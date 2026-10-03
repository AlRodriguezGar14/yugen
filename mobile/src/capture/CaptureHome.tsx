import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { CaptureSource } from './types';
import { colors } from '../theme';
import { styles } from './uiStyles';

export default function CaptureHome({
  busy,
  error,
  notice,
  onChoose,
}: {
  busy: boolean;
  error: string | null;
  notice: string | null;
  onChoose: (source: CaptureSource) => void;
}) {
  return (
    <ScrollView style={styles.homeScroll} contentContainerStyle={styles.homeContent}>
      <View style={styles.header}>
        <View style={styles.brandMark}><Text style={styles.brandKanji}>幽</Text></View>
        <View style={styles.brandCopy}>
          <Text style={styles.eyebrow}>YUGEN · CAPTURE</Text>
          <Text style={styles.heading}>Keep what caught your eye.</Text>
        </View>
      </View>
      <View style={styles.emptyState}>
        <Text style={styles.emptyIndex}>JAPANESE, IN CONTEXT</Text>
        <Text style={styles.emptyTitle}>A sign, menu, or sentence.</Text>
        <Text style={styles.emptyCopy}>Capture a little Japanese text. Choose what matters and keep it for later.</Text>
        <View style={styles.sourceRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take a photo"
            disabled={busy}
            onPress={() => onChoose('camera')}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.disabled]}
          >
            <Text style={styles.buttonKicker}>01</Text>
            <Text style={styles.primaryButtonText}>Take a photo</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose a photo"
            disabled={busy}
            onPress={() => onChoose('library')}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, busy && styles.disabled]}
          >
            <Text style={styles.buttonKicker}>02</Text>
            <Text style={styles.secondaryButtonText}>Choose image</Text>
          </Pressable>
        </View>
        {busy && <ActivityIndicator color={colors.green} style={styles.homeSpinner} />}
        {(error || notice) && (
          <Text accessibilityLiveRegion="polite" style={error ? styles.errorMessage : styles.noticeMessage}>
            {error ?? notice}
          </Text>
        )}
      </View>
      <Text style={styles.privacyNote}>Photos and recognized text stay on this device. Local dictionaries provide readings and meanings.</Text>
    </ScrollView>
  );
}
