import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { AUTOSAVE_DELAY_MS, createPlacementStore } from "./placement/store";
import { SEED_TYPES, type ProjectDoc } from "./placement/projectDoc";
import type { SaveResult } from "../bridge/project";
import { SaveBadge } from "./SaveBadge";

function seededDoc(name = "Badge"): ProjectDoc {
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

const okSave = (): SaveResult => ({
  path: "C:\\p.pcbre",
  bytes: 1,
  blobCount: 0,
  savedAt: "2026-11-15T10:00:00Z",
});

const addComponent = (store: ReturnType<typeof createPlacementStore>) =>
  store.addComponent({
    boardId: "b1",
    typeId: "ic",
    shape: { rect: { x: 0, y: 0, w: 5, h: 5 } },
    refdes: "U1",
  });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("stays hidden until a project opens", () => {
  const store = createPlacementStore({ openProject: vi.fn() });
  const view = render(() => <SaveBadge store={store} />);
  expect(view.container.querySelector(".tab-save-badge")).toBeNull();
});

it("mirrors save states with a colored dot and the status message", async () => {
  let release!: (result: SaveResult) => void;
  const bridge = {
    openProject: vi.fn(async () => ({
      doc: seededDoc(),
      assets: {},
      path: "C:\\p.pcbre",
    })),
    save: vi.fn().mockImplementation(
      () =>
        new Promise<SaveResult>((resolve) => {
          release = resolve;
        }),
    ),
  };
  const store = createPlacementStore(bridge);
  const view = render(() => <SaveBadge store={store} />);
  await store.openProject("C:\\p.pcbre");

  const badge = view.container.querySelector(".tab-save-badge")!;
  const dot = view.container.querySelector(".tab-save-dot")!;
  expect(badge).toBeTruthy();
  expect(badge.getAttribute("aria-live")).toBe("polite");
  expect(badge.getAttribute("title")).toBe("C:\\p.pcbre");
  expect(badge.textContent).toContain("Ready");
  expect(dot.getAttribute("data-state")).toBe("idle");

  addComponent(store);
  expect(badge.textContent).toContain("Unsaved changes");
  expect(dot.getAttribute("data-state")).toBe("dirty");

  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  expect(badge.textContent).toContain("Saving…");
  expect(dot.getAttribute("data-state")).toBe("saving");

  release(okSave());
  await vi.advanceTimersByTimeAsync(0);
  expect(badge.textContent).toMatch(/^Saved/);
  expect(dot.getAttribute("data-state")).toBe("saved");
});

it("shows the error state when a save fails", async () => {
  const bridge = {
    openProject: vi.fn(async () => ({
      doc: seededDoc(),
      assets: {},
      path: "C:\\p.pcbre",
    })),
    save: vi.fn().mockRejectedValue(new Error("disk full")),
  };
  const store = createPlacementStore(bridge);
  const view = render(() => <SaveBadge store={store} />);
  await store.openProject("C:\\p.pcbre");
  addComponent(store);
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
  const badge = view.container.querySelector(".tab-save-badge")!;
  expect(badge.textContent).toContain("Save failed: disk full");
  expect(view.container.querySelector(".tab-save-dot")!.getAttribute("data-state")).toBe("error");
});

it("disappears again once the project closes", async () => {
  const bridge = {
    openProject: vi.fn(async () => ({ doc: seededDoc(), assets: {}, path: "C:\\p.pcbre" })),
    close: vi.fn(async () => null),
  };
  const store = createPlacementStore(bridge);
  const view = render(() => <SaveBadge store={store} />);
  await store.openProject("C:\\p.pcbre");
  expect(view.container.querySelector(".tab-save-badge")).toBeTruthy();
  await store.closeProject();
  expect(view.container.querySelector(".tab-save-badge")).toBeNull();
});
