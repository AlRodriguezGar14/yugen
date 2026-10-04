import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { loadLibraryCaptures, loadStudyCards, type StudyCard } from '../../capture/store';
import { photoSummary } from '../../capture/review';
import type { CaptureRecord } from '../../capture/types';
import { colors } from '../../theme';

export default function LibraryScreen() {
  const [collection, setCollection] = useState<'texts' | 'vocabulary' | 'photos'>('texts');
  const [query, setQuery] = useState('');
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    Promise.all([loadLibraryCaptures(), loadStudyCards()])
      .then(([items, savedCards]) => {
        if (active) {
          setCaptures(items);
          setCards(savedCards);
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError('Your saved sentences could not be opened. Try again.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
    // Retry must re-run the load while the tab remains focused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttempt]));

  const search = query.trim().toLocaleLowerCase();
  const savedTexts = new Map(cards.flatMap((card) => card.kind === 'sentence' && card.groupId ? [[card.groupId, card.sourceText] as const] : []));
  // Each photo appears once; its saved texts and words open independently from the other collections.
  const visiblePhotos = captures.filter((capture) => !search || [capture.correctedText, ...cards.filter((card) => card.captureId === capture.id).map((card) => card.sourceText)]
    .join(' ').toLocaleLowerCase().includes(search));
  const visibleCards = cards.filter((card) => card.kind === (collection === 'vocabulary' ? 'word' : 'sentence'))
    .filter((card) => !search || [card.lemma, card.reading, card.sourceText, ...(card.wordSnapshot?.dictionaryCandidates.flatMap((entry) => entry.meanings) ?? []), card.wordSnapshot?.curatedMeaning ?? '', card.personalMeaning ?? ''].join(' ').toLocaleLowerCase().includes(search));

  const count = collection === 'photos' ? visiblePhotos.length : visibleCards.length;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.brandMark}><Text style={styles.brandKanji}>幽</Text></View>
          <Text style={styles.heading}>Library</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Read a new photo"
            onPress={() => router.navigate({ pathname: '/(tabs)/capture', params: { fresh: String(Date.now()), captureId: undefined } })}
            style={({ pressed }) => [styles.captureButton, pressed && styles.pressed]}
          >
            <Text style={styles.captureButtonText}>＋ Read a photo</Text>
          </Pressable>
        </View>

        <View style={styles.collectionTabs}>{(['texts', 'vocabulary', 'photos'] as const).map((value) => (
          <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: collection === value }} onPress={() => setCollection(value)} style={[styles.collectionTab, collection === value && styles.collectionTabSelected]}>
            <Text style={[styles.collectionTabText, collection === value && styles.collectionTabActiveText]}>{value === 'texts' ? 'Saved texts' : value === 'vocabulary' ? 'Vocabulary' : 'Photos'}</Text>
          </Pressable>
        ))}</View>
        <TextInput accessibilityLabel={`Search ${collection}`} placeholder={collection === 'vocabulary' ? 'Search words, readings, meanings' : 'Search text'} value={query} onChangeText={setQuery} style={styles.search} />
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{collection === 'texts' ? 'Saved texts' : collection === 'vocabulary' ? 'My vocabulary' : 'Photo sources'}</Text>
          <Text style={styles.count}>{count.toString().padStart(2, '0')}</Text>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.green} style={styles.loader} />
        ) : error ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Library unavailable</Text>
            <Text style={styles.emptyCopy}>{error}</Text>
            <Pressable accessibilityRole="button" onPress={() => setLoadAttempt((value) => value + 1)} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry loading Library</Text>
            </Pressable>
          </View>
        ) : collection === 'photos' ? visiblePhotos.length ? (
          <View style={styles.captureList}>
            {visiblePhotos.map((capture) => {
              const sourceCards = cards.filter((card) => card.captureId === capture.id);
              const words = sourceCards.filter((card) => card.kind === 'word').length;
              return (
                <View key={capture.id} style={styles.savedCard}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open photo: ${photoSummary(capture, savedTexts, words)}`}
                    onPress={() => router.navigate({ pathname: '/(tabs)/capture', params: { captureId: capture.id, groupId: sourceCards.find((card) => card.groupId)?.groupId ?? undefined, fresh: undefined } })}
                    style={({ pressed }) => [styles.savedOpen, pressed && styles.pressed]}
                  >
                    <Image source={{ uri: capture.imageUri }} style={styles.thumbnail} />
                    <View style={styles.savedCopy}>
                      <Text style={styles.savedIndex}>{photoSummary(capture, savedTexts, words)}</Text>
                      <Text numberOfLines={2} style={styles.photoText}>{capture.correctedText || capture.rawText || 'Photo'}</Text>
                      <Text style={styles.savedDate}>{new Date(capture.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · Open photo and rows</Text>
                    </View>
                    <Text style={styles.savedArrow}>›</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No photos yet.</Text>
            <Text style={styles.emptyCopy}>Every photo you take or choose appears here, saved or not.</Text>
          </View>
        ) : visibleCards.length ? (
          <View style={styles.captureList}>
            {visibleCards.map((card, index) => {
              const capture = captures.find((item) => item.id === card.captureId);
              return (
              <View
                key={card.id}
                style={styles.savedCard}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Study ${card.kind} card ${card.kind === 'word' ? card.lemma : card.sourceText}`}
                  onPress={() => router.push({ pathname: '/card/[id]', params: { id: card.id, mode: 'dictionary' } })}
                  style={({ pressed }) => [styles.savedOpen, pressed && styles.pressed]}
                >
                  {capture && <Image source={{ uri: capture.imageUri }} style={styles.thumbnail} />}
                  <View style={styles.savedCopy}>
                    <Text style={styles.savedIndex}>{String(index + 1).padStart(2, '0')} · {card.kind === 'word' ? 'WORD' : 'TEXT'}</Text>
                    {collection === 'vocabulary' && <Text style={styles.vocabularyReading}>{card.reading}</Text>}
                    <Text numberOfLines={2} style={styles.savedText}>{card.kind === 'word' ? card.lemma : card.sourceText}</Text>
                    {collection === 'vocabulary' && card.personalMeaning && <Text style={styles.vocabularyMeaning}>Your meaning · {card.personalMeaning}</Text>}
                    {collection === 'vocabulary' && !card.personalMeaning && <Text style={styles.vocabularyMeaning}>{card.wordSnapshot?.dictionaryCandidates[0]?.meanings.join('; ') ?? card.wordSnapshot?.curatedMeaning ?? 'Meaning unavailable'}</Text>}
                    <Text style={styles.savedDate}>
                      {new Date(card.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      {' · '}{collection === 'vocabulary' ? 'Meaning, kanji, photo' : 'Readings, meanings, photo'}
                    </Text>
                  </View>
                  <Text style={styles.savedArrow}>›</Text>
                </Pressable>
              </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyIndex}>FIRST NOTE</Text>
            <Text style={styles.emptyTitle}>{collection === 'vocabulary' ? 'No words yet.' : 'No saved texts yet.'}</Text>
            <Text style={styles.emptyCopy}>Read a photo and tap Save row. The row appears in Saved texts; its words with a clear dictionary meaning appear in Vocabulary.</Text>
          </View>
        )}
        <Pressable accessibilityRole="button" onPress={() => router.push('/sources')} style={styles.sourcesLink}>
          <Text style={styles.sourcesText}>Sources &amp; licenses</Text>
          <Text style={styles.sourcesArrow}>↗</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Tabs size to their labels and wrap onto another row at large text sizes instead of overlapping.
  collectionTabs: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 24, gap: 4 },
  collectionTab: { flexGrow: 1, flexShrink: 0, minWidth: 44, minHeight: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.ink, borderRadius: 8 },
  collectionTabSelected: { backgroundColor: colors.ink },
  collectionTabText: { fontSize: 12, fontWeight: '700', color: colors.ink },
  collectionTabActiveText: { color: colors.white },
  search: { minHeight: 48, borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: 12, marginTop: 12, fontSize: 14, color: colors.ink },
  vocabularyReading: { fontSize: 14, lineHeight: 20, color: colors.ink, marginTop: 4 },
  vocabularyMeaning: { fontSize: 16, lineHeight: 24, color: colors.ink, marginTop: 4 },
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32, maxWidth: 720, width: '100%', alignSelf: 'center' },
  headerCopy: { flex: 1 },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 8, marginBottom: 24 },
  brandMark: { width: 48, height: 56, borderRadius: 8, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  brandKanji: { color: colors.white, fontSize: 32, fontWeight: '800' },
  eyebrow: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.7, marginBottom: 8 },
  // flexGrow (not flex: 1) keeps the title's natural width so the button wraps to its own line at large text sizes.
  heading: { flexGrow: 1, color: colors.ink, fontSize: 24, lineHeight: 30, fontWeight: '800', letterSpacing: -0.5 },
  captureButton: { minHeight: 44, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 8, backgroundColor: colors.ink },
  captureButtonText: { color: colors.white, fontSize: 14, fontWeight: '800' },
  photoText: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: '700', marginTop: 6 },
  captureCallout: { minHeight: 88, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.ink, borderRadius: 12, padding: 24 },
  captureCalloutCopy: { flex: 1 },
  calloutKicker: { color: '#E4E4E4', fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  calloutTitle: { color: colors.white, fontSize: 22, lineHeight: 28, fontWeight: '800', marginTop: 8 },
  calloutSubtitle: { color: '#EEEEEE', fontSize: 14, lineHeight: 21, marginTop: 8 },
  calloutArrow: { color: colors.white, fontSize: 32, paddingLeft: 16 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 32, marginBottom: 16 },
  sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  count: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  captureList: { gap: 16 },
  savedCard: { minHeight: 112, backgroundColor: colors.card, borderWidth: 2, borderColor: colors.ink, borderRadius: 12, padding: 16, gap: 8 },
  savedOpen: { flexDirection: 'row', alignItems: 'center', flex: 1, minHeight: 74, gap: 12 },
  thumbnail: { width: 68, height: 74, borderRadius: 9, backgroundColor: colors.greenWash },
  savedCopy: { flex: 1 },
  savedIndex: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  savedText: { color: colors.ink, fontSize: 22, lineHeight: 32, fontWeight: '700', marginTop: 8 },
  savedDate: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 8 },
  savedArrow: { color: colors.green, fontSize: 24, paddingHorizontal: 2 },
  deleteButton: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  deleteText: { color: colors.orange, fontSize: 12, fontWeight: '700' },
  emptyCard: { backgroundColor: colors.card, borderWidth: 2, borderColor: colors.ink, borderRadius: 12, padding: 24 },
  emptyIndex: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  emptyTitle: { color: colors.ink, fontSize: 20, lineHeight: 28, fontWeight: '800', marginTop: 16 },
  emptyCopy: { color: colors.muted, fontSize: 16, lineHeight: 24, marginTop: 8 },
  loader: { marginTop: 38 },
  retryButton: { minHeight: 44, justifyContent: 'center', marginTop: 8 },
  retryText: { color: colors.green, fontSize: 14, fontWeight: '700' },
  sourcesLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 25, paddingVertical: 10 },
  sourcesText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  sourcesArrow: { color: colors.orange, fontSize: 14 },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.55 },
});
