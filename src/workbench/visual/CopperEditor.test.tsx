import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { createCopperEditor, type CopperEditor } from "./CopperEditor";
let store: ReturnType<typeof createPlacementStore>;
let editor: CopperEditor;
beforeEach(async () => {
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Test",
    createdAt: "t",
    updatedAt: "t",
    types: SEED_TYPES,
    boards: [],
    components: [],
    assets: {},
  };
  store = createPlacementStore({
    openProject: async () => ({ doc, assets: {}, path: "test.pcbre" }),
    save: vi.fn(),
  });
  await store.openProject("test.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  store.visual.calibratePcb(10);
  render(() => {
    editor = createCopperEditor(
      store,
      () => true,
      () => {},
    );
    return (
      <>
        <editor.Toolbar />
        <editor.Inspector />
        <editor.Dialog />
      </>
    );
  });
});
afterEach(() => store.dispose());
function trace(a: { x: number; y: number }, b: { x: number; y: number }) {
  fireEvent.click(screen.getByRole("button", { name: "Place trace" }));
  editor.down(a, 1, true, 0);
  editor.down(b, 1, true, 0);
  editor.finish();
}
it("creates isolated copper with persisted net/color and undo", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  const p = store.visual.activePcb()!;
  expect(p.traces).toHaveLength(1);
  expect(p.traces![0].width).toBe(5);
  expect(p.nets![0].color).toMatch(/^#[0-9a-f]{6}$/i);
  store.undo();
  expect(store.visual.activePcb()!.traces ?? []).toHaveLength(0);
});
it("prompts before joining nets and cancels without document mutation", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  trace({ x: 0, y: 100 }, { x: 100, y: 100 });
  const before = JSON.stringify(store.doc());
  trace({ x: 50, y: 0 }, { x: 50, y: 100 });
  expect(
    screen.getByRole("dialog", { name: "Join connected nets" }),
  ).toBeTruthy();
  expect(JSON.stringify(store.doc())).toBe(before);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(JSON.stringify(store.doc())).toBe(before);
});
it("joins atomically and undo restores separate nets", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  trace({ x: 0, y: 100 }, { x: 100, y: 100 });
  trace({ x: 50, y: 0 }, { x: 50, y: 100 });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(store.visual.activePcb()!.nets).toHaveLength(1);
  expect(store.visual.activePcb()!.traces).toHaveLength(3);
  store.undo();
  expect(store.visual.activePcb()!.nets).toHaveLength(2);
  expect(store.visual.activePcb()!.traces).toHaveLength(2);
});
it("keeps zone overlaps manually netted and leaves cancelled naming netless", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Place zone" }));
  editor.down({ x: -20, y: -20 }, 1, false, 0);
  editor.down({ x: 120, y: -20 }, 1, false, 0);
  editor.down({ x: 120, y: 120 }, 1, false, 0);
  editor.finish();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(store.visual.activePcb()!.zones![0].netId).toBeUndefined();
  expect(store.visual.activePcb()!.nets).toHaveLength(1);
});
it("does not commit stale copper drags after a PCB change", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  editor.down({ x: 0, y: 0 }, 1, false, 0);
  store.visual.addPcb();
  expect(() => editor.up({ x: 10, y: 10 })).not.toThrow();
  expect(store.visual.activePcb()!.traces ?? []).toHaveLength(0);
});
it("clears a deleted placement net before placing new isolated copper", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Place via" }));
  const p = store.visual.activePcb()!;
  fireEvent.change(screen.getByRole("combobox", { name: "Net" }), {
    target: { value: p.nets![0].id },
  });
  store.visual.replaceCopper(p.id, {
    nets: [],
    traces: p.traces!.map((t) => ({ ...t, netId: undefined })),
    zones: [],
    vias: [],
  });
  editor.down({ x: 200, y: 200 }, 1, true, 0);
  const next = store.visual.activePcb()!;
  expect(next.nets).toHaveLength(1);
  expect(next.vias![0].netId).toBe(next.nets![0].id);
  expect(next.nets![0].id).not.toBe(p.nets![0].id);
});
