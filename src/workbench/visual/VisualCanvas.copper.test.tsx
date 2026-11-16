import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { VisualCanvas } from "./VisualCanvas";
import type { CopperEditor } from "./CopperEditor";

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
