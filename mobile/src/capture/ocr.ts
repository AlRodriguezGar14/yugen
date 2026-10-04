import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { processImageTextRecognition } from 'react-native-vision-camera-mlkit';
import type { CaptureRegion, NormalizedBounds } from './types';
import { cropBoundsToPixels, mapCropBoundsToImage, normalizeBounds, ocrResizeFor } from './geometry';

/** Recognizes the full photo by default; retained legacy crops still map to the original image. */
export async function analyzeJapaneseImage(
  imageUri: string,
  _imageWidth: number,
  _imageHeight: number,
  cropBounds: NormalizedBounds = { x: 0, y: 0, width: 1, height: 1 },
) {
  const source = ImageManipulator.manipulate(imageUri);
  let upright: Awaited<ReturnType<typeof source.renderAsync>> | null = null;
  let crop: ReturnType<typeof ImageManipulator.manipulate> | null = null;
  let image: Awaited<ReturnType<typeof source.renderAsync>> | null = null;
  let croppedUri: string | null = null;
  try {
    // Render orientation first: encoded JPEG dimensions can be swapped by EXIF rotation.
    upright = await source.renderAsync();
    const fullImage = cropBounds.x === 0 && cropBounds.y === 0 && cropBounds.width === 1 && cropBounds.height === 1;
    const pixels = fullImage ? null : cropBoundsToPixels(cropBounds, upright.width, upright.height);
    const resize = ocrResizeFor(pixels?.width ?? upright.width, pixels?.height ?? upright.height);
    if (!pixels && !resize) image = upright;
    else {
      // Camera photos exceed ML Kit's static-image limit; bounds are fractions, so downscaling is lossless for overlays.
      crop = ImageManipulator.manipulate(upright);
      if (pixels) crop = crop.crop(pixels);
      if (resize) crop = crop.resize(resize);
      image = await crop.renderAsync();
    }
    const renderedImage = image;
    const cropped = await renderedImage.saveAsync({ format: SaveFormat.JPEG, compress: 1 });
    croppedUri = cropped.uri;
    const result = await processImageTextRecognition(cropped.uri, { language: 'JAPANESE' });
    const regions: CaptureRegion[] = result.blocks.flatMap((block, blockIndex) =>
      block.lines.map((line, lineIndex) => ({
        id: `${blockIndex}:${lineIndex}`,
        text: line.text,
        bounds: mapCropBoundsToImage(
          normalizeBounds(line.bounds, renderedImage.width, renderedImage.height),
          cropBounds,
        ),
        confidence: line.confidence,
      })),
    );

    return { rawText: result.text, regions, imageDimensions: { width: upright.width, height: upright.height } };
  } finally {
    if (image !== upright) image?.release();
    upright?.release();
    crop?.release();
    source.release();
    if (croppedUri) {
      try {
        new File(croppedUri).delete();
      } catch {
        // Cleanup must not mask the OCR result.
      }
    }
  }
}
