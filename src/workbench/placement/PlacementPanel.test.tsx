import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import type { ProjectDoc } from "./projectDoc";
import { SEED_TYPES } from "./projectDoc";
import { createPlacementStore } from "./store";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  save: vi.fn(),
  exportHtml: vi.fn(),
  pickSave: vi.fn(),
  pickOpen: vi.fn(),
  pickImage: vi.fn(),
  pickHtml: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("../../bridge/dialog", () => ({
  pickProjectOpen: mocks.pickOpen,
  pickProjectSave: mocks.pickSave,
  pickImageImport: mocks.pickImage,
  pickHtmlExportPath: mocks.pickHtml,
}));

import { PlacementPanel } from "./PlacementPanel";

function doc(name = "Demo board"): ProjectDoc {
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

function makeStore(withDoc?: ProjectDoc) {
  const bridge = {
    newProject: vi.fn(async (path: string, name: string) => ({
      doc: doc(name),
      assets: {},
      path,
    })),
    openProject: vi.fn(async (path: string) => ({ doc: withDoc ?? doc(), assets: {}, path })),
    save: mocks.save,
    saveAs: vi.fn(),
    close: vi.fn(async () => null),
    exportHtml: mocks.exportHtml,
  };
  const store = createPlacementStore(bridge);
  if (withDoc) void store.openProject("C:\\proj\\demo.pcbre");
  return store;
}

beforeEach(() => {
  mocks.isTauri.mockReturnValue(true);
  mocks.save.mockResolvedValue({ path: "C:\\proj\\demo.pcbre", bytes: 10, blobCount: 0, savedAt: "2026-11-15T10:00:00Z" });
  mocks.exportHtml.mockResolvedValue(2048);
});

afterEach(() => {
  vi.clearAllMocks();
});

it("collapses details and resizes them from the left separator with the keyboard", () => {
  render(() => <PlacementPanel store={makeStore()} onOpenProjectsTab={vi.fn()} />);
  const separator = screen.getByRole("separator", { name: "Resize selection details" });
  expect(separator.getAttribute("aria-valuenow")).toBe("300");
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator.getAttribute("aria-valuenow")).toBe("320");
  fireEvent.click(screen.getByRole("button", { name: "Hide selection details" }));
  expect(screen.queryByRole("separator")).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Component properties" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show selection details" }));
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("320");
});

it("shows an honest empty state in browser preview and links to the Projects tab", () => {
  mocks.isTauri.mockReturnValue(false);
  const store = makeStore();
  const openProjectsTab = vi.fn();
  render(() => <PlacementPanel store={store} onOpenProjectsTab={openProjectsTab} />);
  expect(screen.getAllByText("No project open.").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Projects are available in the desktop app.").length).toBeGreaterThan(0);
  const openTab = screen.getByRole("button", { name: "Open the Projects tab" }) as HTMLButtonElement;
  expect(openTab.disabled).toBe(false);
  fireEvent.click(openTab);
  expect(openProjectsTab).toHaveBeenCalledTimes(1);
}, 15000);

it("renders the canvas safely and shows project actions with a board", async () => {
  const seeded = doc();
  seeded.boards.push({
    id: "b1",
    name: "Front",
    assetHash: "a".repeat(64),
    width: 800,
    height: 600,
  });
  seeded.activeBoardId = "b1";
  const store = makeStore(seeded);
  await waitFor(() => expect(store.doc()).toBeTruthy());
  render(() => <PlacementPanel store={store} onOpenProjectsTab={vi.fn()} />);
  expect(screen.getByRole("application", { name: /board canvas/i })).toBeTruthy();
  expect(screen.getByRole("toolbar", { name: "Project actions" })).toBeTruthy();
  expect(screen.getByRole("toolbar", { name: "Placement tools" })).toBeTruthy();
  expect(screen.getByRole("toolbar", { name: "Boards" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add mapping tab" })).toBeTruthy();
  expect(screen.getByText(/Front — 800 × 600 px/)).toBeTruthy();
});

it("shows the slimmed header actions and the new-component type picker", async () => {
  const seeded = doc();
  seeded.boards.push({
    id: "b1",
    name: "Front",
    assetHash: "a".repeat(64),
    width: 800,
    height: 600,
  });
  seeded.activeBoardId = "b1";
  const store = makeStore(seeded);
  await waitFor(() => expect(store.doc()).toBeTruthy());
  render(() => <PlacementPanel store={store} onOpenProjectsTab={vi.fn()} />);
  // Project lifecycle buttons moved to the Projects tab (B1 slim-down).
  for (const name of ["New project…", "Open…", "Save as…", "Close project"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(screen.getByRole("button", { name: "Add image…" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Export HTML…" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage types…" })).toBeTruthy();
  // The TypeCombobox for new components lives in the header and follows the
  // draw-type signal.
  expect(screen.queryByRole("combobox", { name: "Type for new components" })).toBeNull();
  // Scope to the header toolbar: the properties panel renders its own "Save"
  // action when a component is selected.
  const header = screen.getByRole("toolbar", { name: "Project actions" });
  expect(within(header).getByRole("button", { name: "Save" })).toBeTruthy();
  // The project name and inline save status sit at the header's right edge.
  expect(screen.queryByText("Demo board")).toBeNull();
  expect(screen.queryByText("Ready")).toBeNull();
});

it("Export HTML… is preview-disabled and flows through the picker", async () => {
  mocks.isTauri.mockReturnValue(false);
  const empty = makeStore();
  const preview = render(() => <PlacementPanel store={empty} onOpenProjectsTab={vi.fn()} />);
  const exportButton = screen.getByRole("button", { name: "Export HTML…" }) as HTMLButtonElement;
  expect(exportButton.disabled).toBe(true);
  expect(exportButton.title).toBe("Projects are available in the desktop app.");
  preview.unmount();

  mocks.isTauri.mockReturnValue(true);
  const seeded = doc();
  seeded.boards.push({
    id: "b1",
    name: "Front",
    assetHash: "a".repeat(64),
    width: 100,
    height: 80,
  });
  seeded.activeBoardId = "b1";
  const store = makeStore(seeded);
  await waitFor(() => expect(store.doc()).toBeTruthy());
  render(() => <PlacementPanel store={store} onOpenProjectsTab={vi.fn()} />);
  mocks.pickHtml.mockResolvedValue("C:\\out\\Demo board.html");
  fireEvent.click(screen.getByRole("button", { name: "Export HTML…" }));
  await waitFor(() => expect(mocks.exportHtml).toHaveBeenCalledTimes(1));
  expect(mocks.pickHtml).toHaveBeenCalledWith("Demo board.html");
  const [html, path] = mocks.exportHtml.mock.calls[0];
  expect(path).toBe("C:\\out\\Demo board.html");
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain(`@@ASSET:${"a".repeat(64)}.png@@`);
  expect(store.statusMessage()).toBe("HTML exported to C:\\out\\Demo board.html");
});

it("surfaces flow failures as panel errors", async () => {
  const seeded = doc();
  seeded.boards.push({
    id: "b1",
    name: "Front",
    assetHash: "a".repeat(64),
    width: 100,
    height: 80,
  });
  seeded.activeBoardId = "b1";
  const store = makeStore(seeded);
  await waitFor(() => expect(store.doc()).toBeTruthy());
  render(() => <PlacementPanel store={store} onOpenProjectsTab={vi.fn()} />);
  mocks.pickHtml.mockRejectedValue(new Error("The file picker could not be opened."));
  fireEvent.click(screen.getByRole("button", { name: "Export HTML…" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("The file picker could not be opened."),
  );
});
