type PixelBounds = { left: number; top: number; width: number; height: number };
type ImageRect = { left: number; top: number; width: number; height: number };

export function normalizeBounds(bounds: PixelBounds, imageWidth: number, imageHeight: number) {
  if (imageWidth <= 0 || imageHeight <= 0) throw new Error('Image dimensions are unavailable.');

  return {
    x: bounds.left / imageWidth,
    y: bounds.top / imageHeight,
    width: bounds.width / imageWidth,
    height: bounds.height / imageHeight,
  };
}

/** The contain-fit rectangle of an upright image inside a laid-out frame, or null before layout. */
export function containFit(frame: { width: number; height: number }, image: { width: number; height: number }): ImageRect | null {
  const scale = Math.min(frame.width / image.width, frame.height / image.height);
  if (!(frame.width > 0 && frame.height > 0 && Number.isFinite(scale) && scale > 0)) return null;
  return { left: (frame.width - image.width * scale) / 2, top: (frame.height - image.height * scale) / 2, width: image.width * scale, height: image.height * scale };
}
