import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { analysisFailureMessage, readingToSave, requestJapaneseAnalysis } from './analysis';
import { rowGroupsForCapture, textGroupsForCapture, excludeRegions, restoreRegion as restoreCaptureRegion, updateManualCorrection, updateRegionCorrection } from './review';
import { brushTouchesBounds, containFit } from './geometry';
import { ANALYSIS_CONTRACT_VERSION, type AnalysisResponse, type AnalysisTokenReview, type CaptureRecord, type TextGroup } from './types';
import AnalysisReadingsAndMeanings from './CaptureAnalysisPreview';
import { styles } from './uiStyles';
import { loadTextGroups } from './store';
import { colors } from '../theme';

/** Dictionary choices belong to one exact text of one row or block; editing the text discards them. */
const reviewKey = (group: TextGroup) => `${group.id}\n${group.text}`;

/**
 * Photo-first review: every kept OCR line is a study row with furigana, glosses and its own Save; lines of one
 * native OCR block also form a paragraph that saves together. Raw OCR and the photo are never changed.
 */
export default function CaptureReview({
  capture,
  busy,
  error,
  notice,
  onChange,
  onNewCapture,
  onRetry,
  onSave,
  onSaveWord,
}: {
  capture: CaptureRecord;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onChange: (capture: CaptureRecord) => void;
  onNewCapture: () => void;
  onRetry: () => void;
  onSave: (capture: CaptureRecord, group: TextGroup) => void;
  onSaveWord: (capture: CaptureRecord, group: TextGroup, index: number, reading: string | null) => void;
}) {
  const rows = rowGroupsForCapture(capture);
  // Multi-line OCR blocks also save as one paragraph text.
  const blocks = textGroupsForCapture(capture).filter((group) => group.regionIds.length > 1);
  const { height: windowHeight } = useWindowDimensions();
  const [previewFrame, setPreviewFrame] = useState({ width: 0, height: 0 });
  const [displayImage, setDisplayImage] = useState({ width: capture.imageMetadata.displayWidth ?? capture.imageMetadata.width, height: capture.imageMetadata.displayHeight ?? capture.imageMetadata.height });
  const [showRaw, setShowRaw] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const currentCapture = useRef(capture);
  useEffect(() => { currentCapture.current = capture; }, [capture]);
  const [brushEnabled, setBrushEnabled] = useState(false);
  const [brushPoint, setBrushPoint] = useState<{ x: number; y: number } | null>(null);
  const [undoHistory, setUndoHistory] = useState<CaptureRecord[]>([]);
  const brushStroke = useRef<{ previous: { x: number; y: number }; snapshot: CaptureRecord; changed: boolean } | null>(null);
  // Overlays use the upright image as displayed; encoded metadata can be swapped by EXIF rotation.
  const imageFit = containFit(previewFrame, { width: capture.imageMetadata.displayWidth ?? displayImage.width, height: capture.imageMetadata.displayHeight ?? displayImage.height });
  const [focusedRegionId, setFocusedRegionId] = useState<string | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [openParagraphs, setOpenParagraphs] = useState<Set<string>>(() => new Set());
  const [savedGroupTexts, setSavedGroupTexts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResponse>>({});
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const [analysisAttempt, setAnalysisAttempt] = useState(0);
  const [reviews, setReviews] = useState<Record<string, Record<string, AnalysisTokenReview>>>({});
  const analysesRef = useRef(analyses);
  useEffect(() => { analysesRef.current = analyses; }, [analyses]);

  // Which rows are saved, reloaded after each save; saved rows reopen with their readings and explicit choices.
  useEffect(() => {
    let active = true;
    loadTextGroups(capture.id).then((items) => {
      if (!active) return;
      setSavedGroupTexts(Object.fromEntries(items.map((group) => [group.id, group.text])));
      // Newer in-session readings and choices win.
      setAnalyses((current) => ({ ...Object.fromEntries(items.flatMap((group) => group.analysis?.normalizedText === group.text ? [[group.text, group.analysis]] : [])), ...current }));
      setReviews((current) => ({ ...Object.fromEntries(items.map((group) => [reviewKey(group), group.analysisReview])), ...current }));
    }).catch(() => {});
    return () => { active = false; };
  }, [capture.id, notice, busy]);

  // Load readings for every row and block once per exact text.
  const textsKey = JSON.stringify([...new Set([...rows, ...blocks].map((group) => group.text).filter((text) => text.trim()))]);
  useEffect(() => {
    let active = true;
    const texts = JSON.parse(textsKey) as string[];
    Promise.resolve().then(async () => {
      // Typing in a row edits its text on every keystroke; analyze once it settles.
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const text of texts) {
        if (!active) return;
        if (analysesRef.current[text]) continue;
        try {
          const analysis = await requestJapaneseAnalysis({ contractVersion: ANALYSIS_CONTRACT_VERSION, language: capture.language, text });
          // Readings stay valid for their exact text even if the rows changed meanwhile.
          setAnalyses((current) => ({ ...current, [text]: analysis }));
        } catch (cause) {
          console.warn('Yugen readings failed', cause);
          if (active) setAnalysisErrors((current) => ({ ...current, [text]: analysisFailureMessage(cause) }));
        }
      }
    });
    return () => { active = false; };
  }, [capture.language, textsKey, analysisAttempt]);

  const linesOf = (block: TextGroup) => rows.filter((row) => block.regionIds.includes(row.regionIds[0]));
  const paragraphs = blocks.filter((block) => linesOf(block).length > 1);
  const units = [...paragraphs, ...rows.filter((row) => !paragraphs.some((block) => block.regionIds.includes(row.regionIds[0])))];
  const savedRowCount = rows.filter((row) => row.text.trim() && savedGroupTexts[row.id] === row.text).length;
  const kept = capture.regions.filter((region) => !region.review?.excluded);
  const excluded = capture.regions.filter((region) => region.review?.excluded);

  function applyEdit(record: CaptureRecord) {
    // A previous whole-stroke snapshot must never erase a later correction.
    setUndoHistory([]);
    currentCapture.current = record;
    onChange(record);
  }

  function chooseCandidate(group: TextGroup, index: number, dictionaryCandidateId: string) {
    setUndoHistory([]);
    const key = reviewKey(group);
    setReviews((current) => ({ ...current, [key]: { ...current[key], [index]: { ignored: current[key]?.[index]?.ignored ?? false, dictionaryCandidateId } } }));
  }

  function saveButton(group: TextGroup, noun: 'row' | 'paragraph') {
    const saved = savedGroupTexts[group.id] === group.text;
    const blank = !group.text.trim();
    const label = busy && savingId === group.id ? 'Saving…' : saved ? 'Save again' : `Save ${noun}`;
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${group.text}`} disabled={busy || blank}
        onPress={() => saveGroup(group)} style={[styles.rowSave, (busy || blank) && styles.disabled]}>
        <Text style={styles.wordSaveText}>{label}</Text>
      </Pressable>
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
    const saved = savedGroupTexts[block.id] === block.text;
    return (
      <View key={block.id} style={[styles.findingCard, !!focusedRegionId && block.regionIds.includes(focusedRegionId) && styles.selectedFinding]}>
        <Text style={styles.sectionLabel}>PARAGRAPH · {lines.length} LINES{saved ? ' · SAVED' : ''}</Text>
        <View style={styles.rowActions}>
          {saveButton(block, 'paragraph')}
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpenParagraphs((current) => {
            const next = new Set(current);
            if (open) next.delete(block.id); else next.add(block.id);
            return next;
          })} style={styles.rowAction}>
            <Text style={styles.rowActionText}>{open ? 'Hide lines' : `Lines · ${lines.length}`}</Text>
          </Pressable>
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
        {blank ? <Text style={styles.helperText}>This row is empty. Type its text or brush it away.</Text> : study(group)}
        <View style={styles.rowActions}>
          {/* Saving again is idempotent and adds words resolved since (new readings or choices). */}
          {saveButton(group, 'row')}
          {region && (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: editing }} onPress={() => setEditingRowId(editing ? null : group.id)} style={styles.rowAction}>
              <Text style={styles.rowActionText}>{editing ? 'Done editing' : 'Edit'}</Text>
            </Pressable>
          )}
        </View>
        {editing && (
          <>
            <TextInput
              editable={!busy}
              accessibilityLabel="Corrected text for this row"
              multiline
              onChangeText={(value) => applyEdit(updateRegionCorrection(capture, region.id, value))}
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

  function saveGroup(group: TextGroup) {
    setSavingId(group.id);
    onSave(capture, reviewedGroup(group));
  }

  /** Saves one explicitly approved word together with its row or paragraph. */
  function saveWord(group: TextGroup, index: number) {
    const reviewed = reviewedGroup(group);
    const token = reviewed.analysis?.tokens[index];
    onSaveWord(capture, reviewed, index, token ? readingToSave(token, reviewed.analysisReview[index]?.dictionaryCandidateId) : null);
  }

  function restoreRegion(regionId: string) {
    applyEdit(restoreCaptureRegion(capture, regionId));
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
    if (stroke?.changed) setUndoHistory((history) => [...history, stroke.snapshot]);
  }

  function undoBrush() {
    const previous = undoHistory.at(-1);
    if (!previous) return;
    currentCapture.current = previous;
    onChange(previous);
    setUndoHistory((history) => history.slice(0, -1));
  }

  return (
    <View style={styles.reviewContent}>
      <View style={styles.captureHeader}>
        <Text style={styles.captureTitle}>Capture</Text>
        <View style={styles.headerActions}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onNewCapture} style={styles.newCaptureButton}>
            <Text style={styles.newCaptureText}>New</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.photoPanel, { height: Math.round(windowHeight * 0.32) }]}>
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
              onPress={() => setFocusedRegionId(region.id)}
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

      <ScrollView style={styles.reviewBody} contentContainerStyle={styles.textContent} keyboardShouldPersistTaps="handled">
        {(error || notice) && (
          <Text accessibilityLiveRegion="polite" style={error ? styles.errorMessage : styles.noticeMessage}>{error ?? notice}</Text>
        )}

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

        {capture.status !== 'processing' && !kept.length && (
          <View style={styles.manualEntry}>
            <Text style={styles.sectionLabel}>{capture.regions.length ? 'ALL ROWS REMOVED' : 'NO TEXT FOUND'}</Text>
            <Text style={styles.helperText}>Type the Japanese you want to keep{capture.regions.length ? ', or restore removed rows below' : ''}.</Text>
            <TextInput
              editable={!busy}
              accessibilityLabel="Enter text manually"
              multiline
              onChangeText={(correctedText) => applyEdit(updateManualCorrection(capture, correctedText))}
              placeholder="Enter Japanese text"
              placeholderTextColor="#929991"
              style={styles.inlineEditor}
              textAlignVertical="top"
              value={capture.correctedText}
            />
          </View>
        )}

        {units.length > 0 && (
          <Text style={styles.sectionLabel}>{rows.length} {rows.length === 1 ? 'ROW' : 'ROWS'} · {savedRowCount} SAVED</Text>
        )}
        {units.map((group) => paragraphs.includes(group) ? paragraphCard(group) : rowCard(group))}

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

        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showRaw }} onPress={() => setShowRaw((current) => !current)} style={styles.disclosureButton}>
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
      </ScrollView>
    </View>
  );
}
