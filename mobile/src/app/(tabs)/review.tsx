import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { deleteCapture, loadOcrReviewCaptures } from '@/capture/store';
import { afterCommit } from '@/capture/studyChanges';
import type { CaptureRecord } from '@/capture/types';
import { colors } from '@/theme';

function statusText(capture: CaptureRecord): string {
  switch (capture.status) {
    case 'selecting': return 'READY TO READ';
    case 'processing': return 'READING PHOTO';
    case 'complete': return 'READY TO REVIEW';
    case 'failed': return 'OCR NEEDS RETRY';
  }
}

export default function OcrReviewScreen() {
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    loadOcrReviewCaptures()
      .then((items) => {
        if (active) {
          setCaptures(items);
          setError(null);
        }
      })
      .catch(() => { if (active) setError('Your OCR drafts could not be opened. Try again.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // Retry must re-run the load while the tab remains focused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttempt]));

  function confirmDelete(capture: CaptureRecord) {
    Alert.alert('Delete photo and everything from it?', 'This permanently removes the photo, its raw OCR and corrections, and every saved text, word and practice card from this photo on this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete photo and its records',
        style: 'destructive',
        onPress: () => {
          void afterCommit(deleteCapture(capture.id))
            .then(() => {
              setCaptures((current) => current.filter((item) => item.id !== capture.id));
            })
            .catch(() => Alert.alert('Could not delete', 'The capture is still in OCR Review. Try again.'));
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.brandMark}><Text style={styles.brandKanji}>文</Text></View>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>YUGEN · WORKBENCH</Text>
            <Text style={styles.heading}>Unfinished notes.</Text>
          </View>
          <Text style={styles.count}>{captures.length.toString().padStart(2, '0')}</Text>
        </View>
        <Text style={styles.intro}>Pick up where you left off. Correct the text, brush away noise, or save what you want to keep.</Text>

        {loading ? <ActivityIndicator color={colors.green} style={styles.loader} /> : error ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>OCR Review unavailable</Text><Text style={styles.emptyCopy}>{error}</Text>
            <Pressable accessibilityRole="button" onPress={() => setLoadAttempt((value) => value + 1)} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Retry loading OCR Review</Text>
            </Pressable>
          </View>
        ) : captures.length ? (
          <View style={styles.captureList}>
            {captures.map((capture) => (
              <View key={capture.id} style={styles.captureCard}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open OCR review: ${capture.correctedText || statusText(capture)}`}
                  onPress={() => router.push({ pathname: '/(tabs)/capture', params: { captureId: capture.id } })}
                  style={({ pressed }) => [styles.openCapture, pressed && styles.pressed]}
                >
                  <Image source={{ uri: capture.imageUri }} style={styles.thumbnail} />
                  <View style={styles.captureCopy}>
                    <Text style={styles.status}>{statusText(capture)}</Text>
                    <Text numberOfLines={2} style={styles.captureText}>{capture.correctedText || (capture.status === 'failed' ? 'Retry reading or enter the text yourself.' : capture.status === 'processing' ? 'Reading the Japanese in your photo…' : 'Open to read the text in this photo.')}</Text>
                    <Text style={styles.date}>{new Date(capture.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {capture.regions.length} findings</Text>
                  </View>
                  <Text style={styles.arrow}>›</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete OCR capture from ${new Date(capture.createdAt).toLocaleDateString()}`}
                  onPress={() => confirmDelete(capture)}
                  style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
                >
                  <Text style={styles.deleteText}>Delete capture</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyKicker}>NO OPEN CAPTURES</Text>
            <Text style={styles.emptyTitle}>A clean review queue.</Text>
            <Text style={styles.emptyCopy}>New photos will appear here until you save a text selection or delete the capture.</Text>
            <Pressable accessibilityRole="button" onPress={() => router.navigate({ pathname: '/(tabs)/capture', params: { fresh: String(Date.now()), captureId: undefined } })} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Capture Japanese text</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 28, maxWidth: 720, width: '100%', alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 8 },
  brandMark: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  brandKanji: { color: colors.paper, fontSize: 19 },
  headerCopy: { flex: 1 },
  eyebrow: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1.7, marginBottom: 4 },
  heading: { color: colors.ink, fontSize: 24, lineHeight: 30, fontWeight: '800' },
  count: { color: colors.muted, fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  intro: { color: colors.muted, fontSize: 16, lineHeight: 21, marginBottom: 18 },
  captureList: { gap: 16 },
  captureCard: { backgroundColor: colors.card, borderWidth: 2, borderColor: colors.ink, borderRadius: 12, padding: 10 },
  openCapture: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 76 },
  thumbnail: { width: 64, height: 72, borderRadius: 9, backgroundColor: colors.greenWash },
  captureCopy: { flex: 1 },
  status: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  captureText: { color: colors.ink, fontSize: 16, lineHeight: 21, marginTop: 5 },
  date: { color: colors.muted, fontSize: 14, marginTop: 4 },
  arrow: { color: colors.green, fontSize: 23 },
  deleteButton: { minHeight: 44, alignSelf: 'flex-end', justifyContent: 'center', paddingHorizontal: 10, borderRadius: 9, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, marginTop: 6 },
  deleteText: { color: colors.orange, fontSize: 14, fontWeight: '700' },
  emptyCard: { backgroundColor: colors.card, borderWidth: 2, borderColor: colors.ink, borderRadius: 12, padding: 24 },
  emptyKicker: { color: colors.orange, fontSize: 14, fontWeight: '700', letterSpacing: 1.2 },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '700', marginTop: 9 },
  emptyCopy: { color: colors.muted, fontSize: 16, lineHeight: 21, marginTop: 6 },
  primaryButton: { minHeight: 46, justifyContent: 'center', alignItems: 'center', borderRadius: 11, backgroundColor: colors.green, marginTop: 15 },
  primaryButtonText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  loader: { marginTop: 38 },
  pressed: { opacity: 0.76 },
});
