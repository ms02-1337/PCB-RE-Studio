import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import type { ProjectDoc } from "./projectDoc";
import { SEED_TYPES } from "./projectDoc";
import { createPlacementStore, type PlacementStore } from "./store";
import { COLOR_PALETTE } from "./color";
import { TypeManager } from "./TypeManager";

async function makeStore(): Promise<PlacementStore> {
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Fixtures",
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    types: SEED_TYPES.map((type) => ({ ...type })),
    boards: [{ id: "b1", name: "Front", assetHash: "a".repeat(64), width: 100, height: 100 }],
    components: [
      {
        id: "c1",
        boardId: "b1",
        refdes: "U1",
        typeId: "ic",
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
  await store.openProject("C:\\p.pcbre");
  return store;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("lists types with usage counts and marks Unassigned undeletable", async () => {
  const store = await makeStore();
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Manage component types" })).toBeTruthy();
  expect(screen.getAllByTitle("Rename this type").length).toBe(SEED_TYPES.length);
  const unassignedDelete = screen.getByTitle(
    "Unassigned is the built-in fallback type and cannot be deleted",
  ) as HTMLButtonElement;
  expect(unassignedDelete.disabled).toBe(true);
});

it("centers its overlay and shows an editable color swatch per type", async () => {
  const store = await makeStore();
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Manage component types" });
  expect(dialog.closest(".overlay")!.classList.contains("overlay--center")).toBe(true);
  // One native color input per row, seeded from the document. The
  // TypeCombobox keeps the .pl-chip-dot styling elsewhere.
  const swatches = dialog.querySelectorAll(".type-table input[type='color']");
  expect(swatches.length).toBe(SEED_TYPES.length);
  expect(dialog.querySelectorAll(".type-table .pl-chip-dot")).toHaveLength(0);
  for (const type of SEED_TYPES) {
    const swatch = screen.getByLabelText(`Color for ${type.name}`) as HTMLInputElement;
    expect(swatch.value).toBe(type.color);
  }
});

it("adds a type after validating the prefix", async () => {
  const store = await makeStore();
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  fireEvent.input(screen.getByLabelText("New type name"), { target: { value: "Relay" } });
  fireEvent.input(screen.getByLabelText("New type prefix"), { target: { value: "1K" } });
  fireEvent.click(screen.getByRole("button", { name: "Add type" }));
  expect(screen.getByText("Prefix must start with a letter and contain only letters and digits.")).toBeTruthy();

  fireEvent.input(screen.getByLabelText("New type prefix"), { target: { value: "R" } });
  fireEvent.click(screen.getByRole("button", { name: "Add type" }));
  expect(screen.getByText("Prefix R is already used by another type.")).toBeTruthy();

  fireEvent.input(screen.getByLabelText("New type prefix"), { target: { value: "K" } });
  fireEvent.click(screen.getByRole("button", { name: "Add type" }));
  const relay = store.doc()?.types.find((type) => type.name === "Relay");
  await waitFor(() => expect(relay).toBeTruthy());
  expect(relay!.prefix).toBe("K");
  // No picker: the type still gets a valid palette color automatically.
  expect(relay!.color).toMatch(/^#[0-9a-f]{6}$/);
  expect(COLOR_PALETTE).toContain(relay!.color);
}, 15000);

it("renames inline and commits color swatch changes as single undo entries", async () => {
  const store = await makeStore();
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  fireEvent.click(screen.getAllByTitle("Rename this type")[0]);
  const rename = screen.getByLabelText("Rename Resistor");
  fireEvent.input(rename, { target: { value: "Resistor network" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  expect(store.doc()?.types.find((type) => type.id === "resistor")?.name).toBe("Resistor network");

  // A committed pick writes updateType once; undo restores the prior color.
  const swatch = screen.getByLabelText("Color for Resistor network") as HTMLInputElement;
  fireEvent.change(swatch, { target: { value: "#123456" } });
  expect(store.doc()?.types.find((type) => type.id === "resistor")?.color).toBe("#123456");
  expect(store.canUndo()).toBe(true);
  store.undo();
  expect(store.doc()?.types.find((type) => type.id === "resistor")?.color).toBe("#e5484d");
});

it("Escape closes the modal and restores focus to the invoking element", async () => {
  const store = await makeStore();
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  store.setTypeManagerOpen(true);
  render(() => (
    <Show when={store.typeManagerOpen()}>
      <TypeManager store={store} onClose={() => store.setTypeManagerOpen(false)} />
    </Show>
  ));
  const dialog = screen.getByRole("dialog", { name: "Manage component types" });
  // Focus moved into the modal on open (first form field).
  expect(document.activeElement).toBe(screen.getByLabelText("New type name"));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(store.typeManagerOpen()).toBe(false);
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it("Escape during an inline rename cancels the rename without closing the modal", async () => {
  const store = await makeStore();
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  fireEvent.click(screen.getAllByTitle("Rename this type")[0]);
  const rename = screen.getByLabelText("Rename Resistor");
  fireEvent.keyDown(rename, { key: "Escape" });
  await waitFor(() => expect(screen.queryByLabelText("Rename Resistor")).toBeNull());
  expect(screen.getByRole("dialog", { name: "Manage component types" })).toBeTruthy();
  expect(store.doc()?.types.find((type) => type.id === "resistor")?.name).toBe("Resistor");
});

it("blocks deleting a type that components still use", async () => {
  const store = await makeStore();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  const icDelete = screen.getAllByRole("button", { name: "Delete" }).find(
    (button) => button.closest("tr")?.textContent?.includes("IC"),
  )! as HTMLButtonElement;
  expect(icDelete.disabled).toBe(true);
  expect(icDelete.title).toBe("Type 'IC' is used by 1 component and cannot be deleted");
  fireEvent.click(icDelete);
  expect(confirm).not.toHaveBeenCalled();
  // The type and its component's assignment survive untouched.
  expect(store.doc()?.types.find((type) => type.id === "ic")).toBeTruthy();
  expect(store.doc()?.components[0].typeId).toBe("ic");
});

it("deletes an unused type after confirming and keeps it on cancel", async () => {
  const store = await makeStore();
  const confirm = vi.spyOn(window, "confirm");
  confirm.mockReturnValue(true);
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).find(
    (button) => button.closest("tr")?.textContent?.includes("Resistor"),
  )!);
  expect(confirm).toHaveBeenCalledWith("Delete type 'Resistor'?");
  expect(store.doc()?.types.find((type) => type.id === "resistor")).toBeUndefined();
  confirm.mockReturnValue(false);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).find(
    (button) => button.closest("tr")?.textContent?.includes("Capacitor"),
  )!);
  expect(confirm).toHaveBeenCalledWith("Delete type 'Capacitor'?");
  expect(store.doc()?.types.find((type) => type.id === "capacitor")).toBeTruthy();
});
