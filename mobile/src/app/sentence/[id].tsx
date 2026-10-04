import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, Pressable, ScrollView, Text } from 'react-native';
import { loadCaptureById, loadTextEntryForGroup } from '../../capture/store';
import type { CaptureRecord } from '../../capture/types';
import SourcePhoto from '../../capture/SourcePhoto';
import { styles } from '../../capture/uiStyles';

/** Historical sentence links resolve their preserved entry without constructing a new card identity. */
export default function SavedSentenceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [capture, setCapture] = useState<CaptureRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    loadCaptureById(id).then(async (source) => {
      const entry = source ? await loadTextEntryForGroup(`legacy:${source.id}`) : null;
      if (!active) return;
      if (entry) router.replace({ pathname: '/card/[id]', params: { id: entry.id, mode: 'dictionary' } });
      setCapture(source); setLoading(false);
    }).catch(() => { if (active) { setLoading(false); setError('This saved sentence could not be opened.'); } });
    return () => { active = false; };
  }, [id]);
  return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.textContent}>
    <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.newCaptureButton}><Text style={styles.newCaptureText}>‹ Library</Text></Pressable>
    {loading ? <ActivityIndicator /> : capture ? <><Text selectable>{capture.correctedText}</Text><SourcePhoto capture={capture} regions={capture.regions.filter((region) => region.review?.selected)} /></> : <Text>{error ?? 'This saved sentence was deleted.'}</Text>}
  </ScrollView></SafeAreaView>;
}
