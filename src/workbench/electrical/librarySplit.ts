/** Pixel minima win in short layouts, which scroll rather than crushing panels. */
export function librarySplit(availableHeight: number, ratio: number) {
  const height = Math.max(320, Number.isFinite(availableHeight) ? availableHeight : 320);
  const min = Math.max(120, height * 0.2);
  const max = Math.max(min, Math.min(height - 200, height * 0.65));
  const size = Math.max(min, Math.min(max, height * ratio));
  return { height, min, max, size };
}
