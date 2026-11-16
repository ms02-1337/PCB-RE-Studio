import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import type { ProjectDoc } from "./projectDoc";
import { SEED_TYPES, UNASSIGNED_TYPE_ID } from "./projectDoc";
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

it("centers its overlay and shows read-only color dots instead of pickers", async () => {
  const store = await makeStore();
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Manage component types" });
  expect(dialog.closest(".overlay")!.classList.contains("overlay--center")).toBe(true);
  // No color/hex inputs anywhere: colors are display-only now.
  expect(screen.queryByLabelText(/color for /i)).toBeNull();
  expect(screen.queryByLabelText(/hex color for /i)).toBeNull();
  expect(screen.queryByLabelText("New type color")).toBeNull();
  const dots = dialog.querySelectorAll(".type-table .pl-chip-dot");
  expect(dots.length).toBe(SEED_TYPES.length);
  expect((dots[0] as HTMLElement).title).toMatch(/^#[0-9a-f]{6}$/);
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

it("renames inline; the color column stays read-only", async () => {
  const store = await makeStore();
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  fireEvent.click(screen.getAllByTitle("Rename this type")[0]);
  const rename = screen.getByLabelText("Rename Resistor");
  fireEvent.input(rename, { target: { value: "Resistor network" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  expect(store.doc()?.types.find((type) => type.id === "resistor")?.name).toBe("Resistor network");

  // The former hex-input path is gone: editing colors happens elsewhere.
  expect(screen.queryByLabelText("Hex color for Resistor network")).toBeNull();
  expect(store.doc()?.types.find((type) => type.id === "resistor")?.color).toBe(
    SEED_TYPES.find((type) => type.id === "resistor")!.color,
  );
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

it("deletes a used type after confirming reassignment to Unassigned", async () => {
  const store = await makeStore();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).find(
    (button) => button.closest("tr")?.textContent?.includes("IC"),
  )!);
  expect(confirm).toHaveBeenCalledWith("1 component will be reassigned to Unassigned. Delete type 'IC'?");
  await waitFor(() => expect(store.doc()?.types.find((type) => type.id === "ic")).toBeUndefined());
  expect(store.doc()?.components[0].typeId).toBe(UNASSIGNED_TYPE_ID);
});

it("keeps a used type when the user cancels", async () => {
  const store = await makeStore();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(() => <TypeManager store={store} onClose={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).find(
    (button) => button.closest("tr")?.textContent?.includes("IC"),
  )!);
  expect(store.doc()?.types.find((type) => type.id === "ic")).toBeTruthy();
  expect(store.doc()?.components[0].typeId).toBe("ic");
});
