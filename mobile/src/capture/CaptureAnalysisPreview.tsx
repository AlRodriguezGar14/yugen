import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { alignAnalysisTokensToText, hiraganaReading, isContentToken, wordDisplayForToken, tokenMeaningForDisplay, requestJapaneseAnalysis } from './analysis';
import type { AnalysisResponse, KanjiDetail } from './types';
import { colors } from '../theme';
import { styles } from './uiStyles';

export default function AnalysisReadingsAndMeanings({
  text,
  analysis,
  busy,
  error,
  choices,
  onChooseCandidate,
  onRetry,
  onSaveWord,
  onEnrichCharacters,
  showHeading = false,
}: {
  text: string;
  analysis: AnalysisResponse | null;
  busy: boolean;
  error: string | null;
  choices: Record<number, string>;
  onChooseCandidate: (index: number, id: string) => void;
  onRetry: () => void;
  showHeading?: boolean;
  /** Saves one approved word; ambiguous words need a chosen sense first. */
  onSaveWord?: (index: number) => void;
  onEnrichCharacters?: (index: number, details: KanjiDetail[]) => void;
}) {
  const currentText = useRef<string | null>(text);
  useEffect(() => { currentText.current = text; return () => { currentText.current = null; }; }, [text]);
  const errorPanel = error ? <View style={styles.previewError}>
    <Text accessibilityLiveRegion="polite" style={styles.previewErrorText}>{error}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Retry local readings and dictionary lookup" onPress={onRetry} style={styles.previewRetryButton}><Text style={styles.previewRetryText}>Retry readings</Text></Pressable>
  </View> : null;
  const [expandedCharacters, setExpandedCharacters] = useState<Set<number>>(() => new Set());
  const [characterDetails, setCharacterDetails] = useState<Record<string, KanjiDetail[]>>({});
  const [characterError, setCharacterError] = useState<string | null>(null);
  if (!analysis) {
    return (
      <>
        <Text selectable style={styles.previewFuriganaGap}>{text}</Text>
        <Text style={styles.previewMeaningHeading}>LOCAL READINGS &amp; WORD MEANINGS</Text>
        {error ? (
          <View style={styles.previewError}>
            <Text style={styles.previewErrorText}>{error}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry local readings and dictionary lookup"
              onPress={onRetry}
              style={({ pressed }) => [styles.previewRetryButton, pressed && styles.previewRetryPressed]}
            >
              <Text style={styles.previewRetryText}>Retry readings</Text>
            </Pressable>
          </View>
        ) : busy ? (
          <View style={styles.previewStatus}>
            <ActivityIndicator color={colors.green} size="small" />
            <Text accessibilityLiveRegion="polite" style={styles.previewStatusText}>Checking local readings and dictionary entries…</Text>
          </View>
        ) : <Text style={styles.previewStatusText}>Local readings are not available yet.</Text>}
      </>
    );
  }
  const tokens = analysis.tokens;
  const words = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => isContentToken(token));
  // A text that is exactly its one displayed word would repeat the same ruby; keep context or differing forms.
  const onlyWord = words.length === 1 && wordDisplayForToken(words[0].token, choices[words[0].index] ?? null).surface === text.trim();

  return (
    <>
      {!onlyWord && furiganaText(text, analysis, choices)}
      {errorPanel}
      {busy && <ActivityIndicator color={colors.ink} />}
      <View style={styles.previewMeanings}>
        {showHeading && <Text style={styles.previewMeaningHeading}>WORDS &amp; MEANINGS</Text>}
        {words.map(({ token, index }) => {
          const selectedId = choices[index] ?? null;
          const word = wordDisplayForToken(token, selectedId);
          const meaning = tokenMeaningForDisplay(token, selectedId);
          return (
            <View key={`${index}:${token.surface}`} style={styles.previewMeaningRow}>
              <View style={styles.previewWordLine}>
                <View style={styles.wordRuby}>
                  {(hasKanji(word.surface) || word.reading !== word.surface) && <Text style={styles.previewReading}>{word.reading ? hiraganaReading(word.reading) : 'Reading unknown'}</Text>}
                  <Text style={styles.wordSurface}>{word.surface}</Text>
                </View>
              </View>
              {word.sourceSurface && <Text style={styles.furiganaNote}>In source · {word.sourceSurface} · {word.sourceReading ? hiraganaReading(word.sourceReading) : 'Reading unknown'}</Text>}
              {token.writtenFormEvidence && <Text style={styles.dictionaryLabel}>DICTIONARY ENTRY FOR THIS WRITTEN FORM · NOT PLACED IN CONTEXT</Text>}
              {token.dictionaryCandidates.length > 1 ? (
                <>
                  <Text style={styles.dictionaryLabel}>DICTIONARY CANDIDATES</Text>
                  <Text style={styles.previewUnknown}>{selectedId ? 'Selected dictionary sense' : 'Choose a reading and dictionary sense'}</Text>
                  {token.dictionaryCandidates.map((candidate) => {
                    const selected = selectedId === candidate.id;
                    const recommended = !choices[index] && candidate.recommended;
                    return (
                      <Pressable
                        key={candidate.id}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        onPress={() => onChooseCandidate(index, candidate.id)}
                        style={styles.previewCandidate}
                      >
                        <Text style={styles.previewCandidateMark}>{selected ? '●' : '○'}</Text>
                        <Text style={[selected || recommended ? styles.previewMeaning : styles.previewExtraSense, styles.previewCandidateText]}>
                          {hiraganaReading(candidate.reading)} · {candidate.meanings[0] ?? 'No gloss'}
                          {candidate.meanings.length > 1 ? ` · +${candidate.meanings.length - 1} senses` : ''}
                        </Text>
                        {recommended && <Text style={styles.previewCandidateHint}>LIKELY</Text>}
                      </Pressable>
                    );
                  })}
                </>
              ) : meaning?.source === 'Yugen term guide' ? (
                <>
                  <Text style={styles.dictionaryLabel}>YUGEN TERM GUIDE</Text>
                  <Text style={styles.previewMeaning}>{token.dictionaryCandidates.length === 1 ? token.dictionaryCandidates[0].meanings.join('; ') : meaning.text}</Text>
                </>
              ) : meaning ? (
                <>
                  <Text style={styles.dictionaryLabel}>DICTIONARY</Text>
                  <Text style={styles.previewMeaning}>{token.dictionaryCandidates.length === 1 ? token.dictionaryCandidates[0].meanings.join('; ') : meaning.text}</Text>
                </>
              ) : token.kanjiDetails?.length ? (
                <>
                  {/* Character evidence, labeled: it describes each kanji, never a meaning of this word. */}
                  <Text style={styles.dictionaryLabel}>NO DICTIONARY WORD · CHARACTER MEANINGS (KANJIDIC)</Text>
                  {token.kanjiDetails.map((detail) => (
                    <Text key={detail.character} style={styles.previewMeaning}>
                      {detail.character} · {detail.meanings.slice(0, 3).join(', ') || 'no meaning listed'}
                      {[...detail.onReadings, ...detail.kunReadings].length ? ` · ${[...detail.onReadings, ...detail.kunReadings].join(' / ')}` : ''}
                    </Text>
                  ))}
                </>
              ) : (
                <Text style={styles.previewUnknown}>Unknown · no dictionary entry</Text>
              )}
              {/* Only a word with an approvable dictionary entry or curated meaning can be saved; character evidence cannot. */}
              {onSaveWord && savable(token) && (
                <Pressable accessibilityRole="button" accessibilityLabel={`Save word ${token.surface}`} disabled={busy}
                  onPress={() => onSaveWord(index)} style={[styles.wordSave, busy && styles.disabled]}>
                  <Text style={styles.wordSaveText}>Save word</Text>
                </Pressable>
              )}
              {!!token.scriptUnits.length && (
                <>
                  <Pressable accessibilityRole="button" accessibilityState={{ expanded: expandedCharacters.has(index) }} onPress={() => {
                    if (!expandedCharacters.has(index) && !token.kanjiDetails && !characterDetails[`${text}:${index}`]) {
                      setCharacterError(null);
                      void requestJapaneseAnalysis({ contractVersion: 2, language: analysis.language, text: token.lemma }).then((response) => {
                        if (currentText.current !== text) return;
                        const details = response.tokens.flatMap((entry) => entry.kanjiDetails ?? []).filter((detail) => token.scriptUnits.includes(detail.character));
                        setCharacterDetails((current) => ({ ...current, [`${text}:${index}`]: details }));
                        onEnrichCharacters?.(index, details);
                      }).catch(() => { if (currentText.current === text) setCharacterError('Character definitions could not be loaded. Close and reopen Characters to retry.'); });
                    }
                    setExpandedCharacters((current) => {
                    const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next;
                  }); }} style={styles.characterToggle}><Text style={styles.characterToggleText}>Characters · {token.scriptUnits.join(' ')} {expandedCharacters.has(index) ? '−' : '+'}</Text></Pressable>
                  {expandedCharacters.has(index) && token.scriptUnits.map((character) => {
                    const detail = (token.kanjiDetails ?? characterDetails[`${text}:${index}`])?.find((entry) => entry.character === character);
                    return <View key={character} style={styles.characterEntry}>
                      <Text style={styles.characterTitle}>{character}</Text>
                      <Text style={styles.previewMeaning}>{detail?.meanings.length ? detail.meanings.join('; ') : 'No character dictionary entry available.'}</Text>
                      {!!detail?.onReadings.length && <Text style={styles.characterReading}>On · {detail.onReadings.join(' · ')}</Text>}
                      {!!detail?.kunReadings.length && <Text style={styles.characterReading}>Kun · {detail.kunReadings.join(' · ')}</Text>}
                    </View>;
                  })}
                  {expandedCharacters.has(index) && characterError && <Text style={styles.translationError}>{characterError}</Text>}
                </>
              )}
            </View>
          );
        })}
        {!words.length && <Text style={styles.previewStatusText}>No dictionary words were found in this text.</Text>}
        {showHeading && <Text style={styles.previewDisclaimer}>Local dictionary senses describe words; sentence context may leave several possible meanings.</Text>}
      </View>
    </>
  );
}

/** The exact text with furigana over kanji; a chosen dictionary reading applies only when the source is already its lemma. */
function furiganaText(text: string, analysis: AnalysisResponse, choices: Record<number, string>) {
  const segments = alignAnalysisTokensToText(text, analysis.tokens.map((token, index) => {
    const word = wordDisplayForToken(token, choices[index] ?? null);
    return { surface: token.surface, reading: word.sourceSurface ? token.reading : word.reading };
  }));
  if (!segments) return <Text selectable style={styles.selectionPreview}>{text}</Text>;
  return (
    <View accessible accessibilityLabel={text} style={styles.previewFurigana}>
      {segments.flatMap((segment, index) => segment.text.split('\n').flatMap((part, line) => [
        ...(line ? [<View key={`${index}:${line}:break`} style={styles.rubyBreak} />] : []),
        ...(part ? [
          <View key={`${index}:${line}`} style={styles.previewFuriganaToken}>
            <Text style={styles.previewReading}>{segment.reading && hasKanji(part) ? hiraganaReading(segment.reading) : ' '}</Text>
            <Text style={styles.previewFuriganaSurface}>{part}</Text>
          </View>,
        ] : []),
      ]))}
    </View>
  );
}

function savable(token: AnalysisResponse['tokens'][number]): boolean {
  return token.dictionaryCandidates.some((candidate) => candidate.reading.trim() && candidate.meanings.some((meaning) => meaning.trim()))
    || !!token.curatedMeaning?.trim();
}

function hasKanji(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}
