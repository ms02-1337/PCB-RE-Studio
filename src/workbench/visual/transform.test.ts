// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Point } from "../placement/projectDoc";
import type { Perspective3, VisualImage, Warp2 } from "./model";
import {
  affineFromTriangle,
  applyPerspective,
  deskewDstRect,
  deskewHomography,
  invertPerspective,
  isConvexQuad,
  isInvertiblePerspective,
  mirrorVisualImages,
  composeWarpLeft,
  effectiveVisualTransform,
  imageAnchor,
  imageLinear,
  levelLine,
  maxResidualPx,
  normalizeRotation,
  perspectiveMesh,
  rotationMatrix,
  snap15,
  solveAffine,
  solvePerspective,
  sortQuadCorners,
  sourceToWorld,
  visualCropRect,
  worldAabb,
  worldFootprint,
  worldToSource,
  type AffineMatrix,
} from "./transform";

const image = (over: Partial<VisualImage> = {}): VisualImage => ({
  id: "img-1", name: "Photo", assetHash: "a".repeat(64), width: 200, height: 100,
  x: 10, y: 20, flipH: false, flipV: false, visible: true, opacity: 1, locked: false, ...over,
});

const close = (p: Point, x: number, y: number, eps = 1e-9) => {
  expect(Math.abs(p.x - x)).toBeLessThan(eps);
  expect(Math.abs(p.y - y)).toBeLessThan(eps);
};

describe("visual crop rect and effective transform", () => {
  it("fills defaults from a legacy image and clamps/rounds crops into the source bounds", () => {
    expect(effectiveVisualTransform(image())).toEqual({
      crop: { x: 0, y: 0, w: 200, h: 100 }, rotation: 0, flipH: false, flipV: false, scaleX: 1, scaleY: 1, warp: null,
    });
    expect(visualCropRect(image())).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(visualCropRect(image({ crop: { x: 10.4, y: 5.6, w: 100, h: 50 } }))).toEqual({ x: 10, y: 6, w: 100, h: 50 });
    expect(visualCropRect(image({ crop: { x: 150, y: 0, w: 100, h: 100 } }))).toEqual({ x: 150, y: 0, w: 50, h: 100 });
    expect(visualCropRect(image({ crop: { x: -20, y: -30, w: 100, h: 50 } }))).toEqual({ x: 0, y: 0, w: 80, h: 20 });
    expect(visualCropRect(image({ crop: { x: 0, y: 0, w: 200, h: 100 } }))).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });
});

describe("identity invariant (AC6): legacy placement equivalence", () => {
  it("maps corners, anchor and footprint exactly like the legacy top-left renderer", () => {
    const legacy = image();
    expect(imageLinear(legacy)).toEqual({ a: 1, b: 0, c: 0, d: 1 });
    expect(imageAnchor(legacy)).toEqual({ x: 110, y: 70 });
    expect(sourceToWorld(legacy, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(sourceToWorld(legacy, { x: 200, y: 100 })).toEqual({ x: 210, y: 120 });
    expect(worldFootprint(legacy)).toEqual([
      { x: 10, y: 20 }, { x: 210, y: 20 }, { x: 210, y: 120 }, { x: 10, y: 120 },
    ]);
    expect(worldAabb([legacy])).toEqual({ left: 10, top: 20, right: 210, bottom: 120 });
    expect(worldAabb([])).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it("matches the legacy center-translate + axis-scale flip rendering for every flip combo", () => {
    for (const flipH of [false, true]) {
      for (const flipV of [false, true]) {
        const img = image({ flipH, flipV });
        for (const [sx, sy] of [[0, 0], [200, 0], [0, 100], [200, 100], [64, 33]] as const) {
          const world = sourceToWorld(img, { x: sx, y: sy });
          // legacy: translate(x + w/2, y + h/2); scale(flip ±1); draw at (−w/2, −h/2)
          expect(world).toEqual({
            x: 10 + (flipH ? 200 - sx : sx),
            y: 20 + (flipV ? 100 - sy : sy),
          });
        }
      }
    }
  });

  it("applies flips in displayed (post-rotation) axes and scale in source axes", () => {
    // F·R(90): the rotated top edge flips as a whole — source (200,0) → (60,170).
    // (Pre-rotation flips, R·F, would send it to (160,−30) instead.)
    const rotFlip = image({ rotation: 90, flipH: true });
    close(sourceToWorld(rotFlip, { x: 200, y: 0 }), 60, 170);
    // R(90)·S(2,1): the source x stretch happens BEFORE the rotation, so it
    // lands on the world y axis: L = {a:0, b:2, c:−1, d:0}.
    const rotScale = image({ rotation: 90, scaleX: 2 });
    const L = imageLinear(rotScale);
    expect(L.a).toBeCloseTo(0, 12);
    expect(L.b).toBeCloseTo(2, 12);
    expect(L.c).toBeCloseTo(-1, 12);
    expect(L.d).toBeCloseTo(0, 12);
    close(sourceToWorld(rotScale, { x: 100, y: 0 }), 160, 70);
    // full stack: W · F · R · S
    const W: Warp2 = { a: 1.1, b: 0.2, c: -0.1, d: 0.9 };
    const stacked = image({ warp: W, rotation: 90, flipH: true, scaleY: 0.5 });
    const RS = composeWarpLeft({ a: 1, b: 0, c: 0, d: 0.5 }, rotationMatrix(90)); // R·S
    const FRS = composeWarpLeft(RS, { a: -1, b: 0, c: 0, d: 1 }); // F·R·S
    expect(imageLinear(stacked)).toEqual(composeWarpLeft(FRS, W)); // W·F·R·S
  });

  it("uses the crop-rect center as the pivot: the kept region stays at its document offset", () => {
    const cropped = image({ crop: { x: 50, y: 20, w: 60, h: 40 } });
    expect(imageAnchor(cropped)).toEqual({ x: 90, y: 60 });
    expect(sourceToWorld(cropped, { x: 80, y: 40 })).toEqual({ x: 90, y: 60 }); // crop center → anchor
    expect(sourceToWorld(cropped, { x: 50, y: 20 })).toEqual({ x: 60, y: 40 }); // crop corner → x + r.x, y + r.y
    expect(sourceToWorld(cropped, { x: 110, y: 60 })).toEqual({ x: 120, y: 80 });
    expect(worldToSource(cropped, { x: 90, y: 60 })).toEqual({ x: 80, y: 40 });
  });
});

describe("source ↔ world round-trip (AC7)", () => {
  const combos: VisualImage[] = [
    image(),
    image({ crop: { x: 20, y: 10, w: 120, h: 60 } }),
    image({ rotation: 37.2 }),
    image({ rotation: 90 }),
    image({ flipH: true, flipV: true }),
    image({ scaleX: 1.7, scaleY: 0.6 }),
    image({ rotation: 37.2, flipH: true, scaleX: 1.7, scaleY: 0.6, crop: { x: 15, y: 10, w: 100, h: 50 } }),
    image({ warp: { a: 1.1, b: 0.15, c: -0.1, d: 0.95 } }),
    image({ rotation: 90, flipV: true, scaleY: 2, warp: { a: 0.9, b: -0.2, c: 0.25, d: 1.1 } }),
  ];
  const samples: Point[] = [
    { x: -40, y: -30 }, { x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 100 }, { x: 250, y: 130 }, { x: 33.3, y: 66.6 },
  ];

  it("inverts exactly (≤ 1e-6) for every transform combo, including points outside the crop", () => {
    for (const img of combos) {
      for (const p of samples) {
        const back = worldToSource(img, sourceToWorld(img, p));
        expect(Math.abs(back.x - p.x), `${img.id} @ ${p.x},${p.y}`).toBeLessThan(1e-6);
        expect(Math.abs(back.y - p.y), `${img.id} @ ${p.x},${p.y}`).toBeLessThan(1e-6);
      }
    }
  });

  it("rotates clockwise on screen (y down) about the crop center", () => {
    const rotated = image({ rotation: 90 });
    close(sourceToWorld(rotated, { x: 200, y: 0 }), 160, 170); // top-right → bottom-right
    close(sourceToWorld(rotated, { x: 0, y: 0 }), 160, -30); // top-left → top-right
    close(sourceToWorld(rotated, { x: 200, y: 100 }), 60, 170); // bottom-right → bottom-left
    const box = worldAabb([rotated]);
    expect(box.left).toBeCloseTo(60, 9);
    expect(box.top).toBeCloseTo(-30, 9);
    expect(box.right).toBeCloseTo(160, 9);
    expect(box.bottom).toBeCloseTo(170, 9);
  });
});

describe("solveAffine (AC8)", () => {
  const apply = (t: AffineMatrix, p: Point): Point => ({ x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f });
  const corners: Point[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];

  it("recovers an exact affine from 4 consistent pairs (residual < 1e-9)", () => {
    const t: AffineMatrix = { a: 1.2, b: 0.3, c: -0.4, d: 1.5, e: 7, f: -3 };
    const dst = corners.map((p) => apply(t, p));
    const solved = solveAffine(corners, dst)!;
    expect(solved).not.toBeNull();
    for (const key of ["a", "b", "c", "d", "e", "f"] as const) expect(solved[key]).toBeCloseTo(t[key], 9);
    expect(maxResidualPx(solved, corners, dst)).toBeLessThan(1e-9);
  });

  it("recovers mirrored mappings (negative determinant)", () => {
    const t: AffineMatrix = { a: -1, b: 0, c: 0, d: 1, e: 3, f: 4 };
    const dst = corners.map((p) => apply(t, p));
    const solved = solveAffine(corners, dst)!;
    expect(maxResidualPx(solved, corners, dst)).toBeLessThan(1e-9);
  });

  it("still fits overdetermined (5-pair) consistent input exactly", () => {
    const t: AffineMatrix = { a: 0.8, b: -0.2, c: 0.4, d: 1.1, e: -2, f: 5 };
    const src = [...corners, { x: 37, y: 21 }];
    const dst = src.map((p) => apply(t, p));
    const solved = solveAffine(src, dst)!;
    expect(maxResidualPx(solved, src, dst)).toBeLessThan(1e-9);
  });

  it("returns null for collinear or coincident points", () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    expect(solveAffine(line, line.map((p) => ({ x: p.x, y: p.y + 5 })))).toBeNull();
    const same = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
    expect(solveAffine(same, corners)).toBeNull();
    expect(solveAffine([], [])).toBeNull();
  });
});

describe("composeWarpLeft and matrix helpers", () => {
  it("left-composes m · (base ?? I) and is non-commuting for rotations vs scales", () => {
    const A = rotationMatrix(30); // rotation
    const B = { a: 2, b: 0, c: 0, d: 1 }; // x2 scale
    expect(composeWarpLeft(null, B)).toEqual(B);
    const BA = composeWarpLeft(A, B); // B · A — B applies after A
    const AB = composeWarpLeft(B, A); // A · B
    expect(BA).toEqual({ a: 2 * A.a, b: A.b, c: 2 * A.c, d: A.d });
    expect(AB).toEqual({ a: 2 * A.a, b: 2 * A.b, c: A.c, d: A.d });
    expect(BA).not.toEqual(AB);
    // Semantics: (B·A)·v = B·(A·v) — the base applies first to vectors.
    const v = { x: 1, y: 0 };
    const av = { x: A.a * v.x + A.c * v.y, y: A.b * v.x + A.d * v.y };
    expect((BA.a * v.x + BA.c * v.y)).toBeCloseTo(B.a * av.x + B.c * av.y, 12);
    expect((BA.b * v.x + BA.d * v.y)).toBeCloseTo(B.b * av.x + B.d * av.y, 12);
  });

  it("builds exact quarter-turn-adjacent rotation matrices", () => {
    const r0 = rotationMatrix(0);
    expect(r0.a).toBe(1);
    expect(r0.b).toBe(0);
    expect(Math.abs(r0.c)).toBe(0); // −0 and +0 are the same rotation
    expect(r0.d).toBe(1);
    const r90 = rotationMatrix(90);
    expect(r90.a).toBeCloseTo(0, 12);
    expect(r90.b).toBeCloseTo(1, 12);
    expect(r90.c).toBeCloseTo(-1, 12);
    expect(r90.d).toBeCloseTo(0, 12);
  });
});

describe("normalizeRotation / snap15 / levelLine (AC10)", () => {
  it("normalizes any finite degrees into [0, 360)", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(720.5)).toBeCloseTo(0.5, 12);
    expect(normalizeRotation(450)).toBeCloseTo(90, 12);
    expect(normalizeRotation(-720)).toBe(0);
    expect(normalizeRotation(-0.5)).toBeCloseTo(359.5, 12);
    expect(normalizeRotation(370)).toBeCloseTo(10, 12); // 350° + 20° → 10
  });

  it("snaps to the nearest multiple of 15", () => {
    expect(snap15(0)).toBe(0);
    expect(snap15(7)).toBe(0);
    expect(snap15(8)).toBe(15);
    expect(snap15(22)).toBe(15);
    expect(snap15(23)).toBe(30);
    expect(snap15(-7)).toBe(0);
    expect(snap15(-8)).toBe(-15);
    expect(snap15(45)).toBe(45);
    expect(snap15(90)).toBe(90);
  });

  it("levels a line to the nearest axis with |delta| ≤ 45°", () => {
    expect(levelLine({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ deltaDeg: 0, axis: "horizontal" });
    expect(levelLine({ x: 0, y: 0 }, { x: 0, y: 10 })).toEqual({ deltaDeg: 0, axis: "vertical" });
    expect(levelLine({ x: 0, y: 0 }, { x: 10, y: 10 })).toEqual({ deltaDeg: 45, axis: "vertical" });
    expect(levelLine({ x: 0, y: 0 }, { x: -10, y: -10 })).toEqual({ deltaDeg: 45, axis: "vertical" });
    const shallow = levelLine({ x: 0, y: 0 }, { x: 10, y: 4 })!;
    expect(shallow.axis).toBe("horizontal");
    expect(shallow.deltaDeg).toBeCloseTo(-21.801, 3);
    const steep = levelLine({ x: 0, y: 0 }, { x: 4, y: -10 })!;
    expect(steep.axis).toBe("vertical");
    expect(steep.deltaDeg).toBeCloseTo(-21.801, 3);
    // every direction stays within ±45°
    for (let i = 0; i < 72; i++) {
      const ang = (i * 5 * Math.PI) / 180;
      const level = levelLine({ x: 3, y: -2 }, { x: 3 + Math.cos(ang) * 50, y: -2 + Math.sin(ang) * 50 })!;
      expect(Math.abs(level.deltaDeg)).toBeLessThanOrEqual(45 + 1e-9);
      expect(["horizontal", "vertical"]).toContain(level.axis);
    }
    expect(levelLine({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
  });
});

it.each(["horizontal", "vertical"] as const)("preserves eight-image registration under a shared %s reflection", axis => {
  const images = Array.from({ length: 8 }, (_, i) => image({ id: String(i), width: 200 + i * 31, height: 100 + i * 19, x: i * 13, y: -i * 7, rotation: i * 11, scaleX: 1 + i / 10, scaleY: 1 - i / 20, flipH: i % 2 === 0, crop: { x: 5, y: 7, w: 150, h: 70 }, warp: { a: 1 + i / 20, b: i / 50, c: -i / 70, d: 1 + i / 30 }, visible: i !== 7 }));
  const bounds = worldAabb(images), cx = (bounds.left + bounds.right) / 2, cy = (bounds.top + bounds.bottom) / 2;
  const next = mirrorVisualImages(images, axis)!;
  for (const landmark of [{ x: 20, y: 30 }, { x: 70, y: 80 }, { x: 130, y: 55 }]) {
    images.forEach((photo, i) => close(sourceToWorld(next[i], worldToSource(photo, landmark)), axis === "horizontal" ? 2 * cx - landmark.x : landmark.x, axis === "vertical" ? 2 * cy - landmark.y : landmark.y));
  }
  const restored = mirrorVisualImages(next, axis)!;
  images.forEach((photo, i) => { const p = { x: 30, y: 40 }, w = sourceToWorld(photo, p); close(sourceToWorld(restored[i], p), w.x, w.y); });
});
it("rejects an entire stack with a hidden locked photo or invalid results", () => {
  expect(mirrorVisualImages([image(), image({ locked: true, visible: false })], "horizontal")).toBeNull();
  expect(mirrorVisualImages([image({ x: Infinity })], "horizontal")).toBeNull();
});

// ---------------------------------------------------------------------------
// Perspective (Deskew) — AC1 is the suite above passing UNEDITED: every
// legacy image leaves the pipeline bit-identical.
// ---------------------------------------------------------------------------

/** A mild but visible projective map (no pole over a 200x100 photo:
 * w = 1 + 3e-5·x − 2e-5·y stays in [0.998, 1.006]). */
const mildP: Perspective3 = { a: 1.02, b: 0.011, c: 2.5, d: -0.008, e: 0.99, f: -1.25, g: 3e-5, h: -2e-5 };

const apply = (P: Perspective3, p: Point): Point => applyPerspective(P, p);

describe("perspective evaluation and inversion (AC2, AC3)", () => {
  const src = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }];

  it("solves the 8x8 projective system exactly and rejects degenerate input", () => {
    const H: Perspective3 = { a: 1.05, b: 0.02, c: 3, d: -0.01, e: 0.97, f: -2, g: 2e-5, h: -1e-5 };
    const dst = src.map((p) => apply(H, p));
    const solved = solvePerspective(src, dst)!;
    expect(solved).not.toBeNull();
    for (const k of ["a", "b", "c", "d", "e", "f", "g", "h"] as const)
      expect(Math.abs(solved[k] - H[k]), `coefficient ${k}`).toBeLessThan(1e-6);
    const residual = Math.max(...src.map((p, i) => {
      const got = apply(solved, p);
      return Math.hypot(got.x - dst[i].x, got.y - dst[i].y);
    }));
    expect(residual).toBeLessThan(1e-6);
    // collinear or duplicated source points cannot define a homography
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    expect(solvePerspective(line, line.map((p) => ({ x: p.x, y: p.y + 5 })))).toBeNull();
    expect(solvePerspective([src[0], src[0], src[2], src[3]], dst)).toBeNull();
    expect(solvePerspective(src.slice(0, 3), dst)).toBeNull();
    expect(solvePerspective(src, dst.slice(0, 3))).toBeNull();
    expect(solvePerspective([{ x: Number.NaN, y: 0 }, ...src.slice(1)], dst)).toBeNull();
  });

  it("inverts exactly: P⁻¹∘P is the identity over the image rect", () => {
    const Pinv = invertPerspective(mildP);
    for (const p of [...src, { x: 100, y: 50 }, { x: 37.5, y: 82.25 }]) {
      const back = apply(Pinv, apply(mildP, p));
      expect(Math.abs(back.x - p.x), `${p.x},${p.y}`).toBeLessThan(1e-9 * Math.max(1, Math.abs(p.x)));
      expect(Math.abs(back.y - p.y), `${p.x},${p.y}`).toBeLessThan(1e-9 * Math.max(1, Math.abs(p.y)));
    }
    // involution: inverting twice restores the original map
    const again = invertPerspective(Pinv);
    for (const k of ["a", "b", "c", "d", "e", "f", "g", "h"] as const)
      expect(again[k]).toBeCloseTo(mildP[k], 9);
  });

  it("flags a singular linear part even when the full 3x3 map is invertible", () => {
    // Full det = 1 (rows a,b,c / d,e,f / g,h,1: 1·(4−1) − 2·(2−0) + 1·(2−0))
    // and no pole (w = 1 + y > 0), yet a·e − b·d = 0: every numerator lies
    // on a line, so the adjugate inverse would divide by zero and NaN the
    // world↔source round-trip. Validation must reject exactly this shape.
    const singular: Perspective3 = { a: 1, b: 2, c: 1, d: 2, e: 4, f: 1, g: 0, h: 1 };
    expect(isInvertiblePerspective(singular)).toBe(false);
    expect(isInvertiblePerspective(mildP)).toBe(true);
    expect(isInvertiblePerspective({ a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, g: 1e-6, h: 0 })).toBe(true);
    expect(isInvertiblePerspective({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0 })).toBe(false);
  });
});

describe("pipeline composition with a perspective (AC4, AC5)", () => {
  const stacked = image({
    perspective: mildP,
    crop: { x: 20, y: 10, w: 120, h: 60 },
    rotation: 15,
    flipH: true,
    scaleX: 1.4,
    warp: { a: 1.1, b: 0.05, c: -0.05, d: 0.95 },
  });

  it("applies P innermost: sourceToWorld(p) == legacyAffine(P(p))", () => {
    const r = visualCropRect(stacked);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const L = imageLinear(stacked);
    const t = imageAnchor(stacked);
    for (const p of [{ x: 0, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 50 }, { x: 33, y: 71 }]) {
      const q = apply(mildP, p);
      const legacy = { x: L.a * (q.x - cx) + L.c * (q.y - cy) + t.x, y: L.b * (q.x - cx) + L.d * (q.y - cy) + t.y };
      const got = sourceToWorld(stacked, p);
      expect(got.x).toBeCloseTo(legacy.x, 9);
      expect(got.y).toBeCloseTo(legacy.y, 9);
    }
    // the same image without the field applies the affine directly, so
    // pre-straightening the input reproduces the full pipeline exactly
    const without = { ...stacked, perspective: undefined };
    expect(sourceToWorld(without, apply(mildP, { x: 100, y: 50 }))).toEqual(sourceToWorld(stacked, { x: 100, y: 50 }));
  });

  it("round-trips world↔source through P⁻¹ and keeps original-px semantics", () => {
    const combos: VisualImage[] = [
      image({ perspective: mildP }),
      image({ crop: { x: 20, y: 10, w: 120, h: 60 }, perspective: mildP }),
      image({ rotation: 37.2, flipH: true, scaleX: 1.7, perspective: mildP }),
      image({ warp: { a: 1.1, b: 0.15, c: -0.1, d: 0.95 }, perspective: mildP }),
    ];
    for (const img of combos) {
      for (const p of [{ x: -40, y: -30 }, { x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 100 }, { x: 250, y: 130 }]) {
        const back = worldToSource(img, sourceToWorld(img, p));
        expect(Math.abs(back.x - p.x), `${img.rotation} @ ${p.x},${p.y}`).toBeLessThan(1e-6);
        expect(Math.abs(back.y - p.y), `${img.rotation} @ ${p.x},${p.y}`).toBeLessThan(1e-6);
      }
    }
    // the footprint still traces the crop corners (now through P), and the
    // AABB follows the straightened shape
    const plain = image({ perspective: mildP });
    const foot = worldFootprint(plain);
    expect(foot.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      const corner = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }][i];
      const w = worldFootprint(plain)[i];
      const direct = sourceToWorld(plain, corner);
      expect(w.x).toBeCloseTo(direct.x, 9);
      expect(w.y).toBeCloseTo(direct.y, 9);
    }
    expect(worldAabb([plain])).toEqual({
      left: Math.min(...foot.map((p) => p.x)), right: Math.max(...foot.map((p) => p.x)),
      top: Math.min(...foot.map((p) => p.y)), bottom: Math.max(...foot.map((p) => p.y)),
    });
  });
});

describe("quad helpers (AC6)", () => {
  const rect = [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 50 }, { x: 10, y: 50 }];

  it("orders shuffled corners into TL,TR,BR,BL (ties by x)", () => {
    const shuffles = [
      [rect[2], rect[0], rect[3], rect[1]],
      [rect[1], rect[3], rect[0], rect[2]],
      [rect[3], rect[2], rect[1], rect[0]],
    ];
    for (const shuffle of shuffles)
      expect(sortQuadCorners(shuffle)).toEqual([rect[0], rect[1], rect[2], rect[3]]);
    expect(sortQuadCorners([{ x: 80, y: 0 }, { x: 20, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 50 }]))
      .toEqual([{ x: 20, y: 0 }, { x: 80, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 50 }]);
  });

  it("accepts strictly convex quads and rejects bowties and collinear corners", () => {
    expect(isConvexQuad(rect)).toBe(true);
    expect(isConvexQuad([{ x: 10, y: 10 }, { x: 60, y: 5 }, { x: 100, y: 40 }, { x: 30, y: 60 }])).toBe(true);
    expect(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }])).toBe(false);
    expect(isConvexQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 10 }])).toBe(false);
    expect(isConvexQuad([{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 95, y: 15 }, { x: 10, y: 90 }])).toBe(false);
    expect(isConvexQuad(rect.slice(0, 3))).toBe(false);
  });

  it("builds the destination rect from averaged opposite edges about the centroid", () => {
    const quad = [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 110, y: 60 }, { x: 10, y: 50 }];
    const dst = deskewDstRect(quad);
    const w = Math.sqrt(10100) / 2, h = Math.sqrt(2600) / 2;
    expect(dst).toEqual([
      { x: 55 - w, y: 30 - h }, { x: 55 + w, y: 30 - h }, { x: 55 + w, y: 30 + h }, { x: 55 - w, y: 30 + h },
    ]);
  });
});

describe("deskewHomography (AC7)", () => {
  /** A slightly skewed convex quad fully inside the 200x100 photo. */
  const sourceQuad = [{ x: 50, y: 25 }, { x: 150, y: 20 }, { x: 155, y: 80 }, { x: 45, y: 75 }];
  const worldQuad = sourceQuad.map((p) => sourceToWorld(image(), p));

  it("returns a fitted, pole-free, centered perspective on success", () => {
    const result = deskewHomography(image(), worldQuad);
    if (!("perspective" in result)) throw new Error(`unexpected error: ${result.error}`);
    const P = result.perspective;
    // photo corners map inside [0,w]x[0,h], bbox centered by the 0.98 fit
    const mapped = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }].map((p) => apply(P, p));
    for (const q of mapped) {
      expect(q.x).toBeGreaterThanOrEqual(-1e-6);
      expect(q.x).toBeLessThanOrEqual(200 + 1e-6);
      expect(q.y).toBeGreaterThanOrEqual(-1e-6);
      expect(q.y).toBeLessThanOrEqual(100 + 1e-6);
    }
    const bx = Math.min(...mapped.map((q) => q.x)), by = Math.min(...mapped.map((q) => q.y));
    const bw = Math.max(...mapped.map((q) => q.x)) - bx, bh = Math.max(...mapped.map((q) => q.y)) - by;
    expect(bx + bw / 2).toBeCloseTo(100, 6);
    expect(by + bh / 2).toBeCloseTo(50, 6);
    expect(bw).toBeLessThanOrEqual(200);
    expect(bh).toBeLessThanOrEqual(100);
    // the map stays pole-free over the photograph
    for (const [x, y] of [[0, 0], [200, 0], [200, 100], [0, 100]])
      expect(1 + P.g * x + P.h * y).toBeGreaterThan(0);
    // the clicked corners rectify onto an axis-aligned rectangle (scaled dst)
    const rectified = sortQuadCorners(sourceQuad.map((p) => apply(P, p)));
    const [tl, tr, br, bl] = rectified;
    expect(tl.y).toBeCloseTo(tr.y, 6);
    expect(br.y).toBeCloseTo(bl.y, 6);
    expect(tl.x).toBeCloseTo(bl.x, 6);
    expect(tr.x).toBeCloseTo(br.x, 6);
    // and the store accepts the produced value
    expect(Number.isFinite(P.a + P.b + P.c + P.d + P.e + P.f + P.g + P.h)).toBe(true);
  });

  it("explains every failure distinctly and the strings are user-facing", () => {
    const img = image();
    const toWorld = (quad: Point[]) => quad.map((p) => sourceToWorld(img, p));
    // corner dragged past the photo edge (source x 250 > 200 + 1 tolerance)
    const outside = deskewHomography(img, toWorld([{ x: 250, y: 50 }, { x: 150, y: 20 }, { x: 155, y: 80 }, { x: 45, y: 75 }]));
    if (!("error" in outside)) throw new Error("expected an error");
    // a dart (BR pulled inside the triangle) sorts to a non-convex quad
    const nonConvex = deskewHomography(img, toWorld([{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 95, y: 15 }, { x: 10, y: 90 }]));
    if (!("error" in nonConvex)) throw new Error("expected an error");
    expect(outside.error).not.toBe(nonConvex.error);
    expect(outside.error).toContain("inside the photograph");
    expect(nonConvex.error).toContain("convex");
    // the collinear/degenerate solve is guarded upstream by solvePerspective
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    expect(solvePerspective(line, line)).toBeNull();
  });
});

describe("affineFromTriangle and perspectiveMesh (AC8)", () => {
  it("solves the exact affine through 3 pairs and rejects zero area", () => {
    const A = affineFromTriangle([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], [{ x: 2, y: 3 }, { x: 4, y: 3 }, { x: 2, y: 7 }]);
    expect(A).toEqual({ a: 2, b: 0, c: 0, d: 4, e: 2, f: 3 });
    const shear = affineFromTriangle([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }]);
    expect(shear).toEqual({ a: 1, b: 0, c: 2, d: 1, e: 0, f: 0 });
    expect(affineFromTriangle([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], [{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 2 }])).toBeNull();
    expect(affineFromTriangle([], [])).toBeNull();
  });

  it("tiles the crop rect and reproduces the pipeline per triangle", () => {
    const img = image({ crop: { x: 20, y: 10, w: 120, h: 60 }, perspective: mildP, rotation: 15 });
    const mesh = perspectiveMesh(img, 4);
    expect(mesh).toHaveLength(4 * 4 * 2);
    expect(mesh[0].src).toEqual([{ x: 20, y: 10 }, { x: 50, y: 10 }, { x: 20, y: 25 }]);
    expect(mesh[1].src).toEqual([{ x: 50, y: 10 }, { x: 50, y: 25 }, { x: 20, y: 25 }]); // shared diagonal
    for (const tri of mesh)
      for (let k = 0; k < 3; k++) {
        const w = sourceToWorld(img, tri.src[k]);
        expect(tri.world[k].x).toBeCloseTo(w.x, 9);
        expect(tri.world[k].y).toBeCloseTo(w.y, 9);
      }
    // each triangle's affine reproduces all 3 vertex pairs (≤ 1e-6)
    for (const tri of mesh) {
      const A = affineFromTriangle(tri.src, tri.world)!;
      expect(A).not.toBeNull();
      for (let k = 0; k < 3; k++) {
        const p = tri.src[k];
        expect(A.a * p.x + A.c * p.y + A.e).toBeCloseTo(tri.world[k].x, 6);
        expect(A.b * p.x + A.d * p.y + A.f).toBeCloseTo(tri.world[k].y, 6);
      }
    }
    expect(perspectiveMesh(img, 0)).toEqual([]);
    expect(perspectiveMesh(image(), 2)).toHaveLength(8);
  });
});
