import type { CaptureRecord, CaptureRegion } from './types';

function selectionText(regions: CaptureRegion[]): string {
  return regions
    .filter((region) => region.review?.selected && !region.review.excluded)
    .map((region) => region.review?.correctedText ?? region.text)
    .join('\n');
}

/** Keeps every recognized nonblank finding initially, with original line boundaries. */
export function selectRecognizedFindings(capture: CaptureRecord): CaptureRecord {
  const regions = capture.regions.map((region) => ({ ...region, review: { selected: !!region.text.trim() } }));
  return {
    ...capture, regions, correctedText: selectionText(regions),
    selectedRegionId: regions.find((region) => region.review.selected)?.id ?? null,
  };
}

/** Removes findings touched by one brush segment while retaining their OCR text and corrections. */
export function excludeRegions(capture: CaptureRecord, ids: Set<string>): CaptureRecord {
  if (!capture.regions.some((region) => ids.has(region.id) && !region.review?.excluded)) return capture;
  const regions = capture.regions.map((region) => ids.has(region.id)
    ? { ...region, review: { ...region.review, selected: false, excluded: true } } : region);
  const changesSelection = capture.regions.some((region) => ids.has(region.id) && region.review?.selected);
  return {
    ...capture, regions,
    selectedRegionId: regions.find((region) => region.review?.selected && !region.review.excluded)?.id ?? null,
    correctedText: changesSelection ? selectionText(regions) : capture.correctedText,
  };
}

export function updateManualCorrection(capture: CaptureRecord, correctedText: string): CaptureRecord {
  return {
    ...capture,
    correctedText,
    selectedRegionId: null,
  };
}

export function markCaptureOcrFailed(capture: CaptureRecord): CaptureRecord {
  return { ...capture, status: 'failed' };
}

export function selectSingleRegion(capture: CaptureRecord, regionId: string): CaptureRecord {
  const target = capture.regions.find((region) => region.id === regionId);
  if (!target || target.review?.excluded) return capture;

  const regions = capture.regions.map((region) => ({
    ...region,
    review: {
      ...region.review,
      selected: region.id === regionId,
    },
  }));

  return {
    ...capture,
    regions,
    selectedRegionId: regionId,
    correctedText: selectionText(regions),
  };
}

export function updateRegionCorrection(capture: CaptureRecord, regionId: string, correctedText: string): CaptureRecord {
  const regions = capture.regions.map((region) => region.id === regionId
    ? { ...region, review: { ...region.review, correctedText } }
    : region);

  return {
    ...capture,
    regions,
    correctedText: selectionText(regions),
  };
}

export function toggleRegionSelection(capture: CaptureRecord, regionId: string): CaptureRecord {
  const target = capture.regions.find((region) => region.id === regionId);
  if (!target || target.review?.excluded) return capture;

  const selected = !target.review?.selected;
  const regions = capture.regions.map((region) => region.id === regionId
    ? { ...region, review: { ...region.review, selected } }
    : region);
  const selectedRegionId = regions.find((region) => region.review?.selected)?.id ?? null;

  return {
    ...capture,
    regions,
    selectedRegionId,
    correctedText: selectionText(regions),
  };
}

/** Brings a removed finding back into the kept text with its OCR text and correction. */
export function restoreRegion(capture: CaptureRecord, regionId: string): CaptureRecord {
  if (!capture.regions.some((region) => region.id === regionId && region.review?.excluded)) return capture;
  const regions = capture.regions.map((region) => region.id === regionId
    ? { ...region, review: { ...region.review, selected: true, excluded: false } } : region);
  return {
    ...capture,
    regions,
    selectedRegionId: regions.find((region) => region.review?.selected)?.id ?? null,
    correctedText: selectionText(regions),
  };
}
