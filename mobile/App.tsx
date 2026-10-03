import { useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { analyzeJapaneseImage } from './src/capture/ocr';
import CameraCapture from './src/capture/CameraCapture';
import { markCaptureOcrFailed } from './src/capture/review';
import { saveCapture } from './src/capture/store';
import type { CaptureRecord, CaptureSource } from './src/capture/types';
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
  const [capture, setCapture] = useState<CaptureRecord | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingDraftSave = useRef<Promise<void>>(Promise.resolve());

  async function recognize(record: CaptureRecord) {
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
    const processing = { ...record, status: 'processing' as const };
    let latest: CaptureRecord = processing;
    setCapture(processing);
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await saveCapture(processing);
      const result = await analyzeJapaneseImage(processing.imageUri, processing.imageMetadata.width, processing.imageMetadata.height);
      latest = { ...processing, rawText: result.rawText, regions: result.regions, status: 'complete' };
      await saveCapture(latest);
      setNotice(result.regions.length ? 'Text is ready. Choose the line you want to keep.' : 'No text was found. Enter it manually.');
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
        rawText: '',
        regions: [],
        correctedText: '',
        selectedRegionId: null,
        status: 'selecting',
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
