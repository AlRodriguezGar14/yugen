import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as analysisHelpers from '../src/capture/analysis.ts';
import { brushTouchesBounds, cropBoundsToPixels, mapCropBoundsToImage, normalizeBounds, ocrResizeFor } from '../src/capture/geometry.ts';
import { excludeRegions, selectRecognizedFindings, updateRegionCorrection } from '../src/capture/review.ts';

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
  const takingPhoto = { current: false };
  const deps = {
    ready: true, takingPhoto,
    photoOutput: { capturePhotoToFile: async (settings) => {
      assert.equal(settings.enableShutterSound, false, 'The shutter requests no system sound (the OS may still enforce it)');
      captures += 1;
      if (failCapture) throw new Error('Camera capture failed');
      return { filePath: '/tmp/portrait.jpg' };
    } },
    Image: { getSize: (_uri, success) => success(3000, 4000) },
    setBusy: (value) => { busy = value; }, setError: (value) => { error = value; },
    onPhoto: async (asset) => { photos.push(asset); enteredImport(); await importing; },
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
  assert.equal(takingPhoto.current, false);
  failCapture = true;
  await takePhoto();
  assert.match(error, /could not be captured/);
  assert.equal(busy, false);
  assert.equal(takingPhoto.current, false, 'A capture failure must leave the shutter retryable');
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
  const changes = [];
  const snippet = reviewSource.slice(reviewSource.indexOf('  function applyEdit('), reviewSource.indexOf('  function chooseCandidate('))
    + reviewSource.slice(reviewSource.indexOf('  function paintNoise('), reviewSource.indexOf('  return (\n    <View style={styles.reviewContent}>'));
  const deps = { currentCapture, brushStroke, imageFit: { left: 0, top: 0, width: 300, height: 300 },
    brushTouchesBounds, excludeRegions, setBrushPoint: () => {},
    onChange: (capture) => { currentCapture.current = capture; changes.push(capture); },
  };
  const run = new Function(...Object.keys(deps), `let undoHistory = []; const setUndoHistory = update => { undoHistory = typeof update === 'function' ? update(undoHistory) : update; };\n${stripTypeScriptTypes(snippet)}\nreturn {startBrush, paintNoise, finishBrush, undoBrush, applyEdit};`)(...Object.values(deps));
  const event = (x, y) => ({ nativeEvent: { locationX: x, locationY: y } });
  run.startBrush(event(80, 160));
  run.paintNoise(event(250, 160));
  run.finishBrush(event(250, 160));
  assert.equal(currentCapture.current.correctedText, 'お米');
  assert.equal(currentCapture.current.regions[1].review.excluded, true);
  assert.equal(currentCapture.current.regions[1].text, '1000');
  assert.equal(currentCapture.current.rawText, initial.rawText);
  assert.equal(changes.length, 1, 'Only a stroke that removes a finding is published');
  run.undoBrush();
  assert.deepStrictEqual(currentCapture.current, initial);
  run.startBrush(event(80, 160));
  run.finishBrush(event(250, 160));
  const edited = updateRegionCorrection(currentCapture.current, 'keep', '私の修正。');
  run.applyEdit(edited);
  run.undoBrush();
  assert.deepStrictEqual(currentCapture.current, edited, 'Old brush undo must not discard a later text correction');
});

test('shipped study preview shows local furigana, word meanings and collapsed characters, including local failure', async () => {
  const previewSource = await readFile(new URL('../src/capture/CaptureAnalysisPreview.tsx', import.meta.url), 'utf8');
  const jsx = (_type, props) => props;
  const modules = {
    react: { useRef: (initial) => ({ current: initial }), useEffect: () => {}, useCallback: (fn) => fn, useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {}, './analysis': analysisHelpers,
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
  const props = { text: fixture.correctedText, analysis: fixture.analysis, busy: false, error: null, choices: {}, onChooseCandidate() {}, onRetry() {}, showHeading: true };
  const local = textOf(exports.default(props));
  assert.match(local, /WORDS & MEANINGS/);
  assert.match(local, /^とりにく\s+鶏肉\s+を[\s\S]*WORDS & MEANINGS/, 'Furigana sits on the text itself, ahead of the word list');
  assert.doesNotMatch(local.split('WORDS & MEANINGS')[0], /くださる/, 'Kana words get no reading; lemma readings never replace the source');
  assert.match(local, /chicken/);
  const failed = textOf(exports.default({ ...props, analysis: null, error: 'Local service unavailable' }));
  assert.match(failed, /Local service unavailable.*Retry readings/);
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
  assert.match(local, /chicken[\s\S]*Characters ·\s+鶏 肉\s+\+/, 'Character knowledge is an optional expansion below the word meaning');
  assert.doesNotMatch(local, /On ·|Kun ·/, 'Character readings stay collapsed until requested');
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
  const evidence = { ...list.tokens[0], surface: '雨', lemma: '雨', reading: 'あめ', writtenFormEvidence: true, dictionaryCandidates: [{ id: '1171900:あめ', reading: 'あめ', meanings: ['rain'], recommended: false }] };
  const labeled = textOf(exports.default({ ...props, text: '雨', analysis: { ...list, normalizedText: '雨', tokens: [evidence] } }));
  assert.match(labeled, /DICTIONARY ENTRY FOR THIS WRITTEN FORM · NOT PLACED IN CONTEXT[\s\S]*rain/, 'A fallback entry is labeled as written-form evidence');
  const loading = textOf(exports.default({ ...props, analysis: null, busy: true }));
  assert.match(loading, /Checking local readings/);
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
  const start = source.indexOf('  async function saveSelection(');
  const snippet = source.slice(start, source.indexOf('  async function saveVocabularyWord(', start));
  const { savedTextNotice, unsavedRows } = await import('../src/capture/review.ts');
  let notice = null;
  let error = null;
  let words = { added: 2, existing: 1, pending: 1, unknown: 0 };
  let fail = false;
  const savedGroups = [];
  const capture = { ...fixture, regions: [{ ...fixture.regions[0], id: '0:0', text: '米', review: { selected: true } }, { ...fixture.regions[0], id: '1:0', text: '肉', review: { selected: true } }] };
  const row = { id: `group:${capture.id}:row:0:0`, captureId: capture.id, regionIds: ['0:0'], text: '米', analysis: null, analysisReview: {}, savedAt: null };
  const deps = { capture, setBusy() {}, setError: (value) => { error = value; }, setNotice: (value) => { notice = value; }, setCapture() {}, finishDraftSave: async () => {},
    loadCaptureById: async () => capture, isCaptureDeleted: () => false,
    saveTextGroup: async (_record, group) => { if (fail) throw new Error('Word write failed'); savedGroups.push(group); return words; },
    loadTextGroups: async () => savedGroups, unsavedRows, savedTextNotice, afterCommit: (mutation) => mutation };
  const saveSelection = new Function(...Object.keys(deps), `${stripTypeScriptTypes(snippet)}\nreturn saveSelection;`)(...Object.values(deps));
  await saveSelection(capture, row);
  assert.equal(notice, 'Text saved · 2 new words in Vocabulary · 1 already saved · 1 word needs a meaning choice. 1 row not saved yet.');
  words = null;
  await saveSelection(capture, row);
  assert.match(notice, /Text saved in Saved texts with 0 words: readings are unavailable\. Retry readings/);
  notice = null;
  fail = true;
  await saveSelection(capture, { ...row, id: `group:${capture.id}:row:1:0`, regionIds: ['1:0'], text: '肉' });
  assert.equal(notice, null, 'A rolled-back save never reports success');
  assert.match(error, /could not be saved/);

  // Unchecked legacy lines leave the capture-wide selection empty; a nonblank row still saves on its own text.
  fail = false;
  error = null;
  savedGroups.length = 0;
  const unselected = { ...capture, correctedText: '', regions: capture.regions.map((region) => ({ ...region, review: { selected: false } })) };
  deps.capture = unselected;
  deps.loadCaptureById = async () => unselected;
  const fromEmptySelection = new Function(...Object.keys(deps), `${stripTypeScriptTypes(snippet)}\nreturn saveSelection;`)(...Object.values(deps));
  await fromEmptySelection(unselected, row);
  assert.equal(error, null);
  assert.deepStrictEqual(savedGroups.map((group) => group.id), [row.id], 'The row is saved even with an empty parent selection');
  await fromEmptySelection(unselected, { ...row, text: ' \n ' });
  assert.match(error, /enter some text/, 'An empty row is still rejected');
  assert.equal(savedGroups.length, 1);
});

test('actual word save handler refuses changed or switched text and saves with the current capture', async () => {
  const start = source.indexOf('  async function saveVocabularyWord(');
  const snippet = source.slice(start, source.indexOf('  function startNewCapture(', start));
  const { rowGroupsForCapture, textGroupsForCapture, updateRegionCorrection } = await import('../src/capture/review.ts');
  const stale = { ...fixture, regions: [
    { ...fixture.regions[0], id: '0:0', text: '米', review: { selected: true } },
    { ...fixture.regions[0], id: '1:0', text: '肉', review: { selected: true } },
  ] };
  const row = rowGroupsForCapture(stale)[0];
  const saves = [];
  let error = null;
  const currentCapture = { current: stale };
  const deps = { currentCapture, rowGroupsForCapture, textGroupsForCapture, setBusy() {}, setNotice() {}, setError: (value) => { error = value; },
    addWordCard: async (capture, index, reading, group) => { saves.push({ capture, index, reading, group }); return 'added'; } };
  const saveVocabularyWord = new Function(...Object.keys(deps), `${stripTypeScriptTypes(snippet)}
return saveVocabularyWord;`)(...Object.values(deps));

  // Another row was corrected after the tap rendered: the word still saves, with the newer correction kept.
  currentCapture.current = updateRegionCorrection(stale, '1:0', '鶏肉');
  await saveVocabularyWord(stale, row, 0, 'こめ');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].capture, currentCapture.current, 'The current capture is written, never the stale snapshot');
  assert.equal(error, null);

  currentCapture.current = updateRegionCorrection(stale, '0:0', '米国');
  await saveVocabularyWord(stale, row, 0, 'こめ');
  assert.equal(saves.length, 1, 'A word from text that changed meanwhile is not saved');
  assert.match(error, /changed while saving/);

  currentCapture.current = { ...stale, id: 'another-capture' };
  await saveVocabularyWord(stale, row, 0, 'こめ');
  currentCapture.current = null;
  await saveVocabularyWord(stale, row, 0, 'こめ');
  assert.equal(saves.length, 1, 'Nothing is saved after switching captures');
});


test('Library browses persisted independent entries and their linked photo sources', async () => {
  const entries = [{ id: 'word', captureId: 'qa', kind: 'word', lemma: '果実', reading: 'かじつ', sourceText: '果実', groupId: null, createdAt: '2026-10-04', wordSnapshot: { dictionaryCandidates: [{ meanings: ['fruit'] }] } }];
  const pushes = [];
  const mounted = await mountScreen('../src/app/(tabs)/index.tsx', {
    'react-native-safe-area-context': {}, 'react-native': { StyleSheet: { create: (value) => value } },
    '../../capture/store': { loadLibraryCaptures: async () => [], loadStudyCards: async () => entries },
    '../../capture/review': { photoSummary: () => '' }, '../../theme': { colors: {} },
  }, {}, { push: (route) => pushes.push(route) });
  await mounted.frame();
  mounted.slots[0].value = 'vocabulary';
  assert.match(await mounted.frame(), /果実.*fruit/);
  await mounted.press('Study word card 果実');
  assert.deepEqual(pushes[0], { pathname: '/card/[id]', params: { id: 'word', mode: 'dictionary' } });
  mounted.slots[1].value = 'missing';
  assert.doesNotMatch(await mounted.frame(), /fruit/);
});
