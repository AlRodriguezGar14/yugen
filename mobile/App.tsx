import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { View } from 'react-native';
import { analyzeJapaneseImage } from './src/capture/ocr';
import CameraCapture from './src/capture/CameraCapture';
import { markCaptureOcrFailed, mergePersistedAnalysis, rowGroupsForCapture, savedTextNotice, selectRecognizedFindings, textGroupsForCapture, unsavedRows } from './src/capture/review';
import { isCaptureDeleted, loadCaptureById, saveCapture, saveTextGroup, addWordCard, loadTextGroups, type WordSaveOutcome } from './src/capture/store';
import type { CaptureRecord, CaptureSource, TextGroup } from './src/capture/types';
import CaptureHome from './src/capture/CaptureHome';
import CaptureReview from './src/capture/CaptureReview';
import { styles } from './src/capture/uiStyles';
import { tabBarStyle } from './src/theme';
import { afterCommit } from './src/capture/studyChanges';

function imageExtension(asset: ImagePicker.ImagePickerAsset): string {
  const name = asset.fileName ?? asset.uri.split(/[?#]/)[0];
  return name?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'jpg';
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export default function App() {
  const params = useLocalSearchParams<{ captureId?: string; groupId?: string; fresh?: string }>();
  const resumeId = Array.isArray(params.captureId) ? params.captureId[0] : params.captureId;
  const [capture, setCapture] = useState<CaptureRecord | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeOcrId = useRef<string | null>(null);
  const [ocrSettled, setOcrSettled] = useState(0);
  const currentCapture = useRef(capture);
  currentCapture.current = capture;
  const pendingDraftSave = useRef<Promise<void>>(Promise.resolve());
  const captureId = capture?.id;
  const navigation = useNavigation();
  const bottomInset = useSafeAreaInsets().bottom;
  const [navHidden, setNavHidden] = useState(false);
  const hideNav = navHidden && !!captureId && !showCamera;

  useEffect(() => {
    navigation.setOptions({ tabBarStyle: hideNav ? { display: 'none' } : tabBarStyle(bottomInset) });
  }, [navigation, hideNav, bottomInset]);

  useFocusEffect(useCallback(() => {
    if (!captureId || !isCaptureDeleted(captureId)) return undefined;
    setCapture(null);
    setBusy(false);
    setNotice(null);
    setError('This capture was deleted from OCR Review. Start a new capture to continue.');
    return undefined;
  }, [captureId]));

  useEffect(() => {
    if (!resumeId || currentCapture.current?.id === resumeId || activeOcrId.current) return;
    let active = true;
    setBusy(true);
    Promise.resolve().then(async () => {
      await finishDraftSave();
      const previous = currentCapture.current;
      if (previous) await saveCapture(mergePersistedAnalysis(previous, await loadCaptureById(previous.id)));
      return loadCaptureById(resumeId);
    })
      .then(async (storedRecord) => {
        if (!active) return;
        const record = storedRecord?.status === 'processing' && activeOcrId.current !== storedRecord.id
          ? markCaptureOcrFailed(storedRecord)
          : storedRecord;
        if (record && record !== storedRecord) {
          try {
            await saveCapture(record);
          } catch {
            // The image and selected area remain available in memory for retry.
          }
        }
        if (!active) return;
        setCapture(record);
        setError(record?.status === 'failed'
          ? 'OCR could not read this image. The original is still safe; retry or enter the text manually.'
          : record ? null : 'This capture could not be found. The original may have been removed from this device.');
        setNotice(record?.status === 'selecting'
          ? 'Reading your restored photo…'
          : record ? 'Original capture restored. Retry OCR or continue editing the text.' : null);
        if (record?.status === 'selecting' && !record.correctedText.trim()) await recognize(record);
      })
      .catch(() => {
        if (active) {
          router.setParams({ captureId: currentCapture.current?.id });
          setError('The capture could not be switched. Your current edits are still shown; open the other capture again to retry.');
        }
      })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [resumeId, ocrSettled]);

  useEffect(() => {
    if (!params.fresh || activeOcrId.current) return;
    void startNewCapture();
  }, [params.fresh, ocrSettled]);

  async function finishDraftSave() {
    try {
      await pendingDraftSave.current;
    } catch (error) {
      if (!currentCapture.current) throw error;
      await saveCapture(currentCapture.current);
      pendingDraftSave.current = Promise.resolve();
    }
  }

  async function recognize(record: CaptureRecord, ocrBounds = record.ocrBounds) {
    if (activeOcrId.current) return;
    if (record.status === 'failed' && record.rawText) {
      setBusy(true);
      try {
        const recovered = { ...record, status: 'complete' as const };
        await finishDraftSave();
        await saveCapture(recovered);
        setCapture(isCaptureDeleted(recovered.id) ? null : recovered);
        setError(null);
        setNotice('OCR result saved. Continue reviewing your text.');
      } catch {
        setError('The OCR result could not be saved. Keep this screen open and retry.');
      } finally {
        setBusy(false);
      }
      return;
    }
    const processing = { ...record, ocrBounds: ocrBounds ?? { x: 0, y: 0, width: 1, height: 1 }, status: 'processing' as const };
    let latest: CaptureRecord = processing;
    activeOcrId.current = record.id;
    setCapture(processing);
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await finishDraftSave();
      await saveCapture(processing);
      const result = await analyzeJapaneseImage(
        processing.imageUri,
        processing.imageMetadata.width,
        processing.imageMetadata.height,
        processing.ocrBounds,
      );
      latest = selectRecognizedFindings({ ...processing, rawText: result.rawText, regions: result.regions, status: 'complete',
        imageMetadata: { ...processing.imageMetadata, displayWidth: result.imageDimensions.width, displayHeight: result.imageDimensions.height },
      });
      await saveCapture(latest);
      setNotice(result.regions.length ? 'Text is ready. Save the rows you want to keep.' : 'No text was found. Enter it manually.');
    } catch (cause) {
      // Native OCR reasons (size limits, missing model) appear in device logs for diagnosis.
      console.warn('Yugen OCR failed', cause);
      const failed = markCaptureOcrFailed(latest);
      latest = failed;
      try {
        await saveCapture(failed);
      } catch {
        // The image remains in app-private storage if saving the OCR result fails.
      }
      setError(
        latest.rawText
          ? 'OCR ran, but its result could not be saved. The image is safe; retry to save it.'
          : 'OCR could not read this image. Your original is safe; retry or enter the text manually.',
      );
    } finally {
      activeOcrId.current = null;
      setCapture(isCaptureDeleted(latest.id) ? null : latest);
      setBusy(false);
      setOcrSettled((value) => value + 1);
    }
  }

  async function chooseImage(source: CaptureSource) {
    if (source === 'camera') {
      setShowCamera(true);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsEditing: false, quality: 1, exif: false,
      });
      if (!result.canceled) await importImageAsset(result.assets[0], source);
    } catch {
      setError('The photo could not be opened. Choose another image and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function importImageAsset(asset: ImagePicker.ImagePickerAsset, source: CaptureSource) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const id = newId();
      const directory = new Directory(Paths.document, 'captures');
      directory.create({ idempotent: true, intermediates: true });
      const storedFile = new File(directory, `${id}.${imageExtension(asset)}`);
      await new File(asset.uri).copy(storedFile);

      const record: CaptureRecord = {
        id,
        createdAt: new Date().toISOString(),
        language: 'ja',
        source,
        imageUri: storedFile.uri,
        imageMetadata: {
          assetId: asset.assetId ?? null,
          fileName: asset.fileName ?? null,
          fileSize: asset.fileSize ?? null,
          mimeType: asset.mimeType ?? null,
          width: asset.width,
          height: asset.height,
        },
        ocrBounds: null,
        rawText: '',
        regions: [],
        correctedText: '',
        selectedRegionId: null,
        joinedWithoutBreaks: false,
        status: 'selecting',
        savedAt: null,
        sentenceTranslation: null,
        analysis: null,
        analysisReview: {},
      };
      setCapture(record);
      await saveCapture(record);
      setShowCamera(false);
      await recognize(record);
    } catch (error) {
      setError('The capture could not be saved. Your original photo is unchanged; try again.');
      if (source === 'camera') throw error;
    } finally {
      setBusy(false);
    }
  }

  async function saveSelection(reviewedCapture?: CaptureRecord, group?: TextGroup) {
    if (!capture) return;
    const source = reviewedCapture ?? capture;
    // A row is validated by its own text; the capture-wide selection may be empty (unchecked legacy lines).
    if (!(group?.text ?? source.correctedText).trim()) {
      setError('Select a finding or enter some text before saving.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await finishDraftSave();
      const persisted = await loadCaptureById(source.id);
      if (!persisted || isCaptureDeleted(source.id)) {
        setCapture(null);
        setNotice(null);
        setError('This capture was deleted from OCR Review. Start a new capture to continue.');
        return;
      }
      if (group) {
        const words = await afterCommit(saveTextGroup(source, group));
        setCapture(isCaptureDeleted(source.id) ? null : source);
        const remaining = unsavedRows(source, new Map((await loadTextGroups(source.id)).map((item) => [item.id, item.text]))).length;
        setNotice(savedTextNotice(words, remaining));
        return;
      }
      const latest = mergePersistedAnalysis(source, persisted);
      // Explicit preview choices take precedence over choices recovered from sentence detail.
      for (const [index, review] of Object.entries(source.analysisReview)) {
        if (review !== capture.analysisReview[index]) latest.analysisReview = { ...latest.analysisReview, [index]: review };
      }
      const saved = { ...latest, savedAt: latest.savedAt ?? new Date().toISOString() };
      await saveCapture(saved);
      setCapture(saved);
      setNotice('Saved card on this device.');
      router.push({ pathname: '/sentence/[id]', params: { id: saved.id } });
    } catch {
      setError('The correction could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveVocabularyWord(source: CaptureRecord, group: TextGroup, index: number, reading: string): Promise<WordSaveOutcome> {
    setBusy(true);
    try {
      await finishDraftSave();
      const latest = currentCapture.current;
      if (!latest || latest.id !== source.id || ![...rowGroupsForCapture(latest), ...textGroupsForCapture(latest)].some((item) => item.id === group.id && item.text === group.text)) return null;
      // The word and its parent row are saved in one transaction.
      return await afterCommit(addWordCard(latest, index, reading, group));
    } finally { setBusy(false); }
  }

  async function startNewCapture() {
    if (activeOcrId.current) return;
    const previous = currentCapture.current;
    setBusy(true);
    if (previous) {
      try {
        await finishDraftSave();
        const latest = mergePersistedAnalysis(previous, await loadCaptureById(previous.id));
        await saveCapture(latest);
      } catch {
        setBusy(false);
        setError('The current capture could not be saved. Keep this screen open and retry.');
        return;
      }
    }
    setCapture(null);
    setError(null);
    setNotice(null);
    setBusy(false);
    router.setParams({ captureId: undefined, fresh: undefined });
  }

  if (showCamera) return <CameraCapture onPhoto={(asset) => importImageAsset(asset, 'camera')} onClose={() => setShowCamera(false)} />;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <StatusBar style="dark" />
      {capture ? (
        <CaptureReview
          initialGroupId={Array.isArray(params.groupId) ? params.groupId[0] : params.groupId}
          key={`${capture.id}:${params.groupId ?? ''}`}
          capture={capture}
          busy={busy}
          error={error}
          notice={notice}
          onChange={setCapture}
          onClearNotice={() => setNotice(null)}
          onNewCapture={() => void startNewCapture()}
          onRetry={() => void recognize(capture)}
          onPersistOcrArea={(record) => {
            const write = pendingDraftSave.current.catch(() => undefined).then(async () => {
              const latest = mergePersistedAnalysis(record, await loadCaptureById(record.id));
              latest.sentenceTranslation = record.sentenceTranslation ?? latest.sentenceTranslation;
              await saveCapture(latest);
            });
            pendingDraftSave.current = write;
            void write.catch(() => setError('The draft could not be saved. The original photo is still safe; keep this screen open and retry saving.'));
          }}
          onSave={(reviewedCapture, group) => void saveSelection(reviewedCapture, group)}
          onSaveWord={saveVocabularyWord}
          navHidden={navHidden}
          onToggleNav={() => setNavHidden((hidden) => !hidden)}
        />
      ) : (
        <CaptureHome
          busy={busy}
          error={error}
          notice={notice}
          onChoose={(source) => void chooseImage(source)}
        />
      )}
    </SafeAreaView>
  );
}
