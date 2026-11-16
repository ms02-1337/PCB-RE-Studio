import { it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import type { ProjectDoc } from "./projectDoc";
import { SEED_TYPES } from "./projectDoc";
import { createPlacementStore, type PlacementStore } from "./store";
import { TypeCombobox } from "./TypeCombobox";

function seededDoc(): ProjectDoc {
  return {
    schemaVersion: 1,
    name: "Fixtures",
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    types: SEED_TYPES.map((type) => ({ ...type })),
    boards: [],
    components: [],
    assets: {},
  };
}

async function makeStore(): Promise<PlacementStore> {
  const doc = seededDoc();
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

/** Renders the combobox wired to the store's draw-type signal, like the
 * placement header does. */
function renderCombobox(store: PlacementStore, disabled = false) {
  return render(() => (
    <TypeCombobox
      store={store}
      label="Type"
      value={store.drawTypeId()}
      disabled={disabled}
      onChange={(id) => store.setDrawTypeId(id)}
    />
  ));
}

const optionByLabel = (name: string) => screen.getByText(name).closest("li")!;

beforeEach(() => {
  vi.restoreAllMocks();
});

it("shows the selected type and opens the full list on click", async () => {
  const store = await makeStore();
  renderCombobox(store);
  const input = screen.getByRole("combobox", { name: "Type" }) as HTMLInputElement;
  expect(input.value).toBe("Unassigned");
  expect(input.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(input);
  expect(input.getAttribute("aria-expanded")).toBe("true");
  const listbox = screen.getByRole("listbox", { name: "Type" });
  expect(input.getAttribute("aria-controls")).toBe(listbox.id);
  expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(10);
  // The selected type is marked and starts active.
  expect(optionByLabel("Unassigned").getAttribute("aria-selected")).toBe("true");
  expect(optionByLabel("Unassigned").getAttribute("data-active")).toBe("true");
});

it("filters case-insensitively on name and prefix", async () => {
  const store = await makeStore();
  renderCombobox(store);
  const input = screen.getByRole("combobox", { name: "Type" });
  fireEvent.click(input);
  fireEvent.input(input, { target: { value: "CAP" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByText("Capacitor")).toBeTruthy();

  fireEvent.input(input, { target: { value: "tp" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByText("Test point")).toBeTruthy();

  fireEvent.input(input, { target: { value: "zzz" } });
  expect(screen.queryByRole("option")).toBeNull();
  expect(screen.getByText("No matching type")).toBeTruthy();
});

it("arrow keys move the active option and Enter commits it", async () => {
  const store = await makeStore();
  renderCombobox(store);
  const input = screen.getByRole("combobox", { name: "Type" });
  fireEvent.click(input);
  // Unassigned (last seed) is active; ArrowDown wraps to the first type.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(
    `${input.getAttribute("aria-controls")}-opt-resistor`,
  );
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(
    `${input.getAttribute("aria-controls")}-opt-capacitor`,
  );
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(store.drawTypeId()).toBe("resistor");
  // Committed and closed: the input reverts to the selected type's name.
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect((input as HTMLInputElement).value).toBe("Resistor");
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("Escape reverts and closes; Tab closes without changing the value", async () => {
  const store = await makeStore();
  renderCombobox(store);
  const input = screen.getByRole("combobox", { name: "Type" }) as HTMLInputElement;
  fireEvent.click(input);
  fireEvent.input(input, { target: { value: "cap" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(input.value).toBe("Unassigned");
  expect(store.drawTypeId()).toBe("unassigned");

  fireEvent.click(input);
  expect(input.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
});

it("Enter prefers an exact name match over the active option", async () => {
  const doc = seededDoc();
  // "IC holder" sorts before the real "IC" in doc order, so the ACTIVE option
  // is IC holder while the exact name match is IC.
  doc.types = [
    { id: "holder", name: "IC holder", color: "#123456", prefix: "Z" },
    ...doc.types,
  ];
  const store = createPlacementStore({
    openProject: vi.fn(async () => ({ doc, assets: {}, path: "C:\\p.pcbre" })),
    save: vi.fn(async () => ({ path: "C:\\p.pcbre", bytes: 1, blobCount: 0, savedAt: "t" })),
    saveAs: vi.fn(),
    newProject: vi.fn(),
    close: vi.fn(async () => null),
  });
  await store.openProject("C:\\p.pcbre");
  renderCombobox(store);
  const input = screen.getByRole("combobox", { name: "Type" });
  fireEvent.click(input);
  fireEvent.input(input, { target: { value: "ic" } });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(optionByLabel("IC holder").getAttribute("data-active")).toBe("true");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(store.drawTypeId()).toBe("ic");
});

it("clicking an option commits it", async () => {
  const store = await makeStore();
  renderCombobox(store);
  fireEvent.click(screen.getByRole("combobox", { name: "Type" }));
  fireEvent.click(screen.getByText("Transistor"));
  expect(store.drawTypeId()).toBe("transistor");
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("+ opens a create-type modal prefilled from the filter text", async () => {
  const store = await makeStore();
  renderCombobox(store);
  const input = screen.getByRole("combobox", { name: "Type" });
  fireEvent.click(input);
  fireEvent.input(input, { target: { value: "rel" } });
  fireEvent.click(screen.getByRole("button", { name: "Add a new component type for Type" }));

  const dialog = screen.getByRole("dialog", { name: "Create component type" });
  expect((screen.getByLabelText("New type name") as HTMLInputElement).value).toBe("rel");
  // The suggested prefix comes from the name; Relay's "R" collides with a seed.
  expect((screen.getByLabelText("New type prefix") as HTMLInputElement).value).toBe("R");
  // No color/hex inputs anymore: the random default color is silent.
  expect(screen.queryByLabelText("New type color")).toBeNull();
  expect(screen.queryByLabelText("New type hex color")).toBeNull();
  // The create modal uses the centered overlay variant.
  expect(dialog.closest(".overlay")!.classList.contains("overlay--center")).toBe(true);

  // A taken prefix is rejected with the TypeManager validation message.
  fireEvent.click(screen.getByRole("button", { name: "Add type" }));
  expect(screen.getByRole("status").textContent).toContain(
    "Prefix R is already used by another type",
  );
  expect(store.doc()?.types).toHaveLength(10);

  // A unique prefix confirms: Enter adds the type and selects it.
  fireEvent.input(screen.getByLabelText("New type name"), { target: { value: "Relay" } });
  fireEvent.input(screen.getByLabelText("New type prefix"), { target: { value: "K" } });
  fireEvent.keyDown(dialog, { key: "Enter" });
  const relay = store.doc()?.types.find((type) => type.name === "Relay");
  expect(relay).toMatchObject({ prefix: "K" });
  expect(relay?.color).toMatch(/^#[0-9a-f]{6}$/);
  expect(store.drawTypeId()).toBe(relay?.id);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect((screen.getByRole("combobox", { name: "Type" }) as HTMLInputElement).value).toBe("Relay");
});

it("Escape cancels the create-type modal without adding", async () => {
  const store = await makeStore();
  renderCombobox(store);
  fireEvent.click(screen.getByRole("button", { name: "Add a new component type for Type" }));
  fireEvent.input(screen.getByLabelText("New type name"), { target: { value: "Relay" } });
  fireEvent.input(screen.getByLabelText("New type prefix"), { target: { value: "K" } });
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Create component type" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(store.doc()?.types).toHaveLength(10);
  expect(store.drawTypeId()).toBe("unassigned");
});

it("disables the input and the add button together", async () => {
  const store = await makeStore();
  renderCombobox(store, true);
  expect(
    (screen.getByRole("combobox", { name: "Type" }) as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Add a new component type for Type" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("keeps the closed input in sync when the selection changes elsewhere", async () => {
  const store = await makeStore();
  renderCombobox(store);
  const input = screen.getByRole("combobox", { name: "Type" }) as HTMLInputElement;
  store.setDrawTypeId("diode");
  await Promise.resolve();
  expect(input.value).toBe("Diode");
});
