import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { VisualCanvas } from "./VisualCanvas";

vi.mock("../../bridge/project", async (original) => ({
  ...await original<object>(),
  assetRead: vi.fn(async () => new ArrayBuffer(8)),
}));

// Resize anti-flicker: the ResizeObserver callback must repaint synchronously
// (before the browser paints), and a no-op tick must neither clear the bitmap
// nor repaint at all.

/** Minimal ResizeObserver double: keeps the callback and the observed targets
 * so a test can fire resize ticks manually with synthetic entries. */
class ResizeObserverStub {
  readonly observed: Element[] = [];
  constructor(readonly callback: (entries: ResizeObserverEntry[]) => void) {
    observerStubs.push(this);
  }
  observe(target: Element): void { this.observed.push(target); }
  unobserve(): void {}
  disconnect(): void {}
}
const observerStubs: ResizeObserverStub[] = [];

/** Records every 2D-context call and property write: jsdom has no canvas
 * rasterizer, so "was it painted?" becomes "were ops recorded?". */
function recordingContext(): { ctx: CanvasRenderingContext2D; ops: { op: string; args: unknown[] }[] } {
  const ops: { op: string; args: unknown[] }[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (typeof property !== "string") return undefined;
      return (...args: unknown[]) => { ops.push({ op: property, args }); };
    },
    set: (target, property, value) => {
      target[property as string] = value;
      ops.push({ op: property as string, args: [value] });
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

/** A spec-shaped observer entry; device defaults to an EMPTY device-pixel box
 * (allowed per spec) so the css × dpr fallback path is exercised. */
const roEntry = (
  width: number,
  height: number,
  device: ReadonlyArray<{ inlineSize: number; blockSize: number }> = [],
): ResizeObserverEntry => ({
  target: document.createElement("div"),
  contentRect: new DOMRect(0, 0, width, height),
  borderBoxSize: [],
  contentBoxSize: [],
  devicePixelContentBoxSize: device,
});

const domRect = (width: number, height: number) =>
  ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) });

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("paints synchronously on a changed resize tick and stays silent on an unchanged one", async () => {
  observerStubs.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // Frames are requested but the callback NEVER runs: any paint recorded
  // below must have happened synchronously inside the resize callback.
  const raf = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { ctx, ops } = recordingContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(domRect(500, 400));
  const doc: ProjectDoc = {
    schemaVersion: 1, name: "Resize", createdAt: "t", updatedAt: "t",
    types: SEED_TYPES, boards: [], components: [], assets: {},
  };
  const store = createPlacementStore({ openProject: async () => ({ doc, assets: {}, path: "C:\\test.pcbre" }), save: vi.fn() });
  await store.openProject("C:\\test.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  try {
    render(() => <VisualCanvas store={store} selected={null} select={() => {}} active opacityDraft={null} tool={null} flipX={false} flipY={false} onToolEnd={() => {}} onPrompt={() => {}} />);
    const canvas = screen.getByLabelText("Visual editor photographs") as HTMLCanvasElement;
    const observer = observerStubs[observerStubs.length - 1]!;
    expect(observer.observed[0]).toBe(canvas.parentElement);
    expect(canvas.width).toBe(500);
    expect(canvas.height).toBe(400);
    // Unchanged tick: nothing is written, cleared, or repainted.
    ops.length = 0;
    observer.callback([roEntry(500, 400)]);
    expect(ops).toEqual([]);
    expect(canvas.width).toBe(500);
    // Changed tick: the whole backing store is cleared and repainted inside
    // the callback, even though requestAnimationFrame never fired one.
    rect.mockReturnValue(domRect(700, 450));
    observer.callback([roEntry(700, 450)]);
    expect(raf).toHaveBeenCalled();
    expect(canvas.width).toBe(700);
    expect(canvas.height).toBe(450);
    const cleared = ops.filter((op) => op.op === "clearRect");
    expect(cleared).toHaveLength(1);
    expect(cleared[0].args).toEqual([0, 0, 700, 450]);
    expect(ops.length).toBeGreaterThan(1);
  } finally { cleanup(); store.dispose(); }
});

/** AC19: a deskewed photograph renders through the per-triangle affine mesh
 * (clipped, transformed, overdrawn); a plain photograph keeps the single
 * drawImage fast path; both balance their save/restore pairs. */
it("renders perspective images via the triangle mesh and plain images with one drawImage", async () => {
  observerStubs.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  // jsdom has no image decoder: hand the cache a fake bitmap.
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 100, height: 80, close: vi.fn() })));
  const { ctx, ops } = recordingContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(domRect(500, 400));
  const doc: ProjectDoc = {
    schemaVersion: 1, name: "Deskew render", createdAt: "t", updatedAt: "t",
    types: SEED_TYPES, boards: [], components: [], assets: {},
  };
  const store = createPlacementStore({ openProject: async () => ({ doc, assets: {}, path: "C:\\test.pcbre" }), save: vi.fn() });
  await store.openProject("C:\\test.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  const asset = { hash: "a".repeat(64), size: 8, name: "photo.png" };
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  try {
    render(() => <VisualCanvas store={store} selected={null} select={() => {}} active opacityDraft={null} tool={null} flipX={false} flipY={false} onToolEnd={() => {}} onPrompt={() => {}} />);
    screen.getByLabelText("Visual editor photographs") as HTMLCanvasElement;
    const observer = observerStubs[observerStubs.length - 1]!;
    // plain image: let the bitmap promise settle, then paint via a resize tick
    await new Promise((resolve) => setTimeout(resolve, 0));
    rect.mockReturnValue(domRect(600, 400));
    observer.callback([roEntry(600, 400)]);
    let draws = ops.filter((op) => op.op === "drawImage");
    expect(draws).toHaveLength(1);
    expect(draws[0].args).toHaveLength(9); // bitmap + 9-arg crop draw
    expect(ops.filter((op) => op.op === "clip")).toHaveLength(0);
    const saves = ops.filter((op) => op.op === "save").length;
    const restores = ops.filter((op) => op.op === "restore").length;
    expect(saves).toBe(restores);
    expect(saves).toBeGreaterThanOrEqual(3);
    // deskewed image: 12x12 cells × 2 triangles = 288 clipped affine draws
    const image = store.visual.activePcb()!.images[0];
    store.visual.updateImageTransform(image.id, {
      perspective: { a: 1.02, b: 0.001, c: 0.5, d: -0.001, e: 1.01, f: -0.25, g: 0.000001, h: 0.000002 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ops.length = 0;
    rect.mockReturnValue(domRect(700, 450));
    observer.callback([roEntry(700, 450)]);
    draws = ops.filter((op) => op.op === "drawImage");
    expect(draws).toHaveLength(12 * 12 * 2);
    // full bitmap at (0,0) in source-px space: the triangle affine is on ctx
    expect(draws.every((op) => op.args.length === 3 && op.args[1] === 0 && op.args[2] === 0)).toBe(true);
    expect(ops.filter((op) => op.op === "clip")).toHaveLength(12 * 12 * 2);
    expect(ops.filter((op) => op.op === "transform")).toHaveLength(12 * 12 * 2);
    const savesAfter = ops.filter((op) => op.op === "save").length;
    const restoresAfter = ops.filter((op) => op.op === "restore").length;
    expect(savesAfter).toBe(restoresAfter);
    expect(savesAfter).toBe(12 * 12 * 2 + 3);
  } finally { cleanup(); store.dispose(); }
});
