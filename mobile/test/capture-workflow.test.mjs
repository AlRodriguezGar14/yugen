import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as analysisHelpers from '../src/capture/analysis.ts';
import { brushTouchesBounds, cropBoundsToPixels, mapCropBoundsToImage, normalizeBounds, ocrResizeFor } from '../src/capture/geometry.ts';
import { excludeRegions, selectRecognizedFindings, updateRegionCorrection } from '../src/capture/review.ts';

const reviewSource = await readFile(new URL('../src/capture/CaptureReview.tsx', import.meta.url), 'utf8');
const fixture = JSON.parse(await readFile(new URL('../fixtures/capture-record.json', import.meta.url), 'utf8'));
// Local analysis of the fixture's corrected text (contract 2), as returned by the readings service.
const fixtureAnalysis = {"contractVersion": 2, "language": "ja", "normalizedText": "鶏肉をください。", "tokens": [{"surface": "鶏肉", "lemma": "鶏肉", "reading": "とりにく", "partOfSpeech": "名詞", "dictionaryCandidates": [{"id": "1253020:とりにく", "reading": "とりにく", "meanings": ["chicken meat"], "recommended": true}], "scriptUnits": ["鶏", "肉"]}, {"surface": "を", "lemma": "を", "reading": "を", "partOfSpeech": "助詞", "dictionaryCandidates": [{"id": "1051240:を", "reading": "を", "meanings": ["indicates direct object of action"], "recommended": true}], "scriptUnits": []}, {"surface": "ください", "lemma": "くださる", "reading": "ください", "partOfSpeech": "動詞", "dictionaryCandidates": [{"id": "1001790:ください", "reading": "ください", "meanings": ["please (give me)"], "recommended": true}], "scriptUnits": []}, {"surface": "。", "lemma": "。", "reading": "。", "partOfSpeech": "補助記号", "dictionaryCandidates": [], "scriptUnits": []}]};

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
  const snippet = reviewSource.slice(reviewSource.indexOf('  function applyEdit('), reviewSource.indexOf('  function restoreRegion('))
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
  const props = { text: fixture.correctedText, analysis: fixtureAnalysis, busy: false, error: null, choices: {}, onChooseCandidate() {}, onRetry() {}, showHeading: true };
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
  const loading = textOf(exports.default({ ...props, analysis: null, busy: true }));
  assert.match(loading, /Checking local readings/);
});
