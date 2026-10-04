import { useEffect, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { analysisBaseUrl, hiraganaReading, isContentToken, wordDisplayForToken, requestJapaneseAnalysis, tokenMeaningForDisplay } from '../../capture/analysis';
import { updateAnalysisTokenReview } from '../../capture/review';
import { addWordCard, loadCaptureById, saveAnalysisForText, saveAnalysisReviewForText, saveTranslationForText } from '../../capture/store';
import { AI_TRANSLATION_ENABLED, contextualMeaningForToken, requestSentenceTranslation, sentenceTranslationFailureMessage, TRANSLATION_CONTRACT_VERSION } from '../../capture/translation';
import { analysisRequestFor, type AnalysisToken, type CaptureRecord } from '../../capture/types';
import { colors } from '../../theme';

export default function SavedSentenceScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const [capture, setCapture] = useState<CaptureRecord | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [loadBusy, setLoadBusy] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [cardNotice, setCardNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expandedTokens, setExpandedTokens] = useState<Set<number>>(() => new Set());
  const [showOriginal, setShowOriginal] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const currentCapture = useRef<CaptureRecord | null>(null);
  const reviewSaveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => { currentCapture.current = capture; }, [capture]);

  function saveReviewInOrder(record: CaptureRecord): Promise<boolean> {
    const write = reviewSaveQueue.current.then(async () => {
      const saved = await saveAnalysisReviewForText(record.id, record.correctedText, record.analysisReview);
      if (!saved) throw new Error('Saved text changed before this word review could be persisted.');
      return saved;
    });
    reviewSaveQueue.current = write.then(() => undefined, () => undefined);
    return write;
  }

  useEffect(() => {
    let active = true;
    if (!id) {
      Promise.resolve().then(() => {
        if (active) {
          setLoadError('This saved sentence could not be found.');
          setLoadBusy(false);
        }
      });
      return () => { active = false; };
    }
    loadCaptureById(id)
      .then((record) => {
        if (!active) return;
        setLoadedId(id);
        setLoadError(record ? null : 'This saved sentence could not be found.');
        setAnalysisError(null);
        setCapture(record);
        setLoadBusy(false);
      })
      .catch(() => {
        if (active) {
          setLoadedId(id);
          setLoadError('This saved sentence could not be opened. Your capture remains saved on this device.');
          setLoadBusy(false);
        }
      });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!capture || capture.analysis || !capture.correctedText) return;
    let active = true;
    requestJapaneseAnalysis(analysisRequestFor(capture))
      .then(async (analysis) => {
        if (!active) return;
        const analyzed = { ...capture, analysis };
        let saveFailed = false;
        let savedForThisText = false;
        try {
          savedForThisText = await saveAnalysisForText(capture.id, capture.correctedText, analysis);
        } catch {
          saveFailed = true;
        }
        if (!active) return;
        if (!savedForThisText && !saveFailed) {
          setAnalysisError('The saved text changed while it was being analyzed. Retry to analyze the current text.');
          return;
        }
        setCapture(analyzed);
        if (saveFailed) setAnalysisError('Readings are ready, but could not be saved. The sentence itself is safe.');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAnalysisError(error instanceof Error && error.message === 'Local Japanese analysis is not configured.'
          ? 'Local Japanese analysis is not configured. Follow the “Japanese readings and dictionary” setup in DEVELOPMENT.md.'
          : 'Could not load readings and dictionary meanings. Your saved sentence is safe; check the local analysis service and retry.');
      })
    return () => { active = false; };
  }, [capture, attempt]);

  function toggleToken(index: number) {
    setExpandedTokens((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function retryAnalysis() {
    if (capture?.analysis) {
      setAnalysisError(null);
      try {
        const saved = await saveAnalysisForText(capture.id, capture.correctedText, capture.analysis);
        if (!saved) throw new Error('Saved text changed before readings could be persisted.');
        await saveReviewInOrder(capture);
      } catch {
        setAnalysisError('Your word choices could not be saved. The sentence itself is safe; please retry.');
      }
      return;
    }
    setAnalysisError(null);
    setAttempt((value) => value + 1);
  }

  async function updateTokenReview(index: number, change: { ignored?: boolean; dictionaryCandidateId?: string | null }) {
    const latest = currentCapture.current ?? capture;
    if (!latest) return;
    const updated = updateAnalysisTokenReview(latest, index, change);
    currentCapture.current = updated;
    setCapture(updated);
    try {
      await saveReviewInOrder(updated);
      setAnalysisError(null);
    } catch {
      setAnalysisError('Your choice is shown but could not be saved. Tap Retry save to keep it.');
    }
  }

  async function translateSentence() {
    if (!capture) return;
    const sourceText = capture.correctedText;
    setTranslationBusy(true);
    setTranslationError(null);
    try {
      let analysis = capture.analysis?.normalizedText === sourceText ? capture.analysis : null;
      if (!analysis) {
        try {
          analysis = await requestJapaneseAnalysis(analysisRequestFor(capture));
        } catch {
          analysis = null;
        }
        if (analysis) {
          const latest = await loadCaptureById(capture.id);
          if (!latest || latest.correctedText !== sourceText) {
            setTranslationError('The saved text changed during analysis. Your text is unchanged; retry translation.');
            return;
          }
          const analyzed = { ...latest, analysis };
          currentCapture.current = analyzed;
          setCapture(analyzed);
          try {
            const saved = await saveAnalysisForText(capture.id, sourceText, analysis);
            if (!saved) {
              setTranslationError('The saved text changed while readings were loading. Your text is unchanged; retry translation.');
              return;
            }
          } catch {
            setAnalysisError('Readings are shown but could not be saved. Retry save to keep them.');
          }
        }
      }
      const response = await requestSentenceTranslation({
        contractVersion: TRANSLATION_CONTRACT_VERSION,
        sourceLanguage: capture.language,
        targetLanguage: 'en',
        text: sourceText,
        words: analysis?.tokens
          .map((token, tokenIndex) => ({ tokenIndex, surface: token.surface, token }))
          .filter(({ token }) => isContentToken(token))
          .map(({ tokenIndex, surface }) => ({ tokenIndex, surface })) ?? [],
      });
      const latest = await loadCaptureById(capture.id);
      if (!latest || latest.correctedText !== sourceText) {
        setTranslationError('The saved text changed during translation. Your text is unchanged; tap Translate sentence again.');
        return;
      }
      const translated = {
        ...(currentCapture.current?.id === latest.id && currentCapture.current.correctedText === sourceText
          ? currentCapture.current : latest),
        analysis: latest.analysis ?? analysis,
        sentenceTranslation: {
          sourceText,
          targetLanguage: 'en',
          text: response.translation,
          wordMeanings: response.wordMeanings,
        },
      };
      currentCapture.current = translated;
      setCapture(translated);
      try {
        const saved = await saveTranslationForText(translated.id, sourceText, translated.sentenceTranslation);
        if (!saved) {
          setTranslationError('The saved text changed during translation. Retry translation for the current text.');
          return;
        }
      } catch {
        setTranslationError('Translation is shown, but could not be saved on this device. Retry to save it.');
      }
      if (!analysis) {
        setTranslationError('Sentence translation is ready, but local word boundaries were unavailable. Retry readings, then translate again for contextual word meanings.');
      }
    } catch (error: unknown) {
      setTranslationError(sentenceTranslationFailureMessage(error));
    } finally {
      setTranslationBusy(false);
    }
  }

  if (loadError) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.errorPage}>
          <Text style={styles.eyebrow}>YUGEN · LIBRARY</Text>
          <Text style={styles.errorPageTitle}>{loadError}</Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace('/(tabs)')} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Back to Library</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!capture || loadBusy || loadedId !== id) {
    return (
      <SafeAreaView style={[styles.screen, styles.loadingPage]}>
        <ActivityIndicator color={colors.green} />
        <Text style={styles.helperText}>Opening your saved sentence…</Text>
      </SafeAreaView>
    );
  }

  const tokens = capture.analysis?.tokens ?? [];
  const sentenceTranslation = AI_TRANSLATION_ENABLED && capture.sentenceTranslation?.sourceText === capture.correctedText
    ? capture.sentenceTranslation
    : null;
  const words = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => isContentToken(token));
  const analysisBusy = !capture.analysis && !analysisError;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.topAction}>
          <Text style={styles.topActionText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.topTitle}>SAVED SENTENCE</Text>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/(tabs)')} style={styles.topAction}>
          <Text style={styles.topActionText}>Library</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.sentenceCard}>
          <Text style={styles.eyebrow}>YOUR TEXT · UNCHANGED</Text>
          <Text selectable style={styles.sentenceText}>{capture.correctedText}</Text>
          <Text style={styles.sentenceNote}>Saved on this device · {new Date(capture.savedAt ?? capture.createdAt).toLocaleDateString()}</Text>
        </View>

        {sentenceTranslation && (
          <View style={styles.translationCard}>
            <Text style={styles.translationEyebrow}>SENTENCE TRANSLATION · AI</Text>
            <Text selectable style={styles.translationText}>{sentenceTranslation.text}</Text>
          </View>
        )}
        <View style={styles.vocabularyHeader}>
          <View>
            <Text style={styles.sectionTitle}>Readings &amp; word meanings</Text>
            <Text style={styles.sectionSubhead}>Readings above each word · dictionary senses below</Text>
          </View>
          <Text style={styles.wordCount}>{capture.analysis ? String(words.filter(({ index }) => !capture.analysisReview[String(index)]?.ignored).length).padStart(2, '0') : '···'}</Text>
        </View>

        {analysisBusy && (
          <View style={styles.statusCard}>
            <ActivityIndicator color={colors.green} />
            <Text style={styles.statusText}>Finding readings and dictionary entries…</Text>
          </View>
        )}
        {analysisError && (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Your sentence is saved.</Text>
            <Text style={styles.errorCopy}>{analysisError}</Text>
            <Pressable accessibilityRole="button" disabled={analysisBusy} onPress={() => void retryAnalysis()} style={styles.retryButton}>
              <Text style={styles.retryText}>{capture.analysis ? 'Retry save' : analysisBaseUrl() ? 'Retry analysis' : 'Analysis setup needed'}</Text>
            </Pressable>
          </View>
        )}

        {!!capture.analysis && (words.length ? (
          <View style={styles.wordList}>
            {words.map(({ token, index }) => (
              <WordRow
                key={`${index}:${token.surface}`}
                token={token}
                contextualMeaning={contextualMeaningForToken(sentenceTranslation, capture.correctedText, index, token.surface)}
                ignored={capture.analysisReview[String(index)]?.ignored ?? false}
                selectedDictionaryCandidateId={capture.analysisReview[String(index)]?.dictionaryCandidateId ?? null}
                expanded={expandedTokens.has(index)}
                onPress={() => toggleToken(index)}
                onChooseCandidate={(dictionaryCandidateId) => void updateTokenReview(index, { dictionaryCandidateId })}
                onToggleIgnored={() => void updateTokenReview(index, { ignored: !(capture.analysisReview[String(index)]?.ignored ?? false) })}
                onAddCard={() => {
                  const candidate = token.dictionaryCandidates.find((entry) => entry.id === capture.analysisReview[String(index)]?.dictionaryCandidateId)
                    ?? (token.dictionaryCandidates.length === 1 ? token.dictionaryCandidates[0] : null);
                  if (token.dictionaryCandidates.length > 1 && !candidate) { setCardNotice('Choose a dictionary reading and meaning before saving.'); return; }
                  const reading = candidate?.reading ?? token.reading;
                  if (!reading) { setCardNotice('Choose a dictionary reading before adding this word.'); return; }
                  void addWordCard(capture, index, hiraganaReading(reading)).then((saved) => setCardNotice(saved ? 'Word card saved in Library.' : 'The source changed. Reopen it before adding this word.'))
                    .catch(() => setCardNotice('This word card could not be saved. Please try again.'));
                }}
              />
            ))}
          </View>
        ) : (
          <View style={styles.statusCard}>
            <Text style={styles.statusText}>No dictionary words were detected. Your saved text is unchanged.</Text>
          </View>
        ))}
        {cardNotice && <Text accessibilityLiveRegion="polite" style={styles.helperText}>{cardNotice}</Text>}

        {AI_TRANSLATION_ENABLED && <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTranslation }} onPress={() => setShowTranslation((value) => !value)} style={styles.originalToggle}>
          <Text style={styles.originalTitle}>Optional AI translation</Text>
          <Text style={styles.disclosure}>{showTranslation ? '−' : '+'}</Text>
        </Pressable>}
        {AI_TRANSLATION_ENABLED && showTranslation && (
        <View style={styles.translationCard}>
          <Text style={styles.translationEyebrow}>OPENAI · SENTENCE + WORDS</Text>
          <Pressable accessibilityRole="button" disabled={translationBusy} onPress={() => void translateSentence()} style={styles.translationButton}>
            {translationBusy ? <ActivityIndicator size="small" color={colors.green} /> : <Text style={styles.translationButtonText}>{sentenceTranslation ? 'Translate again' : 'Translate sentence + words'}</Text>}
          </Pressable>
          <Text style={styles.translationPrivacy}>Sends corrected text and local word surfaces—not the photo or raw OCR—to OpenAI via your local Mac when tapped; usage may be billed.</Text>
          {translationError && <Text accessibilityLiveRegion="polite" style={styles.translationError}>{translationError}</Text>}
        </View>

        )}

        <Pressable accessibilityRole="button" onPress={() => setShowOriginal((value) => !value)} style={styles.originalToggle}>
          <View>
            <Text style={styles.originalTitle}>{showOriginal ? 'Hide' : 'Show'} original capture</Text>
            <Text style={styles.originalSubtitle}>Photo, raw OCR, confidence, and image details</Text>
          </View>
          <Text style={styles.disclosure}>{showOriginal ? '−' : '+'}</Text>
        </Pressable>
        {showOriginal && (
          <View style={styles.originalCard}>
            <Image source={{ uri: capture.imageUri }} style={styles.originalImage} resizeMode="contain" />
            <Text style={styles.metaText}>{capture.imageMetadata.width} × {capture.imageMetadata.height} · {capture.source}</Text>
            {capture.imageMetadata.fileName && <Text style={styles.metaText}>{capture.imageMetadata.fileName}</Text>}
            <Text style={styles.rawLabel}>RAW OCR · PRESERVED</Text>
            <Text selectable style={styles.rawText}>{capture.rawText || 'No OCR text was returned.'}</Text>
            {capture.regions.map((region) => (
              <Text key={region.id} style={styles.confidenceText}>
                {region.text}{region.confidence === null ? '' : ` · ${Math.round(region.confidence * 100)}%`}
              </Text>
            ))}
          </View>
        )}
        <Text style={styles.footerNote}>Parser readings are automatic. Local dictionary senses describe words; choose an entry to confirm its reading and meaning.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function WordRow({
  token,
  contextualMeaning,
  expanded,
  ignored,
  selectedDictionaryCandidateId,
  onPress,
  onChooseCandidate,
  onToggleIgnored,
  onAddCard,
}: {
  token: AnalysisToken;
  contextualMeaning: string | null;
  expanded: boolean;
  ignored: boolean;
  selectedDictionaryCandidateId: string | null;
  onPress: () => void;
  onChooseCandidate: (id: string) => void;
  onToggleIgnored: () => void;
  onAddCard: () => void;
}) {
  const display = wordDisplayForToken(token, selectedDictionaryCandidateId);
  const reading = display.reading ? hiraganaReading(display.reading) : '';
  const chosenCandidate = token.dictionaryCandidates.find((candidate) => candidate.id === selectedDictionaryCandidateId);
  const activeCandidate = chosenCandidate ?? token.dictionaryCandidates.find((candidate) => candidate.recommended);
  const displayedMeaning = tokenMeaningForDisplay(token, selectedDictionaryCandidateId);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onPress} style={styles.wordCard}>
      <View style={styles.wordTop}>
        <View style={styles.wordName}>
          {reading && <Text style={styles.wordReading}>{reading}</Text>}
          <Text style={styles.wordSurface}>{display.surface}</Text>
                  </View>
        <Text style={styles.wordChevron}>{expanded ? '−' : '+'}</Text>
      </View>
      {display.sourceSurface && <Text style={styles.scriptUnits}>In source · {display.sourceSurface} · {display.sourceReading ? hiraganaReading(display.sourceReading) : 'Reading unknown'}</Text>}
      <Text style={ignored || (!contextualMeaning && !displayedMeaning) ? styles.unknownGloss : styles.gloss}>
        {ignored ? 'Hidden from vocabulary' : contextualMeaning
          ? `In this sentence · ${contextualMeaning}`
          : displayedMeaning?.source === 'Yugen term guide'
            ? `Known term · app guide: ${displayedMeaning.text}`
            : displayedMeaning ? `Dictionary · ${displayedMeaning.text}` : token.dictionaryCandidates.length > 1
              ? 'Choose a reading and meaning'
              : token.dictionaryCandidates.length
                ? 'Meaning not available'
                : 'Unknown · no JMdict entry'}
      </Text>
      <Pressable accessibilityRole="button" onPress={onAddCard} style={styles.ignoreButton}>
        <Text style={styles.topActionText}>Add word card</Text>
      </Pressable>
      {expanded && (
        <View style={styles.entryDetails}>
          <Text style={styles.partOfSpeech}>{token.partOfSpeech} · {token.lemma}</Text>
          {contextualMeaning && (
            <View style={styles.contextMeaning}>
              <Text style={styles.contextMeaningLabel}>IN THIS SENTENCE · AI</Text>
              <Text style={styles.gloss}>{contextualMeaning}</Text>
            </View>
          )}
          {!!token.dictionaryCandidates.length && <Text style={styles.dictionaryLabel}>DICTIONARY CANDIDATES</Text>}
          {token.dictionaryCandidates.map((candidate) => (
            <Pressable
              key={candidate.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: chosenCandidate?.id === candidate.id }}
              onPress={() => onChooseCandidate(candidate.id)}
              style={styles.senseOption}
            >
              <Text style={styles.senseMark}>{chosenCandidate?.id === candidate.id ? '●' : '○'}</Text>
              <Text style={chosenCandidate?.id === candidate.id || (!chosenCandidate && candidate.recommended) ? styles.gloss : styles.extraGloss}>
                {hiraganaReading(candidate.reading)} · {candidate.meanings[0] ?? 'No gloss'}
                {candidate.meanings.length > 1 ? ` · +${candidate.meanings.length - 1} senses` : ''}
              </Text>
              {!chosenCandidate && candidate.recommended && <Text style={styles.recommendedTag}>Likely</Text>}
            </Pressable>
          ))}
          {activeCandidate?.meanings.slice(1).map((meaning, index) => (
            <Text key={`${activeCandidate.id}:${index}`} style={styles.extraGloss}>{meaning}</Text>
          ))}
          {!!token.scriptUnits.length && token.scriptUnits.map((character) => {
            const detail = token.kanjiDetails?.find((entry) => entry.character === character);
            return <View key={character}>
              <Text style={styles.wordSurface}>{character}</Text>
              <Text style={styles.gloss}>{detail?.meanings.length ? detail.meanings.join('; ') : 'No character dictionary entry available.'}</Text>
              {!!detail?.onReadings.length && <Text style={styles.scriptUnits}>On · {detail.onReadings.join(' · ')}</Text>}
              {!!detail?.kunReadings.length && <Text style={styles.scriptUnits}>Kun · {detail.kunReadings.join(' · ')}</Text>}
            </View>;
          })}
          <Pressable accessibilityRole="button" onPress={onToggleIgnored} style={styles.ignoreButton}>
            <Text style={styles.ignoreText}>{ignored ? 'Restore this word finding' : 'Ignore this word finding'}</Text>
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 30, maxWidth: 720, width: '100%', alignSelf: 'center' },
  topBar: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: colors.line },
  topAction: { minWidth: 58, minHeight: 44, justifyContent: 'center' },
  topActionText: { color: colors.green, fontSize: 16, fontWeight: '700' },
  topTitle: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1.4 },
  sentenceCard: { backgroundColor: colors.green, borderRadius: 12, padding: 24, marginTop: 12 },
  translationCard: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 2, borderColor: colors.ink, padding: 16, marginTop: 12 },
  translationEyebrow: { color: colors.orange, fontSize: 14, fontWeight: '700', letterSpacing: 1.2 },
  translationText: { color: colors.ink, fontSize: 17, lineHeight: 25, marginTop: 7 },
  translationButton: { minHeight: 48, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.ink, marginTop: 8 },
  translationButtonText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  translationPrivacy: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 6 },
  translationError: { color: colors.orange, fontSize: 14, lineHeight: 21, marginTop: 7 },
  eyebrow: { color: '#E4E4E4', fontSize: 14, fontWeight: '700', letterSpacing: 1.2 },
  sentenceText: { color: colors.white, fontSize: 32, lineHeight: 46, fontWeight: '700', marginTop: 17 },
  furiganaSentence: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 18, rowGap: 11 },
  furiganaToken: { alignItems: 'center', justifyContent: 'flex-end', marginRight: 1, minWidth: 10 },
  furiganaReading: { minHeight: 16, color: '#EFEFEF', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  furiganaSurface: { color: colors.white, fontSize: 32, lineHeight: 44, fontWeight: '700' },
  furiganaGap: { color: colors.white, fontSize: 32, lineHeight: 44, fontWeight: '700' },
  furiganaNote: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 5 },
  sentenceNote: { color: '#E4E4E4', fontSize: 14, marginTop: 16 },
  vocabularyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 32, marginBottom: 11 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  sectionSubhead: { color: colors.muted, fontSize: 14, marginTop: 4 },
  wordCount: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  wordList: { gap: 16 },
  wordCard: { backgroundColor: colors.card, borderWidth: 2, borderColor: colors.ink, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  wordTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  wordName: { flex: 1, alignItems: 'flex-start', gap: 2 },
  wordSurface: { color: colors.ink, fontSize: 20, fontWeight: '700' },
  wordReading: { color: colors.green, fontSize: 16 },
  wordChevron: { color: colors.green, fontSize: 19, fontWeight: '500' },
  gloss: { color: colors.ink, fontSize: 16, lineHeight: 21, marginTop: 5 },
  unknownGloss: { color: colors.muted, fontSize: 16, fontStyle: 'italic', marginTop: 5 },
  entryDetails: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 10, paddingTop: 9, gap: 4 },
  partOfSpeech: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  contextMeaning: { marginTop: 5 },
  contextMeaningLabel: { color: colors.green, fontSize: 14, fontWeight: '700', letterSpacing: 0.8 },
  dictionaryLabel: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 0.8, marginTop: 6 },
  extraGloss: { flex: 1, color: colors.ink, fontSize: 16, lineHeight: 21 },
  senseOption: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 5 },
  senseMark: { color: colors.green, fontSize: 16, width: 14 },
  recommendedTag: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
  ignoreButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginTop: 5 },
  ignoreText: { color: colors.orange, fontSize: 14, fontWeight: '700' },
  scriptUnits: { color: colors.muted, fontSize: 14, fontWeight: '600', marginTop: 4 },
  statusCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 16 },
  statusText: { flex: 1, color: colors.muted, fontSize: 16, lineHeight: 21 },
  errorCard: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.orange, borderRadius: 12, padding: 16 },
  errorTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  errorCopy: { color: colors.muted, fontSize: 16, lineHeight: 21, marginTop: 4 },
  retryButton: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.ink, marginTop: 10 },
  retryText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  originalToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: colors.line, marginTop: 24, paddingVertical: 14 },
  originalTitle: { color: colors.green, fontSize: 16, fontWeight: '700' },
  originalSubtitle: { color: colors.muted, fontSize: 14, marginTop: 4 },
  disclosure: { color: colors.green, fontSize: 21 },
  originalCard: { backgroundColor: colors.card, borderRadius: 12, padding: 12 },
  originalImage: { width: '100%', height: 230, borderRadius: 10, backgroundColor: colors.greenWash },
  metaText: { color: colors.muted, fontSize: 14, marginTop: 6 },
  rawLabel: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1, marginTop: 14 },
  rawText: { color: colors.ink, fontSize: 16, lineHeight: 22, marginTop: 6 },
  confidenceText: { color: colors.muted, fontSize: 14, marginTop: 5 },
  footerNote: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 22 },
  helperText: { color: colors.muted, fontSize: 16, marginTop: 12 },
  loadingPage: { justifyContent: 'center', alignItems: 'center' },
  errorPage: { flex: 1, justifyContent: 'center', padding: 24 },
  errorPageTitle: { color: colors.ink, fontSize: 19, fontWeight: '700', lineHeight: 26, marginTop: 8 },
  primaryButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 12, backgroundColor: colors.green, marginTop: 18 },
  primaryButtonText: { color: colors.white, fontSize: 16, fontWeight: '700' },
});
