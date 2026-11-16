import { it, expect } from "vitest";
import {
  boardToScreen,
  clampScale,
  fitView,
  panBy,
  scaleLimits,
  scaleTo100,
  screenToBoard,
  zoomAtPoint,
} from "./view";

const viewport = { width: 800, height: 600 };

it("converts between board and screen coordinates", () => {
  const view = { scale: 2, offsetX: 100, offsetY: 50 };
  expect(boardToScreen(view, { x: 10, y: 20 })).toEqual({ x: 120, y: 90 });
  expect(screenToBoard(view, { x: 120, y: 90 })).toEqual({ x: 10, y: 20 });
  const identity = { scale: 1, offsetX: 0, offsetY: 0 };
  expect(boardToScreen(identity, { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
});

it("fits boards centered with the initial scale capped", () => {
  expect(fitView(viewport, { width: 1600, height: 1200 })).toEqual({
    scale: 0.5,
    offsetX: 0,
    offsetY: 0,
  });
  const tiny = fitView(viewport, { width: 10, height: 10 });
  expect(tiny.scale).toBe(2);
  expect(tiny.offsetX).toBe(390);
  expect(tiny.offsetY).toBe(290);
  const wide = fitView(viewport, { width: 3200, height: 100 });
  expect(wide.scale).toBeCloseTo(0.25);
  expect(wide.offsetX).toBeCloseTo(0);
  expect(wide.offsetY).toBeCloseTo(287.5);
});

it("zooms at the cursor while keeping its board point fixed", () => {
  const fit = fitView(viewport, { width: 1600, height: 1200 });
  const cursor = { x: 400, y: 300 };
  const boardPoint = screenToBoard(fit, cursor);
  const zoomed = zoomAtPoint(fit, cursor, 1.1, fit.scale);
  expect(zoomed.scale).toBeCloseTo(0.55);
  const restored = screenToBoard(zoomed, cursor);
  expect(restored.x).toBeCloseTo(boardPoint.x);
  expect(restored.y).toBeCloseTo(boardPoint.y);
});

it("clamps zoom within [fit*0.25, 32]", () => {
  const fitScale = 0.5;
  expect(scaleLimits(fitScale)).toEqual({ min: 0.125, max: 32 });
  expect(clampScale(40, fitScale)).toBe(32);
  expect(clampScale(0.01, fitScale)).toBeCloseTo(0.125);
  expect(clampScale(4, fitScale)).toBe(4);
  const zoomedIn = zoomAtPoint({ scale: 30, offsetX: 0, offsetY: 0 }, { x: 1, y: 1 }, 4, fitScale);
  expect(zoomedIn.scale).toBe(32);
  const zoomedOut = zoomAtPoint({ scale: 30, offsetX: 0, offsetY: 0 }, { x: 1, y: 1 }, 0.001, fitScale);
  expect(zoomedOut.scale).toBeCloseTo(0.125);
});

it("jumps to 100% around the viewport center and pans", () => {
  const fit = fitView(viewport, { width: 1600, height: 1200 });
  const full = scaleTo100(fit, viewport, fit.scale);
  expect(full.scale).toBe(1);
  const before = screenToBoard(fit, { x: 400, y: 300 });
  const after = screenToBoard(full, { x: 400, y: 300 });
  expect(after.x).toBeCloseTo(before.x);
  expect(after.y).toBeCloseTo(before.y);
  const panned = panBy(full, 30, -20);
  expect(panned).toEqual({ scale: 1, offsetX: full.offsetX + 30, offsetY: full.offsetY - 20 });
});
