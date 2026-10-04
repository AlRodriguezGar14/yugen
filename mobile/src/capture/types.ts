import { hydrateCaptureReview } from './review.ts';

export type CaptureSource = 'camera' | 'library';
export type CaptureStatus = 'selecting' | 'processing' | 'complete' | 'failed';

/** Fractions in the source image's top-left-origin coordinate space, relative to its metadata dimensions. */
export type NormalizedBounds = { x: number; y: number; width: number; height: number };

export type CaptureImageMetadata = {
  assetId: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  width: number;
  height: number;
  /** Upright rendered dimensions; source width/height remain the untouched asset metadata. */
  displayWidth?: number;
  displayHeight?: number;
};

export type CaptureRegion = {
  id: string;
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  confidence: number | null;
  review?: {
    selected?: boolean;
    excluded?: boolean;
    correctedText?: string;
    /** Explicit line grouping overrides the original OCR block. */
    groupId?: string;
    joined?: boolean;
  };
};

export type CaptureRecord = {
  id: string;
  createdAt: string;
  language: string;
  source: CaptureSource;
  imageUri: string;
  imageMetadata: CaptureImageMetadata;
  ocrBounds: NormalizedBounds | null;
  rawText: string;
  regions: CaptureRegion[];
  correctedText: string;
  selectedRegionId: string | null;
  joinedWithoutBreaks: boolean;
  status: CaptureStatus;
  savedAt: string | null;
  sentenceTranslation: SentenceTranslation | null;
  analysis: AnalysisResponse | null;
  analysisReview: Record<string, AnalysisTokenReview>;
};

export type SentenceWordMeaning = { tokenIndex: number; surface: string; text: string };
export type SentenceTranslation = {
  sourceText: string;
  targetLanguage: string;
  text: string;
  wordMeanings: SentenceWordMeaning[];
};

export type AnalysisTokenReview = { ignored: boolean; dictionaryCandidateId: string | null };

export type DictionaryCandidate = {
  id: string;
  reading: string;
  meanings: string[];
  recommended: boolean;
};

export type AnalysisToken = {
  surface: string;
  lemma: string;
  reading: string | null;
  partOfSpeech: string;
  dictionaryCandidates: DictionaryCandidate[];
  curatedMeaning?: string | null;
  scriptUnits: string[];
  kanjiDetails?: KanjiDetail[];
  /** Exact written-form entries the parser could not place in this context (e.g. a kanji in a list). */
  writtenFormEvidence?: boolean;
};

export type KanjiDetail = { character: string; meanings: string[]; onReadings: string[]; kunReadings: string[] };
export type TextGroup = { id: string; captureId: string; regionIds: string[]; text: string; analysis: AnalysisResponse | null; analysisReview: Record<string, AnalysisTokenReview>; savedAt: string | null };

export const ANALYSIS_CONTRACT_VERSION = 2 as const;

export type AnalysisRequest = { contractVersion: typeof ANALYSIS_CONTRACT_VERSION; language: string; text: string };

export type AnalysisResponse = {
  contractVersion: typeof ANALYSIS_CONTRACT_VERSION;
  language: string;
  normalizedText: string;
  tokens: AnalysisToken[];
};

export type CaptureRow = {
  id: string;
  created_at: string;
  language: string;
  source: CaptureSource;
  image_uri: string;
  image_metadata: string;
  ocr_bounds: string | null;
  raw_text: string;
  regions: string;
  corrected_text: string;
  selected_region_id: string | null;
  join_without_breaks: number;
  status: CaptureStatus;
  saved_at: string | null;
  translation_json: string | null;
  analysis_json: string | null;
  analysis_review_json: string | null;
};

export function captureToRow(capture: CaptureRecord): CaptureRow {
  return {
    id: capture.id,
    created_at: capture.createdAt,
    language: capture.language,
    source: capture.source,
    image_uri: capture.imageUri,
    image_metadata: JSON.stringify(capture.imageMetadata),
    ocr_bounds: capture.ocrBounds ? JSON.stringify(capture.ocrBounds) : null,
    raw_text: capture.rawText,
    regions: JSON.stringify(capture.regions),
    corrected_text: capture.correctedText,
    selected_region_id: capture.selectedRegionId,
    join_without_breaks: Number(capture.joinedWithoutBreaks),
    status: capture.status,
    saved_at: capture.savedAt,
    translation_json: capture.sentenceTranslation ? JSON.stringify(capture.sentenceTranslation) : null,
    analysis_json: capture.analysis ? JSON.stringify(capture.analysis) : null,
    analysis_review_json: JSON.stringify(capture.analysisReview),
  };
}

export function captureFromRow(row: CaptureRow): CaptureRecord {
  const parsedAnalysis = row.analysis_json ? JSON.parse(row.analysis_json) as AnalysisResponse : null;
  const analysis = parsedAnalysis?.contractVersion === ANALYSIS_CONTRACT_VERSION && parsedAnalysis.normalizedText === row.corrected_text
    ? parsedAnalysis
    : null;
  return hydrateCaptureReview({
    id: row.id,
    createdAt: row.created_at,
    language: row.language,
    source: row.source,
    imageUri: row.image_uri,
    imageMetadata: JSON.parse(row.image_metadata) as CaptureImageMetadata,
    ocrBounds: row.ocr_bounds ? JSON.parse(row.ocr_bounds) as NormalizedBounds : null,
    rawText: row.raw_text,
    regions: JSON.parse(row.regions) as CaptureRegion[],
    correctedText: row.corrected_text,
    selectedRegionId: row.selected_region_id,
    joinedWithoutBreaks: Number(row.join_without_breaks) === 1,
    status: row.status,
    savedAt: row.saved_at ?? null,
    sentenceTranslation: row.translation_json
      ? (() => {
          const translation = JSON.parse(row.translation_json) as SentenceTranslation;
          return translation.sourceText === row.corrected_text && Array.isArray(translation.wordMeanings) ? translation : null;
        })()
      : null,
    analysis,
    analysisReview: analysis && row.analysis_review_json ? JSON.parse(row.analysis_review_json) as Record<string, AnalysisTokenReview> : {},
  });
}

export function analysisRequestFor(capture: CaptureRecord): AnalysisRequest {
  return { contractVersion: ANALYSIS_CONTRACT_VERSION, language: capture.language, text: capture.correctedText };
}
