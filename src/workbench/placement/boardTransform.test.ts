import { it, expect } from "vitest";
import type { Board, CropRect, Point } from "./projectDoc";
import {
  displaySize,
  displayToImage,
  effectiveBoardTransform,
  imageToDisplay,
  imageToScreen,
  imageToScreenMatrix,
  visibleImageRect,
  type Rotation,
} from "./boardTransform";

function board(overrides: Partial<Board> = {}): Board {
  return {
    id: "b1",
    name: "Front",
    assetHash: "a".repeat(64),
    width: 800,
    height: 600,
    ...overrides,
  };
}

const ROTATIONS: Rotation[] = [0, 90, 180, 270];
const FLIPS: { flipH?: boolean; flipV?: boolean }[] = [
  {},
  { flipH: true },
  { flipV: true },
  { flipH: true, flipV: true },
];
const CROPS: (CropRect | undefined)[] = [
  undefined,
  { x: 100, y: 50, w: 400, h: 300 },
];

const SAMPLE_POINTS: Point[] = [
  { x: 0, y: 0 },
  { x: 800, y: 0 },
  { x: 0, y: 600 },
  { x: 800, y: 600 },
  { x: 400, y: 300 },
  { x: 137.5, y: 421.25 },
  { x: 779, y: 11 },
];

describe("round-trip", () => {
  for (const rotation of ROTATIONS) {
    for (const flip of FLIPS) {
      for (const crop of CROPS) {
        for (const scale of [undefined, 100, 37.5, 800]) {
          it(`inverts for rotation=${rotation} flip=${JSON.stringify(flip)} crop=${crop ? "rect" : "none"} scale=${scale ?? "default"}`, () => {
            const b = board({ rotation, crop, scale, ...flip });
            for (const point of SAMPLE_POINTS) {
              const display = imageToDisplay(b, point);
              const back = displayToImage(b, display);
              expect(back.x).toBeCloseTo(point.x, 6);
              expect(back.y).toBeCloseTo(point.y, 6);
            }
          });
        }
      }
    }
  }
});

describe("corners map to corners", () => {
  const cases: { rotation: Rotation; flipH?: boolean; flipV?: boolean; expected: Point[] }[] = [
    { rotation: 0, expected: [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 600 }, { x: 0, y: 600 }] },
    // 90° CW: top-left → top-right, top-right → bottom-right, etc.
    { rotation: 90, expected: [{ x: 600, y: 0 }, { x: 600, y: 800 }, { x: 0, y: 800 }, { x: 0, y: 0 }] },
    { rotation: 180, expected: [{ x: 800, y: 600 }, { x: 0, y: 600 }, { x: 0, y: 0 }, { x: 800, y: 0 }] },
    { rotation: 270, expected: [{ x: 0, y: 800 }, { x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 800 }] },
    // flipH mirrors the displayed x axis.
    { rotation: 0, flipH: true, expected: [{ x: 800, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 600 }, { x: 800, y: 600 }] },
    // 90° CW then flipV mirrors the displayed y axis.
    {
      rotation: 90,
      flipV: true,
      expected: [
        { x: 600, y: 800 },
        { x: 600, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 800 },
      ],
    },
  ];
  for (const { rotation, flipH, flipV, expected } of cases) {
    it(`maps corners for rotation=${rotation} flipH=${flipH ?? false} flipV=${flipV ?? false}`, () => {
      const b = board({ rotation, flipH, flipV });
      const corners = [
        { x: 0, y: 0 },
        { x: 800, y: 0 },
        { x: 800, y: 600 },
        { x: 0, y: 600 },
      ];
      corners.forEach((corner, index) => {
        const mapped = imageToDisplay(b, corner);
        expect(mapped.x).toBeCloseTo(expected[index].x, 6);
        expect(mapped.y).toBeCloseTo(expected[index].y, 6);
      });
    });
  }
});

it("displaySize composes crop, rotation swap, and scale", () => {
  expect(displaySize(board())).toEqual({ width: 800, height: 600 });
  expect(displaySize(board({ crop: { x: 0, y: 0, w: 400, h: 300 } }))).toEqual({
    width: 400,
    height: 300,
  });
  expect(displaySize(board({ crop: { x: 0, y: 0, w: 400, h: 300 }, rotation: 90 }))).toEqual({
    width: 300,
    height: 400,
  });
  expect(displaySize(board({ rotation: 180, scale: 50 }))).toEqual({ width: 400, height: 300 });
  expect(displaySize(board({ rotation: 270, scale: 200 }))).toEqual({ width: 1200, height: 1600 });
});

it("normalizes defaults for absent optional fields", () => {
  const t = effectiveBoardTransform(board());
  expect(t).toEqual({
    crop: null,
    rotation: 0,
    flipH: false,
    flipV: false,
    scale: 100,
    locked: false,
  });
  expect(effectiveBoardTransform(board({ locked: true, scale: 250, flipH: true })).locked).toBe(
    true,
  );
  expect(visibleImageRect(board())).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  const crop: CropRect = { x: 10, y: 20, w: 100, h: 50 };
  expect(visibleImageRect(board({ crop }))).toEqual(crop);
});

it("crops translate the origin before rotating", () => {
  const b = board({ crop: { x: 100, y: 50, w: 400, h: 300 } });
  // The crop's top-left corner is the display origin.
  expect(imageToDisplay(b, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
  expect(imageToDisplay(b, { x: 500, y: 350 })).toEqual({ x: 400, y: 300 });
  // Rotating the crop 90° CW swaps the display dims.
  const rotated = board({ crop: { x: 100, y: 50, w: 400, h: 300 }, rotation: 90 });
  expect(imageToDisplay(rotated, { x: 100, y: 50 })).toEqual({ x: 300, y: 0 });
  expect(displayToImage(rotated, { x: 300, y: 0 })).toEqual({ x: 100, y: 50 });
});

it("composes the view after the board transform", () => {
  const view = { scale: 2, offsetX: 30, offsetY: 40 };
  const b = board({ scale: 50, rotation: 90 });
  const point: Point = { x: 800, y: 0 };
  const viaHelper = imageToScreen(view, b, point);
  const display = imageToDisplay(b, point);
  expect(viaHelper).toEqual({ x: display.x * 2 + 30, y: display.y * 2 + 40 });
  // The matrix maps arbitrary points identically to the helper.
  const m = imageToScreenMatrix(view, b);
  for (const sample of SAMPLE_POINTS) {
    const direct = imageToScreen(view, b, sample);
    expect(m.a * sample.x + m.c * sample.y + m.e).toBeCloseTo(direct.x, 9);
    expect(m.b * sample.x + m.d * sample.y + m.f).toBeCloseTo(direct.y, 9);
  }
  // An untransformed board degenerates to the plain view formula.
  const plain = imageToScreenMatrix(view, board());
  expect(plain).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 30, f: 40 });
});

it("round-trips through a flipped, rotated, cropped, scaled board with the view", () => {
  const view = { scale: 1.7, offsetX: -40, offsetY: 12.5 };
  const b = board({
    crop: { x: 20, y: 10, w: 760, h: 580 },
    rotation: 270,
    flipH: true,
    scale: 137.5,
  });
  for (const point of SAMPLE_POINTS) {
    const screen = imageToScreen(view, b, point);
    // Invert by hand: screen → display (plain view math) → image.
    const display = { x: (screen.x - view.offsetX) / view.scale, y: (screen.y - view.offsetY) / view.scale };
    const image = displayToImage(b, display);
    expect(image.x).toBeCloseTo(point.x, 5);
    expect(image.y).toBeCloseTo(point.y, 5);
  }
});

describe("arbitrary-angle round-trip", () => {
  for (const rotation of [0.1, 30, 45.7, 89.9, 180.1, 359.9]) {
    for (const flip of FLIPS) {
      for (const crop of CROPS) {
        it(`inverts for rotation=${rotation} flip=${JSON.stringify(flip)} crop=${crop ? "rect" : "none"}`, () => {
          const b = board({ rotation, crop, scale: 137.5, sceneX: -40.5, sceneY: 65.25, ...flip });
          for (const point of SAMPLE_POINTS) {
            const display = imageToDisplay(b, point);
            const back = displayToImage(b, display);
            expect(Math.abs(back.x - point.x)).toBeLessThan(1e-9);
            expect(Math.abs(back.y - point.y)).toBeLessThan(1e-9);
          }
        });
      }
    }
  }
});

it("matches the legacy quarter-turn formulas exactly at 0/90/180/270", () => {
  const crop: CropRect = { x: 100, y: 50, w: 400, h: 300 };
  for (const rotation of ROTATIONS) {
    const b = board({ crop, rotation, flipH: true, flipV: true, scale: 37.5, sceneX: 12.5, sceneY: -7 });
    for (const point of SAMPLE_POINTS) {
      const u = point.x - crop.x;
      const v = point.y - crop.y;
      let rotated: Point;
      if (rotation === 90) rotated = { x: 300 - v, y: u };
      else if (rotation === 180) rotated = { x: 400 - u, y: 300 - v };
      else if (rotation === 270) rotated = { x: v, y: 400 - u };
      else rotated = { x: u, y: v };
      const rw = rotation === 90 || rotation === 270 ? 300 : 400;
      const rh = rotation === 90 || rotation === 270 ? 400 : 300;
      const expected = {
        x: (rw - rotated.x) * 0.375 + 12.5,
        y: (rh - rotated.y) * 0.375 - 7,
      };
      expect(imageToDisplay(b, point)).toEqual(expected);
    }
  }
});

it("quarter turns map points to exact integers (no float drift)", () => {
  const crop: CropRect = { x: 100, y: 50, w: 400, h: 300 };
  expect(imageToDisplay(board({ crop, rotation: 90 }), { x: 250, y: 200 })).toEqual({ x: 150, y: 150 });
  expect(imageToDisplay(board({ crop, rotation: 180 }), { x: 250, y: 200 })).toEqual({ x: 250, y: 150 });
  expect(imageToDisplay(board({ crop, rotation: 270 }), { x: 250, y: 200 })).toEqual({ x: 150, y: 250 });
  expect(imageToDisplay(board({ crop, rotation: 90, flipH: true }), { x: 500, y: 350 })).toEqual({ x: 300, y: 400 });
  expect(displayToImage(board({ crop, rotation: 90, flipH: true }), { x: 300, y: 400 })).toEqual({ x: 500, y: 350 });
});

it("displaySize is the rotated AABB for arbitrary angles", () => {
  const c = Math.cos((30 * Math.PI) / 180);
  const s = Math.sin((30 * Math.PI) / 180);
  const size = displaySize(board({ crop: { x: 0, y: 0, w: 400, h: 300 }, rotation: 30, scale: 200 }));
  expect(size.width).toBeCloseTo((Math.abs(400 * c) + Math.abs(300 * s)) * 2, 9);
  expect(size.height).toBeCloseTo((Math.abs(400 * s) + Math.abs(300 * c)) * 2, 9);
  // Quarter turns still swap exactly.
  expect(displaySize(board({ crop: { x: 0, y: 0, w: 400, h: 300 }, rotation: 90 }))).toEqual({ width: 300, height: 400 });
});

it("maps every crop corner inside the anchored AABB at arbitrary angles", () => {
  for (const rotation of [30, 45.7, 359.9]) {
    const b = board({ crop: { x: 100, y: 50, w: 400, h: 300 }, rotation, sceneX: 25, sceneY: -10 });
    const size = displaySize(b);
    const corners = [
      { x: 100, y: 50 },
      { x: 500, y: 50 },
      { x: 100, y: 350 },
      { x: 500, y: 350 },
    ];
    for (const corner of corners) {
      const display = imageToDisplay(b, corner);
      expect(display.x).toBeGreaterThanOrEqual(25 - 1e-9);
      expect(display.x).toBeLessThanOrEqual(25 + size.width + 1e-9);
      expect(display.y).toBeGreaterThanOrEqual(-10 - 1e-9);
      expect(display.y).toBeLessThanOrEqual(-10 + size.height + 1e-9);
    }
  }
});
