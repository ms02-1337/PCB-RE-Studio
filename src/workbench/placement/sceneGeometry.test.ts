import { expect, it } from "vitest";
import type { Board } from "./projectDoc";
import { displayToImage, imageToDisplay, imageToScreen } from "./boardTransform";
import { fitScene, hitSceneImage, labelFontSize, sceneBounds } from "./sceneGeometry";

const image = (id: string, x: number, y: number): Board => ({ id, name: id, assetHash: "a".repeat(64), width: 100, height: 80, sceneX: x, sceneY: y });

it("fits a scene with negative and positive image positions", () => {
  const images = [image("a", -100, -80), image("b", 100, 80)];
  expect(sceneBounds(images)).toEqual({ x: -100, y: -80, width: 300, height: 240 });
  const view = fitScene({ width: 600, height: 480 }, images);
  expect(imageToScreen(view, images[0], { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  expect(imageToScreen(view, images[1], { x: 100, y: 80 })).toEqual({ x: 600, y: 480 });
});

it("hit tests topmost images after crop/rotation/scale/scene translation", () => {
  const lower = image("lower", 0, 0);
  const upper = { ...image("upper", 20, 20), crop: { x: 10, y: 20, w: 40, h: 20 }, rotation: 90 as const, scale: 200 };
  expect(hitSceneImage([lower, upper], { x: 25, y: 25 })?.id).toBe("upper");
  expect(hitSceneImage([lower, upper], { x: 65, y: 25 })?.id).toBe("lower");
  expect(hitSceneImage([lower, upper], { x: -1, y: 20 })).toBeUndefined();
});

it("translation composes after picture transforms and round-trips without moving local markings", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const board = { ...image("a", -123, 456), rotation, flipH: true, flipV: true, scale: 125, crop: { x: 10, y: 20, w: 40, h: 30 } };
    const point = { x: 25, y: 32 };
    const display = imageToDisplay(board, point);
    const inverse = displayToImage(board, display);
    expect(inverse.x).toBeCloseTo(point.x);
    expect(inverse.y).toBeCloseTo(point.y);
    const moved = imageToDisplay({ ...board, sceneX: board.sceneX! + 200 }, point);
    expect(moved.x - display.x).toBeCloseTo(200);
    expect(moved.y).toBeCloseTo(display.y);
  }
});

it("hides unreadably small labels rather than moving them outside shapes", () => {
  expect(labelFontSize(20, 10, 3)).toBeNull();
  expect(labelFontSize(60, 30, 3)).toBe(16);
  expect(labelFontSize(100, 40, 20)).toBeNull();
  expect(labelFontSize(50, 25, 3)).toBeGreaterThanOrEqual(8);
});

it("includes independent components in scene fit after pictures move or disappear", () => {
  const components = [{ id: "c", boardId: "missing", refdes: "R1", typeId: "resistor", status: "unknown" as const, locked: false, shape: { rect: { x: -100, y: -50, w: 80, h: 40 } } }];
  expect(sceneBounds([], components)).toEqual({ x: -100, y: -50, width: 80, height: 40 });
  const view = fitScene({ width: 400, height: 200 }, [], Infinity, components);
  expect(view.scale).toBe(5);
  expect(view.offsetX).toBe(500);
  expect(view.offsetY).toBe(250);
});

it("scene bounds match the rotated AABB for arbitrary angles", () => {
  for (const rotation of [30, 45.7]) {
    const board = { ...image("a", -10, 20), rotation };
    const c = Math.cos((rotation * Math.PI) / 180);
    const s = Math.sin((rotation * Math.PI) / 180);
    const bounds = sceneBounds([board]);
    // The rotated AABB anchors at (sceneX, sceneY).
    expect(bounds.x).toBe(-10);
    expect(bounds.y).toBe(20);
    expect(bounds.width).toBeCloseTo(Math.abs(100 * c) + Math.abs(80 * s), 9);
    expect(bounds.height).toBeCloseTo(Math.abs(100 * s) + Math.abs(80 * c), 9);
    // Every image corner stays inside the bounds.
    for (const corner of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 80 }, { x: 100, y: 80 }]) {
      const display = imageToDisplay(board, corner);
      expect(display.x).toBeGreaterThanOrEqual(bounds.x - 1e-9);
      expect(display.x).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-9);
      expect(display.y).toBeGreaterThanOrEqual(bounds.y - 1e-9);
      expect(display.y).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-9);
    }
  }
});

it("displayToImage inverts imageToDisplay within 1e-9 at 359.9 degrees", () => {
  const board = { ...image("a", -123, 456), rotation: 359.9, flipH: true, flipV: true, scale: 125, crop: { x: 10, y: 20, w: 40, h: 30 } };
  for (const point of [{ x: 10, y: 20 }, { x: 50, y: 50 }, { x: 25, y: 32 }, { x: 49.9, y: 20.1 }]) {
    const display = imageToDisplay(board, point);
    const inverse = displayToImage(board, display);
    expect(Math.abs(inverse.x - point.x)).toBeLessThan(1e-9);
    expect(Math.abs(inverse.y - point.y)).toBeLessThan(1e-9);
  }
});
