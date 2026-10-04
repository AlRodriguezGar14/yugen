import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { deleteTextGroup, deleteWordCard, createPracticeCard, loadPracticeCardForEntry, EntryDeletedError, type PracticeCard, enrichWordCardCharacters, loadCaptureById, loadStudyCard, loadTextGroup, saveAnalysisForText, saveGroupAnalysisForText, updateWordCard, updateSavedText, WordConflictError, type StudyCard } from '../../capture/store';
import { confirmEntryDeletion } from '../../capture/entryActions';
import { requestJapaneseAnalysis, analysisFailureMessage } from '../../capture/analysis';
import { studyDataForCard } from '../../capture/studyCards';
import { analysisRequestFor, type CaptureRecord } from '../../capture/types';
import AnalysisReadingsAndMeanings from '../../capture/CaptureAnalysisPreview';
import SourcePhoto from '../../capture/SourcePhoto';
import { colors } from '../../theme';

export default function StudyCardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [card, setCard] = useState<StudyCard | null>(null);
  const [capture, setCapture] = useState<CaptureRecord | null>(null);
  const [revealed, setRevealed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [regionIds, setRegionIds] = useState<string[]>([]);
  const [showPhoto, setShowPhoto] = useState(false);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<{ text: string; lemma: string; reading: string; meaning: string } | null>(null);
  const [pending, setPending] = useState<'saving' | 'deleting' | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [deleted, setDeleted] = useState<string | null>(null);
  const [practice, setPractice] = useState<PracticeCard | null>(null);
  const [creatingPractice, setCreatingPractice] = useState(false);
  useEffect(() => {
    let active = true;
    loadStudyCard(id).then(async (savedCard) => {
      const source = savedCard ? await loadCaptureById(savedCard.captureId) : null;
      const group = savedCard?.groupId ? await loadTextGroup(savedCard.groupId) : null;
      const linkedPractice = savedCard ? await loadPracticeCardForEntry(savedCard.id) : null;
      const context = source && savedCard ? { ...source, correctedText: savedCard.sourceText,
        analysis: group?.text === savedCard.sourceText ? group.analysis : source.analysis?.normalizedText === savedCard.sourceText ? source.analysis : null,
        analysisReview: group?.text === savedCard.sourceText ? group.analysisReview : source.analysisReview } : null;
      if (active) { setCard(savedCard); setCapture(context); setRegionIds(group?.regionIds ?? []); setPractice(linkedPractice); setLoading(false); setPending(null); }
    }).catch(() => { if (active) { setError('This card could not be opened. Your Library remains saved.'); setLoading(false); setPending(null); } });
    return () => { active = false; };
  }, [id, reload]);
  useEffect(() => {
    if (!revealed || !capture || card?.wordSnapshot || capture.analysis?.normalizedText === capture.correctedText || capture.correctedText !== card?.sourceText) return;
    let active = true;
    Promise.resolve().then(async () => {
      if (!active) return;
      setAnalysisBusy(true);
      setError(null);
      try {
        const analysis = await requestJapaneseAnalysis(analysisRequestFor(capture));
        const saved = card?.groupId ? await saveGroupAnalysisForText(card.groupId, capture.correctedText, analysis)
          : await saveAnalysisForText(capture.id, capture.correctedText, analysis);
        if (active && saved) setCapture({ ...capture, analysis });
        else if (active) setError('The source changed while readings loaded. Reopen this card.');
      } catch (cause) { if (active) setError(analysisFailureMessage(cause)); }
      finally { if (active) setAnalysisBusy(false); }
    });
    return () => { active = false; };
  }, [revealed, capture, card?.sourceText, card?.groupId, card?.wordSnapshot, attempt]);
  const { analysis, choices } = card && capture ? studyDataForCard(card, capture) : { analysis: null, choices: {} };
  // A word whose saved text was removed still opens its photo and rows.
  const openSource = () => card?.groupId ? router.push({ pathname: '/group/[id]', params: { id: card.groupId } })
    : router.navigate({ pathname: '/(tabs)/capture', params: { captureId: card?.captureId, groupId: undefined, fresh: undefined } });
  // The recorded dictionary evidence keeps its original form even after the user renames the word.
  const recordedWord = card?.wordSnapshot ? card.wordSnapshot.surface : card?.lemma ?? '';
  const renamed = !!card?.wordSnapshot && (card.wordSnapshot.surface !== card.lemma || card.wordSnapshot.reading !== card.reading);

  function startEditing() {
    if (!card) return;
    setStatus(null);
    setDraft({ text: card.sourceText, lemma: card.lemma, reading: card.reading, meaning: card.personalMeaning ?? '' });
  }

  async function saveChanges() {
    if (!card || !draft || pending) return;
    setPending('saving');
    setStatus({ text: 'Saving changes…', error: false });
    try {
      if (card.kind === 'word') await updateWordCard(card.id, { lemma: draft.lemma, reading: draft.reading, personalMeaning: draft.meaning });
      else await updateSavedText(card.groupId!, draft.text, draft.meaning);
      setDraft(null);
      setStatus({ text: card.kind === 'word' ? 'Word saved.' : draft.text === card.sourceText ? 'Text saved.' : 'Text saved. Its readings are being checked again.', error: false });
      // Stays 'saving' until the reload publishes the persisted card, so a stale card cannot be edited again.
      setReload((value) => value + 1);
    } catch (cause) {
      setStatus({ text: cause instanceof WordConflictError ? cause.message : 'Changes could not be saved. Nothing was changed; try again.', error: true });
      setPending(null);
    }
  }

  function confirmDelete() {
    if (!card || pending) return;
    const word = card.kind === 'word';
    confirmEntryDeletion(card.kind, !!practice, (options) => {
      setPending('deleting');
      setStatus({ text: 'Deleting…', error: false });
      (word ? deleteWordCard(card.id, options) : deleteTextGroup(card.groupId!, options))
        .then(() => {
          setStatus(null);
          const kept = practice && options.keepPracticeCards ? ' Its practice card was kept.' : practice ? ' Its practice card was deleted.' : '';
          setDeleted(`${word ? 'Word deleted. Its text and photo remain.' : 'Text deleted. Its words and photo remain.'}${kept}`);
        })
        .catch(() => setStatus({ text: 'It could not be deleted. It is still saved; try again.', error: true }))
        .finally(() => setPending(null));
    });
  }

  async function openOrCreatePractice() {
    if (!card || creatingPractice) return;
    if (practice) { router.push({ pathname: '/practice/[id]', params: { id: practice.id } }); return; }
    setCreatingPractice(true);
    setStatus({ text: 'Creating practice card…', error: false });
    try {
      setPractice(await createPracticeCard(card.id));
      setStatus({ text: 'Practice card created. Find it under Practice in your Library.', error: false });
    } catch (cause) {
      setStatus({ text: cause instanceof EntryDeletedError ? cause.message : 'The practice card could not be created. Try again.', error: true });
    } finally { setCreatingPractice(false); }
  }
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.action}><Text style={styles.actionText}>‹ Library</Text></Pressable>
        <Text style={styles.title}>{card?.kind === 'word' ? 'Word entry' : card?.kind === 'sentence' ? 'Text entry' : 'Saved entry'}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {deleted ? <Text accessibilityLiveRegion="polite" style={styles.body}>{deleted}</Text> : loading ? <ActivityIndicator /> : !card || !capture ? <Text style={styles.body}>{error ?? 'This card or its original source was deleted.'}</Text> : (
          <>
            <Text style={styles.label}>{card.kind === 'word' ? 'WORD' : 'TEXT'} · {revealed ? (card.kind === 'word' ? 'SAVED VOCABULARY' : 'SAVED TEXT') : 'RECALL FIRST'}</Text>
            {(!revealed || card.kind === 'sentence' || renamed) && <Text selectable style={styles.front}>{card.kind === 'word' ? card.lemma : card.sourceText}</Text>}
            {revealed && renamed && <Text style={styles.body}>Your reading · {card.reading}</Text>}
            {revealed && card.kind === 'word' && card.personalMeaning && <Text style={styles.body}>Your meaning · {card.personalMeaning}</Text>}
            {revealed && card.kind === 'sentence' && card.personalMeaning && <View style={styles.personal}><Text style={styles.label}>YOUR TRANSLATION · YOUR OWN WORDS, NOT A DICTIONARY OR AI TRANSLATION</Text><Text selectable style={styles.personalText}>{card.personalMeaning}</Text></View>}
            {status && <Text accessibilityLiveRegion="polite" style={styles.body}>{status.text}</Text>}
            {draft ? (
              <View style={styles.editor}>
                {card.kind === 'word' ? (
                  <>
                    <Text style={styles.label}>WORD</Text>
                    <TextInput accessibilityLabel="Word" autoFocus editable={!pending} value={draft.lemma} onChangeText={(lemma) => setDraft({ ...draft, lemma })} style={styles.input} />
                    <Text style={styles.label}>READING</Text>
                    <TextInput accessibilityLabel="Reading" editable={!pending} value={draft.reading} onChangeText={(reading) => setDraft({ ...draft, reading })} style={styles.input} />
                    <Text style={styles.label}>YOUR MEANING (OPTIONAL · NOT FROM THE DICTIONARY)</Text>
                    <TextInput accessibilityLabel="Your meaning" editable={!pending} multiline value={draft.meaning} onChangeText={(meaning) => setDraft({ ...draft, meaning })} style={styles.input} />
                  </>
                ) : (
                  <>
                    <Text style={styles.label}>TEXT</Text>
                    <TextInput accessibilityLabel="Saved text" autoFocus editable={!pending} multiline value={draft.text} onChangeText={(text) => setDraft({ ...draft, text })} style={styles.input} />
                    <Text style={styles.label}>YOUR TRANSLATION (OPTIONAL · YOUR OWN WORDS)</Text>
                    <TextInput accessibilityLabel="Your translation" editable={!pending} multiline value={draft.meaning} onChangeText={(meaning) => setDraft({ ...draft, meaning })} style={styles.input} />
                  </>
                )}
                <View style={styles.actions}>
                  <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!pending, busy: pending === 'saving' }}
                    disabled={!!pending || (card.kind === 'word' ? !draft.lemma.trim() || !draft.reading.trim() : !draft.text.trim())}
                    onPress={() => void saveChanges()} style={[styles.primary, !!pending && styles.disabled]}>
                    <Text style={styles.primaryText}>{pending === 'saving' ? 'Saving…' : 'Save changes'}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={!!pending} onPress={() => { setDraft(null); setStatus({ text: 'Edit cancelled. Nothing was changed.', error: false }); }} style={styles.secondary}>
                    <Text style={styles.actionText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (card.kind === 'word' || !!card.groupId) && (
              <View style={styles.actions}>
                <Pressable accessibilityRole="button" disabled={!!pending} onPress={startEditing} style={[styles.secondary, !!pending && styles.disabled]}>
                  <Text style={styles.actionText}>{card.kind === 'word' ? 'Edit word' : 'Edit text'}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!pending, busy: pending === 'deleting' }} disabled={!!pending} onPress={confirmDelete} style={[styles.secondary, !!pending && styles.disabled]}>
                  <Text style={styles.danger}>{pending === 'deleting' ? 'Deleting…' : card.kind === 'word' ? 'Delete word' : 'Delete text'}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!pending || creatingPractice, busy: creatingPractice }} disabled={!!pending || creatingPractice}
                  onPress={() => void openOrCreatePractice()} style={[styles.secondary, (!!pending || creatingPractice) && styles.disabled]}>
                  <Text style={styles.actionText}>{creatingPractice ? 'Creating…' : practice ? 'Open practice card' : 'Create practice card (optional)'}</Text>
                </Pressable>
              </View>
            )}
            {revealed && renamed && <Text style={styles.label}>DICTIONARY ENTRY AS RECORDED · {recordedWord} · {card.wordSnapshot?.reading}</Text>}
            {!revealed ? (
              <>
                <Text style={styles.body}>Try to recall the reading and meaning.</Text>
                <Pressable accessibilityRole="button" onPress={() => setRevealed(true)} style={styles.reveal}><Text style={styles.revealText}>Reveal readings & meanings</Text></Pressable>
              </>
            ) : capture.correctedText !== card.sourceText ? <Text style={styles.body}>This source was edited after the word card was created. Open the source to study its current text.</Text> : (
              <AnalysisReadingsAndMeanings key={`${card.id}\n${capture.correctedText}`} text={card.kind === 'word' ? recordedWord : capture.correctedText} analysis={analysis} busy={analysisBusy} error={error}
                choices={choices}
                onChooseCandidate={() => openSource()}
                onEnrichCharacters={(_index, details) => {
                  if (!card.wordSnapshot) return;
                  const enriched = { ...card, wordSnapshot: { ...card.wordSnapshot, kanjiDetails: details } };
                  setCard(enriched);
                  void enrichWordCardCharacters(card.id, details).catch(() => setError('Character definitions are shown but could not be saved. Please retry.'));
                }}
                onRetry={() => setAttempt((value) => value + 1)} showHeading={!renamed} />
            )}
            {revealed && card.kind === 'word' && <Text style={styles.body}>In your text · {card.sourceText}</Text>}
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPhoto }} onPress={() => setShowPhoto((value) => !value)} style={styles.action}>
              <Text style={styles.actionText}>{showPhoto ? 'Hide photo' : 'Show in photo'}</Text>
            </Pressable>
            {showPhoto && <SourcePhoto capture={capture} regions={card.sourceRegions ?? capture.regions.filter((region) => regionIds.includes(region.id))} />}
            <Pressable accessibilityRole="button" onPress={() => openSource()} style={styles.action}>
              <Text style={styles.actionText}>{card.groupId ? 'Open saved text ›' : 'Open photo and rows ›'}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.white },
  header: { minHeight: 48, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: 1, borderBottomColor: colors.line },
  title: { fontSize: 18, fontWeight: '700', color: colors.ink },
  content: { padding: 24, gap: 16 },
  action: { minHeight: 44, justifyContent: 'center' },
  actionText: { fontSize: 16, fontWeight: '700', color: colors.ink },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted },
  front: { fontSize: 32, lineHeight: 44, fontWeight: '700', color: colors.ink },
  body: { fontSize: 16, lineHeight: 24, color: colors.muted },
  reveal: { minHeight: 48, padding: 12, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: colors.ink },
  revealText: { fontSize: 16, fontWeight: '700', color: colors.white },
  personal: { padding: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.line, gap: 4 },
  personalText: { fontSize: 16, lineHeight: 24, color: colors.ink },
  editor: { gap: 8 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: 12, fontSize: 18, lineHeight: 26, color: colors.ink },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  primary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.ink },
  primaryText: { fontSize: 16, fontWeight: '700', color: colors.white },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.line },
  danger: { fontSize: 16, fontWeight: '700', color: colors.orange },
  disabled: { opacity: 0.55 },
});
