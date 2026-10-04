import { analysisBaseUrl, isLocalAnalysisUrl } from './analysis.ts';
import type { SentenceTranslation } from './types.ts';

export const TRANSLATION_CONTRACT_VERSION = 2 as const;
export const AI_TRANSLATION_ENABLED = false;

export type SentenceTranslationRequest = {
  contractVersion: typeof TRANSLATION_CONTRACT_VERSION;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  words: { tokenIndex: number; surface: string }[];
};

export type SentenceTranslationResponse = {
  contractVersion: typeof TRANSLATION_CONTRACT_VERSION;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translation: SentenceTranslation['text'];
  wordMeanings: SentenceTranslation['wordMeanings'];
};

export function contextualMeaningForToken(
  translation: SentenceTranslation | null,
  sourceText: string,
  tokenIndex: number,
  surface: string,
): string | null {
  if (!translation || translation.sourceText !== sourceText) return null;
  return translation.wordMeanings.find((meaning) => meaning.tokenIndex === tokenIndex && meaning.surface === surface)?.text ?? null;
}

export function parseSentenceTranslation(
  value: unknown,
  request: SentenceTranslationRequest,
): SentenceTranslationResponse {
  if (!value || typeof value !== 'object') throw new Error('Translation returned an invalid response.');
  const result = value as Record<string, unknown>;
  if (result.contractVersion !== request.contractVersion
    || result.sourceLanguage !== request.sourceLanguage
    || result.targetLanguage !== request.targetLanguage
    || result.sourceText !== request.text
    || typeof result.translation !== 'string'
    || !result.translation.trim()
    || !Array.isArray(result.wordMeanings)
    || result.wordMeanings.length !== request.words.length) {
    throw new Error('Translation returned an incompatible result. Your text was not changed.');
  }
  for (const [index, word] of request.words.entries()) {
    const meaning = result.wordMeanings[index];
    if (!meaning || meaning.tokenIndex !== word.tokenIndex || meaning.surface !== word.surface
      || typeof meaning.text !== 'string' || !meaning.text.trim()) {
      throw new Error('Translation returned an incompatible result. Your text was not changed.');
    }
  }
  return result as SentenceTranslationResponse;
}

export function sentenceTranslationFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Local translation is not configured.') {
    return 'Translation needs the local analysis service. Your selected text is unchanged.';
  }
  if (/network request failed|failed to fetch|network error|timed out|abort/i.test(message)) {
    return 'Could not reach the local translation service. Restart it on your Mac and retry. Your selected text is unchanged.';
  }
  if (/Translation service returned 503/i.test(message)) {
    return 'Sentence translation is not configured. Add OPENAI_API_KEY on the Mac, restart the service, and retry. Your selected text is unchanged.';
  }
  return 'Sentence translation is temporarily unavailable. Your selected text is unchanged; retry when the service is ready.';
}

export async function requestSentenceTranslation(
  request: SentenceTranslationRequest,
  baseUrl = analysisBaseUrl(),
): Promise<SentenceTranslationResponse> {
  if (!AI_TRANSLATION_ENABLED) throw new Error('AI translation is disabled while local study is being completed.');
  if (!baseUrl || !isLocalAnalysisUrl(baseUrl)) throw new Error('Local translation is not configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${baseUrl}/v1/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Translation service returned ${response.status}.`);
    return parseSentenceTranslation(await response.json(), request);
  } finally {
    clearTimeout(timeout);
  }
}
