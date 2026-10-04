import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { addWordCard, loadCaptureById, loadTextEntryForGroup, loadTextGroup, saveGroupAnalysisForText } from '../../capture/store';
import { analysisFailureMessage, readingToSave, requestJapaneseAnalysis } from '../../capture/analysis';
import type { CaptureRecord, TextGroup } from '../../capture/types';
import AnalysisReadingsAndMeanings, { wordSaveResultFor } from '../../capture/CaptureAnalysisPreview';
import SourcePhoto from '../../capture/SourcePhoto';
import { afterCommit, onStudyChange } from '../../capture/studyChanges';
import { styles } from '../../capture/uiStyles';

export default function SavedGroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [group, setGroup] = useState<TextGroup | null>(null);
  const [source, setSource] = useState<CaptureRecord | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showPhoto, setShowPhoto] = useState(false);
  const [entryId, setEntryId] = useState<string | null>(null);
  const latestGroup = useRef<TextGroup | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const [version, setVersion] = useState(0);
  // Its entry can be edited or deleted on the entry screen above it: reload on return and on committed changes,
  // after any word write still in flight, so the persisted text (or its deletion) is shown.
  useEffect(() => onStudyChange(() => setVersion((value) => value + 1)), []);
  useFocusEffect(useCallback(() => {
    let active = true;
    writes.current.catch(() => {}).then(() => loadTextGroup(id)).then(async (record) => {
      const capture = record ? await loadCaptureById(record.captureId) : null;
      const entry = record ? await loadTextEntryForGroup(record.id) : null;
      if (active) { latestGroup.current = record; setGroup(record); setSource(capture); setEntryId(entry?.id ?? null); setBusy(false); }
    }).catch(() => { if (active) { setError('This text group could not be opened.'); setBusy(false); } });
    return () => { active = false; };
    // A committed change must re-run the load while this screen stays focused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version]));
  useEffect(() => {
    const currentGroup = latestGroup.current;
    if (!currentGroup || (currentGroup.analysis?.normalizedText === currentGroup.text && attempt === 0)) return;
    let active = true;
    Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(true);
      setError(null);
      try {
        const analysis = await requestJapaneseAnalysis({ contractVersion: 2, language: source?.language ?? 'ja', text: currentGroup.text });
        if (!active) return;
        const current = latestGroup.current;
        if (!current || current.text !== analysis.normalizedText) return;
        const saved = await saveGroupAnalysisForText(current.id, current.text, analysis, current.analysisReview);
        if (!saved && active) setError('This group changed or was removed. Reopen it from Library.');
        if (saved && active) { const updated = { ...current, analysis }; latestGroup.current = updated; setGroup(updated); setError(null); }
      } catch (cause) { if (active) setError(analysisFailureMessage(cause)); }
      finally { if (active) setBusy(false); }
    });
    return () => { active = false; };
  }, [group?.id, group?.text, source?.language, attempt]);

  function updateStudy(updated: TextGroup) {
    latestGroup.current = updated;
    setGroup(updated);
    if (!updated.analysis) return;
    const write = writes.current.catch(() => {}).then(async () => {
      if (!await saveGroupAnalysisForText(updated.id, updated.text, updated.analysis!, updated.analysisReview)) throw new Error('The group changed.');
    });
    writes.current = write;
    void write.catch(() => setError('Your study choice is shown but could not be saved. Please retry.'));
  }
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.reviewContent}>
        <View style={styles.captureHeader}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.newCaptureButton}><Text style={styles.newCaptureText}>‹ Library</Text></Pressable>
          <Text style={styles.captureTitle}>Saved group</Text>
        </View>
        <ScrollView contentContainerStyle={styles.textContent}>
          {!group || !source ? busy ? <ActivityIndicator /> : <Text style={styles.errorMessage}>{error ?? 'This group or its source was deleted.'}</Text> : (
            <>
              <AnalysisReadingsAndMeanings key={`${group.id}:${group.text}`} text={group.text} analysis={group.analysis} busy={busy} error={error}
                choices={Object.fromEntries(Object.entries(group.analysisReview).filter(([, review]) => review.dictionaryCandidateId).map(([index, review]) => [index, review.dictionaryCandidateId!]))}
                onRetry={() => setAttempt((value) => value + 1)}
                onChooseCandidate={(index, dictionaryCandidateId) => updateStudy({ ...group, analysisReview: { ...group.analysisReview, [index]: { ignored: group.analysisReview[index]?.ignored ?? false, dictionaryCandidateId } } })}
                onSaveWord={async (index) => {
                  const token = group.analysis?.tokens[index];
                  const reading = token ? readingToSave(token, group.analysisReview[index]?.dictionaryCandidateId) : null;
                  if (!token || !reading) return { state: 'failed', message: 'This word has no dictionary reading to save.' };
                  // Waits for pending choice writes, so the saved word uses the sense shown.
                  await writes.current.catch(() => {});
                  return wordSaveResultFor(await afterCommit(addWordCard(source, index, reading, group)));
                }}
                onEnrichCharacters={(index, details) => { const current = latestGroup.current; if (current?.analysis) updateStudy({ ...current, analysis: { ...current.analysis, tokens: current.analysis.tokens.map((token, position) => position === index ? { ...token, kanjiDetails: details } : token) } }); }}
                translation={null} translationBusy={false} translationError={null} onTranslate={() => {}} showHeading />
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPhoto }} onPress={() => setShowPhoto((value) => !value)} style={styles.disclosureButton}>
                <Text style={styles.disclosureText}>{showPhoto ? 'Hide photo' : 'Show in photo'}</Text>
              </Pressable>
              {showPhoto && <SourcePhoto capture={source} regions={source.regions.filter((region) => group.regionIds.includes(region.id))} />}
              {/* One entry screen owns Edit, translation, Delete and the practice card for this saved text. */}
              {entryId && <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/card/[id]', params: { id: entryId, mode: 'dictionary' } })} style={styles.disclosureButton}><Text style={styles.disclosureText}>Edit, translate, delete or practice ›</Text></Pressable>}
              <Pressable accessibilityRole="button" onPress={() => router.navigate({ pathname: '/(tabs)/capture', params: { captureId: source.id, groupId: group.id, fresh: undefined } })} style={styles.disclosureButton}><Text style={styles.disclosureText}>Original photo &amp; findings ›</Text></Pressable>
            </>
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
