import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, Alert, Keyboard, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { analysisFailureMessage, isConnectivityFailure, readingToSave, requestJapaneseAnalysis } from './analysis';
import { rowGroupsForCapture, textGroupsForCapture, unsavedRows, excludeRegion, excludeRegions, joinSelectedFindings, restoreRegion as restoreCaptureRegion, updateManualCorrection, updateRegionCorrection } from './review';
import { brushTouchesBounds, containFit } from './geometry';
import { ANALYSIS_CONTRACT_VERSION, type AnalysisResponse, type AnalysisTokenReview, type CaptureRecord, type TextGroup } from './types';
import AnalysisReadingsAndMeanings, { wordSaveResultFor, type WordSaveResult } from './CaptureAnalysisPreview';
import { styles } from './uiStyles';
import StatusMessage from './StatusMessage';
import { loadTextGroups, type WordSaveOutcome } from './store';
import { onStudyChange } from './studyChanges';
import { colors } from '../theme';

/** Dictionary choices belong to one exact text of one row or block; editing the text discards them. */
const reviewKey = (group: TextGroup) => `${group.id}\n${group.text}`;
const JAPANESE_ROW = /\p{Script=Han}|[\p{Script=Hiragana}\p{Script=Katakana}][\s\S]*[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Photo-first review: every kept OCR line is a study row with furigana, glosses and its own Save.
 * Editing (per row, or brush/blocks/raw OCR in Edit tools) expands in place.
 */
export default function CaptureReview({
  capture,
  busy,
  error,
  notice,
  onChange,
  onClearNotice,
  onNewCapture,
  onRetry,
  onSave,
  onSaveWord,
  initialGroupId,
  navHidden,
  onToggleNav,
}: {
  initialGroupId?: string;
  capture: CaptureRecord;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onChange: (capture: CaptureRecord) => void;
  onClearNotice: () => void;
  onNewCapture: () => void;
  onRetry: () => void;
  onSave: (capture: CaptureRecord, group?: TextGroup) => void;
  onSaveWord?: (capture: CaptureRecord, group: TextGroup, index: number, reading: string) => Promise<WordSaveOutcome>;
  navHidden?: boolean;
  onToggleNav?: () => void;
}) {
  const rows = rowGroupsForCapture(capture);
  // Bulk saves keep multi-line OCR blocks (and untouched legacy selections) as one text.
  const blocks = textGroupsForCapture(capture).filter((group) => group.regionIds.length > 1 || group.id.startsWith('legacy:'));
  const { height: windowHeight } = useWindowDimensions();
  const [focusedRegionId, setFocusedRegionId] = useState<string | null>(() =>
    [...rows, ...textGroupsForCapture(capture)].find((group) => group.id === initialGroupId)?.regionIds[0] ?? null);
  // Study rows lead once text is ready; the photo stays open while reading, after a failure, or to show a source line.
  const [showPhoto, setShowPhoto] = useState(capture.status !== 'complete' || !!focusedRegionId);
  const [photoForStatus, setPhotoForStatus] = useState(capture.status);
  if (photoForStatus !== capture.status) {
    setPhotoForStatus(capture.status);
    setShowPhoto(capture.status !== 'complete');
  }
  const [showTools, setShowTools] = useState(false);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [savedGroupTexts, setSavedGroupTexts] = useState<Record<string, string>>({});
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResponse>>({});
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const [analysisAttempt, setAnalysisAttempt] = useState(0);
  const [reviews, setReviews] = useState<Record<string, Record<string, AnalysisTokenReview>>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [openParagraphs, setOpenParagraphs] = useState<Set<string>>(() => new Set());
  const [removed, setRemoved] = useState<{ regionId: string; text: string; saved: boolean } | null>(null);
  const [previewFrame, setPreviewFrame] = useState({ width: 0, height: 0 });
  const [displayImage, setDisplayImage] = useState({ width: capture.imageMetadata.displayWidth ?? capture.imageMetadata.width, height: capture.imageMetadata.displayHeight ?? capture.imageMetadata.height });
  const [showRaw, setShowRaw] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const currentCapture = useRef(capture);
  useEffect(() => { currentCapture.current = capture; }, [capture]);
  const analysesRef = useRef(analyses);
  useEffect(() => { analysesRef.current = analyses; }, [analyses]);
  const [brushEnabled, setBrushEnabled] = useState(false);
  const [brushPoint, setBrushPoint] = useState<{ x: number; y: number } | null>(null);
  const [undoHistory, setUndoHistory] = useState<CaptureRecord[]>([]);
  const brushStroke = useRef<{ previous: { x: number; y: number }; snapshot: CaptureRecord; changed: boolean } | null>(null);

  // Saved texts can be edited or deleted elsewhere; reload which rows are saved on return and on committed changes.
  // Only the saved map is replaced; in-session readings, choices and drafts below always win.
  const [savedVersion, setSavedVersion] = useState(0);
  useEffect(() => onStudyChange(() => setSavedVersion((value) => value + 1)), []);
  useFocusEffect(useCallback(() => { setSavedVersion((value) => value + 1); }, []));
  useEffect(() => {
    let active = true; // a newer load supersedes this one, so a late result never overwrites fresher state
    loadTextGroups(capture.id).then((items) => {
      if (!active) return;
      setSavedGroupTexts(Object.fromEntries(items.map((group) => [group.id, group.text])));
      // Saved rows reopen with their stored readings and explicit choices; newer in-session state wins.
      setAnalyses((current) => ({ ...Object.fromEntries(items.flatMap((group) => group.analysis?.normalizedText === group.text ? [[group.text, group.analysis]] : [])), ...current }));
      setReviews((current) => ({ ...Object.fromEntries(items.map((group) => [reviewKey(group), group.analysisReview])), ...current }));
    }).catch(() => {});
    return () => { active = false; };
  }, [capture.id, notice, busy, savedVersion]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const imageFit = containFit(previewFrame, { width: capture.imageMetadata.displayWidth ?? displayImage.width, height: capture.imageMetadata.displayHeight ?? displayImage.height });
  const excluded = capture.regions.filter((region) => region.review?.excluded);
  // Focused row first, then rows with real Japanese (kanji or 2+ kana), each group in photo order; LINE n keeps provenance.
  const rank = (group: TextGroup) => focusedRegionId && group.regionIds.includes(focusedRegionId) ? 0 : JAPANESE_ROW.test(group.text) ? 1 : 2;
  const linesOf = (block: TextGroup) => rows.filter((row) => block.regionIds.includes(row.regionIds[0]));
  const paragraphs = blocks.filter((block) => linesOf(block).length > 1);
  // A row counts as saved on its own or inside a saved paragraph with unchanged text (same rule as Drafts).
  const unsavedIds = new Set(unsavedRows(capture, new Map(Object.entries(savedGroupTexts))).map((row) => row.id));
  const savedRowCount = rows.filter((row) => row.text.trim() && !unsavedIds.has(row.id)).length;
  const units = [...paragraphs, ...rows.filter((row) => !paragraphs.some((block) => block.regionIds.includes(row.regionIds[0])))]
    .sort((left, right) => rank(left) - rank(right));
  // Paragraphs lead the screen. Their hidden lines need readings only when expanded.
  const visibleStudyGroups = [
    ...units.filter((group) => paragraphs.includes(group)),
    ...units.filter((group) => !paragraphs.includes(group)),
    ...paragraphs.filter((group) => openParagraphs.has(group.id)).flatMap(linesOf),
  ];
  const textsKey = JSON.stringify([...new Set(visibleStudyGroups.map((group) => group.text).filter((text) => text.trim()))]);
  const analysisRequests = useRef(new Map<string, Promise<AnalysisResponse>>());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    let disconnected = false;
    let next = 0;
    const texts = JSON.parse(textsKey) as string[];
    async function worker() {
      while (active && !disconnected && next < texts.length) {
        const text = texts[next++];
        if (analysesRef.current[text]) continue;
        // Keep the same two-request limit when typing or expanding lines replaces this effect's queue.
        while (active && analysisRequests.current.size >= 2 && !analysisRequests.current.has(text)) {
          await Promise.race(analysisRequests.current.values()).catch(() => undefined);
        }
        if (!active || disconnected) return;
        let request = analysisRequests.current.get(text);
        if (!request) {
          request = requestJapaneseAnalysis({ contractVersion: ANALYSIS_CONTRACT_VERSION, language: capture.language, text })
            .then((analysis) => {
              if (mounted.current) {
                // Cache only under the requested exact text, including results whose row was edited meanwhile.
                analysesRef.current = { ...analysesRef.current, [text]: analysis };
                setAnalyses((current) => ({ ...current, [text]: analysis }));
                setAnalysisErrors((current) => { const remaining = { ...current }; delete remaining[text]; return remaining; });
              }
              return analysis;
            })
            .finally(() => { analysisRequests.current.delete(text); });
          analysisRequests.current.set(text, request);
        }
        try {
          await request;
        } catch (cause) {
          if (!active) return;
          console.warn('Yugen readings failed', cause);
          const message = analysisFailureMessage(cause);
          if (isConnectivityFailure(cause)) {
            disconnected = true;
            setAnalysisErrors((current) => ({ ...current, ...Object.fromEntries(texts.filter((item) => !analysesRef.current[item]).map((item) => [item, message])) }));
          } else {
            setAnalysisErrors((current) => ({ ...current, [text]: message }));
          }
        }
      }
    }
    // A correction changes on each keystroke; wait until typing settles before starting its lookup.
    const timer = setTimeout(() => { void Promise.all([worker(), worker()]); }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [capture.language, textsKey, analysisAttempt]);

  const noRecognizedRows = !capture.regions.some((region) => !region.review?.excluded && (region.text.trim() || region.review?.correctedText?.trim()));

  function applyEdit(record: CaptureRecord) {
    // A previous whole-stroke snapshot must never erase a later correction or translation.
    setUndoHistory([]);
    currentCapture.current = record;
    onChange(record);
  }

  function chooseCandidate(group: TextGroup, index: number, dictionaryCandidateId: string) {
    setUndoHistory([]);
    const key = reviewKey(group);
    setReviews((current) => ({ ...current, [key]: { ...current[key], [index]: { ignored: current[key]?.[index]?.ignored ?? false, dictionaryCandidateId } } }));
  }

  function focusRow(regionId: string) {
    if (capture.regions.find((region) => region.id === regionId)?.review?.excluded) return;
    setFocusedRegionId(regionId);
    onClearNotice();
  }

  function showInPhoto(regionId: string) {
    setFocusedRegionId(regionId);
    setShowPhoto(true);
  }

  function editRegion(regionId: string, value: string) {
    applyEdit(updateRegionCorrection(capture, regionId, value));
    onClearNotice();
  }

  function removeFromDraft(group: TextGroup) {
    const regionId = group.regionIds[0];
    setEditingRowId(null);
    const updated = excludeRegion(capture, regionId);
    applyEdit(updated);
    setRemoved({ regionId, text: group.text, saved: savedGroupTexts[group.id] !== undefined });
    onClearNotice();
  }

  function undoRemoval() {
    if (!removed) return;
    const restored = restoreCaptureRegion(currentCapture.current, removed.regionId);
    applyEdit(restored);
    setRemoved(null);
  }

  function restoreRegion(regionId: string) {
    applyEdit(restoreCaptureRegion(capture, regionId));
    setRemoved(null);
    onClearNotice();
  }

  /** Save action shared by lines and paragraphs; an edited saved entry is only replaced after confirmation. */
  function saveButton(group: TextGroup, noun: 'row' | 'paragraph') {
    const savedText = savedGroupTexts[group.id];
    const saved = savedText === group.text;
    const replaces = savedText !== undefined && !saved;
    const blank = !group.text.trim();
    const label = busy && savingId === group.id ? 'Saving…' : replaces ? 'Replace saved text' : saved ? 'Save again' : `Save ${noun}`;
    return (
      <>
        {replaces && <Text style={styles.helperText}>Saved as edited: {savedText}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${group.text}`} disabled={busy || blank}
          onPress={() => replaces ? confirmReplace(group, savedText) : saveGroup(group)} style={[styles.rowSave, (busy || blank) && styles.disabled]}>
          <Text style={styles.wordSaveText}>{label}</Text>
        </Pressable>
      </>
    );
  }

  function study(group: TextGroup) {
    const analysis = analyses[group.text] ?? null;
    const choices = Object.fromEntries(Object.entries(reviews[reviewKey(group)] ?? {}).flatMap(([index, review]) => review.dictionaryCandidateId ? [[index, review.dictionaryCandidateId]] : []));
    return (
      <AnalysisReadingsAndMeanings
        key={reviewKey(group)}
        text={group.text}
        analysis={analysis}
        busy={!analysis && !analysisErrors[group.text]}
        error={analysis ? null : analysisErrors[group.text] ?? null}
        choices={choices}
        translation={null} translationBusy={false} translationError={null} onTranslate={() => {}}
        onChooseCandidate={(index, id) => chooseCandidate(group, index, id)}
        onRetry={retryReadings}
        onSaveWord={(index) => saveWord(group, index)}
        onEnrichCharacters={(index, details) => setAnalyses((current) => current[group.text] ? { ...current, [group.text]: { ...current[group.text], tokens: current[group.text].tokens.map((token, tokenIndex) => tokenIndex === index ? { ...token, kanjiDetails: details } : token) } } : current)}
      />
    );
  }

  function paragraphCard(block: TextGroup) {
    const lines = linesOf(block);
    const open = openParagraphs.has(block.id);
    const selectedLines = capture.regions.filter((region) => block.regionIds.includes(region.id) && region.review?.selected && !region.review.excluded);
    const joined = capture.joinedWithoutBreaks || (!!selectedLines.length && selectedLines.every((region) => region.review?.joined));
    const saved = savedGroupTexts[block.id] === block.text;
    return (
      <View key={block.id} style={[styles.findingCard, !!focusedRegionId && block.regionIds.includes(focusedRegionId) && styles.selectedFinding]}>
        <Text style={styles.sectionLabel}>PARAGRAPH · {lines.length} LINES{saved ? ' · SAVED' : ''}</Text>
        {/* Save and Lines lead; the word list below can be long. */}
        <View style={styles.rowActions}>
          {saveButton(block, 'paragraph')}
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpenParagraphs((current) => {
            const next = new Set(current);
            if (open) next.delete(block.id); else next.add(block.id);
            return next;
          })} style={styles.rowAction}>
            <Text style={styles.rowActionText}>{open ? 'Hide lines' : `Lines · ${lines.length}`}</Text>
          </Pressable>
          {selectedLines.length > 1 && !capture.savedAt && (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => { applyEdit(joinSelectedFindings(capture, !joined, new Set(block.regionIds))); onClearNotice(); }} style={styles.rowAction}>
              <Text style={styles.rowActionText}>{joined ? 'Keep line breaks' : 'Join lines'}</Text>
            </Pressable>
          )}
        </View>
        {block.text.trim() ? study(block) : <Text style={styles.helperText}>No lines of this paragraph are kept.</Text>}
        {open && lines.map((line) => rowCard(line))}
      </View>
    );
  }

  function retryReadings() {
    setAnalysisErrors({});
    setAnalysisAttempt((attempt) => attempt + 1);
  }

  function rowCard(group: TextGroup) {
    const region = capture.regions.find((item) => item.id === group.regionIds[0]);
    const saved = savedGroupTexts[group.id] === group.text;
    const editing = !!region && editingRowId === group.id;
    const blank = !group.text.trim();
    return (
      <View key={group.id} style={[styles.findingCard, !!region && region.id === focusedRegionId && styles.selectedFinding]}>
        <Text style={styles.sectionLabel}>{region ? `LINE ${capture.regions.indexOf(region) + 1}` : 'TYPED TEXT'}{saved ? ' · SAVED' : ''}</Text>
        {blank ? <Text style={styles.helperText}>This row is empty. Type its text or remove it.</Text> : study(group)}
        <View style={styles.rowActions}>
          {/* Saving again is idempotent and adds words resolved since (new readings or choices). */}
          {saveButton(group, 'row')}
          {region && (
            <Pressable accessibilityRole="button" onPress={() => showInPhoto(region.id)} style={styles.rowAction}>
              <Text style={styles.rowActionText}>Show in photo</Text>
            </Pressable>
          )}
          {region && (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: editing }} onPress={() => setEditingRowId(editing ? null : group.id)} style={styles.rowAction}>
              <Text style={styles.rowActionText}>{editing ? 'Done editing' : 'Edit'}</Text>
            </Pressable>
          )}
          {region && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove line from this draft: ${group.text}`} disabled={busy} onPress={() => removeFromDraft(group)} style={styles.rowAction}>
              <Text style={styles.removeRowText}>Remove from draft</Text>
            </Pressable>
          )}
        </View>
        {editing && (
          <>
            <TextInput
              editable={!busy}
              accessibilityLabel="Corrected text for this row"
              multiline
              onChangeText={(value) => editRegion(region.id, value)}
              placeholder="Correct this row"
              placeholderTextColor="#929991"
              style={styles.inlineEditor}
              textAlignVertical="top"
              value={group.text}
            />
            {region.confidence !== null && <Text style={styles.confidence}>OCR confidence {Math.round(region.confidence * 100)}%</Text>}
          </>
        )}
      </View>
    );
  }

  function reviewedGroup(group: TextGroup): TextGroup {
    const analysis = analyses[group.text]?.normalizedText === group.text ? analyses[group.text] : null;
    return { ...group, analysis, analysisReview: analysis ? { ...reviews[reviewKey(group)] } : {} };
  }

  function confirmReplace(group: TextGroup, savedText: string) {
    Alert.alert('Replace saved text?', `Your saved text “${savedText}” will be replaced by this row: “${group.text}”. Its words stay in Vocabulary.`, [
      { text: 'Keep saved text', style: 'cancel' },
      { text: 'Replace saved text', style: 'destructive', onPress: () => saveGroup(group) },
    ]);
  }

  function saveGroup(group: TextGroup) {
    setSavingId(group.id);
    onSave(capture, reviewedGroup(group));
  }

  /** Saves one word with its row or paragraph and returns the real outcome for the word's own feedback. */
  async function saveWord(group: TextGroup, index: number): Promise<WordSaveResult> {
    if (!onSaveWord) return { state: 'failed', message: 'Words cannot be saved here.' };
    const reviewed = reviewedGroup(group);
    const token = reviewed.analysis?.tokens[index];
    if (!token) return { state: 'failed', message: 'This text changed while saving. Try again.' };
    const reading = readingToSave(token, reviewed.analysisReview[index]?.dictionaryCandidateId);
    if (!reading) return { state: 'failed', message: 'This word has no dictionary reading to save.' };
    const outcome = await onSaveWord(capture, reviewed, index, reading);
    setSavedVersion((value) => value + 1); // its row or paragraph may now be saved too
    return wordSaveResultFor(outcome);
  }

  function paintNoise(event: GestureResponderEvent) {
    const stroke = brushStroke.current;
    if (!stroke || !imageFit) return;
    const point = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
    const latest = currentCapture.current;
    const ids = new Set(latest.regions.filter((region) => !region.review?.excluded
      && brushTouchesBounds(stroke.previous, point, region.bounds, imageFit)).map((region) => region.id));
    const updated = excludeRegions(latest, ids);
    stroke.previous = point;
    setBrushPoint(point);
    if (updated !== latest) {
      stroke.changed = true;
      currentCapture.current = updated;
      onChange(updated);
      onClearNotice();
    }
  }

  function startBrush(event: GestureResponderEvent) {
    const point = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
    brushStroke.current = { previous: point, snapshot: currentCapture.current, changed: false };
    paintNoise(event);
  }

  function finishBrush(event: GestureResponderEvent) {
    paintNoise(event);
    const stroke = brushStroke.current;
    brushStroke.current = null;
    setBrushPoint(null);
    if (stroke?.changed) {
      setUndoHistory((history) => [...history, stroke.snapshot]);
    }
  }

  function undoBrush() {
    const previous = undoHistory.at(-1);
    if (!previous) return;
    currentCapture.current = previous;
    onChange(previous);
    setUndoHistory((history) => history.slice(0, -1));
    onClearNotice();
  }

  return (
    <KeyboardAvoidingView style={styles.reviewLayout} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
      <View style={styles.reviewContent}>
        <View style={styles.captureHeader}>
          <Text style={styles.captureTitle}>Capture</Text>
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPhoto }} onPress={() => setShowPhoto((value) => !value)} style={styles.newCaptureButton}>
              <Text style={styles.newCaptureText}>{showPhoto ? 'Hide photo' : 'Show photo'}</Text>
            </Pressable>
            {onToggleNav && (
              <Pressable accessibilityRole="button" accessibilityLabel={navHidden ? 'Show bottom navigation' : 'Hide bottom navigation'} onPress={onToggleNav} style={styles.newCaptureButton}>
                <Text style={styles.newCaptureText}>{navHidden ? 'Menu' : 'Hide menu'}</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" disabled={busy} onPress={onNewCapture} style={styles.newCaptureButton}>
              <Text style={styles.newCaptureText}>New</Text>
            </Pressable>
          </View>
        </View>

        {showPhoto && (
          <View style={[styles.photoPanel, { height: Math.round(windowHeight * (keyboardVisible ? 0.18 : 0.32)) }]}>
            <View style={styles.imageViewport} onLayout={(event) => setPreviewFrame(event.nativeEvent.layout)}>
              <Image
                source={{ uri: capture.imageUri }}
                style={styles.image}
                resizeMode="contain"
                onLoad={(event) => { if (event.nativeEvent.source) setDisplayImage(event.nativeEvent.source); }}
                accessibilityLabel="Captured text image"
              />
              {imageFit && capture.regions.map((region, index) => (
                <Pressable
                  key={region.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Show row ${index + 1}: ${region.review?.correctedText ?? region.text}`}
                  disabled={busy || brushEnabled || !!region.review?.excluded}
                  onPress={() => focusRow(region.id)}
                  style={[
                    styles.regionOutline,
                    region.id === focusedRegionId && styles.highlightOutline,
                    region.review?.excluded && styles.removedRegionOutline,
                    {
                      left: imageFit.left + region.bounds.x * imageFit.width,
                      top: imageFit.top + region.bounds.y * imageFit.height,
                      width: Math.max(8, region.bounds.width * imageFit.width),
                      height: Math.max(8, region.bounds.height * imageFit.height),
                    },
                  ]}
                />
              ))}
              {brushEnabled && !busy && imageFit && (
                <View style={[StyleSheet.absoluteFill, { zIndex: 3 }]}
                  onStartShouldSetResponder={(event) => {
                    const { locationX: x, locationY: y } = event.nativeEvent;
                    return x >= imageFit.left && x <= imageFit.left + imageFit.width && y >= imageFit.top && y <= imageFit.top + imageFit.height;
                  }}
                  onResponderTerminationRequest={() => false}
                  onResponderGrant={startBrush} onResponderMove={paintNoise} onResponderRelease={finishBrush} onResponderTerminate={finishBrush}
                />
              )}
              {brushPoint && <View pointerEvents="none" style={[styles.brushCursor, { left: brushPoint.x - 22, top: brushPoint.y - 22 }]} />}
              {capture.status === 'processing' && <View style={styles.photoStatus}><ActivityIndicator color={colors.ink} /><Text style={styles.helperText}>Reading text…</Text></View>}
            </View>
          </View>
        )}
        {showPhoto && showTools && (
          <>
            <View style={styles.brushToolbar}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: brushEnabled }} disabled={busy || !capture.regions.length}
                onPress={() => setBrushEnabled((enabled) => !enabled)} style={[styles.brushButton, brushEnabled && styles.brushButtonActive]}>
                <Text style={[styles.brushButtonText, brushEnabled && styles.brushButtonTextActive]}>{brushEnabled ? 'Done brushing' : 'Brush away'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={!undoHistory.length || busy} onPress={undoBrush} style={[styles.undoButton, !undoHistory.length && styles.disabled]}>
                <Text style={styles.brushButtonText}>Undo brush</Text>
              </Pressable>
            </View>
            <Text style={styles.brushHint}>{brushEnabled ? 'Paint unwanted lines. Undo restores the last stroke.' : 'Brush away unwanted lines on the photo.'}</Text>
          </>
        )}

        <ScrollView style={styles.reviewBody} contentContainerStyle={styles.textContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <StatusMessage text={error ?? notice} error={!!error} />

          {capture.status === 'failed' && (
            <View style={styles.failureCard}>
              <Text style={styles.failureTitle}>Your photo is safe.</Text>
              <Text style={styles.helperText}>Text recognition did not finish. Retry, or type the text below.</Text>
              <Pressable accessibilityRole="button" disabled={busy} onPress={onRetry} style={styles.retryButton}>
                <Text style={styles.retryButtonText}>{capture.rawText ? 'Retry saving OCR result' : 'Retry text recognition'}</Text>
              </Pressable>
            </View>
          )}
          {capture.status === 'processing' && (
            <View style={styles.previewStatus}><ActivityIndicator color={colors.green} /><Text accessibilityLiveRegion="polite" style={styles.previewStatusText}>Photo kept on this device. Reading text…</Text></View>
          )}

          {capture.status !== 'processing' && noRecognizedRows && (
            <View style={styles.manualEntry}>
              <Text style={styles.sectionLabel}>{capture.regions.length ? 'ALL ROWS REMOVED' : 'NO TEXT FOUND'}</Text>
              <Text style={styles.helperText}>Type the Japanese you want to keep{capture.regions.length ? ', or restore rows in Edit tools' : ''}.</Text>
              <TextInput
                editable={!busy}
                accessibilityLabel="Enter text manually"
                multiline
                onChangeText={(correctedText) => {
                  applyEdit(updateManualCorrection(capture, correctedText));
                  onClearNotice();
                }}
                placeholder="Enter Japanese text"
                placeholderTextColor="#929991"
                style={styles.inlineEditor}
                textAlignVertical="top"
                value={capture.correctedText}
              />
            </View>
          )}

          {removed && (
            <View style={styles.undoBar}>
              <Text accessibilityLiveRegion="polite" style={styles.undoText}>
                Removed “{removed.text}” from this draft.{removed.saved ? ' Its saved text stays in your Library.' : ''}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Undo removing the line" onPress={undoRemoval} style={styles.rowAction}>
                <Text style={styles.rowActionText}>Undo</Text>
              </Pressable>
            </View>
          )}
          {units.length > 0 && (
            <Text style={styles.sectionLabel}>{rows.length} {rows.length === 1 ? 'ROW' : 'ROWS'} · {savedRowCount} SAVED</Text>
          )}
          {units.map((group) => paragraphs.includes(group) ? paragraphCard(group) : rowCard(group))}

          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTools }} onPress={() => { if (!showTools) setShowPhoto(true); setShowTools(!showTools); setBrushEnabled(false); }} style={styles.disclosureButton}>
            <Text style={styles.disclosureText}>Edit tools</Text>
            <Text style={styles.disclosureChevron}>{showTools ? '−' : '+'}</Text>
          </Pressable>
          {showTools && (
            <View style={styles.selectionDetails}>
              {capture.savedAt && (
                <Pressable accessibilityRole="button" onPress={() => applyEdit({ ...capture, savedAt: null, joinedWithoutBreaks: false })} style={styles.joinAction}>
                  <Text style={styles.joinActionText}>Split this older saved text into OCR rows</Text>
                </Pressable>
              )}
              {excluded.length > 0 && (
                <Pressable accessibilityRole="button" onPress={() => setShowExcluded((current) => !current)} style={styles.disclosureButton}>
                  <Text style={styles.disclosureText}>{showExcluded ? 'Hide' : 'Show'} removed rows · {excluded.length}</Text>
                </Pressable>
              )}
              {showExcluded && excluded.map((region) => (
                <View key={region.id} style={[styles.findingCard, styles.excludedFinding, styles.findingHeader]}>
                  <Text numberOfLines={2} style={styles.findingRaw}>{region.review?.correctedText ?? region.text}</Text>
                  <Pressable accessibilityRole="button" disabled={busy} onPress={() => restoreRegion(region.id)} style={styles.smallAction}>
                    <Text style={styles.restoreText}>Restore</Text>
                  </Pressable>
                </View>
              ))}
              <Pressable accessibilityRole="button" onPress={() => setShowRaw((current) => !current)} style={styles.disclosureButton}>
                <Text style={styles.disclosureText}>{showRaw ? 'Hide' : 'Show'} original OCR text</Text>
                <Text style={styles.disclosureChevron}>{showRaw ? '−' : '+'}</Text>
              </Pressable>
              {showRaw && (
                <View style={styles.rawCard}>
                  <Text style={styles.sectionLabel}>RAW OCR · PRESERVED</Text>
                  <Text selectable style={styles.rawText}>
                    {capture.rawText || (capture.status === 'processing' ? 'Reading text from image…' : 'No text was returned. The original image is still saved.')}
                  </Text>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {keyboardVisible && (
          <View style={styles.footer}>
            <Pressable accessibilityRole="button" accessibilityLabel="Dismiss keyboard" onPress={Keyboard.dismiss} style={styles.dismissKeyboard}>
              <Text style={styles.dismissKeyboardText}>Done</Text>
            </Pressable>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
