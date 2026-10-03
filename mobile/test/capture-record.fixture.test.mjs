import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { captureFromRow, captureToRow } from '../src/capture/types.ts';
import { normalizeBounds } from '../src/capture/geometry.ts';
import { markCaptureOcrFailed, selectSingleRegion, updateManualCorrection, updateRegionCorrection } from '../src/capture/review.ts';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/capture-record.json', import.meta.url), 'utf8'),
);

test('capture row round-trip preserves raw text, correction, confidence, and image metadata', () => {
  const restored = captureFromRow(captureToRow(fixture));

  assert.deepStrictEqual(restored, fixture);
  assert.notEqual(restored.rawText, restored.correctedText);
  assert.equal(restored.imageMetadata.fileName, 'menu-sample.jpg');
  assert.equal(restored.regions[0].confidence, 0.91);
});

test('OCR failure marks the capture recoverable without dropping source or prior text', () => {
  const failed = markCaptureOcrFailed({ ...fixture, status: 'processing' });

  assert.equal(failed.status, 'failed');
  assert.equal(failed.imageUri, fixture.imageUri);
  assert.deepStrictEqual(failed.imageMetadata, fixture.imageMetadata);
  assert.equal(failed.rawText, fixture.rawText);
  assert.equal(failed.correctedText, fixture.correctedText);
  assert.deepStrictEqual(failed.regions, fixture.regions);
});

test('OCR boxes normalize their top-left edge rather than their center', () => {
  assert.deepStrictEqual(
    normalizeBounds({ x: 100, y: 130, left: 80, top: 120, width: 40, height: 20 }, 400, 200),
    { x: 0.2, y: 0.6, width: 0.1, height: 0.1 },
  );
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
