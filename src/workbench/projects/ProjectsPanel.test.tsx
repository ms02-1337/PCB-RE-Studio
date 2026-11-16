import { it, expect, vi, beforeEach, afterEach, describe } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { createPlacementStore, type PlacementStore } from "../placement/store";
import { ProjectsPanel, formatDateTime } from "./ProjectsPanel";
import { addRecent, loadRecent } from "./recent";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  newProject: vi.fn(),
  openProject: vi.fn(),
  save: vi.fn(),
  saveAs: vi.fn(),
  close: vi.fn(),
  exportCopy: vi.fn(),
  deleteProject: vi.fn(),
  pickSave: vi.fn(),
  pickOpen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("../../bridge/dialog", () => ({
  pickProjectSave: mocks.pickSave,
  pickProjectOpen: mocks.pickOpen,
  pickImageImport: vi.fn(),
  pickDatasheetImport: vi.fn(),
  pickExportPath: vi.fn(),
  pickHtmlExportPath: vi.fn(),
}));

const PATH = "C:\\p\\fix.pcbre";

// Local-time ISO strings (no Z) so the formatted timestamps are TZ-stable.
function seededDoc(name = "Fixtures"): ProjectDoc {
  return {
    schemaVersion: 1,
    name,
    createdAt: "2026-11-15T10:30:00",
    updatedAt: "2026-11-15T11:45:00",
    types: SEED_TYPES.map((type) => ({ ...type })),
    boards: [
      {
        id: "b1",
        name: "Front",
        assetHash: "a".repeat(64),
        width: 100,
        height: 80,
      },
      {
        id: "b2",
        name: "Back",
        assetHash: "b".repeat(64),
        width: 100,
        height: 80,
      },
    ],
    components: [
      {
        id: "c1",
        boardId: "b1",
        refdes: "U1",
        typeId: "ic",
        shape: { rect: { x: 0, y: 0, w: 5, h: 5 } },
        status: "identified",
        locked: false,
      },
      {
        id: "c2",
        boardId: "b2",
        refdes: "R1",
        typeId: "resistor",
        shape: { rect: { x: 1, y: 1, w: 5, h: 5 } },
        status: "identified",
        locked: false,
      },
    ],
    assets: {
      ["a".repeat(64)]: { hash: "a".repeat(64), size: 6144, name: "front.png" },
      ["b".repeat(64)]: { hash: "b".repeat(64), size: 2048, name: "back.png" },
    },
    activeBoardId: "b1",
    description: "Existing note",
  };
}

function bridgeMocks() {
  return {
    newProject: mocks.newProject,
    openProject: mocks.openProject,
    save: mocks.save,
    saveAs: mocks.saveAs,
    close: mocks.close,
    exportHtml: vi.fn(),
    projectExportCopy: mocks.exportCopy,
    projectDelete: mocks.deleteProject,
  };
}

async function makeStore(doc?: ProjectDoc): Promise<PlacementStore> {
  const store = createPlacementStore(bridgeMocks());
  if (doc) {
    mocks.openProject.mockResolvedValueOnce({
      doc,
      assets: doc.assets,
      path: PATH,
    });
    await store.openProject(PATH);
  }
  return store;
}

function panel(store: PlacementStore, onOpenSettings = vi.fn()) {
  return render(() => (
    <ProjectsPanel store={store} onOpenSettings={onOpenSettings} />
  ));
}

beforeEach(() => {
  localStorage.clear();
  mocks.isTauri.mockReturnValue(true);
  mocks.save.mockResolvedValue({
    path: PATH,
    bytes: 1,
    blobCount: 0,
    savedAt: "2026-11-15T10:00:00Z",
  });
  mocks.close.mockResolvedValue(null);
  mocks.deleteProject.mockResolvedValue(null);
  mocks.exportCopy.mockResolvedValue({
    path: "C:\\p\\copy.pcbre",
    bytes: 1,
    blobCount: 0,
    savedAt: "2026-11-15T10:00:00Z",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("formatDateTime", () => {
  it("formats local-time ISO strings as YYYY-MM-DD HH:MM and blanks invalid ones", () => {
    expect(formatDateTime("2026-11-15T10:30:00")).toBe("2026-11-15 10:30");
    expect(formatDateTime("not a date")).toBe("");
    expect(formatDateTime(undefined)).toBe("");
  });
});

describe("open project card", () => {
  it("shows metadata, timestamps, the file path, and a stats line", async () => {
    const store = await makeStore(seededDoc());
    panel(store);
    expect(
      (screen.getByLabelText("Project name") as HTMLInputElement).value,
    ).toBe("Fixtures");
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Existing note");
    expect(screen.getByText("Created 2026-11-15 10:30")).toBeTruthy();
    expect(screen.getByText("Updated 2026-11-15 11:45")).toBeTruthy();
    expect(screen.getByTitle(PATH).textContent).toContain(PATH);
    const stats = screen.getByLabelText("Project statistics");
    expect(stats.textContent).toContain("Board mapping");
    expect(stats.textContent).toContain("Layers2");
    expect(stats.textContent).toContain("Components2");
    expect(stats.textContent).toContain("Visual editor");
    expect(stats.textContent).toContain("Photographs0");
    expect(stats.textContent).toContain("Traces0");
    expect(stats.textContent).toContain("Asset storage8.0 KB");
  });

  it("displays visual editor statistics when visual editor data is present", async () => {
    const doc = seededDoc();
    doc.visualEditor = {
      activePcbId: "pcb-1",
      pcbs: [
        {
          id: "pcb-1",
          name: "Main PCB",
          layers: ["l1", "l2"],
          images: [
            {
              id: "img1",
              name: "Top.jpg",
              assetHash: "a".repeat(64),
              width: 1000,
              height: 800,
              x: 0,
              y: 0,
              flipH: false,
              flipV: false,
              visible: true,
              opacity: 1,
              locked: false,
            },
          ],
          traces: [
            {
              id: "t1",
              layerId: "l1",
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 10 },
              ],
              width: 2,
            },
            {
              id: "t2",
              layerId: "l2",
              points: [
                { x: 10, y: 10 },
                { x: 20, y: 20 },
              ],
              width: 2,
            },
          ],
          vias: [{ id: "v1", x: 10, y: 10, diameter: 0.8, drill: 0.4 }],
          zones: [
            {
              id: "z1",
              layerId: "l1",
              points: [
                { x: 0, y: 0 },
                { x: 50, y: 0 },
                { x: 50, y: 50 },
              ],
            },
          ],
          nets: [
            { id: "net1", name: "GND", color: "#00ff00" },
            { id: "net2", name: "VCC", color: "#ff0000" },
          ],
        },
      ],
    };
    const store = await makeStore(doc);
    panel(store);
    const stats = screen.getByLabelText("Project statistics");
    expect(stats.textContent).toContain("Photographs1");
    expect(stats.textContent).toContain("Traces2");
    expect(stats.textContent).toContain("Vias1");
    expect(stats.textContent).toContain("Zones1");
    expect(stats.textContent).toContain("Nets2");
  });

  it("falls back to an em dash for unparseable timestamps", async () => {
    const doc = seededDoc();
    doc.createdAt = "not a date";
    const store = await makeStore(doc);
    panel(store);
    expect(screen.getByText("Created -")).toBeTruthy();
    expect(screen.getByText("Updated 2026-11-15 11:45")).toBeTruthy();
  });

  it("edits the name and description through updateProjectMeta", async () => {
    const store = await makeStore(seededDoc());
    panel(store);
    const name = screen.getByLabelText("Project name");
    fireEvent.input(name, { target: { value: "  Renamed  " } });
    fireEvent.blur(name);
    expect(store.doc()?.name).toBe("Renamed");
    expect(store.saveState()).toBe("dirty");

    const description = screen.getByLabelText("Description");
    fireEvent.input(description, { target: { value: "Main board rev C" } });
    fireEvent.blur(description);
    expect(store.doc()?.description).toBe("Main board rev C");
  });

  it("rejects an empty name: the field reverts and the doc keeps its name", async () => {
    const store = await makeStore(seededDoc());
    panel(store);
    const name = screen.getByLabelText("Project name");
    fireEvent.input(name, { target: { value: "   " } });
    fireEvent.blur(name);
    expect(store.doc()?.name).toBe("Fixtures");
    expect(
      (screen.getByLabelText("Project name") as HTMLInputElement).value,
    ).toBe("Fixtures");
    expect(store.statusMessage()).toBe("Project name cannot be empty");
  });

  it("rejects an over-long description: the field reverts and the doc keeps its text", async () => {
    const store = await makeStore(seededDoc());
    panel(store);
    const description = screen.getByLabelText("Description");
    fireEvent.input(description, { target: { value: "x".repeat(4001) } });
    fireEvent.blur(description);
    expect(store.doc()?.description).toBe("Existing note");
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("Existing note");
    expect(store.statusMessage()).toBe(
      "Description must be 4000 characters or fewer",
    );
  });

  it("offers every lifecycle action plus Autosave settings…", async () => {
    const onOpenSettings = vi.fn();
    const store = await makeStore(seededDoc());
    panel(store, onOpenSettings);
    for (const label of [
      "New project…",
      "Open…",
      "Save as…",
      "Export copy…",
      "Delete…",
      "Close project",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Delete…" }).className).toContain(
      "danger",
    );
    expect(screen.queryByRole("button", { name: "Autosave settings…" })).toBeNull();
  });

  it("exports a copy through the picker and bridge", async () => {
    const store = await makeStore(seededDoc());
    panel(store);
    mocks.pickSave.mockResolvedValue("C:\\p\\Fixtures-copy.pcbre");
    fireEvent.click(screen.getByRole("button", { name: "Export copy…" }));
    await waitFor(() => expect(mocks.exportCopy).toHaveBeenCalledTimes(1));
    expect(mocks.pickSave).toHaveBeenCalledWith("Fixtures-copy.pcbre");
    const [docArg, pathArg] = mocks.exportCopy.mock.calls[0];
    expect(pathArg).toBe("C:\\p\\Fixtures-copy.pcbre");
    expect(docArg.name).toBe("Fixtures");
    expect(store.statusMessage()).toBe(
      "Project copy exported to C:\\p\\Fixtures-copy.pcbre",
    );
  });

  it("deletes permanently after flushing unsaved work and forgets the recent entry", async () => {
    const store = await makeStore(seededDoc());
    expect(loadRecent().some((entry) => entry.path === PATH)).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    panel(store);
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await waitFor(() => expect(mocks.deleteProject).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledTimes(0); // clean doc: no flush needed
    expect(confirm.mock.calls[0][0]).toContain(PATH);
    await waitFor(() => expect(store.doc()).toBeNull());
    expect(loadRecent().some((entry) => entry.path === PATH)).toBe(false);
    // The empty state takes over.
    expect(screen.getByText("No recent projects yet.")).toBeTruthy();
  });

  it("keeps the project when the delete confirm is declined", async () => {
    const store = await makeStore(seededDoc());
    vi.spyOn(window, "confirm").mockReturnValue(false);
    panel(store);
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    expect(store.doc()).toBeTruthy();
  });

  it("closes the project through the store flow", async () => {
    const store = await makeStore(seededDoc());
    panel(store);
    fireEvent.click(screen.getByRole("button", { name: "Close project" }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.doc()).toBeNull());
  });

  it("surfaces flow failures as alerts", async () => {
    const store = await makeStore(seededDoc());
    panel(store);
    mocks.pickSave.mockResolvedValue("C:\\p\\Fixtures-copy.pcbre");
    mocks.exportCopy.mockRejectedValue(new Error("disk full"));
    fireEvent.click(screen.getByRole("button", { name: "Export copy…" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("disk full"),
    );
  });

  it("disables dialog-backed actions in browser preview with honest titles", async () => {
    mocks.isTauri.mockReturnValue(false);
    const store = await makeStore(seededDoc());
    panel(store);
    for (const label of [
      "New project…",
      "Open…",
      "Save as…",
      "Export copy…",
      "Delete…",
    ]) {
      const button = screen.getByRole("button", {
        name: label,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Projects are available in the desktop app.");
    }
    expect(
      (
        screen.getByRole("button", {
          name: "Close project",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

describe("no-project state", () => {
  it("offers New/Open/Import plus the recent list", async () => {
    addRecent("C:\\a\\one.pcbre", "One");
    addRecent("C:\\a\\two.pcbre", "Two");
    const store = await makeStore();
    panel(store);
    expect(screen.getByText("No project open.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Import project/ })).toBeTruthy();
    const next = screen.getByRole("button", {
      name: "New project…",
    }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    expect(screen.getByText("One")).toBeTruthy();
    expect(screen.getByText("Two")).toBeTruthy();

    // Clicking a recent entry opens it through the store (clean: no prompt).
    mocks.openProject.mockResolvedValue({
      doc: seededDoc("Two"),
      assets: {},
      path: "C:\\a\\two.pcbre",
    });
    fireEvent.click(screen.getByRole("button", { name: /^Two/ }));
    await waitFor(() =>
      expect(mocks.openProject).toHaveBeenCalledWith("C:\\a\\two.pcbre"),
    );
    await waitFor(() => expect(store.doc()?.name).toBe("Two"));
  });

  it("disables New/Open in browser preview with honest titles", async () => {
    mocks.isTauri.mockReturnValue(false);
    const store = await makeStore();
    panel(store);
    for (const label of ["New project…", "Open…", "Import project…"]) {
      const button = screen.getByRole("button", {
        name: label,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Projects are available in the desktop app.");
    }
  });

  it("creates a project through New project… and records it as recent", async () => {
    const store = await makeStore();
    mocks.pickSave.mockResolvedValue("C:\\p\\fresh.pcbre");
    mocks.newProject.mockResolvedValue({
      doc: seededDoc("fresh"),
      assets: {},
      path: "C:\\p\\fresh.pcbre",
    });
    panel(store);
    fireEvent.click(screen.getByRole("button", { name: "New project…" }));
    await waitFor(() => expect(store.doc()?.name).toBe("fresh"));
    expect(mocks.pickSave).toHaveBeenCalledWith("Untitled.pcbre");
    expect(
      loadRecent().some((entry) => entry.path === "C:\\p\\fresh.pcbre"),
    ).toBe(true);
    expect(screen.getByLabelText("Project name")).toBeTruthy();
  });

  it("removes a recent entry with × and refreshes the list", async () => {
    addRecent("C:\\a\\one.pcbre", "One");
    const store = await makeStore();
    panel(store);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove One from recent projects" }),
    );
    expect(loadRecent()).toEqual([]);
    expect(screen.getByText("No recent projects yet.")).toBeTruthy();
  });

  it("shows a muted note when the recent list is empty", async () => {
    const store = await makeStore();
    panel(store);
    expect(screen.getByText("No recent projects yet.")).toBeTruthy();
  });
});
