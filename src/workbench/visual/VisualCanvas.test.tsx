import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { VisualCanvas } from "./VisualCanvas";

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
