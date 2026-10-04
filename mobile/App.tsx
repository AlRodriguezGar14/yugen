import { useCallback, useEffect, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { analyzeJapaneseImage } from '@/capture/ocr';
import CameraCapture from '@/capture/CameraCapture';
import { markCaptureOcrFailed, rowGroupsForCapture, savedTextNotice, selectRecognizedFindings, textGroupsForCapture, unsavedRows } from '@/capture/review';
import { isCaptureDeleted, loadCaptureById, saveAnalysisReviewForText, saveTextGroup, addWordCard, loadTextGroups, type WordSaveOutcome } from '@/capture/store';
import type { CaptureRecord, CaptureSource, TextGroup } from '@/capture/types';
import CaptureHome from '@/capture/CaptureHome';
import CaptureReview from '@/capture/CaptureReview';
import { styles } from '@/capture/uiStyles';
import { tabBarStyle } from '@/theme';
import { afterCommit } from '@/capture/studyChanges';
import { useCaptureSession, type OperationContext } from '@/capture/useCaptureSession';

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
  const { capture, busy, error, notice, settled, currentCapture, activeOperation, run, updateDraft, flushDraft, clearNotice, clearDeletedCapture } = useCaptureSession();
  const [showCamera, setShowCamera] = useState(false);
  const [navHidden, setNavHidden] = useState(false);
  const navigation = useNavigation();
  const bottomInset = useSafeAreaInsets().bottom;
  const hideNav = navHidden && !!capture && !showCamera;

  useEffect(() => {
    navigation.setOptions({ tabBarStyle: hideNav ? { display: 'none' } : tabBarStyle(bottomInset) });
  }, [navigation, hideNav, bottomInset]);

  useFocusEffect(useCallback(() => { clearDeletedCapture(); }, [clearDeletedCapture, capture?.id]));

  // Imports and resume run OCR inside their existing job, avoiding nested operations.
  const recognizeRecord = useCallback(async (record: CaptureRecord, context: OperationContext) => {
    context.error(null);
    context.notice(null);
    if (record.status === 'failed' && record.rawText) {
      try {
        await flushDraft();
        const recovered = { ...record, status: 'complete' as const };
        await context.persist(recovered);
        context.show(recovered);
        context.notice('OCR result saved. Continue reviewing your text.');
      } catch { context.error('The OCR result could not be saved. Keep this screen open and retry.'); }
      return;
    }
    const processing = { ...record, ocrBounds: record.ocrBounds ?? { x: 0, y: 0, width: 1, height: 1 }, status: 'processing' as const };
    let latest: CaptureRecord = processing;
    context.show(processing);
    try {
      await flushDraft();
      await context.persist(processing);
      const result = await analyzeJapaneseImage(processing.imageUri, processing.imageMetadata.width,
        processing.imageMetadata.height, processing.ocrBounds);
      latest = selectRecognizedFindings({ ...processing, rawText: result.rawText, regions: result.regions, status: 'complete',
        imageMetadata: { ...processing.imageMetadata, displayWidth: result.imageDimensions.width, displayHeight: result.imageDimensions.height },
      });
      await context.persist(latest);
      context.notice(result.regions.length ? 'Text is ready. Save the rows you want to keep.' : 'No text was found. Enter it manually.');
    } catch (cause) {
      console.warn('Yugen OCR failed', cause);
      latest = markCaptureOcrFailed(latest);
      try { await context.persist(latest); } catch {
        // Preserve the private image and raw OCR for persistence retry.
      }
      context.error(latest.rawText
        ? 'OCR ran, but its result could not be saved. The image is safe; retry to save it.'
        : 'OCR could not read this image. Your original is safe; retry or enter the text manually.');
    } finally { context.show(latest); }
  }, [flushDraft]);

  const startNewCapture = useCallback(async () => {
    await run('new', async (context) => {
      try {
        await flushDraft();
        context.show(null);
        context.error(null);
        context.notice(null);
        setShowCamera(false);
        router.setParams({ captureId: undefined, fresh: undefined });
      } catch {
        context.error('The current capture could not be saved. Keep this screen open and retry.');
        // Consume the failed request instead of immediately retrying on settlement.
        router.setParams({ fresh: undefined });
      }
    });
  }, [run, flushDraft]);

  useEffect(() => {
    if (!resumeId || params.fresh || currentCapture.current?.id === resumeId || activeOperation.current) return;
    let active = true;
    void run('resume', async (context) => {
      try {
        await flushDraft();
        const stored = await loadCaptureById(resumeId);
        const record = stored?.status === 'processing' ? markCaptureOcrFailed(stored) : stored;
        if (record && record !== stored) {
          try { await context.persist(record); } catch {
            // Preserve the restored image and draft so OCR can be retried.
          }
        }
        if (!active) return;
        setShowCamera(false);
        context.show(record);
        context.error(record?.status === 'failed'
          ? 'OCR could not read this image. The original is still safe; retry or enter the text manually.'
          : record ? null : 'This capture could not be found. The original may have been removed from this device.');
        context.notice(record?.status === 'selecting' ? 'Reading your restored photo…'
          : record ? 'Original capture restored. Retry OCR or continue editing the text.' : null);
        if (!record) router.setParams({ captureId: undefined });
        if (record?.status === 'selecting' && !record.correctedText.trim()) await recognizeRecord(record, context);
      } catch {
        if (!active) return;
        router.setParams({ captureId: currentCapture.current?.id });
        context.error('The capture could not be switched. Your current edits are still shown; open the other capture again to retry.');
      }
    });
    return () => { active = false; };
  }, [resumeId, params.fresh, settled, currentCapture, activeOperation, run, flushDraft, recognizeRecord]);

  useEffect(() => {
    if (params.fresh && !activeOperation.current) void startNewCapture();
  }, [params.fresh, settled, activeOperation, startNewCapture]);

  async function importAsset(asset: ImagePicker.ImagePickerAsset, source: CaptureSource, context: OperationContext) {
    const id = newId();
    const directory = new Directory(Paths.document, 'captures');
    directory.create({ idempotent: true, intermediates: true });
    const storedFile = new File(directory, `${id}.${imageExtension(asset)}`);
    await new File(asset.uri).copy(storedFile);
    const record: CaptureRecord = {
      id, createdAt: new Date().toISOString(), language: 'ja', source, imageUri: storedFile.uri,
      imageMetadata: { assetId: asset.assetId ?? null, fileName: asset.fileName ?? null,
        fileSize: asset.fileSize ?? null, mimeType: asset.mimeType ?? null, width: asset.width, height: asset.height },
      ocrBounds: null, rawText: '', regions: [], correctedText: '', selectedRegionId: null,
      joinedWithoutBreaks: false, status: 'selecting', savedAt: null, sentenceTranslation: null,
      analysis: null, analysisReview: {},
    };
    context.show(record);
    await context.persist(record);
    setShowCamera(false);
    await recognizeRecord(record, context);
  }

  async function chooseImage(source: CaptureSource) {
    if (source === 'camera') { if (!activeOperation.current) setShowCamera(true); return; }
    await run('import', async (context) => {
      context.error(null);
      context.notice(null);
      try {
        await flushDraft();
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1, exif: false });
        if (!result.canceled) await importAsset(result.assets[0], source, context);
      } catch { context.error('The photo could not be opened or saved. Choose another image and try again.'); }
    });
  }

  async function importCameraPhoto(takePhoto: () => Promise<ImagePicker.ImagePickerAsset>) {
    await run('import', async (context) => {
      context.error(null);
      context.notice(null);
      try { await flushDraft(); await importAsset(await takePhoto(), 'camera', context); }
      catch (cause) {
        context.error('The capture could not be saved. Your original photo is unchanged; try again.');
        throw cause;
      }
    });
  }

  async function saveSelection(reviewedCapture?: CaptureRecord, group?: TextGroup) {
    await run('save', async (context) => {
      const source = reviewedCapture ?? currentCapture.current;
      if (!source || source.id !== currentCapture.current?.id) return;
      if (!(group?.text ?? source.correctedText).trim()) {
        context.error('Select a finding or enter some text before saving.');
        return;
      }
      context.error(null);
      try {
        await flushDraft();
        const persisted = await loadCaptureById(source.id);
        if (!persisted || isCaptureDeleted(source.id)) {
          context.show(null);
          context.notice(null);
          context.error('This capture was deleted from OCR Review. Start a new capture to continue.');
          return;
        }
        if (group) {
          const current = currentCapture.current;
          if (!current || current.id !== source.id || ![...rowGroupsForCapture(current), ...textGroupsForCapture(current)]
            .some((item) => item.id === group.id && item.text === group.text)) {
            context.error('This row changed before it could be saved. Review its current text and try again.');
            return;
          }
          const words = await afterCommit(saveTextGroup(current, group));
          const remaining = unsavedRows(current, new Map((await loadTextGroups(current.id)).map((item) => [item.id, item.text]))).length;
          context.notice(savedTextNotice(words, remaining));
        } else {
          let analysisReview = persisted.analysisReview;
          if (source.correctedText === persisted.correctedText && source.analysis?.normalizedText === persisted.correctedText) {
            // Preserve detail-screen choices except those explicitly changed by this preview.
            for (const [index, review] of Object.entries(source.analysisReview)) {
              if (review !== currentCapture.current?.analysisReview[index]) analysisReview = { ...analysisReview, [index]: review };
            }
            if (analysisReview !== persisted.analysisReview) await saveAnalysisReviewForText(persisted.id, persisted.correctedText, analysisReview);
          }
          const saved = { ...persisted, analysisReview, savedAt: persisted.savedAt ?? new Date().toISOString() };
          await context.persist(saved);
          context.show(saved);
          context.notice('Saved card on this device.');
          router.push({ pathname: '/sentence/[id]', params: { id: saved.id } });
        }
      } catch { context.error('The correction could not be saved. Please try again.'); }
    });
  }

  async function saveVocabularyWord(source: CaptureRecord, group: TextGroup, index: number, reading: string): Promise<WordSaveOutcome> {
    return await run('save', async () => {
      await flushDraft();
      const latest = currentCapture.current;
      if (!latest || latest.id !== source.id || ![...rowGroupsForCapture(latest), ...textGroupsForCapture(latest)].some((item) => item.id === group.id && item.text === group.text)) return null;
      return afterCommit(addWordCard(latest, index, reading, group));
    }) ?? null;
  }

  if (showCamera) return <CameraCapture onPhoto={importCameraPhoto} onClose={() => setShowCamera(false)} />;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <StatusBar style="dark" />
      {capture ? (
        <CaptureReview
          initialGroupId={Array.isArray(params.groupId) ? params.groupId[0] : params.groupId}
          key={`${capture.id}:${params.groupId ?? ''}`}
          capture={capture} busy={busy} error={error} notice={notice}
          onChange={updateDraft} onClearNotice={clearNotice}
          onNewCapture={() => void startNewCapture()}
          onRetry={() => void run('ocr', (context) => recognizeRecord(currentCapture.current ?? capture, context))}
          onSave={(record, group) => void saveSelection(record, group)}
          onSaveWord={saveVocabularyWord}
          navHidden={navHidden} onToggleNav={() => setNavHidden((hidden) => !hidden)}
        />
      ) : <CaptureHome busy={busy} error={error} notice={notice} onChoose={(source) => void chooseImage(source)} />}
    </SafeAreaView>
  );
}
