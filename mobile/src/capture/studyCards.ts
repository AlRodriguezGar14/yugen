import { hiraganaReading } from './analysis';
import type { StudyCard } from './store';
import type { CaptureRecord } from './types';

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
