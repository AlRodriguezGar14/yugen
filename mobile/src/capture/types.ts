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
  status: CaptureStatus;
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
};

export type KanjiDetail = { character: string; meanings: string[]; onReadings: string[]; kunReadings: string[] };

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
  status: CaptureStatus;
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
    status: capture.status,
  };
}

export function captureFromRow(row: CaptureRow): CaptureRecord {
  return {
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
    status: row.status,
  };
}
