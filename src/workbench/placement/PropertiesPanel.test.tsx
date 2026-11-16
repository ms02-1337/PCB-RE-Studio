import { it, expect, vi, beforeEach, afterEach, describe } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import type { ProjectDoc } from "./projectDoc";
import { SEED_TYPES } from "./projectDoc";
import { createPlacementStore, type PlacementStore } from "./store";
import { PropertiesPanel } from "./PropertiesPanel";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  assetImport: vi.fn(),
  assetImportClipboardImage: vi.fn(),
  assetRead: vi.fn(),
  assetExport: vi.fn(),
  pickDatasheet: vi.fn(),
  pickExport: vi.fn(),
  pickImage: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("../../bridge/project", () => ({
  projectNew: vi.fn(),
  projectOpen: vi.fn(),
  projectImportCopy: vi.fn(),
  projectSave: vi.fn(),
  projectSaveAs: vi.fn(),
  projectClose: vi.fn(async () => null),
  projectExportCopy: vi.fn(),
  projectExportHtml: vi.fn(),
  projectDelete: vi.fn(),
  assetImport: mocks.assetImport,
  assetImportClipboardImage: mocks.assetImportClipboardImage,
  assetRead: mocks.assetRead,
  assetExport: mocks.assetExport,
  ProjectBridgeError: class ProjectBridgeError extends Error {},
}));
vi.mock("../../bridge/dialog", () => ({
  pickProjectOpen: vi.fn(),
  pickProjectImportSource: vi.fn(),
  pickProjectSave: vi.fn(),
  pickImageImport: mocks.pickImage,
  pickDatasheetImport: mocks.pickDatasheet,
  pickExportPath: mocks.pickExport,
  pickHtmlExportPath: vi.fn(),
}));

function seededDoc(): ProjectDoc {
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Fixtures",
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    types: SEED_TYPES.map((type) => ({ ...type })),
    boards: [{ id: "b1", name: "Front", assetHash: "a".repeat(64), width: 1024, height: 768 }],
    components: [],
    assets: { ["a".repeat(64)]: { hash: "a".repeat(64), size: 2048, name: "board.png" } },
    activeBoardId: "b1",
  };
  return doc;
}

async function makeStore(doc: ProjectDoc, select?: string): Promise<PlacementStore> {
  const store = createPlacementStore({
    openProject: vi.fn(async () => ({ doc, assets: doc.assets, path: "C:\\p.pcbre" })),
    save: vi.fn(async () => ({ path: "C:\\p.pcbre", bytes: 1, blobCount: 0, savedAt: "2026-11-15T10:00:00Z" })),
    saveAs: vi.fn(),
    newProject: vi.fn(),
    close: vi.fn(async () => null),
  });
  await store.openProject("C:\\p.pcbre");
  if (select) store.setSelectedId(select);
  return store;
}

function panel(store: PlacementStore) {
  return render(() => (
    <PropertiesPanel
      store={store}
      onOpenProjectsTab={vi.fn()}
      onAddBoard={vi.fn()}
    />
  ));
}

beforeEach(() => {
  mocks.isTauri.mockReturnValue(true);
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  // Clipboard stubs from the copy-button tests must not leak into other suites.
  delete (navigator as { clipboard?: unknown }).clipboard;
});

it("offers the Projects tab when no project is open", () => {
  mocks.isTauri.mockReturnValue(false);
  const onOpenProjectsTab = vi.fn();
  const store = createPlacementStore({ save: vi.fn() });
  render(() => (
    <PropertiesPanel store={store} onOpenProjectsTab={onOpenProjectsTab} onAddBoard={vi.fn()} />
  ));
  expect(screen.getByText("No project open.")).toBeTruthy();
  expect(screen.getByText("Projects are available in the desktop app.")).toBeTruthy();
  // Lifecycle buttons live in the Projects tab now - only the link remains.
  expect(screen.queryByRole("button", { name: "New project…" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open…" })).toBeNull();
  const openTab = screen.getByRole("button", { name: "Open the Projects tab" }) as HTMLButtonElement;
  expect(openTab.disabled).toBe(false);
  fireEvent.click(openTab);
  expect(onOpenProjectsTab).toHaveBeenCalledTimes(1);
});

it("shows board stats when nothing is selected", async () => {
  const store = await makeStore(seededDoc());
  panel(store);
  expect(screen.getByText(/Front - 1024 × 768 px/)).toBeTruthy();
  expect(screen.getByText(/0 components marked/)).toBeTruthy();
  expect(screen.getByText(/Draw a rect, ellipse, or polygon/)).toBeTruthy();
});

it("edits component fields into the store", async () => {
  const doc = seededDoc();
  doc.components.push({
    id: "c1",
    boardId: "b1",
    refdes: "U1",
    typeId: "ic",
    shape: { rect: { x: 0, y: 0, w: 30, h: 20 } },
    status: "identified",
    locked: false,
  });
  const store = await makeStore(doc, "c1");
  panel(store);
  fireEvent.input(screen.getByLabelText("Part number"), { target: { value: "LM358" } });
  fireEvent.input(screen.getByLabelText("Value"), { target: { value: "dual op-amp" } });
  fireEvent.input(screen.getByLabelText("Marking"), { target: { value: "LM358N" } });
  fireEvent.input(screen.getByLabelText("Package"), { target: { value: "DIP-8" } });
  fireEvent.input(screen.getByLabelText("Manufacturer"), { target: { value: "TI" } });
  fireEvent.input(screen.getByLabelText("URL"), { target: { value: "https://example.com/lm358.pdf" } });
  fireEvent.input(screen.getByLabelText("Notes"), { target: { value: "Check rail" } });
  const component = store.doc()!.components[0];
  expect(component.partNumber).toBe("LM358");
  expect(component.value).toBe("dual op-amp");
  expect(component.marking).toBe("LM358N");
  expect(component.pkg).toBe("DIP-8");
  expect(component.manufacturer).toBe("TI");
  expect(component.datasheetUrl).toBe("https://example.com/lm358.pdf");
  expect(component.notes).toBe("Check rail");

  // The type is edited through the combobox: open, pick the option.
  fireEvent.click(screen.getByRole("combobox", { name: "Type" }));
  fireEvent.click(screen.getByText("Resistor"));
  expect(store.doc()!.components[0].typeId).toBe("resistor");
  expect((screen.getByRole("combobox", { name: "Type" }) as HTMLInputElement).value).toBe("Resistor");
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "verified" } });
  expect(store.doc()!.components[0].status).toBe("verified");
  fireEvent.input(screen.getByLabelText("Reference designator"), { target: { value: "U9" } });
  expect(store.doc()!.components[0].refdes).toBe("U9");
});

it("locks disable every field except the lock toggle", async () => {
  const doc = seededDoc();
  doc.components.push({
    id: "c1",
    boardId: "b1",
    refdes: "U1",
    typeId: "ic",
    shape: { rect: { x: 0, y: 0, w: 30, h: 20 } },
    status: "identified",
    locked: true,
  });
  const store = await makeStore(doc, "c1");
  panel(store);
  expect(screen.getByText("Component is locked - unlock to edit.")).toBeTruthy();
  expect((screen.getByLabelText("Part number") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Status") as HTMLSelectElement).disabled).toBe(true);
  // The lock button reads "Locked" while locked…
  const lock = screen.getByRole("button", { name: "Locked" });
  expect(lock.getAttribute("aria-pressed")).toBe("true");
  const del = screen.getByRole("button", { name: "Delete" });
  expect((del as HTMLButtonElement).disabled).toBe(true);
  expect(del.title).toBe("Component is locked");
  fireEvent.click(lock);
  expect(store.doc()!.components[0].locked).toBe(false);
  // …and "Lock" once unlocked, so the label matches the action it performs.
  const unlock = screen.getByRole("button", { name: "Lock" });
  expect(unlock.getAttribute("aria-pressed")).toBe("false");
  expect((screen.getByLabelText("Part number") as HTMLInputElement).disabled).toBe(false);
});

describe("copy field buttons", () => {
  /** Doc whose component carries all five copyable values (locked by default). */
  function copyableDoc(locked: boolean): ProjectDoc {
    const doc = seededDoc();
    doc.components.push({
      id: "c1",
      boardId: "b1",
      refdes: "U1",
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 30, h: 20 } },
      status: "identified",
      locked,
      partNumber: "LM358",
      value: "10k",
      datasheetUrl: "https://example.com/lm358.pdf",
      description: "Dual op-amp",
      notes: "Check rail",
    });
    return doc;
  }

  function stubClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  }

  it("copies each field's committed value from a locked component; inputs stay disabled", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const store = await makeStore(copyableDoc(true), "c1");
    panel(store);
    // Exactly the five copyable fields gain buttons - no others.
    expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(5);
    const expected: Array<[string, string]> = [
      ["Part number", "LM358"],
      ["Value", "10k"],
      ["URL", "https://example.com/lm358.pdf"],
      ["Description", "Dual op-amp"],
      ["Notes", "Check rail"],
    ];
    expected.forEach(([label]) => {
      const field = screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
      expect(field.disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: `Copy ${label}` }));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(5));
    expected.forEach(([, value], index) => {
      expect(writeText).toHaveBeenNthCalledWith(index + 1, value);
    });
  });

  it("still copies while unlocked, using the edited value at click time", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const store = await makeStore(copyableDoc(false), "c1");
    panel(store);
    expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(5);
    fireEvent.input(screen.getByLabelText("Part number"), { target: { value: "LM358N" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy Part number" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("LM358N"));
  });

  it("reports a friendly alert when the clipboard is missing or rejects", async () => {
    stubClipboard(vi.fn(async () => { throw new Error("denied"); }));
    const store = await makeStore(copyableDoc(true), "c1");
    panel(store);
    fireEvent.click(screen.getByRole("button", { name: "Copy Value" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be copied"));
    // A missing clipboard API surfaces the same message.
    delete (navigator as { clipboard?: unknown }).clipboard;
    fireEvent.click(screen.getByRole("button", { name: "Copy Notes" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be copied"));
  });
});

it("duplicates with a fresh refdes and deletes unlocked components", async () => {
  const doc = seededDoc();
  doc.components.push({
    id: "c1",
    boardId: "b1",
    refdes: "U7",
    typeId: "ic",
    shape: { rect: { x: 10, y: 10, w: 30, h: 20 } },
    status: "identified",
    locked: false,
  });
  const store = await makeStore(doc, "c1");
  panel(store);
  fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
  const components = store.doc()!.components;
  expect(components).toHaveLength(2);
  expect(components[1].refdes).toBe("U8");
  expect(components[1].shape).toEqual({ rect: { x: 22, y: 22, w: 30, h: 20 } });
  expect(store.selectedId()).toBe(components[1].id);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(store.doc()!.components).toHaveLength(1);
});

it("flags duplicate refdes inline", async () => {
  const doc = seededDoc();
  doc.components.push(
    {
      id: "c1",
      boardId: "b1",
      refdes: "U1",
      typeId: "ic",
      shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
      status: "identified",
      locked: false,
    },
    {
      id: "c2",
      boardId: "b1",
      refdes: "U1",
      typeId: "ic",
      shape: { rect: { x: 40, y: 0, w: 10, h: 10 } },
      status: "identified",
      locked: false,
    },
  );
  const store = await makeStore(doc, "c2");
  panel(store);
  expect(screen.getByText(/already used/i)).toBeTruthy();
});

it("typing keeps the same form and input DOM nodes (no per-keystroke rebuild)", async () => {
  const doc = seededDoc();
  doc.components.push({
    id: "c1",
    boardId: "b1",
    refdes: "U1",
    typeId: "ic",
    shape: { rect: { x: 0, y: 0, w: 30, h: 20 } },
    status: "identified",
    locked: false,
  });
  const store = await makeStore(doc, "c1");
  const { container } = panel(store);
  const form = container.querySelector(".pl-form")!;
  const input = screen.getByLabelText("Part number") as HTMLInputElement;
  input.focus();
  fireEvent.input(input, { target: { value: "LM358" } });
  await Promise.resolve();
  // Regression pin for the keyed-Show bug: the doc is cloned per edit, but the
  // form must not be disposed and recreated (which dropped focus to <body>).
  expect(container.querySelector(".pl-form")).toBe(form);
  expect(screen.getByLabelText("Part number")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(store.doc()!.components[0].partNumber).toBe("LM358");
  fireEvent.input(input, { target: { value: "LM358N" } });
  expect(screen.getByLabelText("Part number")).toBe(input);
  expect(store.doc()!.components[0].partNumber).toBe("LM358N");
});

it("shows a failed-image state with a working retry", async () => {
  const doc = seededDoc();
  doc.components.push({
    id: "c1",
    boardId: "b1",
    refdes: "U1",
    typeId: "ic",
    shape: { rect: { x: 0, y: 0, w: 30, h: 20 } },
    status: "identified",
    locked: false,
    imageHash: "e".repeat(64),
  });
  const store = await makeStore(doc, "c1");
  mocks.assetRead.mockRejectedValueOnce(new Error("asset gone"));
  panel(store);
  await waitFor(() => expect(screen.getByText("Image could not be loaded.")).toBeTruthy());
  expect(screen.queryByText("Loading image…")).toBeNull();
  const createObjectURL = vi.fn(() => "blob:retry");
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  mocks.assetRead.mockResolvedValueOnce(new ArrayBuffer(8));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Image for U1" })).toBeTruthy());
  expect(screen.getByRole("img", { name: "Image for U1" }).getAttribute("src")).toBe("blob:retry");
});

it("attaches and detaches datasheet files independently of the URL", async () => {
  const doc = seededDoc();
  doc.components.push({
    id: "c1",
    boardId: "b1",
    refdes: "U1",
    typeId: "ic",
    shape: { rect: { x: 0, y: 0, w: 30, h: 20 } },
    status: "identified",
    locked: false,
    datasheetUrl: "https://example.com/old",
  });
  const store = await makeStore(doc, "c1");
  panel(store);
  const hash = "d".repeat(64);
  mocks.pickDatasheet.mockResolvedValue("C:\\docs\\chip.pdf");
  mocks.assetImport.mockResolvedValue({ hash, size: 4096, name: "chip.pdf" });
  fireEvent.click(screen.getAllByRole("button", { name: "Attach…" })[0]);
  await waitFor(() => expect(store.doc()!.components[0].datasheetHash).toBe(hash));
  expect(store.doc()!.assets[hash]).toEqual({ hash, size: 4096, name: "chip.pdf" });
  expect(store.doc()!.components[0].datasheetUrl).toBe("https://example.com/old");
  expect(screen.getByText(/chip\.pdf/)).toBeTruthy();
  expect(screen.getByText("4.0 KB")).toBeTruthy();

  mocks.pickExport.mockResolvedValue("C:\\export\\chip.pdf");
  mocks.assetExport.mockResolvedValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(mocks.assetExport).toHaveBeenCalledWith(hash, "C:\\export\\chip.pdf"));

  fireEvent.click(screen.getByRole("button", { name: "Detach" }));
  await waitFor(() => expect(store.doc()!.components[0].datasheetHash).toBeUndefined());
  expect(store.doc()!.components[0].datasheetUrl).toBe("https://example.com/old");
});

it("attaches and detaches component images with a thumbnail", async () => {
  const doc = seededDoc();
  doc.components.push({
    id: "c1",
    boardId: "b1",
    refdes: "U1",
    typeId: "ic",
    shape: { rect: { x: 0, y: 0, w: 30, h: 20 } },
    status: "identified",
    locked: false,
  });
  const store = await makeStore(doc, "c1");
  panel(store);
  const hash = "e".repeat(64);
  mocks.pickImage.mockResolvedValue("C:\\shots\\chip.png");
  mocks.assetImport.mockResolvedValue({ hash, size: 1000, name: "chip.png" });
  mocks.assetRead.mockResolvedValue(new ArrayBuffer(8));
  const createObjectURL = vi.fn(() => "blob:thumbnail");
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const imageAttach = screen.getByRole("button", { name: "Browse…" });
  fireEvent.click(imageAttach);
  await waitFor(() => expect(store.doc()!.components[0].imageHashes).toEqual([hash]));
  await waitFor(() => expect(screen.getByRole("img", { name: "Image for U1" })).toBeTruthy());
  expect(screen.getByRole("img", { name: "Image for U1" }).getAttribute("src")).toBe("blob:thumbnail");
  fireEvent.click(screen.getByRole("button", { name: "Delete image" }));
  await waitFor(() => expect(store.doc()!.components[0].imageHash).toBeUndefined());
  expect(revokeObjectURL).toHaveBeenCalled();
});

function imageDoc(): ProjectDoc {
  const doc = seededDoc();
  doc.components.push({ id: "c1", boardId: "b1", refdes: "U1", typeId: "ic",
    shape: { rect: { x: 0, y: 0, w: 30, h: 20 } }, status: "identified", locked: false });
  return doc;
}

it("persists an image display name into component.imageNames", async () => {
  const doc = imageDoc();
  doc.components[0].imageHash = "e".repeat(64);
  const store = await makeStore(doc, "c1");
  panel(store);
  mocks.assetRead.mockResolvedValue(new ArrayBuffer(8));
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:name"), revokeObjectURL: vi.fn() });
  const hash = "e".repeat(64);
  const input = screen.getByLabelText("Image name") as HTMLInputElement;
  expect(input.value).toBe("");
  expect(input.getAttribute("maxlength")).toBe("200");
  fireEvent.input(input, { target: { value: "  Front shot  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(store.doc()!.components[0].imageNames).toEqual({ [hash]: "Front shot" });
  expect(input.value).toBe("Front shot");
  // An emptied name deletes the key to keep the document clean.
  fireEvent.input(input, { target: { value: "   " } });
  fireEvent.blur(input);
  expect(store.doc()!.components[0].imageNames).toEqual({});
  // Re-set via change, then verify the record is copied, not mutated.
  fireEvent.input(input, { target: { value: "Top" } });
  fireEvent.change(input);
  fireEvent.input(input, { target: { value: "Bottom" } });
  fireEvent.blur(input);
  expect(store.doc()!.components[0].imageNames).toEqual({ [hash]: "Bottom" });
  // The name input follows the component lock state.
  store.updateComponent("c1", { locked: true });
  expect((screen.getByLabelText("Image name") as HTMLInputElement).disabled).toBe(true);
});

it("opens a centered image viewer from the thumbnail and closes it with Escape", async () => {
  const doc = imageDoc();
  doc.components[0].imageHash = "e".repeat(64);
  const store = await makeStore(doc, "c1");
  panel(store);
  mocks.assetRead.mockResolvedValue(new ArrayBuffer(8));
  const createObjectURL = vi.fn(() => "blob:viewer");
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  await waitFor(() => expect(screen.getByRole("img", { name: "Image for U1" })).toBeTruthy());
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open image for U1" }));
  const dialog = screen.getByRole("dialog", { name: "Image viewer" });
  expect(dialog.closest(".overlay")!.classList.contains("overlay--center")).toBe(true);
  expect(screen.getByText("Scroll to zoom · drag to pan")).toBeTruthy();
  // The viewer reuses the same object URL as the thumbnail.
  const images = screen.getAllByRole("img", { name: "Image for U1" });
  expect(images).toHaveLength(2);
  expect(images.every((image) => image.getAttribute("src") === "blob:viewer")).toBe(true);
  // Wheel zoom scales the transform; clamps hold at 16× and 0.1×.
  const stage = dialog.querySelector(".image-viewer-stage")!;
  const viewerImage = images.find((image) => image.closest(".image-viewer-stage"))!;
  fireEvent.wheel(stage, { deltaY: -120 });
  expect(viewerImage.style.transform).toContain("scale(1.15)");
  for (let zoom = 0; zoom < 80; zoom++) fireEvent.wheel(stage, { deltaY: -120 });
  expect(viewerImage.style.transform).toContain("scale(16)");
  for (let zoom = 0; zoom < 120; zoom++) fireEvent.wheel(stage, { deltaY: 120 });
  expect(viewerImage.style.transform).toContain("scale(0.1)");
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  // Reopening starts from a reset transform.
  fireEvent.click(screen.getByRole("button", { name: "Open image for U1" }));
  const reopened = screen.getByRole("dialog", { name: "Image viewer" });
  expect(reopened.querySelector("img")!.style.transform).toBe("translate(0px, 0px) scale(1)");
  fireEvent.keyDown(reopened, { key: "Escape" });
});

it("detaches a component image through the icon-only trash button", async () => {
  const doc = imageDoc();
  doc.components[0].imageHash = "e".repeat(64);
  const store = await makeStore(doc, "c1");
  panel(store);
  mocks.assetRead.mockResolvedValue(new ArrayBuffer(8));
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:trash"), revokeObjectURL: vi.fn() });
  await waitFor(() => expect(screen.getByRole("img", { name: "Image for U1" })).toBeTruthy());
  const trash = screen.getByRole("button", { name: "Delete image" }) as HTMLButtonElement;
  expect(trash.title).toBe("Remove this image");
  fireEvent.click(trash);
  await waitFor(() => expect(store.doc()!.components[0].imageHash).toBeUndefined());
  expect(screen.getByText("No component image attached.")).toBeTruthy();
});

it("pastes and appends a component image, retaining browse and reporting clipboard errors", async () => {
  const store = await makeStore(imageDoc(), "c1");
  panel(store);
  mocks.assetRead.mockResolvedValue(new ArrayBuffer(8));
  mocks.assetImportClipboardImage.mockResolvedValue({ hash: "f".repeat(64), size: 24, name: "clipboard.png" });
  fireEvent.click(screen.getByRole("button", { name: "Paste image" }));
  await waitFor(() => expect(store.doc()!.components[0].imageHashes).toEqual(["f".repeat(64)]));
  expect(screen.getByRole("button", { name: "Browse…" })).toBeTruthy();
  mocks.assetImportClipboardImage.mockRejectedValue(new Error("The clipboard does not contain an image."));
  fireEvent.click(screen.getByRole("button", { name: "Paste image" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("does not contain an image"));
  expect(store.doc()!.components[0].imageHashes).toEqual(["f".repeat(64)]);
});

it("supports Ctrl/Cmd+V while preserving text paste and ignoring hidden, dialog, locked and no-selection states", async () => {
  const store = await makeStore(imageDoc(), "c1");
  const { container, unmount } = panel(store);
  mocks.assetRead.mockResolvedValue(new ArrayBuffer(8));
  mocks.assetImportClipboardImage.mockResolvedValue({ hash: "f".repeat(64), size: 24, name: "clipboard.png" });
  const keyboard = (target: Element, modifier = "ctrlKey") => fireEvent.keyDown(target, { key: "v", [modifier]: true });
  expect(keyboard(screen.getByLabelText("Notes"))).toBe(true);
  expect(keyboard(screen.getByLabelText("Part number"))).toBe(true);
  container.hidden = true;
  expect(keyboard(document.body)).toBe(true);
  container.hidden = false;
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  expect(keyboard(document.body)).toBe(true);
  dialog.remove();
  store.updateComponent("c1", { locked: true });
  expect(keyboard(document.body)).toBe(true);
  store.updateComponent("c1", { locked: false });
  store.setSelectedId(null);
  expect(keyboard(document.body)).toBe(true);
  store.setSelectedId("c1");
  expect(mocks.assetImportClipboardImage).not.toHaveBeenCalled();
  expect(keyboard(document.body)).toBe(false);
  await waitFor(() => expect(store.doc()!.components[0].imageHashes).toEqual(["f".repeat(64)]));
  await waitFor(() => expect((screen.getByRole("button", { name: "Paste image" }) as HTMLButtonElement).disabled).toBe(false));
  expect(keyboard(document.body, "metaKey")).toBe(false);
  await waitFor(() => expect(mocks.assetImportClipboardImage).toHaveBeenCalledTimes(2));
  unmount();
  expect(keyboard(document.body)).toBe(true);
});

it("retains the original browse target and ignores completion after project changes or locking", async () => {
  const store = await makeStore(imageDoc(), "c1");
  const second = store.duplicateComponent("c1");
  store.setSelectedId("c1");
  panel(store);
  let finish!: (path: string | null) => void;
  mocks.pickImage.mockImplementation(() => new Promise<string | null>((resolve) => { finish = resolve; }));
  mocks.assetImport.mockResolvedValue({ hash: "e".repeat(64), size: 20, name: "chip.png" });
  mocks.assetRead.mockResolvedValue(new ArrayBuffer(8));
  fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  store.setSelectedId(second!);
  finish("C:\\chip.png");
  await waitFor(() => expect(store.doc()!.components[0].imageHashes).toEqual(["e".repeat(64)]));
  expect(store.doc()!.components[1].imageHash).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  store.updateComponent(second!, { locked: true });
  finish("C:\\chip.png");
  await waitFor(() => expect(mocks.assetImport).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  expect(store.doc()!.components[1].imageHash).toBeUndefined();
  store.updateComponent(second!, { locked: false });
  fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  await store.openProject("C:\\other.pcbre");
  finish("C:\\chip.png");
  await Promise.resolve();
  expect(mocks.assetImport).toHaveBeenCalledTimes(2);
});

it("cancels browsing without importing and disables image actions in preview or while busy", async () => {
  const store = await makeStore(imageDoc(), "c1");
  const { unmount } = panel(store);
  let finish!: (path: string | null) => void;
  mocks.pickImage.mockImplementation(() => new Promise<string | null>((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  expect((screen.getByRole("button", { name: "Paste image" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
  expect(mocks.assetImportClipboardImage).not.toHaveBeenCalled();
  finish(null);
  await waitFor(() => expect((screen.getByRole("button", { name: "Browse…" }) as HTMLButtonElement).disabled).toBe(false));
  expect(mocks.assetImport).not.toHaveBeenCalled();
  unmount();
  mocks.isTauri.mockReturnValue(false);
  panel(store);
  expect((screen.getByRole("button", { name: "Browse…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Paste image" }) as HTMLButtonElement).disabled).toBe(true);
});

describe("board-picture inspector", () => {
  it("exposes rotate, mirror, and scale controls that write the board", async () => {
    const store = await makeStore(seededDoc());
    store.setBoardSelected(true);
    panel(store);
    expect(screen.getByText("Board picture selected - transform how it is displayed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rotate 90° CW" }));
    expect(store.doc()!.boards[0].rotation).toBe(90);
    fireEvent.click(screen.getByRole("button", { name: "Rotate 90° CW" }));
    expect(store.doc()!.boards[0].rotation).toBe(180);
    fireEvent.click(screen.getByRole("button", { name: "Rotate 90° CCW" }));
    expect(store.doc()!.boards[0].rotation).toBe(90);
    fireEvent.click(screen.getByRole("button", { name: "Mirror horizontal" }));
    expect(store.doc()!.boards[0].flipH).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Mirror vertical" }));
    expect(store.doc()!.boards[0].flipV).toBe(true);
    fireEvent.change(screen.getByLabelText("Scale %"), { target: { value: "150" } });
    expect(store.doc()!.boards[0].scale).toBe(150);
    // Original image dimensions are never rewritten by transforms.
    expect(store.doc()!.boards[0].width).toBe(1024);
    expect(store.doc()!.boards[0].height).toBe(768);
  });

  it("locking the picture disables every transform except unlocking", async () => {
    const store = await makeStore(seededDoc());
    store.setBoardSelected(true);
    panel(store);
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    const locked = screen.getByRole("button", { name: "Locked" }) as HTMLButtonElement;
    expect(locked.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Picture is locked - unlock to transform.")).toBeTruthy();
    for (const name of [
      "Rotate 90° CCW",
      "Rotate 90° CW",
      "Mirror horizontal",
      "Mirror vertical",
      "Rotate 0.1° counterclockwise",
      "Rotate 0.1° clockwise",
    ]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByLabelText("Scale %") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(locked);
    expect((screen.getByRole("button", { name: "Rotate 90° CW" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Rotate 0.1° clockwise" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("Scale %") as HTMLInputElement).disabled).toBe(false);
  });

  it("fine rotation steps 0.1° and wraps counterclockwise from zero", async () => {
    const store = await makeStore(seededDoc());
    store.setBoardSelected(true);
    panel(store);
    expect(screen.getByText("0°")).toBeTruthy();
    const plus = screen.getByRole("button", { name: "Rotate 0.1° clockwise" });
    for (let click = 0; click < 7; click++) fireEvent.click(plus);
    expect(store.doc()!.boards[0].rotation).toBe(0.7);
    expect(screen.getByText("0.7°")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rotate 0.1° counterclockwise" }));
    expect(store.doc()!.boards[0].rotation).toBe(0.6);
    // A quarter turn on top of a fine offset keeps the 0.1° remainder.
    fireEvent.click(screen.getByRole("button", { name: "Rotate 90° CW" }));
    expect(store.doc()!.boards[0].rotation).toBeCloseTo(90.6, 10);
    expect(screen.getByText("90.6°")).toBeTruthy();
  });

  it("renames the board from the header input and reverts an empty draft", async () => {
    const store = await makeStore(seededDoc());
    store.setBoardSelected(true);
    panel(store);
    const input = screen.getByLabelText("Board name") as HTMLInputElement;
    expect(input.value).toBe("Front");
    fireEvent.input(input, { target: { value: "  Top layer  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.doc()!.boards[0].name).toBe("Top layer");
    expect(input.value).toBe("Top layer");
    // Empty commits revert to the previous name instead of clearing it.
    fireEvent.input(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(store.doc()!.boards[0].name).toBe("Top layer");
    expect(input.value).toBe("Top layer");
    // Renaming stays allowed while the picture is locked.
    store.updateBoard("b1", { locked: true });
    expect((screen.getByLabelText("Board name") as HTMLInputElement).disabled).toBe(false);
    fireEvent.input(input, { target: { value: "Bottom" } });
    fireEvent.change(input);
    expect(store.doc()!.boards[0].name).toBe("Bottom");
  });

  it("renders Lock and Delete image after the transform fieldset", async () => {
    const store = await makeStore(seededDoc());
    store.setBoardSelected(true);
    panel(store);
    const fieldset = screen.getByRole("group", { name: "Board picture" });
    for (const name of ["Lock", "Delete image"]) {
      const button = screen.getByRole("button", { name });
      // The button follows the fieldset in document order.
      expect(fieldset.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("offers a Save action that triggers requestSave", async () => {
    const store = await makeStore(imageDoc(), "c1");
    panel(store);
    const requestSave = vi.spyOn(store, "requestSave");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(requestSave).toHaveBeenCalledTimes(1);
  });

  it("applies and cancels the pending crop from the inspector", async () => {
    const store = await makeStore(seededDoc());
    store.setBoardSelected(true);
    panel(store);
    expect(screen.getByText(/pick the Crop tool/i)).toBeTruthy();
    store.setCropDraft({ x: 10, y: 20, w: 100.4, h: 50 });
    expect(screen.getByRole("group", { name: "Pending crop" })).toBeTruthy();
    expect(screen.getByText(/100 × 50 px/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.cropDraft()).toBeNull();
    expect(store.doc()!.boards[0].crop).toBeUndefined();
    store.setCropDraft({ x: 10, y: 20, w: 100, h: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(store.doc()!.boards[0].crop).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(store.cropDraft()).toBeNull();
  });
});
