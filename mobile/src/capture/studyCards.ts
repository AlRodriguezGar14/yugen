import { hiraganaReading } from './analysis';
import type { SourceRegion, StudyCard } from './store';
import type { CaptureRecord } from './types';

/** What a practice card reveals: the entry's current effective answer, or its snapshot once detached. */
export type PracticeAnswer = {
  kind: 'word' | 'sentence';
  prompt: string;
  reading: string | null;
  /** Recorded dictionary evidence (labeled when the word was renamed); never the user's own words. */
  dictionaryMeaning: string | null;
  /** The user's own meaning (word) or translation (text). */
  personal: string | null;
  sourceText: string;
  /** The photo lines the entry was first saved from; kept with a detached card. Absent for legacy entries. */
  sourceRegions?: SourceRegion[] | null;
};

export function practiceAnswer(entry: StudyCard): PracticeAnswer {
  const word = entry.kind === 'word';
  return { kind: entry.kind, prompt: word ? entry.lemma : entry.sourceText, reading: word ? entry.reading : null,
    dictionaryMeaning: word && entry.wordSnapshot ? recordedMeaning(entry) : null, personal: entry.personalMeaning, sourceText: entry.sourceText,
    sourceRegions: entry.sourceRegions };
}

/** The recorded dictionary gloss; after the user renames a word it is qualified as evidence for the original form. */
export function recordedMeaning(card: StudyCard): string {
  const gloss = card.wordSnapshot?.dictionaryCandidates[0]?.meanings.join('; ') ?? card.wordSnapshot?.curatedMeaning ?? null;
  if (!gloss || !card.wordSnapshot) return 'Meaning unavailable';
  const { surface, reading } = card.wordSnapshot;
  return surface !== card.lemma || reading !== card.reading ? `Recorded dictionary entry for ${surface} (${reading}) · ${gloss}` : gloss;
}

/** Word recall uses its approved identity even if later source review chooses another sense. */
export function studyDataForCard(card: StudyCard, capture: CaptureRecord) {
  if (card.kind === 'word' && card.wordSnapshot) {
    return { analysis: { contractVersion: 2 as const, language: capture.language, normalizedText: card.sourceText, tokens: [card.wordSnapshot] }, choices: card.dictionaryCandidateId ? { '0': card.dictionaryCandidateId } : {} };
  }
  let analysis = capture.analysis?.normalizedText === capture.correctedText && capture.correctedText === card.sourceText ? capture.analysis : null;
  let choices = Object.fromEntries(Object.entries(capture.analysisReview).filter(([, review]) => review.dictionaryCandidateId).map(([index, review]) => [index, review.dictionaryCandidateId!]));
  if (card.kind === 'word' && analysis) {
    const token = analysis.tokens[card.tokenIndex ?? -1];
    if (token?.lemma.normalize('NFC').trim() === card.lemma) {
      const candidates = token.dictionaryCandidates.filter((candidate) => hiraganaReading(candidate.reading) === card.reading);
      const selected = candidates.find((candidate) => candidate.id === choices[String(card.tokenIndex)]);
      analysis = { ...analysis, tokens: [{ ...token, reading: card.reading, dictionaryCandidates: candidates }] };
      choices = selected ? { '0': selected.id } : {};
    } else analysis = null;
  }
  return { analysis, choices };
}
