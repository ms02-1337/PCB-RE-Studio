// Pure board transform pipeline. The order is FIXED: crop (image px) →
// rotation (degrees clockwise, finite in [0, 360)) → flipH/flipV (displayed
// axes) → uniform scale (percent/100), then scene translation. Shapes stay in
// ORIGINAL image pixels; these helpers map image px ↔ display px, and compose
// with the view (screen = display × view.scale + view.offset).

import type { Board, CropRect, Point } from "./projectDoc";
import type { View } from "./view";

/** Degrees clockwise; finite, [0, 360). Quarter turns are written as exact
 * integers by the store. */
export type Rotation = number;

/** Rotation in degrees → unit vectors of the rotated basis. Quarter turns
 * snap to exact values so legacy files keep byte-identical results (cos 90°
 * is ~6.1e-17, not 0). */
function rotationBasis(degrees: Rotation): { c: number; s: number } {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) return { c: 1, s: 0 };
  if (normalized === 90) return { c: 0, s: 1 };
  if (normalized === 180) return { c: -1, s: 0 };
  if (normalized === 270) return { c: 0, s: -1 };
  const radians = (normalized * Math.PI) / 180;
  return { c: Math.cos(radians), s: Math.sin(radians) };
}

/** Axis-aligned bounding box of a w×h rect rotated by the given basis:
 * (|w·c| + |h·s|, |w·s| + |h·c|). */
function rotatedBox(w: number, h: number, c: number, s: number): { w: number; h: number } {
  return { w: Math.abs(w * c) + Math.abs(h * s), h: Math.abs(w * s) + Math.abs(h * c) };
}

/** Normalized transform: defaults filled in, `crop: null` = full image. */
export interface BoardTransform {
  crop: CropRect | null;
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** Percent (10-800 per schema validation). */
  scale: number;
  locked: boolean;
}

/** Canvas-order affine matrix (for ctx.setTransform):
 * x' = a·x + c·y + e; y' = b·x + d·y + f. */
export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function effectiveBoardTransform(board: Board): BoardTransform {
  return {
    crop: board.crop ?? null,
    rotation: board.rotation ?? 0,
    flipH: board.flipH ?? false,
    flipV: board.flipV ?? false,
    scale: typeof board.scale === "number" ? board.scale : 100,
    locked: board.locked ?? false,
  };
}

/** The visible region in ORIGINAL image px (crop rect or the full image). */
export function visibleImageRect(board: Board): CropRect {
  const t = effectiveBoardTransform(board);
  return t.crop ?? { x: 0, y: 0, w: board.width, h: board.height };
}

/** Displayed size: AABB of the cropped rect rotated by θ, × scale/100. */
export function displaySize(board: Board): { width: number; height: number } {
  const t = effectiveBoardTransform(board);
  const crop = t.crop ?? { x: 0, y: 0, w: board.width, h: board.height };
  const { c, s } = rotationBasis(t.rotation);
  const box = rotatedBox(crop.w, crop.h, c, s);
  const factor = t.scale / 100;
  return { width: box.w * factor, height: box.h * factor };
}

/** Image px → display px through the fixed pipeline (crop→rotate→flip→scale).
 * Rotation is about the visible rect's center; the rotated AABB's top-left
 * lands at (sceneX, sceneY). Identical (exactly) to the legacy quarter-turn
 * math at 0/90/180/270. */
export function imageToDisplay(board: Board, p: Point): Point {
  const t = effectiveBoardTransform(board);
  const crop = t.crop ?? { x: 0, y: 0, w: board.width, h: board.height };
  const w = crop.w;
  const h = crop.h;
  const { c, s } = rotationBasis(t.rotation);
  const box = rotatedBox(w, h, c, s);
  // Crop-local → rotate about the rect center → anchor the AABB at the origin.
  const u = p.x - crop.x - w / 2;
  const v = p.y - crop.y - h / 2;
  let x = c * u - s * v + box.w / 2;
  let y = s * u + c * v + box.h / 2;
  // Flips mirror the displayed (rotated) axes.
  if (t.flipH) x = box.w - x;
  if (t.flipV) y = box.h - y;
  const factor = t.scale / 100;
  return { x: x * factor + (board.sceneX ?? 0), y: y * factor + (board.sceneY ?? 0) };
}

/** Exact algebraic inverse of imageToDisplay (display px → image px). */
export function displayToImage(board: Board, p: Point): Point {
  const t = effectiveBoardTransform(board);
  const crop = t.crop ?? { x: 0, y: 0, w: board.width, h: board.height };
  const w = crop.w;
  const h = crop.h;
  const { c, s } = rotationBasis(t.rotation);
  const box = rotatedBox(w, h, c, s);
  const factor = t.scale / 100;
  let x = (p.x - (board.sceneX ?? 0)) / factor;
  let y = (p.y - (board.sceneY ?? 0)) / factor;
  // Undo flips (mirroring is its own inverse).
  if (t.flipH) x = box.w - x;
  if (t.flipV) y = box.h - y;
  // Undo the rotation: the rotated basis is orthonormal, so invert by
  // applying its transpose, then re-center and restore the crop origin.
  const xr = x - box.w / 2;
  const yr = y - box.h / 2;
  return { x: c * xr + s * yr + w / 2 + crop.x, y: -s * xr + c * yr + h / 2 + crop.y };
}

/** Image px → screen (CSS) px: the board transform composed with the view. */
export function imageToScreen(view: View, board: Board, p: Point): Point {
  const d = imageToDisplay(board, p);
  return { x: d.x * view.scale + view.offsetX, y: d.y * view.scale + view.offsetY };
}

/** Affine matrix for image px → screen px (view applied after the board
 * transform); pass multiplied by devicePixelRatio to ctx.setTransform. */
export function imageToScreenMatrix(view: View, board: Board): AffineMatrix {
  const origin = imageToScreen(view, board, { x: 0, y: 0 });
  const i = imageToScreen(view, board, { x: 1, y: 0 });
  const j = imageToScreen(view, board, { x: 0, y: 1 });
  return {
    a: i.x - origin.x,
    b: i.y - origin.y,
    c: j.x - origin.x,
    d: j.y - origin.y,
    e: origin.x,
    f: origin.y,
  };
}
