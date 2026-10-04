import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import { rowGroupsForCapture, unsavedRows } from './review';
import { captureFromRow, captureToRow, type CaptureRecord, type CaptureRow, type TextGroup, type AnalysisToken, type AnalysisTokenReview, type NormalizedBounds } from './types';
import { hiraganaReading, isContentToken } from './analysis';
import { practiceAnswer, type PracticeAnswer } from './studyCards';

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

async function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await SQLite.openDatabaseAsync('yugen.db');
      await db.execAsync(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS captures (
          id TEXT PRIMARY KEY NOT NULL,
          created_at TEXT NOT NULL,
          language TEXT NOT NULL,
          source TEXT NOT NULL,
          image_uri TEXT NOT NULL,
          image_metadata TEXT NOT NULL,
          ocr_bounds TEXT,
          raw_text TEXT NOT NULL,
          regions TEXT NOT NULL,
          corrected_text TEXT NOT NULL,
          selected_region_id TEXT,
          join_without_breaks INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          saved_at TEXT,
          translation_json TEXT,
          analysis_json TEXT,
          analysis_review_json TEXT NOT NULL DEFAULT '{}'
        );
      `);
      const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(captures)');
      const names = new Set(columns.map((column) => column.name));
      if (!names.has('ocr_bounds')) await db.execAsync('ALTER TABLE captures ADD COLUMN ocr_bounds TEXT');
      if (!names.has('join_without_breaks')) await db.execAsync('ALTER TABLE captures ADD COLUMN join_without_breaks INTEGER NOT NULL DEFAULT 0');
      if (!names.has('saved_at')) {
        await db.execAsync('ALTER TABLE captures ADD COLUMN saved_at TEXT');
      }
      if (!names.has('translation_json')) await db.execAsync('ALTER TABLE captures ADD COLUMN translation_json TEXT');
      if (!names.has('analysis_json')) await db.execAsync('ALTER TABLE captures ADD COLUMN analysis_json TEXT');
      if (!names.has('analysis_review_json')) await db.execAsync("ALTER TABLE captures ADD COLUMN analysis_review_json TEXT NOT NULL DEFAULT '{}'");
      const { user_version: schemaVersion } = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version') ?? { user_version: 0 };
      if (schemaVersion < 1) {
        await db.execAsync('UPDATE captures SET saved_at = NULL WHERE saved_at = created_at');
        await db.execAsync('PRAGMA user_version = 1');
      }
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS study_cards (
          id TEXT PRIMARY KEY NOT NULL,
          capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('sentence', 'word')),
          language TEXT NOT NULL,
          lemma TEXT NOT NULL DEFAULT '',
          reading TEXT NOT NULL DEFAULT '',
          token_index INTEGER,
          source_text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS word_card_identity ON study_cards(language, lemma, reading) WHERE kind = 'word';
        CREATE INDEX IF NOT EXISTS study_card_source ON study_cards(capture_id);
      `);
      if (schemaVersion < 2) await db.execAsync(`
        INSERT OR IGNORE INTO study_cards(id, capture_id, kind, language, source_text, created_at)
          SELECT 'sentence:' || id, id, 'sentence', language, corrected_text, saved_at
          FROM captures WHERE saved_at IS NOT NULL AND LENGTH(TRIM(corrected_text)) > 0;
        PRAGMA user_version = 2;
      `);
      await db.execAsync(`
        DROP TRIGGER IF EXISTS saved_capture_card_insert;
        DROP TRIGGER IF EXISTS saved_capture_card_update;
        DROP INDEX IF EXISTS sentence_card_source;
        CREATE TABLE IF NOT EXISTS text_groups (
          id TEXT PRIMARY KEY NOT NULL, capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
          region_ids TEXT NOT NULL, text TEXT NOT NULL, analysis_json TEXT, review_json TEXT NOT NULL DEFAULT '{}', saved_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS text_group_source ON text_groups(capture_id);
      `);
      const cardColumns = new Set((await db.getAllAsync<{ name: string }>('PRAGMA table_info(study_cards)')).map((column) => column.name));
      if (!cardColumns.has('group_id')) await db.execAsync('ALTER TABLE study_cards ADD COLUMN group_id TEXT REFERENCES text_groups(id) ON DELETE CASCADE');
      if (!cardColumns.has('word_snapshot')) await db.execAsync('ALTER TABLE study_cards ADD COLUMN word_snapshot TEXT');
      if (!cardColumns.has('candidate_id')) await db.execAsync('ALTER TABLE study_cards ADD COLUMN candidate_id TEXT');
      if (!cardColumns.has('source_regions')) await db.execAsync('ALTER TABLE study_cards ADD COLUMN source_regions TEXT');
      if (!cardColumns.has('personal_meaning')) await db.execAsync('ALTER TABLE study_cards ADD COLUMN personal_meaning TEXT');
      await db.execAsync("CREATE UNIQUE INDEX IF NOT EXISTS sentence_card_group ON study_cards(group_id) WHERE kind = 'sentence'");
      // Practice cards are optional, independent exercises linked to saved knowledge.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS practice_cards (id TEXT PRIMARY KEY NOT NULL, entry_id TEXT, answer_json TEXT, created_at TEXT NOT NULL, capture_id TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS practice_card_entry ON practice_cards(entry_id) WHERE entry_id IS NOT NULL;
      `);
      if (schemaVersion < 3) {
        await db.execAsync(`
          INSERT OR IGNORE INTO text_groups(id, capture_id, region_ids, text, analysis_json, review_json, saved_at)
            SELECT 'legacy:' || id, id, '[]', corrected_text, analysis_json, analysis_review_json, saved_at FROM captures
            WHERE saved_at IS NOT NULL AND LENGTH(TRIM(corrected_text)) > 0;
          UPDATE study_cards SET group_id = 'legacy:' || capture_id WHERE EXISTS (SELECT 1 FROM text_groups WHERE id = 'legacy:' || study_cards.capture_id);
        `);
        const words = await db.getAllAsync<StudyCardRow>("SELECT * FROM study_cards WHERE kind = 'word'");
        for (const card of words) {
          const row = await db.getFirstAsync<CaptureRow>('SELECT * FROM captures WHERE id = ?', card.capture_id);
          const capture = row ? captureFromRow(row) : null;
          const token = capture?.analysis?.tokens[card.token_index ?? -1];
          if (token && capture?.correctedText === card.source_text) {
            const candidateId = capture.analysisReview[String(card.token_index)]?.dictionaryCandidateId ?? null;
            const candidates = token.dictionaryCandidates.filter((candidate) => hiraganaReading(candidate.reading) === card.reading);
            await db.runAsync('UPDATE study_cards SET word_snapshot = ?, candidate_id = ? WHERE id = ?', JSON.stringify({ ...token, surface: card.lemma, lemma: card.lemma, reading: card.reading, dictionaryCandidates: candidates }), candidates.some((candidate) => candidate.id === candidateId) ? candidateId : null, card.id);
          }
        }
        await db.execAsync('PRAGMA user_version = 3');
      }
      return db;
    })().catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export async function saveCapture(capture: CaptureRecord): Promise<void> {
  const db = await database();
  await writeCapture(db, capture);
}

async function writeCapture(db: SQLite.SQLiteDatabase, capture: CaptureRecord): Promise<void> {
  const row = captureToRow(capture);
  await db.runAsync(
    `INSERT INTO captures (
      id, created_at, language, source, image_uri, image_metadata, ocr_bounds, raw_text,
      regions, corrected_text, selected_region_id, join_without_breaks, status, saved_at, translation_json, analysis_json, analysis_review_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      created_at = excluded.created_at,
      language = excluded.language,
      source = excluded.source,
      image_uri = excluded.image_uri,
      image_metadata = excluded.image_metadata,
      ocr_bounds = excluded.ocr_bounds,
      raw_text = excluded.raw_text,
      regions = excluded.regions,
      corrected_text = excluded.corrected_text,
      selected_region_id = excluded.selected_region_id,
      join_without_breaks = excluded.join_without_breaks,
      status = excluded.status,
      -- Legacy whole-photo saves are no longer created; a cleared flag (deleted legacy text) is never re-set by a stale draft.
      saved_at = CASE WHEN captures.saved_at IS NULL THEN NULL ELSE excluded.saved_at END,
      translation_json = excluded.translation_json,
      analysis_json = excluded.analysis_json,
      analysis_review_json = excluded.analysis_review_json;`,
    row.id,
    row.created_at,
    row.language,
    row.source,
    row.image_uri,
    row.image_metadata,
    row.ocr_bounds,
    row.raw_text,
    row.regions,
    row.corrected_text,
    row.selected_region_id,
    row.join_without_breaks,
    row.status,
    row.saved_at,
    row.translation_json,
    row.analysis_json,
    row.analysis_review_json,
  );
}


type GroupRow = { id: string; capture_id: string; region_ids: string; text: string; analysis_json: string | null; review_json: string; saved_at: string };
function groupFromRow(row: GroupRow): TextGroup {
  return { id: row.id, captureId: row.capture_id, regionIds: JSON.parse(row.region_ids), text: row.text,
    analysis: row.analysis_json ? JSON.parse(row.analysis_json) : null, analysisReview: JSON.parse(row.review_json), savedAt: row.saved_at };
}
export async function loadTextGroups(captureId: string): Promise<TextGroup[]> {
  const db = await database();
  const rows = await db.getAllAsync<GroupRow>('SELECT * FROM text_groups WHERE capture_id = ? ORDER BY saved_at DESC', captureId);
  return rows.map(groupFromRow);
}
/** Writes the source, its group and the group's sentence card; callers own the surrounding transaction. */
async function writeGroup(txn: SQLite.SQLiteDatabase, capture: CaptureRecord, group: TextGroup): Promise<void> {
  if (group.captureId !== capture.id || !group.text.trim()) throw new Error('This group cannot be saved.');
  if (!await txn.getFirstAsync('SELECT id FROM captures WHERE id = ?', capture.id)) throw new Error('The source was deleted.');
  await writeCapture(txn, capture);
  const validAnalysis = group.analysis?.normalizedText === group.text ? group.analysis : null;
  const savedAt = group.savedAt ?? new Date().toISOString();
  await txn.runAsync(`INSERT INTO text_groups(id,capture_id,region_ids,text,analysis_json,review_json,saved_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET region_ids=excluded.region_ids,text=excluded.text,analysis_json=excluded.analysis_json,review_json=excluded.review_json`,
    group.id, capture.id, JSON.stringify(group.regionIds), group.text, validAnalysis ? JSON.stringify(validAnalysis) : null, JSON.stringify(validAnalysis ? group.analysisReview : {}), savedAt);
  await txn.runAsync(`INSERT INTO study_cards(id,capture_id,kind,language,source_text,created_at,group_id,source_regions) VALUES (?,?,'sentence',?,?,?,?,?)
    ON CONFLICT(group_id) WHERE kind = 'sentence' DO UPDATE SET source_text=excluded.source_text`, `sentence:${group.id}`, capture.id, capture.language, group.text, savedAt, group.id,
    sourceRegionsJson(capture, group.regionIds));
}

/** Word counts of one save, by unique lexical record (language + lemma + reading), not by token occurrence. */
export type RecordedWords = { added: number; existing: number; pending: number; unknown: number };

/**
 * Saves a text group, its sentence card and every resolved Japanese word in one transaction; any failure rolls
 * all of them back. Ambiguous words stay pending and words without an entry stay unknown — nothing is guessed.
 * Returns null when the text has no current readings, so only the text was saved.
 */
export async function saveTextGroup(capture: CaptureRecord, group: TextGroup): Promise<RecordedWords | null> {
  if (group.captureId !== capture.id || !group.text.trim()) throw new Error('This group cannot be saved.');
  const analysis = group.analysis?.normalizedText === group.text ? group.analysis : null;
  const counts: RecordedWords = { added: 0, existing: 0, pending: 0, unknown: 0 };
  const db = await database();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await writeGroup(txn, capture, group);
    const seen = new Set<string>();
    for (const [index, token] of analysis?.tokens.entries() ?? []) {
      const review = group.analysisReview[String(index)];
      if (review?.ignored || !isContentToken(token) || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token.surface)) continue;
      const word = resolveWord(token, review);
      const key = typeof word === 'string' ? `${word}\n${token.lemma}\n${token.reading}` : `${word.lemma}\n${word.reading}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[typeof word === 'string' ? word : await writeWord(txn, capture, word, index, group.text, group)] += 1;
    }
  });
  return analysis ? counts : null;
}

/** Original photo lines a card came from, snapshotted at first save so later edits or deletions never move it. */
export type SourceRegion = { id: string; bounds: NormalizedBounds };

function sourceRegionsJson(capture: CaptureRecord, regionIds: string[]): string | null {
  const regions = capture.regions.filter((region) => regionIds.includes(region.id)).map(({ id, bounds }) => ({ id, bounds }));
  return regions.length ? JSON.stringify(regions) : null;
}

type ResolvedWord = { lemma: string; reading: string; snapshot: AnalysisToken; candidateId: string | null };

/**
 * The approved dictionary entry of a token: an explicit valid choice, the only entry with a reading and gloss,
 * or a labeled curated term. A LIKELY hint or a parser reading alone never approves a sense. Written-form evidence
 * the parser could not place in context stays pending unless the user explicitly approves it (`explicitSave`).
 */
export function resolveWord(token: AnalysisToken, review?: AnalysisTokenReview, explicitSave = false): ResolvedWord | 'pending' | 'unknown' {
  const eligible = token.dictionaryCandidates.filter((candidate) => candidate.reading.trim() && candidate.meanings.some((meaning) => meaning.trim()));
  const explicit = token.dictionaryCandidates.find((candidate) => candidate.id === review?.dictionaryCandidateId);
  const chosen = explicit ?? (eligible.length === 1 ? eligible[0] : null);
  if (!explicit && (eligible.length > 1 || (token.writtenFormEvidence && !explicitSave && eligible.length))) return 'pending';
  if (chosen ? !eligible.includes(chosen) : !token.curatedMeaning?.trim()) return 'unknown';
  const lemma = token.lemma.normalize('NFC').trim();
  const reading = hiraganaReading((chosen?.reading ?? token.reading ?? '').normalize('NFC').trim());
  if (!lemma || !reading) return 'unknown';
  return { lemma, reading, candidateId: chosen?.id ?? null, snapshot: { ...token, surface: lemma, reading, dictionaryCandidates: chosen ? [chosen] : [] } };
}

/** Inserts an approved word snapshot; an already saved language + lemma + reading keeps its original sense. */
async function writeWord(txn: SQLite.SQLiteDatabase, capture: CaptureRecord, word: ResolvedWord, tokenIndex: number, text: string, group?: TextGroup): Promise<'added' | 'existing'> {
  if (await txn.getFirstAsync("SELECT id FROM study_cards WHERE kind = 'word' AND language = ? AND lemma = ? AND reading = ?", capture.language, word.lemma, word.reading)) return 'existing';
  await txn.runAsync(`INSERT INTO study_cards
    (id,capture_id,kind,language,lemma,reading,token_index,source_text,created_at,group_id,word_snapshot,candidate_id,source_regions)
    VALUES (?,?,'word',?,?,?,?,?,?,?,?,?,?)`,
    `word:${JSON.stringify([capture.language, word.lemma, word.reading])}`, capture.id, capture.language, word.lemma, word.reading, tokenIndex,
    text, new Date().toISOString(), group?.id ?? null, JSON.stringify(word.snapshot), word.candidateId, sourceRegionsJson(capture, group?.regionIds ?? []));
  return 'added';
}

/** Explicit vocabulary approval of one word, saved atomically with its parent row or paragraph. */
export async function addWordCard(capture: CaptureRecord, tokenIndex: number, reading: string, group: TextGroup): Promise<WordSaveOutcome> {
  const token = group.analysis?.normalizedText === group.text ? group.analysis.tokens[tokenIndex] : null;
  if (!token || !Number.isInteger(tokenIndex)) return null;
  const word = resolveWord(token, group.analysisReview[String(tokenIndex)], true);
  if (typeof word === 'string' || word.reading !== hiraganaReading(reading.normalize('NFC').trim())) return null;
  let saved: WordSaveOutcome = null;
  const db = await database();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await writeGroup(txn, capture, group);
    saved = await writeWord(txn, capture, word, tokenIndex, group.text, group);
  });
  return saved;
}

/** 'added' or 'existing' (same language + lemma + reading already saved); null when the approval no longer holds. */
export type WordSaveOutcome = 'added' | 'existing' | null;

export type StudyCard = {
  id: string;
  captureId: string;
  kind: 'sentence' | 'word';
  tokenIndex: number | null;
  lemma: string;
  reading: string;
  sourceText: string;
  createdAt: string;
  groupId: string | null;
  wordSnapshot: AnalysisToken | null;
  dictionaryCandidateId: string | null;
  sourceRegions: SourceRegion[] | null;
  /** The user's own meaning; never a dictionary sense. */
  personalMeaning: string | null;
};

type StudyCardRow = {
  id: string; capture_id: string; kind: StudyCard['kind']; token_index: number | null;
  lemma: string; reading: string; source_text: string; created_at: string;
  group_id: string | null; word_snapshot: string | null; candidate_id: string | null; source_regions?: string | null; personal_meaning?: string | null;
};

function cardFromRow(row: StudyCardRow): StudyCard {
  return { id: row.id, captureId: row.capture_id, kind: row.kind, tokenIndex: row.token_index,
    lemma: row.lemma, reading: row.reading, sourceText: row.source_text, createdAt: row.created_at,
    groupId: row.group_id ?? null, wordSnapshot: row.word_snapshot ? JSON.parse(row.word_snapshot) as AnalysisToken : null, dictionaryCandidateId: row.candidate_id ?? null,
    sourceRegions: row.source_regions ? JSON.parse(row.source_regions) as SourceRegion[] : null, personalMeaning: row.personal_meaning ?? null };
}


export async function loadCaptureById(id: string): Promise<CaptureRecord | null> {
  const db = await database();
  const row = await db.getFirstAsync<CaptureRow>('SELECT * FROM captures WHERE id = ?', id);
  return row ? captureFromRow(row) : null;
}

export async function loadLibraryCaptures(): Promise<CaptureRecord[]> {
  const db = await database();
  const rows = await db.getAllAsync<CaptureRow>('SELECT * FROM captures ORDER BY created_at DESC');
  return rows.map(captureFromRow);
}

export async function loadTextGroup(id: string): Promise<TextGroup | null> {
  const db = await database();
  const row = await db.getFirstAsync<GroupRow>('SELECT * FROM text_groups WHERE id = ?', id);
  return row ? groupFromRow(row) : null;
}

export async function loadStudyCards(): Promise<StudyCard[]> {
  const db = await database();
  return (await db.getAllAsync<StudyCardRow>('SELECT * FROM study_cards ORDER BY created_at DESC, id')).map(cardFromRow);
}

export async function loadTextEntryForGroup(groupId: string): Promise<StudyCard | null> {
  const db = await database();
  const row = await db.getFirstAsync<StudyCardRow>("SELECT * FROM study_cards WHERE kind = 'sentence' AND group_id = ?", groupId);
  return row ? cardFromRow(row) : null;
}

export async function loadStudyCard(id: string): Promise<StudyCard | null> {
  const db = await database();
  const row = await db.getFirstAsync<StudyCardRow>('SELECT * FROM study_cards WHERE id = ?', id);
  return row ? cardFromRow(row) : null;
}

export async function enrichWordCardCharacters(id: string, details: NonNullable<AnalysisToken['kanjiDetails']>): Promise<void> {
  const db = await database();
  const row = await db.getFirstAsync<StudyCardRow>("SELECT * FROM study_cards WHERE id = ? AND kind = 'word'", id);
  if (!row?.word_snapshot) return;
  const token = JSON.parse(row.word_snapshot) as AnalysisToken;
  await db.runAsync('UPDATE study_cards SET word_snapshot = ? WHERE id = ? AND word_snapshot = ?',
    JSON.stringify({ ...token, kanjiDetails: details.filter((detail) => token.scriptUnits.includes(detail.character)) }), id, row.word_snapshot);
}

export async function saveAnalysisForText(
  id: string,
  correctedText: string,
  analysis: NonNullable<CaptureRecord['analysis']>,
): Promise<boolean> {
  const db = await database();
  const result = await db.runAsync(
    'UPDATE captures SET analysis_json = ? WHERE id = ? AND corrected_text = ?',
    JSON.stringify(analysis),
    id,
    correctedText,
  );
  return result.changes > 0;
}

export async function saveAnalysisReviewForText(
  id: string,
  correctedText: string,
  analysisReview: CaptureRecord['analysisReview'],
): Promise<boolean> {
  const db = await database();
  const result = await db.runAsync(
    'UPDATE captures SET analysis_review_json = ? WHERE id = ? AND corrected_text = ?',
    JSON.stringify(analysisReview),
    id,
    correctedText,
  );
  return result.changes > 0;
}

export async function saveGroupAnalysisForText(id: string, text: string, analysis: NonNullable<TextGroup['analysis']>, review: TextGroup['analysisReview'] = {}): Promise<boolean> {
  if (analysis.normalizedText !== text) return false;
  const db = await database();
  return (await db.runAsync('UPDATE text_groups SET analysis_json = ?, review_json = ? WHERE id = ? AND text = ?', JSON.stringify(analysis), JSON.stringify(review), id, text)).changes > 0;
}

/** An edit would collide with a different saved word. */
export class WordConflictError extends Error {}

export async function updateWordCard(id: string, change: { lemma: string; reading: string; personalMeaning: string }): Promise<void> {
  const lemma = change.lemma.normalize('NFC').trim();
  const reading = hiraganaReading(change.reading.normalize('NFC').trim());
  if (!lemma || !reading) throw new Error('A word and its reading are required.');
  const db = await database();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const card = await txn.getFirstAsync<{ language: string }>("SELECT language FROM study_cards WHERE id = ? AND kind = 'word'", id);
    if (!card) throw new Error('This word was deleted.');
    if (await txn.getFirstAsync("SELECT id FROM study_cards WHERE kind = 'word' AND language = ? AND lemma = ? AND reading = ? AND id <> ?", card.language, lemma, reading, id)) {
      throw new WordConflictError(`${lemma} (${reading}) is already in your Vocabulary. Open that word instead; nothing was changed.`);
    }
    await txn.runAsync('UPDATE study_cards SET lemma = ?, reading = ?, personal_meaning = ? WHERE id = ?', lemma, reading, change.personalMeaning.trim() || null, id);
  });
}

export async function updateSavedText(groupId: string, text: string, translation?: string): Promise<void> {
  if (!text.trim()) throw new Error('A saved text cannot be empty.');
  const db = await database();
  await db.withExclusiveTransactionAsync(async (txn) => {
    // Readings and choices are cleared only when the wording changed (SET sees the old text).
    const updated = await txn.runAsync(`UPDATE text_groups SET analysis_json = CASE WHEN text = ? THEN analysis_json END,
      review_json = CASE WHEN text = ? THEN review_json ELSE '{}' END, text = ? WHERE id = ?`, text, text, text, groupId);
    if (!updated.changes) throw new Error('This text was deleted.');
    await txn.runAsync("UPDATE study_cards SET source_text = ? WHERE kind = 'sentence' AND group_id = ?", text, groupId);
    // The user's own translation, kept apart from OCR, dictionary glosses and any future provider output.
    if (translation !== undefined) await txn.runAsync("UPDATE study_cards SET personal_meaning = ? WHERE kind = 'sentence' AND group_id = ?", translation.trim() || null, groupId);
  });
}

/** An optional recall exercise; while linked it always shows its entry's current answer. */
export type PracticeCard = { id: string; entryId: string | null; createdAt: string; answer: PracticeAnswer | null;
  /** Source photo, from the card's own provenance or its linked entry; null when unknown. */
  captureId: string | null };
type PracticeRow = { id: string; entry_id: string | null; answer_json: string | null; created_at: string; capture_id?: string | null };

async function practiceFromRow(db: SQLite.SQLiteDatabase, row: PracticeRow): Promise<PracticeCard> {
  const entry = row.entry_id ? await db.getFirstAsync<StudyCardRow>('SELECT * FROM study_cards WHERE id = ?', row.entry_id) : null;
  const answer = entry ? practiceAnswer(cardFromRow(entry)) : row.answer_json ? JSON.parse(row.answer_json) as PracticeAnswer : null;
  return { id: row.id, entryId: entry ? row.entry_id : null, createdAt: row.created_at, answer, captureId: row.capture_id ?? entry?.capture_id ?? null };
}

export async function loadPracticeCards(): Promise<PracticeCard[]> {
  const db = await database();
  const rows = await db.getAllAsync<PracticeRow>('SELECT * FROM practice_cards ORDER BY created_at DESC, id');
  return Promise.all(rows.map((row) => practiceFromRow(db, row)));
}

export async function loadPracticeCard(id: string): Promise<PracticeCard | null> {
  const db = await database();
  const row = await db.getFirstAsync<PracticeRow>('SELECT * FROM practice_cards WHERE id = ?', id);
  return row ? practiceFromRow(db, row) : null;
}

export async function loadPracticeCardForEntry(entryId: string): Promise<PracticeCard | null> {
  const db = await database();
  const row = await db.getFirstAsync<PracticeRow>('SELECT * FROM practice_cards WHERE entry_id = ?', entryId);
  return row ? practiceFromRow(db, row) : null;
}

/** The entry a request depends on no longer exists; nothing was created or changed. */
export class EntryDeletedError extends Error {}

/** Creates the entry's practice card, or returns the existing one (idempotent). */
export async function createPracticeCard(entryId: string): Promise<PracticeCard> {
  const db = await database();
  // One transaction: an entry deleted concurrently can never leave a card without entry or snapshot.
  await db.withExclusiveTransactionAsync(async (txn) => {
    const entry = await txn.getFirstAsync<{ capture_id: string }>('SELECT capture_id FROM study_cards WHERE id = ?', entryId);
    if (!entry) throw new EntryDeletedError('This entry was deleted, so no practice card was created.');
    await txn.runAsync('INSERT OR IGNORE INTO practice_cards (id, entry_id, answer_json, created_at, capture_id) VALUES (?, ?, NULL, ?, ?)',
      `practice:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`, entryId, new Date().toISOString(), entry.capture_id);
  });
  // The entry (and its card) can be deleted between the commit and this read; report it, never return null.
  const card = await loadPracticeCardForEntry(entryId);
  if (!card) throw new EntryDeletedError('This entry was deleted, so its practice card no longer exists.');
  return card;
}

/** Deletes only the practice card; its entry and photo remain. */
export async function deletePracticeCard(id: string): Promise<void> {
  const db = await database();
  await db.runAsync('DELETE FROM practice_cards WHERE id = ?', id);
}


/** Deleting an entry can retain its practice as an independent current-answer snapshot. */
export type EntryDeletion = { keepPracticeCards?: boolean };

async function settlePracticeCards(txn: SQLite.SQLiteDatabase, entry: StudyCard, { keepPracticeCards = false }: EntryDeletion): Promise<void> {
  if (keepPracticeCards) {
    // A kept card records its source photo too, so a later whole-photo delete still removes it (older rows had none).
    await txn.runAsync('UPDATE practice_cards SET entry_id = NULL, answer_json = ?, capture_id = ? WHERE entry_id = ?', JSON.stringify(practiceAnswer(entry)), entry.captureId, entry.id);
  } else {
    await txn.runAsync('DELETE FROM practice_cards WHERE entry_id = ?', entry.id);
  }
}

export async function deleteWordCard(id: string, options: EntryDeletion = {}): Promise<void> {
  const db = await database();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const entry = await txn.getFirstAsync<StudyCardRow>("SELECT * FROM study_cards WHERE id = ? AND kind = 'word'", id);
    if (entry) await settlePracticeCards(txn, cardFromRow(entry), options);
    await txn.runAsync("DELETE FROM study_cards WHERE id = ? AND kind = 'word'", id);
  });
}

export async function deleteTextGroup(id: string, options: EntryDeletion = {}): Promise<void> {
  const db = await database();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const entry = await txn.getFirstAsync<StudyCardRow>("SELECT * FROM study_cards WHERE kind = 'sentence' AND group_id = ?", id);
    if (entry) await settlePracticeCards(txn, cardFromRow(entry), options);
    await txn.runAsync("UPDATE study_cards SET group_id = NULL WHERE kind = 'word' AND group_id = ?", id);
    await txn.runAsync("DELETE FROM study_cards WHERE kind = 'sentence' AND group_id = ?", id);
    if (id.startsWith('legacy:')) await txn.runAsync('UPDATE captures SET saved_at = NULL WHERE id = ?', id.slice('legacy:'.length));
    await txn.runAsync('DELETE FROM text_groups WHERE id = ?', id);
  });
}


export async function loadOcrReviewCaptures(): Promise<CaptureRecord[]> {
  const db = await database();
  const rows = await db.getAllAsync<CaptureRow>('SELECT * FROM captures ORDER BY created_at DESC');
  const saved = new Map((await db.getAllAsync<{ id: string; text: string }>('SELECT id, text FROM text_groups')).map((group) => [group.id, group.text]));
  return rows.map(captureFromRow).filter((capture) => capture.status !== 'complete'
    || !rowGroupsForCapture(capture).length || unsavedRows(capture, saved).length > 0);
}

export async function deleteCapture(id: string): Promise<boolean> {
  try {
    const db = await database();
    const row = await db.getFirstAsync<CaptureRow>('SELECT * FROM captures WHERE id = ?', id);
    if (row) {
      const capturesDirectory = new Directory(Paths.document, 'captures');
      const capturesPrefix = `${capturesDirectory.uri.replace(/\/$/, '')}/`;
      if (row.image_uri.startsWith(capturesPrefix)) {
        const file = new File(row.image_uri);
        if (file.exists) file.delete();
      }
    }
    await db.withExclusiveTransactionAsync(async (txn) => {
      // Separate connection, foreign keys OFF: every dependent row is removed explicitly.
      await txn.runAsync('DELETE FROM practice_cards WHERE capture_id = ? OR entry_id IN (SELECT id FROM study_cards WHERE capture_id = ?)', id, id);
      await txn.runAsync('DELETE FROM study_cards WHERE capture_id = ?', id);
      await txn.runAsync('DELETE FROM text_groups WHERE capture_id = ?', id);
      await txn.runAsync('DELETE FROM captures WHERE id = ?', id);
    });
    return true;
  } catch (error) {
    throw error;
  }
}
