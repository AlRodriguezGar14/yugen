import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as analysisHelpers from '../src/capture/analysis.ts';
import * as reviewHelpers from '../src/capture/review.ts';
import * as translationHelpers from '../src/capture/translation.ts';
import { excludeRegions, markCaptureOcrFailed, mergePersistedAnalysis, selectRecognizedFindings, updateRegionCorrection } from '../src/capture/review.ts';
import { brushTouchesBounds, cropBoundsToPixels, mapCropBoundsToImage, normalizeBounds, ocrResizeFor } from '../src/capture/geometry.ts';

const source = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
const reviewSource = await readFile(new URL('../src/capture/CaptureReview.tsx', import.meta.url), 'utf8');
const fixture = JSON.parse(await readFile(new URL('../fixtures/capture-record.json', import.meta.url), 'utf8'));

/**
 * Mounts a production screen under a minimal hook runtime whose effects and callbacks re-run only when their
 * dependencies really change; `refocus()` re-runs focus callbacks like returning to the screen with Back.
 */
async function mountScreen(path, dependencies, routeParams = {}, router = { push() {}, back() {}, navigate() {} }, props = undefined) {
  const slots = [];
  const focus = new Map();
  let cursor = 0;
  // Pending effects by hook slot; an effect's deps are recorded only when it actually runs (like React's commit).
  const queued = new Map();
  const changed = (index, deps) => !slots[index] || !deps || !slots[index].deps || deps.some((dep, at) => !Object.is(dep, slots[index].deps[at]));
  const react = {
    useState: (initial) => {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useRef: (initial) => { const index = cursor++; slots[index] ??= { value: { current: initial } }; return slots[index].value; },
    useCallback: (fn, deps) => { const index = cursor++; if (changed(index, deps)) slots[index] = { value: fn, deps }; return slots[index].value; },
    useEffect: (effect, deps) => {
      const index = cursor++;
      if (!changed(index, deps)) { queued.delete(index); return; }
      slots[index] ??= { deps: undefined };
      queued.set(index, () => { slots[index].cleanup?.(); slots[index].deps = deps; slots[index].cleanup = effect() ?? undefined; });
    },
  };
  const render = (type, props) => typeof type === 'function' ? type(props) : { type, ...props };
  const modules = {
    react, 'react/jsx-runtime': { jsx: render, jsxs: render },
    'expo-router': { router, useLocalSearchParams: () => routeParams,
      useFocusEffect: (callback) => { focus.set(cursor, callback); react.useEffect(callback, [callback]); } },
    ...dependencies,
  };
  // Compiles a production module against this runtime; `{ __compile: path, dependencies }` entries are nested modules.
  async function compile(modulePath, moduleDependencies) {
    const compiled = {};
    const resolved = { react, 'react/jsx-runtime': modules['react/jsx-runtime'], ...moduleDependencies };
    for (const [name, value] of Object.entries(resolved)) if (value?.__compile) resolved[name] = await compile(value.__compile, value.dependencies);
    const source = await readFile(new URL(modulePath, import.meta.url), 'utf8');
    new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)((name) => {
      assert.ok(name in resolved, `Unexpected screen dependency: ${name}`);
      return resolved[name];
    }, compiled);
    return { __esModule: true, ...compiled };
  }
  const exports = await compile(path, modules);
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join(' ')
    : node && typeof node === 'object' ? textOf(node.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function frame() {
    cursor = 0;
    exports.default(props);
    const runs = [...queued.values()];
    queued.clear();
    runs.forEach((run) => run());
    await settle();
    cursor = 0;
    return textOf(exports.default(props));
  }
  async function refocus() {
    for (const [index, callback] of focus) { slots[index]?.cleanup?.(); slots[index].cleanup = callback() ?? undefined; }
    await settle();
    return frame();
  }
  async function press(label) {
    const find = (node) => Array.isArray(node) ? node.map(find).find(Boolean)
      : node && typeof node === 'object' ? (node.accessibilityRole === 'button' && !node.disabled && (textOf(node.children).trim() === label || node.accessibilityLabel === label) ? node : find(node.children)) : undefined;
    cursor = 0;
    const button = find(exports.default(props));
    assert.ok(button, `No button labeled ${label}`);
    await button.onPress();
    return frame();
  }
  const tree = () => { cursor = 0; return exports.default(props); };
  return { slots, frame, refocus, press, tree };
}
// Resolve production declarations by AST name rather than their formatting or neighboring handlers.
function appDeclarations(...names) {
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(file));
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)) found.set(declaration.name.text, node.getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const name of names) assert.ok(found.has(name), `Missing production declaration: ${name}`);
  return names.map((name) => found.get(name)).join('\n');
}
const sessionSource = await readFile(new URL('../src/capture/useCaptureSession.ts', import.meta.url), 'utf8');

// Compiles the shipped hook; exposes its existing refs only for controlled queued-write I/O.
function handlers(capture, analyzeJapaneseImage = async () => { throw new Error('Unexpected OCR'); }, persisted = capture, failCompleteSave = false, overrides = {}) {
  const states = [];
  let cursor = 0;
  const saved = [];
  const routes = [];
  const deletedIds = new Set();
  const react = {
    useState(initial) {
      const index = cursor++;
      states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: (value) => ({ current: value }), useCallback: (callback) => callback,
    useEffect: () => {},
  };
  const saveCapture = async (record) => {
    if (record.status === 'complete' && failCompleteSave) { failCompleteSave = false; throw new Error('OCR save failed'); }
    saved.push(record); persisted = record;
  };
  const modules = {
    react, 'react-native': { AppState: { addEventListener: () => ({ remove() {} }) } },
    './store': { saveCapture: overrides.saveCapture ?? saveCapture, isCaptureDeleted: (id) => deletedIds.has(id) },
  };
  const exported = {};
  const instrumented = sessionSource.replace('return { ...session,', 'return { dirtyDrafts, writeQueue, ...session,');
  assert.notEqual(instrumented, sessionSource, 'Expose the production queue refs for controlled I/O');
  new Function('require', 'exports', ts.transpileModule(instrumented, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(
    (name) => { assert.ok(name in modules, `Unexpected hook module ${name}`); return modules[name]; }, exported);
  const session = exported.useCaptureSession();
  session.currentCapture.current = capture;
  states[0] = { capture, error: null, notice: null };
  const deps = {
    useCallback: (callback) => callback, run: session.run, flushDraft: session.flushDraft, currentCapture: session.currentCapture,
    activeOperation: session.activeOperation, analyzeJapaneseImage, markCaptureOcrFailed, selectRecognizedFindings,
    rowGroupsForCapture: reviewHelpers.rowGroupsForCapture, textGroupsForCapture: reviewHelpers.textGroupsForCapture,
    savedTextNotice: reviewHelpers.savedTextNotice, unsavedRows: reviewHelpers.unsavedRows,
    saveTextGroup: async (record, group) => { saved.push({ ...record, savedGroup: group }); return null; }, loadTextGroups: async () => [],
    saveAnalysisReviewForText: async (_id, _text, review) => { persisted = { ...persisted, analysisReview: review }; return true; },
    afterCommit: (mutation) => mutation, isCaptureDeleted: (id) => deletedIds.has(id),
    ImagePicker: { launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///photo.jpg', width: 4000, height: 3000 }] }) },
    Directory: class { uri = 'file:///private/captures'; create() {} },
    File: class { constructor(base, name) { this.uri = name ? `${base.uri}/${name}` : base; } async copy() {} },
    Paths: { document: 'file:///private' }, newId: () => 'imported', imageExtension: () => 'jpg', setShowCamera: () => {},
    loadCaptureById: async () => persisted,
    router: { push: (route) => routes.push(route), setParams: () => {} },
    ...overrides,
  };
  const code = appDeclarations('recognizeRecord', 'startNewCapture', 'importAsset', 'chooseImage', 'importCameraPhoto', 'saveSelection', 'saveVocabularyWord');
  const shipped = new Function(...Object.keys(deps), `${stripTypeScriptTypes(code)}\nreturn { recognizeRecord, startNewCapture, chooseImage, importCameraPhoto, saveSelection, saveVocabularyWord };`)(...Object.values(deps));
  return {
    ...shipped, recognize: (record) => session.run('ocr', (context) => shipped.recognizeRecord(record, context)),
    saved, routes, deletedIds, session, currentCapture: session.currentCapture,
    pendingDraftSave: session.writeQueue, dirtyDrafts: session.dirtyDrafts,
    setPersisted: (record) => { persisted = record; },
    completePendingWrite: (record) => { saved.push(record); persisted = record; session.dirtyDrafts.current.delete(record.id); },
    get shown() { return states[0].capture; }, get settled() { return states[2]; }, get error() { return states[0].error; }, get notice() { return states[0].notice; },
  };
}

test('capture handlers defer fresh navigation, preserve OCR retry output, and save explicit valid choices', async () => {
  const fullBounds = { x: 0, y: 0, width: 1, height: 1 };
  let automaticCalls = 0;
  const automatic = handlers(null, async (_uri, _width, _height, bounds) => {
    automaticCalls += 1;
    assert.deepStrictEqual(bounds, fullBounds);
    return { rawText: '鶏肉をください。', regions: fixture.regions, imageDimensions: { width: 3000, height: 4000 } };
  });
  await automatic.chooseImage('library');
  assert.equal(automaticCalls, 1, 'Photo import must start OCR without another confirmation');
  assert.equal(automatic.shown.status, 'complete');
  assert.ok(automatic.shown.regions.every((region) => region.review.selected));
  assert.equal(automatic.shown.imageMetadata.width, 4000, 'Original encoded metadata remains preserved');
  assert.equal(automatic.shown.imageMetadata.displayWidth, 3000, 'Overlay uses upright rendered dimensions');

  let resolveOcr;
  let enteredOcr;
  const entered = new Promise((resolve) => { enteredOcr = resolve; });
  const ocr = new Promise((resolve) => { resolveOcr = resolve; });
  const pending = handlers({ ...fixture, status: 'selecting' }, () => { enteredOcr(); return ocr; });
  const recognition = pending.recognize(pending.shown);
  await entered;
  await pending.startNewCapture();
  assert.equal(pending.shown.status, 'processing');
  resolveOcr({ rawText: '米', regions: fixture.regions, imageDimensions: { width: 3000, height: 4000 } });
  await recognition;
  assert.equal(pending.shown.rawText, '米');
  assert.equal(pending.settled, 1);
  assert.equal(pending.saved.at(-1).status, 'complete');
  await pending.startNewCapture();
  assert.equal(pending.shown, null);

  const failedSave = handlers({ ...fixture, status: 'selecting' }, async () => ({ rawText: '米', regions: fixture.regions, imageDimensions: { width: 3000, height: 4000 } }), fixture, true);
  await failedSave.recognize(failedSave.shown);
  assert.equal(failedSave.shown.status, 'failed');
  assert.equal(failedSave.shown.rawText, '米');
  assert.equal(failedSave.settled, 1);
  assert.equal(failedSave.saved.at(-1).status, 'failed');

  const failed = { ...fixture, status: 'failed', correctedText: '私の修正。' };
  const retry = handlers(failed);
  await retry.recognize(failed);
  assert.equal(retry.shown.status, 'complete');
  assert.equal(retry.saved[0].correctedText, failed.correctedText);
  assert.deepStrictEqual(retry.saved[0].regions, failed.regions);
  assert.equal(retry.saved[0].rawText, failed.rawText);

  const blank = handlers({ ...fixture, correctedText: ' \n\t ' });
  await blank.saveSelection();
  assert.equal(blank.saved.length, 0);
  assert.equal(blank.routes.length, 0);
  assert.match(blank.error, /enter some text/);

  const persisted = { ...fixture, analysisReview: { '0': { ignored: true, dictionaryCandidateId: 'detail' } } };
  const explicit = handlers(fixture, undefined, persisted);
  const choice = { ignored: false, dictionaryCandidateId: 'preview' };
  await explicit.saveSelection({ ...fixture, analysisReview: { ...fixture.analysisReview, '0': choice } });
  assert.deepStrictEqual(explicit.saved[0].analysisReview['0'], choice);
  assert.equal(explicit.routes[0].pathname, '/sentence/[id]');

  const oldTranslation = { sourceText: fixture.correctedText, targetLanguage: 'en', text: 'Old translation', wordMeanings: [] };
  const newTranslation = { ...oldTranslation, text: 'New translation' };
  const latestDraft = { ...fixture, sentenceTranslation: newTranslation };
  const draft = handlers(latestDraft, undefined, { ...fixture, sentenceTranslation: oldTranslation });
  let resolveDraft;
  draft.pendingDraftSave.current = new Promise((resolve) => { resolveDraft = resolve; })
    .then(() => draft.completePendingWrite(latestDraft));
  const leaving = draft.startNewCapture();
  await Promise.resolve();
  assert.equal(draft.saved.length, 0, 'New must wait for pending draft persistence');
  assert.equal(draft.shown, latestDraft);
  resolveDraft();
  await leaving;
  assert.deepStrictEqual(draft.saved.at(-1).sentenceTranslation, newTranslation);
  assert.equal(draft.shown, null);

  const failedDraft = handlers(latestDraft, undefined, { ...fixture, sentenceTranslation: oldTranslation });
  failedDraft.dirtyDrafts.current.set(latestDraft.id, latestDraft);
  failedDraft.pendingDraftSave.current = Promise.reject(new Error('Draft save failed'));
  await failedDraft.startNewCapture();
  assert.equal(failedDraft.saved.length, 1, 'Failed draft write retries the current snapshot before leaving without a redundant full-record write');
  assert.deepStrictEqual(failedDraft.saved.at(-1).sentenceTranslation, newTranslation);
  await failedDraft.pendingDraftSave.current;
  assert.equal(failedDraft.shown, null);
});

test('actual row save handler sends only matching readings and that row’s own choices', () => {
  const start = reviewSource.indexOf('  function reviewedGroup(');
  const end = reviewSource.indexOf('  function paintNoise(', start);
  assert.ok(start >= 0 && end > start, 'Missing review save handler extraction markers');
  const snippet = reviewSource.slice(start, end);
  const capture = { ...fixture, correctedText: '私の修正。' };
  const row = { id: 'group:x:row:0:1', captureId: capture.id, text: '私の修正。', regionIds: ['0:1'], analysis: null, analysisReview: {}, savedAt: null };
  const choice = { '0': { ignored: true, dictionaryCandidateId: 'chosen' } };
  const saved = [];
  function saveWith(analyses, group = row) {
    const deps = { capture, analyses, reviews: { [`${row.id}\n${row.text}`]: choice }, reviewKey: (item) => `${item.id}\n${item.text}`, setSavingId: () => {},
      onSave: (record, savedGroup) => saved.push({ record, group: savedGroup }) };
    new Function(...Object.keys(deps), `${stripTypeScriptTypes(snippet)}\nreturn saveGroup;`)(...Object.values(deps))(group);
  }
  saveWith({});
  assert.equal(saved[0].record, capture);
  assert.equal(saved[0].group.analysis, null, 'A row saved before readings arrive carries no analysis');
  assert.deepStrictEqual(saved[0].group.analysisReview, {});
  saveWith({ [row.text]: { normalizedText: 'Previous text' } });
  assert.equal(saved[1].group.analysis, null, 'Stale analysis is never saved');
  const matching = { normalizedText: row.text };
  saveWith({ [row.text]: matching });
  assert.equal(saved[2].group.analysis, matching);
  assert.deepStrictEqual(saved[2].group.analysisReview, choice);
  assert.deepStrictEqual(saved[2].group.regionIds, ['0:1'], 'A row keeps its source region identity');
  saveWith({ [row.text]: matching }, { ...row, id: 'group:x:row:9:9' });
  assert.deepStrictEqual(saved[3].group.analysisReview, {}, "Identical text never authorizes another row's choices");
});

test('row save handler records resolved words and reports pending ones without hiding missing readings', async () => {
  let words = { added: 2, existing: 1, pending: 1, unknown: 0 };
  let fail = false;
  const savedGroups = [];
  const capture = { ...fixture, regions: [{ ...fixture.regions[0], id: '0:0', text: '米', review: { selected: true } }, { ...fixture.regions[0], id: '1:0', text: '肉', review: { selected: true } }] };
  const row = { id: `group:${capture.id}:row:0:0`, captureId: capture.id, regionIds: ['0:0'], text: '米', analysis: null, analysisReview: {}, savedAt: null };
  const dependencies = {
    saveTextGroup: async (_record, group) => { if (fail) throw new Error('Word write failed'); savedGroups.push(group); return words; },
    loadTextGroups: async () => savedGroups,
  };
  const screen = handlers(capture, undefined, capture, false, dependencies);
  await screen.saveSelection(capture, row);
  assert.equal(screen.notice, 'Text saved · 2 new words in Vocabulary · 1 already saved · 1 word needs a meaning choice. 1 row not saved yet.');
  words = null;
  await screen.saveSelection(capture, row);
  assert.match(screen.notice, /Text saved in Saved texts with 0 words: readings are unavailable\. Retry readings/);
  screen.session.clearNotice();
  fail = true;
  await screen.saveSelection(capture, { ...row, id: `group:${capture.id}:row:1:0`, regionIds: ['1:0'], text: '肉' });
  assert.equal(screen.notice, null, 'A rolled-back save never reports success');
  assert.match(screen.error, /could not be saved/);

  // Unchecked legacy lines leave the capture-wide selection empty; a nonblank row still saves on its own text.
  fail = false;
  savedGroups.length = 0;
  const unselected = { ...capture, correctedText: '', regions: capture.regions.map((region) => ({ ...region, review: { selected: false } })) };
  const fromEmptySelection = handlers(unselected, undefined, unselected, false, dependencies);
  await fromEmptySelection.saveSelection(unselected, row);
  assert.equal(fromEmptySelection.error, null);
  assert.deepStrictEqual(savedGroups.map((group) => group.id), [row.id], 'The row is saved even with an empty parent selection');
  await fromEmptySelection.saveSelection(unselected, { ...row, text: ' \n ' });
  assert.match(fromEmptySelection.error, /enter some text/, 'An empty row is still rejected');
  assert.equal(savedGroups.length, 1);
});

test('shipped study preview shows local readings and words before optional AI, including local failure', async () => {
  const previewSource = await readFile(new URL('../src/capture/CaptureAnalysisPreview.tsx', import.meta.url), 'utf8');
  const jsx = (_type, props) => props;
  const modules = {
    react: { useRef: (initial) => ({ current: initial }), useEffect: () => {}, useCallback: (fn) => fn, useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {}, './analysis': analysisHelpers, './translation': translationHelpers,
    '../theme': { colors: {} }, './uiStyles': { styles: {} },
  };
  const compiled = ts.transpileModule(previewSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', compiled)((name) => {
    assert.ok(name in modules, `Unexpected study dependency: ${name}`);
    return modules[name];
  }, exports);
  function textOf(node) {
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    if (node && typeof node === 'object') return textOf(node.children);
    return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  }
  const props = { text: fixture.correctedText, analysis: fixture.analysis, busy: false, error: null, choices: {},
    translation: null, translationBusy: false, translationError: null, onTranslate() {}, onChooseCandidate() {}, onRetry() {}, showHeading: true };
  const local = textOf(exports.default(props));
  assert.doesNotMatch(local, /LOCAL FURIGANA/);
  assert.match(local, /WORDS & MEANINGS/);
  assert.match(local, /^とりにく\s+鶏肉\s+を[\s\S]*WORDS & MEANINGS/, 'Furigana sits on the text itself, ahead of the word list');
  assert.doesNotMatch(local.split('WORDS & MEANINGS')[0], /くださる/, 'Kana words get no reading; lemma readings never replace the source');
  assert.match(local, /chicken/);
  assert.doesNotMatch(local, /Optional AI translation|Translate sentence \+ words|Sends corrected text/);
  const translated = textOf(exports.default({ ...props, translation: { sourceText: props.text, targetLanguage: 'en', text: 'The complete sentence', wordMeanings: [{ tokenIndex: 0, surface: fixture.analysis.tokens[0].surface, meaning: 'Context gloss' }] } }));
  assert.doesNotMatch(translated, /The complete sentence|Context gloss/, 'AI is unused even with previously saved translation');
  const failed = textOf(exports.default({ ...props, analysis: null, error: 'Local service unavailable' }));
  assert.match(failed, /Local service unavailable.*Retry readings/);
  assert.doesNotMatch(failed, /Optional AI translation/);
  assert.match(textOf(exports.default({ ...props, error: 'Choice could not be saved' })), /Choice could not be saved.*Retry readings/, 'Cached readings must not hide persistence failures');
  assert.equal(local.match(/とりにく/g)?.length, 2, 'Multi-word text keeps its context ruby plus the word row');
  const fruit = { surface: '果実', lemma: '果実', reading: 'かじつ', partOfSpeech: '名詞', dictionaryCandidates: [{ id: 'fruit', reading: 'かじつ', meanings: ['fruit'], recommended: false }], scriptUnits: ['果', '実'] };
  const single = textOf(exports.default({ ...props, text: '果実', analysis: { contractVersion: 2, language: 'ja', normalizedText: '果実', tokens: [fruit] } }));
  assert.equal(single.match(/かじつ/g)?.length, 1, 'A one-word row shows its ruby once');
  assert.equal(single.match(/果実/g)?.length, 1);
  assert.match(single, /fruit/);
  const inflectedToken = { ...fruit, surface: 'ください', lemma: 'くださる', reading: 'ください', dictionaryCandidates: [{ id: 'kudasaru', reading: 'くださる', meanings: ['to give'], recommended: false }] };
  const inflected = textOf(exports.default({ ...props, text: 'ください', choices: { 0: 'kudasaru' }, analysis: { contractVersion: 2, language: 'ja', normalizedText: 'ください', tokens: [inflectedToken] } }));
  assert.match(inflected, /ください[\s\S]*くださる/, 'An inflected source keeps its own form beside the canonical word');
  // Real pre-fix phone list analysis: 雨/魚 had no dictionary word; their character evidence must still show, labeled.
  const list = JSON.parse(await readFile(new URL('../fixtures/n5-list-analysis.json', import.meta.url), 'utf8'));
  const listText = textOf(exports.default({ ...props, text: list.normalizedText, analysis: list, onSaveWord() {} }));
  const approvable = list.tokens.filter((token) => analysisHelpers.isContentToken(token) && token.dictionaryCandidates.some((candidate) => candidate.meanings.length)).length;
  assert.equal(listText.match(/Save word/g)?.length, approvable, 'Save word only where a dictionary entry can be approved');
  assert.doesNotMatch(listText.split('魚').at(-1), /Save word/, 'Character evidence (魚) offers no Save word');
  assert.match(listText, /雨\s+NO DICTIONARY WORD · CHARACTER MEANINGS \(KANJIDIC\)\s+雨\s+·\s+rain\s+·\s+ウ \/ あめ/, 'Basic 雨 shows rain and its readings');
  assert.match(listText, /魚\s+NO DICTIONARY WORD · CHARACTER MEANINGS \(KANJIDIC\)\s+魚\s+·\s+fish\s+·\s+ギョ \/ うお \/ さかな/);
  assert.doesNotMatch(listText, /Unknown · no dictionary entry/, 'Kanji with character data are never shown as plain unknown');
  assert.match(listText, /電食[\s\S]*electrolytic corrosion/, 'Dictionary words keep their own gloss; compounds are not split');
  const loading = textOf(exports.default({ ...props, analysis: null, busy: true }));
  assert.match(loading, /Checking local readings/);

  const studyDataSource = await readFile(new URL('../src/capture/studyCards.ts', import.meta.url), 'utf8');
  const studyExports = {};
  new Function('require', 'exports', ts.transpileModule(studyDataSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(() => analysisHelpers, studyExports);
  const cardSource = await readFile(new URL('../src/app/card/[id].tsx', import.meta.url), 'utf8');
  const cardModules = {
    ...modules,
    'expo-router': { router: { push() {}, back() {} }, useLocalSearchParams: () => ({ id: 'sentence:test' }), useFocusEffect: () => {} },
    'react-native-safe-area-context': {}, 'react-native': { StyleSheet: { create: (value) => value }, Platform: { OS: 'android' } },
    '../../capture/store': {}, '../../capture/analysis': analysisHelpers, '../../capture/types': {},
    '../../capture/studyCards': studyExports, '../../capture/CaptureAnalysisPreview': exports,
    '../../theme': { colors: {} },
  };
  cardModules['react/jsx-runtime'] = { jsx: (type, value) => typeof type === 'function' ? type(value) : value, jsxs: (type, value) => typeof type === 'function' ? type(value) : value };
  const cardExports = {};
  new Function('require', 'exports', ts.transpileModule(cardSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)((name) => cardModules[name], cardExports);
  const sentenceCard = { id: 'sentence:test', captureId: fixture.id, kind: 'sentence', tokenIndex: null, lemma: '', reading: '', sourceText: fixture.correctedText, createdAt: fixture.createdAt };
  function renderCard(card, revealed, draft = null, pending = null, practice = null, group = null) {
    // useState order: card, capture, revealed, loading, error, attempt, analysisBusy, regionIds, showPhoto, draft, pending.
    const states = [card, fixture, revealed, false, null, 0, false, [], false, draft, pending, null, 0, null, practice, false, 0, group];
    modules.react.useState = (initial) => [states.length ? states.shift() : typeof initial === 'function' ? initial() : initial, () => {}];
    modules.react.useEffect = () => {};
    return textOf(cardExports.default());
  }
  const front = renderCard(sentenceCard, false);
  assert.match(front, /RECALL FIRST.*Reveal readings/);
  assert.doesNotMatch(front, /WORDS & MEANINGS|chicken/);
  const revealed = renderCard(sentenceCard, true);
  assert.match(revealed, /とりにく.*chicken/);
  assert.match(revealed, /TEXT\s+·\s+SAVED TEXT/);
  assert.doesNotMatch(revealed, /SAVED VOCABULARY/);
  assert.doesNotMatch(revealed, /OpenAI|Optional AI|Translate sentence/);
  const word = renderCard({ ...sentenceCard, kind: 'word', tokenIndex: 0, lemma: fixture.analysis.tokens[0].lemma, reading: 'とりにく' }, true);
  assert.match(word, /とりにく.*chicken/);
  assert.match(word, /WORD\s+·\s+SAVED VOCABULARY/);
  assert.equal(word.match(/とりにく/g)?.length, 1, 'A word card shows its ruby once');
  assert.doesNotMatch(word, /please/);
  assert.equal(word.match(/DICTIONARY/g)?.length, 1, 'Only the approved word has a dictionary section');

  // Direct entry actions: each card edits and deletes only itself, with explicit labels and busy states.
  const savedText = { ...sentenceCard, groupId: 'group:x:row:0:0' };
  assert.match(renderCard(savedText, true), /Edit text[\s\S]*Delete text/);
  assert.doesNotMatch(renderCard(savedText, true), /Delete word|Delete photo/);
  const editingText = renderCard(savedText, true, { text: savedText.sourceText, lemma: '', reading: '', meaning: '' });
  assert.ok(editingText.indexOf('Cancel') < editingText.indexOf('WORDS & MEANINGS'), 'The editor and Save/Cancel sit under the entry, before long dictionary panels');
  assert.ok(renderCard(savedText, true).indexOf('Delete text') < renderCard(savedText, true).indexOf('Show in photo'), 'Entry actions precede the photo panel');
  // While the saved card reloads after Save changes, the stale card cannot be edited again.
  function buttonFor(node, label) {
    if (Array.isArray(node)) return node.map((child) => buttonFor(child, label)).find(Boolean);
    if (!node || typeof node !== 'object') return undefined;
    if (node.accessibilityRole === 'button' && textOf(node.children).includes(label)) return node;
    return buttonFor(node.children, label);
  }
  const states = [savedText, fixture, true, false, null, 0, false, [], false, null, 'saving'];
  modules.react.useState = (initial) => [states.length ? states.shift() : typeof initial === 'function' ? initial() : initial, () => {}];
  assert.equal(buttonFor(cardExports.default(), 'Edit text').disabled, true, 'Edit stays disabled until the authoritative card loads');
  assert.match(studyExports.recordedMeaning({ lemma: '鳥肉', reading: 'とりにく', wordSnapshot: { surface: '鶏肉', reading: 'とりにく', dictionaryCandidates: [{ meanings: ['chicken meat'] }] } }),
    /^Recorded dictionary entry for 鶏肉 \(とりにく\) · chicken meat$/, 'Library never presents the original gloss as the renamed word’s meaning');
  assert.equal(studyExports.recordedMeaning({ lemma: '鶏肉', reading: 'とりにく', wordSnapshot: { surface: '鶏肉', reading: 'とりにく', dictionaryCandidates: [{ meanings: ['chicken meat'] }] } }), 'chicken meat');
  assert.match(editingText, /Save changes[\s\S]*Cancel/);
  assert.doesNotMatch(editingText, /Edit text/);
  assert.match(renderCard(savedText, true, { text: 'x', lemma: '', reading: '', meaning: '' }, 'saving'), /Saving…/);
  assert.match(renderCard(savedText, true, null, 'deleting'), /Deleting…/);
  const snapshot = { ...fixture.analysis.tokens[0], surface: '鶏肉', reading: 'とりにく', dictionaryCandidates: [fixture.analysis.tokens[0].dictionaryCandidates[0]] };
  const wordCard = { ...sentenceCard, id: 'word:test', kind: 'word', tokenIndex: 0, lemma: '鳥肉', reading: 'とりにく', wordSnapshot: snapshot, personalMeaning: 'poultry' };
  const renamedWord = renderCard(wordCard, true);
  assert.match(renamedWord, /鳥肉[\s\S]*YOUR MEANING · NOT FROM THE DICTIONARY\s+poultry[\s\S]*DICTIONARY ENTRY AS RECORDED ·\s+鶏肉\s+·\s+とりにく[\s\S]*chicken/,
    'A personal meaning is labeled as the user’s and the recorded dictionary evidence stays visible');
  assert.match(renamedWord, /Edit word[\s\S]*Delete word/);
  assert.doesNotMatch(renamedWord, /WORDS & MEANINGS/, 'The recorded dictionary word is evidence, not presented as the edited entry');
  assert.ok(renamedWord.indexOf('鳥肉') < renamedWord.indexOf('鶏肉'), 'The edited word leads');
  assert.doesNotMatch(renamedWord, /Delete text/);
  assert.match(renderCard(wordCard, true, { text: '', lemma: '鳥肉', reading: 'とりにく', meaning: 'poultry' }), /WORD[\s\S]*READING[\s\S]*YOUR MEANING \(OPTIONAL · NOT FROM THE DICTIONARY\)[\s\S]*Save changes/);

  // Paragraph entry: the personal translation is labeled as the user's own words; practice is an explicit, separate card.
  const withTranslation = renderCard({ ...savedText, personalMeaning: 'Chicken, please.' }, true);
  assert.match(withTranslation, /YOUR TRANSLATION · YOUR OWN WORDS, NOT A DICTIONARY OR AI TRANSLATION\s+Chicken, please\./);
  assert.match(withTranslation, /Create practice card/);
  assert.doesNotMatch(withTranslation, /Practice · hide answers|Open practice card/, 'Entries are knowledge; recall lives on practice cards');
  assert.match(renderCard(savedText, true, null, null, { id: 'practice:1', entryId: savedText.id }), /Open practice card/);
  // A saved text records its analyzed words directly; a word entry never offers to save itself.
  const textGroup = { id: savedText.groupId, captureId: fixture.id, regionIds: [], text: savedText.sourceText, analysis: fixture.analysis, analysisReview: {}, savedAt: '2026-10-04' };
  assert.match(renderCard(savedText, true, null, null, null, textGroup), /chicken[\s\S]*Save word/, 'Text entry: Save word beside its words');
  assert.doesNotMatch(renderCard(savedText, true), /Save word/, 'No Save word without the saved text to guard it');
  assert.doesNotMatch(renderCard(wordCard, true, null, null, null, textGroup), /Save word/, 'A word entry does not save itself');
  assert.match(renderCard(savedText, true, { text: savedText.sourceText, lemma: '', reading: '', meaning: '' }), /TEXT[\s\S]*YOUR TRANSLATION \(OPTIONAL · YOUR OWN WORDS\)[\s\S]*Save changes/);

  // Practice card route: prompt first, answer on request, independent cards labeled, card-only deletion.
  const practiceSource = await readFile(new URL('../src/app/practice/[id].tsx', import.meta.url), 'utf8');
  const practiceExports = {};
  new Function('require', 'exports', ts.transpileModule(practiceSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)((name) => cardModules[name], practiceExports);
  function renderPractice(card, revealed) {
    const states = [card, false, revealed, false, null, false];
    modules.react.useState = (initial) => [states.length ? states.shift() : initial, () => {}];
    return textOf(practiceExports.default());
  }
  const answer = { kind: 'sentence', prompt: '鶏肉をください。', reading: null, dictionaryMeaning: null, personal: 'Chicken, please.', sourceText: '鶏肉をください。' };
  const prompt = renderPractice({ id: 'p', entryId: 'sentence:x', answer }, false);
  assert.match(prompt, /鶏肉をください。[\s\S]*Reveal answer[\s\S]*Open entry ›[\s\S]*Delete practice card/);
  assert.doesNotMatch(prompt, /Chicken, please\./, 'The answer stays hidden until revealed');
  assert.match(renderPractice({ id: 'p', entryId: 'sentence:x', answer }, true), /YOUR TRANSLATION · YOUR OWN WORDS\s+Chicken, please\./);
  const independent = renderPractice({ id: 'p', entryId: null, answer }, false);
  assert.match(independent, /INDEPENDENT CARD \(ITS ENTRY WAS DELETED\)/);
  assert.doesNotMatch(independent, /Open entry/);

  // Entry deletion prompt offers exactly the confirmed choices when a practice card exists.
  const alerts = [];
  const entryActions = {};
  const entrySource = await readFile(new URL('../src/capture/entryActions.ts', import.meta.url), 'utf8');
  new Function('require', 'exports', ts.transpileModule(entrySource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(
    () => ({ Alert: { alert: (title, message, buttons) => alerts.push({ title, message, buttons }) } }), entryActions);
  const chosen = [];
  entryActions.confirmEntryDeletion('word', true, (options) => chosen.push(options));
  assert.deepStrictEqual(alerts[0].buttons.map((button) => button.text), ['Cancel', 'Delete word and practice card', 'Delete word, keep practice card']);
  alerts[0].buttons[1].onPress();
  alerts[0].buttons[2].onPress();
  assert.deepStrictEqual(chosen, [{ keepPracticeCards: false }, { keepPracticeCards: true }]);
  entryActions.confirmEntryDeletion('sentence', false, () => {});
  assert.deepStrictEqual(alerts[1].buttons.map((button) => button.text), ['Cancel', 'Delete text'], 'No card, no extra choice');
});

test('actual brush stroke and undo handlers preserve corrections and raw OCR', () => {
  const initial = selectRecognizedFindings({ ...fixture, regions: [
    { ...fixture.regions[0], id: 'keep', text: '米', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
    { ...fixture.regions[0], id: 'noise', text: '1000', bounds: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 } },
  ] });
  initial.regions[0].review.correctedText = 'お米';
  initial.correctedText = 'お米\n1000';
  const currentCapture = { current: initial };
  const brushStroke = { current: null };
  const persisted = [];
  const snippet = reviewSource.slice(reviewSource.indexOf('  function applyEdit('), reviewSource.indexOf('  function chooseCandidate('))
    + reviewSource.slice(reviewSource.indexOf('  function paintNoise('), reviewSource.indexOf('  return (\n    <KeyboardAvoidingView'));
  const deps = { currentCapture, brushStroke, imageFit: { left: 0, top: 0, width: 300, height: 300 },
    brushTouchesBounds, excludeRegions, setBrushPoint: () => {},
    onChange: (capture) => { currentCapture.current = capture; persisted.push(capture); }, onClearNotice: () => {},
  };
  const run = new Function(...Object.keys(deps), `let undoHistory = []; const setUndoHistory = update => { undoHistory = typeof update === 'function' ? update(undoHistory) : update; };\n${stripTypeScriptTypes(snippet)}\nreturn {startBrush, paintNoise, finishBrush, undoBrush, applyEdit};`)(...Object.values(deps));
  const event = (x, y) => ({ nativeEvent: { locationX: x, locationY: y } });
  run.startBrush(event(80, 160));
  run.paintNoise(event(250, 160));
  run.finishBrush(event(250, 160));
  assert.equal(currentCapture.current.correctedText, 'お米');
  assert.equal(currentCapture.current.regions[1].text, '1000');
  assert.equal(currentCapture.current.rawText, initial.rawText);
  run.undoBrush();
  assert.deepStrictEqual(currentCapture.current, initial);
  assert.equal(persisted.length, 2, 'Brush edit and undo are both handed to draft persistence');
  run.startBrush(event(80, 160));
  run.finishBrush(event(250, 160));
  const edited = updateRegionCorrection(currentCapture.current, 'keep', '私の修正。');
  run.applyEdit(edited);
  run.undoBrush();
  assert.deepStrictEqual(currentCapture.current, edited, 'Old brush undo must not discard a later text correction');
});

test('actual OCR adapter renders upright before full-image recognition or legacy cropping', async () => {
  const ocrSource = await readFile(new URL('../src/capture/ocr.ts', import.meta.url), 'utf8');
  const snippet = ocrSource.slice(ocrSource.indexOf('export async function analyzeJapaneseImage(')).replace('export ', '');
  let cropPixels = null;
  let resized = null;
  let recognized = null;
  let upright = { width: 3000, height: 4000, release() {}, saveAsync: async () => ({ uri: 'file:///upright.jpg' }) };
  const ImageManipulator = { manipulate: () => ({
    crop(pixels) { cropPixels = pixels; return this; },
    resize(size) { resized = size; return this; },
    renderAsync: async () => {
      const rendered = resized ?? cropPixels ?? upright;
      recognized = { width: rendered.width, height: rendered.height };
      return { ...upright, width: rendered.width, height: rendered.height };
    },
    release() {},
  }) };
  const deps = { ImageManipulator, SaveFormat: { JPEG: 'jpeg' }, File: class { delete() {} }, cropBoundsToPixels, mapCropBoundsToImage, normalizeBounds, ocrResizeFor,
    processImageTextRecognition: async () => ({ text: '米', blocks: [{ lines: [{ text: '米', confidence: null, bounds: { left: 120, top: 250, bottom: 210, width: 180, height: 40 } }] }] }),
  };
  const analyze = new Function(...Object.keys(deps), `${stripTypeScriptTypes(snippet)}\nreturn analyzeJapaneseImage;`)(...Object.values(deps));
  const whole = await analyze('file:///exif6.jpg', 4000, 3000);
  assert.equal(cropPixels, null, 'Whole photo must render without an encoded-dimension crop');
  assert.ok(recognized.width * recognized.height <= 4_000_000 && Math.max(recognized.width, recognized.height) <= 4096,
    'A 12 MP camera photo must be downscaled before Android ML Kit, which rejects images over 4 MP');
  assert.deepStrictEqual(whole.imageDimensions, { width: 3000, height: 4000 }, 'Overlay keeps the full upright dimensions');
  assert.equal(whole.regions[0].bounds.y, 210 / recognized.height);
  resized = null;
  await analyze('file:///exif6.jpg', 4000, 3000, { x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
  assert.deepStrictEqual(cropPixels, { originX: 300, originY: 800, width: 1500, height: 2000 });
  assert.equal(resized, null, 'A crop already within limits is not resized');
  upright = { ...upright, width: 1000, height: 1500 };
  cropPixels = null;
  await analyze('file:///screenshot.png', 1000, 1500);
  assert.equal(resized, null, 'A small imported image is recognized unchanged');
  assert.equal(ocrResizeFor(4096, 900), null);
  assert.deepStrictEqual(ocrResizeFor(8192, 100), { width: 4096, height: 50 });
});

test('direct camera shutter hands upright photo to OCR once and recovers from capture failure', async () => {
  const cameraSource = await readFile(new URL('../src/capture/CameraCapture.tsx', import.meta.url), 'utf8');
  const start = cameraSource.indexOf('  async function takePhoto(');
  const snippet = cameraSource.slice(start, cameraSource.indexOf('  return (', start));
  assert.ok(snippet.includes('capturePhotoToFile'), 'The shutter must capture directly without the system photo approval');
  let captures = 0;
  let busy = false;
  let error = null;
  let failCapture = false;
  let finishImport;
  let enteredImport;
  const importing = new Promise((resolve) => { finishImport = resolve; });
  const entered = new Promise((resolve) => { enteredImport = resolve; });
  const photos = [];
  const takingPhoto = { current: null };
  const eligibility = { current: true };
  const mounted = { current: true };
  const deps = {
    eligibility, mounted, takingPhoto,
    photoOutput: { capturePhotoToFile: async (settings) => {
      assert.equal(settings.enableShutterSound, false, 'The shutter requests no system sound (the OS may still enforce it)');
      captures += 1;
      if (failCapture) throw new Error('Camera capture failed');
      return { filePath: '/tmp/portrait.jpg' };
    } },
    Image: { getSize: (_uri, success) => success(3000, 4000) },
    setPhoto: (value) => {
      busy = value.status === 'capturing' || value.status === 'handing-off';
      if (value.status === 'failed') error = value.message;
    }, setError: (value) => { error = value; },
    onPhoto: async (capture) => { photos.push(await capture()); enteredImport(); await importing; },
  };
  const takePhoto = new Function(...Object.keys(deps), `${stripTypeScriptTypes(snippet)}\nreturn takePhoto;`)(...Object.values(deps));
  const first = takePhoto();
  await entered;
  await takePhoto();
  assert.equal(captures, 1, 'A double tap during capture/import must not take another photo');
  assert.equal(busy, true);
  assert.deepStrictEqual(photos[0], { uri: 'file:///tmp/portrait.jpg', width: 3000, height: 4000, fileName: 'portrait.jpg', mimeType: 'image/jpeg', type: 'image' });
  finishImport();
  await first;
  assert.equal(busy, false);
  assert.equal(takingPhoto.current, null);
  failCapture = true;
  eligibility.current = true; // The committed ready/idle render re-enables the shutter.
  await takePhoto();
  assert.match(error, /could not be captured/);
  assert.equal(busy, false);
  assert.equal(takingPhoto.current, null, 'A capture failure must leave the shutter retryable');
});

test('shipped capture review shows every row with readings and its own actions, tools collapsed', async () => {
  const review = await import('../src/capture/review.ts');
  const geometry = await import('../src/capture/geometry.ts');
  const transpile = (code) => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const render = (type, props) => typeof type === 'function' ? type(props) : { type, ...props };
  const react = { useRef: (initial) => ({ current: initial }), useEffect: () => {}, useCallback: (fn) => fn, useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] };
  const load = (code, modules) => {
    const exports = {};
    new Function('require', 'exports', transpile(code))((name) => {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    }, exports);
    return exports;
  };
  const shared = { react, 'react/jsx-runtime': { jsx: render, jsxs: render }, './analysis': analysisHelpers, '../theme': { colors: {} }, './uiStyles': { styles: {} } };
  const preview = load(await readFile(new URL('../src/capture/CaptureAnalysisPreview.tsx', import.meta.url), 'utf8'),
    { ...shared, 'react-native': {}, './translation': translationHelpers });
  let analyze = async () => { throw new Error('Unexpected readings request'); };
  let savedGroupsForTest = [];
  const component = load(reviewSource, { ...shared, './analysis': { ...analysisHelpers, requestJapaneseAnalysis: (request) => analyze(request) },
    './review': review, './geometry': geometry, './types': { ANALYSIS_CONTRACT_VERSION: 2 },
    './CaptureAnalysisPreview': preview, './store': { loadTextGroups: async () => savedGroupsForTest }, 'expo-router': { useFocusEffect: () => {} }, './studyChanges': { onStudyChange: () => () => {} }, './StatusMessage': { default: ({ text }) => text },
    'react-native': { useWindowDimensions: () => ({ width: 400, height: 800 }), Platform: { OS: 'android' }, StyleSheet: { absoluteFill: {} }, Keyboard: { addListener: () => ({ remove() {} }) } } });
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join(' ')
    : node && typeof node === 'object' ? textOf(node.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  const capture = { ...fixture, status: 'complete', savedAt: null, regions: [
    { ...fixture.regions[0], id: '0:0', text: 'SHINCHRNTHEMOE2を', review: { selected: true } },
    { ...fixture.regions[0], id: '1:0', text: fixture.correctedText, review: { selected: true } },
  ] };
  const noop = () => {};
  const text = textOf(component.default({ capture, busy: false, error: null, notice: null, onChange: noop, onClearNotice: noop, onNewCapture: noop,
    onRetry: noop, onPersistOcrArea: noop, onSave: noop, navHidden: false, onToggleNav: noop }));
  assert.match(text, /2\s+ROWS\s+·\s+0\s+SAVED/);
  assert.match(text, /LINE 2\s+鶏肉をください。[\s\S]*LINE 1\s+SHINCHRNTHEMOE2を/, 'Japanese rows lead; a mostly-Latin line stays, labeled with its photo line');
  assert.doesNotMatch(text, /Captured text image|Hide photo/, 'Recognized text leads; the photo starts collapsed');
  assert.match(text, /Show photo/);
  assert.equal(text.match(/Save row/g)?.length, 2, 'Each row saves independently');
  assert.equal(text.match(/Show in photo/g)?.length, 2);
  assert.match(text, /Checking local readings/, 'Rows show readings loading, not an empty study');
  assert.match(text, /Edit tools/);
  assert.doesNotMatch(text, /Brush away|SAVE LINES TOGETHER|RAW OCR/, 'Edit tools start collapsed');
  assert.match(text, /Show photo[\s\S]*Hide menu[\s\S]*New/);
  const reading = textOf(component.default({ capture: { ...capture, status: 'processing' }, busy: true, error: null, notice: null, onChange: noop, onClearNotice: noop,
    onNewCapture: noop, onRetry: noop, onPersistOcrArea: noop, onSave: noop }));
  assert.match(reading, /Hide photo[\s\S]*Reading text/, 'The photo stays open while text is read');

  // Minimal hook runtime: run the shipped readings effect and re-render with its state.
  async function mounted(props) {
    const states = [];
    const refs = [];
    let effects = [];
    let stateCursor = 0;
    let refCursor = 0;
    react.useState = (initial) => {
      const index = stateCursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    };
    react.useRef = (initial) => { const index = refCursor++; return refs[index] ??= { current: initial }; };
    react.useEffect = (effect) => { effects.push(effect); };
    const tree = () => { stateCursor = 0; refCursor = 0; effects = []; return component.default(props); };
    const render = () => textOf(tree());
    render();
    effects.forEach((effect) => effect());
    await new Promise((resolve) => setTimeout(resolve, 400));
    lastMount = { render, tree };
    return render();
  }
  let lastMount = null;
  // Presses the shipped button whose visible label matches, like a user tap.
  function press(label) {
    const find = (node) => Array.isArray(node) ? node.map(find).find(Boolean)
      : node && typeof node === 'object' ? (node.accessibilityRole === 'button' && (textOf(node.children).trim() === label || node.accessibilityLabel === label) ? node : find(node.children)) : undefined;
    const button = find(lastMount.tree());
    assert.ok(button, `No button labeled ${label}`);
    button.onPress();
    return lastMount.render();
  }
  const props = { capture: { ...capture, regions: [...capture.regions, { ...fixture.regions[0], id: '2:0', text: '果実', review: { selected: true } }] },
    busy: false, error: null, notice: null, onChange: noop, onClearNotice: noop, onNewCapture: noop, onRetry: noop, onPersistOcrArea: noop, onSave: noop };
  analyze = async ({ text: requested }) => {
    if (requested === fixture.correctedText) throw new Error('Analysis service returned 400.');
    return { contractVersion: 2, language: 'ja', normalizedText: requested, tokens: [] };
  };
  const isolated = await mounted(props);
  assert.match(isolated, /鶏肉をください。[\s\S]*HTTP 400/, 'The rejected row shows its own error');
  assert.equal(isolated.match(/No dictionary words were found/g)?.length, 2, 'Rows after a rejected row still get readings');
  analyze = async () => { throw new TypeError('Network request failed'); };
  const offline = await mounted(props);
  savedGroupsForTest = [{ id: `group:${capture.id}:row:2:0`, captureId: capture.id, regionIds: ['2:0'], text: '果物', analysis: null, analysisReview: {}, savedAt: '2026-10-04' }];
  const replaced = await mounted(props);
  assert.match(replaced, /Saved as edited:\s+果物[\s\S]*Replace saved text/, 'An OCR row never silently overwrites its edited saved text');
  savedGroupsForTest = [];
  assert.equal(offline.match(/Can't reach the local readings service/g)?.length, 3, 'An unreachable service is reported on every row');

  // A native OCR block of two lines is one paragraph; its lines expand and can be removed from the draft with Undo.
  analyze = async ({ text: requested }) => ({ contractVersion: 2, language: 'ja', normalizedText: requested, tokens: [] });
  const persisted = [];
  const block = { ...capture, regions: [
    { ...fixture.regions[0], id: '0:0', text: '雨が降ります。', review: { selected: true } },
    { ...fixture.regions[0], id: '0:1', text: '魚を食べます。', review: { selected: true } },
  ] };
  const paragraphProps = { ...props, capture: block, onPersistOcrArea: (record) => persisted.push(record) };
  paragraphProps.onChange = (record) => { paragraphProps.capture = record; };
  savedGroupsForTest = [{ id: `group:${capture.id}:row:0:1`, captureId: capture.id, regionIds: ['0:1'], text: '魚を食べます。', analysis: null, analysisReview: {}, savedAt: '2026-10-04' }];
  const paragraph = await mounted(paragraphProps);
  assert.match(paragraph, /PARAGRAPH\s+·\s+2\s+LINES[\s\S]*Save paragraph[\s\S]*Lines · 2[\s\S]*雨が降ります。[\s\S]*魚を食べます。/, 'The paragraph leads with its actions, then its text with line breaks');
  assert.ok(paragraph.indexOf('Save paragraph') < paragraph.indexOf('No dictionary words were found'), 'Save paragraph comes before the word list');
  assert.doesNotMatch(paragraph, /LINE 1/, 'Lines stay collapsed until expanded');
  const expanded = press('Lines · 2');
  assert.match(expanded, /LINE 1[\s\S]*Save row[\s\S]*Remove from draft[\s\S]*LINE 2/, 'Remove from draft is outside Edit');
  const afterRemoval = press('Remove from draft');
  assert.equal(paragraphProps.capture.regions.find((region) => region.id === '0:0').review.excluded, true);
  assert.equal(persisted.at(-1).regions.find((region) => region.id === '0:0').review.excluded, true, 'Removal is persisted');
  assert.match(afterRemoval, /Removed “\s*雨が降ります。\s*” from this draft\.\s+Undo/);
  const undone = press('Undo');
  assert.equal(paragraphProps.capture.regions.find((region) => region.id === '0:0').review.excluded, false, 'Undo restores the line');
  assert.equal(persisted.at(-1).regions.find((region) => region.id === '0:0').review.excluded, false);
  assert.doesNotMatch(undone, /Removed “/);
  assert.match(undone, /Hide lines/, 'Undo keeps the paragraph open');
  const savedLineRemoved = press('Remove line from this draft: 魚を食べます。');
  assert.match(savedLineRemoved, /Its saved text stays in your Library\./, 'Removing a saved line never deletes its saved entry');
  assert.equal(savedGroupsForTest.length, 1);
  savedGroupsForTest = [];
  react.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}];
  react.useRef = (initial) => ({ current: initial });
  react.useEffect = () => {};
});

test('Photos lists every source with an honest draft, unread or saved label', async () => {
  const { photoSummary } = await import('../src/capture/review.ts');
  const capture = { ...fixture, id: 'p', savedAt: null, status: 'complete', regions: [
    { ...fixture.regions[0], id: '0:0', text: '米', review: { selected: true } },
    { ...fixture.regions[0], id: '1:0', text: '肉', review: { selected: true } },
  ] };
  assert.equal(photoSummary({ ...capture, status: 'processing' }, new Map(), 0), 'PHOTO KEPT · TEXT NOT READ YET');
  assert.equal(photoSummary({ ...capture, status: 'failed' }, new Map(), 0), 'PHOTO KEPT · TEXT NOT READ · OPEN TO RETRY');
  assert.equal(photoSummary(capture, new Map(), 0), 'DRAFT · 2 ROWS NOT SAVED', 'An unsaved camera draft still appears');
  assert.equal(photoSummary(capture, new Map([['group:p:row:0:0', '米']]), 3), '1 SAVED · 1 ROW NOT SAVED · 3 WORDS');
  assert.equal(photoSummary({ ...capture, regions: [], correctedText: '' }, new Map(), 0), 'DRAFT · NO TEXT FOUND');
});

test('a focused Library reloads when a card mutation commits after the user went back', async () => {
  const changes = await import('../src/capture/studyChanges.ts');
  // Commit semantics: no event for a failed mutation, none after unsubscribe.
  let events = 0;
  const unsubscribe = changes.onStudyChange(() => { events += 1; });
  await assert.rejects(changes.afterCommit(Promise.reject(new Error('write failed'))));
  assert.equal(events, 0, 'A failed mutation emits no change');
  assert.equal(await changes.afterCommit(Promise.resolve('done')), 'done');
  assert.equal(events, 1);
  unsubscribe();
  await changes.afterCommit(Promise.resolve());
  assert.equal(events, 1);

  let persisted = [{ id: 'word', captureId: 'qa', kind: 'word', lemma: '果実', reading: 'かじつ', sourceText: '果実', groupId: null, createdAt: '2026-10-04', wordSnapshot: null, personalMeaning: null }];
  const { slots, frame, tree } = await mountScreen('../src/app/(tabs)/index.tsx', {
    'react-native-safe-area-context': {}, 'react-native': { StyleSheet: { create: (value) => value } },
    '../../capture/store': { loadLibraryCaptures: async () => [], loadStudyCards: async () => persisted, loadPracticeCards: async () => [] }, '../../capture/entryActions': {},
    '../../capture/review': { photoSummary: () => '' }, '../../capture/studyCards': { recordedMeaning: () => '' },
    '../../capture/StatusMessage': { default: () => null }, '../../capture/studyChanges': changes, '../../theme': { colors: {} },
  });
  await frame();
  // Four tabs at 350pt and 1.3× text: each sizes to its label and the row wraps, so labels never overlap.
  const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : [];
  const rendered = nodes(tree());
  const tabs = rendered.filter((node) => node.accessibilityRole === 'tab');
  assert.equal(tabs.length, 4);
  for (const tab of tabs) {
    const style = Object.assign({}, ...[tab.style].flat().filter(Boolean));
    assert.ok(style.flex === undefined && style.flexGrow === 1 && style.flexShrink === 0 && style.minHeight >= 44, `Tab sizes to its label: ${JSON.stringify(style)}`);
  }
  assert.equal(rendered.find((node) => node.children === tabs || (Array.isArray(node.children) && tabs.every((tab) => node.children.includes(tab))))?.style.flexWrap, 'wrap', 'The tab row wraps');
  slots[0].value = 'vocabulary'; // the user is looking at Vocabulary
  assert.match(await frame(), /果実/, 'The Library loaded while the deletion was still pending');
  persisted = [];
  await changes.afterCommit(Promise.resolve()); // the card screen's deletion commits now
  await frame();
  assert.doesNotMatch(await frame(), /果実/, 'The committed deletion refreshes the already focused Library');
});

test('practice and entry screens stay current across navigation round trips', async () => {
  const changes = await import('../src/capture/studyChanges.ts');
  const shared = {
    'react-native-safe-area-context': {}, 'react-native': { StyleSheet: { create: (value) => value }, Platform: { OS: 'android' }, Alert: {} },
    '../../capture/StatusMessage': { default: () => null }, '../../capture/studyChanges': changes, '../../theme': { colors: {} },
  };
  // Practice → Open entry → edit the meaning → Back: the still-mounted practice card shows the new answer, hidden first.
  let personal = 'old meaning';
  const practiceScreen = await mountScreen('../src/app/practice/[id].tsx', { ...shared, '../../capture/SourcePhoto': { default: () => null }, '../../capture/types': {}, '../../capture/store': {
    loadPracticeCard: async () => ({ id: 'practice:1', entryId: 'word:1', createdAt: '2026-10-04',
      answer: { kind: 'word', prompt: '鶏肉', reading: 'とりにく', dictionaryMeaning: 'chicken meat', personal, sourceText: '鶏肉' } }),
  } }, { id: 'practice:1' });
  await practiceScreen.frame();
  assert.match(await practiceScreen.press('Reveal answer'), /old meaning/);
  personal = 'new meaning';
  await changes.afterCommit(Promise.resolve()); // the entry screen's Save changes commits
  const back = await practiceScreen.refocus();
  assert.doesNotMatch(back, /old meaning|new meaning/, 'The refreshed answer is hidden until revealed again');
  assert.match(await practiceScreen.press('Reveal answer'), /new meaning/);

  // Entry → Open practice card → Delete practice card → Back: the entry offers Create again, keeping an open draft.
  let practice = { id: 'practice:1', entryId: 'word:1', createdAt: '2026-10-04', answer: null };
  const entry = { id: 'word:1', captureId: fixture.id, kind: 'word', tokenIndex: 0, lemma: '鶏肉', reading: 'とりにく', sourceText: fixture.correctedText,
    createdAt: '2026-10-04', groupId: null, wordSnapshot: { ...fixture.analysis.tokens[0], surface: '鶏肉', reading: 'とりにく' }, personalMeaning: null, sourceRegions: null };
  const entryScreen = await mountScreen('../src/app/card/[id].tsx', { ...shared,
    '../../capture/store': { loadStudyCard: async () => entry, loadCaptureById: async () => fixture, loadTextGroup: async () => null, loadPracticeCardForEntry: async () => practice, WordConflictError: Error },
    '../../capture/entryActions': {}, '../../capture/analysis': analysisHelpers, '../../capture/studyCards': { studyDataForCard: () => ({ analysis: null, choices: {} }) },
    '../../capture/types': {}, '../../capture/CaptureAnalysisPreview': { default: () => null }, '../../capture/SourcePhoto': { default: () => null },
  }, { id: 'word:1', mode: 'dictionary' });
  await entryScreen.frame();
  assert.match(await entryScreen.frame(), /Open practice card/);
  assert.match(await entryScreen.press('Edit word'), /Save changes/, 'An unsaved draft is open');
  practice = null;
  await changes.afterCommit(Promise.resolve()); // the practice screen's Delete practice card commits
  const returned = await entryScreen.refocus();
  assert.match(returned, /Save changes/, 'The draft survives the refresh');
  await entryScreen.press('Cancel');
  assert.match(await entryScreen.frame(), /Create practice card \(optional\)/, 'No stale pointer to the deleted card');
});

test('a legacy saved group links to its real text entry and stays current after edit or delete', async () => {
  const changes = await import('../src/capture/studyChanges.ts');
  const pushed = [];
  const legacyGroup = { id: `legacy:${fixture.id}`, captureId: fixture.id, regionIds: [], text: fixture.correctedText, analysis: fixture.analysis, analysisReview: {}, savedAt: '2026-10-02' };
  let currentGroup = legacyGroup;
  const groupScreen = await mountScreen('../src/app/group/[id].tsx', {
    'react-native-safe-area-context': {}, 'react-native': {},
    '../../capture/store': { loadTextGroup: async () => currentGroup, loadCaptureById: async () => fixture,
      loadTextEntryForGroup: async (groupId) => groupId === legacyGroup.id ? { id: `sentence:${fixture.id}` } : null },
    '../../capture/analysis': analysisHelpers, '../../capture/types': {}, '../../capture/CaptureAnalysisPreview': { default: () => null },
    '../../capture/SourcePhoto': { default: () => null }, '../../capture/StatusMessage': { default: () => null },
    '../../capture/studyChanges': changes, '../../capture/uiStyles': { styles: {} },
  }, { id: legacyGroup.id }, { push: (route) => pushed.push(route), back() {}, navigate() {} });
  await groupScreen.frame();
  await groupScreen.press('Edit, translate, delete or practice ›');
  assert.deepStrictEqual(pushed.at(-1).params.id, `sentence:${fixture.id}`, 'Legacy entries keep their original sentence:<captureId> identity');

  // Entry → Edit text → Save changes → Back: the still-mounted group shows the persisted text.
  const editedText = '鶏肉をお願いします。';
  currentGroup = { ...legacyGroup, text: editedText, analysis: { ...fixture.analysis, normalizedText: editedText } };
  await changes.afterCommit(Promise.resolve());
  await groupScreen.refocus();
  assert.equal(groupScreen.slots[0].value.text, editedText, 'The group reloads the edited text');
  // Entry → Delete text → Back: the group reports the deletion instead of showing the old text.
  currentGroup = null;
  await changes.afterCommit(Promise.resolve());
  assert.match(await groupScreen.refocus(), /This group or its source was deleted\./);
});

test('a practice card withholds its previous answer while reloading and shows its source only after Reveal', async () => {
  const changes = await import('../src/capture/studyChanges.ts');
  let next = null;
  const answer = (personal, sourceRegions) => ({ id: 'practice:2', entryId: null, captureId: fixture.id, createdAt: '2026-10-04',
    answer: { kind: 'word', prompt: '鶏肉', reading: 'とりにく', dictionaryMeaning: 'chicken meat', personal, sourceText: '鶏肉', sourceRegions } });
  let load = async () => answer('old meaning', [{ id: '0:1', bounds: fixture.regions[0].bounds }]);
  const photos = [];
  const screen = await mountScreen('../src/app/practice/[id].tsx', {
    'react-native-safe-area-context': {}, 'react-native': { StyleSheet: { create: (value) => value }, Alert: {} },
    '../../capture/StatusMessage': { __esModule: true, default: ({ text }) => text }, '../../capture/studyChanges': changes, '../../theme': { colors: {} },
    '../../capture/types': {}, '../../capture/SourcePhoto': { __esModule: true, default: ({ regions }) => { photos.push(regions); return `PHOTO WITH ${regions.length} LINES`; } },
    '../../capture/store': { loadPracticeCard: () => load(), loadCaptureById: async (id) => id === fixture.id ? fixture : null },
  }, { id: 'practice:2' });
  const prompt = await screen.frame();
  assert.doesNotMatch(prompt, /Show in photo|PHOTO WITH/, 'The source photo is part of the answer: hidden before Reveal');
  assert.match(await screen.press('Reveal answer'), /old meaning[\s\S]*Show in photo/);
  assert.match(await screen.press('Show in photo'), /PHOTO WITH 1 LINES/, 'The snapshot bounds outline the original photo');
  assert.deepStrictEqual(photos.at(-1), [{ id: '0:1', bounds: fixture.regions[0].bounds }]);

  // Edit elsewhere → Back while the refreshed card is still loading: nothing stale is shown or revealable.
  load = () => new Promise((resolve) => { next = resolve; });
  await changes.afterCommit(Promise.resolve());
  const pending = await screen.refocus();
  assert.doesNotMatch(pending, /old meaning|鶏肉|PHOTO WITH/, 'The previous card is withheld while reloading');
  await assert.rejects(screen.press('Reveal answer'), /No button labeled Reveal answer/, 'A quick Reveal cannot show the stale answer');
  next(answer('new meaning', null));
  await screen.frame();
  const refreshed = await screen.press('Reveal answer');
  assert.match(refreshed, /new meaning/);
  assert.doesNotMatch(refreshed, /old meaning/);
  assert.match(await screen.press('Show in photo'), /PHOTO WITH 0 LINES/, 'A legacy answer without bounds shows the whole photo, no invented boxes');

  // A failed reload is a clear dead state, not an interactive stale card.
  load = async () => { throw new Error('db closed'); };
  const failed = await screen.refocus();
  assert.match(failed, /could not be opened/);
  assert.doesNotMatch(failed, /鶏肉|Reveal answer|Delete practice card/);
});

test('capture saved status follows external deletion on commit and return, ignoring late loads', async () => {
  const changes = await import('../src/capture/studyChanges.ts');
  const review = await import('../src/capture/review.ts');
  const geometry = await import('../src/capture/geometry.ts');
  const capture = { ...fixture, status: 'complete', savedAt: null, regions: [
    { ...fixture.regions[0], id: '0:0', text: '雨が降ります。', review: { selected: true } },
    { ...fixture.regions[0], id: '0:1', text: '魚を食べます。', review: { selected: true } },
  ] };
  const block = review.textGroupsForCapture(capture)[0];
  const savedBlock = { ...block, savedAt: '2026-10-04' };
  let loads = [];
  const loadTextGroups = () => new Promise((resolve) => loads.push(resolve));
  const settleLoads = async (groups) => { const pending = loads; loads = []; pending.forEach((resolve) => resolve(groups)); await new Promise((done) => setTimeout(done, 0)); };
  const noop = () => {};
  const props = { capture, busy: false, error: null, notice: null, onChange: noop, onClearNotice: noop, onNewCapture: noop, onRetry: noop, onPersistOcrArea: noop, onSave: noop };
  const screen = await mountScreen('../src/capture/CaptureReview.tsx', {
    './analysis': { ...analysisHelpers, requestJapaneseAnalysis: async ({ text }) => ({ contractVersion: 2, language: 'ja', normalizedText: text, tokens: [] }) },
    './review': review, './geometry': geometry, './types': { ANALYSIS_CONTRACT_VERSION: 2 }, './uiStyles': { styles: {} }, '../theme': { colors: {} },
    './CaptureAnalysisPreview': { __esModule: true, default: () => null }, './StatusMessage': { __esModule: true, default: ({ text }) => text },
    './store': { loadTextGroups }, './studyChanges': changes,
    'react-native': { useWindowDimensions: () => ({ width: 350, height: 667 }), Platform: { OS: 'android' }, StyleSheet: { absoluteFill: {} }, Keyboard: { addListener: () => ({ remove() {} }) }, Alert: {} },
  }, {}, undefined, props);
  await screen.frame();
  await settleLoads([savedBlock]);
  const savedView = await screen.frame();
  assert.match(savedView, /PARAGRAPH\s+·\s+2\s+LINES\s+·\s+SAVED[\s\S]*Save again/);
  assert.match(savedView, /2\s+ROWS\s+·\s+2\s+SAVED/, 'A saved paragraph counts the rows it covers');

  // The entry screen deletes the paragraph's text; its commit reaches this still-mounted capture.
  await changes.afterCommit(Promise.resolve());
  await screen.frame();
  await settleLoads([]);
  const afterDelete = await screen.frame();
  assert.match(afterDelete, /Save paragraph/, 'A deleted paragraph can be saved again from its photo');
  assert.doesNotMatch(afterDelete, /Save again|· SAVED/);
  assert.match(afterDelete, /2\s+ROWS\s+·\s+0\s+SAVED/, 'The counter refreshes after the paragraph is deleted');

  // Returning to the tab reloads too; an older, slower load can never overwrite the newer result.
  await changes.afterCommit(Promise.resolve());
  await screen.frame();
  const older = loads;
  loads = [];
  await screen.refocus();
  await settleLoads([]);
  older.forEach((resolve) => resolve([savedBlock])); // the stale response arrives last
  await new Promise((done) => setTimeout(done, 0));
  assert.match(await screen.frame(), /Save paragraph/, 'A late stale load is ignored');

  // A correction after saving the paragraph is no longer covered; an individually saved row counts on its own.
  await changes.afterCommit(Promise.resolve());
  await screen.frame();
  props.capture = { ...capture, regions: capture.regions.map((region, index) => index ? region : { ...region, review: { selected: true, correctedText: '雨が降りました。' } }) };
  await settleLoads([savedBlock]);
  assert.match(await screen.frame(), /2\s+ROWS\s+·\s+0\s+SAVED/, 'A changed paragraph is not falsely counted as saved');
  props.capture = capture;
  const line = review.rowGroupsForCapture(capture)[1];
  await changes.afterCommit(Promise.resolve());
  await screen.frame();
  await settleLoads([{ ...line, savedAt: '2026-10-04' }]);
  assert.match(await screen.frame(), /2\s+ROWS\s+·\s+1\s+SAVED/, 'An individually saved row still counts');
});

test('Save word shows its own saving, saved, needs-choice and retry state beside the tapped word', async () => {
  // A long paragraph like the CEO photo: the tapped middle word's feedback must sit at that word, not at the group.
  const candidate = (id, reading, meaning) => ({ id, reading, meanings: [meaning], recommended: false });
  const word = (surface, reading, candidates) => ({ surface, lemma: surface, reading, partOfSpeech: '名詞', dictionaryCandidates: candidates, scriptUnits: [...surface] });
  const tokens = [
    word('追金', 'おいきん', [candidate('a', 'おいきん', 'additional payment')]),
    word('長', 'ちょう', [candidate('b', 'ちょう', 'head; chief')]),
    word('雨', 'あめ', [candidate('rain', 'あめ', 'rain')]),
    word('間', 'ま', [candidate('m1', 'ま', 'space'), candidate('m2', 'あいだ', 'interval'), candidate('m3', 'かん', 'between')]),
    word('電', 'でん', [candidate('c', 'でん', 'electricity')]),
    word('目', 'め', [candidate('d', 'め', 'eye')]),
  ];
  const text = '追金長雨間電目';
  const analysis = { contractVersion: 2, language: 'ja', normalizedText: text, tokens };
  let respond;
  const calls = [];
  const props = { text, analysis, busy: false, error: null, choices: {}, translation: null, translationBusy: false, translationError: null,
    onTranslate() {}, onChooseCandidate() {}, onRetry() {}, onSaveWord: (index) => { calls.push(index); return new Promise((resolve) => { respond = resolve; }); } };
  const preview = await mountScreen('../src/capture/CaptureAnalysisPreview.tsx', {
    'react-native': {}, './analysis': analysisHelpers, './translation': translationHelpers, '../theme': { colors: {} }, './uiStyles': { styles: {} },
  }, {}, undefined, props);
  // Each word's row runs from its own meaning to the next word's meaning.
  const between = (view, from, to) => view.slice(view.indexOf(from), view.indexOf(to, view.indexOf(from)));
  await preview.frame();
  const tap = async (label) => { const pending = preview.press(label); await new Promise((done) => setTimeout(done, 0)); return pending; };

  void tap('Save word 雨');
  const saving = await preview.frame();
  assert.match(between(saving, 'rain', 'space'), /Saving…/, 'Saving shows on the tapped word');
  await assert.rejects(preview.press('Save word 雨'), /No button labeled/, 'No second tap while saving');
  respond({ state: 'saved', message: 'Saved in Vocabulary.' });
  await new Promise((done) => setTimeout(done, 0));
  const saved = await preview.frame();
  assert.match(between(saved, 'rain', 'space'), /Saved in Vocabulary\./, 'Success is visible beside the word');
  assert.doesNotMatch(between(saved, 'electricity', 'eye'), /Saved in Vocabulary/, 'Other words keep their own state');
  assert.deepStrictEqual(calls, [2]);

  const choice = await preview.press('Save word 間');
  assert.match(between(choice, 'between', 'electricity'), /Choose one reading and meaning above/, 'The required choice is explained at the tapped word');
  assert.deepStrictEqual(calls, [2], 'No save is attempted without an explicit choice');

  void tap('Save word 電');
  respond({ state: 'failed', message: 'Could not save. Try again.' });
  await new Promise((done) => setTimeout(done, 0));
  const failed = await preview.frame();
  assert.match(between(failed, 'electricity', 'eye'), /Retry save[\s\S]*Could not save\. Try again\./, 'Failure offers a retry at the word');
  void tap('Retry save 電');
  assert.deepStrictEqual(calls, [2, 4, 4], 'Retry calls the real save again');
  respond({ state: 'saved', message: 'Already in your Vocabulary.' });
  await new Promise((done) => setTimeout(done, 0));
  assert.match(between(await preview.frame(), 'electricity', 'eye'), /Saved ✓[\s\S]*Already in your Vocabulary\./, 'An existing entry is reported as already saved');

  // A save in flight stays visibly locked on its word even if the user picks another sense meanwhile;
  // its result belongs to the old sense, so neither success nor error shows for the new one.
  const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : [];
  const button = (label) => nodes(preview.tree()).find((node) => node.accessibilityRole === 'button' && node.accessibilityLabel === label);
  for (const [outcome, from] of [[{ state: 'saved', message: 'Saved in Vocabulary.' }, 'm2'], [{ state: 'failed', message: 'Could not save. Try again.' }, 'm1']]) {
    props.choices = { 3: from };
    await preview.frame();
    void tap('Save word 間');
    props.choices = { 3: 'm3' };
    await preview.frame();
    assert.equal(button('Saving 間')?.disabled, true, 'The in-flight word stays Saving and disabled after its choice changed');
    assert.equal(button('Save word 間'), undefined, 'No enabled Save word that would ignore a tap');
    assert.equal(button('Saved ✓ 電')?.disabled, true, 'Other words keep their own state (電 stays saved)');
    respond(outcome);
    await new Promise((done) => setTimeout(done, 0));
    const after = await preview.frame();
    assert.equal(button('Save word 間')?.disabled, false, 'After it settles the new sense can be saved');
    assert.doesNotMatch(between(after, 'between', 'electricity'), /Saved|Could not save/, `No stale ${outcome.state} for the new sense`);
  }
  props.choices = {};
  await preview.frame();
});

test('a saved text entry scopes its in-place choices to the entry and its exact text', async () => {
  const candidate = (id, reading, meaning) => ({ id, reading, meanings: [meaning], recommended: false });
  const analysisOf = (text) => ({ contractVersion: 2, language: 'ja', normalizedText: text, tokens: [
    { surface: '米', lemma: '米', reading: 'べい', partOfSpeech: '名詞', scriptUnits: ['米'], dictionaryCandidates: [candidate('rice', 'こめ', 'rice'), candidate('usa', 'べい', 'America')] },
    { surface: 'を', lemma: 'を', reading: 'を', partOfSpeech: '助詞', scriptUnits: [], dictionaryCandidates: [] },
  ] });
  const first = '米を買う';
  const groups = { 'g:a': { id: 'g:a', captureId: fixture.id, regionIds: [], text: first, analysis: analysisOf(first), analysisReview: {}, savedAt: '2026-10-04' } };
  const entry = (id, groupId) => ({ id, captureId: fixture.id, kind: 'sentence', tokenIndex: null, lemma: '', reading: '', sourceText: groups[groupId].text,
    createdAt: '2026-10-04', groupId, wordSnapshot: null, personalMeaning: null, sourceRegions: null });
  const saves = [];
  const routeParams = { id: 'sentence:a', mode: 'dictionary' };
  const screen = await mountScreen('../src/app/card/[id].tsx', {
    'react-native-safe-area-context': {}, 'react-native': { StyleSheet: { create: (value) => value }, Platform: { OS: 'android' }, Alert: {} },
    '../../capture/StatusMessage': { default: () => null }, '../../capture/studyChanges': { afterCommit: (mutation) => mutation, onStudyChange: () => () => {} },
    '../../theme': { colors: {} }, '../../capture/entryActions': {}, '../../capture/SourcePhoto': { default: () => null },
    '../../capture/types': { analysisRequestFor: (capture) => ({ contractVersion: 2, language: 'ja', text: capture.correctedText }) },
    '../../capture/analysis': { ...analysisHelpers, requestJapaneseAnalysis: async ({ text }) => analysisOf(text) },
    '../../capture/studyCards': { studyDataForCard: (_card, capture) => ({ analysis: capture.analysis, choices: Object.fromEntries(Object.entries(capture.analysisReview)
      .flatMap(([index, review]) => review.dictionaryCandidateId ? [[index, review.dictionaryCandidateId]] : [])) }) },
    '../../capture/store': {
      loadStudyCard: async (id) => entry(id, id === 'sentence:a' ? 'g:a' : 'g:b'), loadCaptureById: async () => fixture, loadTextGroup: async (id) => groups[id] ?? null,
      loadPracticeCardForEntry: async () => null, saveGroupAnalysisForText: async (id, _text, analysis) => { groups[id] = { ...groups[id], analysis }; return true; },
      updateSavedText: async (id, newText) => { groups[id] = { ...groups[id], text: newText, analysis: null, analysisReview: {} }; },
      addWordCard: async (...args) => { saves.push(args); return 'added'; }, WordConflictError: class extends Error {}, EntryDeletedError: class extends Error {},
    },
    '../../capture/CaptureAnalysisPreview': { __compile: '../src/capture/CaptureAnalysisPreview.tsx', dependencies: {
      'react-native': {}, './analysis': analysisHelpers, './translation': translationHelpers, '../theme': { colors: {} }, './uiStyles': { styles: {} } } },
  }, routeParams);
  const nodes = (node) => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : [];
  const textOf = (node) => Array.isArray(node) ? node.map(textOf).join(' ') : node && typeof node === 'object' ? textOf(node.children) : typeof node === 'string' ? node : '';
  const choose = async (meaning) => {
    nodes(screen.tree()).find((node) => node.accessibilityRole === 'radio' && textOf(node.children).includes(meaning)).onPress();
    return screen.frame();
  };
  const settle = async () => { for (let step = 0; step < 12; step += 1) await screen.frame(); return screen.frame(); };
  await settle();
  assert.match(await choose('America'), /Selected dictionary sense/);

  // Edit the source text: the same word and candidate ids stay at index 0, but the old choice is not approval.
  await screen.press('Edit text');
  nodes(screen.tree()).find((node) => node.accessibilityLabel === 'Saved text').onChangeText('米を売る');
  await screen.press('Save changes');
  const edited = await settle();
  assert.match(edited, /米を売る/);
  assert.match(edited, /Choose a reading and dictionary sense/, 'The choice made for the old text is dropped');
  assert.match(await screen.press('Save word 米'), /Choose one reading and meaning above/);
  assert.equal(saves.length, 0, 'Nothing is saved with a stale choice');
  await choose('rice');
  await screen.press('Save word 米');
  assert.equal(saves.length, 1);
  assert.deepStrictEqual([saves[0][2], saves[0][3].text, saves[0][3].analysisReview['0'].dictionaryCandidateId], ['こめ', '米を売る', 'rice'], 'The explicit new choice is what is saved');

  // Navigating to another entry with the same text never carries this entry's choice.
  groups['g:b'] = { ...groups['g:a'], id: 'g:b', analysisReview: {} };
  await choose('America');
  routeParams.id = 'sentence:b';
  const other = await settle();
  assert.match(other, /Choose a reading and dictionary sense/, 'Choices are scoped to their entry');
});


test('late OCR recovery and row-save completion never republish a deleted capture', async () => {
  for (const operation of ['recovery', 'row']) {
    let enterSave;
    let resolveSave;
    const entered = new Promise((resolve) => { enterSave = resolve; });
    const pending = new Promise((resolve) => { resolveSave = resolve; });
    const pause = async () => { enterSave(); await pending; };
    const record = { ...fixture, status: 'failed' };
    const screen = handlers(record, () => { throw new Error('Recovery must not rerun OCR'); }, fixture, false, {
      saveCapture: pause, saveTextGroup: pause,
    });
    const running = operation === 'recovery'
      ? screen.recognize(record)
      : screen.saveSelection(record, reviewHelpers.rowGroupsForCapture(record)[0]);
    await entered;
    screen.deletedIds.add(record.id);
    screen.session.clearDeletedCapture();
    resolveSave();
    await running;
    assert.equal(screen.shown, null, `${operation} completion must not reopen its deleted capture`);
  }
});
