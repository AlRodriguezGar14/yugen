import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityIndicator, Alert, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { deleteCapture, deleteTextGroup } from '../../capture/store';
import { loadLibraryPage, type LibraryCollection, type LibraryCursor, type LibraryEntry, type LibraryItem, type LibraryPhoto } from '../../capture/libraryQueries';
import { confirmEntryDeletion } from '../../capture/entryActions';
import StatusMessage from '../../capture/StatusMessage';
import { afterCommit, onStudyChange } from '../../capture/studyChanges';
import { colors } from '../../theme';

export default function LibraryScreen() {
  const [collection, setCollection] = useState<LibraryCollection>('texts');
  const [query, setQuery] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const search = query.trim();
  const scope = `${collection}\n${search}\n${loadAttempt}`;
  const [loadedScope, setLoadedScope] = useState('');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<LibraryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const paging = useRef(false);
  const focused = useRef(false);
  const list = useRef<FlatList<LibraryItem>>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  function remove(id: string, action: () => Promise<unknown>, done: string, failed: string) {
    if (deletingId) return;
    loadGeneration.current += 1;
    setDeletingId(id);
    setStatus({ text: 'Deleting…', error: false });
    afterCommit(action())
      .then(() => setStatus({ text: done, error: false }))
      .catch(() => setStatus({ text: failed, error: true }))
      .finally(() => { setDeletingId(null); setLoadAttempt((value) => value + 1); });
  }

  function confirmDelete(photo: LibraryPhoto) {
    Alert.alert('Delete photo and its cards?', 'This removes the original photo, its OCR text, and every saved text, word and practice card from this photo on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete photo', style: 'destructive', onPress: () => remove(photo.id, () => deleteCapture(photo.id), 'Photo and its cards deleted.', 'The photo could not be deleted. It is still in your Library; try again.') },
    ]);
  }

  function confirmDeleteText(card: LibraryEntry) {
    confirmEntryDeletion('sentence', !!card.hasPractice, (options) => remove(card.id, () => deleteTextGroup(card.groupId!, options),
      options.keepPracticeCards ? 'Text deleted. Its practice card, words and photo remain.' : 'Text deleted. Its words and photo remain.', 'The text could not be deleted. Try again.'));
  }

  useEffect(() => onStudyChange((change) => {
    if (change === 'capture' && collection !== 'photos') return;
    loadGeneration.current += 1;
    setLoadAttempt((value) => value + 1);
  }, 'all'), [collection]);

  useFocusEffect(useCallback(() => {
    const generation = ++loadGeneration.current;
    focused.current = true;
    paging.current = false;
    setLoading(true);
    setLoadingMore(false);
    setPageError(null);
    setCursor(null);
    setItems([]);
    setTotal(0);
    list.current?.scrollToOffset({ offset: 0, animated: false });
    loadLibraryPage(collection, search)
      .then((page) => {
        if (generation !== loadGeneration.current) return;
        setItems(page.items);
        setTotal(page.total);
        setCursor(page.nextCursor);
        setLoadedScope(scope);
        setError(null);
      })
      .catch(() => { if (generation === loadGeneration.current) setError('Your Library could not be opened. Try again.'); })
      .finally(() => { if (generation === loadGeneration.current) setLoading(false); });
    return () => { focused.current = false; loadGeneration.current += 1; };
  }, [collection, search, scope]));

  async function loadMore() {
    if (!focused.current || loading || paging.current || deletingId || !cursor || loadedScope !== scope) return;
    const generation = loadGeneration.current;
    paging.current = true;
    setLoadingMore(true);
    setPageError(null);
    try {
      const page = await loadLibraryPage(collection, search, cursor);
      if (generation !== loadGeneration.current) return;
      setItems((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !ids.has(item.id))];
      });
      setTotal(page.total);
      setCursor(page.nextCursor);
    } catch {
      if (generation === loadGeneration.current) setPageError('More results could not be opened. Try again.');
    } finally {
      if (generation === loadGeneration.current) { paging.current = false; setLoadingMore(false); }
    }
  }

  function renderItem({ item, index }: { item: LibraryItem; index: number }) {
    if (item.collection === 'practice') return (
      <Pressable accessibilityRole="button" accessibilityLabel={`Practice ${item.prompt ?? 'card'}`}
        onPress={() => router.push({ pathname: '/practice/[id]', params: { id: item.id } })} style={({ pressed }) => [styles.savedCard, pressed && styles.pressed]}>
        <Text style={styles.savedIndex}>{item.kind === 'word' ? 'WORD' : 'TEXT'} · PRACTICE{item.entryId ? '' : ' · INDEPENDENT'}</Text>
        <Text numberOfLines={2} style={styles.savedText}>{item.prompt ?? 'Answer unavailable'}</Text>
        <Text style={styles.savedDate}>Recall it, then reveal the answer</Text>
      </Pressable>
    );
    if (item.collection === 'photos') return (
      <View style={styles.savedCard}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open photo: ${item.summary}`}
          onPress={() => router.navigate({ pathname: '/(tabs)/capture', params: { captureId: item.id, groupId: item.groupId ?? undefined, fresh: undefined } })}
          style={({ pressed }) => [styles.savedOpen, pressed && styles.pressed]}>
          <Image source={{ uri: item.imageUri }} style={styles.thumbnail} />
          <View style={styles.savedCopy}>
            <Text style={styles.savedIndex}>{item.summary}</Text>
            <Text numberOfLines={2} style={styles.photoText}>{item.text}</Text>
            <Text style={styles.savedDate}>{new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · Open photo and rows</Text>
          </View>
          <Text style={styles.savedArrow}>›</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Delete this photo and its saved texts and words"
          accessibilityState={{ disabled: !!deletingId, busy: deletingId === item.id }} disabled={!!deletingId}
          onPress={() => confirmDelete(item)} style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed, !!deletingId && styles.disabled]}>
          <Text style={styles.deleteText}>{deletingId === item.id ? 'Deleting…' : 'Delete photo & its cards'}</Text>
        </Pressable>
      </View>
    );
    return (
      <View style={styles.savedCard}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Study ${item.collection === 'vocabulary' ? 'word' : 'sentence'} card ${item.collection === 'vocabulary' ? item.lemma : item.sourceText}`}
          onPress={() => router.push({ pathname: '/card/[id]', params: { id: item.id, mode: 'dictionary' } })} style={({ pressed }) => [styles.savedOpen, pressed && styles.pressed]}>
          {item.imageUri && <Image source={{ uri: item.imageUri }} style={styles.thumbnail} />}
          <View style={styles.savedCopy}>
            <Text style={styles.savedIndex}>{String(index + 1).padStart(2, '0')} · {item.collection === 'vocabulary' ? 'WORD' : 'TEXT'}</Text>
            {item.collection === 'vocabulary' && <Text style={styles.vocabularyReading}>{item.reading}</Text>}
            <Text numberOfLines={2} style={styles.savedText}>{item.collection === 'vocabulary' ? item.lemma : item.sourceText}</Text>
            {item.collection === 'vocabulary' && <Text style={styles.vocabularyMeaning}>{item.personalMeaning ? `Your meaning · ${item.personalMeaning}` : item.meaning}</Text>}
            <Text style={styles.savedDate}>{new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              {' · '}{item.collection === 'vocabulary' ? 'Meaning, kanji, photo, practice' : 'Readings, meanings, photo, practice'}</Text>
          </View>
          <Text style={styles.savedArrow}>›</Text>
        </Pressable>
        {item.collection === 'texts' && item.groupId && <Pressable accessibilityRole="button" accessibilityLabel={`Delete text ${item.sourceText}`}
          accessibilityState={{ disabled: !!deletingId, busy: deletingId === item.id }} disabled={!!deletingId} onPress={() => confirmDeleteText(item)} style={[styles.deleteButton, !!deletingId && styles.disabled]}>
          <Text style={styles.deleteText}>{deletingId === item.id ? 'Deleting…' : 'Delete text'}</Text>
        </Pressable>}
      </View>
    );
  }

  const empty = loading || loadedScope !== scope && !error ? <ActivityIndicator color={colors.green} style={styles.loader} /> : error ? (
    <View style={styles.emptyCard}>
      <Text style={styles.emptyTitle}>Library unavailable</Text><Text style={styles.emptyCopy}>{error}</Text>
      <Pressable accessibilityRole="button" onPress={() => setLoadAttempt((value) => value + 1)} style={styles.retryButton}><Text style={styles.retryText}>Retry loading Library</Text></Pressable>
    </View>
  ) : (
    <View style={styles.emptyCard}>
      <Text style={styles.emptyTitle}>{collection === 'practice' ? 'No practice cards yet.' : collection === 'photos' ? 'No photos yet.' : collection === 'vocabulary' ? 'No words yet.' : 'No saved texts yet.'}</Text>
      <Text style={styles.emptyCopy}>{collection === 'practice' ? 'Open a saved text or word and tap Create practice card. Entries never become cards automatically.' : collection === 'photos' ? 'Every photo you take or choose appears here, saved or not.' : 'Read a photo and tap Save row. The row appears in Saved texts; its words with a clear dictionary meaning appear in Vocabulary.'}</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <FlatList ref={list} data={loading || error || loadedScope !== scope ? [] : items} renderItem={renderItem} keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" onEndReached={() => { if (!pageError) void loadMore(); }} onEndReachedThreshold={0.5}
        ItemSeparatorComponent={() => <View style={{ height: 16 }} />} ListEmptyComponent={empty}
        ListHeaderComponent={<View>
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

        <View style={styles.collectionTabs}>{(['texts', 'vocabulary', 'practice', 'photos'] as const).map((value) => (
          <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: collection === value }} onPress={() => setCollection(value)} style={[styles.collectionTab, collection === value && styles.collectionTabSelected]}>
            <Text style={[styles.collectionTabText, collection === value && styles.collectionTabActiveText]}>{value === 'texts' ? 'Saved texts' : value === 'vocabulary' ? 'Vocabulary' : value === 'practice' ? 'Practice' : 'Photos'}</Text>
          </Pressable>
        ))}</View>
        <TextInput accessibilityLabel={`Search ${collection}`} placeholder={collection === 'vocabulary' ? 'Search words, readings, meanings' : 'Search text'} value={query} onChangeText={setQuery} style={styles.search} />
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{collection === 'texts' ? 'Saved texts' : collection === 'vocabulary' ? 'My vocabulary' : collection === 'practice' ? 'Practice cards' : 'Photo sources'}</Text>
          <Text style={styles.count}>{(loadedScope === scope ? total : 0).toString().padStart(2, '0')}</Text>
        </View>
        <StatusMessage text={status?.text ?? null} error={status?.error} />

        </View>}
        ListFooterComponent={<View>
          {loadingMore && <ActivityIndicator accessibilityLabel="Loading more results" color={colors.green} />}
          {pageError && <Pressable accessibilityRole="button" onPress={() => void loadMore()} style={styles.retryButton}><Text style={styles.retryText}>{pageError}</Text></Pressable>}
          <Pressable accessibilityRole="button" onPress={() => router.push('/sources')} style={styles.sourcesLink}>
            <Text style={styles.sourcesText}>Sources &amp; licenses</Text><Text style={styles.sourcesArrow}>↗</Text>
          </Pressable>
        </View>} />
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
