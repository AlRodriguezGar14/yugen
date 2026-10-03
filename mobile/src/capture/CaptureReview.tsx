import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { selectSingleRegion, updateManualCorrection, updateRegionCorrection } from './review';
import { containFit } from './geometry';
import type { CaptureRecord } from './types';
import { styles } from './uiStyles';
import { colors } from '../theme';

/**
 * Photo-first review: the original photo with its recognized lines, the raw OCR kept unchanged,
 * and a correction of the chosen line stored separately.
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
  const [showRaw, setShowRaw] = useState(false);
  const imageFit = containFit(previewFrame, { width: capture.imageMetadata.width, height: capture.imageMetadata.height });

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
          <Image source={{ uri: capture.imageUri }} style={styles.image} resizeMode="contain" accessibilityLabel="Captured text image" />
          {imageFit && capture.regions.map((region, index) => (
            <Pressable
              key={region.id}
              accessibilityRole="button"
              accessibilityLabel={`Choose line ${index + 1}: ${region.review?.correctedText ?? region.text}`}
              disabled={busy}
              onPress={() => onChange(selectSingleRegion(capture, region.id))}
              style={[
                styles.regionOutline,
                region.review?.selected && styles.highlightOutline,
                {
                  left: imageFit.left + region.bounds.x * imageFit.width,
                  top: imageFit.top + region.bounds.y * imageFit.height,
                  width: Math.max(8, region.bounds.width * imageFit.width),
                  height: Math.max(8, region.bounds.height * imageFit.height),
                },
              ]}
            />
          ))}
          {capture.status === 'processing' && <View style={styles.photoStatus}><ActivityIndicator color={colors.ink} /><Text style={styles.helperText}>Reading text…</Text></View>}
        </View>
      </View>

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

        {capture.status !== 'processing' && !capture.regions.length && (
          <View style={styles.manualEntry}>
            <Text style={styles.sectionLabel}>NO TEXT FOUND</Text>
            <Text style={styles.helperText}>Type the Japanese you want to keep.</Text>
            <TextInput
              editable={!busy}
              accessibilityLabel="Enter text manually"
              multiline
              onChangeText={(correctedText) => onChange(updateManualCorrection(capture, correctedText))}
              placeholder="Enter Japanese text"
              placeholderTextColor="#929991"
              style={styles.inlineEditor}
              textAlignVertical="top"
              value={capture.correctedText}
            />
          </View>
        )}

        {capture.regions.map((region, index) => {
          const selected = !!region.review?.selected;
          return (
            <View key={region.id} style={[styles.findingCard, selected && styles.selectedFinding]}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected }} disabled={busy} onPress={() => onChange(selectSingleRegion(capture, region.id))} style={styles.findingTextButton}>
                <Text style={styles.sectionLabel}>LINE {index + 1}{selected ? ' · CHOSEN' : ''}</Text>
                <Text style={styles.findingRaw}>{region.text}</Text>
              </Pressable>
              {selected && (
                <>
                  <TextInput
                    editable={!busy}
                    accessibilityLabel="Corrected text for this line"
                    multiline
                    onChangeText={(value) => onChange(updateRegionCorrection(capture, region.id, value))}
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
