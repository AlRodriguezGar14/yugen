import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { excludeRegions, restoreRegion as restoreCaptureRegion, toggleRegionSelection, updateManualCorrection, updateRegionCorrection } from './review';
import { analysisFailureMessage, requestJapaneseAnalysis } from './analysis';
import { brushTouchesBounds, containFit } from './geometry';
import { ANALYSIS_CONTRACT_VERSION, type AnalysisResponse, type AnalysisTokenReview, type CaptureRecord } from './types';
import AnalysisReadingsAndMeanings from './CaptureAnalysisPreview';
import { styles } from './uiStyles';
import { colors } from '../theme';

/**
 * Photo-first review: the original photo with its recognized lines, the raw OCR kept unchanged,
 * and every recognized line kept with its own correction stored separately. An optional brush removes unwanted lines.
 * The kept text shows local furigana and dictionary meanings.
 */
export default function CaptureReview({
  capture,
  busy,
  error,
  notice,
  onChange,
  onNewCapture,
  onRetry,
}: {
  capture: CaptureRecord;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onChange: (capture: CaptureRecord) => void;
  onNewCapture: () => void;
  onRetry: () => void;
}) {
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
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResponse>>({});
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const [analysisAttempt, setAnalysisAttempt] = useState(0);
  // Dictionary choices belong to one exact text; editing the text discards them.
  const [reviews, setReviews] = useState<Record<string, Record<string, AnalysisTokenReview>>>({});
  const analysesRef = useRef(analyses);
  useEffect(() => { analysesRef.current = analyses; }, [analyses]);
  const studyText = capture.correctedText;

  // Load readings once per exact kept text.
  useEffect(() => {
    if (!studyText.trim() || analysesRef.current[studyText]) return undefined;
    let active = true;
    Promise.resolve().then(async () => {
      // Typing edits the text on every keystroke; analyze once it settles.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!active) return;
      try {
        const analysis = await requestJapaneseAnalysis({ contractVersion: ANALYSIS_CONTRACT_VERSION, language: capture.language, text: studyText });
        // Readings stay valid for their exact text even if the text changed meanwhile.
        setAnalyses((current) => ({ ...current, [studyText]: analysis }));
      } catch (cause) {
        console.warn('Yugen readings failed', cause);
        if (active) setAnalysisErrors((current) => ({ ...current, [studyText]: analysisFailureMessage(cause) }));
      }
    });
    return () => { active = false; };
  }, [capture.language, studyText, analysisAttempt]);
  const kept = capture.regions.filter((region) => !region.review?.excluded);
  const excluded = capture.regions.filter((region) => region.review?.excluded);

  function applyEdit(record: CaptureRecord) {
    // A previous whole-stroke snapshot must never erase a later correction.
    setUndoHistory([]);
    currentCapture.current = record;
    onChange(record);
  }

  function chooseCandidate(index: number, dictionaryCandidateId: string) {
    setReviews((current) => ({ ...current, [studyText]: { ...current[studyText], [index]: { ignored: current[studyText]?.[index]?.ignored ?? false, dictionaryCandidateId } } }));
  }

  function retryReadings() {
    setAnalysisErrors({});
    setAnalysisAttempt((attempt) => attempt + 1);
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
              accessibilityLabel={`Keep or skip line ${index + 1}: ${region.review?.correctedText ?? region.text}`}
              disabled={busy || brushEnabled || !!region.review?.excluded}
              onPress={() => applyEdit(toggleRegionSelection(capture, region.id))}
              style={[
                styles.regionOutline,
                region.review?.selected && styles.highlightOutline,
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

        {kept.map((region) => {
          const selected = !!region.review?.selected;
          return (
            <View key={region.id} style={[styles.findingCard, selected && styles.selectedFinding]}>
              <View style={styles.findingHeader}>
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Keep line ${capture.regions.indexOf(region) + 1}`}
                  disabled={busy} onPress={() => applyEdit(toggleRegionSelection(capture, region.id))} style={styles.findingSelect}>
                  <View style={[styles.checkbox, selected && styles.checkboxSelected]}>{selected && <Text style={styles.checkboxMark}>✓</Text>}</View>
                </Pressable>
                <View style={styles.findingTextButton}>
                  <Text style={styles.sectionLabel}>LINE {capture.regions.indexOf(region) + 1}{selected ? ' · KEPT' : ''}</Text>
                  <Text style={styles.findingRaw}>{region.text}</Text>
                </View>
              </View>
              {selected && (
                <>
                  <TextInput
                    editable={!busy}
                    accessibilityLabel="Corrected text for this line"
                    multiline
                    onChangeText={(value) => applyEdit(updateRegionCorrection(capture, region.id, value))}
                    placeholder="Correct this line"
                    placeholderTextColor="#929991"
                    style={styles.inlineEditor}
                    textAlignVertical="top"
                    value={region.review?.correctedText ?? region.text}
                  />
                  {region.confidence !== null && <Text style={styles.confidence}>OCR confidence {Math.round(region.confidence * 100)}%</Text>}
                </>
              )}
            </View>
          );
        })}

        {capture.status !== 'processing' && !!studyText.trim() && (
          <View style={styles.findingCard}>
            <Text style={styles.sectionLabel}>KEPT TEXT · LOCAL READINGS</Text>
            <AnalysisReadingsAndMeanings
              key={studyText}
              text={studyText}
              analysis={analyses[studyText] ?? null}
              busy={!analyses[studyText] && !analysisErrors[studyText]}
              error={analyses[studyText] ? null : analysisErrors[studyText] ?? null}
              choices={Object.fromEntries(Object.entries(reviews[studyText] ?? {}).flatMap(([index, review]) => review.dictionaryCandidateId ? [[index, review.dictionaryCandidateId]] : []))}
              onChooseCandidate={chooseCandidate}
              onRetry={retryReadings}
              onEnrichCharacters={(index, details) => setAnalyses((current) => current[studyText] ? { ...current, [studyText]: { ...current[studyText], tokens: current[studyText].tokens.map((token, tokenIndex) => tokenIndex === index ? { ...token, kanjiDetails: details } : token) } } : current)}
              showHeading
            />
          </View>
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
