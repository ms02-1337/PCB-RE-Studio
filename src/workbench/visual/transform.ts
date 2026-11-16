// Pure visual-image transform pipeline. The order is FIXED and mirrors the
// Board-mapping precedent (docs/decisions/0003): perspective (INNERMOST,
// source px → straightened source px, set only by Deskew) → crop (source px)
// → per-axis scale (source axes) → rotation (degrees CW) → flipH/flipV in
// the displayed (post-rotation) axes → align warp (left-composed, set only
// by 4-point Align), then translation.
// Everything applies about the CROP-RECT CENTER so an identity transform
// renders exactly like the legacy x/y top-left placement:
//
//   p'           = P(p)                        (when image.perspective exists)
//   local origin = crop center                 p_local = p' − (cx+cw/2, cy+ch/2)
//   linear L     = warp · F(flipH,flipV) · R(rotation) · S(scaleX,scaleY)
//   anchor t     = (x + cx + cw/2, y + cy + ch/2)
//   world        = L · p_local + t
//
// Render recipe (identity perspective): ctx.translate(t) · ctx.transform(L) ·
// drawImage(bitmap, cropSrcRect, (−cw/2, −ch/2, cw, ch)). With a perspective
// the affine above is reproduced per-mesh-triangle instead (see
// perspectiveMesh / affineFromTriangle in this module). Every other tool
// (Align warp' = A·warp, Rotate, Resize, mirror) rewrites only the linear
// part L and the anchor OUTSIDE P — perspective is never rewritten by them.
// Mirroring (negative warp determinant) is valid: back-side photos align
// through the same math. This module is pure — no DOM, no store access.

import type { CropRect, Point } from "../placement/projectDoc";
import type { Perspective3, VisualImage, Warp2 } from "./model";

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

/** Source-image px → world px through the fixed pipeline. The perspective
 * (when present) applies INNERMOST: p' = P(p) feeds the legacy affine. */
export function sourceToWorld(image: VisualImage, p: Point): Point {
  const q = image.perspective ? applyPerspective(image.perspective, p) : p;
  const r = visualCropRect(image);
  const L = imageLinear(image);
  const t = imageAnchor(image);
  const u = q.x - (r.x + r.w / 2);
  const v = q.y - (r.y + r.h / 2);
  return { x: L.a * u + L.c * v + t.x, y: L.b * u + L.d * v + t.y };
}

/** Exact inverse of sourceToWorld (world px → source-image px). Must invert
 * the full linear part (warp may skew/mirror), not just its transpose. The
 * affine inverse unwinds to STRAIGHTENED source px; P⁻¹ then maps those back
 * to ORIGINAL source px, so callers keep seeing original-image coordinates
 * (crop containment and the crop tool are unaffected by deskew). */
export function worldToSource(image: VisualImage, p: Point): Point {
  const r = visualCropRect(image);
  const L = imageLinear(image);
  const t = imageAnchor(image);
  const wx = p.x - t.x;
  const wy = p.y - t.y;
  const det = L.a * L.d - L.b * L.c;
  const u = (L.d * wx - L.c * wy) / det;
  const v = (-L.b * wx + L.a * wy) / det;
  const straightened = { x: u + r.x + r.w / 2, y: v + r.y + r.h / 2 };
  return image.perspective
    ? applyPerspective(invertPerspective(image.perspective), straightened)
    : straightened;
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

// ---------------------------------------------------------------------------
// Perspective (Deskew). P is the INNERMOST factor of the pipeline: it maps
// original source px → straightened source px before crop/linear/anchor.
// ---------------------------------------------------------------------------

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** True when P⁻¹ (invertPerspective) exists in the same normalized form:
 * the linear part must be invertible because the adjugate shortcut divides
 * by its determinant. A projective map can be invertible as a 3×3 (|det| > 0)
 * yet collapse every numerator onto a line (singular linear part) while
 * staying pole-free — such a P passes naive validation but would silently
 * NaN every inverse, so it is rejected up front (deskew solve, actions and
 * Rust validation all apply this same test). */
export function isInvertiblePerspective(P: Perspective3): boolean {
  return Math.abs(P.a * P.e - P.b * P.d) > 1e-9;
}

/** Evaluate P at p. Division by the denominator w = 1 + g·x + h·y is
 * unguarded here — callers keep P pole-free over the region of interest
 * (actions.cleanPerspective and deskewHomography enforce it). */
export function applyPerspective(P: Perspective3, p: Point): Point {
  const w = 1 + P.g * p.x + P.h * p.y;
  return { x: (P.a * p.x + P.b * p.y + P.c) / w, y: (P.d * p.x + P.e * p.y + P.f) / w };
}

/** Exact inverse of P via the 3x3 adjugate ÷ det, renormalized so its own
 * h33 = 1. inverse = adj/det has h33 = adj33/det (adj33 = the upper-left 2x2
 * determinant = a·e − b·d), so dividing every entry by that factor leaves
 * exactly adj/adj33. A nonzero full determinant does NOT imply adj33 ≠ 0 (a
 * projective map can be invertible as a 3×3 yet have a singular linear
 * part), so callers must guarantee invertibility via isInvertiblePerspective
 * — the deskew solve, actions.cleanPerspective and Rust validation all apply
 * it — which makes the division and the round-trip exact. */
export function invertPerspective(P: Perspective3): Perspective3 {
  const m = 1 / (P.a * P.e - P.b * P.d);
  return {
    a: (P.e - P.f * P.h) * m,
    b: (P.c * P.h - P.b) * m,
    c: (P.b * P.f - P.c * P.e) * m,
    d: (P.f * P.g - P.d) * m,
    e: (P.a - P.c * P.g) * m,
    f: (P.c * P.d - P.a * P.f) * m,
    g: (P.d * P.h - P.e * P.g) * m,
    h: (P.b * P.g - P.a * P.h) * m,
  };
}

/** Solve the 8x8 projective system for h33 = 1 (each pair contributes two
 * rows: a·x + b·y + c − g·u·x − h·u·y = u and the v-equivalent) by Gaussian
 * elimination with partial pivoting. Null when the input is not 4 finite
 * pairs or a pivot collapses below 1e-9 (collinear/degenerate geometry). */
export function solvePerspective(src: Point[], dst: Point[]): Perspective3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  if (!src.concat(dst).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const n = 8;
  const A: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const u = dst[i].x;
    const v = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    if (!(Math.abs(A[pivot][col]) > 1e-9)) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / A[col][col];
      for (let k = col; k < n; k++) A[row][k] -= factor * A[col][k];
      rhs[row] -= factor * rhs[col];
    }
  }
  const x = new Array<number>(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = rhs[row];
    for (let k = row + 1; k < n; k++) sum -= A[row][k] * x[k];
    x[row] = sum / A[row][row];
  }
  return { a: x[0], b: x[1], c: x[2], d: x[3], e: x[4], f: x[5], g: x[6], h: x[7] };
}

/** Order shuffled quad corners into TL,TR,BR,BL: ascending y (ties by x)
 * splits top/bottom halves, each half sorted by x. */
export function sortQuadCorners(points: Point[]): [Point, Point, Point, Point] {
  const sorted = [...points].sort((p, q) => p.y - q.y || p.x - q.x);
  const top = [sorted[0], sorted[1]].sort((p, q) => p.x - q.x);
  const bottom = [sorted[2], sorted[3]].sort((p, q) => p.x - q.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}

/** True when the quad (TL,TR,BR,BL order) is strictly convex: the four
 * consecutive-edge cross products share one sign and every |cross| > 1e-9.
 * Rejects bowties and collinear corners. */
export function isConvexQuad(quad: Point[]): boolean {
  if (quad.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(Math.abs(cross) > 1e-9)) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Destination rectangle for a deskew solve: an axis-aligned rect centered on
 * the quad centroid whose width averages the TL/TR and BL/BR edge lengths and
 * whose height averages the TL/BL and TR/BR edges, returned as TL,TR,BR,BL
 * corners in the same units as the (already sorted) input quad. */
export function deskewDstRect(quad: Point[]): Point[] {
  const [tl, tr, br, bl] = quad;
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const h = (dist(tl, bl) + dist(tr, br)) / 2;
  const cx = (tl.x + tr.x + br.x + bl.x) / 4;
  const cy = (tl.y + tr.y + br.y + bl.y) / 4;
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

export type DeskewHomography = { perspective: Perspective3 } | { error: string };

/** Build the deskew perspective for a dragged world-space quad: corners go to
 * ORIGINAL source px (through worldToSource), are sorted TL,TR,BR,BL, then
 * checked inside-photo (±1 px tolerance over the full source bounds) and for
 * convexity before solving H: quad → an axis-aligned rect centered on the
 * quad centroid (deskewDstRect). The raw H is finally fit into the image
 * rectangle: its image of the 4 photo corners is scaled by
 * s = min(w/bw, h/bh) × 0.98 and centered, so the straightened photo always
 * lands inside its own source bounds (pole-free over the photo). Errors are
 * user-facing toast strings; the caller keeps the quad for correction. */
export function deskewHomography(image: VisualImage, worldCorners: Point[]): DeskewHomography {
  if (worldCorners.length !== 4) return { error: "Deskew needs four corner handles" };
  const sorted = sortQuadCorners(worldCorners.map((p) => worldToSource(image, p)));
  const w = image.width;
  const h = image.height;
  const inside = sorted.every(
    (p) => p.x >= -1 && p.x <= w + 1 && p.y >= -1 && p.y <= h + 1,
  );
  if (!inside) return { error: "Deskew corners must stay inside the photograph" };
  if (!isConvexQuad(sorted)) return { error: "Deskew corners must form a convex quadrilateral" };
  const H = solvePerspective(sorted, deskewDstRect(sorted));
  if (!H) return { error: "Deskew failed — the corner geometry is degenerate" };
  // Fit: map the photo corners through H, then scale + translate that bbox
  // into the image rect (0.98 margin), folding s·H + offset back into one
  // Perspective3 (offset enters the numerator: +offset·W).
  const mapped = [
    applyPerspective(H, { x: 0, y: 0 }),
    applyPerspective(H, { x: w, y: 0 }),
    applyPerspective(H, { x: w, y: h }),
    applyPerspective(H, { x: 0, y: h }),
  ];
  const bx = Math.min(...mapped.map((p) => p.x));
  const by = Math.min(...mapped.map((p) => p.y));
  const bw = Math.max(...mapped.map((p) => p.x)) - bx;
  const bh = Math.max(...mapped.map((p) => p.y)) - by;
  if (!mapped.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) || !(bw > 1e-9) || !(bh > 1e-9))
    return { error: "Deskew failed — the corner geometry is degenerate" };
  const s = (Math.min(w / bw, h / bh) * 98) / 100;
  const ox = (w - s * bw) / 2 - s * bx;
  const oy = (h - s * bh) / 2 - s * by;
  const perspective = {
    a: s * H.a + ox * H.g,
    b: s * H.b + ox * H.h,
    c: s * H.c + ox,
    d: s * H.d + oy * H.g,
    e: s * H.e + oy * H.h,
    f: s * H.f + oy,
    g: H.g,
    h: H.h,
  };
  // The fit offset enters the linear part, so invertibility must be checked
  // on the FINAL map: a singular linear part would NaN every worldToSource.
  if (!isInvertiblePerspective(perspective))
    return { error: "Deskew failed — the corner geometry is degenerate" };
  return { perspective };
}

/** Exact affine through 3 point pairs (p → q); null on zero-area input.
 * The linear part solves M · (p2−p1, p3−p1) = (q2−q1, q3−q1) in closed form. */
export function affineFromTriangle(src: Point[], dst: Point[]): AffineMatrix | null {
  if (src.length !== 3 || dst.length !== 3) return null;
  const [p1, p2, p3] = src;
  const [q1, q2, q3] = dst;
  const dx2 = p2.x - p1.x, dy2 = p2.y - p1.y;
  const dx3 = p3.x - p1.x, dy3 = p3.y - p1.y;
  const det = dx2 * dy3 - dx3 * dy2;
  if (!(Math.abs(det) > 1e-12)) return null;
  const u2 = q2.x - q1.x, v2 = q2.y - q1.y;
  const u3 = q3.x - q1.x, v3 = q3.y - q1.y;
  const a = (u2 * dy3 - u3 * dy2) / det;
  const c = (u3 * dx2 - u2 * dx3) / det;
  const b = (v2 * dy3 - v3 * dy2) / det;
  const d = (v3 * dx2 - v2 * dx3) / det;
  return {
    a, b, c, d,
    e: q1.x - a * p1.x - c * p1.y,
    f: q1.y - b * p1.x - d * p1.y,
  };
}

export interface MeshTriangle {
  /** Triangle in ORIGINAL source px (over the crop rect). */
  src: [Point, Point, Point];
  /** The same triangle through the composed pipeline (world px). */
  world: [Point, Point, Point];
}

/** Tile the visual crop rect into divisions×divisions cells in ORIGINAL
 * source px, mapping every vertex through the composed pipeline. Each cell
 * becomes 2 triangles sharing the (i+1,j)–(i,j+1) diagonal; the canvas
 * approximates the perspective per triangle with affineFromTriangle. */
export function perspectiveMesh(image: VisualImage, divisions = 12): MeshTriangle[] {
  const triangles: MeshTriangle[] = [];
  if (!(divisions >= 1)) return triangles;
  const r = visualCropRect(image);
  const cols = divisions + 1;
  const src: Point[] = [];
  const world: Point[] = [];
  for (let j = 0; j <= divisions; j++)
    for (let i = 0; i <= divisions; i++) {
      const p = { x: r.x + (r.w * i) / divisions, y: r.y + (r.h * j) / divisions };
      src.push(p);
      world.push(sourceToWorld(image, p));
    }
  const at = (i: number, j: number): number => j * cols + i;
  for (let j = 0; j < divisions; j++)
    for (let i = 0; i < divisions; i++) {
      const tl = at(i, j), tr = at(i + 1, j), br = at(i + 1, j + 1), bl = at(i, j + 1);
      triangles.push({
        src: [src[tl], src[tr], src[bl]],
        world: [world[tl], world[tr], world[bl]],
      });
      triangles.push({
        src: [src[tr], src[br], src[bl]],
        world: [world[tr], world[br], world[bl]],
      });
    }
  return triangles;
}
