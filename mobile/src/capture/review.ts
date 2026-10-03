import type { CaptureRecord, CaptureRegion } from './types';

function selectionText(regions: CaptureRegion[]): string {
  return regions
    .filter((region) => region.review?.selected)
    .map((region) => region.review?.correctedText ?? region.text)
    .join('\n');
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
  if (!target) return capture;

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
