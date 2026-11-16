import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { CanvasStage } from "./CanvasStage";
import { hoverSummary } from "./hoverInfo";
import { createPlacementStore } from "./store";
import { SEED_TYPES, type ProjectDoc } from "./projectDoc";

vi.mock("../../bridge/project", async (original) => ({
  ...await original<typeof import("../../bridge/project")>(),
  assetRead: vi.fn(async () => new ArrayBuffer(0)),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup() {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
  const doc: ProjectDoc = {
    schemaVersion: 1, name: "Scene", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", assets: {}, types: [...SEED_TYPES],
    boards: [
      { id: "a", name: "First", assetHash: "a".repeat(64), width: 100, height: 80 },
      { id: "b", name: "Second", assetHash: "b".repeat(64), width: 100, height: 80, sceneX: 200, sceneY: 0 },
    ],
    components: [{ id: "r1", boardId: "b", refdes: "R1", typeId: "resistor", status: "unknown", locked: false, shape: { rect: { x: 5, y: 5, w: 20, h: 20 } } }],
    mappingTabs: [{ id: "tab", name: "Board 1", boardIds: ["a", "b"] }], activeMappingTabId: "tab", activeBoardId: "a",
  };
  const store = createPlacementStore({ openProject: vi.fn(async () => ({ doc, assets: {}, path: "C:\\scene.pcbre" })) });
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  await store.openProject("C:\\scene.pcbre");
  render(() => <CanvasStage store={store} onAddBoard={vi.fn()} />);
  const canvas = screen.getByRole("application");
  Object.defineProperty(canvas, "setPointerCapture", { configurable: true, value: vi.fn() });
  const pointer = (type: string, x: number, y: number) => fireEvent(canvas, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  return { store, canvas, pointer };
}

it("moves an image once while markings remain selectable at their original scene position", async () => {
  const { store, pointer } = await setup();
  const update = vi.spyOn(store, "updateBoard");
  const shape = structuredClone(store.doc()!.components[0].shape);
  pointer("pointerdown", 520, 200);
  expect(store.activeBoard()?.id).toBe("b");
  expect(store.boardSelected()).toBe(true);
  pointer("pointermove", 560, 220);
  expect(update).not.toHaveBeenCalled();
  pointer("pointerup", 560, 220);
  expect(update).toHaveBeenCalledExactlyOnceWith("b", { sceneX: 220, sceneY: 10 });
  expect(store.doc()!.components[0].shape).toEqual(shape);
  expect(shape).toEqual({ rect: { x: 205, y: 5, w: 20, h: 20 } });
  store.updateBoard("b", { sceneX: 1000, sceneY: 1000 });
  pointer("pointerdown", 425, 145);
  expect(store.selectedId()).toBe("r1");
  pointer("pointerup", 425, 145);
});

it("cancels an image drag without committing a placement", async () => {
  const { store, pointer } = await setup();
  const update = vi.spyOn(store, "updateBoard");
  pointer("pointerdown", 520, 200);
  pointer("pointermove", 560, 220);
  pointer("pointercancel", 560, 220);
  expect(update).not.toHaveBeenCalled();
  expect(store.activeBoard()?.sceneX).toBe(200);
});

it("selects a component on another scene image without dragging that image", async () => {
  const { store, pointer } = await setup();
  const update = vi.spyOn(store, "updateBoard");
  pointer("pointerdown", 425, 145);
  expect(store.selectedId()).toBe("r1");
  pointer("pointerup", 425, 145);
  expect(update).not.toHaveBeenCalled();
});

it("shows hover cursors and publishes the hover summary to the status bar", async () => {
  const { canvas, pointer } = await setup();
  // The fitted view maps scene px 1:2 with offset (0,120): component r1
  // (scene 205..225 × 5..25) lands at screen (410..450 × 130..170).
  pointer("pointermove", 430, 150);
  expect(canvas.style.cursor).toBe("move");
  expect(hoverSummary()).toBe("R1 · Resistor");
  // An empty area of the first picture: unlocked picture → move + its name.
  pointer("pointermove", 100, 200);
  expect(canvas.style.cursor).toBe("move");
  expect(hoverSummary()).toBe("First");
  // Select the rect, then hover its east handle (scene 225,15 → 450,150).
  pointer("pointerdown", 425, 145);
  pointer("pointerup", 425, 145);
  pointer("pointermove", 450, 150);
  expect(canvas.getAttribute("style")).toContain("ew-resize");
  // Leaving the canvas resets the cursor and clears the summary.
  fireEvent.pointerLeave(canvas);
  expect(canvas.style.cursor).toBe("default");
  expect(hoverSummary()).toBeNull();
});

it("refuses locked hover targets and resets to the baseline cursor off-target", async () => {
  const { store, canvas, pointer } = await setup();
  // Lock the picture under the empty area: hovering it shows not-allowed,
  // while its name still surfaces as the summary.
  store.updateBoard("a", { locked: true });
  pointer("pointermove", 100, 200);
  expect(canvas.getAttribute("style")).toContain("not-allowed");
  expect(hoverSummary()).toBe("First");
  // Off every target the Select baseline cursor returns.
  pointer("pointermove", 300, 30);
  expect(canvas.style.cursor).toBe("default");
  expect(hoverSummary()).toBeNull();
});

it("undoes and redoes a committed image crop with canvas shortcuts", async () => {
  const { store, canvas, pointer } = await setup();
  store.setTool("crop");
  pointer("pointerdown", 20, 140);
  pointer("pointermove", 160, 240);
  pointer("pointerup", 160, 240);
  expect(store.cropDraft()).toEqual({ x: 10, y: 10, w: 70, h: 50 });
  store.applyCrop();
  expect(store.doc()!.boards[0].crop).toEqual({ x: 10, y: 10, w: 70, h: 50 });
  fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  expect(store.doc()!.boards[0].crop).toBeUndefined();
  fireEvent.keyDown(canvas, { key: "Z", ctrlKey: true, shiftKey: true });
  expect(store.doc()!.boards[0].crop).toEqual({ x: 10, y: 10, w: 70, h: 50 });
});

it("draws and selects scene markings in an empty mapping tab", async () => {
  const { store, pointer } = await setup();
  store.addMappingTab();
  store.setView({ scale: 1, offsetX: 0, offsetY: 0 });
  store.setTool("rect");
  pointer("pointerdown", 50, 60);
  pointer("pointermove", 120, 100);
  pointer("pointerup", 120, 100);
  const selected = store.selectedComponent();
  expect(selected?.shape).toEqual({ rect: { x: 50, y: 60, w: 70, h: 40 } });
  expect(selected?.coordinateSpace).toBe("scene");
  store.setSelectedId(null);
  pointer("pointerdown", 80, 80);
  expect(store.selectedId()).toBe(selected?.id);
});
