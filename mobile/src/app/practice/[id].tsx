import { useCallback, useEffect, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { deletePracticeCard, loadCaptureById, loadPracticeCard, type PracticeCard } from '@/capture/store';
import SourcePhoto from '@/capture/SourcePhoto';
import type { CaptureRecord } from '@/capture/types';
import StatusMessage from '@/capture/StatusMessage';
import { afterCommit, onStudyChange } from '@/capture/studyChanges';
import { colors } from '@/theme';

/** A recall exercise: the prompt first, the answer only on request. Deleting it never touches its entry. */
export default function PracticeCardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [card, setCard] = useState<PracticeCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [version, setVersion] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  // undefined: not requested; null: the original photo no longer exists.
  const [photo, setPhoto] = useState<CaptureRecord | null | undefined>(undefined);

  // Its entry may be edited while this screen stays mounted below it: reload on return and on committed changes.
  useEffect(() => onStudyChange(() => setVersion((value) => value + 1)), []);
  useFocusEffect(useCallback(() => {
    let active = true;
    // Withhold the previous card until the refreshed one arrives, so a quick Reveal can never show a stale answer.
    setRevealed(false);
    setCard(null);
    setPhoto(undefined);
    setLoading(true);
    setLoadFailed(false);
    loadPracticeCard(id)
      .then((loaded) => { if (active) setCard(loaded); })
      .catch(() => { if (active) { setLoadFailed(true); setStatus({ text: 'This practice card could not be opened. Go back and try again.', error: true }); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // A committed change must re-run the load while this screen stays focused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version]));

  function confirmDelete() {
    if (!card || deleting) return;
    Alert.alert('Delete this practice card?', card.entryId ? 'Only the practice card is deleted. Its entry and photo remain.' : 'Only this independent practice card is deleted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete practice card', style: 'destructive', onPress: () => {
        setDeleting(true);
        setStatus({ text: 'Deleting…', error: false });
        afterCommit(deletePracticeCard(card.id))
          .then(() => { setDeleted(true); setStatus({ text: card.entryId ? 'Practice card deleted. Its entry remains.' : 'Practice card deleted.', error: false }); })
          .catch(() => setStatus({ text: 'The practice card could not be deleted. Try again.', error: true }))
          .finally(() => setDeleting(false));
      } },
    ]);
  }

  async function togglePhoto(captureId: string) {
    if (photo !== undefined) { setPhoto(undefined); return; }
    // The original private image with the lines saved at first save; legacy entries show the whole photo honestly.
    setPhoto(await loadCaptureById(captureId).catch(() => null));
  }

  const answer = card?.answer;
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.action}><Text style={styles.actionText}>‹ Back</Text></Pressable>
        <Text style={styles.title}>Practice card</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <StatusMessage text={status?.text ?? null} error={status?.error} />
        {loading ? <ActivityIndicator accessibilityLabel="Loading practice card" /> : deleted || loadFailed || !card || !answer ? (
          !deleted && !loadFailed && <Text style={styles.body}>{card ? 'This practice card has no answer to show.' : 'This practice card was deleted.'}</Text>
        ) : (
          <>
            <Text style={styles.label}>{answer.kind === 'word' ? 'WORD' : 'TEXT'} · PRACTICE{card.entryId ? '' : ' · INDEPENDENT CARD (ITS ENTRY WAS DELETED)'}</Text>
            <Text selectable style={styles.front}>{answer.prompt}</Text>
            {!revealed ? (
              <Pressable accessibilityRole="button" onPress={() => setRevealed(true)} style={styles.reveal}><Text style={styles.revealText}>Reveal answer</Text></Pressable>
            ) : (
              <View accessibilityLiveRegion="polite" style={styles.answer}>
                {answer.reading && <Text style={styles.reading}>{answer.reading}</Text>}
                {answer.dictionaryMeaning && <><Text style={styles.label}>DICTIONARY</Text><Text style={styles.body}>{answer.dictionaryMeaning}</Text></>}
                {answer.personal && <>
                  <Text style={styles.label}>{answer.kind === 'word' ? 'YOUR MEANING · NOT FROM THE DICTIONARY' : 'YOUR TRANSLATION · YOUR OWN WORDS'}</Text>
                  <Text style={styles.body}>{answer.personal}</Text>
                </>}
                {!answer.dictionaryMeaning && !answer.personal && <Text style={styles.body}>No meaning or translation saved yet. Add one on its entry.</Text>}
                {answer.kind === 'word' && <Text style={styles.muted}>In your text · {answer.sourceText}</Text>}
                {/* The photo shows the text, so it is part of the answer and only offered after Reveal. */}
                {card.captureId && (
                  <Pressable accessibilityRole="button" accessibilityState={{ expanded: photo !== undefined }} onPress={() => void togglePhoto(card.captureId!)} style={styles.action}>
                    <Text style={styles.actionText}>{photo !== undefined ? 'Hide photo' : 'Show in photo'}</Text>
                  </Pressable>
                )}
                {photo === null && <Text style={styles.muted}>The original photo is no longer on this device.</Text>}
                {photo && <SourcePhoto capture={photo} regions={answer.sourceRegions ?? []} />}
                <Pressable accessibilityRole="button" onPress={() => { setRevealed(false); setPhoto(undefined); }} style={styles.action}><Text style={styles.actionText}>Hide answer</Text></Pressable>
              </View>
            )}
            <View style={styles.actions}>
              {card.entryId && (
                <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/card/[id]', params: { id: card.entryId!, mode: 'dictionary' } })} style={styles.secondary}>
                  <Text style={styles.actionText}>Open entry ›</Text>
                </Pressable>
              )}
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: deleting, busy: deleting }} disabled={deleting} onPress={confirmDelete} style={[styles.secondary, deleting && styles.disabled]}>
                <Text style={styles.danger}>{deleting ? 'Deleting…' : 'Delete practice card'}</Text>
              </Pressable>
            </View>
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
  reading: { fontSize: 20, lineHeight: 28, color: colors.ink },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  muted: { fontSize: 14, lineHeight: 20, color: colors.muted },
  answer: { gap: 8 },
  reveal: { minHeight: 48, padding: 12, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: colors.ink },
  revealText: { fontSize: 16, fontWeight: '700', color: colors.white },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.line },
  danger: { fontSize: 16, fontWeight: '700', color: colors.orange },
  disabled: { opacity: 0.55 },
});
