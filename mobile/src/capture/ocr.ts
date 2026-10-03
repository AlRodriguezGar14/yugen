import { processImageTextRecognition } from 'react-native-vision-camera-mlkit';
import type { CaptureRegion } from './types';
import { normalizeBounds } from './geometry';

/** Recognizes Japanese lines in the full photo; bounds are fractions of the given image dimensions. */
export async function analyzeJapaneseImage(imageUri: string, imageWidth: number, imageHeight: number) {
  const result = await processImageTextRecognition(imageUri, { language: 'JAPANESE' });
  const regions: CaptureRegion[] = result.blocks.flatMap((block, blockIndex) =>
    block.lines.map((line, lineIndex) => ({
      id: `${blockIndex}:${lineIndex}`,
      text: line.text,
      bounds: normalizeBounds(line.bounds, imageWidth, imageHeight),
      confidence: line.confidence,
    })),
  );

  return { rawText: result.text, regions };
}
