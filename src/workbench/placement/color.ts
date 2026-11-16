// Type color helpers: #rrggbb parsing, alpha fills, and YIQ-contrast labels.

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function isValidColor(color: string): boolean {
  return HEX.test(color);
}

export function parseColor(color: string): Rgb | null {
  if (!isValidColor(color)) return null;
  return {
    r: Number.parseInt(color.slice(1, 3), 16),
    g: Number.parseInt(color.slice(3, 5), 16),
    b: Number.parseInt(color.slice(5, 7), 16),
  };
}

export function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** YIQ perceived luminance; dark text on light type colors, light on dark. */
export function labelColor(color: string): string {
  const rgb = parseColor(color);
  if (!rgb) return "#f9fafb";
  const yiq = (299 * rgb.r + 587 * rgb.g + 114 * rgb.b) / 1000;
  return yiq >= 128 ? "#111827" : "#f9fafb";
}

/** Fixed pleasant palette for random default colors of new types. */
export const COLOR_PALETTE = [
  "#e5484d",
  "#e08a2e",
  "#d9a406",
  "#52b788",
  "#2fbfa8",
  "#40c4e0",
  "#4f8fdb",
  "#9b6dff",
  "#d16ba5",
  "#7a9e4f",
];

/** Random palette pick for the silent default color of a new type. */
export function randomPaletteColor(): string {
  return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)] ?? "#8a8a8a";
}
