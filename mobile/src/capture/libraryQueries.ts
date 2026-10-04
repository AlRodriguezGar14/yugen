import { database } from './store';
import { captureFromRow, type CaptureRow } from './types';
import { photoSummary } from './review';

export type LibraryCollection = 'texts' | 'vocabulary' | 'practice' | 'photos';
export type LibraryCursor = { createdAt: string; id: string };
type ListIdentity = { id: string; createdAt: string };
export type LibraryEntry = ListIdentity & { collection: 'texts' | 'vocabulary'; captureId: string; imageUri: string | null;
  groupId: string | null; sourceText: string; lemma: string; reading: string; meaning: string; personalMeaning: string | null; hasPractice: number };
export type LibraryPhoto = ListIdentity & { collection: 'photos'; imageUri: string; text: string; summary: string; groupId: string | null };
export type LibraryPractice = ListIdentity & { collection: 'practice'; entryId: string | null; kind: 'word' | 'sentence' | null; prompt: string | null };
export type LibraryItem = LibraryEntry | LibraryPhoto | LibraryPractice;
export type LibraryPage = { items: LibraryItem[]; total: number; nextCursor: LibraryCursor | null };
const PAGE_SIZE = 30;

/** Reads one stable page of list summaries; complete records are loaded only by their detail screens. */
export async function loadLibraryPage(collection: LibraryCollection, query: string, cursor: LibraryCursor | null = null): Promise<LibraryPage> {
  const db = await database();
  let from: string;
  let search: string;
  const term = query.trim().toLocaleLowerCase();
  // ponytail: SQLite lower() folds ASCII; add stored Unicode search keys if accented Latin case folding is needed.
  if (collection === 'photos') {
    from = `SELECT c.id, c.created_at AS createdAt, c.image_uri AS imageUri, c.corrected_text, c.raw_text,
      c.language, c.source, c.image_metadata, c.ocr_bounds, c.regions, c.selected_region_id, c.join_without_breaks, c.status, c.saved_at,
      (SELECT group_id FROM study_cards WHERE capture_id=c.id AND group_id IS NOT NULL ORDER BY created_at DESC,id LIMIT 1) AS groupId,
      (SELECT COUNT(*) FROM study_cards WHERE capture_id=c.id AND kind='word') AS words
      FROM captures c`;
    search = `instr(lower(corrected_text), ?) > 0 OR EXISTS (SELECT 1 FROM study_cards s WHERE s.capture_id=list.id AND instr(lower(s.source_text), ?) > 0)`;
  } else if (collection === 'practice') {
    from = `SELECT p.id, p.created_at AS createdAt, s.id AS entryId,
      COALESCE(s.kind,json_extract(p.answer_json,'$.kind')) AS kind,
      CASE WHEN s.id IS NOT NULL THEN CASE WHEN s.kind='word' THEN s.lemma ELSE s.source_text END ELSE json_extract(p.answer_json,'$.prompt') END AS prompt
      FROM practice_cards p LEFT JOIN study_cards s ON s.id=p.entry_id`;
    search = `instr(lower(COALESCE(prompt,'')), ?) > 0`;
  } else {
    from = `SELECT s.id, s.created_at AS createdAt, s.capture_id AS captureId, s.group_id AS groupId,
      s.source_text AS sourceText, s.lemma, s.reading, s.personal_meaning AS personalMeaning, c.image_uri AS imageUri,
      json_extract(s.word_snapshot,'$.surface') AS recordedWord, json_extract(s.word_snapshot,'$.reading') AS recordedReading,
      json_extract(s.word_snapshot,'$.dictionaryCandidates[0].meanings') AS meanings, json_extract(s.word_snapshot,'$.curatedMeaning') AS curatedMeaning,
      s.word_snapshot, EXISTS(SELECT 1 FROM practice_cards p WHERE p.entry_id=s.id) AS hasPractice
      FROM study_cards s LEFT JOIN captures c ON c.id=s.capture_id WHERE s.kind='${collection === 'vocabulary' ? 'word' : 'sentence'}'`;
    search = `instr(lower(lemma || ' ' || reading || ' ' || sourceText || ' ' || COALESCE(curatedMeaning,'') || ' ' || COALESCE(personalMeaning,'')), ?) > 0
      OR EXISTS (SELECT 1 FROM json_each(list.word_snapshot,'$.dictionaryCandidates') candidate, json_each(candidate.value,'$.meanings') gloss WHERE instr(lower(gloss.value), ?) > 0)`;
  }
  const searchWhere = term ? `(${search})` : '1';
  const searchParams = term ? (collection === 'practice' ? [term] : [term, term]) : [];
  const total = (await db.getFirstAsync<{ total: number }>(`SELECT COUNT(*) AS total FROM (${from}) list WHERE ${searchWhere}`, ...searchParams))?.total ?? 0;
  const pageWhere = cursor ? ' AND (createdAt < ? OR (createdAt = ? AND id > ?))' : '';
  const params = [...searchParams, ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [])];
  // Exclude the snapshot from the native result; SQL uses it only to search real dictionary meanings.
  const projection = collection === 'texts' || collection === 'vocabulary'
    ? 'id,createdAt,captureId,groupId,sourceText,lemma,reading,personalMeaning,imageUri,recordedWord,recordedReading,meanings,curatedMeaning,hasPractice' : '*';
  type Row = CaptureRow & { createdAt: string; imageUri: string | null; captureId: string; groupId: string | null; sourceText: string; lemma: string; reading: string; personalMeaning: string | null; hasPractice: number; entryId: string | null; kind: 'word' | 'sentence' | null; prompt: string | null; words: number; recordedWord: string | null; recordedReading: string | null; meanings: string | null; curatedMeaning: string | null };
  const rows = await db.getAllAsync<Row>(`SELECT ${projection} FROM (${from}) list WHERE ${searchWhere}${pageWhere} ORDER BY createdAt DESC,id LIMIT ?`, ...params, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  let items: LibraryItem[];
  if (collection === 'photos') {
    const savedTexts = new Map<string, Map<string, string>>();
    if (page.length) {
      const groups = await db.getAllAsync<{ capture_id: string; id: string; text: string }>(`SELECT capture_id,id,text FROM text_groups WHERE capture_id IN (${page.map(() => '?').join(',')})`, ...page.map((row) => row.id));
      groups.forEach((group) => {
        let texts = savedTexts.get(group.capture_id);
        if (!texts) { texts = new Map(); savedTexts.set(group.capture_id, texts); }
        texts.set(group.id, group.text);
      });
    }
    items = page.map((row) => {
      // OCR regions are needed for the existing saved-row coverage summary, but analysis is not.
      const capture = captureFromRow({ ...row, created_at: row.createdAt, image_uri: row.imageUri!, translation_json: null, analysis_json: null, analysis_review_json: '{}' });
      return { collection: 'photos', id: row.id, createdAt: row.createdAt, imageUri: row.imageUri!, groupId: row.groupId,
        text: capture.correctedText || capture.rawText || 'Photo', summary: photoSummary(capture, savedTexts.get(row.id) ?? new Map(), row.words) };
    });
  } else if (collection === 'practice') {
    items = page.map((row) => ({ collection, id: row.id, createdAt: row.createdAt, entryId: row.entryId, kind: row.kind, prompt: row.prompt }));
  } else {
    items = page.map((row) => {
      const gloss = row.meanings ? (JSON.parse(row.meanings) as string[]).join('; ') : row.curatedMeaning;
      const meaning = !gloss || !row.recordedWord ? 'Meaning unavailable'
        : row.recordedWord !== row.lemma || row.recordedReading !== row.reading ? `Recorded dictionary entry for ${row.recordedWord} (${row.recordedReading}) · ${gloss}` : gloss;
      return { collection, id: row.id, createdAt: row.createdAt, captureId: row.captureId, imageUri: row.imageUri, groupId: row.groupId,
        sourceText: row.sourceText, lemma: row.lemma, reading: row.reading, meaning, personalMeaning: row.personalMeaning, hasPractice: row.hasPractice };
    });
  }
  const last = page.at(-1);
  return { items, total, nextCursor: rows.length > PAGE_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null };
}
