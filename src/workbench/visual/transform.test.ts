// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Point } from "../placement/projectDoc";
import type { VisualImage, Warp2 } from "./model";
import {
  composeWarpLeft,
  effectiveVisualTransform,
  imageAnchor,
  imageLinear,
  levelLine,
  maxResidualPx,
  normalizeRotation,
  rotationMatrix,
  snap15,
  solveAffine,
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
