import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test, { mock } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith('.') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts') && !specifier.endsWith('.ts')
      ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')) };
    }
    return nextLoad(url, context);
  },
});

const testDirectory = mkdtempSync(join(tmpdir(), 'yugen-store-'));
const databasePath = join(testDirectory, 'cards.sqlite');
let sqlite = new DatabaseSync(databasePath);
let imageExists = true;
let failImageDelete = false;
let failSqlDelete = false;
let failCardWrite = false;
let failWordWrite = false;
// Optional pause before one exact read, to interleave another operation (e.g. a deletion) at that point.
let queryGate = null;
// Models expo-sqlite natively: withExclusiveTransactionAsync opens a NEW connection on the same file
// (Transaction.createAsync, useNewConnection), where SQLite's foreign_keys defaults OFF, so no cascades run there.
function sqliteAdapter(transaction) { const db = () => transaction ?? sqlite; return {
    execAsync: async (sql) => db().exec(sql),
    getAllAsync: async (sql, ...params) => db().prepare(sql).all(...params),
    getFirstAsync: async (sql, ...params) => {
      if (queryGate && sql === queryGate.sql) { const gate = queryGate; queryGate = null; gate.entered(); await gate.released; }
      return db().prepare(sql).get(...params) ?? null;
    },
    runAsync: async (sql, ...params) => {
      if (failCardWrite && sql.includes('INSERT INTO study_cards')) throw new Error('Card write failed');
      if (failWordWrite && sql.includes('INSERT INTO study_cards') && sql.includes("'word'")) throw new Error('Word write failed');
      if (failSqlDelete && sql.startsWith('DELETE')) throw new Error('SQL deletion failed');
      return db().prepare(sql).run(...params);
    },
  withExclusiveTransactionAsync: async (callback) => {
    const transaction = new DatabaseSync(databasePath);
    transaction.exec('PRAGMA foreign_keys = OFF');
    transaction.exec('BEGIN IMMEDIATE');
    try { await callback(sqliteAdapter(transaction)); transaction.exec('COMMIT'); }
    catch (error) { transaction.exec('ROLLBACK'); throw error; }
    finally { transaction.close(); }
  },
}; }
mock.module('expo-sqlite', { exports: { openDatabaseAsync: async () => sqliteAdapter() } });
mock.module('expo-file-system', { exports: {
  Paths: { document: 'file:///private/' },
  Directory: class { uri = 'file:///private/captures'; },
  File: class {
    get exists() { return imageExists; }
    delete() {
      if (failImageDelete) throw new Error('Image deletion failed');
      imageExists = false;
    }
  },
} });

const fixture = JSON.parse(await readFile(new URL('../fixtures/capture-record.json', import.meta.url), 'utf8'));
const { captureToRow } = await import('../src/capture/types.ts');
const { studyDataForCard } = await import('../src/capture/studyCards.ts');
const { hiraganaReading } = await import('../src/capture/analysis.ts');
const legacy = captureToRow({ ...fixture, id: 'legacy-saved', savedAt: '2026-10-02T00:00:00Z' });
sqlite.exec(`CREATE TABLE captures (${Object.keys(legacy).map((name) => `${name} TEXT${name === 'id' ? ' PRIMARY KEY' : ''}`).join(', ')}); PRAGMA user_version = 1;`);
sqlite.prepare(`INSERT INTO captures VALUES (${Object.keys(legacy).map(() => '?').join(', ')})`).run(...Object.values(legacy));
const { addWordCard, saveTextGroup, loadTextGroups, loadOcrReviewCaptures, deleteTextGroup, enrichWordCardCharacters, deleteCapture, isCaptureDeleted, loadCaptureById, loadStudyCard, loadStudyCards, saveAnalysisReviewForText, saveCapture, saveTranslationForText } = await import('../src/capture/store.ts');

test('rows save independently and record only resolved words; ambiguous and unknown stay pending', async () => {
  const { rowGroupsForCapture, textGroupsForCapture } = await import('../src/capture/review.ts');
  const candidate = (id, reading, meaning) => ({ id, reading, meanings: [meaning], recommended: false });
  const token = (surface, reading, partOfSpeech, dictionaryCandidates) => ({ surface, lemma: surface, reading, partOfSpeech, dictionaryCandidates, scriptUnits: [] });
  const text = '米と鶏肉と山田の鶏肉';
  const analysis = { contractVersion: 2, language: 'ja', normalizedText: text, tokens: [
    token('米', 'べい', '名詞', [candidate('rice:こめ', 'こめ', 'rice'), candidate('usa:べい', 'べい', 'America')]),
    token('と', 'と', '助詞', [candidate('to', 'と', 'and')]),
    token('鶏肉', 'とりにく', '名詞', [candidate('chicken', 'とりにく', 'chicken meat')]),
    token('と', 'と', '助詞', []),
    token('山田', 'やまだ', '名詞', []),
    token('の', 'の', '助詞', []),
    token('鶏肉', 'とりにく', '名詞', [candidate('chicken', 'とりにく', 'chicken meat')]),
  ] };
  const capture = { ...fixture, id: 'rows', savedAt: null, analysis: null, analysisReview: {}, correctedText: `${text}\n果実`, regions: [
    { ...fixture.regions[0], id: '0:0', text, review: { selected: true } },
    { ...fixture.regions[0], id: '0:1', text: '果実', review: { selected: true } },
  ] };
  await saveCapture(capture);
  const [row, second] = rowGroupsForCapture(capture);
  assert.equal(row.id, 'group:rows:row:0:0', 'Row identity is its stable source region');
  assert.deepStrictEqual(row.regionIds, ['0:0']);

  const wordsOf = async (id) => (await loadStudyCards()).filter((card) => card.captureId === id && card.kind === 'word');
  assert.equal(await saveTextGroup(capture, row), null, 'Without readings only the text is saved; nothing is invented');
  assert.equal((await wordsOf(capture.id)).length, 0);

  const reviewed = { ...row, analysis };
  failWordWrite = true;
  await assert.rejects(saveTextGroup(capture, reviewed), /Word write failed/);
  failWordWrite = false;
  assert.equal((await loadTextGroups(capture.id))[0].analysis, null, 'A failed word write rolls back the row update too');
  assert.equal((await wordsOf(capture.id)).length, 0);

  assert.deepStrictEqual(await saveTextGroup(capture, reviewed), { added: 1, existing: 0, pending: 1, unknown: 1 }, 'Counts unique words, not repeated tokens');
  let words = await wordsOf(capture.id);
  assert.deepStrictEqual(words.map((card) => [card.lemma, card.reading, card.groupId]), [['鶏肉', 'とりにく', row.id]]);
  const likely = { ...analysis, tokens: analysis.tokens.map((item, index) => index ? item : { ...item, dictionaryCandidates: item.dictionaryCandidates.map((entry, position) => ({ ...entry, recommended: !position })) }) };
  assert.equal((await saveTextGroup(capture, { ...row, analysis: likely })).pending, 1, 'A LIKELY hint is not an approval');
  const approved = { ...reviewed, analysisReview: { '0': { ignored: false, dictionaryCandidateId: 'rice:こめ' } } };
  assert.deepStrictEqual(await saveTextGroup(capture, approved), { added: 1, existing: 1, pending: 0, unknown: 1 });
  words = await wordsOf(capture.id);
  assert.equal(words.length, 2, 'Repeated saves never duplicate words');
  const otherSense = { ...reviewed, analysisReview: { '0': { ignored: false, dictionaryCandidateId: 'usa:べい' } } };
  await saveTextGroup(capture, otherSense);
  assert.deepStrictEqual((await wordsOf(capture.id)).filter((card) => card.lemma === '米').map((card) => card.wordSnapshot.dictionaryCandidates[0].meanings[0]).sort(), ['America', 'rice'],
    'A different reading is a different word; the approved rice sense is untouched');

  const unsavedRow = { ...rowGroupsForCapture(capture)[1], analysis: { ...analysis, normalizedText: '果実', tokens: [token('果実', 'かじつ', '名詞', [candidate('fruit', 'かじつ', 'fruit')])] } };
  failWordWrite = true;
  await assert.rejects(addWordCard(capture, 0, 'かじつ', unsavedRow), /Word write failed/);
  failWordWrite = false;
  assert.ok(!(await loadTextGroups(capture.id)).some((group) => group.id === unsavedRow.id), 'Save word rolls back its parent row on failure');
  assert.equal(await addWordCard(capture, 0, 'かじつ', unsavedRow), 'added');
  assert.ok((await loadTextGroups(capture.id)).some((group) => group.id === unsavedRow.id), 'Save word saves its parent row');
  await deleteTextGroup(unsavedRow.id);
  assert.ok((await wordsOf(capture.id)).some((card) => card.lemma === '果実' && card.groupId === null), 'Removing a saved text keeps its words in Vocabulary');

  const chicken = (await wordsOf(capture.id)).find((card) => card.lemma === '鶏肉');
  assert.deepStrictEqual(chicken.sourceRegions, [{ id: '0:0', bounds: capture.regions[0].bounds }], 'A word keeps the photo line it was first saved from');
  assert.deepStrictEqual((await loadStudyCard(`sentence:${row.id}`)).sourceRegions, chicken.sourceRegions);
  const moved = { ...capture, regions: capture.regions.map((region, index) => index ? region : { ...region, bounds: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } }) };
  await saveTextGroup(moved, approved);
  assert.deepStrictEqual((await loadStudyCard(chicken.id)).sourceRegions, chicken.sourceRegions, 'Re-saving never moves a word’s provenance');
  assert.deepStrictEqual((await loadStudyCard(`sentence:${row.id}`)).sourceRegions, chicken.sourceRegions);
  await deleteTextGroup(row.id);
  const detached = await loadStudyCard(chicken.id);
  assert.equal(detached.groupId, null);
  assert.deepStrictEqual(detached.sourceRegions, chicken.sourceRegions, 'Show in photo still has the saved line after its text is removed');
  assert.equal(await loadStudyCard(`sentence:${row.id}`), null);
  await saveTextGroup(capture, approved);

  assert.ok((await loadOcrReviewCaptures()).some((item) => item.id === capture.id), 'An unsaved row keeps the photo in OCR Review');
  await saveTextGroup(capture, second);
  assert.ok(!(await loadOcrReviewCaptures()).some((item) => item.id === capture.id), 'All rows saved leaves OCR Review');
  assert.equal((await loadStudyCards()).filter((card) => card.captureId === capture.id && card.kind === 'sentence').length, 2, 'Each row is its own saved text');

  const blockCapture = { ...capture, id: 'rows-block' };
  await saveCapture(blockCapture);
  await saveTextGroup(blockCapture, textGroupsForCapture(blockCapture)[0]);
  assert.ok(!(await loadOcrReviewCaptures()).some((item) => item.id === blockCapture.id), 'A saved block covers its rows');
  await deleteCapture(capture.id);
  await deleteCapture(blockCapture.id);
  imageExists = true;
});

test('saved texts and words edit and delete independently, without resurrection or identity collisions', async () => {
  const store = await import('../src/capture/store.ts');
  const { rowGroupsForCapture } = await import('../src/capture/review.ts');
  const capture = { ...fixture, id: 'entries', savedAt: null, regions: [{ ...fixture.regions[0], id: '0:0', review: { selected: true } }] };
  await saveCapture(capture);
  const row = { ...rowGroupsForCapture(capture)[0], analysis: fixture.analysis };
  assert.equal((await saveTextGroup(capture, row)).added, 2);
  const textId = `sentence:${row.id}`;
  const wordsOf = async () => (await loadStudyCards()).filter((card) => card.captureId === capture.id && card.kind === 'word');
  const chicken = (await wordsOf()).find((card) => card.lemma === '鶏肉');

  await store.updateSavedText(row.id, '鶏肉をください！');
  const edited = (await loadTextGroups(capture.id))[0];
  assert.equal(edited.text, '鶏肉をください！');
  assert.equal(edited.analysis, null, 'Edited text drops readings for reanalysis');
  assert.deepStrictEqual(edited.analysisReview, {}, 'and its stale dictionary choices');
  assert.equal((await loadStudyCard(textId)).sourceText, '鶏肉をください！');
  const source = await loadCaptureById(capture.id);
  assert.equal(source.rawText, capture.rawText, 'Raw OCR is untouched');
  assert.deepStrictEqual(source.regions[0].bounds, capture.regions[0].bounds);
  assert.equal((await wordsOf()).length, 2, 'Recorded words are independent of text edits');
  await saveCapture(capture); // ordinary draft persistence from an open capture editor
  assert.equal((await loadTextGroups(capture.id))[0].text, '鶏肉をください！', 'Draft saves never revert an edited saved text');

  await store.updateWordCard(chicken.id, { lemma: '鳥肉', reading: 'トリニク', personalMeaning: ' poultry for dinner ' });
  const renamed = await loadStudyCard(chicken.id);
  assert.deepStrictEqual([renamed.lemma, renamed.reading, renamed.personalMeaning], ['鳥肉', 'とりにく', 'poultry for dinner']);
  assert.deepStrictEqual(renamed.wordSnapshot, chicken.wordSnapshot, 'Dictionary evidence is never rewritten');
  assert.deepStrictEqual(renamed.sourceRegions, chicken.sourceRegions);
  const other = (await wordsOf()).find((card) => card.id !== chicken.id);
  await assert.rejects(store.updateWordCard(other.id, { lemma: '鳥肉', reading: 'とりにく', personalMeaning: '' }), store.WordConflictError);
  assert.equal((await loadStudyCard(other.id)).lemma, other.lemma, 'A conflict changes nothing');

  // The edited card still owns the original natural id; saving the original word again must not collide.
  const resaved = await saveTextGroup(capture, row);
  assert.equal(resaved.added, 1);
  const restored = (await wordsOf()).find((card) => card.lemma === '鶏肉');
  assert.notEqual(restored.id, chicken.id);
  assert.equal((await loadStudyCard(chicken.id)).personalMeaning, 'poultry for dinner', 'The user’s edited word is not overwritten');

  await store.deleteWordCard(restored.id);
  assert.equal(await loadStudyCard(restored.id), null);
  assert.ok(await loadStudyCard(textId), 'Deleting a word keeps its text');
  assert.ok(await loadCaptureById(capture.id), 'and its photo');

  await deleteTextGroup(row.id);
  assert.equal(await loadStudyCard(textId), null, 'Deleting a text removes its card on the separate transaction connection');
  assert.equal((await wordsOf()).length, 2, 'and keeps its words');
  await assert.rejects(store.updateSavedText(row.id, 'stale edit'), /deleted/, 'A stale edit cannot resurrect a deleted text');
  assert.equal(await store.saveGroupAnalysisForText(row.id, row.text, fixture.analysis), false, 'nor can a stale reanalysis');
  assert.equal(await addWordCard(capture, 0, 'とりにく', { ...row, savedAt: '2026-10-04T00:00:00Z' }), null, 'nor a stale saved-text word save');
  assert.equal(await loadStudyCard(textId), null);

  // A kanji the parser could not place in context: a row save never records it implicitly; Save word may.
  const listRow = { ...row, id: `group:${capture.id}:row:list`, text: '雨', regionIds: [], analysis: { contractVersion: 2, language: 'ja', normalizedText: '雨', tokens: [
    { surface: '雨', lemma: '雨', reading: 'あめ', partOfSpeech: '接尾辞', writtenFormEvidence: true, scriptUnits: ['雨'],
      dictionaryCandidates: [{ id: '1171900:あめ', reading: 'あめ', meanings: ['rain'], recommended: false }] },
  ] } };
  assert.deepStrictEqual(await saveTextGroup(capture, listRow), { added: 0, existing: 0, pending: 1, unknown: 0 });
  assert.equal(await addWordCard(capture, 0, 'あめ', { ...listRow, savedAt: '2026-10-04' }), 'added', 'An explicit Save word approves it');
  assert.ok((await wordsOf()).some((card) => card.lemma === '雨' && card.reading === 'あめ'));
  await deleteTextGroup(listRow.id);

  const legacyCapture = { ...capture, id: 'old-whole-photo', savedAt: '2026-10-01T00:00:00Z' };
  await saveCapture(legacyCapture);
  await saveTextGroup(legacyCapture, { id: 'legacy:old-whole-photo', captureId: legacyCapture.id, regionIds: [], text: legacyCapture.correctedText, analysis: null, analysisReview: {}, savedAt: legacyCapture.savedAt });
  await deleteTextGroup('legacy:old-whole-photo');
  await saveCapture(legacyCapture); // a stale open editor still holding the legacy flag
  assert.equal((await loadCaptureById(legacyCapture.id)).savedAt, null, 'A deleted legacy text is not re-presented as saved');
  assert.ok(!(await loadStudyCards()).some((card) => card.captureId === legacyCapture.id), 'and none of its cards return');
  await deleteCapture(legacyCapture.id);

  // Restart: edits persist, deleted text stays deleted, and a provable orphan from the old bug is repaired.
  const buggyConnection = new DatabaseSync(databasePath, { enableForeignKeyConstraints: false }); // like the old exclusive transaction
  buggyConnection.exec(`INSERT INTO study_cards(id,capture_id,kind,language,source_text,created_at,group_id) VALUES ('sentence:orphan','entries','sentence','ja','orphan','2026-10-04','group:gone');
    INSERT INTO study_cards(id,capture_id,kind,language,lemma,reading,source_text,created_at,group_id) VALUES ('word:orphan','entries','word','ja','孤児','こじ','orphan','2026-10-04','group:gone');`);
  buggyConnection.close();
  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  const reopened = await import('../src/capture/store.ts?entries-restart');
  assert.equal(await reopened.loadStudyCard('sentence:orphan'), null, 'An orphan text card is repaired');
  assert.equal((await reopened.loadStudyCard('word:orphan')).groupId, null, 'An orphaned word is kept, only detached');
  assert.equal((await reopened.loadStudyCard(chicken.id)).personalMeaning, 'poultry for dinner');
  assert.equal(await reopened.loadStudyCard(textId), null);
  await reopened.deleteCapture(capture.id);
  imageExists = true;
});

test('practice cards are optional, idempotent, follow their entry, and obey the two entry-deletion choices', async () => {
  const store = await import('../src/capture/store.ts');
  const { rowGroupsForCapture } = await import('../src/capture/review.ts');
  const capture = { ...fixture, id: 'practice', savedAt: null, regions: [{ ...fixture.regions[0], id: '0:0', review: { selected: true } }] };
  await saveCapture(capture);
  const row = { ...rowGroupsForCapture(capture)[0], analysis: fixture.analysis };
  await saveTextGroup(capture, row);
  const entries = (await loadStudyCards()).filter((card) => card.captureId === capture.id);
  const text = entries.find((card) => card.kind === 'sentence');
  const chicken = entries.find((card) => card.lemma === '鶏肉');
  assert.equal((await store.loadPracticeCards()).length, 0, 'Saving entries never creates practice cards');

  await store.updateSavedText(row.id, row.text, ' Chicken, please. ');
  assert.equal((await loadStudyCard(text.id)).personalMeaning, 'Chicken, please.', 'The personal translation persists on the text entry');
  const textCard = await store.createPracticeCard(text.id);
  assert.equal((await store.createPracticeCard(text.id)).id, textCard.id, 'Create is idempotent');
  assert.equal(textCard.answer.personal, 'Chicken, please.');
  const wordCard = await store.createPracticeCard(chicken.id);
  await store.updateWordCard(chicken.id, { lemma: '鶏肉', reading: 'とりにく', personalMeaning: 'chicken' });
  assert.equal((await store.loadPracticeCard(wordCard.id)).answer.personal, 'chicken', 'A linked card follows entry edits');

  await store.deletePracticeCard(wordCard.id);
  assert.equal(await store.loadPracticeCard(wordCard.id), null);
  assert.ok(await loadStudyCard(chicken.id), 'Deleting a card keeps its entry');
  assert.ok(await loadCaptureById(capture.id), 'and its photo');

  const again = await store.createPracticeCard(chicken.id);
  await store.deleteWordCard(chicken.id, { keepPracticeCards: true });
  const kept = await store.loadPracticeCard(again.id);
  assert.equal(kept.entryId, null, 'Kept card is detached');
  assert.deepStrictEqual([kept.answer.prompt, kept.answer.reading, kept.answer.personal, kept.answer.dictionaryMeaning], ['鶏肉', 'とりにく', 'chicken', 'chicken meat'],
    'The snapshot is the entry’s effective answer at deletion');
  assert.equal(kept.captureId, capture.id, 'A kept card still knows its source photo');
  assert.deepStrictEqual(kept.answer.sourceRegions, chicken.sourceRegions, 'and the exact lines the entry was saved from');
  assert.ok(kept.answer.sourceRegions?.length, 'Saved rows always have line bounds');
  await saveCapture({ ...capture, regions: capture.regions.map((region) => ({ ...region, bounds: { x: 0.6, y: 0.6, width: 0.1, height: 0.1 } })) });
  assert.deepStrictEqual((await store.loadPracticeCard(again.id)).answer.sourceRegions, chicken.sourceRegions, 'Later OCR edits never move the snapshot bounds');
  await saveCapture(capture);

  await deleteTextGroup(row.id); // default: entry and its practice card are deleted together
  assert.equal(await store.loadPracticeCard(textCard.id), null);
  assert.equal(await loadStudyCard(text.id), null);

  await assert.rejects(store.createPracticeCard(text.id), store.EntryDeletedError, 'No card is created for a deleted entry');

  // QA race: the entry is deleted after the create commits but before its result is read.
  const raceRow = { ...rowGroupsForCapture(capture)[0], id: `group:${capture.id}:row:race`, regionIds: [] };
  await saveTextGroup(capture, raceRow);
  const raceEntry = (await loadStudyCards()).find((card) => card.groupId === raceRow.id);
  let release;
  const entered = new Promise((resolve) => { queryGate = { sql: 'SELECT * FROM practice_cards WHERE entry_id = ?', released: new Promise((done) => { release = done; }), entered: resolve }; });
  const creating = store.createPracticeCard(raceEntry.id);
  await entered;
  await deleteTextGroup(raceRow.id);
  release();
  await assert.rejects(creating, store.EntryDeletedError, 'Never resolves null when the entry vanished after commit');
  assert.ok(!(await store.loadPracticeCards()).some((card) => !card.answer), 'and leaves no orphan card');

  // An older linked card without photo provenance (before capture_id existed) gains it when kept on entry deletion.
  const olderEntry = (await loadStudyCards()).find((card) => card.captureId === capture.id && card.kind === 'word');
  const older = await store.createPracticeCard(olderEntry.id);
  sqlite.prepare('UPDATE practice_cards SET capture_id = NULL WHERE id = ?').run(older.id);
  await store.deleteWordCard(olderEntry.id, { keepPracticeCards: true });
  assert.equal(sqlite.prepare('SELECT capture_id FROM practice_cards WHERE id = ?').get(older.id).capture_id, capture.id, 'Kept cards record their source photo');
  await saveTextGroup(capture, row); // the photo keeps saved entries for the checks below
  assert.equal((await store.loadPracticeCards()).filter((card) => !card.answer).length, 0, 'and no answerless card is left behind');

  // Restart keeps the detached card; whole-photo deletion removes every card from that photo, detached or linked.
  const other = { ...capture, id: 'practice-other' };
  await saveCapture(other);
  await saveTextGroup(other, { ...rowGroupsForCapture(other)[0], analysis: fixture.analysis });
  const otherCard = await store.createPracticeCard((await loadStudyCards()).find((card) => card.captureId === other.id && card.kind === 'sentence').id);
  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  const reopened = await import('../src/capture/store.ts?practice-restart');
  assert.equal((await reopened.loadPracticeCard(again.id)).answer.prompt, '鶏肉');
  const words = (await reopened.loadStudyCards()).filter((card) => card.captureId === capture.id && card.kind === 'word');
  const linked = await reopened.createPracticeCard(words[0].id);
  await reopened.deleteCapture(capture.id);
  imageExists = true;
  assert.equal(await reopened.loadPracticeCard(linked.id), null, 'Photo deletion removes its linked practice cards');
  assert.equal(await reopened.loadPracticeCard(again.id), null, 'and its detached snapshot cards, by their source photo');
  assert.equal(await reopened.loadPracticeCard(older.id), null, 'including a kept card whose provenance was originally missing');
  assert.ok(await reopened.loadPracticeCard(otherCard.id), 'Another photo’s practice card is untouched');
  await reopened.deleteCapture(other.id);
  imageExists = true;
});

test('Save word persists once per identity, keeps the explicit sense, retries failures and refuses stale text', async () => {
  const store = await import('../src/capture/store.ts');
  const { rowGroupsForCapture } = await import('../src/capture/review.ts');
  const text = '雨と米';
  const candidate = (id, reading, meaning) => ({ id, reading, meanings: [meaning], recommended: false });
  const analysis = { contractVersion: 2, language: 'ja', normalizedText: text, tokens: [
    { surface: '雨', lemma: '雨', reading: 'あめ', partOfSpeech: '名詞', scriptUnits: ['雨'], dictionaryCandidates: [candidate('rain', 'あめ', 'rain')] },
    { surface: 'と', lemma: 'と', reading: 'と', partOfSpeech: '助詞', scriptUnits: [], dictionaryCandidates: [] },
    { surface: '米', lemma: '米', reading: 'べい', partOfSpeech: '名詞', scriptUnits: ['米'], dictionaryCandidates: [candidate('rice', 'こめ', 'rice'), candidate('usa', 'べい', 'America')] },
  ] };
  const capture = { ...fixture, id: 'word-save', savedAt: null, correctedText: text, regions: [{ ...fixture.regions[0], id: '0:0', text, review: { selected: true } }] };
  await saveCapture(capture);
  const row = { ...rowGroupsForCapture(capture)[0], analysis };
  const words = async () => (await loadStudyCards()).filter((card) => card.captureId === capture.id && card.kind === 'word');

  failWordWrite = true;
  await assert.rejects(addWordCard(capture, 0, 'あめ', row), /Word write failed/);
  failWordWrite = false;
  assert.equal((await words()).length, 0, 'A failed save leaves nothing behind');
  assert.equal(await addWordCard(capture, 0, 'あめ', row), 'added', 'Retry saves the word');
  assert.equal(await addWordCard(capture, 0, 'あめ', row), 'existing', 'A repeat tap reports the existing entry');
  assert.equal((await words()).filter((card) => card.lemma === '雨').length, 1, 'Never a duplicate');

  assert.equal(await addWordCard(capture, 2, 'べい', row), null, 'An ambiguous word needs an explicit sense');
  const chosen = { ...row, analysisReview: { 2: { ignored: false, dictionaryCandidateId: 'rice' } } };
  assert.equal(await addWordCard(capture, 2, 'こめ', chosen), 'added');
  const rice = (await words()).find((card) => card.lemma === '米');
  assert.deepStrictEqual([rice.reading, rice.dictionaryCandidateId, rice.wordSnapshot.dictionaryCandidates[0].meanings[0]], ['こめ', 'rice', 'rice'], 'The chosen sense, not another index');

  const saved = (await loadTextGroups(capture.id)).find((group) => group.id === row.id);
  await store.updateSavedText(row.id, '雨と米と魚');
  assert.equal(await addWordCard(capture, 0, 'あめ', { ...saved, analysis }), null, 'A save delayed past a text edit is refused');

  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  const reopened = await import('../src/capture/store.ts?word-save-reopen');
  assert.deepStrictEqual((await reopened.loadStudyCards()).filter((card) => card.captureId === capture.id && card.kind === 'word').map((card) => card.lemma).sort(), ['米', '雨'], 'Saved words survive a reopen');
  await reopened.deleteCapture(capture.id);
  imageExists = true;
});

test('store preserves choices, rejects stale writes, and keeps failed deletions retryable', async () => {
  assert.equal((await loadStudyCards()).filter((card) => card.captureId === legacy.id).length, 1, 'Existing saved text migrates to one sentence card');
  await saveCapture({ ...fixture, id: 'legacy-saved', savedAt: '2026-10-02T00:00:00Z' });
  assert.equal((await loadStudyCards()).filter((card) => card.captureId === legacy.id).length, 1);
  const legacyGroup = (await loadTextGroups(legacy.id))[0];
  await saveTextGroup({ ...fixture, id: legacy.id, savedAt: legacy.saved_at }, legacyGroup);
  const legacyCards = (await loadStudyCards()).filter((card) => card.captureId === legacy.id);
  assert.equal(legacyCards.filter((card) => card.kind === 'sentence').length, 1, 'Re-saving migrated group retains its existing card identity');
  assert.equal(legacyCards.find((card) => card.kind === 'sentence').id, `sentence:${legacy.id}`);
  const { loadTextEntryForGroup } = await import('../src/capture/store.ts');
  assert.equal(legacyGroup.id, `legacy:${legacy.id}`);
  assert.equal((await loadTextEntryForGroup(legacyGroup.id)).id, `sentence:${legacy.id}`,
    'A legacy group resolves its real text entry by group link, not a derived sentence:<groupId> id');
  assert.equal(await loadStudyCard(`sentence:${legacyGroup.id}`), null, 'The derived id never existed');
  assert.equal(legacyCards.filter((card) => card.kind === 'word').length, 2, 'An explicit re-save records the resolved words of the migrated text');
  const capture = { ...fixture, id: 'store-test', imageUri: 'file:///private/captures/test.jpg' };
  await saveCapture(capture);
  const review = { '0': { ignored: true, dictionaryCandidateId: 'chosen' } };
  await saveAnalysisReviewForText(capture.id, capture.correctedText, review);
  const translation = { sourceText: capture.correctedText, targetLanguage: 'en', text: 'Chicken, please.', wordMeanings: [] };
  assert.equal(await saveTranslationForText(capture.id, capture.correctedText, translation), true);
  assert.deepStrictEqual((await loadCaptureById(capture.id)).analysisReview, review);
  assert.equal(await saveTranslationForText(capture.id, 'stale', { ...translation, sourceText: 'stale' }), false);
  assert.deepStrictEqual((await loadCaptureById(capture.id)).sentenceTranslation, translation);
  const saved = { ...capture, savedAt: '2026-10-03T00:00:00Z' };
  await saveCapture(saved);
  const group = { id: 'group:store-test:0', captureId: saved.id, regionIds: saved.regions.map((region) => region.id), text: saved.correctedText, analysis: saved.analysis, analysisReview: saved.analysisReview, savedAt: saved.savedAt };
  await saveTextGroup(saved, group);
  await saveTextGroup(saved, group);
  assert.equal((await loadStudyCards()).filter((card) => card.captureId === saved.id && card.kind === 'sentence').length, 1, 'Repeated Save creates only one sentence card');
  assert.equal(await addWordCard(saved, 0, 'とりにく'), 'existing', 'Saving a known word again reports it as already saved');
  assert.equal(await addWordCard(saved, 0, 'とりにく'), 'existing');
  const cards = await loadStudyCards();
  assert.deepStrictEqual(cards.filter((card) => card.kind === 'word').map((card) => card.lemma).sort(), ['くださる', '鶏肉'], 'Saved words stay unique across texts and explicit approvals');
  assert.deepStrictEqual(await loadStudyCard(cards[1].id), cards[1]);
  const word = cards.find((card) => card.kind === 'word' && card.lemma === '鶏肉');
  const study = studyDataForCard(word, { ...saved, analysisReview: { '0': { ignored: false, dictionaryCandidateId: 'different-reading' } } });
  assert.equal(study.analysis.tokens.length, 1, 'Word reveal targets only its approved word');
  assert.equal(study.analysis.tokens[0].reading, word.reading);
  assert.ok(study.analysis.tokens[0].dictionaryCandidates.every((candidate) => hiraganaReading(candidate.reading) === word.reading));
  assert.equal(studyDataForCard(word, { ...saved, correctedText: 'Changed', analysis: null }).analysis.tokens[0].reading, word.reading, 'Approved word snapshot survives source edits');
  await saveCapture({ ...saved, correctedText: 'Changed source', analysis: null });
  assert.equal(await addWordCard(saved, 0, 'とりにく'), null, 'An existing word card does not authorize stale-source approval');
  assert.equal(await addWordCard(saved, 0, 'different'), null, 'Stale word source cannot create a card');
  assert.equal((await loadStudyCards()).find((card) => card.id === `sentence:${group.id}`).sourceText, group.text, 'Saving another source correction does not overwrite saved group');
  const second = { ...group, id: 'group:store-test:1', regionIds: [], text: 'Changed source', analysis: null };
  await saveTextGroup({ ...saved, correctedText: 'Changed source', analysis: null }, second);
  assert.equal((await loadTextGroups(saved.id)).length, 2);
  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  const withTwoGroups = await import('../src/capture/store.ts?two-groups');
  assert.equal((await withTwoGroups.loadTextGroups(saved.id)).length, 2, 'Multiple groups survive a full database reopen');
  assert.equal((await withTwoGroups.loadStudyCards()).filter((card) => card.captureId === saved.id).length, 2);
  failCardWrite = true;
  await assert.rejects(saveTextGroup({ ...saved, correctedText: 'Rollback' }, { ...second, id: 'rollback', text: 'Rollback' }), /Card write failed/);
  failCardWrite = false;
  assert.equal((await loadCaptureById(saved.id)).correctedText, 'Changed source');
  assert.equal((await loadTextGroups(saved.id)).length, 2, 'Group and source writes roll back if card creation fails');
  await enrichWordCardCharacters(word.id, [{ character: '鶏', meanings: ['chicken'], onReadings: ['ケイ'], kunReadings: ['にわとり'] }]);
  const enriched = await loadStudyCard(word.id);
  assert.equal(enriched.wordSnapshot.kanjiDetails[0].meanings[0], 'chicken');
  assert.equal(enriched.wordSnapshot.reading, word.wordSnapshot.reading);
  assert.deepStrictEqual(enriched.wordSnapshot.dictionaryCandidates, word.wordSnapshot.dictionaryCandidates);
  await deleteTextGroup(second.id);
  assert.ok(await loadCaptureById(saved.id), 'Removing a group never deletes the shared source');
  assert.equal(imageExists, true);

  const queueSource = { ...fixture, id: 'group-queue', savedAt: null, regions: [
    { ...fixture.regions[0], id: '0:0', text: '鶏肉', review: { selected: true } },
    { ...fixture.regions[0], id: '1:0', text: '果実', review: { selected: true } },
  ], correctedText: '鶏肉\n果実', analysis: null };
  await saveCapture(queueSource);
  const { textGroupsForCapture } = await import('../src/capture/review.ts');
  const queueGroups = textGroupsForCapture(queueSource);
  await saveTextGroup(queueSource, queueGroups[0]);
  assert.ok((await loadOcrReviewCaptures()).some((item) => item.id === queueSource.id));
  await saveTextGroup(queueSource, queueGroups[1]);
  assert.ok(!(await loadOcrReviewCaptures()).some((item) => item.id === queueSource.id), 'Fully saved groups leave OCR Review');
  const editedQueue = { ...queueSource, regions: queueSource.regions.map((region, index) => index ? region : { ...region, review: { selected: true, correctedText: '犬' } }) };
  await saveCapture(editedQueue);
  assert.ok((await loadOcrReviewCaptures()).some((item) => item.id === queueSource.id), 'An edited group re-enters the review queue');
  await deleteCapture(queueSource.id);
  imageExists = true;

  failImageDelete = true;
  await assert.rejects(deleteCapture(capture.id), /Image deletion failed/);
  assert.ok(await loadCaptureById(capture.id));
  assert.equal(imageExists, true);
  assert.equal(isCaptureDeleted(capture.id), false);

  failImageDelete = false;
  failSqlDelete = true;
  await assert.rejects(deleteCapture(capture.id), /SQL deletion failed/);
  assert.ok(await loadCaptureById(capture.id));
  assert.equal(isCaptureDeleted(capture.id), false);
  failSqlDelete = false;
  assert.equal(await deleteCapture(capture.id), true);
  assert.equal(await loadCaptureById(capture.id), null);
  assert.equal((await loadStudyCards()).filter((card) => card.captureId === capture.id).length, 0, 'Source deletion cascades to sentence and word cards');
  assert.equal(isCaptureDeleted(capture.id), true);
  assert.equal(await saveTranslationForText(capture.id, capture.correctedText, translation), false);
  await saveCapture(capture);
  assert.equal(await loadCaptureById(capture.id), null);
  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  const restarted = await import('../src/capture/store.ts?restart=1');
  const reopened = await restarted.loadStudyCards();
  assert.equal(reopened.filter((card) => card.kind === 'sentence').length, 1, 'Database reopen retains legacy sentence card without duplicating it');
  assert.ok(reopened.every((card) => card.captureId === legacy.id), 'Deleted source cards are not resurrected');
  sqlite.prepare('DELETE FROM study_cards WHERE capture_id = ?').run(legacy.id);
  const initializedAgain = await import('../src/capture/store.ts?restart=2');
  assert.equal((await initializedAgain.loadStudyCards()).length, 0, 'Completed migration does not recreate removed cards on app restart');
  sqlite.close();
  rmSync(testDirectory, { recursive: true, force: true });
});
