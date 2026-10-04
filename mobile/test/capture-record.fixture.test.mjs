import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { alignAnalysisTokensToText, analysisFailureMessage, hiraganaReading, isContentToken, isLocalAnalysisUrl, parseAnalysisResponse, wordDisplayForToken, readingForDisplay, safeDictionaryMeaning, tokenMeaningForDisplay } from '../src/capture/analysis.ts';
import { captureFromRow, captureToRow } from '../src/capture/types.ts';
import { brushTouchesBounds, cropBoundsFromDrag, cropBoundsToPixels, mapCropBoundsToImage, normalizeBounds } from '../src/capture/geometry.ts';
import { excludeRegions, hydrateCaptureReview, markCaptureOcrFailed, restoreRegion, selectRecognizedFindings, selectSingleRegion, toggleRegionSelection, updateManualCorrection, updateRegionCorrection } from '../src/capture/review.ts';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/capture-record.json', import.meta.url), 'utf8'),
);

test('capture row round-trip preserves raw text, correction, confidence, and image metadata', () => {
  const restored = captureFromRow(captureToRow(fixture));

  assert.deepStrictEqual(restored, fixture);
  assert.notEqual(restored.rawText, restored.correctedText);
  assert.equal(restored.imageMetadata.fileName, 'menu-sample.jpg');
  assert.deepStrictEqual(restored.ocrBounds, fixture.ocrBounds);
  assert.equal(restored.regions[0].confidence, 0.91);
  assert.equal(restored.savedAt, fixture.savedAt);
  assert.deepStrictEqual(restored.analysis, fixture.analysis);
});

test('sentence translation stays separate from source text and is invalidated after a correction', () => {
  const translated = {
    ...fixture,
    sentenceTranslation: {
      sourceText: fixture.correctedText,
      targetLanguage: 'en',
      text: 'Please give me chicken.',
      wordMeanings: [{ tokenIndex: 0, surface: '鶏肉', text: 'chicken meat' }],
    },
  };
  const restored = captureFromRow(captureToRow(translated));

  assert.deepStrictEqual(restored.sentenceTranslation, translated.sentenceTranslation);
  assert.equal(restored.correctedText, fixture.correctedText);
  const corrected = updateManualCorrection(restored, '鶏肉をお願いします。');
  assert.equal(corrected.sentenceTranslation, null);
  const staleRow = captureToRow(translated);
  staleRow.corrected_text = '鶏肉をお願いします。';
  assert.equal(captureFromRow(staleRow).sentenceTranslation, null);
});

test('OCR failure marks the capture recoverable without dropping source or prior text', () => {
  const failed = markCaptureOcrFailed({ ...fixture, status: 'processing' });

  assert.equal(failed.status, 'failed');
  assert.equal(failed.imageUri, fixture.imageUri);
  assert.deepStrictEqual(failed.imageMetadata, fixture.imageMetadata);
  assert.deepStrictEqual(failed.ocrBounds, fixture.ocrBounds);
  assert.equal(failed.rawText, fixture.rawText);
  assert.equal(failed.correctedText, fixture.correctedText);
  assert.deepStrictEqual(failed.regions, fixture.regions);
});

test('analysis readings are presented in hiragana without changing the selected text', () => {
  assert.equal(hiraganaReading('ケイニク・ください'), 'けいにく・ください');
  assert.deepStrictEqual(
    parseAnalysisResponse(fixture.analysis, { contractVersion: 2, language: 'ja', text: fixture.correctedText }),
    fixture.analysis,
  );
  assert.throws(
    () => parseAnalysisResponse({ ...fixture.analysis, normalizedText: '鶏肉ください。' }, { contractVersion: 2, language: 'ja', text: fixture.correctedText }),
    /Your text was not changed/,
  );
});

test('furigana layout preserves corrected text and line breaks verbatim', () => {
  const text = '鶏肉を\nください。';
  const tokens = [
    { surface: '鶏肉', reading: 'けいにく' },
    { surface: 'を', reading: 'を' },
    { surface: 'ください', reading: 'ください' },
    { surface: '。', reading: '。' },
  ];
  const segments = alignAnalysisTokensToText(text, tokens);

  assert.deepStrictEqual(segments?.map(({ text: segment }) => segment), ['鶏肉', 'を', '\n', 'ください', '。']);
  assert.equal(segments?.map(({ text: segment }) => segment).join(''), text);
});

test('word meanings omit grammatical particles and punctuation from the findings list', () => {
  assert.equal(isContentToken(fixture.analysis.tokens[0]), true);
  assert.equal(isContentToken(fixture.analysis.tokens[1]), false);
  assert.equal(isContentToken(fixture.analysis.tokens[3]), false);
});

test('JMdict recommendation links a common reading and meaning while retaining alternatives', () => {
  const candidates = [
    { id: '1508750:こめ', reading: 'こめ', meanings: ['(husked grains of) rice'], recommended: true },
    { id: '2150610:べい', reading: 'べい', meanings: ['(United States of) America'], recommended: false },
  ];
  assert.equal(safeDictionaryMeaning(candidates, null), '(husked grains of) rice');
  assert.equal(safeDictionaryMeaning(candidates, '1508750:こめ'), '(husked grains of) rice');
  assert.equal(safeDictionaryMeaning([{ id: 'one:かな', reading: 'かな', meanings: ['one meaning'], recommended: false }], null), 'one meaning');
  assert.equal(safeDictionaryMeaning([], null), null);
  const unresolved = candidates.map((candidate) => ({ ...candidate, recommended: false }));
  assert.equal(safeDictionaryMeaning(unresolved, null), null);
});

test('sentence furigana can use the parser reading without confirming an ambiguous dictionary meaning', () => {
  const candidates = [
    { id: '1508750:こめ', reading: 'こめ', meanings: ['rice'], recommended: false },
    { id: '2150610:べい', reading: 'べい', meanings: ['America'], recommended: false },
  ];
  const token = { surface: '米', reading: 'こめ', partOfSpeech: '名詞', dictionaryCandidates: candidates, scriptUnits: ['米'] };

  assert.equal(readingForDisplay(token, null), 'こめ');
  assert.equal(tokenMeaningForDisplay(token, null), null);
  assert.equal(readingForDisplay(token, '2150610:べい'), 'べい');
  assert.equal(tokenMeaningForDisplay(token, '2150610:べい')?.text, 'America');
});

test('automatic furigana keeps the analyzer reading instead of choosing a likely dictionary sense', () => {
  const token = {
    surface: '米',
    reading: 'こめ',
    partOfSpeech: '名詞',
    dictionaryCandidates: [
      { id: 'rice:こめ', reading: 'こめ', meanings: ['rice'], recommended: true },
      { id: 'america:べい', reading: 'べい', meanings: ['America'], recommended: false },
    ],
    scriptUnits: ['米'],
  };

  assert.equal(readingForDisplay(token, null), 'こめ');
  assert.equal(readingForDisplay(token, 'rice:こめ'), 'こめ');
});

test('analysis keeps curated term meanings separate from dictionary senses', () => {
  const response = {
    ...fixture.analysis,
    tokens: [{ ...fixture.analysis.tokens[0], dictionaryCandidates: [], curatedMeaning: 'Kinmemai rice' }],
  };
  const request = { contractVersion: 2, language: 'ja', text: fixture.correctedText };

  assert.equal(parseAnalysisResponse(response, request).tokens[0].curatedMeaning, 'Kinmemai rice');
  assert.throws(
    () => parseAnalysisResponse({ ...response, tokens: [{ ...response.tokens[0], curatedMeaning: 42 }] }, request),
    /incompatible result/,
  );
  assert.deepStrictEqual(
    tokenMeaningForDisplay(response.tokens[0], null),
    { text: 'Kinmemai rice', source: 'Yugen term guide' },
  );
  assert.deepStrictEqual(
    tokenMeaningForDisplay({ dictionaryCandidates: [
      { id: 'rice:こめ', reading: 'こめ', meanings: ['rice'], recommended: true },
      { id: 'america:べい', reading: 'べい', meanings: ['America'], recommended: false },
    ], curatedMeaning: null }, null),
    { text: 'rice', source: 'JMdict' },
  );
});

test('missing automatic reading remains unresolved until a dictionary candidate is selected', () => {
  const token = {
    ...fixture.analysis.tokens[0], reading: null,
    dictionaryCandidates: [{ id: 'rice:こめ', reading: 'こめ', meanings: ['rice'], recommended: false }],
  };
  assert.equal(readingForDisplay(token, null), null);
  assert.equal(readingForDisplay(token, 'rice:こめ'), 'こめ');
});

test('legacy selected findings are hydrated when loaded and remain editable', () => {
  const row = captureToRow(fixture);
  row.regions = JSON.stringify(fixture.regions.map(({ review, ...region }) => region));
  const restored = captureFromRow(row);
  const edited = updateRegionCorrection(restored, restored.selectedRegionId, '修正した文。');
  assert.equal(edited.correctedText, '修正した文。');
  assert.equal(edited.rawText, fixture.rawText);
});

test('analysis requests are restricted to a local service host', () => {
  assert.equal(isLocalAnalysisUrl('http://192.168.1.12:8080'), true);
  assert.equal(isLocalAnalysisUrl('http://yugen.local:8080'), true);
  assert.equal(isLocalAnalysisUrl('https://analysis.example.com'), false);
});

test('analysis failures explain how to restore readings without risking OCR text', () => {
  assert.match(analysisFailureMessage(new TypeError('Network request failed.')), /same Wi-Fi/i);
  assert.match(analysisFailureMessage(new Error('Local Japanese analysis is not configured.')), /EXPO_PUBLIC_ANALYSIS_BASE_URL/);
  assert.match(analysisFailureMessage(new Error('Analysis service returned 503.')), /HTTP 503/i);
  assert.match(analysisFailureMessage(new Error('Analysis returned an incompatible result.')), /dev client/i);
  assert.match(analysisFailureMessage(new Error('other error')), /\(other error\).*Your OCR text is still safe/i, 'The real cause stays visible');
});

test('older capture rows remain readable with empty analysis and original line breaks', () => {
  const legacyRow = captureToRow(fixture);
  delete legacyRow.saved_at;
  delete legacyRow.analysis_json;
  delete legacyRow.analysis_review_json;
  delete legacyRow.join_without_breaks;
  delete legacyRow.ocr_bounds;

  const restored = captureFromRow(legacyRow);
  assert.equal(restored.savedAt, null);
  assert.equal(restored.analysis, null);
  assert.deepStrictEqual(restored.analysisReview, {});
  assert.equal(restored.joinedWithoutBreaks, false);
  assert.equal(restored.ocrBounds, null);
  assert.equal(restored.rawText, fixture.rawText);
});

test('old analysis contracts are discarded and reanalyzed without dropping the capture', () => {
  const row = captureToRow(fixture);
  row.analysis_json = JSON.stringify({ ...fixture.analysis, contractVersion: 1 });
  row.analysis_review_json = JSON.stringify({ '0': { ignored: true, dictionaryEntry: 'old cached gloss' } });

  const restored = captureFromRow(row);
  assert.equal(restored.analysis, null);
  assert.deepStrictEqual(restored.analysisReview, {});
  assert.equal(restored.rawText, fixture.rawText);
  assert.equal(restored.correctedText, fixture.correctedText);
});

test('OCR boxes normalize their top-left edge rather than their center', () => {
  assert.deepStrictEqual(
    normalizeBounds({ x: 100, y: 130, left: 80, top: 120, width: 40, height: 20 }, 400, 200),
    { x: 0.2, y: 0.6, width: 0.1, height: 0.1 },
  );
});

test('iOS reversed top and bottom edges align to the visible text without shifting Android bounds', () => {
  assert.deepStrictEqual(normalizeBounds({ left: 120, top: 250, bottom: 210, width: 180, height: 40 }, 3000, 4000),
    { x: 0.04, y: 0.0525, width: 0.06, height: 0.01 });
  assert.deepStrictEqual(normalizeBounds({ left: 120, top: 210, bottom: 250, width: 180, height: 40 }, 3000, 4000),
    { x: 0.04, y: 0.0525, width: 0.06, height: 0.01 });
});

test('whole-image findings are kept automatically and brush cleanup preserves source and undo state', () => {
  const recognized = selectRecognizedFindings({ ...fixture, regions: [
    { ...fixture.regions[0], id: 'first', text: '米' },
    { ...fixture.regions[0], id: 'noise', text: '1000' },
    { ...fixture.regions[0], id: 'blank', text: '   ' },
  ] });
  assert.equal(recognized.correctedText, '米\n1000');
  const corrected = updateRegionCorrection(recognized, 'first', 'お米');
  const snapshot = structuredClone(corrected);
  const brushed = excludeRegions(corrected, new Set(['noise']));
  assert.equal(brushed.correctedText, 'お米');
  assert.equal(brushed.rawText, fixture.rawText);
  assert.equal(brushed.regions[1].text, '1000');
  assert.equal(brushed.regions[1].review.excluded, true);
  assert.deepStrictEqual(corrected, snapshot, 'Undo snapshot must remain untouched');
  assert.deepStrictEqual(captureFromRow(captureToRow(brushed)), brushed);
});

test('brush catches fast swipes through upright image findings and ignores letterboxing', () => {
  const image = { left: 37.5, top: 0, width: 225, height: 300 }; // upright 3000x4000 in a square preview
  const bounds = { x: 0.4, y: 0.45, width: 0.2, height: 0.05 };
  assert.equal(brushTouchesBounds({ x: 38, y: 145 }, { x: 262, y: 145 }, bounds, image), true);
  assert.equal(brushTouchesBounds({ x: 10, y: 100 }, { x: 10, y: 200 }, bounds, image), false);
  assert.equal(brushTouchesBounds({ x: 100, y: 20 }, { x: 160, y: 20 }, bounds, image), false);
  assert.equal(brushTouchesBounds({ x: 150, y: 145 }, { x: 150, y: 145 }, bounds, image), true);
});

test('drawn OCR area is constrained to the image and maps findings back to the source', () => {
  const image = { left: 10, top: 20, width: 200, height: 150 };
  const crop = cropBoundsFromDrag({ x: 30, y: 40 }, { x: 170, y: 120 }, image);

  assert.deepStrictEqual(crop, { x: 0.1, y: 20 / 150, width: 0.7, height: 80 / 150 });
  assert.equal(cropBoundsFromDrag({ x: 0, y: 0 }, { x: 100, y: 100 }, image), null);
  assert.deepStrictEqual(cropBoundsToPixels({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, 1200, 800), {
    originX: 120,
    originY: 160,
    width: 600,
    height: 400,
  });
  assert.deepStrictEqual(
    mapCropBoundsToImage({ x: 0.25, y: 0.2, width: 0.5, height: 0.4 }, { x: 0.1, y: 0.2, width: 0.5, height: 0.5 }),
    { x: 0.225, y: 0.30000000000000004, width: 0.25, height: 0.2 },
  );
});

test('older captures hydrate the selected finding without replacing its correction', () => {
  const legacy = structuredClone(fixture);
  delete legacy.regions[0].review;

  const hydrated = hydrateCaptureReview(legacy);

  assert.equal(hydrated.regions[0].review.selected, true);
  assert.equal(hydrated.regions[0].review.correctedText, fixture.correctedText);
  assert.equal(hydrated.rawText, fixture.rawText);
});

test('inflected source and dictionary word keep their own written form and reading', () => {
  const token = { ...fixture.analysis.tokens[0], surface: '使い', lemma: '使う', reading: 'つかい', dictionaryCandidates: [{ id: 'use', reading: 'つかう', meanings: ['to use'], recommended: false }] };
  assert.equal(wordDisplayForToken(token, null).surface, '使い');
  assert.equal(wordDisplayForToken(token, null).reading, 'つかい');
  const chosen = wordDisplayForToken(token, 'use');
  assert.equal(chosen.surface, '使う');
  assert.equal(chosen.reading, 'つかう');
  assert.equal(chosen.sourceSurface, '使い');
  assert.equal(chosen.sourceReading, 'つかい');
});

test('optional kanji details accept old caches but reject malformed dictionary fields', () => {
  const request = { contractVersion: 2, language: 'ja', text: fixture.correctedText };
  const response = { ...fixture.analysis, normalizedText: request.text };
  assert.ok(parseAnalysisResponse(response, request));
  const details = [{ character: '鶏', meanings: ['chicken'], onReadings: ['ケイ'], kunReadings: ['にわとり'] }];
  assert.deepStrictEqual(parseAnalysisResponse({ ...response, tokens: [{ ...response.tokens[0], kanjiDetails: details }] }, request).tokens[0].kanjiDetails, details);
  assert.throws(() => parseAnalysisResponse({ ...response, tokens: [{ ...response.tokens[0], kanjiDetails: [{ ...details[0], meanings: 42 }] }] }, request), /incompatible/);
});

test('choosing and correcting a finding preserves the raw OCR result', () => {
  const twoLines = {
    ...fixture,
    selectedRegionId: null,
    correctedText: '',
    regions: [
      { ...fixture.regions[0], review: { selected: false } },
      { ...fixture.regions[0], id: '0:2', text: 'お願いします。', review: { selected: false } },
    ],
  };
  const chosen = selectSingleRegion(twoLines, '0:2');
  const corrected = updateRegionCorrection(chosen, '0:2', 'お願いしました。');
  const switched = selectSingleRegion(corrected, '0:1');

  assert.equal(chosen.correctedText, 'お願いします。');
  assert.equal(corrected.correctedText, 'お願いしました。');
  assert.equal(corrected.regions[1].text, 'お願いします。', 'OCR text stays untouched');
  assert.equal(corrected.rawText, fixture.rawText);
  assert.equal(switched.correctedText, '鶏肉をください。');
  assert.equal(switched.regions[1].review.correctedText, 'お願いしました。', 'Another line keeps its correction');
  assert.deepStrictEqual(captureFromRow(captureToRow(corrected)), corrected);
  const manual = updateManualCorrection(corrected, '手入力の文。');
  assert.equal(manual.selectedRegionId, null);
  assert.equal(manual.rawText, fixture.rawText);
});

test('brush cleanup removes findings while preserving source, corrections and undo state', () => {
  const chosen = selectSingleRegion({ ...fixture, regions: [
    { ...fixture.regions[0], id: 'first', text: '米', review: { selected: false } },
    { ...fixture.regions[0], id: 'noise', text: '1000', review: { selected: false } },
  ] }, 'first');
  const corrected = updateRegionCorrection(chosen, 'first', 'お米');
  const snapshot = structuredClone(corrected);
  const brushed = excludeRegions(corrected, new Set(['noise']));
  assert.equal(brushed.correctedText, 'お米');
  assert.equal(brushed.rawText, fixture.rawText);
  assert.equal(brushed.regions[1].text, '1000');
  assert.equal(brushed.regions[1].review.excluded, true);
  assert.deepStrictEqual(corrected, snapshot, 'Undo snapshot must remain untouched');
  assert.deepStrictEqual(captureFromRow(captureToRow(brushed)), brushed);
  assert.equal(excludeRegions(brushed, new Set(['noise'])), brushed, 'An already removed finding is not removed again');
  const removedChoice = excludeRegions(brushed, new Set(['first']));
  assert.equal(removedChoice.correctedText, '', 'Removing the chosen line clears the selection');
  assert.equal(removedChoice.selectedRegionId, null);
  assert.equal(selectSingleRegion(removedChoice, 'first'), removedChoice, 'A removed finding cannot be chosen');
  const restored = restoreRegion(removedChoice, 'first');
  assert.equal(restored.regions[0].review.excluded, false);
  assert.equal(restored.regions[0].review.correctedText, 'お米', 'Restore keeps the correction');
  assert.equal(restored.regions[0].text, '米');
  assert.equal(restored.correctedText, 'お米', 'A restored finding is kept again');
});

test('unchecking and rechecking kept findings preserves corrections and the raw OCR result', () => {
  const recognized = selectRecognizedFindings({ ...fixture, regions: [
    { ...fixture.regions[0], text: '鶏肉をください。' },
    { ...fixture.regions[0], id: '0:2', text: 'お願いします。' },
  ] });
  assert.equal(recognized.correctedText, '鶏肉をください。\nお願いします。', 'Lines keep their original breaks');
  const corrected = updateRegionCorrection(recognized, '0:1', '鶏肉をお願いします。');
  const unchecked = toggleRegionSelection(corrected, '0:1');
  assert.equal(unchecked.correctedText, 'お願いします。');
  assert.equal(unchecked.regions[0].review.correctedText, '鶏肉をお願いします。', 'An unchecked line keeps its correction');
  assert.equal(toggleRegionSelection(unchecked, '0:1').correctedText, '鶏肉をお願いします。\nお願いします。');
  assert.equal(unchecked.rawText, fixture.rawText);
  assert.equal(unchecked.regions[0].text, fixture.regions[0].text);
  const removed = excludeRegions(unchecked, new Set(['0:1']));
  assert.equal(toggleRegionSelection(removed, '0:1'), removed, 'A removed finding is restored, not toggled');
});
