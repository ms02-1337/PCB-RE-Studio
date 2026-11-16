import { it, expect, vi, beforeEach, afterEach, describe } from "vitest";
import {
  AUTOSAVE_DELAY_MS,
  MAX_AUTOSAVE_DELAY_MS,
  MIN_AUTOSAVE_DELAY_MS,
  clockText,
  createPlacementStore,
} from "./store";
import { normalizeMappingTabs, SEED_TYPES, UNASSIGNED_TYPE_ID, type ProjectDoc } from "./projectDoc";
import { imageToDisplay } from "./boardTransform";
import { ProjectBridgeError, type LoadedProject, type SaveResult } from "../../bridge/project";
import { loadRecent } from "../projects/recent";

const dialogs = vi.hoisted(() => ({
  pickProjectSave: vi.fn(),
  pickProjectOpen: vi.fn(),
  pickProjectImportSource: vi.fn(),
  pickImageImport: vi.fn(),
  pickHtmlExportPath: vi.fn(),
}));

vi.mock("../../bridge/dialog", () => ({
  pickProjectSave: dialogs.pickProjectSave,
  pickProjectOpen: dialogs.pickProjectOpen,
  pickProjectImportSource: dialogs.pickProjectImportSource,
  pickImageImport: dialogs.pickImageImport,
  pickHtmlExportPath: dialogs.pickHtmlExportPath,
}));

function seededDoc(name = "Unit fixture"): ProjectDoc {
  return {
    schemaVersion: 1,
    name,
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    types: SEED_TYPES.map((type) => ({ ...type })),
    boards: [],
    components: [],
    assets: {},
  };
}

function loaded(doc: ProjectDoc): LoadedProject {
  return { doc, assets: doc.assets, path: "C:\\proj\\fixture.pcbre" };
}

const okSave = (path = "C:\\proj\\fixture.pcbre"): SaveResult => ({
  path,
  bytes: 1234,
  blobCount: 0,
  savedAt: "2026-11-15T10:30:00Z",
});
function makeStore() {
  const bridge = {
    newProject: vi.fn(),
    openProject: vi.fn(),
    importProjectCopy: vi.fn(),
    save: vi.fn().mockResolvedValue(okSave()),
    saveAs: vi.fn(),
    close: vi.fn(),
    exportHtml: vi.fn().mockResolvedValue(2048),
    projectExportCopy: vi.fn().mockResolvedValue(okSave("C:\\proj\\fixture-copy.pcbre")),
    projectDelete: vi.fn().mockResolvedValue(null),
  };
  const store = createPlacementStore(bridge);
  return { store, bridge };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.values(dialogs).forEach((dialog) => dialog.mockReset());
});

describe("multi-image mapping scenes", () => {
  it("migrates legacy rectangle and ellipse axes through crop, rotation, flip, scale and translation", () => {
    const source = seededDoc();
    source.boards.push({ id: "old", name: "Front", assetHash: "a".repeat(64), width: 200, height: 100, rotation: 90, flipH: true, scale: 200, sceneX: 300, sceneY: -40, crop: { x: 10, y: 10, w: 180, h: 80 } });
    const common = { boardId: "old", typeId: "resistor", status: "identified" as const, locked: false };
    source.components.push({ ...common, id: "r1", refdes: "R1", shape: { rect: { x: 20, y: 20, w: 20, h: 20 } } });
    source.components.push({ ...common, id: "r2", refdes: "R2", shape: { ellipse: { cx: 30, cy: 30, rx: 10, ry: 5 } } });
    const migrated = normalizeMappingTabs(source);
    expect(migrated.components[0].shape).toEqual({ rect: { x: 320, y: -20, w: 40, h: 40 } });
    expect(migrated.components[1].shape).toEqual({ ellipse: { cx: 340, cy: 0, rx: 10, ry: 20 } });
    expect(normalizeMappingTabs(migrated).components).toEqual(migrated.components);
  });
  it("migrates old markings once into scene coordinates and keeps them after image movement or deletion", async () => {
    const { store, bridge } = makeStore();
    const source = seededDoc();
    const board = { id: "old", name: "Front", assetHash: "a".repeat(64), width: 200, height: 100, rotation: 90 as const, flipH: true, scale: 200, sceneX: 300, sceneY: -40, crop: { x: 10, y: 10, w: 180, h: 80 } };
    source.boards.push(board);
    source.components.push({ id: "r1", boardId: "old", refdes: "R1", typeId: "resistor", shape: { polygon: { points: [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 20, y: 40 }] } }, status: "identified", locked: false });
    bridge.openProject.mockResolvedValue(loaded(source));
    await store.openProject("C:\\legacy.pcbre");
    const migrated = store.sceneComponents()[0];
    expect(migrated.coordinateSpace).toBe("scene");
    expect(migrated.shape).toEqual({ polygon: { points: [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 20, y: 40 }].map((point) => imageToDisplay(board, point)) } });
    store.updateBoard("old", { sceneX: 900, sceneY: 120 });
    expect(store.sceneComponents()[0].shape).toEqual(migrated.shape);
    await store.saveNow();
    const saved = bridge.save.mock.calls[0][0] as ProjectDoc;
    bridge.openProject.mockResolvedValue(loaded(saved));
    await store.openProject("C:\\saved.pcbre");
    expect(store.sceneComponents()[0].shape).toEqual(migrated.shape);
    store.deleteBoard("old");
    expect(store.doc()?.boards).toHaveLength(0);
    expect(store.sceneComponents()).toHaveLength(1);
    store.deleteMappingTab(store.activeMappingTab()!.id);
    expect(store.doc()?.components).toHaveLength(0);
  });

  it("undoes committed crop and geometry changes across saves and resets history per project", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\fixture.pcbre");
    store.addBoard({ name: "Front", asset: { hash: "a".repeat(64), name: "a.png", size: 2 }, width: 100, height: 100 });
    expect(store.canUndo()).toBe(false);
    store.setCropDraft({ x: 10, y: 10, w: 50, h: 50 });
    store.applyCrop();
    expect(store.activeBoard()?.crop).toEqual({ x: 10, y: 10, w: 50, h: 50 });
    await store.saveNow();
    store.undo();
    expect(store.activeBoard()?.crop).toBeUndefined();
    expect(store.saveState()).toBe("dirty");
    expect(store.canRedo()).toBe(true);
    store.redo();
    expect(store.activeBoard()?.crop?.w).toBe(50);
    store.updateBoard(store.activeBoard()!.id, { sceneX: 40 });
    store.undo();
    expect(store.activeBoard()?.sceneX).toBe(0);
    await store.openProject("C:\\other.pcbre");
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });

  it("persists component descriptions and multiple photo references and clears undo at asset boundaries", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\fixture.pcbre");
    const first = { hash: "a".repeat(64), name: "a.png", size: 2 }, second = { hash: "b".repeat(64), name: "b.png", size: 3 };
    store.registerAsset(first); store.registerAsset(second);
    const id = store.addComponent({ boardId: "scene", typeId: "resistor", refdes: "R1", shape: { rect: { x: 0, y: 0, w: 20, h: 20 } } });
    store.updateComponent(id, { description: "A measured resistor", imageHashes: [first.hash, second.hash] });
    expect(store.canUndo()).toBe(false);
    await store.saveNow();
    const saved = bridge.save.mock.calls[0][0] as ProjectDoc;
    expect(saved.components[0].description).toBe("A measured resistor");
    expect(saved.components[0].imageHashes).toEqual([first.hash, second.hash]);
    store.updateComponent(id, { description: "x".repeat(4001) });
    expect(store.sceneComponents()[0].description).toBe("A measured resistor");
    store.updateComponent(id, { description: "Changed" });
    expect(store.canUndo()).toBe(true);
    store.updateComponent(id, { imageHashes: [second.hash] });
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });
  it("persists component image display names into the doc and through save", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    const hash = "a".repeat(64);
    store.registerAsset({ hash, name: "a.png", size: 2 });
    const id = store.addComponent({ boardId: "scene", typeId: "resistor", refdes: "R1", shape: { rect: { x: 0, y: 0, w: 20, h: 20 } } });
    // The patch carries the complete record; empty strings clear a name.
    store.updateComponent(id, { imageNames: { [hash]: "Top view" } });
    expect(store.doc()!.components[0].imageNames).toEqual({ [hash]: "Top view" });
    store.updateComponent(id, { imageNames: { [hash]: "" } });
    expect(store.doc()!.components[0].imageNames).toEqual({ [hash]: "" });
    store.updateComponent(id, { imageNames: { [hash]: "Angled view" } });
    await store.saveNow();
    const saved = bridge.save.mock.calls[0][0] as ProjectDoc;
    expect(saved.components[0].imageNames).toEqual({ [hash]: "Angled view" });
    bridge.openProject.mockResolvedValue(loaded(saved));
    await store.openProject("C:\\saved.pcbre");
    expect(store.doc()?.components[0].imageNames?.[hash]).toBe("Angled view");
    // Client-side guard rejects oversized labels without mutating.
    const before = store.doc();
    store.updateComponent(id, { imageNames: { [hash]: "x".repeat(201) } });
    expect(store.doc()).toBe(before);
    expect(store.statusMessage()).toContain("Image names");
  });

  it("discards an image picker completion after switching tabs", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\fixture.pcbre");
    let finish!: (path: string) => void;
    dialogs.pickImageImport.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const importing = store.addBoardFlow();
    store.addMappingTab();
    finish("C:\\board.png");
    await importing;
    expect(store.doc()?.boards).toHaveLength(0);
    expect(store.sceneBoards()).toHaveLength(0);
  });
  it("opens one empty tab and imports several images into that scene", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\fixture.pcbre");
    expect(store.mappingTabs()).toHaveLength(1);
    const firstTab = store.activeMappingTab()!.id;
    const asset = { hash: "a".repeat(64), name: "board.png", size: 10 };
    store.addBoard({ name: "Front", asset, width: 200, height: 100 });
    const first = store.activeBoard()!;
    store.addBoard({ name: "Back", asset, width: 100, height: 100 });
    expect(store.mappingTabs()).toHaveLength(1);
    expect(store.sceneBoards()).toHaveLength(2);
    expect(store.activeBoard()!.sceneX).toBe(240);
    store.updateBoard(first.id, { sceneX: -120, sceneY: 50 });
    expect(store.sceneBoards()[0].sceneX).toBe(-120);
    store.addMappingTab();
    expect(store.sceneBoards()).toEqual([]);
    expect(store.activeBoard()).toBeUndefined();
    store.activateMappingTab(firstTab);
    expect(store.sceneBoards()).toHaveLength(2);
    expect(store.activeBoard()?.id).toBe(first.id);
    store.dispose();
  });

  it("migrates legacy image tabs and deletes only the chosen scene", async () => {
    const { store, bridge } = makeStore();
    const legacy = seededDoc();
    legacy.boards = ["front", "back"].map((id) => ({ id, name: id, assetHash: "a".repeat(64), width: 100, height: 100 }));
    legacy.activeBoardId = "back";
    bridge.openProject.mockResolvedValue(loaded(legacy));
    await store.openProject("C:\\legacy.pcbre");
    expect(store.mappingTabs()).toHaveLength(2);
    expect(store.sceneBoards().map((board) => board.id)).toEqual(["back"]);
    store.deleteMappingTab(store.activeMappingTab()!.id);
    expect(store.doc()?.boards.map((board) => board.id)).toEqual(["front"]);
    store.deleteMappingTab(store.activeMappingTab()!.id);
    expect(store.mappingTabs()).toHaveLength(1);
    expect(store.sceneBoards()).toEqual([]);
    store.dispose();
  });

  it("persists scene grouping and positions without changing image-local shapes", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\fixture.pcbre");
    store.addBoard({ name: "Front", asset: { hash: "a".repeat(64), name: "a.png", size: 2 }, width: 100, height: 100 });
    const id = store.activeBoard()!.id;
    const shape = { rect: { x: 1, y: 2, w: 10, h: 12 } };
    store.addComponent({ boardId: id, typeId: "resistor", refdes: "R1", shape });
    store.updateBoard(id, { sceneX: 200, sceneY: -40 });
    await store.saveNow();
    const saved = bridge.save.mock.calls[0][0] as ProjectDoc;
    expect(saved.mappingTabs?.[0].boardIds).toEqual([id]);
    expect(saved.boards[0].sceneY).toBe(-40);
    expect(saved.components[0].shape).toEqual(shape);
    store.updateBoard(id, { sceneX: Infinity });
    expect(store.activeBoard()?.sceneX).toBe(200);
    store.dispose();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("loads seeded types and boards via the bridge", async () => {
  const { store, bridge } = makeStore();
  bridge.newProject.mockResolvedValue(loaded(seededDoc("New board")));
  await store.newProject("C:\\proj\\new.pcbre", "New board");
  expect(bridge.newProject).toHaveBeenCalledWith("C:\\proj\\new.pcbre", "New board");
  expect(store.doc()?.name).toBe("New board");
  expect(store.doc()?.types).toHaveLength(10);
  expect(store.projectPath()).toBe("C:\\proj\\fixture.pcbre");
  expect(store.saveState()).toBe("saved");
});

it("imports a project copy only after saving the current project", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc("Current")));
  await store.openProject("C:\\proj\\current.pcbre");
  store.updateProjectMeta({ description: "Changed before import" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  dialogs.pickProjectImportSource.mockResolvedValue("C:\\incoming\\source.pcbre");
  dialogs.pickProjectSave.mockResolvedValue("C:\\projects\\source-copy.pcbre");
  bridge.importProjectCopy.mockResolvedValue({
    ...loaded(seededDoc("Imported")),
    path: "C:\\projects\\source-copy.pcbre",
  });

  await store.importProjectFlow();

  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(dialogs.pickProjectImportSource).toHaveBeenCalledOnce();
  expect(dialogs.pickProjectSave).toHaveBeenCalledWith("source-copy.pcbre");
  expect(bridge.importProjectCopy).toHaveBeenCalledWith(
    "C:\\incoming\\source.pcbre",
    "C:\\projects\\source-copy.pcbre",
  );
  expect(store.doc()?.name).toBe("Imported");
  expect(store.projectPath()).toBe("C:\\projects\\source-copy.pcbre");
  expect(store.saveState()).toBe("idle");
});

it("keeps the active project when import destination selection is cancelled", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc("Current")));
  await store.openProject("C:\\proj\\current.pcbre");
  dialogs.pickProjectImportSource.mockResolvedValue("C:\\incoming\\source.pcbre");
  dialogs.pickProjectSave.mockResolvedValue(null);

  await store.importProjectFlow();

  expect(bridge.importProjectCopy).not.toHaveBeenCalled();
  expect(store.doc()?.name).toBe("Current");
  expect(store.projectPath()).toBe("C:\\proj\\fixture.pcbre");
});

it("debounces many mutations into one autosave after 2s idle", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\proj\\fixture.pcbre");
  store.addBoard({ name: "Front", asset: { hash: "a".repeat(64), size: 5, name: "f.png" }, width: 100, height: 80 });
  store.addComponent({ boardId: store.doc()!.boards[0].id, typeId: "resistor", shape: { rect: { x: 0, y: 0, w: 10, h: 10 } }, refdes: "R1" });
  store.addComponent({ boardId: store.doc()!.boards[0].id, typeId: "ic", shape: { rect: { x: 20, y: 0, w: 10, h: 10 } }, refdes: "U1" });
  expect(store.saveState()).toBe("dirty");
  expect(store.statusMessage()).toBe("Unsaved changes");
  expect(bridge.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
  expect(bridge.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(bridge.save.mock.calls[0][0].components).toHaveLength(2);
  expect(store.saveState()).toBe("saved");
  expect(store.statusMessage()).toBe(`Saved ${clockText("2026-11-15T10:30:00Z")}`);
});

it("keeps a single trailing save while another save is in flight", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  let release!: (result: SaveResult) => void;
  bridge.save.mockReturnValue(
    new Promise<SaveResult>((resolve) => {
      release = resolve;
    }),
  );
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(store.saveState()).toBe("saving");
  // Mutating while the first save is still running must not stack requests.
  store.updateComponent(store.doc()!.components[0].id, { partNumber: "LM358" });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
  expect(bridge.save).toHaveBeenCalledTimes(1);
  release(okSave());
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(bridge.save).toHaveBeenCalledTimes(2);
  expect(store.saveState()).toBe("saved");
});

it("keeps dirty state and retries after a failed save", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  bridge.save.mockRejectedValueOnce(new Error("disk unavailable"));
  bridge.save.mockResolvedValue(okSave());
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(store.saveState()).toBe("error");
  expect(store.statusMessage()).toBe("Save failed: disk unavailable");
  // Dirty remains; the scheduler retries without any new mutation.
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(bridge.save).toHaveBeenCalledTimes(2);
  expect(store.saveState()).toBe("saved");
});

it("flushes immediately on demand and closes after confirming discard", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  bridge.save.mockResolvedValue(okSave());
  bridge.close.mockResolvedValue(null);
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  await store.saveNow();
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(store.saveState()).toBe("saved");
  // New dirty work: close asks before discarding; a confirmed discard wipes
  // without another save.
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 9, y: 0, w: 5, h: 5 } }, refdes: "U2" });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await store.closeProject();
  expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/unsaved changes/i));
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(bridge.close).toHaveBeenCalledTimes(1);
  expect(store.doc()).toBeNull();
  expect(store.statusMessage()).toBe("Ready");
});

it("lifecycle flows abort with no side effects when the discard confirm is declined", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const before = store.doc();

  await store.newProjectFlow();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(dialogs.pickProjectSave).not.toHaveBeenCalled();
  expect(bridge.newProject).not.toHaveBeenCalled();

  await store.openProjectFlow();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(dialogs.pickProjectOpen).not.toHaveBeenCalled();
  expect(bridge.openProject).toHaveBeenCalledTimes(1); // only the initial load

  await store.closeProjectFlow();
  expect(confirm).toHaveBeenCalledTimes(3);
  expect(bridge.close).not.toHaveBeenCalled();
  // Declining leaves the project fully usable and still dirty.
  expect(store.doc()).toBe(before);
  expect(store.saveState()).toBe("dirty");
  expect(store.panelError()).toBe("");
});

it("lifecycle flows proceed after the discard confirm is accepted", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  const shape = { rect: { x: 0, y: 0, w: 5, h: 5 } };
  store.addComponent({ boardId: "b", typeId: "ic", shape, refdes: "U1" });
  vi.spyOn(window, "confirm").mockReturnValue(true);

  dialogs.pickProjectSave.mockResolvedValue("C:\\fresh.pcbre");
  bridge.newProject.mockResolvedValue(loaded(seededDoc("Fresh")));
  await store.newProjectFlow();
  expect(bridge.newProject).toHaveBeenCalledWith("C:\\fresh.pcbre", "fresh");
  expect(store.doc()?.name).toBe("Fresh");

  store.addComponent({ boardId: "b", typeId: "ic", shape, refdes: "R1" });
  dialogs.pickProjectOpen.mockResolvedValue("C:\\other.pcbre");
  bridge.openProject.mockResolvedValue(loaded(seededDoc("Other")));
  await store.openProjectFlow();
  expect(bridge.openProject).toHaveBeenLastCalledWith("C:\\other.pcbre");
  expect(store.doc()?.name).toBe("Other");

  store.addComponent({ boardId: "b", typeId: "ic", shape, refdes: "C1" });
  bridge.close.mockResolvedValue(null);
  await store.closeProjectFlow();
  expect(bridge.close).toHaveBeenCalledTimes(1);
  expect(store.doc()).toBeNull();
});

it("close flags a failed save in the discard prompt and aborts when declined", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  bridge.save.mockRejectedValueOnce(new Error("disk unavailable"));
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(store.saveState()).toBe("error");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await store.closeProjectFlow();
  expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/last save failed/i));
  expect(bridge.close).not.toHaveBeenCalled();
  expect(store.doc()).toBeTruthy();
});

it("close waits for an in-flight save to settle before confirming", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  let release!: (result: SaveResult) => void;
  bridge.save.mockReturnValue(
    new Promise<SaveResult>((resolve) => {
      release = resolve;
    }),
  );
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(store.saveState()).toBe("saving");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const closing = store.closeProjectFlow();
  // While the save is in flight the prompt must not have run yet.
  expect(confirm).not.toHaveBeenCalled();
  expect(store.saveState()).toBe("saving");
  // A mutation lands while the save runs; it stays unsaved after the save
  // settles, so close must still ask before wiping.
  store.updateComponent(store.doc()!.components[0].id, { partNumber: "LM358" });
  release(okSave());
  await closing;
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(bridge.close).not.toHaveBeenCalled(); // declined → project stays open
  expect(store.doc()).toBeTruthy();
});

it("does not retry autosave after a typed validation failure", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  bridge.save.mockRejectedValueOnce(
    new ProjectBridgeError("invalid_data", "The project document is not valid."),
  );
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(store.saveState()).toBe("error");
  expect(store.statusMessage()).toBe("Save failed: The project document is not valid.");
  // No 2s retry loop: still exactly one save after several delay windows.
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 5);
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(store.saveState()).toBe("error");
  // The next mutation re-arms autosave and the save succeeds.
  store.updateComponent(store.doc()!.components[0].id, { partNumber: "LM358" });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(bridge.save).toHaveBeenCalledTimes(2);
  expect(store.saveState()).toBe("saved");
});

it("queues Ctrl+S and save-as behind an in-flight save instead of overlapping", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  let release!: (result: SaveResult) => void;
  bridge.save.mockReturnValue(
    new Promise<SaveResult>((resolve) => {
      release = resolve;
    }),
  );
  bridge.saveAs.mockResolvedValue(okSave("C:\\two.pcbre"));
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(store.saveState()).toBe("saving");

  const manual = store.saveNow();
  const asNew = store.saveProjectAs("C:\\two.pcbre");
  // Both wait: no second save request while the first is in flight.
  expect(bridge.save).toHaveBeenCalledTimes(1);
  expect(bridge.saveAs).not.toHaveBeenCalled();
  // A mutation during the first save is included in the queued save.
  store.updateComponent(store.doc()!.components[0].id, { partNumber: "LM358" });
  release(okSave());
  await manual;
  expect(bridge.save).toHaveBeenCalledTimes(2);
  expect(bridge.save.mock.calls[1][0].components[0].partNumber).toBe("LM358");
  await asNew;
  expect(bridge.saveAs).toHaveBeenCalledTimes(1);
  expect(store.projectPath()).toBe("C:\\two.pcbre");
  expect(store.saveState()).toBe("saved");
});

it("switches the save target with saveProjectAs", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc("Original")));
  await store.openProject("C:\\p.pcbre");
  bridge.saveAs.mockResolvedValue(okSave("C:\\rev-two.pcbre"));
  await store.saveProjectAs("C:\\rev-two.pcbre");
  expect(bridge.saveAs).toHaveBeenCalledTimes(1);
  expect(bridge.saveAs.mock.calls[0][1]).toBe("C:\\rev-two.pcbre");
  expect(store.projectPath()).toBe("C:\\rev-two.pcbre");
  expect(store.doc()?.name).toBe("rev-two");
  expect(store.saveState()).toBe("saved");
});

it("locks block edits but not unlocking", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  const id = store.doc()!.components[0].id;
  store.updateComponent(id, { locked: true });
  expect(store.doc()!.components[0].locked).toBe(true);
  store.updateComponent(id, { partNumber: "nope" });
  expect(store.doc()!.components[0].partNumber).toBeUndefined();
  store.updateComponent(id, { shape: { rect: { x: 99, y: 99, w: 5, h: 5 } } });
  expect(store.doc()!.components[0].shape).toEqual({ rect: { x: 0, y: 0, w: 5, h: 5 } });
  store.deleteComponent(id);
  expect(store.doc()!.components).toHaveLength(1);
  store.updateComponent(id, { locked: false });
  expect(store.doc()!.components[0].locked).toBe(false);
  store.updateComponent(id, { partNumber: "LM358" });
  expect(store.doc()!.components[0].partNumber).toBe("LM358");
});

it("duplicates offset +12/+12, unlock, fresh refdes, hashes by reference", async () => {
  const { store, bridge } = makeStore();
  const doc = seededDoc();
  doc.components.push({
    id: "source",
    boardId: "b1",
    refdes: "U3",
    typeId: "ic",
    shape: { polygon: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] } },
    status: "verified",
    locked: true,
    partNumber: "NE555",
    datasheetHash: "d".repeat(64),
    imageHash: "i".repeat(64),
  });
  bridge.openProject.mockResolvedValue(loaded(doc));
  await store.openProject("C:\\p.pcbre");
  const newId = store.duplicateComponent("source");
  expect(newId).not.toBeNull();
  const copy = store.doc()!.components.find((component) => component.id === newId)!;
  expect(copy.refdes).toBe("U4");
  expect(copy.locked).toBe(false);
  expect(copy.partNumber).toBe("NE555");
  expect(copy.datasheetHash).toBe("d".repeat(64));
  expect(copy.imageHash).toBe("i".repeat(64));
  expect(copy.shape).toEqual({
    polygon: { points: [{ x: 12, y: 12 }, { x: 22, y: 12 }, { x: 12, y: 22 }] },
  });
  expect(store.selectedId()).toBe(newId);
});

it("flags duplicated refdes for inline display", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 8, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  expect([...store.duplicateRefdesSet()]).toEqual(["U1"]);
});

it("deleting an image retains independent scene components", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  store.addBoard({ name: "Front", asset: { hash: "a".repeat(64), size: 5, name: "f.png" }, width: 100, height: 80 });
  store.addBoard({ name: "Back", asset: { hash: "b".repeat(64), size: 5, name: "b.png" }, width: 100, height: 80 });
  const front = store.doc()!.boards[0];
  store.addComponent({ boardId: front.id, typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  store.addComponent({ boardId: store.doc()!.boards[1].id, typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U2" });
  store.deleteBoard(front.id);
  expect(store.doc()!.boards.map((board) => board.name)).toEqual(["Back"]);
  expect(store.doc()!.components.map((component) => component.refdes)).toEqual(["U1", "U2"]);
  expect(store.doc()!.activeBoardId).toBe(store.doc()!.boards[0].id);
});

it("deleteType keeps in-use types and Unassigned; deletes unused types", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  store.addBoard({ name: "Front", asset: { hash: "a".repeat(64), size: 5, name: "f.png" }, width: 100, height: 80 });
  const boardId = store.doc()!.boards[0].id;
  store.addComponent({ boardId, typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  // A type any component still references is undeletable: silent no-op.
  store.deleteType("ic");
  expect(store.doc()!.types.find((type) => type.id === "ic")).toBeTruthy();
  expect(store.doc()!.components[0].typeId).toBe("ic");
  store.deleteType(UNASSIGNED_TYPE_ID);
  expect(store.doc()!.types.find((type) => type.id === UNASSIGNED_TYPE_ID)).toBeTruthy();
  // Unused types delete cleanly; nothing references them.
  store.deleteType("resistor");
  expect(store.doc()!.types.find((type) => type.id === "resistor")).toBeUndefined();
  store.addType({ name: "Relay", color: "#aa33cc", prefix: "K" });
  const relay = store.doc()!.types.find((type) => type.name === "Relay")!;
  store.updateType(relay.id, { color: "#bb44dd" });
  expect(store.typeById(relay.id)?.color).toBe("#bb44dd");
});

it("reorders components for z-order and counts per board", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  store.addBoard({ name: "Front", asset: { hash: "a".repeat(64), size: 5, name: "f.png" }, width: 100, height: 80 });
  const boardId = store.doc()!.boards[0].id;
  store.addComponent({ boardId, typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
  store.addComponent({ boardId, typeId: "ic", shape: { rect: { x: 9, y: 0, w: 5, h: 5 } }, refdes: "U2" });
  const first = store.doc()!.components[0].id;
  expect(store.doc()!.components.map((component) => component.refdes)).toEqual(["U1", "U2"]);
  store.bringToFront(first);
  expect(store.doc()!.components.map((component) => component.refdes)).toEqual(["U2", "U1"]);
  store.sendToBack(first);
  expect(store.doc()!.components.map((component) => component.refdes)).toEqual(["U1", "U2"]);
  expect(store.componentCount(boardId)).toBe(2);
});

it("view and selection changes never schedule saves", async () => {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  store.setView({ scale: 3, offsetX: 10, offsetY: 10 });
  store.setTool("rect");
  store.setSelectedId("nope");
  store.setTypeManagerOpen(true);
  expect(store.saveState()).toBe("idle");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
  expect(bridge.save).not.toHaveBeenCalled();
});

async function storeWithBoard() {
  const { store, bridge } = makeStore();
  bridge.openProject.mockResolvedValue(loaded(seededDoc()));
  await store.openProject("C:\\p.pcbre");
  store.addBoard({
    name: "Front",
    asset: { hash: "a".repeat(64), size: 5, name: "f.png" },
    width: 800,
    height: 600,
  });
  return { store, bridge, boardId: store.doc()!.boards[0].id };
}

describe("board transforms", () => {
  it("rotates by ±90° wrapping through 0/90/180/270", async () => {
    const { store, boardId } = await storeWithBoard();
    store.rotateBoard(boardId, 1);
    expect(store.doc()!.boards[0].rotation).toBe(90);
    store.rotateBoard(boardId, 1);
    expect(store.doc()!.boards[0].rotation).toBe(180);
    store.rotateBoard(boardId, -1);
    expect(store.doc()!.boards[0].rotation).toBe(90);
    store.rotateBoard(boardId, 1);
    store.rotateBoard(boardId, 1);
    store.rotateBoard(boardId, 1);
    expect(store.doc()!.boards[0].rotation).toBe(0);
  });

  it("mirrors H and V independently", async () => {
    const { store, boardId } = await storeWithBoard();
    store.flipBoard(boardId, "h");
    expect(store.doc()!.boards[0].flipH).toBe(true);
    expect(store.doc()!.boards[0].flipV).toBeUndefined();
    store.flipBoard(boardId, "v");
    expect(store.doc()!.boards[0].flipV).toBe(true);
    store.flipBoard(boardId, "h");
    expect(store.doc()!.boards[0].flipH).toBe(false);
  });

  it("clamps board scale to 10–800", async () => {
    const { store, boardId } = await storeWithBoard();
    store.setBoardScale(boardId, 5);
    expect(store.doc()!.boards[0].scale).toBe(10);
    store.setBoardScale(boardId, 9999);
    expect(store.doc()!.boards[0].scale).toBe(800);
    store.setBoardScale(boardId, 137.5);
    expect(store.doc()!.boards[0].scale).toBe(138);
    expect(() => store.setBoardScale(boardId, Number.NaN)).not.toThrow();
    expect(store.doc()!.boards[0].scale).toBe(138);
  });

  it("locked boards reject every edit except unlocking", async () => {
    const { store, boardId } = await storeWithBoard();
    store.updateBoard(boardId, { locked: true });
    store.rotateBoard(boardId, 1);
    store.rotateBoardBy(boardId, 0.1);
    store.flipBoard(boardId, "h");
    store.setBoardScale(boardId, 200);
    store.updateBoard(boardId, { name: "nope", crop: { x: 0, y: 0, w: 10, h: 10 } });
    const board = store.doc()!.boards[0];
    expect(board.rotation).toBeUndefined();
    expect(board.flipH).toBeUndefined();
    expect(board.scale).toBeUndefined();
    expect(board.crop).toBeUndefined();
    expect(board.name).toBe("Front");
    expect(board.locked).toBe(true);
    store.updateBoard(boardId, { locked: false });
    expect(store.doc()!.boards[0].locked).toBe(false);
  });

  it("transform edits are ordinary mutations: dirty plus one autosave each", async () => {
    const { store, bridge, boardId } = await storeWithBoard();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS); // flush the addBoard save
    bridge.save.mockClear();
    store.rotateBoard(boardId, 1);
    expect(store.saveState()).toBe("dirty");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(bridge.save).toHaveBeenCalledTimes(1);
    const saved = bridge.save.mock.calls[0][0] as ProjectDoc;
    expect(saved.boards[0].rotation).toBe(90);
    // width/height stay the ORIGINAL image dims; components are never rewritten.
    expect(saved.boards[0].width).toBe(800);
    expect(saved.boards[0].height).toBe(600);
    expect(saved.components).toHaveLength(0);
  });

  it("accumulates fine rotation in 0.1 steps", async () => {
    const { store, boardId } = await storeWithBoard();
    for (let index = 0; index < 7; index += 1) store.rotateBoardBy(boardId, 0.1);
    expect(store.doc()!.boards[0].rotation).toBe(0.7);
    store.rotateBoardBy(boardId, -0.7);
    expect(store.doc()!.boards[0].rotation).toBe(0);
    // Quarter turns from a fine angle stay exact additions of 90.
    store.rotateBoardBy(boardId, 45.7);
    store.rotateBoard(boardId, 1);
    expect(store.doc()!.boards[0].rotation).toBe(135.7);
  });

  it("wraps fine rotation into [0, 360) with round-half-up to one decimal", async () => {
    const { store, boardId } = await storeWithBoard();
    store.rotateBoardBy(boardId, 359.9);
    expect(store.doc()!.boards[0].rotation).toBe(359.9);
    // 359.9 + 0.1 wraps to exactly 0.
    store.rotateBoardBy(boardId, 0.1);
    expect(store.doc()!.boards[0].rotation).toBe(0);
    // Negative degrees wrap upward.
    store.rotateBoardBy(boardId, -0.1);
    expect(store.doc()!.boards[0].rotation).toBe(359.9);
    // Half-way rounds up: 359.95 → 360.0 → normalized to 0; 0.05 → 0.1.
    store.rotateBoardBy(boardId, 0.05);
    expect(store.doc()!.boards[0].rotation).toBe(0);
    store.rotateBoardBy(boardId, 0.04);
    expect(store.doc()!.boards[0].rotation).toBe(0);
    store.rotateBoardBy(boardId, 0.05);
    expect(store.doc()!.boards[0].rotation).toBe(0.1);
    // Non-finite degrees are a no-op.
    expect(() => store.rotateBoardBy(boardId, Number.NaN)).not.toThrow();
    expect(store.doc()!.boards[0].rotation).toBe(0.1);
  });

  it("persists a fine rotation through the save path", async () => {
    const { store, bridge, boardId } = await storeWithBoard();
    store.rotateBoardBy(boardId, 45.7);
    await store.saveNow();
    const saved = bridge.save.mock.calls[0][0] as ProjectDoc;
    expect(saved.boards[0].rotation).toBe(45.7);
    bridge.openProject.mockResolvedValue(loaded(saved));
    await store.openProject("C:\\fine-rotation.pcbre");
    expect(store.doc()?.boards[0].rotation).toBe(45.7);
  });
});

describe("crop", () => {
  it("applyCrop clamps into the image bounds and commits", async () => {
    const { store } = await storeWithBoard();
    store.setCropDraft({ x: -50, y: 100, w: 5000, h: 20.7 });
    store.applyCrop();
    expect(store.doc()!.boards[0].crop).toEqual({ x: 0, y: 100, w: 800, h: 21 });
    expect(store.cropDraft()).toBeNull();
    // Marked dirty like any mutation.
    expect(store.saveState()).toBe("dirty");
  });

  it("an empty clamped rect keeps the draft for another try", async () => {
    const { store } = await storeWithBoard();
    // y beyond the image clamps h to 0 → rejected, draft stays.
    store.setCropDraft({ x: 0, y: 700, w: 100, h: 50 });
    store.applyCrop();
    expect(store.doc()!.boards[0].crop).toBeUndefined();
    expect(store.cropDraft()).toEqual({ x: 0, y: 700, w: 100, h: 50 });
    // A usable retry commits.
    store.setCropDraft({ x: 10, y: 20, w: 100, h: 50 });
    store.applyCrop();
    expect(store.doc()!.boards[0].crop).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it("cancelCrop discards the draft without touching the board", async () => {
    const { store } = await storeWithBoard();
    store.setCropDraft({ x: 1, y: 2, w: 30, h: 40 });
    store.cancelCrop();
    expect(store.cropDraft()).toBeNull();
    expect(store.doc()!.boards[0].crop).toBeUndefined();
  });

  it("activating another board drops the pending crop draft", async () => {
    const { store } = await storeWithBoard();
    store.addBoard({ name: "Back", asset: { hash: "b".repeat(64), size: 5, name: "b.png" }, width: 640, height: 480 });
    const [front, back] = store.doc()!.boards;
    // addBoard activated Back; switch back to Front so the later activation
    // takes the non-trivial path.
    store.activateBoard(front.id);
    store.setCropDraft({ x: 10, y: 10, w: 200, h: 150 });
    store.activateBoard(back.id);
    expect(store.cropDraft()).toBeNull();
    // applyCrop is a no-op: neither board receives a crop.
    store.applyCrop();
    expect(store.doc()!.boards.find((board) => board.id === front.id)?.crop).toBeUndefined();
    expect(store.doc()!.boards.find((board) => board.id === back.id)?.crop).toBeUndefined();
    expect(store.doc()!.activeBoardId).toBe(back.id);
  });

  it("a locked board ignores applyCrop; the draft survives until cancel", async () => {
    const { store, boardId } = await storeWithBoard();
    store.updateBoard(boardId, { locked: true });
    store.setCropDraft({ x: 0, y: 0, w: 50, h: 50 });
    store.applyCrop();
    expect(store.doc()!.boards[0].crop).toBeUndefined();
    expect(store.cropDraft()).toEqual({ x: 0, y: 0, w: 50, h: 50 });
    store.cancelCrop();
    expect(store.cropDraft()).toBeNull();
  });

  it("cropping never rewrites the original dimensions or components", async () => {
    const { store, boardId } = await storeWithBoard();
    store.addComponent({
      boardId,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    store.setCropDraft({ x: 100, y: 100, w: 50, h: 50 });
    store.applyCrop();
    const board = store.doc()!.boards[0];
    expect(board.width).toBe(800);
    expect(board.height).toBe(600);
    expect(store.doc()!.components[0].shape).toEqual({ rect: { x: 0, y: 0, w: 10, h: 10 } });
  });
});

describe("picture selection", () => {
  it("component selection clears the picture selection; empty clicks do not", async () => {
    const { store, boardId } = await storeWithBoard();
    store.setBoardSelected(true);
    expect(store.boardSelected()).toBe(true);
    store.addComponent({
      boardId,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    const id = store.doc()!.components[0].id;
    store.setSelectedId(id);
    expect(store.boardSelected()).toBe(false);
    // An explicit null (empty-canvas click) does NOT reselect the picture —
    // the canvas decides; the store setter only clears.
    store.setSelectedId(null);
    expect(store.boardSelected()).toBe(false);
    store.setBoardSelected(true);
    expect(store.boardSelected()).toBe(true);
  });

  it("board and component state resets on lifecycle changes", async () => {
    const { store, bridge } = await storeWithBoard();
    store.setBoardSelected(true);
    store.setTool("crop");
    store.setCropDraft({ x: 0, y: 0, w: 10, h: 10 });
    bridge.close.mockResolvedValue(null);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await store.closeProject();
    expect(store.boardSelected()).toBe(false);
    expect(store.tool()).toBe("select");
    expect(store.cropDraft()).toBeNull();
    expect(store.doc()).toBeNull();
  });
});

describe("configureAutosave", () => {
  it("clamps the delay into 500–60000ms", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    store.configureAutosave({ delayMs: 10 });
    store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
    await vi.advanceTimersByTimeAsync(MIN_AUTOSAVE_DELAY_MS - 1);
    expect(bridge.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.save).toHaveBeenCalledTimes(1);

    store.configureAutosave({ delayMs: 999_999 });
    store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 1, y: 0, w: 5, h: 5 } }, refdes: "U2" });
    await vi.advanceTimersByTimeAsync(MAX_AUTOSAVE_DELAY_MS - 1);
    expect(bridge.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.save).toHaveBeenCalledTimes(2);
  });

  it("disabled marks dirty but never schedules a save; Ctrl+S still works", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    store.configureAutosave({ enabled: false });
    store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
    expect(store.saveState()).toBe("dirty");
    expect(store.statusMessage()).toBe("Unsaved changes");
    await vi.advanceTimersByTimeAsync(MAX_AUTOSAVE_DELAY_MS * 2);
    expect(bridge.save).not.toHaveBeenCalled();
    // An explicit save is unaffected by the disabled autosave timer.
    await store.saveNow();
    expect(bridge.save).toHaveBeenCalledTimes(1);
    expect(store.saveState()).toBe("saved");
  });

  it("re-enabling schedules the still-dirty document", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    store.configureAutosave({ enabled: false });
    store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
    store.configureAutosave({ enabled: true, delayMs: MIN_AUTOSAVE_DELAY_MS });
    await vi.advanceTimersByTimeAsync(MIN_AUTOSAVE_DELAY_MS);
    expect(bridge.save).toHaveBeenCalledTimes(1);
    expect(store.saveState()).toBe("saved");
  });

  it("reschedules an already-pending autosave with the new delay", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    store.addComponent({ boardId: "b", typeId: "ic", shape: { rect: { x: 0, y: 0, w: 5, h: 5 } }, refdes: "U1" });
    expect(store.saveState()).toBe("dirty");
    // A save is scheduled on the default 2s delay; reconfigure to 10s while
    // the timer is pending.
    store.configureAutosave({ delayMs: 10_000 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 4); // 8s: old delay must not fire
    expect(bridge.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000 - AUTOSAVE_DELAY_MS * 4); // exactly 10s since reconfiguring
    expect(bridge.save).toHaveBeenCalledTimes(1);
    expect(store.saveState()).toBe("saved");
  });
});

describe("exportHtmlFlow", () => {
  it("picks a path, builds the HTML, exports, and never touches save state", async () => {
    const { store, bridge } = await storeWithBoard();
    store.addComponent({
      boardId: store.doc()!.boards[0].id,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS); // settle autosave
    expect(store.saveState()).toBe("saved");
    dialogs.pickHtmlExportPath.mockResolvedValue("C:\\out\\Front.html");
    await store.exportHtmlFlow();
    expect(dialogs.pickHtmlExportPath).toHaveBeenCalledWith("Unit fixture.html");
    expect(bridge.exportHtml).toHaveBeenCalledTimes(1);
    const [html, path] = bridge.exportHtml.mock.calls[0];
    expect(path).toBe("C:\\out\\Front.html");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(`@@ASSET:${"a".repeat(64)}.png@@`);
    // The doc did not change: no dirty flip, no save.
    expect(store.saveState()).toBe("saved");
    expect(store.statusMessage()).toBe("HTML exported to C:\\out\\Front.html");
    expect(bridge.save).toHaveBeenCalledTimes(1);
  });

  it("aborts quietly when the dialog is dismissed", async () => {
    const { store, bridge } = await storeWithBoard();
    dialogs.pickHtmlExportPath.mockResolvedValue(null);
    await store.exportHtmlFlow();
    expect(bridge.exportHtml).not.toHaveBeenCalled();
    expect(store.panelError()).toBe("");
  });

  it("surfaces export failures as panel errors", async () => {
    const { store, bridge } = await storeWithBoard();
    dialogs.pickHtmlExportPath.mockResolvedValue("C:\\out\\x.html");
    bridge.exportHtml.mockRejectedValue(new Error("disk full"));
    await store.exportHtmlFlow();
    expect(store.panelError()).toBe("disk full");
  });
});

describe("updateProjectMeta", () => {
  it("renames with trimming and marks the document dirty", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    store.updateProjectMeta({ name: "  Renamed board  " });
    expect(store.doc()?.name).toBe("Renamed board");
    expect(store.saveState()).toBe("dirty");
    expect(store.panelError()).toBe("");
  });

  it("rejects an empty name with a status message and no mutation", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc("Keep me")));
    await store.openProject("C:\\p.pcbre");
    const before = store.doc();
    store.updateProjectMeta({ name: "   " });
    expect(store.doc()).toBe(before);
    expect(store.doc()?.name).toBe("Keep me");
    expect(store.statusMessage()).toBe("Project name cannot be empty");
  });

  it("sets and clears the description; guards 4000 characters client-side", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    store.updateProjectMeta({ description: "  Main board  " });
    expect(store.doc()?.description).toBe("Main board");
    store.updateProjectMeta({ description: "" });
    expect(store.doc()?.description).toBe("");
    const before = store.doc();
    store.updateProjectMeta({ description: "x".repeat(4001) });
    expect(store.doc()).toBe(before);
    expect(store.doc()?.description).toBe("");
    expect(store.statusMessage()).toBe("Description must be 4000 characters or fewer");
    // At exactly 4000 the edit goes through.
    store.updateProjectMeta({ description: "y".repeat(4000) });
    expect(store.doc()?.description).toBe("y".repeat(4000));
  });
});

describe("exportCopyFlow", () => {
  it("picks <name>-copy.pcbre, exports, and never touches save state", async () => {
    const { store, bridge } = await storeWithBoard();
    store.addComponent({
      boardId: store.doc()!.boards[0].id,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS); // settle autosave
    expect(store.saveState()).toBe("saved");
    dialogs.pickProjectSave.mockResolvedValue("C:\\proj\\Unit fixture-copy.pcbre");

    await store.exportCopyFlow();
    expect(dialogs.pickProjectSave).toHaveBeenCalledWith("Unit fixture-copy.pcbre");
    expect(bridge.projectExportCopy).toHaveBeenCalledTimes(1);
    const [docArg, pathArg] = bridge.projectExportCopy.mock.calls[0];
    expect(pathArg).toBe("C:\\proj\\Unit fixture-copy.pcbre");
    expect(docArg.name).toBe("Unit fixture");
    // The open project is untouched: no dirty flip, no save, same target.
    expect(store.saveState()).toBe("saved");
    expect(store.statusMessage()).toBe("Project copy exported to C:\\proj\\Unit fixture-copy.pcbre");
    expect(store.projectPath()).toBe("C:\\proj\\fixture.pcbre");
    expect(bridge.save).toHaveBeenCalledTimes(1);
  });

  it("aborts quietly when the dialog is dismissed", async () => {
    const { store, bridge } = await storeWithBoard();
    dialogs.pickProjectSave.mockResolvedValue(null);
    await store.exportCopyFlow();
    expect(bridge.projectExportCopy).not.toHaveBeenCalled();
    expect(store.panelError()).toBe("");
  });

  it("surfaces export failures as panel errors", async () => {
    const { store, bridge } = await storeWithBoard();
    dialogs.pickProjectSave.mockResolvedValue("C:\\proj\\copy.pcbre");
    bridge.projectExportCopy.mockRejectedValue(new Error("disk full"));
    await store.exportCopyFlow();
    expect(store.panelError()).toBe("disk full");
  });
});

describe("deleteProjectFlow", () => {
  it("flushes unsaved work, confirms with the path, then resets and forgets the recent entry", async () => {
    const { store, bridge } = await storeWithBoard();
    const previousPath = store.projectPath()!;
    expect(loadRecent().some((entry) => entry.path === previousPath)).toBe(true);
    store.addComponent({
      boardId: store.doc()!.boards[0].id,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await store.deleteProjectFlow();
    expect(bridge.save).toHaveBeenCalledTimes(1); // flush before deleting
    const message = confirm.mock.calls[0]?.[0] ?? "";
    expect(message).toContain(previousPath);
    expect(message.toLowerCase()).toContain("permanently delete");
    expect(message).toContain("Unsaved changes were saved first");
    expect(bridge.projectDelete).toHaveBeenCalledTimes(1);
    // Full reset, exactly like closeProject.
    expect(store.doc()).toBeNull();
    expect(store.projectPath()).toBeNull();
    expect(store.saveState()).toBe("idle");
    expect(store.statusMessage()).toBe("Ready");
    expect(store.tool()).toBe("select");
    expect(store.cropDraft()).toBeNull();
    expect(loadRecent().some((entry) => entry.path === previousPath)).toBe(false);
  });

  it("confirms without the saved note when nothing was dirty", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await store.deleteProjectFlow();
    expect(bridge.save).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0]?.[0] ?? "").not.toContain("Unsaved changes were saved");
    expect(bridge.projectDelete).toHaveBeenCalledTimes(1);
    expect(store.doc()).toBeNull();
  });

  it("cancel keeps the project open (the flush already happened)", async () => {
    const { store, bridge } = await storeWithBoard();
    store.addComponent({
      boardId: store.doc()!.boards[0].id,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await store.deleteProjectFlow();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bridge.projectDelete).not.toHaveBeenCalled();
    expect(store.doc()).toBeTruthy();
    expect(store.saveState()).toBe("saved"); // the flush survived
  });

  it("keeps the project open when the flush fails", async () => {
    const { store, bridge } = await storeWithBoard();
    bridge.save.mockRejectedValue(new Error("disk unavailable"));
    store.addComponent({
      boardId: store.doc()!.boards[0].id,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await store.deleteProjectFlow();
    expect(confirm).not.toHaveBeenCalled();
    expect(bridge.projectDelete).not.toHaveBeenCalled();
    expect(store.doc()).toBeTruthy();
    expect(store.panelError()).toBe("Unsaved changes could not be saved, so the project was not deleted.");
  });

  it("surfaces Rust failures and keeps the project open", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc()));
    await store.openProject("C:\\p.pcbre");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    bridge.projectDelete.mockRejectedValue(new Error("file locked"));
    await store.deleteProjectFlow();
    expect(store.panelError()).toBe("file locked");
    expect(store.doc()).toBeTruthy();
    expect(store.projectPath()).toBe("C:\\proj\\fixture.pcbre");
  });
});

describe("openRecentFlow", () => {
  it("opens without a prompt when the current project is clean", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValueOnce(loaded(seededDoc("First")));
    await store.openProject("C:\\first.pcbre");
    const confirm = vi.spyOn(window, "confirm");
    bridge.openProject.mockResolvedValueOnce(loaded(seededDoc("Second")));
    await store.openRecentFlow("C:\\second.pcbre");
    expect(confirm).not.toHaveBeenCalled();
    expect(bridge.openProject).toHaveBeenLastCalledWith("C:\\second.pcbre");
    expect(store.doc()?.name).toBe("Second");
  });

  it("confirms when dirty, flush-saves, then opens the target", async () => {
    const { store, bridge } = await storeWithBoard();
    store.addComponent({
      boardId: store.doc()!.boards[0].id,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    bridge.openProject.mockResolvedValue(loaded(seededDoc("Other")));
    await store.openRecentFlow("C:\\other.pcbre");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("C:\\other.pcbre"));
    expect(bridge.save).toHaveBeenCalledTimes(1); // flush, not discard
    expect(bridge.openProject).toHaveBeenLastCalledWith("C:\\other.pcbre");
    expect(store.doc()?.name).toBe("Other");
  });

  it("declining the confirm is a no-op", async () => {
    const { store, bridge } = await storeWithBoard();
    store.addComponent({
      boardId: store.doc()!.boards[0].id,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const before = store.doc();
    await store.openRecentFlow("C:\\other.pcbre");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bridge.save).not.toHaveBeenCalled();
    expect(bridge.openProject).toHaveBeenCalledTimes(1); // only the initial load
    expect(store.doc()).toBe(before);
  });

  it("keeps the current project open when the flush fails", async () => {
    const { store, bridge } = await storeWithBoard();
    bridge.save.mockRejectedValue(new Error("disk unavailable"));
    store.addComponent({
      boardId: store.doc()!.boards[0].id,
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      refdes: "U1",
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await store.openRecentFlow("C:\\other.pcbre");
    expect(bridge.openProject).toHaveBeenCalledTimes(1); // only the initial load
    expect(store.doc()?.name).toBe("Unit fixture");
    expect(store.panelError()).toBe("Unsaved changes could not be saved, so C:\\other.pcbre was not opened.");
  });

  it("surfaces open failures and keeps the current project open", async () => {
    const { store, bridge } = await storeWithBoard();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS); // settle autosave
    expect(store.saveState()).toBe("saved");
    const before = store.doc();
    bridge.openProject.mockRejectedValue(new Error("container corrupt"));
    await store.openRecentFlow("C:\\broken.pcbre");
    expect(store.panelError()).toBe("container corrupt");
    expect(store.doc()).toBe(before);
    expect(store.statusMessage()).toBe("Saved " + clockText("2026-11-15T10:30:00Z"));
  });
});

describe("recent projects recording", () => {
  it("records new/open/save-as targets most-recent-first", async () => {
    const { store, bridge } = makeStore();
    bridge.newProject.mockResolvedValue(loaded(seededDoc("Fresh")));
    await store.newProject("C:\\fresh.pcbre", "fresh");
    expect(loadRecent()[0]).toMatchObject({ path: "C:\\proj\\fixture.pcbre", name: "Fresh" });

    // loaded() pins the path fixture, so the open re-records the same path
    // under the new name (dedupe by path).
    bridge.openProject.mockResolvedValue(loaded(seededDoc("Second")));
    await store.openProject("C:\\second.pcbre");
    expect(loadRecent().map((entry) => entry.name)).toEqual(["Second"]);

    bridge.saveAs.mockResolvedValue(okSave("C:\\rev-two.pcbre"));
    await store.saveProjectAs("C:\\rev-two.pcbre");
    const entries = loadRecent();
    expect(entries[0]).toMatchObject({ path: "C:\\rev-two.pcbre", name: "rev-two" });
    expect(entries.some((entry) => entry.path === "C:\\proj\\fixture.pcbre")).toBe(true);
  });

  it("a failed save-as records nothing", async () => {
    const { store, bridge } = makeStore();
    bridge.openProject.mockResolvedValue(loaded(seededDoc("Original")));
    await store.openProject("C:\\p.pcbre");
    localStorage.clear(); // isolate from the open record
    bridge.saveAs.mockResolvedValue(okSave("C:\\kept.pcbre"));
    await store.saveProjectAs("C:\\kept.pcbre");
    expect(loadRecent().map((entry) => entry.path)).toEqual(["C:\\kept.pcbre"]);
    localStorage.clear();
    bridge.saveAs.mockRejectedValueOnce(new Error("disk full"));
    bridge.saveAs.mockResolvedValue(okSave("C:\\lost.pcbre"));
    await store.saveProjectAs("C:\\lost.pcbre");
    expect(loadRecent()).toEqual([]);
  });
});
