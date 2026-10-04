import type { NormalizedBounds } from './types';

type PixelBounds = { left: number; top: number; bottom?: number; width: number; height: number };
type Point = { x: number; y: number };
type ImageRect = { left: number; top: number; width: number; height: number };

/** Tests the complete brush segment, including fast swipes, against a finding in the displayed image. */
export function brushTouchesBounds(start: Point, end: Point, bounds: NormalizedBounds, image: ImageRect, radius = 22): boolean {
  if (image.width <= 0 || image.height <= 0) return false;
  let near = 0;
  let far = 1;
  const left = image.left + bounds.x * image.width;
  const top = image.top + bounds.y * image.height;
  const limits = [
    [start.x, end.x - start.x, image.left, image.left + image.width],
    [start.y, end.y - start.y, image.top, image.top + image.height],
    [start.x, end.x - start.x, left - radius, left + bounds.width * image.width + radius],
    [start.y, end.y - start.y, top - radius, top + bounds.height * image.height + radius],
  ];
  for (const [origin, delta, min, max] of limits) {
    if (delta === 0) {
      if (origin < min || origin > max) return false;
    } else {
      const first = (min - origin) / delta;
      const last = (max - origin) / delta;
      near = Math.max(near, Math.min(first, last));
      far = Math.min(far, Math.max(first, last));
      if (near > far) return false;
    }
  }
  return true;
}

export function normalizeBounds(bounds: PixelBounds, imageWidth: number, imageHeight: number) {
  if (imageWidth <= 0 || imageHeight <= 0) throw new Error('Image dimensions are unavailable.');

  return {
    x: bounds.left / imageWidth,
    // ML Kit's iOS adapter labels maxY as top and minY as bottom; Android uses ordinary edges.
    y: Math.min(bounds.top, bounds.bottom ?? bounds.top) / imageHeight,
    width: bounds.width / imageWidth,
    height: bounds.height / imageHeight,
  };
}

/** Converts preview-local drag points and the contain-fit image rectangle to source-image fractions. */
export function cropBoundsFromDrag(start: Point, end: Point, image: ImageRect): NormalizedBounds | null {
  const inside = start.x >= image.left && start.x <= image.left + image.width
    && start.y >= image.top && start.y <= image.top + image.height;
  if (!inside || image.width <= 0 || image.height <= 0) return null;

  const left = Math.max(image.left, Math.min(start.x, end.x));
  const top = Math.max(image.top, Math.min(start.y, end.y));
  const right = Math.min(image.left + image.width, Math.max(start.x, end.x));
  const bottom = Math.min(image.top + image.height, Math.max(start.y, end.y));
  if (right - left < 8 || bottom - top < 8) return null;

  return {
    x: (left - image.left) / image.width,
    y: (top - image.top) / image.height,
    width: (right - left) / image.width,
    height: (bottom - top) / image.height,
  };
}

/** Converts source-image fractions to ImageManipulator pixels using source metadata dimensions. */
export function cropBoundsToPixels(bounds: NormalizedBounds, imageWidth: number, imageHeight: number) {
  if (imageWidth <= 0 || imageHeight <= 0) throw new Error('Image dimensions are unavailable.');
  const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(bounds.x * imageWidth)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(bounds.y * imageHeight)));
  const right = Math.max(left + 1, Math.min(imageWidth, Math.ceil((bounds.x + bounds.width) * imageWidth)));
  const bottom = Math.max(top + 1, Math.min(imageHeight, Math.ceil((bounds.y + bounds.height) * imageHeight)));
  return { originX: left, originY: top, width: right - left, height: bottom - top };
}

/** The contain-fit rectangle of an upright image inside a laid-out frame, or null before layout. */
export function containFit(frame: { width: number; height: number }, image: { width: number; height: number }): ImageRect | null {
  const scale = Math.min(frame.width / image.width, frame.height / image.height);
  if (!(frame.width > 0 && frame.height > 0 && Number.isFinite(scale) && scale > 0)) return null;
  return { left: (frame.width - image.width * scale) / 2, top: (frame.height - image.height * scale) / 2, width: image.width * scale, height: image.height * scale };
}

/**
 * Size that fits ML Kit's static-image limits (Android rejects images over 4 MP or 4,096 px;
 * iOS silently downsamples). Returns null when the image already fits.
 */
export function ocrResizeFor(width: number, height: number, maxPixels = 4_000_000, maxDimension = 4_096) {
  const scale = Math.min(1, maxDimension / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return scale < 1 ? { width: Math.floor(width * scale), height: Math.floor(height * scale) } : null;
}

/** Maps bounds in temporary-crop coordinates back into the original source-image coordinate space. */
export function mapCropBoundsToImage(bounds: NormalizedBounds, crop: NormalizedBounds): NormalizedBounds {
  return {
    x: crop.x + bounds.x * crop.width,
    y: crop.y + bounds.y * crop.height,
    width: bounds.width * crop.width,
    height: bounds.height * crop.height,
  };
}
