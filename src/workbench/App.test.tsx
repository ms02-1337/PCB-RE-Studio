import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import App from "./App";
import { SEED_TYPES, type ProjectDoc } from "./placement/projectDoc";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  invoke: vi.fn(),
  pickOpen: vi.fn(),
  pickSave: vi.fn(),
  pickImage: vi.fn(),
  pickDatasheet: vi.fn(),
  pickExport: vi.fn(),
  pickHtml: vi.fn(),
  projectOpen: vi.fn(),
  projectImportCopy: vi.fn(),
  projectSave: vi.fn(),
  projectExportCopy: vi.fn(),
  projectExportHtml: vi.fn(),
  projectDelete: vi.fn(),
  assetRead: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  // window.ts pulls @tauri-apps/api/window, whose modules import several
  // core bindings at load time — provide the full export surface.
  Channel: class {},
  PluginListener: class {},
  Resource: class {},
  SERIALIZE_TO_IPC_FN: Symbol("serialize-to-ipc"),
  addPluginListener: vi.fn(),
  checkPermissions: vi.fn(),
  convertFileSrc: vi.fn(),
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
  requestPermissions: vi.fn(),
  transformCallback: vi.fn(),
}));
vi.mock("../bridge/dialog", () => ({
  pickProjectOpen: mocks.pickOpen,
  pickProjectSave: mocks.pickSave,
  pickImageImport: mocks.pickImage,
  pickDatasheetImport: mocks.pickDatasheet,
  pickExportPath: mocks.pickExport,
  pickHtmlExportPath: mocks.pickHtml,
}));
vi.mock("../bridge/project", () => ({
  projectNew: vi.fn(),
  projectOpen: mocks.projectOpen,
  projectImportCopy: mocks.projectImportCopy,
  projectSave: mocks.projectSave,
  projectSaveAs: vi.fn(),
  projectClose: vi.fn(async () => null),
  projectExportCopy: mocks.projectExportCopy,
  projectExportHtml: mocks.projectExportHtml,
  projectDelete: mocks.projectDelete,
  assetImport: vi.fn(),
  assetRead: mocks.assetRead,
  assetExport: vi.fn(),
  ProjectBridgeError: class ProjectBridgeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

function docFixture(name = "Demo board"): ProjectDoc {
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

beforeEach(() => {
  localStorage.clear();
  mocks.isTauri.mockReturnValue(false);
  mocks.projectSave.mockResolvedValue({
    path: "C:\\proj\\demo.pcbre",
    bytes: 1,
    blobCount: 0,
    savedAt: "2026-11-15T10:00:00Z",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

it("removes palette, sidebar and bottom panel and adds File/Edit/About menus", () => {
  const { container } = render(() => <App />);
  expect(screen.queryByRole("button", { name: "Command Palette" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Activity bar" })).toBeNull();
  expect(
    screen.queryByRole("complementary", { name: "Primary sidebar" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Sidebar" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Bottom panel" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Panel" })).toBeNull();
  expect(
    screen.getByRole("navigation", { name: "Application menu" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("navigation", { name: "Application menu" })
      .closest(".titlebar"),
  ).toBeTruthy();
  for (const menu of ["File", "Edit", "About"])
    expect(screen.getByText(menu, { selector: "summary" })).toBeTruthy();
  expect(container.querySelector(".bottom")).toBeNull();
  fireEvent.click(screen.getByText("File", { selector: "summary" }));
  const fileMenu = screen
    .getByText("File", { selector: "summary" })
    .closest("details")!;
  expect(fileMenu.open).toBe(true);
  fireEvent.click(screen.getByText("Edit", { selector: "summary" }));
  const editMenu = screen
    .getByText("Edit", { selector: "summary" })
    .closest("details")!;
  expect(fileMenu.open).toBe(false);
  expect(editMenu.open).toBe(true);
  screen.getByRole("menuitem", { name: "Autosave settings…" }).focus();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(editMenu.open).toBe(false);
  expect(document.activeElement).toBe(
    screen.getByText("Edit", { selector: "summary" }),
  );
  fireEvent.click(screen.getByText("File", { selector: "summary" }));
  const reopenedFileMenu = screen
    .getByText("File", { selector: "summary" })
    .closest("details")!;
  fireEvent.pointerDown(screen.getByRole("tab", { name: "Projects" }));
  expect(reopenedFileMenu.open).toBe(false);
  fireEvent.click(screen.getByText("About", { selector: "summary" }));
  const aboutMenu = screen
    .getByText("About", { selector: "summary" })
    .closest("details")!;
  fireEvent.click(
    screen.getByRole("menuitem", { name: "About PCB RE Studio" }),
  );
  expect(aboutMenu.open).toBe(false);
  expect(
    screen.getByRole("dialog", { name: "About PCB RE Studio" }),
  ).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Close" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(document.activeElement).toBe(
    screen.getByText("About", { selector: "summary" }),
  );
}, 15_000);

it("opens Settings from the title bar on every tab and restores keyboard focus", () => {
  render(() => <App />);
  const settings = screen.getByRole("button", { name: "Settings" });
  expect(settings.closest(".titlebar")).toBeTruthy();
  expect(settings.closest("nav")).toBeNull();
  for (const tab of screen.getAllByRole("tab")) {
    fireEvent.click(tab);
    settings.focus();
    fireEvent.click(settings);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const first = screen.getByRole("tab", { name: "General" });
    const last = screen.getByRole("button", { name: "Apply" });
    expect(document.activeElement).toBe(first);
    const closeButton = screen.getByRole("button", { name: "Close settings" });
    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(settings);
  }
}, 15_000);

it("navigates all six panels with roving keyboard focus", () => {
  render(() => <App />);
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Projects",
    "Board Mapping",
    "Visual Editor",
    "Schematic",
    "BOM",
    "Nets",
  ]);
  // The tablist holds ONLY tab buttons; the save badge sits outside it.
  const tablist = screen.getByRole("tablist", { name: "Workspace tabs" });
  expect(Array.from(tablist.children)).toEqual(tabs);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    tabs[0].id,
  );
  tabs[0].focus();
  fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
  expect(document.activeElement).toBe(tabs[5]);
  expect(screen.getByRole("tabpanel").getAttribute("id")).toBe(
    tabs[5].getAttribute("aria-controls"),
  );
  fireEvent.keyDown(tabs[5], { key: "Home" });
  expect(document.activeElement).toBe(tabs[0]);
  fireEvent.keyDown(tabs[0], { key: "End" });
  expect(document.activeElement).toBe(tabs[5]);
  fireEvent.click(tabs[2]);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    tabs[2].id,
  );
  expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([tabs[2]]);
});
it("switches and restores theme, including unavailable storage", () => {
  const first = render(() => <App />);
  fireEvent.click(screen.getByLabelText("Switch to light theme"));
  expect(
    first.container.querySelector(".workbench")?.getAttribute("data-theme"),
  ).toBe("light");
  first.unmount();
  const second = render(() => <App />);
  expect(screen.getByLabelText("Switch to dark theme")).toBeTruthy();
  second.unmount();
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error();
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error();
    });
  try {
    render(() => <App />);
    fireEvent.click(screen.getByLabelText("Switch to light theme"));
    expect(screen.getByLabelText("Switch to dark theme")).toBeTruthy();
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});
it("provides a centered title fallback and disabled preview window controls", () => {
  const view = render(() => <App />);
  expect(screen.getByTitle("PCB RE Studio — No project open")).toBeTruthy();
  for (const name of ["Minimize", "Maximize", "Close window"])
    expect((screen.getByLabelText(name) as HTMLButtonElement).disabled).toBe(
      true,
    );
  view.unmount();
  render(() => <App projectName="Board revision A" />);
  expect(screen.getByTitle("PCB RE Studio — Board revision A")).toBeTruthy();
});
it("hosts the Projects panel in tab 0", () => {
  render(() => <App />);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    "tab-0",
  );
  // ProjectsPanel's no-project state: New/Open + recent list.
  expect(screen.getByRole("button", { name: "New project…" })).toBeTruthy();
  expect(screen.getByText("No recent projects yet.")).toBeTruthy();
  // Switching to Board mapping hides the Projects panel and shows placement.
  fireEvent.click(screen.getAllByRole("tab")[1]);
  expect(document.getElementById("panel-0")?.hasAttribute("hidden")).toBe(true);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    "tab-1",
  );
  expect(screen.getByRole("toolbar", { name: "Project actions" })).toBeTruthy();
});
it("offers project actions in the File menu with honest gating", () => {
  render(() => <App />);
  fireEvent.click(screen.getByText("File", { selector: "summary" }));
  for (const name of [
    "Export copy…",
    "Export HTML…",
    "Delete project…",
    "New project…",
    "Open…",
  ]) {
    expect(screen.getByRole("menuitem", { name })).toBeTruthy();
  }
  // No project open (and browser preview): dialog-backed commands stay off,
  // autosave settings work everywhere.
  for (const name of ["Export copy…", "Export HTML…", "Delete project…"]) {
    expect(
      (screen.getByRole("menuitem", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
  }
  fireEvent.click(screen.getByText("Edit", { selector: "summary" }));
  expect(
    (
      screen.getByRole("menuitem", {
        name: "Autosave settings…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
it("shows the save badge only while a project is open", async () => {
  const bare = render(() => <App />);
  expect(bare.container.querySelector(".tab-save-badge")).toBeNull();
  bare.unmount();

  mocks.isTauri.mockReturnValue(true);
  mocks.pickOpen.mockResolvedValue("C:\\proj\\demo.pcbre");
  mocks.projectOpen.mockResolvedValue({
    doc: docFixture(),
    assets: {},
    path: "C:\\proj\\demo.pcbre",
  });
  const view = render(() => <App />);
  fireEvent.click(screen.getByText("File", { selector: "summary" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open…" }));
  await waitFor(() =>
    expect(view.container.querySelector(".tab-save-badge")).toBeTruthy(),
  );
  const badge = view.container.querySelector(".tab-save-badge")!;
  const dot = view.container.querySelector(".tab-save-dot")!;
  // The badge is a sibling of the tablist, never a child of it.
  expect(badge.closest('[role="tablist"]')).toBeNull();
  expect(badge.getAttribute("aria-live")).toBe("polite");
  expect(badge.getAttribute("title")).toBe("C:\\proj\\demo.pcbre");
  expect(badge.textContent).toContain("Ready");
  expect(dot.getAttribute("data-state")).toBe("idle");

  // Editing the project name through the Projects card flips it dirty.
  const name = screen.getByLabelText("Project name");
  fireEvent.input(name, { target: { value: "Demo board v2" } });
  fireEvent.blur(name);
  expect(badge.textContent).toContain("Unsaved changes");
  expect(dot.getAttribute("data-state")).toBe("dirty");

  // Ctrl+S saves immediately; the badge turns saved.
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(badge.textContent).toMatch(/^Saved/));
  expect(dot.getAttribute("data-state")).toBe("saved");
});
it("keeps save state out of the status bar; the badge stays the only surface", async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.pickOpen.mockResolvedValue("C:\\proj\\demo.pcbre");
  mocks.projectOpen.mockResolvedValue({
    doc: docFixture(),
    assets: {},
    path: "C:\\proj\\demo.pcbre",
  });
  const view = render(() => <App />);
  fireEvent.click(screen.getByText("File", { selector: "summary" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open…" }));
  const footer = () => view.container.querySelector("footer [role='status']")!;
  // Once the project is open the badge appears and the status bar reads Ready.
  await waitFor(() => expect(view.container.querySelector(".tab-save-badge")).toBeTruthy());
  expect(footer().textContent).toBe("Ready");
  // A pending mutation dirties the badge only — never the footer.
  const name = screen.getByLabelText("Project name");
  fireEvent.input(name, { target: { value: "Demo board v2" } });
  fireEvent.blur(name);
  expect(view.container.querySelector(".tab-save-badge")!.textContent).toContain("Unsaved changes");
  expect(footer().textContent).not.toContain("Unsaved changes");
  expect(footer().textContent).toBe("Ready");
}, 15_000);

it("applies autosave settings from Edit and persists them", () => {
  render(() => <App />);
  fireEvent.click(screen.getByText("Edit", { selector: "summary" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Autosave settings…" }));
  fireEvent.click(screen.getByRole("tab", { name: "Autosave" }));
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "Autosave" }),
  );
  fireEvent.click(screen.getByLabelText("Enable autosave"));
  fireEvent.input(screen.getByLabelText("Autosave delay (ms)"), {
    target: { value: "5000" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(JSON.parse(localStorage.getItem("pcb-re-studio.autosave")!)).toEqual({
    enabled: false,
    delayMs: 5000,
  });
});

it("keeps both Settings tab panels available to their controls", () => {
  render(() => <App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const generalTab = screen.getByRole("tab", { name: "General" });
  const autosaveTab = screen.getByRole("tab", { name: "Autosave" });
  const generalPanel = document.getElementById(
    generalTab.getAttribute("aria-controls")!,
  );
  const autosavePanel = document.getElementById(
    autosaveTab.getAttribute("aria-controls")!,
  );
  expect(generalPanel).toBeTruthy();
  expect(autosavePanel).toBeTruthy();
  expect(generalPanel?.hasAttribute("hidden")).toBe(false);
  expect(autosavePanel?.hasAttribute("hidden")).toBe(true);
  fireEvent.click(autosaveTab);
  expect(generalPanel?.hasAttribute("hidden")).toBe(true);
  expect(autosavePanel?.hasAttribute("hidden")).toBe(false);
});
it("keeps saved autosave settings applied across restarts", async () => {
  localStorage.setItem(
    "pcb-re-studio.autosave",
    JSON.stringify({ enabled: false, delayMs: 5000 }),
  );
  const view = render(() => <App />);
  view.unmount();
  // The stored preference loads again on the next mount.
  const second = render(() => <App />);
  fireEvent.click(screen.getByText("Edit", { selector: "summary" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Autosave settings…" }));
  fireEvent.click(screen.getByRole("tab", { name: "Autosave" }));
  expect(
    (screen.getByLabelText("Enable autosave") as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    (screen.getByLabelText("Autosave delay (ms)") as HTMLInputElement).value,
  ).toBe("5000");
  second.unmount();
});
