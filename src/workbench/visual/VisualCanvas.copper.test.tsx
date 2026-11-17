import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { VisualCanvas } from "./VisualCanvas";
import type { CopperEditor } from "./CopperEditor";
import type { VisualPcb } from "./model";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("recognizes copper-only scenes and cancels drags without discarding click routes", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const doc: ProjectDoc = {
    schemaVersion: 1, name: "Copper", createdAt: "t", updatedAt: "t",
    types: SEED_TYPES, boards: [], components: [], assets: {},
    visualEditor: { activePcbId: "pcb", pcbs: [{ id: "pcb", name: "PCB", layers: ["front", "back"], images: [], vias: [{ id: "via", x: 500, y: 500, diameter: 10, drill: 5 }] }] },
  };
  const store = createPlacementStore({ openProject: async () => ({ doc, assets: {}, path: "C:\\test.pcbre" }), save: vi.fn() });
  await store.openProject("C:\\test.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  const cancel = vi.fn(), cancelDrag = vi.fn();
  const copper = { layer: () => "front", cancel, cancelDrag } as unknown as CopperEditor;
  try {
    render(() => <VisualCanvas store={store} copper={copper} selected={null} select={() => {}} active opacityDraft={null} tool={null} flipX={false} flipY={false} onToolEnd={() => {}} onPrompt={() => {}} />);
    expect(screen.queryByText("Add photographs to compare PCB layers.")).toBeNull();
    const canvas = screen.getByLabelText("Visual editor photographs");
    fireEvent.pointerCancel(canvas);
    fireEvent.lostPointerCapture(canvas);
    expect(cancelDrag).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  } finally { cleanup(); store.dispose(); }
});

it("selects region with left drag and multi-moves elements together while ignoring locked images", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => {},
  });
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "MultiMove",
    createdAt: "t",
    updatedAt: "t",
    types: SEED_TYPES,
    boards: [],
    components: [],
    assets: {},
    visualEditor: {
      activePcbId: "pcb",
      pcbs: [
        {
          id: "pcb",
          name: "PCB",
          layers: ["front"],
          images: [
            {
              id: "img1",
              name: "Unlocked",
              assetHash: "h1",
              width: 20,
              height: 20,
              x: 50,
              y: 50,
              flipH: false,
              flipV: false,
              visible: true,
              opacity: 1,
              locked: false,
              layerId: "front",
            },
            {
              id: "imgLocked",
              name: "Locked",
              assetHash: "h2",
              width: 20,
              height: 20,
              x: 60,
              y: 60,
              flipH: false,
              flipV: false,
              visible: true,
              opacity: 1,
              locked: true,
              layerId: "front",
            },
          ],
          vias: [{ id: "via1", x: 70, y: 70, diameter: 10, drill: 5 }],
          traces: [
            {
              id: "trace1",
              points: [
                { x: 40, y: 40 },
                { x: 80, y: 80 },
              ],
              width: 2,
              layerId: "front",
            },
          ],
        },
      ],
    },
  };
  const store = createPlacementStore({
    openProject: async () => ({ doc, assets: {}, path: "C:\\test.pcbre" }),
    save: vi.fn(),
  });
  await store.openProject("C:\\test.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });

  const copper = {
    layer: () => "front",
    hit: (p: { x: number; y: number }) => {
      if (Math.hypot(p.x - 70, p.y - 70) <= 10) {
        return { id: "via1", x: 70, y: 70, diameter: 10, drill: 5 };
      }
      return undefined;
    },
    setSelected: vi.fn(),
    cancelDrag: vi.fn(),
    draw: vi.fn(),
    move: vi.fn(),
    up: vi.fn(),
    down: vi.fn(),
    drawing: () => false,
    // Multi-selection moves now route through the copper commit pipeline
    // (CopperEditor.commitMoved); this scene has no components or nets, so
    // the reconciled commit reduces to replaceCopper.
    commitMoved: (next: VisualPcb) => store.visual.replaceCopper(next.id, next),
  } as unknown as CopperEditor;

  try {
    render(() => (
      <VisualCanvas
        store={store}
        copper={copper}
        selected={null}
        select={() => {}}
        active
        opacityDraft={null}
        tool={null}
        flipX={false}
        flipY={false}
        onToolEnd={() => {}}
        onPrompt={() => {}}
      />
    ));
    const canvas = screen.getByLabelText("Visual editor photographs");

    // 1. Box select from world (0, 0) to (120, 120).
    // Initial offset is 30, 30 and scale is 1.
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 150, clientY: 150, pointerId: 1 });

    // 2. Drag the selected via at world (70, 70), which is screen (100, 100).
    // Move it by dx = +20, dy = +30 to screen (120, 130).
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 120, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 120, clientY: 130, pointerId: 1 });

    const pcb = store.visual.activePcb()!;
    const via = pcb.vias!.find((v) => v.id === "via1")!;
    const img1 = pcb.images.find((i) => i.id === "img1")!;
    const imgLocked = pcb.images.find((i) => i.id === "imgLocked")!;
    const trace = pcb.traces!.find((t) => t.id === "trace1")!;

    // Moved elements
    expect(via.x).toBe(90);
    expect(via.y).toBe(100);
    expect(img1.x).toBe(70);
    expect(img1.y).toBe(80);
    expect(trace.points[0].x).toBe(60);
    expect(trace.points[0].y).toBe(70);
    expect(trace.points[1].x).toBe(100);
    expect(trace.points[1].y).toBe(110);

    // Locked image did not move!
    expect(imgLocked.x).toBe(60);
    expect(imgLocked.y).toBe(60);

    // 3. Middle click (button 1) pans the canvas without moving elements
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 1, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 200, clientY: 200, pointerId: 1 });

    const pcbAfterPan = store.visual.activePcb()!;
    expect(pcbAfterPan.vias!.find((v) => v.id === "via1")!.x).toBe(90);
  } finally {
    cleanup();
    store.dispose();
  }
});
