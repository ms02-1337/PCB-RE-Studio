import { createVisualActions } from "../visual/actions";
import { initialVisualEditor } from "../visual/model";
// Placement store: document slice, UI slice, and the autosave scheduler
// (2s debounce, promise-chain queue so saves never overlap, trailing save,
// retry on failure except typed validation errors, which wait for user
// action). View/selection changes never touch the save pipeline; only doc
// mutations do. Lifecycle flows live here so every surface (Projects tab,
// placement header) shares them: new/open/close confirm
// before discarding unsaved work; delete and open-recent flush-save first
// so nothing is lost by surprise. Successful loads record recent projects.

import { createSignal, getOwner, onCleanup } from "solid-js";
import type { AssetInfo, Board, Component, ComponentType, ProjectDoc, Shape } from "./projectDoc";
import { normalizeMappingTabs, UNASSIGNED_TYPE_ID } from "./projectDoc";
import { moveShape } from "./geometry";
import { nextRefdes, duplicateRefdes } from "./refdes";
import { displaySize, effectiveBoardTransform } from "./boardTransform";
import { buildProjectHtml } from "./htmlExport";
import type { View } from "./view";
import type { LoadedProject, SaveResult } from "../../bridge/project";
import { ProjectBridgeError } from "../../bridge/project";
import * as bridge from "../../bridge/project";
import { pickHtmlExportPath, pickImageImport, pickProjectImportSource, pickProjectOpen, pickProjectSave } from "../../bridge/dialog";
import { addRecent, removeRecent } from "../projects/recent";

export const AUTOSAVE_DELAY_MS = 2000;
export const MIN_AUTOSAVE_DELAY_MS = 500;
export const MAX_AUTOSAVE_DELAY_MS = 60000;

export type Tool = "select" | "rect" | "ellipse" | "polygon" | "pan" | "crop";
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export interface PlacementBridge {
  newProject: (path: string, name: string) => Promise<LoadedProject>;
  openProject: (path: string) => Promise<LoadedProject>;
  importProjectCopy: (sourcePath: string, destPath: string) => Promise<LoadedProject>;
  save: (doc: ProjectDoc) => Promise<SaveResult>;
  saveAs: (doc: ProjectDoc, path: string) => Promise<SaveResult>;
  close: () => Promise<null>;
  exportHtml: (html: string, path: string) => Promise<unknown>;
  projectExportCopy: (doc: ProjectDoc, path: string) => Promise<SaveResult>;
  projectDelete: () => Promise<null>;
}

export interface PlacementAssets {
  importAsset: (path: string) => Promise<AssetInfo>;
  readAsset: (hash: string) => Promise<ArrayBuffer>;
}

export interface NewBoard {
  name: string;
  asset: AssetInfo;
  width: number;
  height: number;
}

export interface NewComponent {
  boardId: string;
  typeId: string;
  shape: Shape;
  refdes: string;
}

function defaultBridge(): PlacementBridge {
  return {
    newProject: bridge.projectNew,
    openProject: bridge.projectOpen,
    importProjectCopy: bridge.projectImportCopy,
    save: bridge.projectSave,
    saveAs: bridge.projectSaveAs,
    close: bridge.projectClose,
    exportHtml: bridge.projectExportHtml,
    projectExportCopy: bridge.projectExportCopy,
    projectDelete: bridge.projectDelete,
  };
}

const defaultAssets: PlacementAssets = {
  importAsset: bridge.assetImport,
  readAsset: bridge.assetRead,
};

function fileBaseName(path: string): string {
  const segments = path.split(/[\\/]/);
  const file = segments[segments.length - 1] || "Untitled";
  return file.replace(/\.[^.]+$/, "") || "Untitled";
}

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Typed validation failures can never succeed on a retry timer — they need a
 * document change or an explicit save — so autosave must not loop on them. */
function isValidationError(error: unknown): boolean {
  return error instanceof ProjectBridgeError && error.code === "invalid_data";
}

/** "Saved HH:MM:SS" clock text from a savedAt timestamp (or now). */
export function clockText(savedAt?: string): string {
  const date = savedAt ? new Date(savedAt) : new Date();
  const valid = !Number.isNaN(date.getTime());
  const used = valid ? date : new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(used.getHours())}:${pad(used.getMinutes())}:${pad(used.getSeconds())}`;
}

export function createPlacementStore(
  deps: Partial<PlacementBridge> = {},
  assets: PlacementAssets = defaultAssets,
) {
  const api: PlacementBridge = { ...defaultBridge(), ...deps };
  const [doc, setDoc] = createSignal<ProjectDoc | null>(null);
  const [projectPath, setProjectPath] = createSignal<string | null>(null);
  const [projectSession, setProjectSession] = createSignal(0);
  const [saveState, setSaveState] = createSignal<SaveState>("idle");
  const [statusMessage, setStatusMessage] = createSignal("Ready");
  const [panelError, setPanelError] = createSignal("");
  const [tool, setTool] = createSignal<Tool>("select");
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [boardSelected, setBoardSelected] = createSignal(false);
  const [view, setView] = createSignal<View>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [typeManagerOpen, setTypeManagerOpen] = createSignal(false);
  const [drawTypeId, setDrawTypeId] = createSignal<string>(UNASSIGNED_TYPE_ID);
  const [viewport, setViewport] = createSignal({ width: 0, height: 0 });
  const [canUndo, setCanUndo] = createSignal(false);
  const [canRedo, setCanRedo] = createSignal(false);
  const undoStack: ProjectDoc[] = [];
  const redoStack: ProjectDoc[] = [];
  const HISTORY_LIMIT = 60;
  const refreshHistory = () => { setCanUndo(undoStack.length > 0); setCanRedo(redoStack.length > 0); };
  const clearHistory = () => { undoStack.length = 0; redoStack.length = 0; refreshHistory(); };
  const assetReferences = (value: ProjectDoc) => [...new Set([
    ...value.boards.map((board) => board.assetHash),
    ...(value.visualEditor?.pcbs.flatMap((pcb) => pcb.images.map((image) => image.assetHash)) ?? []),
    ...value.components.flatMap((component) => [component.datasheetHash, component.imageHash, ...(component.imageHashes ?? [])].filter((hash): hash is string => Boolean(hash))),
  ])].sort().join(",");
  /** Pending crop rectangle in ORIGINAL image px; UI state, never doc data
   * until applyCrop() commits it. */
  const [cropDraft, setCropDraft] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);

  let dirty = false;
  let saving = false;
  let pendingSave = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let mutationCount = 0;
  const autosaveSettings = { enabled: true, delayMs: AUTOSAVE_DELAY_MS };
  // Tail of the save queue: every save (autosave, Ctrl+S, save-as) runs after
  // the previous one settles, so two saves never overlap and the saving state
  // stays accurate. Jobs handle their own errors; the chain never rejects.
  let saveChain: Promise<void> = Promise.resolve();

  function serializeSave(job: () => Promise<void>): Promise<void> {
    const run = saveChain.then(job);
    saveChain = run.catch(() => undefined);
    return run;
  }

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  if (getOwner()) onCleanup(clearTimer);

  const scheduleAutosave = () => {
    clearTimer();
    timer = setTimeout(() => {
      void performAutosave();
    }, autosaveSettings.delayMs);
  };

  /** Runtime autosave configuration: clamp the delay, then reschedule (or
   * drop) the pending timer so a dirty document still saves on schedule. */
  function configureAutosave(config: { enabled?: boolean; delayMs?: number }): void {
    if (config.enabled !== undefined) autosaveSettings.enabled = config.enabled;
    if (config.delayMs !== undefined) {
      autosaveSettings.delayMs = clamp(config.delayMs, MIN_AUTOSAVE_DELAY_MS, MAX_AUTOSAVE_DELAY_MS);
    }
    if (!autosaveSettings.enabled) clearTimer();
    else if (dirty) scheduleAutosave();
  }

  const markDirty = () => {
    dirty = true;
    mutationCount += 1;
    if (saving) pendingSave = true;
    setSaveState("dirty");
    setStatusMessage("Unsaved changes");
    if (autosaveSettings.enabled) scheduleAutosave();
  };

  async function performAutosave(): Promise<void> {
    if (!doc() || !dirty || saving) {
      if (saving) pendingSave = true;
      return;
    }
    await runSave(() => api.save(doc()!), false);
  }

  async function runSave(job: () => Promise<SaveResult>, rememberPath: boolean): Promise<void> {
    await serializeSave(async () => {
      saving = true;
      pendingSave = false;
      // The snapshot below includes every mutation made so far; anything that
      // lands during the await stays dirty and schedules the trailing save.
      const snapshotCount = mutationCount;
      let retryable = true;
      setSaveState("saving");
      setStatusMessage("Saving…");
      try {
        const result = await job();
        dirty = mutationCount > snapshotCount;
        if (rememberPath) setProjectPath(result.path);
        setSaveState("saved");
        setStatusMessage(`Saved ${clockText(result.savedAt)}`);
      } catch (error) {
        dirty = true;
        retryable = !isValidationError(error);
        setSaveState("error");
        setStatusMessage(`Save failed: ${errorMessage(error)}`);
      } finally {
        saving = false;
        if (retryable && (dirty || pendingSave) && autosaveSettings.enabled) scheduleAutosave();
      }
    });
  }

  /** Immediate flush (Ctrl+S). A save already in flight is awaited via the
   * queue, so requests run sequentially instead of overlapping. */
  async function saveNow(): Promise<void> {
    if (!doc()) return;
    await runSave(() => api.save(doc()!), false);
  }

  /** Manual save with the UI-side duplicate-refdes guard. */
  async function requestSave(): Promise<void> {
    if (!doc()) return;
    if (duplicateRefdesSet().size > 0) {
      setSaveState("error");
      setStatusMessage("Save blocked: fix duplicate refdes values first");
      return;
    }
    await saveNow();
  }

  /** Runs a dialog-backed flow, surfacing failures through `panelError`. */
  async function guarded(action: () => Promise<void>): Promise<void> {
    setPanelError("");
    try {
      await action();
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "The operation could not be completed.");
    }
  }

  /** Shared gate for flows that would discard the current project (new/open/
   * close). With no unsaved work it passes silently; otherwise it requires an
   * explicit confirmation, stating that the last save failed when it did. A
   * declined confirm leaves the current project fully usable. */
  function confirmDiscardChanges(): boolean {
    const failed = saveState() === "error";
    const savingNow = saveState() === "saving";
    if (!dirty && !failed && !savingNow) return true;
    const detail = failed
      ? " The last save failed, so the newest changes exist only in memory."
      : savingNow
        ? " A save is still running."
        : "";
    return window.confirm(`This project has unsaved changes.${detail} Discard them and continue?`);
  }

  const newProjectFlow = () =>
    guarded(async () => {
      if (!confirmDiscardChanges()) return;
      const path = await pickProjectSave("Untitled.pcbre");
      if (!path) return;
      await newProject(path, fileBaseName(path));
    });

  const openProjectFlow = () =>
    guarded(async () => {
      if (!confirmDiscardChanges()) return;
      const path = await pickProjectOpen();
      if (!path) return;
      await openProject(path);
    });

  /** Imports a project as a separate file. The active project is saved first
   * if needed; both paths are chosen before the native copy changes project
   * state, and cancellation leaves the current project active. */
  const importProjectFlow = () =>
    guarded(async () => {
      await saveChain;
      if (dirty) {
        if (!window.confirm("This project has unsaved changes. Save them before importing another project?")) {
          return;
        }
        await saveNow();
        if (dirty) {
          setPanelError("Unsaved changes could not be saved, so the project was not imported.");
          return;
        }
      }
      const source = await pickProjectImportSource();
      if (!source) return;
      const destination = await pickProjectSave(`${fileBaseName(source)}-copy.pcbre`);
      if (!destination) return;
      const loaded = await api.importProjectCopy(source, destination);
      resetFor(loaded);
      setSaveState("idle");
      setStatusMessage("Ready");
      addRecent(loaded.path, loaded.doc.name);
    });

  const saveAsFlow = () =>
    guarded(async () => {
      const current = doc();
      if (!current) return;
      const path = await pickProjectSave(`${current.name}.pcbre`);
      if (!path) return;
      await saveProjectAs(path);
    });

  const closeProjectFlow = () => guarded(closeProject);

  const addBoardFlow = () =>
    guarded(async () => {
      const session = projectSession();
      const tabId = activeMappingTab()?.id;
      const valid = () => projectSession() === session && activeMappingTab()?.id === tabId && Boolean(doc());
      if (!valid()) return;
      const path = await pickImageImport();
      if (!path || !valid()) return;
      const asset = await assets.importAsset(path);
      if (!valid()) return;
      const buffer = await assets.readAsset(asset.hash);
      if (!valid()) return;
      if (typeof createImageBitmap !== "function") {
        throw new Error("Board images are available in the desktop app.");
      }
      const bitmap = await createImageBitmap(new Blob([buffer]));
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();
      if (!valid()) return;
      if (!width || !height) throw new Error("The image has no usable dimensions.");
      registerAsset(asset);
      addBoard({ name: fileBaseName(path), asset, width, height });
    });

  /** Exports a standalone HTML report. Never touches saveState/dirty — the
   * document did not change, so the transient status message is enough. */
  const exportHtmlFlow = () =>
    guarded(async () => {
      const current = doc();
      if (!current) return;
      const path = await pickHtmlExportPath(`${current.name}.html`);
      if (!path) return;
      const html = buildProjectHtml(current);
      await api.exportHtml(html, path);
      setStatusMessage(`HTML exported to ${path}`);
    });

  /** Saves a standalone copy of the current document under a chosen path.
   * The open project is untouched: saveState, dirty, and projectPath stay
   * as they were (the document did not change). */
  const exportCopyFlow = () =>
    guarded(async () => {
      const current = doc();
      if (!current) return;
      const path = await pickProjectSave(`${current.name}-copy.pcbre`);
      if (!path) return;
      await api.projectExportCopy(current, path);
      setStatusMessage(`Project copy exported to ${path}`);
    });

  /** Permanently deletes the open project file. Unsaved work is flushed
   * first (nothing is lost by surprise); a declined confirm, a failed
   * flush, or a failed delete keeps the project open. */
  const deleteProjectFlow = () =>
    guarded(async () => {
      const target = projectPath();
      if (!doc() || !target) return;
      // Mirror closeProject: let any in-flight save settle before deciding.
      await saveChain;
      const wasDirty = dirty;
      if (wasDirty) {
        await saveNow();
        if (dirty) {
          setPanelError("Unsaved changes could not be saved, so the project was not deleted.");
          return;
        }
      }
      const message =
        `Permanently delete ${target} from disk?` +
        (wasDirty ? " Unsaved changes were saved first." : "") +
        " This cannot be undone.";
      if (!window.confirm(message)) return;
      await api.projectDelete();
      // Forget the file before resetting: the Projects tab remounts its
      // recent list as the document clears, and it must not see a deleted
      // file. Rust already cleared staged assets along with the container.
      removeRecent(target);
      clearProjectState();
    });

  /** Opens a recent project by path. Unsaved work is flushed first —
   * nothing is discarded — and a failed flush or a failed open keeps the
   * current project open (openProject only resets on success). */
  const openRecentFlow = (path: string) =>
    guarded(async () => {
      await saveChain;
      if (dirty) {
        if (!window.confirm(`This project has unsaved changes. Save them and open ${path}?`)) {
          return;
        }
        await saveNow();
        if (dirty) {
          setPanelError(`Unsaved changes could not be saved, so ${path} was not opened.`);
          return;
        }
      }
      await openProject(path);
    });

  /** Component selection clears the board-picture selection; an explicit null
   * (empty-canvas click handled by the canvas) can reselect the board. */
  function selectComponent(id: string | null): void {
    setSelectedId(id);
    if (id !== null) setBoardSelected(false);
  }

  function mutate(change: (draft: ProjectDoc) => void): void {
    const current = doc();
    if (!current) return;
    const next: ProjectDoc = JSON.parse(JSON.stringify(current)) as ProjectDoc;
    change(next);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    // Asset GC runs on save. History never resurrects blobs that may have
    // been collected: crossing an asset-reference boundary clears history.
    if (assetReferences(next) !== assetReferences(current)) clearHistory();
    else { undoStack.push(current); if (undoStack.length > HISTORY_LIMIT) undoStack.shift(); redoStack.length = 0; refreshHistory(); }
    setDoc(next);
    markDirty();
  }

  function restoreHistory(from: ProjectDoc[], to: ProjectDoc[]): void {
    const current = doc(), previous = from.pop();
    if (!current || !previous) return;
    to.push(current);
    setDoc(previous);
    setSelectedId(null); setBoardSelected(false); setCropDraft(null);
    refreshHistory(); markDirty();
  }
  const undo = () => restoreHistory(undoStack, redoStack);
  const redo = () => restoreHistory(redoStack, undoStack);

  /** Project metadata edits. Names are trimmed and cannot be emptied; the
   * description is capped client-side (Rust stays the authority). A
   * rejected edit sets a status message and mutates nothing. */
  const MAX_DESCRIPTION_LENGTH = 4000;
  function updateProjectMeta(patch: { name?: string; description?: string }): void {
    const current = doc();
    if (!current) return;
    const name = patch.name !== undefined ? patch.name.trim() : undefined;
    if (name !== undefined && !name) {
      setStatusMessage("Project name cannot be empty");
      return;
    }
    const description = patch.description !== undefined ? patch.description.trim() : undefined;
    if (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) {
      setStatusMessage(`Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`);
      return;
    }
    mutate((draft) => {
      if (name !== undefined) draft.name = name;
      if (description !== undefined) draft.description = description;
    });
  }

  const findComponent = (id: string | null) =>
    doc()?.components.find((component) => component.id === id);

  async function newProject(path: string, name: string): Promise<void> {
    const loaded = await api.newProject(path, name);
    resetFor(loaded);
    setStatusMessage(`Saved ${clockText()}`);
    setSaveState("saved");
    addRecent(loaded.path, loaded.doc.name);
  }

  async function openProject(path: string): Promise<void> {
    const loaded = await api.openProject(path);
    resetFor(loaded);
    setSaveState("idle");
    setStatusMessage("Ready");
    addRecent(loaded.path, loaded.doc.name);
  }

  function resetFor(loaded: LoadedProject): void {
    clearHistory();
    setProjectSession((session) => session + 1);
    clearTimer();
    dirty = false;
    pendingSave = false;
    setDoc(normalizeMappingTabs({ ...loaded.doc, visualEditor: loaded.doc.visualEditor ?? initialVisualEditor() }));
    setProjectPath(loaded.path);
    setSelectedId(null);
    setBoardSelected(false);
    setTool("select");
    setCropDraft(null);
  }

  /** Saves to a new path, switches the active target, and adopts the file's
   * base name as the project name (drives the window title). Queued behind any
   * in-flight save so saves never overlap. A successful save-as records the
   * new target as the most recent project. */
  async function saveProjectAs(path: string): Promise<void> {
    const current = doc();
    if (!current) return;
    const snapshot: ProjectDoc = { ...current, name: fileBaseName(path) };
    await runSave(() => api.saveAs(snapshot, path), true);
    // Adopt the renamed doc only if nothing mutated while the save ran.
    if (doc() === current) setDoc(snapshot);
    const savedPath = projectPath();
    if (saveState() !== "error" && savedPath) addRecent(savedPath, snapshot.name);
  }

  /** Full reset after the Rust side closed/cleared the project: document,
   * path, selection, tool, pending crop, and the save pipeline go idle. */
  function clearProjectState(): void {
    clearHistory();
    setProjectSession((session) => session + 1);
    clearTimer();
    dirty = false;
    pendingSave = false;
    setDoc(null);
    setProjectPath(null);
    setSelectedId(null);
    setBoardSelected(false);
    setTool("select");
    setCropDraft(null);
    setSaveState("idle");
    setStatusMessage("Ready");
  }

  async function closeProject(): Promise<void> {
    // Let any in-flight (or queued) save settle before deciding; a pending
    // autosave timer is cancelled below and would no-op without a doc anyway.
    await saveChain;
    if (doc() && !confirmDiscardChanges()) return;
    await api.close();
    clearProjectState();
  }

  function registerAsset(asset: AssetInfo): void {
    mutate((draft) => {
      draft.assets[asset.hash] = asset;
    });
  }

  function addBoard(board: NewBoard): void {
    mutate((draft) => {
      draft.assets[board.asset.hash] = board.asset;
      const id = uid("board");
      const tab = draft.mappingTabs?.find((entry) => entry.id === draft.activeMappingTabId);
      const neighbors = draft.boards.filter((entry) => tab?.boardIds.includes(entry.id));
      const sceneX = neighbors.length ? Math.max(...neighbors.map((entry) => (entry.sceneX ?? 0) + displaySize(entry).width)) + 40 : 0;
      draft.boards.push({
        id,
        name: board.name,
        assetHash: board.asset.hash,
        width: board.width,
        height: board.height,
        sceneX,
        sceneY: 0,
      });
      tab?.boardIds.push(id);
      draft.activeBoardId = id;
    });
    setSelectedId(null);
    setBoardSelected(false);
  }

  function renameBoard(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    mutate((draft) => {
      const board = draft.boards.find((entry) => entry.id === id);
      if (board) board.name = trimmed;
    });
  }

  /** Board field edits; a locked board only accepts lock toggles (mirrors
   * component semantics). */
  function updateBoard(id: string, patch: Partial<Board>): void {
    if ((patch.sceneX !== undefined && !Number.isFinite(patch.sceneX)) ||
        (patch.sceneY !== undefined && !Number.isFinite(patch.sceneY))) return;
    const current = doc()?.boards.find((entry) => entry.id === id);
    if (!current) return;
    if (current.locked) {
      const keys = Object.keys(patch);
      if (!(keys.length === 1 && keys[0] === "locked")) return;
    }
    mutate((draft) => {
      const board = draft.boards.find((entry) => entry.id === id);
      if (board) Object.assign(board, patch);
    });
  }

  /** Commits the pending crop rect to the active board: clamps to the image
   * bounds and rejects empty rectangles (the draft stays for another try).
   * A locked picture rejects the crop outright — the draft survives until
   * unlocked or cancelled. */
  function applyCrop(): void {
    const active = activeBoard();
    const draft = cropDraft();
    if (!active || !draft) return;
    if (active.locked) return;
    const x = clamp(Math.round(draft.x), 0, active.width);
    const y = clamp(Math.round(draft.y), 0, active.height);
    const w = clamp(Math.round(draft.w), 0, active.width - x);
    const h = clamp(Math.round(draft.h), 0, active.height - y);
    if (w <= 0 || h <= 0) return;
    updateBoard(active.id, { crop: { x, y, w, h } });
    setCropDraft(null);
  }

  function cancelCrop(): void {
    setCropDraft(null);
  }

  /** Quarter-turn rotation (`quarters × 90°`, e.g. ±1) wrapping into
   * [0, 360); exact-integer results when starting from whole degrees.
   * Transform field only; locked boards are rejected by updateBoard. */
  function rotateBoard(id: string, quarters: number): void {
    const current = doc()?.boards.find((entry) => entry.id === id);
    if (!current) return;
    const rotation = effectiveBoardTransform(current).rotation;
    const next = (((rotation + quarters * 90) % 360) + 360) % 360;
    updateBoard(id, { rotation: next });
  }

  /** Fine-grained rotation by arbitrary degrees (UI: ±0.1° steps).
   * Rule: `round10(wrap(current + degrees))` where wrap lands in [0, 360)
   * and round10 rounds half-up to one decimal; a result rounded to 360
   * becomes 0. Non-finite degrees and locked boards are no-ops (the lock
   * via updateBoard, same as rotateBoard). */
  function rotateBoardBy(id: string, degrees: number): void {
    if (!Number.isFinite(degrees)) return;
    const current = doc()?.boards.find((entry) => entry.id === id);
    if (!current) return;
    const rotation = effectiveBoardTransform(current).rotation;
    const wrapped = (((rotation + degrees) % 360) + 360) % 360;
    const next = (Math.round(wrapped * 10) / 10) % 360;
    updateBoard(id, { rotation: next });
  }

  function flipBoard(id: string, axis: "h" | "v"): void {
    const current = doc()?.boards.find((entry) => entry.id === id);
    if (!current) return;
    if (axis === "h") updateBoard(id, { flipH: !current.flipH });
    else updateBoard(id, { flipV: !current.flipV });
  }

  function setBoardScale(id: string, percent: number): void {
    if (!Number.isFinite(percent)) return;
    updateBoard(id, { scale: clamp(Math.round(percent), 10, 800) });
  }

  function deleteBoard(id: string): void {
    mutate((draft) => {
      draft.boards = draft.boards.filter((board) => board.id !== id);
      draft.components = draft.components.filter((component) => component.coordinateSpace === "scene" || component.boardId !== id);
      for (const tab of draft.mappingTabs ?? []) tab.boardIds = tab.boardIds.filter((boardId) => boardId !== id);
      if (draft.activeBoardId === id) {
        draft.activeBoardId = draft.mappingTabs?.find((tab) => tab.id === draft.activeMappingTabId)?.boardIds[0];
      }
    });
    setSelectedId(null);
    setBoardSelected(false);
    setCropDraft(null);
  }

  function activateBoard(id: string): void {
    if (!sceneBoards().some((board) => board.id === id)) return;
    if (doc()?.activeBoardId === id) return;
    mutate((draft) => {
      draft.activeBoardId = id;
    });
    setSelectedId(null);
    setBoardSelected(false);
    // The pending crop targeted the previously active board; without this it
    // would silently apply to the newly activated one.
    setCropDraft(null);
  }

  const mappingTabs = () => doc()?.mappingTabs ?? [];
  const activeMappingTab = () => mappingTabs().find((tab) => tab.id === doc()?.activeMappingTabId);
  const sceneBoards = () => {
    const ids = activeMappingTab()?.boardIds ?? [];
    const boards = doc()?.boards ?? [];
    return ids.flatMap((id) => {
      const board = boards.find((entry) => entry.id === id);
      return board ? [board] : [];
    });
  };
  const sceneComponents = () => doc()?.components.filter((component) => component.mappingTabId === activeMappingTab()?.id) ?? [];
  function clearSceneSelection(): void {
    setSelectedId(null);
    setBoardSelected(false);
    setCropDraft(null);
    setTool("select");
  }
  function addMappingTab(): void {
    mutate((draft) => {
      const id = uid("mapping");
      (draft.mappingTabs ??= []).push({ id, name: `Board ${draft.mappingTabs.length + 1}`, boardIds: [] });
      draft.activeMappingTabId = id;
      delete draft.activeBoardId;
    });
    clearSceneSelection();
  }
  function activateMappingTab(id: string): void {
    if (!mappingTabs().some((tab) => tab.id === id) || activeMappingTab()?.id === id) return;
    mutate((draft) => {
      draft.activeMappingTabId = id;
      draft.activeBoardId = draft.mappingTabs?.find((tab) => tab.id === id)?.boardIds[0];
    });
    clearSceneSelection();
  }
  function renameMappingTab(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed || !mappingTabs().some((tab) => tab.id === id)) return;
    mutate((draft) => { draft.mappingTabs!.find((tab) => tab.id === id)!.name = trimmed; });
  }
  function deleteMappingTab(id: string): void {
    const tab = mappingTabs().find((entry) => entry.id === id);
    if (!tab) return;
    mutate((draft) => {
      const removed = new Set(tab.boardIds);
      draft.boards = draft.boards.filter((board) => !removed.has(board.id));
      draft.components = draft.components.filter((component) => component.mappingTabId !== id && (component.coordinateSpace === "scene" || !removed.has(component.boardId)));
      draft.mappingTabs = draft.mappingTabs!.filter((entry) => entry.id !== id);
      if (!draft.mappingTabs.length) draft.mappingTabs.push({ id: uid("mapping"), name: "Board 1", boardIds: [] });
      if (draft.activeMappingTabId === id) {
        draft.activeMappingTabId = draft.mappingTabs[0].id;
        draft.activeBoardId = draft.mappingTabs[0].boardIds[0];
      }
    });
    clearSceneSelection();
  }

  function addComponent(input: NewComponent): string {
    const id = uid("c");
    mutate((draft) => {
      draft.components.push({
        id,
        boardId: input.boardId,
        refdes: input.refdes,
        typeId: input.typeId,
        shape: input.shape,
        coordinateSpace: "scene",
        mappingTabId: draft.activeMappingTabId,
        status: "identified",
        locked: false,
      });
    });
    return id;
  }

  /** Field and shape edits; locked components only accept lock changes. */
  function updateComponent(id: string, patch: Partial<Component>): void {
    const current = findComponent(id);
    if (!current) return;
    if (patch.description !== undefined && patch.description.length > 4000) { setStatusMessage("Description must be 4000 characters or fewer"); return; }
    // imageNames is passed as the complete record (empty string clears a
    // name); Rust stays the authority for key format.
    if (patch.imageNames !== undefined) {
      const labels = Object.values(patch.imageNames);
      if (labels.length > 64 || labels.some((label) => label.length > 200)) {
        setStatusMessage("Image names must be 64 entries or fewer with labels of 200 characters or fewer");
        return;
      }
    }
    if (current.locked && !("locked" in patch)) return;
    mutate((draft) => {
      const component = draft.components.find((entry) => entry.id === id);
      if (!component) return;
      Object.assign(component, patch);
    });
  }

  /** Copy shape + all fields, offset +12/+12 board px, fresh refdes, unlocked. */
  function duplicateComponent(id: string): string | null {
    const source = findComponent(id);
    const current = doc();
    if (!source || !current) return null;
    const type = current.types.find((entry) => entry.id === source.typeId);
    const refdes = nextRefdes(type?.prefix ?? "X", current.components);
    const newId = uid("c");
    mutate((draft) => {
      const original = draft.components.find((entry) => entry.id === id);
      if (!original) return;
      const copy: Component = JSON.parse(JSON.stringify(original)) as Component;
      copy.id = newId;
      copy.refdes = refdes;
      copy.locked = false;
      copy.shape = moveShape(original.shape, 12, 12);
      draft.components.push(copy);
    });
    setSelectedId(newId);
    return newId;
  }

  function deleteComponent(id: string): void {
    const current = findComponent(id);
    if (!current || current.locked) return;
    mutate((draft) => {
      draft.components = draft.components.filter((component) => component.id !== id);
    });
    if (selectedId() === id) setSelectedId(null);
  }

  function bringToFront(id: string): void {
    mutate((draft) => {
      const index = draft.components.findIndex((component) => component.id === id);
      if (index >= 0) {
        const [moved] = draft.components.splice(index, 1);
        draft.components.push(moved);
      }
    });
  }

  function sendToBack(id: string): void {
    mutate((draft) => {
      const index = draft.components.findIndex((component) => component.id === id);
      if (index >= 0) {
        const [moved] = draft.components.splice(index, 1);
        draft.components.unshift(moved);
      }
    });
  }

  function addType(type: Omit<ComponentType, "id">): string {
    const id = uid("type");
    mutate((draft) => {
      draft.types.push({ ...type, id });
    });
    return id;
  }

  function updateType(id: string, patch: Partial<Omit<ComponentType, "id">>): void {
    mutate((draft) => {
      const type = draft.types.find((entry) => entry.id === id);
      if (type) Object.assign(type, patch);
    });
  }

  /** Deleting a type in use reassigns its components to Unassigned, which is
   * itself undeletable. */
  function deleteType(id: string): void {
    if (id === UNASSIGNED_TYPE_ID) return;
    mutate((draft) => {
      draft.types = draft.types.filter((type) => type.id !== id);
      for (const component of draft.components) {
        if (component.typeId === id) component.typeId = UNASSIGNED_TYPE_ID;
      }
    });
  }

  const selectedComponent = () => findComponent(selectedId());
  const activeBoard = () => {
    const current = doc();
    if (!current?.activeBoardId) return undefined;
    return current.boards.find((board) => board.id === current.activeBoardId);
  };
  const duplicateRefdesSet = () => {
    const current = doc();
    return current ? duplicateRefdes(current.components) : new Set<string>();
  };
  const typeById = (id: string) => doc()?.types.find((type) => type.id === id);
  const componentCount = (boardId: string) =>
    doc()?.components.filter((component) => component.boardId === boardId).length ?? 0;

  const visual = createVisualActions(doc, mutate);
  const addVisualImageFlow = () => guarded(async () => {
    const session = projectSession();
    const pcbId = visual.activePcb()?.id;
    const valid = () => projectSession() === session && visual.activePcb()?.id === pcbId && Boolean(doc());
    if (!pcbId || !valid()) return;
    const path = await pickImageImport();
    if (!path || !valid()) return;
    const asset = await assets.importAsset(path);
    if (!valid()) return;
    const bytes = await assets.readAsset(asset.hash);
    if (!valid()) return;
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const { width, height } = bitmap; bitmap.close();
    if (!valid()) return;
    if (!width || !height) throw new Error("The image has no usable dimensions.");
    visual.addImage(pcbId, asset, fileBaseName(path), width, height);
  });
  return {
    visual, addVisualImageFlow,
    undo, redo, canUndo, canRedo, sceneComponents,
    doc,
    projectPath,
    projectSession,
    saveState,
    statusMessage,
    panelError,
    tool,
    selectedId,
    boardSelected,
    view,
    typeManagerOpen,
    drawTypeId,
    viewport,
    cropDraft,
    newProject,
    openProject,
    saveNow,
    requestSave,
    saveProjectAs,
    closeProject,
    newProjectFlow,
    openProjectFlow,
    importProjectFlow,
    saveAsFlow,
    closeProjectFlow,
    addBoardFlow,
    exportHtmlFlow,
    exportCopyFlow,
    deleteProjectFlow,
    openRecentFlow,
    updateProjectMeta,
    addBoard,
    registerAsset,
    renameBoard,
    deleteBoard,
    activateBoard,
    updateBoard,
    applyCrop,
    cancelCrop,
    rotateBoard,
    rotateBoardBy,
    flipBoard,
    setBoardScale,
    addComponent,
    updateComponent,
    duplicateComponent,
    deleteComponent,
    bringToFront,
    sendToBack,
    addType,
    updateType,
    deleteType,
    configureAutosave,
    setTool,
    setSelectedId: selectComponent,
    setBoardSelected,
    setView,
    setTypeManagerOpen,
    setDrawTypeId,
    setViewport,
    setCropDraft,
    selectedComponent,
    activeBoard,
    mappingTabs,
    activeMappingTab,
    sceneBoards,
    addMappingTab,
    activateMappingTab,
    renameMappingTab,
    deleteMappingTab,
    duplicateRefdesSet,
    typeById,
    componentCount,
    dispose: clearTimer,
  };
}

export type PlacementStore = ReturnType<typeof createPlacementStore>;
