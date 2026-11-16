import { it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import type { ProjectDoc } from "./projectDoc";
import { SEED_TYPES } from "./projectDoc";
import { createPlacementStore, type PlacementStore } from "./store";
import { Toolbar } from "./Toolbar";
import { BoardBar } from "./BoardBar";

function storeWithBoard(): PlacementStore {
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Fixtures",
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    types: SEED_TYPES.map((type) => ({ ...type })),
    boards: [{ id: "b1", name: "Front", assetHash: "a".repeat(64), width: 640, height: 480 }],
    components: [
      {
        id: "c1",
        boardId: "b1",
        refdes: "R1",
        typeId: "resistor",
        shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
        status: "identified",
        locked: false,
      },
    ],
    assets: {},
    activeBoardId: "b1",
  };
  const store = createPlacementStore({
    openProject: vi.fn(async () => ({ doc, assets: {}, path: "C:\\p.pcbre" })),
    save: vi.fn(async () => ({ path: "C:\\p.pcbre", bytes: 1, blobCount: 0, savedAt: "2026-11-15T10:00:00Z" })),
    saveAs: vi.fn(),
    newProject: vi.fn(),
    close: vi.fn(async () => null),
  });
  void store.openProject("C:\\p.pcbre");
  return store;
}

function emptyStore(): PlacementStore {
  return createPlacementStore({
    openProject: vi.fn(async () => ({
      doc: {
        schemaVersion: 1,
        name: "Empty",
        createdAt: "t",
        updatedAt: "t",
        types: SEED_TYPES.map((type) => ({ ...type })),
        boards: [],
        components: [],
        assets: {},
      } as ProjectDoc,
      assets: {},
      path: "C:\\p.pcbre",
    })),
    save: vi.fn(async () => ({ path: "C:\\p.pcbre", bytes: 1, blobCount: 0, savedAt: "2026-11-15T10:00:00Z" })),
    saveAs: vi.fn(),
    newProject: vi.fn(),
    close: vi.fn(async () => null),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

const TOOL_TITLES = [
  "Select (V)",
  "Rect (R)",
  "Ellipse (E)",
  "Polygon (P)",
  "Pan (H)",
  "Crop (C)",
];

it("toolbar toggles tools and disables drawing without a board", async () => {
  const store = emptyStore();
  await store.openProject("C:\\p.pcbre");
  const empty = render(() => <Toolbar store={store} />);
  // Every tool except Select needs a board; zoom controls need a viewport.
  for (const title of TOOL_TITLES) {
    expect((screen.getByTitle(title) as HTMLButtonElement).disabled).toBe(title === "Crop (C)");
  }
  const select = screen.getByTitle("Select (V)") as HTMLButtonElement;
  expect(select.disabled).toBe(false);
  expect(select.getAttribute("aria-pressed")).toBe("true");
  expect(select.getAttribute("aria-label")).toBe("Select");
  expect((screen.getByTitle("Fit to view (0)") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTitle("Zoom 100% (1)") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTitle("Zoom in (+)") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTitle("Zoom out (−)") as HTMLButtonElement).disabled).toBe(true);

  const withBoard = storeWithBoard();
  await withBoard.openProject("C:\\p.pcbre");
  empty.unmount();
  const { unmount } = render(() => <Toolbar store={withBoard} />);
  const rect = screen.getByTitle("Rect (R)") as HTMLButtonElement;
  expect(rect.disabled).toBe(false);
  fireEvent.click(rect);
  expect(withBoard.tool()).toBe("rect");
  expect(screen.getByTitle("Rect (R)").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTitle("Select (V)").getAttribute("aria-pressed")).toBe("false");
  // The crop tool joins the column and toggles like the draw tools.
  fireEvent.click(screen.getByTitle("Crop (C)"));
  expect(withBoard.tool()).toBe("crop");
  expect(screen.getByTitle("Crop (C)").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("toolbar", { name: "Placement tools" }).getAttribute("aria-orientation")).toBe("vertical");
  unmount();
});

it("toolbar separates groups with lines only, no group texts", async () => {
  const store = storeWithBoard();
  await store.openProject("C:\\p.pcbre");
  const { container } = render(() => <Toolbar store={store} />);
  // The former group labels are gone entirely.
  for (const label of ["Parts", "Image", "View", "Components", "Images", "Navigation"]) {
    expect(screen.queryByText(label)).toBeNull();
  }
  // Three thin separators remain: shapes | crop-area | select/pan | zoom.
  expect(container.querySelectorAll(".pl-toolbar-sep")).toHaveLength(3);
  for (const separator of container.querySelectorAll(".pl-toolbar-sep")) {
    expect(separator.getAttribute("aria-hidden")).toBe("true");
  }
});

it("toolbar transform buttons rotate and mirror the selected unlocked picture", async () => {
  const store = storeWithBoard();
  await store.openProject("C:\\p.pcbre");
  const { container } = render(() => <Toolbar store={store} />);
  const rotateCcw = screen.getByRole("button", { name: "Rotate 90° CCW" }) as HTMLButtonElement;
  const rotateCw = screen.getByRole("button", { name: "Rotate 90° CW" }) as HTMLButtonElement;
  const mirrorV = screen.getByRole("button", { name: "Mirror vertical" }) as HTMLButtonElement;
  const mirrorH = screen.getByRole("button", { name: "Mirror horizontal" }) as HTMLButtonElement;
  // Titles carry the same exact names; the buttons sit right after Crop.
  expect(rotateCcw.title).toBe("Rotate 90° CCW");
  expect(container.querySelector('.pl-tool-btn[title="Crop (C)"]')!.nextElementSibling).toBe(rotateCcw);
  // A doc alone is not enough: no picture is selected yet.
  for (const button of [rotateCcw, rotateCw, mirrorV, mirrorH]) expect(button.disabled).toBe(true);
  store.setBoardSelected(true);
  for (const button of [rotateCcw, rotateCw, mirrorV, mirrorH]) expect(button.disabled).toBe(false);
  const rotate = vi.spyOn(store, "rotateBoard");
  const flip = vi.spyOn(store, "flipBoard");
  fireEvent.click(rotateCcw);
  expect(rotate).toHaveBeenCalledExactlyOnceWith("b1", -1);
  fireEvent.click(rotateCw);
  expect(rotate).toHaveBeenLastCalledWith("b1", 1);
  fireEvent.click(mirrorV);
  expect(flip).toHaveBeenCalledExactlyOnceWith("b1", "v");
  fireEvent.click(mirrorH);
  expect(flip).toHaveBeenLastCalledWith("b1", "h");
  // A locked picture disables the transforms again.
  store.updateBoard("b1", { locked: true });
  for (const button of [rotateCcw, rotateCw, mirrorV, mirrorH]) expect(button.disabled).toBe(true);
});

it("toolbar zoom buttons drive the view once a viewport exists", async () => {
  const store = storeWithBoard();
  await store.openProject("C:\\p.pcbre");
  store.setViewport({ width: 800, height: 600 });
  render(() => <Toolbar store={store} />);
  fireEvent.click(screen.getByTitle("Fit to view (0)"));
  expect(store.view().scale).toBeCloseTo(1.25); // min(800/640, 600/480), under the cap of 2
  fireEvent.click(screen.getByTitle("Zoom in (+)"));
  expect(store.view().scale).toBeGreaterThan(0.8);
  fireEvent.click(screen.getByTitle("Zoom 100% (1)"));
  expect(store.view().scale).toBeCloseTo(1);
});

it("boardbar lists boards, switches, renames, and deletes with confirm", async () => {
  const store = storeWithBoard();
  await store.openProject("C:\\p.pcbre");
  store.addBoard({
    name: "Back",
    asset: { hash: "b".repeat(64), size: 10, name: "back.png" },
    width: 320,
    height: 240,
  });
  const backId = store.doc()!.boards[1].id;
  // A transformed board (rotate + scale) still lists and switches normally.
  store.updateBoard(backId, { rotation: 90, scale: 200 });
  const addBoard = vi.fn();
  render(() => <BoardBar store={store} onAddBoard={addBoard} />);
  expect(store.sceneBoards()).toHaveLength(2);
  // Tabs are name-only chips: the image-count subtitle is gone for narrowness.
  expect(screen.queryByText(/images/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add mapping tab" }));
  const secondTab = store.activeMappingTab()!.id;
  const front = screen.getByTitle(/Front — double-click/);
  const back = screen.getByTitle(/Board 2 — double-click/);
  // Active board is conveyed by aria-current only (aria-pressed dropped).
  expect(front.getAttribute("aria-current")).toBeNull();
  expect(back.getAttribute("aria-current")).toBe("true");
  fireEvent.click(back);
  await waitFor(() => expect(store.activeMappingTab()?.id).toBe(secondTab));

  // Rename via F2 then commit with Enter.
  fireEvent.keyDown(front, { key: "F2" });
  const rename = screen.getByLabelText("Rename mapping tab Front");
  fireEvent.input(rename, { target: { value: "Top" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  expect(store.mappingTabs()[0].name).toBe("Top");

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  expect(screen.queryByLabelText("Delete mapping tab Top")).toBeNull();
  fireEvent.contextMenu(screen.getByTitle(/Top — double-click/));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete tab" }));
  expect(confirm).toHaveBeenCalledWith("Delete mapping tab 'Top' and its images and components?");
  await waitFor(() => expect(store.doc()?.boards).toHaveLength(0));
  expect(store.doc()?.components).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Add mapping tab" }));
  expect(store.mappingTabs()).toHaveLength(2);
  expect(addBoard).not.toHaveBeenCalled();
});
