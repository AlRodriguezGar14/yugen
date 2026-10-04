import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { analyzeJapaneseImage } from './src/capture/ocr';
import CameraCapture from './src/capture/CameraCapture';
import { markCaptureOcrFailed, rowGroupsForCapture, savedTextNotice, selectRecognizedFindings, textGroupsForCapture, unsavedRows } from './src/capture/review';
import { loadCaptureById, saveCapture, saveTextGroup, addWordCard, loadTextGroups } from './src/capture/store';
import type { CaptureRecord, CaptureSource, TextGroup } from './src/capture/types';
import CaptureHome from './src/capture/CaptureHome';
import CaptureReview from './src/capture/CaptureReview';
import { styles } from './src/capture/uiStyles';

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
  const currentCapture = useRef(capture);
  currentCapture.current = capture;
  const pendingDraftSave = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!resumeId) return;
    let active = true;
    loadCaptureById(resumeId).then((record) => { if (active) setCapture(record); }).catch(() => { if (active) setError('This photo could not be opened.'); });
    return () => { active = false; };
  }, [resumeId]);
  useEffect(() => { if (params.fresh) void Promise.resolve().then(() => { setCapture(null); router.setParams({ fresh: undefined, captureId: undefined, groupId: undefined }); }); }, [params.fresh]);

  async function recognize(record: CaptureRecord, ocrBounds = record.ocrBounds) {
    if (record.status === 'failed' && record.rawText) {
      setBusy(true);
      try {
        const recovered = { ...record, status: 'complete' as const };
        await saveCapture(recovered);
        setCapture(recovered);
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
    setCapture(processing);
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
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
      setNotice(result.regions.length ? 'Text is ready. Every recognized line is kept; uncheck or brush away what you do not need.' : 'No text was found. Enter it manually.');
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
      setCapture(latest);
      setBusy(false);
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

  async function saveSelection(source: CaptureRecord, group: TextGroup) {
    // A row is validated by its own text; the capture-wide selection may be empty.
    if (!group.text.trim()) {
      setError('Select a finding or enter some text before saving.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const words = await saveTextGroup(source, group);
      setCapture(source);
      const remaining = unsavedRows(source, new Map((await loadTextGroups(source.id)).map((item) => [item.id, item.text]))).length;
      setNotice(savedTextNotice(words, remaining));
    } catch {
      setError('The correction could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveVocabularyWord(source: CaptureRecord, group: TextGroup, index: number, reading: string | null) {
    if (!reading) {
      setError('This word has no dictionary reading to save.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The tap may be older than the screen: the word only saves if its row still has the same text in the
      // current capture, and it is saved with that current capture so no newer correction is overwritten.
      const latest = currentCapture.current;
      if (!latest || latest.id !== source.id || ![...rowGroupsForCapture(latest), ...textGroupsForCapture(latest)].some((item) => item.id === group.id && item.text === group.text)) {
        setError('Not saved: this text changed while saving. Check it and try again.');
        return;
      }
      // The word and its parent row are saved in one transaction.
      const outcome = await addWordCard(latest, index, reading, group);
      if (outcome === 'added') setNotice('Saved in Vocabulary.');
      else if (outcome === 'existing') setNotice('Already in your Vocabulary.');
      else setError('Not saved: this word needs a chosen reading and meaning. Choose one above and try again.');
    } catch {
      setError('The word could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function startNewCapture() {
    setCapture(null);
    setError(null);
    setNotice(null);
  }

  if (showCamera) return <CameraCapture onPhoto={(asset) => importImageAsset(asset, 'camera')} onClose={() => setShowCamera(false)} />;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <StatusBar style="dark" />
      {capture ? (
        <CaptureReview
          key={capture.id}
          capture={capture}
          busy={busy}
          error={error}
          notice={notice}
          onChange={(record) => {
            setCapture(record);
            setNotice(null);
            // Draft corrections are written in order; raw OCR and the photo are never rewritten by them.
            const write = pendingDraftSave.current.catch(() => undefined).then(() => saveCapture(record));
            pendingDraftSave.current = write;
            void write.catch(() => setError('The draft could not be saved. The original photo is still safe; keep this screen open and retry saving.'));
          }}
          onNewCapture={startNewCapture}
          onRetry={() => void recognize(capture)}
          onSave={(reviewedCapture, group) => void saveSelection(reviewedCapture, group)}
          onSaveWord={(source, group, index, reading) => void saveVocabularyWord(source, group, index, reading)}
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
