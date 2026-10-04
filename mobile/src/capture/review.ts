import type { CaptureRecord, CaptureRegion, TextGroup } from './types';

/** Native blocks stay separate; joining kept findings is an explicit user action. */
export function textGroupsForCapture(capture: CaptureRecord): TextGroup[] {
  if (capture.savedAt) return [{ id: `legacy:${capture.id}`, captureId: capture.id,
    regionIds: capture.regions.map((region) => region.id), text: capture.correctedText,
    analysis: capture.analysis, analysisReview: capture.analysisReview, savedAt: capture.savedAt }];
  // Unchecked findings remain reachable in Edit so the user can add them back.
  const kept = capture.regions.filter((region) => !region.review?.excluded && (region.review?.correctedText ?? region.text).trim());
  const blocks = new Map<string, CaptureRegion[]>();
  for (const region of kept) {
    const key = region.review?.groupId ?? (capture.joinedWithoutBreaks ? 'joined' : /^\d+:\d+$/.test(region.id) ? region.id.split(':')[0] : region.id);
    blocks.set(key, [...(blocks.get(key) ?? []), region]);
  }
  if (!blocks.size && capture.correctedText.trim()) return [{ id: `group:${capture.id}:manual`, captureId: capture.id, regionIds: [], text: capture.correctedText, analysis: capture.analysis, analysisReview: capture.analysisReview, savedAt: null }];
  return [...blocks.entries()].map(([key, regions]) => {
    const selected = regions.filter((region) => region.review?.selected);
    const joined = capture.joinedWithoutBreaks || (!!selected.length && selected.every((region) => region.review?.joined));
    const text = selected.map((region) => region.review?.correctedText ?? region.text).join(joined ? '' : '\n');
    const analysis = capture.analysis?.normalizedText === text ? capture.analysis : null;
    const identity = key === 'joined' ? `joined:${JSON.stringify(regions.map((region) => region.id))}` : `block:${key}`;
    return { id: `group:${capture.id}:${identity}`, captureId: capture.id, regionIds: regions.map((region) => region.id), text, analysis, analysisReview: analysis ? capture.analysisReview : {}, savedAt: null };
  });
}

/**
 * One independently savable text per kept OCR line, identified by its source region ID.
 * Without recognized lines, the manually entered text is the only row.
 */
export function rowGroupsForCapture(capture: CaptureRecord): TextGroup[] {
  // A row cleared while editing stays visible (unsavable) instead of vanishing under the keyboard.
  const rows = capture.regions
    .filter((region) => !region.review?.excluded && (region.text.trim() || region.review?.correctedText?.trim()))
    .map((region) => ({ id: `group:${capture.id}:row:${region.id}`, captureId: capture.id, regionIds: [region.id],
      text: region.review?.correctedText ?? region.text, analysis: null, analysisReview: {}, savedAt: null }));
  if (rows.length || !capture.correctedText.trim()) return rows;
  return [{ id: `group:${capture.id}:manual`, captureId: capture.id, regionIds: [], text: capture.correctedText, analysis: null, analysisReview: {}, savedAt: null }];
}

/** Rows not yet saved, either on their own or inside a saved block/legacy group with unchanged text. */
export function unsavedRows(capture: CaptureRecord, savedTexts: Map<string, string>): TextGroup[] {
  const savedBlocks = textGroupsForCapture(capture).filter((group) => group.text.trim() && savedTexts.get(group.id) === group.text);
  return rowGroupsForCapture(capture).filter((row) => row.text.trim() && savedTexts.get(row.id) !== row.text
    && !savedBlocks.some((group) => row.regionIds.length ? row.regionIds.every((id) => group.regionIds.includes(id)) : group.text === row.text));
}

/** Save feedback: where the text went, new vs already saved words, and which words still need the user. */
export function savedTextNotice(words: { added: number; existing: number; pending: number; unknown: number } | null, remaining: number): string {
  const left = remaining ? ` ${remaining} ${remaining === 1 ? 'row' : 'rows'} not saved yet.` : ' All rows saved.';
  if (!words) return `Text saved in Saved texts with 0 words: readings are unavailable. Retry readings, then save again to add its words.${left}`;
  const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? '' : 's'}`;
  const parts = [`Text saved · ${count(words.added, 'new word')} in Vocabulary`];
  if (words.existing) parts.push(`${words.existing} already saved`);
  if (words.pending) parts.push(`${count(words.pending, 'word')} need${words.pending === 1 ? 's' : ''} a meaning choice`);
  if (words.unknown) parts.push(`${words.unknown} without a dictionary entry`);
  return `${parts.join(' · ')}.${left}`;
}

function selectionText(regions: CaptureRegion[], joinedWithoutBreaks = false): string {
  return regions
    .filter((region) => region.review?.selected && !region.review.excluded)
    .map((region) => region.review?.correctedText ?? region.text)
    .join(joinedWithoutBreaks ? '' : '\n');
}

/** Keeps every recognized nonblank finding initially, with original line boundaries. */
export function selectRecognizedFindings(capture: CaptureRecord): CaptureRecord {
  const regions = capture.regions.map((region) => ({ ...region, review: { selected: !!region.text.trim() } }));
  return {
    ...capture, regions, correctedText: selectionText(regions),
    selectedRegionId: regions.find((region) => region.review.selected)?.id ?? null,
    joinedWithoutBreaks: false, analysis: null, analysisReview: {}, sentenceTranslation: null,
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
    correctedText: changesSelection ? selectionText(regions, capture.joinedWithoutBreaks) : capture.correctedText,
    analysis: changesSelection ? null : capture.analysis,
    analysisReview: changesSelection ? {} : capture.analysisReview,
    sentenceTranslation: changesSelection ? null : capture.sentenceTranslation,
  };
}

export function updateManualCorrection(capture: CaptureRecord, correctedText: string): CaptureRecord {
  return {
    ...capture,
    correctedText,
    selectedRegionId: null,
    sentenceTranslation: null,
    analysis: null,
    analysisReview: {},
  };
}

export function markCaptureOcrFailed(capture: CaptureRecord): CaptureRecord {
  return { ...capture, status: 'failed' };
}

export function hydrateCaptureReview(capture: CaptureRecord): CaptureRecord {
  if (capture.regions.some((region) => region.review?.selected)) return capture;
  if (!capture.selectedRegionId) return capture;

  return {
    ...capture,
    regions: capture.regions.map((region) => region.id === capture.selectedRegionId
      ? { ...region, review: { selected: true, correctedText: capture.correctedText || region.text } }
      : region),
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
    joinedWithoutBreaks: selected ? capture.joinedWithoutBreaks : false,
    correctedText: selectionText(regions, selected && capture.joinedWithoutBreaks),
    sentenceTranslation: null,
    analysis: null,
    analysisReview: {},
  };
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
    joinedWithoutBreaks: false,
    correctedText: selectionText(regions),
    sentenceTranslation: null,
    analysis: null,
    analysisReview: {},
  };
}

export function updateRegionCorrection(capture: CaptureRecord, regionId: string, correctedText: string): CaptureRecord {
  const regions = capture.regions.map((region) => region.id === regionId
    ? { ...region, review: { ...region.review, correctedText } }
    : region);

  return {
    ...capture,
    regions,
    correctedText: selectionText(regions, capture.joinedWithoutBreaks),
    sentenceTranslation: null,
    analysis: null,
    analysisReview: {},
  };
}

export function restoreRegion(capture: CaptureRecord, regionId: string): CaptureRecord {
  if (!capture.regions.some((region) => region.id === regionId && region.review?.excluded)) return capture;
  const regions = capture.regions.map((region) => region.id === regionId
    ? { ...region, review: { ...region.review, selected: true, excluded: false } } : region);
  return {
    ...capture,
    regions,
    selectedRegionId: regions.find((region) => region.review?.selected)?.id ?? null,
    correctedText: selectionText(regions, capture.joinedWithoutBreaks),
    sentenceTranslation: null, analysis: null, analysisReview: {},
  };
}

export function photoSummary(capture: CaptureRecord, savedTexts: Map<string, string>, words: number): string {
  if (capture.status === 'processing' || capture.status === 'selecting') return 'PHOTO KEPT · TEXT NOT READ YET';
  if (capture.status === 'failed') return 'PHOTO KEPT · TEXT NOT READ · OPEN TO RETRY';
  const texts = [...savedTexts.keys()].filter((id) => id.startsWith(`group:${capture.id}:`) || id === `legacy:${capture.id}`).length;
  const unsaved = unsavedRows(capture, savedTexts).length;
  const rows = `${unsaved} ${unsaved === 1 ? 'ROW' : 'ROWS'} NOT SAVED`;
  if (!texts) return unsaved ? `DRAFT · ${rows}` : 'DRAFT · NO TEXT FOUND';
  return `${texts} SAVED · ${rows} · ${words} ${words === 1 ? 'WORD' : 'WORDS'}`;
}
