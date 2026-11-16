// Pure visual-image transform pipeline. The order is FIXED and mirrors the
// Board-mapping precedent (docs/decisions/0003): crop (source-image px) →
// per-axis scale (source axes) → rotation (degrees CW) → flipH/flipV in the
// displayed (post-rotation) axes → align warp (left-composed, set only by
// 4-point Align), then translation.
// Everything applies about the CROP-RECT CENTER so an identity transform
// renders exactly like the legacy x/y top-left placement:
//
//   local origin = crop center            p_local = p_source − (cx+cw/2, cy+ch/2)
//   linear L     = warp · F(flipH,flipV) · R(rotation) · S(scaleX,scaleY)
//   anchor t     = (x + cx + cw/2, y + cy + ch/2)
//   world        = L · p_local + t
//
// Render recipe: ctx.translate(t) · ctx.transform(L) ·
// drawImage(bitmap, cropSrcRect, (−cw/2, −ch/2, cw, ch)).
// Mirroring (negative warp determinant) is valid: back-side photos align
// through the same math. This module is pure — no DOM, no store access.

import type { CropRect, Point } from "../placement/projectDoc";
import type { VisualImage, Warp2 } from "./model";

/** Canvas-order affine matrix (x' = a·x + c·y + e; y' = b·x + d·y + f),
 * the same shape as placement/boardTransform.ts. */
export interface AffineMatrix { a: number; b: number; c: number; d: number; e: number; f: number }

/** Normalized transform: defaults filled in; `warp: null` = identity. */
export interface VisualTransform {
  crop: CropRect;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  scaleX: number;
  scaleY: number;
  warp: Warp2 | null;
}

// ---------------------------------------------------------------------------
// Signatures below are a FROZEN contract; every function is implemented and
// unit-tested against the invariants documented here.
// ---------------------------------------------------------------------------

/** Defaults filled in from the image record (crop = full image, rotation 0,
 * scales 1, warp null when fields are absent). */
export function effectiveVisualTransform(image: VisualImage): VisualTransform {
  return {
    crop: visualCropRect(image),
    rotation: image.rotation ?? 0,
    flipH: image.flipH ?? false,
    flipV: image.flipV ?? false,
    scaleX: image.scaleX ?? 1,
    scaleY: image.scaleY ?? 1,
    warp: image.warp ?? null,
  };
}

/** Clamp-and-round one endpoint of a crop span into [lo, hi]. */
function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/** Resolved crop rect: `image.crop` clamped into the source bounds, or the
 * full-image rect when absent. Integer fields. */
export function visualCropRect(image: VisualImage): CropRect {
  const crop = image.crop;
  if (!crop) return { x: 0, y: 0, w: image.width, h: image.height };
  const x0 = clampInt(Math.min(crop.x, crop.x + crop.w), 0, image.width);
  const x1 = clampInt(Math.max(crop.x, crop.x + crop.w), 0, image.width);
  const y0 = clampInt(Math.min(crop.y, crop.y + crop.h), 0, image.height);
  const y1 = clampInt(Math.max(crop.y, crop.y + crop.h), 0, image.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Canvas-order 2x2 product m1 · m2 (m2 applies first to source vectors). */
function mul2(m1: Warp2, m2: Warp2): Warp2 {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
  };
}

/** The linear part L = warp · F(flipH,flipV) · R(rotation) · S(scaleX,scaleY)
 * as a 2x2 in canvas order: per-axis scale applies first (source axes), then
 * rotation, then the flips in the displayed (post-rotation) axes — the
 * Board-mapping precedence; warp is the outer factor. */
export function imageLinear(image: VisualImage): Warp2 {
  const t = effectiveVisualTransform(image);
  const flip: Warp2 = { a: t.flipH ? -1 : 1, b: 0, c: 0, d: t.flipV ? -1 : 1 };
  const scale: Warp2 = { a: t.scaleX, b: 0, c: 0, d: t.scaleY };
  // S applies first (source px units), then R, then F; warp is the outer factor.
  const pipeline = mul2(flip, mul2(rotationMatrix(t.rotation), scale));
  return t.warp ? mul2(t.warp, pipeline) : pipeline;
}

/** World-space anchor t = (x + cx + cw/2, y + cy + ch/2): the world position
 * of the crop-rect center before any linear transform. */
export function imageAnchor(image: VisualImage): Point {
  const r = visualCropRect(image);
  return { x: image.x + r.x + r.w / 2, y: image.y + r.y + r.h / 2 };
}

/** Source-image px → world px through the fixed pipeline. */
export function sourceToWorld(image: VisualImage, p: Point): Point {
  const r = visualCropRect(image);
  const L = imageLinear(image);
  const t = imageAnchor(image);
  const u = p.x - (r.x + r.w / 2);
  const v = p.y - (r.y + r.h / 2);
  return { x: L.a * u + L.c * v + t.x, y: L.b * u + L.d * v + t.y };
}

/** Exact inverse of sourceToWorld (world px → source-image px). Must invert
 * the full linear part (warp may skew/mirror), not just its transpose. */
export function worldToSource(image: VisualImage, p: Point): Point {
  const r = visualCropRect(image);
  const L = imageLinear(image);
  const t = imageAnchor(image);
  const wx = p.x - t.x;
  const wy = p.y - t.y;
  const det = L.a * L.d - L.b * L.c;
  const u = (L.d * wx - L.c * wy) / det;
  const v = (-L.b * wx + L.a * wy) / det;
  return { x: u + r.x + r.w / 2, y: v + r.y + r.h / 2 };
}

/** The 4 crop-rect corners mapped to world space (render/hit footprint). */
export function worldFootprint(image: VisualImage): Point[] {
  const r = visualCropRect(image);
  return [
    sourceToWorld(image, { x: r.x, y: r.y }),
    sourceToWorld(image, { x: r.x + r.w, y: r.y }),
    sourceToWorld(image, { x: r.x + r.w, y: r.y + r.h }),
    sourceToWorld(image, { x: r.x, y: r.y + r.h }),
  ];
}

/** Union axis-aligned bounding box of the world footprints of the given
 * images (used by Fit and empty-space checks). */
export function worldAabb(images: VisualImage[]): { left: number; top: number; right: number; bottom: number } {
  if (!images.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const image of images) {
    for (const p of worldFootprint(image)) {
      if (p.x < left) left = p.x;
      if (p.x > right) right = p.x;
      if (p.y < top) top = p.y;
      if (p.y > bottom) bottom = p.y;
    }
  }
  return { left, top, right, bottom };
}

/** 3x3 determinant. */
function det3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/** Least-squares affine mapping src[i] → dst[i] (normal equations on the 3x3
 * moment matrix, exactly the reference algorithm). Returns null when the
 * system is degenerate (|det| < 1e-6 — collinear or coincident points).
 * Overdetermined input (≠ 4 pairs, if ever needed) still yields the LSQ fit. */
export function solveAffine(src: Point[], dst: Point[]): AffineMatrix | null {
  if (src.length === 0 || src.length !== dst.length) return null;
  const Bx = [0, 0, 0];
  const By = [0, 0, 0];
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0;
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    const u = dst[i].x;
    const v = dst[i].y;
    Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y;
    Bx[0] += x * u; Bx[1] += y * u; Bx[2] += u;
    By[0] += x * v; By[1] += y * v; By[2] += v;
  }
  const M = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx, Sy, src.length],
  ];
  const D = det3(M);
  if (Math.abs(D) < 1e-6) return null;
  // Cramer's rule: substitute the RHS into column k, divide by D.
  const solve = (b: number[]): [number, number, number] => {
    const cols = [0, 1, 2].map((k) => {
      const Mk = M.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)));
      return det3(Mk) / D;
    });
    return [cols[0], cols[1], cols[2]];
  };
  const [a, c, e] = solve(Bx); // u = a·x + c·y + e
  const [b, d, f] = solve(By); // v = b·x + d·y + f
  return { a, b, c, d, e, f };
}

/** Max over i of |T(src[i]) − dst[i]| in px, for the residual report. */
export function maxResidualPx(t: AffineMatrix, src: Point[], dst: Point[]): number {
  let max = 0;
  for (let i = 0; i < src.length && i < dst.length; i++) {
    const s = src[i];
    const d = dst[i];
    max = Math.max(max, Math.hypot(t.a * s.x + t.c * s.y + t.e - d.x, t.b * s.x + t.d * s.y + t.f - d.y));
  }
  return max;
}

/** m · (base ?? I) — left-composition used by Align (A·warp), Rotate-on-warped
 * (R(δ)·warp) and Resize (diag(fx,fy)·warp). Canvas-order 2x2 multiply. */
export function composeWarpLeft(base: Warp2 | null, m: Warp2): Warp2 {
  const b: Warp2 = base ?? { a: 1, b: 0, c: 0, d: 1 };
  return {
    a: m.a * b.a + m.c * b.b,
    b: m.b * b.a + m.d * b.b,
    c: m.a * b.c + m.c * b.d,
    d: m.b * b.c + m.d * b.d,
  };
}

/** Rotation matrix R(deg) CW in canvas coordinates (positive y is down, so
 * CW on screen = positive angle with the standard canvas transform). */
export function rotationMatrix(deg: number): Warp2 {
  const radians = (deg * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { a: c, b: s, c: -s, d: c };
}

/** Map any finite degrees into [0, 360): −90 → 270, 360 → 0, 720.5 → 0.5. */
export function normalizeRotation(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Snap degrees to the nearest multiple of 15 (Shift-drag on the gizmo). */
export function snap15(deg: number): number {
  return Math.round(deg / 15) * 15 || 0; // || 0 maps −0 to +0
}

/** Given a dragged "level this" line a→b (world space), return the rotation
 * delta (degrees, |delta| ≤ 45) that makes the line axis-aligned and which
 * axis (horizontal/vertical) it snaps to. Null when the line is too short
 * (caller decides the threshold in screen px). */
export function levelLine(a: Point, b: Point): { deltaDeg: number; axis: "horizontal" | "vertical" } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return null; // direction undefined; caller gates length
  const ang = Math.atan2(dy, dx);
  const target = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
  const delta = target - ang;
  return {
    deltaDeg: (delta * 180) / Math.PI,
    axis: Math.abs(Math.cos(target)) > 0.5 ? "horizontal" : "vertical",
  };
}
