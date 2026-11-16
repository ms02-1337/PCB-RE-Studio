import { describe, expect, it } from "vitest";
import type { OverlayView, VisualToolOverlay } from "./toolController";
import {
  drawVisualOverlays,
  endTicks,
  loupePlacement,
  midpoint,
  screenToBase,
  screenToWorld,
  worldToScreen,
  type Rect,
} from "./overlays";

const view = (over: Partial<OverlayView> = {}): OverlayView =>
  ({ scale: 2, offsetX: 30, offsetY: 40, flipX: false, flipY: false, width: 800, height: 600, ...over });

describe("visual overlay view mapping", () => {
  it("maps world→screen and back without flips", () => {
    const v = view();
    const p = { x: 12, y: -7 };
    expect(worldToScreen(v, p)).toEqual({ x: 12 * 2 + 30, y: -7 * 2 + 40 });
    expect(screenToWorld(v, worldToScreen(v, p))).toEqual(p);
  });
  it("mirrors about the canvas center under both flips", () => {
    const v = view({ flipX: true, flipY: true });
    const s = worldToScreen(v, { x: 10, y: 5 });
    expect(s.x).toBe(800 - (10 * 2 + 30));
    expect(s.y).toBe(600 - (5 * 2 + 40));
    expect(screenToWorld(v, s)).toEqual({ x: 10, y: 5 });
  });
  it("keeps each flip axis independent", () => {
    const onlyX = view({ flipX: true });
    const s = worldToScreen(onlyX, { x: 0, y: 5 });
    expect(s).toEqual({ x: 800 - 30, y: 50 });
    expect(screenToWorld(onlyX, s)).toEqual({ x: 0, y: 5 });
    const onlyY = view({ flipY: true });
    expect(worldToScreen(onlyY, { x: 0, y: 5 })).toEqual({ x: 30, y: 600 - 50 });
  });
  it("round-trips arbitrary points under every flip combination", () => {
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        const v = view({ flipX, flipY, scale: 0.37, offsetX: -120, offsetY: 96 });
        const p = { x: 123.5, y: -42.25 };
        const back = screenToWorld(v, worldToScreen(v, p));
        expect(back.x).toBeCloseTo(p.x, 10);
        expect(back.y).toBeCloseTo(p.y, 10);
      }
    }
  });
  it("un-flips screen points into base coordinates only", () => {
    expect(screenToBase(view({ flipX: true }), { x: 770, y: 3 })).toEqual({ x: 30, y: 3 });
    expect(screenToBase(view({ flipY: true }), { x: 770, y: 3 })).toEqual({ x: 770, y: 597 });
    expect(screenToBase(view(), { x: 770, y: 3 })).toEqual({ x: 770, y: 3 });
  });
});

describe("overlay geometry helpers", () => {
  it("places ticks perpendicular to the measured line at both ends", () => {
    const ticks = endTicks({ x: 0, y: 0 }, { x: 10, y: 0 }, 4);
    expect(ticks).toEqual([
      { a: { x: 0, y: 4 }, b: { x: 0, y: -4 } },
      { a: { x: 10, y: 4 }, b: { x: 10, y: -4 } },
    ]);
    const diagonal = endTicks({ x: 0, y: 0 }, { x: 3, y: 4 }, 5);
    expect(diagonal).toHaveLength(2);
    for (const tick of diagonal) {
      const dx = tick.b.x - tick.a.x, dy = tick.b.y - tick.a.y;
      expect(dx * 3 + dy * 4).toBeCloseTo(0, 10); // perpendicular to (3,4)
      expect(Math.hypot(dx, dy)).toBeCloseTo(10, 10); // 2 × half
    }
    expect(endTicks({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });
  it("midpoints a segment", () => {
    expect(midpoint({ x: -2, y: 4 }, { x: 6, y: 10 })).toEqual({ x: 2, y: 7 });
  });
  it("places the loupe away from the nearest edge without covering the source", () => {
    const right = loupePlacement({ x: 700, y: 300 }, 140, 20, 800, 600)!;
    expect(right).not.toBeNull();
    expect(right.x + right.w).toBeLessThanOrEqual(700 - 20);
    const source: Rect = { x: 680, y: 280, w: 40, h: 40 };
    const overlaps = right.x < source.x + source.w && right.x + right.w > source.x
      && right.y < source.y + source.h && right.y + right.h > source.y;
    expect(overlaps).toBe(false);
    expect(right.x).toBeGreaterThanOrEqual(0);
    expect(right.y).toBeGreaterThanOrEqual(0);
    expect(right.x + right.w).toBeLessThanOrEqual(800);
    expect(right.y + right.h).toBeLessThanOrEqual(600);
    const left = loupePlacement({ x: 60, y: 300 }, 140, 20, 800, 600)!;
    expect(left.x).toBeGreaterThanOrEqual(80);
  });
  it("refuses a loupe that cannot fit the canvas", () => {
    expect(loupePlacement({ x: 10, y: 10 }, 140, 20, 100, 100)).toBeNull();
  });
});

/** Minimal recording context: a missing method here means drawVisualOverlays
 * called something a real Canvas2D context would not have. */
function fakeContext(withRoundRect: boolean): CanvasRenderingContext2D {
  const noop = () => undefined;
  const ctx: Record<string, unknown> = {
    canvas: { width: 1600, height: 1200, clientWidth: 800, clientHeight: 600 },
    setTransform: noop, save: noop, restore: noop, translate: noop, scale: noop, transform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, rect: noop,
    stroke: noop, fill: noop, strokeRect: noop, fillRect: noop, clearRect: noop,
    drawImage: noop, setLineDash: noop, strokeText: noop, fillText: noop,
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  if (withRoundRect) ctx.roundRect = noop;
  return ctx as unknown as CanvasRenderingContext2D;
}

const overlayItems: VisualToolOverlay[] = [
  { kind: "banner", text: "Measure: drag or click twice", tone: "neutral" },
  { kind: "banner", text: "Residual 0.42 px", tone: "accent" },
  { kind: "banner", text: "Degenerate points", tone: "danger" },
  { kind: "measure", a: { x: 10, y: 10 }, b: { x: 60, y: 40 }, label: "58.3 px | 5.83 mm", hint: "Calibrated", live: false },
  { kind: "measure", a: { x: 0, y: 0 }, b: { x: 30, y: 30 }, label: "42.4 px", live: true },
  { kind: "rotateGizmo", center: { x: 40, y: 40 }, knob: { x: 80, y: 40 }, radius: 40, dragging: true, line: { a: { x: 0, y: 20 }, b: { x: 80, y: 24 }, axis: "horizontal" } },
  { kind: "alignMarkers", points: [{ p: { x: 10, y: 10 }, index: 1, phase: "moving" }, { p: { x: 50, y: 50 }, index: 2, phase: "reference" }], loupe: { at: { x: 20, y: 20 } } },
  { kind: "cropPreview", polygon: [{ x: 5, y: 5 }, { x: 50, y: 5 }, { x: 50, y: 40 }, { x: 5, y: 40 }] },
  { kind: "resizeLine", a: { x: 0, y: 30 }, b: { x: 60, y: 30 }, axis: "x", step: 1 },
];

describe("drawVisualOverlays", () => {
  it("paints every overlay kind with and without roundRect support", () => {
    expect(() => drawVisualOverlays(fakeContext(true), overlayItems, view())).not.toThrow();
    expect(() => drawVisualOverlays(fakeContext(false), overlayItems, view())).not.toThrow();
    expect(() => drawVisualOverlays(fakeContext(true), overlayItems, view({ flipX: true, flipY: true }))).not.toThrow();
  });
  it("skips a loupe whose source region leaves the canvas", () => {
    const items: VisualToolOverlay[] = [
      { kind: "alignMarkers", points: [], loupe: { at: { x: -100, y: -100 } } },
    ];
    expect(() => drawVisualOverlays(fakeContext(true), items, view())).not.toThrow();
  });
  it("tolerates a null context and empty items", () => {
    expect(drawVisualOverlays(null, overlayItems, view())).toBeUndefined();
    expect(drawVisualOverlays(fakeContext(true), [], view())).toBeUndefined();
  });
});
