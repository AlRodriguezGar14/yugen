import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { containFit } from './geometry';
import type { CaptureRecord, NormalizedBounds } from './types';
import { styles } from './uiStyles';

/** The original photo with only the given source lines outlined; unlinked older texts say so instead of guessing. */
export default function SourcePhoto({ capture, regions }: { capture: CaptureRecord; regions: { id: string; bounds: NormalizedBounds }[] }) {
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState<{ width: number; height: number } | null>(null);
  const fit = containFit(frame, {
    width: capture.imageMetadata.displayWidth ?? loaded?.width ?? capture.imageMetadata.width,
    height: capture.imageMetadata.displayHeight ?? loaded?.height ?? capture.imageMetadata.height,
  });
  return (
    <>
      <View style={styles.sourcePhoto} onLayout={(event) => setFrame(event.nativeEvent.layout)}>
        <Image source={{ uri: capture.imageUri }} style={styles.image} resizeMode="contain" accessibilityLabel="Original photo"
          onLoad={(event) => { if (event.nativeEvent.source) setLoaded(event.nativeEvent.source); }} />
        {fit && regions.map((region) => (
          <View key={region.id} pointerEvents="none" style={[styles.regionOutline, styles.highlightOutline, {
            left: fit.left + region.bounds.x * fit.width,
            top: fit.top + region.bounds.y * fit.height,
            width: Math.max(8, region.bounds.width * fit.width),
            height: Math.max(8, region.bounds.height * fit.height),
          }]} />
        ))}
      </View>
      {!regions.length && <Text style={styles.helperText}>This text is not linked to specific lines of the photo.</Text>}
    </>
  );
}
