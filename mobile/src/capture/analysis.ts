import type { AnalysisRequest, AnalysisResponse, AnalysisToken, DictionaryCandidate } from './types';

export function analysisBaseUrl(): string | null {
  const value = process.env.EXPO_PUBLIC_ANALYSIS_BASE_URL?.trim().replace(/\/+$/, '');
  return value && isLocalAnalysisUrl(value) ? value : null;
}

export function isLocalAnalysisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')) return true;
    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  } catch {
    return false;
  }
}

const NETWORK_FAILURE = /network request failed|failed to fetch|network error|timed out|abort/i;

/** True when the service itself is missing or unreachable, so every text would fail alike (not one rejected text). */
export function isConnectivityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message === 'Local Japanese analysis is not configured.' || NETWORK_FAILURE.test(message);
}

export function analysisFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const safeSuffix = 'Your OCR text is still safe.';

  if (message === 'Local Japanese analysis is not configured.') {
    return `Local readings are not configured. Restart with pnpm --dir mobile start:dev-client. ${safeSuffix}`;
  }
  if (NETWORK_FAILURE.test(message)) {
    return `Can't reach the local readings service at ${analysisBaseUrl() ?? 'the configured address'}. Keep it running on your Mac with the phone on the same Wi-Fi, then retry. ${safeSuffix}`;
  }
  const status = message.match(/Analysis service returned (\d{3})\./i)?.[1];
  if (status) {
    return `The local readings service returned HTTP ${status}. Check its terminal output, then retry. ${safeSuffix}`;
  }
  if (/incompatible result|invalid response/i.test(message)) {
    return `The local service and app versions do not match. Restart the readings service and dev client, then retry. ${safeSuffix}`;
  }
  return `Local readings and dictionary entries are unavailable${message ? ` (${message})` : ''}. Check the local readings service, then retry. ${safeSuffix}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDictionaryCandidate(value: unknown): value is DictionaryCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.reading === 'string'
    && isStringArray(candidate.meanings)
    && typeof candidate.recommended === 'boolean';
}

function isAnalysisToken(value: unknown): value is AnalysisToken {
  if (!value || typeof value !== 'object') return false;
  const token = value as Record<string, unknown>;
  return typeof token.surface === 'string'
    && typeof token.lemma === 'string'
    && (typeof token.reading === 'string' || token.reading === null)
    && typeof token.partOfSpeech === 'string'
    && Array.isArray(token.dictionaryCandidates)
    && token.dictionaryCandidates.every(isDictionaryCandidate)
    && (token.curatedMeaning === undefined || token.curatedMeaning === null || typeof token.curatedMeaning === 'string')
    && isStringArray(token.scriptUnits)
    && (token.writtenFormEvidence === undefined || typeof token.writtenFormEvidence === 'boolean')
    && (token.kanjiDetails === undefined || (Array.isArray(token.kanjiDetails) && token.kanjiDetails.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const detail = entry as Record<string, unknown>;
      return typeof detail.character === 'string' && [...detail.character].length === 1
        && isStringArray(detail.meanings) && isStringArray(detail.onReadings) && isStringArray(detail.kunReadings);
    })));
}

export function parseAnalysisResponse(value: unknown, request: AnalysisRequest): AnalysisResponse {
  if (!value || typeof value !== 'object') throw new Error('Analysis returned an invalid response.');
  const result = value as Record<string, unknown>;
  if (result.contractVersion !== request.contractVersion || result.language !== request.language || result.normalizedText !== request.text
    || !Array.isArray(result.tokens) || !result.tokens.every(isAnalysisToken)) {
    throw new Error('Analysis returned an incompatible result. Your text was not changed.');
  }
  return result as AnalysisResponse;
}

export async function requestJapaneseAnalysis(
  request: AnalysisRequest,
  baseUrl = analysisBaseUrl(),
): Promise<AnalysisResponse> {
  if (!baseUrl || !isLocalAnalysisUrl(baseUrl)) throw new Error('Local Japanese analysis is not configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Analysis service returned ${response.status}.`);
    return parseAnalysisResponse(await response.json(), request);
  } finally {
    clearTimeout(timeout);
  }
}

export function hiraganaReading(reading: string): string {
  return [...reading].map((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0x30a1 && code <= 0x30f6
      ? String.fromCodePoint(code - 0x60)
      : character;
  }).join('');
}

export function safeDictionaryMeaning(candidates: DictionaryCandidate[], selectedId: string | null): string | null {
  const selected = candidates.find((candidate) => candidate.id === selectedId);
  if (selected) return selected.meanings[0] ?? null;
  const recommended = candidates.filter((candidate) => candidate.recommended);
  if (recommended.length === 1) return recommended[0].meanings[0] ?? null;
  return candidates.length === 1 ? candidates[0].meanings[0] ?? null : null;
}

export function tokenMeaningForDisplay(
  token: Pick<AnalysisToken, 'dictionaryCandidates' | 'curatedMeaning'>,
  selectedId: string | null,
): { text: string; source: 'JMdict' | 'Yugen term guide' } | null {
  const dictionaryMeaning = safeDictionaryMeaning(token.dictionaryCandidates, selectedId);
  if (dictionaryMeaning) return { text: dictionaryMeaning, source: 'JMdict' };
  return token.curatedMeaning ? { text: token.curatedMeaning, source: 'Yugen term guide' } : null;
}

/** The reading a Save word request uses: the explicit choice, else the only candidate, else the parser reading. */
export function readingToSave(token: AnalysisToken, choiceId: string | null | undefined): string | null {
  const candidate = token.dictionaryCandidates.find((item) => item.id === choiceId)
    ?? (token.dictionaryCandidates.length === 1 ? token.dictionaryCandidates[0] : null);
  return candidate?.reading ?? token.reading;
}

export function readingForDisplay(token: AnalysisToken, selectedId: string | null): string | null {
  const selected = token.dictionaryCandidates.find((candidate) => candidate.id === selectedId);
  if (selected) return selected.reading;
  return token.reading;
}

/** A dictionary reading belongs to the canonical form, never an inflected source surface. */
export function wordDisplayForToken(token: AnalysisToken, selectedId: string | null) {
  const chosen = token.dictionaryCandidates.find((candidate) => candidate.id === selectedId);
  return { surface: chosen ? token.lemma : token.surface, reading: chosen?.reading ?? token.reading,
    sourceSurface: chosen && token.lemma !== token.surface ? token.surface : null, sourceReading: token.reading };
}

export function isContentToken(token: Pick<AnalysisToken, 'surface' | 'partOfSpeech'>): boolean {
  return token.surface.trim().length > 0
    && !/^[\p{P}\p{S}\s]+$/u.test(token.surface)
    && !['助詞', '助動詞', '補助記号'].includes(token.partOfSpeech);
}

export function alignAnalysisTokensToText(
  text: string,
  tokens: Pick<AnalysisToken, 'surface' | 'reading'>[],
): { text: string; reading: string | null }[] | null {
  const segments: { text: string; reading: string | null }[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (!token.surface) return null;
    const start = text.indexOf(token.surface, cursor);
    if (start < 0) return null;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), reading: null });
    segments.push({ text: token.surface, reading: token.reading });
    cursor = start + token.surface.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), reading: null });
  return segments;
}
