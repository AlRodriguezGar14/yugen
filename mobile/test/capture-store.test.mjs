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
// Models expo-sqlite natively: withExclusiveTransactionAsync opens a NEW connection on the same file
// (Transaction.createAsync, useNewConnection), where SQLite's foreign_keys defaults OFF, so no cascades run there.
function sqliteAdapter(transaction) { const db = () => transaction ?? sqlite; return {
    execAsync: async (sql) => db().exec(sql),
    getAllAsync: async (sql, ...params) => db().prepare(sql).all(...params),
    getFirstAsync: async (sql, ...params) => db().prepare(sql).get(...params) ?? null,
    runAsync: async (sql, ...params) => {
      if (failSqlDelete && sql.startsWith('DELETE')) throw new Error('SQL deletion failed');
      if (failCardWrite && sql.includes('INSERT INTO study_cards')) throw new Error('Card write failed');
      if (failWordWrite && sql.includes('INSERT INTO study_cards') && sql.includes("'word'")) throw new Error('Word write failed');
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
  File: class { get exists() { return imageExists; } delete() { if (failImageDelete) throw new Error('Image deletion failed'); imageExists = false; } },
} });

const fixture = JSON.parse(await readFile(new URL('../fixtures/capture-record.json', import.meta.url), 'utf8'));
const { captureToRow } = await import('../src/capture/types.ts');
// A device database from the earlier whole-photo version: one saved selection and one approved word card.
const legacy = captureToRow({ ...fixture, id: 'legacy-saved', savedAt: '2026-10-02T00:00:00Z' });
sqlite.exec(`CREATE TABLE captures (${Object.keys(legacy).map((name) => `${name} TEXT${name === 'id' ? ' PRIMARY KEY' : ''}`).join(', ')}); PRAGMA user_version = 1;`);
sqlite.prepare(`INSERT INTO captures VALUES (${Object.keys(legacy).map(() => '?').join(', ')})`).run(...Object.values(legacy));
sqlite.exec(`CREATE TABLE study_cards (id TEXT PRIMARY KEY NOT NULL, capture_id TEXT NOT NULL, kind TEXT NOT NULL, language TEXT NOT NULL,
  lemma TEXT NOT NULL DEFAULT '', reading TEXT NOT NULL DEFAULT '', token_index INTEGER, source_text TEXT NOT NULL, created_at TEXT NOT NULL);
  INSERT INTO study_cards VALUES ('word:legacy', 'legacy-saved', 'word', 'ja', 'くださる', 'ください', 2, '${fixture.correctedText}', '2026-10-02T00:00:01Z');`);
const { addWordCard, saveTextGroup, loadTextGroups, saveCapture } = await import('../src/capture/store.ts');
const { rowGroupsForCapture, textGroupsForCapture } = await import('../src/capture/review.ts');
const cardsOf = (captureId, kind) => sqlite.prepare('SELECT * FROM study_cards WHERE capture_id = ? AND kind = ? ORDER BY created_at, id').all(captureId, kind);

test('rows save independently and record only resolved words; ambiguous and unknown stay pending', async () => {
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
  const capture = { ...fixture, id: 'rows', correctedText: `${text}\n果実`, regions: [
    { ...fixture.regions[0], id: '0:0', text, review: { selected: true } },
    { ...fixture.regions[0], id: '0:1', text: '果実', review: { selected: true } },
  ] };
  await saveCapture(capture);
  const [row] = rowGroupsForCapture(capture);
  assert.equal(row.id, 'group:rows:row:0:0', 'Row identity is its stable source region');
  assert.deepStrictEqual(row.regionIds, ['0:0']);

  assert.equal(await saveTextGroup(capture, row), null, 'Without readings only the text is saved; nothing is invented');
  assert.equal(cardsOf(capture.id, 'word').length, 0);

  const reviewed = { ...row, analysis };
  failWordWrite = true;
  await assert.rejects(saveTextGroup(capture, reviewed), /Word write failed/);
  failWordWrite = false;
  assert.equal((await loadTextGroups(capture.id))[0].analysis, null, 'A failed word write rolls back the row update too');
  assert.equal(cardsOf(capture.id, 'word').length, 0);

  assert.deepStrictEqual(await saveTextGroup(capture, reviewed), { added: 1, existing: 0, pending: 1, unknown: 1 }, 'Counts unique words, not repeated tokens');
  assert.deepStrictEqual(cardsOf(capture.id, 'word').map((card) => [card.lemma, card.reading, card.group_id]), [['鶏肉', 'とりにく', row.id]]);
  const likely = { ...analysis, tokens: analysis.tokens.map((item, index) => index ? item : { ...item, dictionaryCandidates: item.dictionaryCandidates.map((entry, position) => ({ ...entry, recommended: !position })) }) };
  assert.equal((await saveTextGroup(capture, { ...row, analysis: likely })).pending, 1, 'A LIKELY hint is not an approval');
  const approved = { ...reviewed, analysisReview: { '0': { ignored: false, dictionaryCandidateId: 'rice:こめ' } } };
  assert.deepStrictEqual(await saveTextGroup(capture, approved), { added: 1, existing: 1, pending: 0, unknown: 1 });
  assert.equal(cardsOf(capture.id, 'word').length, 2, 'Repeated saves never duplicate words');
  const otherSense = { ...reviewed, analysisReview: { '0': { ignored: false, dictionaryCandidateId: 'usa:べい' } } };
  await saveTextGroup(capture, otherSense);
  assert.deepStrictEqual(cardsOf(capture.id, 'word').filter((card) => card.lemma === '米').map((card) => JSON.parse(card.word_snapshot).dictionaryCandidates[0].meanings[0]).sort(), ['America', 'rice'],
    'A different reading is a different word; the approved rice sense is untouched');
  assert.equal(cardsOf(capture.id, 'sentence').length, 1, 'Repeated row saves keep one saved text');

  const chicken = cardsOf(capture.id, 'word').find((card) => card.lemma === '鶏肉');
  assert.deepStrictEqual(JSON.parse(chicken.source_regions), [{ id: '0:0', bounds: capture.regions[0].bounds }], 'A word keeps the photo line it was first saved from');
  const moved = { ...capture, regions: capture.regions.map((region, index) => index ? region : { ...region, bounds: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } }) };
  await saveTextGroup(moved, approved);
  assert.equal(cardsOf(capture.id, 'word').find((card) => card.id === chicken.id).source_regions, chicken.source_regions, 'Re-saving never moves a word’s provenance');

  const blockCapture = { ...capture, id: 'rows-block' };
  await saveCapture(blockCapture);
  const [block] = textGroupsForCapture(blockCapture);
  assert.equal(block.text, `${text}\n果実`, 'A native OCR block is one paragraph with its line breaks');
  await saveTextGroup(blockCapture, block);
  assert.equal(cardsOf(blockCapture.id, 'sentence')[0].source_text, block.text);
});

test('Save word persists once per identity, keeps the explicit sense and retries failures atomically', async () => {
  const text = '雨と麦';
  const candidate = (id, reading, meaning) => ({ id, reading, meanings: [meaning], recommended: false });
  const analysis = { contractVersion: 2, language: 'ja', normalizedText: text, tokens: [
    { surface: '雨', lemma: '雨', reading: 'あめ', partOfSpeech: '名詞', scriptUnits: ['雨'], dictionaryCandidates: [candidate('rain', 'あめ', 'rain')] },
    { surface: 'と', lemma: 'と', reading: 'と', partOfSpeech: '助詞', scriptUnits: [], dictionaryCandidates: [] },
    { surface: '麦', lemma: '麦', reading: 'ばく', partOfSpeech: '名詞', scriptUnits: ['麦'], dictionaryCandidates: [candidate('wheat', 'むぎ', 'wheat'), candidate('baku', 'ばく', 'barley (literary)')] },
  ] };
  const capture = { ...fixture, id: 'word-save', correctedText: text, regions: [{ ...fixture.regions[0], id: '0:0', text, review: { selected: true } }] };
  await saveCapture(capture);
  const row = { ...rowGroupsForCapture(capture)[0], analysis };

  failWordWrite = true;
  await assert.rejects(addWordCard(capture, 0, 'あめ', row), /Word write failed/);
  failWordWrite = false;
  assert.equal(cardsOf(capture.id, 'word').length, 0, 'A failed save leaves nothing behind');
  assert.ok(!(await loadTextGroups(capture.id)).some((group) => group.id === row.id), 'Save word rolls back its parent row on failure');
  assert.equal(await addWordCard(capture, 0, 'アメ', row), 'added', 'Retry saves the word; readings compare as hiragana');
  assert.ok((await loadTextGroups(capture.id)).some((group) => group.id === row.id), 'Save word saves its parent row');
  assert.equal(await addWordCard(capture, 0, 'あめ', row), 'existing', 'A repeat tap reports the existing entry');
  assert.equal(cardsOf(capture.id, 'word').filter((card) => card.lemma === '雨').length, 1, 'Never a duplicate');

  assert.equal(await addWordCard(capture, 2, 'ばく', row), null, 'An ambiguous word needs an explicit sense');
  const chosen = { ...row, analysisReview: { 2: { ignored: false, dictionaryCandidateId: 'wheat' } } };
  assert.equal(await addWordCard(capture, 2, 'ばく', chosen), null, 'A reading other than the chosen sense is refused');
  assert.equal(await addWordCard(capture, 2, 'むぎ', chosen), 'added');
  const wheat = cardsOf(capture.id, 'word').find((card) => card.lemma === '麦');
  assert.deepStrictEqual([wheat.reading, wheat.candidate_id, JSON.parse(wheat.word_snapshot).dictionaryCandidates[0].meanings[0]], ['むぎ', 'wheat', 'wheat'], 'The chosen sense, not another index');

  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  const reopened = await import('../src/capture/store.ts?word-save-reopen');
  assert.ok((await reopened.loadTextGroups(capture.id)).length, 'Saved rows survive a reopen');
  assert.deepStrictEqual(cardsOf(capture.id, 'word').map((card) => card.lemma).sort(), ['雨', '麦'], 'Saved words survive a reopen');
});

test('written-form evidence is never recorded by a row save, only by an explicit Save word', async () => {
  const capture = { ...fixture, id: 'list', correctedText: '魚', regions: [{ ...fixture.regions[0], id: '0:0', text: '魚', review: { selected: true } }] };
  await saveCapture(capture);
  // A kanji the parser could not place in context.
  const listRow = { ...rowGroupsForCapture(capture)[0], analysis: { contractVersion: 2, language: 'ja', normalizedText: '魚', tokens: [
    { surface: '魚', lemma: '魚', reading: 'さかな', partOfSpeech: '接尾辞', writtenFormEvidence: true, scriptUnits: ['魚'],
      dictionaryCandidates: [{ id: '1578010:さかな', reading: 'さかな', meanings: ['fish'], recommended: false }] },
  ] } };
  assert.deepStrictEqual(await saveTextGroup(capture, listRow), { added: 0, existing: 0, pending: 1, unknown: 0 });
  assert.equal(cardsOf(capture.id, 'word').length, 0);
  assert.equal(await addWordCard(capture, 0, 'さかな', listRow), 'added', 'An explicit Save word approves it');
  assert.deepStrictEqual(cardsOf(capture.id, 'word').map((card) => [card.lemma, card.reading]), [['魚', 'さかな']]);
});

test('entry reads retain approved words and the actual migrated text identity', async () => {
  const store = await import('../src/capture/store.ts');
  const legacyGroups = await store.loadTextGroups('legacy-saved');
  assert.equal(legacyGroups.length, 1);
  const legacyEntry = await store.loadTextEntryForGroup(legacyGroups[0].id);
  assert.ok(legacyEntry);
  assert.equal(legacyEntry.groupId, legacyGroups[0].id);
  assert.equal((await store.loadStudyCard(legacyEntry.id)).sourceText, legacyGroups[0].text);
  const entries = await store.loadStudyCards();
  assert.ok(entries.some((entry) => entry.kind === 'word' && entry.wordSnapshot));
});

test('legacy saved entries survive the schema upgrade once, as text groups with their words', async () => {
  // The first store use (in earlier tests) upgraded the old database; nothing else touches this capture.
  const [legacyGroup] = await loadTextGroups(legacy.id);
  assert.equal(legacyGroup.id, `legacy:${legacy.id}`, 'An old saved selection becomes one legacy group');
  assert.equal(legacyGroup.text, fixture.correctedText);
  assert.deepStrictEqual(legacyGroup.analysis, fixture.analysis, 'Its readings are kept');
  assert.equal(cardsOf(legacy.id, 'sentence').length, 1, 'Existing saved text migrates to one sentence card');
  assert.equal(cardsOf(legacy.id, 'sentence')[0].group_id, legacyGroup.id);
  const word = cardsOf(legacy.id, 'word')[0];
  assert.equal(word.group_id, legacyGroup.id, 'An old word card links to its migrated text');
  assert.deepStrictEqual(JSON.parse(word.word_snapshot).dictionaryCandidates, fixture.analysis.tokens[2].dictionaryCandidates, 'and gains an approved snapshot of its reading');
  assert.equal(word.candidate_id, null, 'No sense is invented when none was chosen');

  await saveCapture({ ...fixture, id: legacy.id, savedAt: legacy.saved_at });
  assert.equal(cardsOf(legacy.id, 'sentence').length, 1, 'Draft persistence never duplicates the migrated card');
  assert.deepStrictEqual(await saveTextGroup({ ...fixture, id: legacy.id, savedAt: legacy.saved_at }, legacyGroup), { added: 0, existing: 2, pending: 0, unknown: 0 },
    'An explicit re-save resolves the migrated words; the old card and an already saved word are not duplicated');
  assert.deepStrictEqual(cardsOf(legacy.id, 'sentence').map((card) => card.id), [`sentence:${legacy.id}`], 'Re-saving the migrated group retains its existing card identity');
  assert.deepStrictEqual(cardsOf(legacy.id, 'word').map((card) => card.id), ['word:legacy']);

  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  sqlite.prepare("DELETE FROM study_cards WHERE capture_id = ? AND kind = 'sentence'").run(legacy.id);
  const restarted = await import('../src/capture/store.ts?legacy-restart');
  assert.equal((await restarted.loadTextGroups(legacy.id)).length, 1);
  assert.equal(cardsOf(legacy.id, 'sentence').length, 0, 'Completed migrations do not recreate removed cards on restart');
});

test('entry edits preserve dictionary evidence, reject identity collisions and invalidate only changed text', async () => {
  const store = await import('../src/capture/store.ts');
  const capture = { ...fixture, id: 'editing', correctedText: '犬', regions: [{ ...fixture.regions[0], id: '0:0', text: '犬', review: { selected: true } }] };
  await store.saveCapture(capture);
  const group = { ...rowGroupsForCapture(capture)[0], analysis: { contractVersion: 2, language: 'ja', normalizedText: '犬', tokens: [{ surface: '犬', lemma: '犬', reading: 'いぬ', partOfSpeech: '名詞', scriptUnits: ['犬'], dictionaryCandidates: [{ id: 'dog', reading: 'いぬ', meanings: ['dog'], recommended: false }] }] } };
  await store.saveTextGroup(capture, group);
  const entry = (await store.loadStudyCards()).find((card) => card.captureId === capture.id && card.kind === 'word');
  await store.updateWordCard(entry.id, { lemma: '狗', reading: 'イヌ', personalMeaning: ' My dog ' });
  const edited = await store.loadStudyCard(entry.id);
  assert.deepEqual([edited.lemma, edited.reading, edited.personalMeaning], ['狗', 'いぬ', 'My dog']);
  assert.equal(edited.wordSnapshot.surface, '犬');
  const other = (await store.loadStudyCards()).find((card) => card.kind === 'word' && card.id !== entry.id);
  await assert.rejects(store.updateWordCard(entry.id, { lemma: other.lemma, reading: other.reading, personalMeaning: '' }), store.WordConflictError);
  assert.equal((await store.loadStudyCard(entry.id)).lemma, '狗');
  await store.updateSavedText(group.id, '犬');
  assert.ok((await store.loadTextGroup(group.id)).analysis, 'Unchanged wording retains readings');
  await store.updateSavedText(group.id, '犬です');
  assert.equal((await store.loadTextGroup(group.id)).analysis, null);
  assert.equal((await store.loadTextEntryForGroup(group.id)).sourceText, '犬です');
  assert.equal((await store.loadCaptureById(capture.id)).rawText, capture.rawText);
  assert.equal((await store.loadStudyCard(entry.id)).wordSnapshot.surface, '犬');
});

test('personal paragraph translations persist separately without replacing unchanged dictionary analysis', async () => {
  const store = await import('../src/capture/store.ts');
  const group = (await store.loadTextGroups('editing'))[0];
  await store.updateSavedText(group.id, group.text, ' My own translation ');
  const entry = await store.loadTextEntryForGroup(group.id);
  assert.equal(entry.personalMeaning, 'My own translation');
  assert.equal(entry.sourceText, group.text);
  assert.equal((await store.loadCaptureById('editing')).sentenceTranslation, fixture.sentenceTranslation);
  await store.updateSavedText(group.id, group.text, '');
  assert.equal((await store.loadTextEntryForGroup(group.id)).personalMeaning, null);
});

test('practice is explicit and idempotent, follows current entries, and deletes independently', async () => {
  const store = await import('../src/capture/store.ts');
  const entry = (await store.loadStudyCards()).find((card) => card.captureId === 'editing' && card.kind === 'word');
  assert.equal(await store.loadPracticeCardForEntry(entry.id), null);
  const card = await store.createPracticeCard(entry.id);
  assert.equal((await store.createPracticeCard(entry.id)).id, card.id);
  assert.equal((await store.loadPracticeCards()).filter((item) => item.entryId === entry.id).length, 1);
  assert.equal(card.answer.prompt, entry.lemma);
  await store.updateWordCard(entry.id, { lemma: entry.lemma, reading: entry.reading, personalMeaning: 'Updated personal answer' });
  assert.equal((await store.loadPracticeCard(card.id)).answer.personal, 'Updated personal answer');
  assert.equal(card.captureId, entry.captureId);
  assert.deepEqual(card.answer.sourceRegions, entry.sourceRegions);
  await store.deletePracticeCard(card.id);
  assert.equal(await store.loadPracticeCard(card.id), null);
  assert.ok(await store.loadStudyCard(entry.id));
  assert.ok(await store.loadCaptureById(entry.captureId));
});

test('entry deletion offers delete-both or latest-answer KEEP snapshots while preserving photo and other entries', async () => {
  const store = await import('../src/capture/store.ts');
  const word = (await store.loadStudyCards()).find((entry) => entry.captureId === 'editing' && entry.kind === 'word');
  const practice = await store.createPracticeCard(word.id);
  await store.updateWordCard(word.id, { lemma: word.lemma, reading: word.reading, personalMeaning: 'Latest approved answer' });
  await store.deleteWordCard(word.id, { keepPracticeCards: true });
  const kept = await store.loadPracticeCard(practice.id);
  assert.equal(kept.entryId, null);
  assert.equal(kept.answer.personal, 'Latest approved answer');
  assert.deepEqual(kept.answer.sourceRegions, word.sourceRegions);
  assert.equal(kept.captureId, word.captureId);
  const group = (await store.loadTextGroups('editing'))[0];
  const text = await store.loadTextEntryForGroup(group.id);
  const textPractice = await store.createPracticeCard(text.id);
  await store.deleteTextGroup(group.id);
  assert.equal(await store.loadPracticeCard(textPractice.id), null);
  assert.equal(await store.loadStudyCard(text.id), null);
  assert.ok(await store.loadPracticeCard(practice.id));
  assert.ok(await store.loadCaptureById(word.captureId));
  assert.ok((await store.loadStudyCards()).some((entry) => entry.captureId !== word.captureId));
});

test('photo deletion is explicit across native connections and remains retryable on file or SQL failure', async () => {
  const store = await import('../src/capture/store.ts');
  const capture = await store.loadCaptureById('editing');
  await store.saveCapture({ ...capture, imageUri: 'file:///private/captures/editing.jpg' });
  assert.ok((await store.loadPracticeCards()).some((card) => card.captureId === capture.id && !card.entryId));
  failImageDelete = true;
  await assert.rejects(store.deleteCapture(capture.id), /Image deletion failed/);
  failImageDelete = false;
  assert.ok(await store.loadCaptureById(capture.id));
  assert.ok(imageExists);
  failSqlDelete = true;
  await assert.rejects(store.deleteCapture(capture.id), /SQL deletion failed/);
  failSqlDelete = false;
  assert.ok(await store.loadCaptureById(capture.id));
  assert.ok((await store.loadPracticeCards()).some((card) => card.captureId === capture.id), 'Database deletion rolled back');
  await store.deleteCapture(capture.id);
  assert.equal(await store.loadCaptureById(capture.id), null);
  assert.equal((await store.loadPracticeCards()).filter((card) => card.captureId === capture.id).length, 0, 'Detached cards deleted by source provenance');
  assert.equal((await store.loadStudyCards()).filter((entry) => entry.captureId === capture.id).length, 0);
  assert.ok(await store.loadCaptureById('rows'), 'Other source untouched');
  imageExists = true;
});

test('a failed saved-text card write rolls back its group and source correction', async () => {
  const capture = { ...fixture, id: 'rollback' };
  await saveCapture(capture);
  const row = rowGroupsForCapture(capture)[0];
  failCardWrite = true;
  await assert.rejects(saveTextGroup({ ...capture, correctedText: 'Rollback' }, { ...row, text: 'Rollback' }), /Card write failed/);
  failCardWrite = false;
  assert.equal(sqlite.prepare('SELECT corrected_text FROM captures WHERE id = ?').get(capture.id).corrected_text, capture.correctedText);
  assert.equal((await loadTextGroups(capture.id)).length, 0, 'Group and source writes roll back if card creation fails');
  await assert.rejects(saveTextGroup({ ...capture, id: 'never-saved' }, { ...row, captureId: 'never-saved' }), /source was deleted/, 'A group never saves without its source photo');
  sqlite.close();
  rmSync(testDirectory, { recursive: true, force: true });
});


