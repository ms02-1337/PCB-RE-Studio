import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { BomPanel } from "./BomPanel";
import type { ElectricalComponent } from "./model";

let store: ReturnType<typeof createPlacementStore>;

const makeComponent = (id: string, ref: string, value: string, footprint = "R_0805", symbol = "Device:R"): ElectricalComponent => ({
  id,
  reference: ref,
  value,
  partName: "RES-10K",
  layerId: "front",
  x: 0,
  y: 0,
  rotation: 0,
  scale: 1,
  terminals: [
    { number: "1" },
    { number: "2" },
  ],
  definition: {
    id: "def-" + id,
    name: "Def " + id,
    partName: "RES-10K",
    value,
    referencePrefix: "R",
    pinMap: { "1": "1", "2": "2" },
    footprint: {
      id: "fp-" + id,
      name: footprint,
      source: "",
      raw: "",
      graphics: [],
      diagnostics: [],
      pads: [],
    },
    symbol: {
      id: "sym-" + id,
      name: symbol,
      reference: "R",
      source: "",
      raw: "",
      diagnostics: [],
      units: [],
    },
  },
});

beforeEach(async () => {
  const c1 = makeComponent("c1", "R1", "10k");
  const c2 = makeComponent("c2", "R2", "10k");
  const c3 = makeComponent("c3", "R3", "10k");

  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Test Project",
    createdAt: "t",
    updatedAt: "t",
    types: SEED_TYPES,
    boards: [],
    components: [],
    assets: {},
    visualEditor: {
      activePcbId: "pcb-1",
      pcbs: [
        {
          id: "pcb-1",
          name: "Main Board",
          layers: ["front", "back"],
          pxPerMm: 10,
          images: [],
          components: [c1, c2, c3],
          nets: [],
        },
      ],
    },
  };

  store = createPlacementStore({
    openProject: async () => ({ doc, assets: {}, path: "test.pcbre" }),
    save: vi.fn(),
  });
  await store.openProject("test.pcbre");
});

afterEach(() => {
  store.dispose();
});

it("renders BOM table with standardized columns, symbol column, and references button", () => {
  render(() => <BomPanel store={store} />);

  expect(screen.getByRole("heading", { name: "Bill of materials" })).toBeTruthy();
  expect(document.querySelector(".electrical-separator")).toBeTruthy();
  expect(screen.getByLabelText("Search BOM")).toBeTruthy();
  expect(screen.getByText("ID")).toBeTruthy();
  expect(screen.getByText("Quantity")).toBeTruthy();
  expect(screen.getByText("Value")).toBeTruthy();
  expect(screen.getByText("Footprint")).toBeTruthy();
  expect(screen.getByText("Symbol")).toBeTruthy();
  expect(screen.getByText("Part name")).toBeTruthy();
  expect(screen.getByText("References")).toBeTruthy();

  // References column button
  const refBtn = screen.getByRole("button", { name: /references \/ replace for row 1/i });
  expect(refBtn).toBeTruthy();
});

it("opens references modal, lists all references with edit and locate, and replaces footprint/symbol", async () => {
  const onNavigate = vi.fn();
  const onReplace = vi.fn();

  render(() => (
    <BomPanel store={store} onNavigate={onNavigate} onReplace={onReplace} />
  ));

  // Open modal from row references button
  const refBtn = screen.getByRole("button", { name: /references \/ replace for row 1/i });
  fireEvent.click(refBtn);

  // Modal dialog is displayed
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeTruthy();
  expect(screen.getByText(/References — 10k · Device:R \(3\)/)).toBeTruthy();

  // All 3 references are listed in the table
  expect(screen.getByLabelText("Reference R1")).toBeTruthy();
  expect(screen.getByLabelText("Reference R2")).toBeTruthy();
  expect(screen.getByLabelText("Reference R3")).toBeTruthy();

  // Edit reference R1 to R100
  const r1Input = screen.getByLabelText("Reference R1");
  fireEvent.change(r1Input, { target: { value: "R100" } });
  expect(store.visual.activePcb()!.components!.find((c) => c.id === "c1")!.reference).toBe("R100");

  // Locate button calls onNavigate (R100 sorted after R2, R3)
  const locateBtns = screen.getAllByRole("button", { name: "Locate" });
  expect(locateBtns).toHaveLength(3);
  fireEvent.click(locateBtns[2]);
  expect(onNavigate).toHaveBeenCalledWith("c1");
  // Locating closes the modal
  expect(screen.queryByRole("dialog")).toBeNull();

  // Re-open modal
  fireEvent.click(screen.getByRole("button", { name: /references \/ replace for row 1/i }));
  expect(screen.getByRole("dialog")).toBeTruthy();

  // Uncheck R100
  const r100Check = screen.getByLabelText("Select R100") as HTMLInputElement;
  fireEvent.click(r100Check);

  // Click Replace footprint / symbol button
  const replaceBtn = screen.getByRole("button", { name: /replace footprint \/ symbol… \(2 selected\)/i });
  fireEvent.click(replaceBtn);

  expect(onReplace).toHaveBeenCalledWith(["c2", "c3"]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("closes modal on Close button click and Escape key", () => {
  render(() => <BomPanel store={store} />);

  fireEvent.click(screen.getByRole("button", { name: /references \/ replace for row 1/i }));
  expect(screen.getByRole("dialog")).toBeTruthy();

  // Close via Close button
  const closeBtn = screen.getByRole("button", { name: "Close" });
  fireEvent.click(closeBtn);
  expect(screen.queryByRole("dialog")).toBeNull();

  // Open again and close via Escape
  fireEvent.click(screen.getByRole("button", { name: /references \/ replace for row 1/i }));
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("displays Value and Part name as text by default and enables input on click", async () => {
  render(() => <BomPanel store={store} />);

  // Headers have the centered column classes
  const qtyTh = screen.getByRole("columnheader", { name: "Quantity" });
  const valTh = screen.getByRole("columnheader", { name: "Value" });
  const partTh = screen.getByRole("columnheader", { name: "Part name" });
  expect(qtyTh.classList.contains("bom-col-qty")).toBe(true);
  expect(valTh.classList.contains("bom-col-val")).toBe(true);
  expect(partTh.classList.contains("bom-col-part")).toBe(true);

  // By default, no text input is rendered for Value and Part name
  expect(screen.queryByRole("textbox", { name: "Value for row 1" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Part name for row 1" })).toBeNull();

  // Plain text buttons with cursor/title are rendered
  const valBtn = screen.getByRole("button", { name: "Value for row 1" });
  expect(valBtn.textContent).toBe("10k");
  expect(valBtn.classList.contains("bom-editable-text")).toBe(true);

  const partBtn = screen.getByRole("button", { name: "Part name for row 1" });
  expect(partBtn.textContent).toBe("RES-10K");
  expect(partBtn.classList.contains("bom-editable-text")).toBe(true);

  // Clicking Value enters edit mode
  fireEvent.click(valBtn);
  const valInput = screen.getByRole("textbox", { name: "Value for row 1" }) as HTMLInputElement;
  expect(valInput).toBeTruthy();
  expect(valInput.value).toBe("10k");

  // Editing and pressing Enter commits
  fireEvent.input(valInput, { target: { value: "22k" } });
  fireEvent.keyDown(valInput, { key: "Enter" });

  // Exits edit mode and updates all components in the group
  expect(screen.queryByRole("textbox", { name: "Value for row 1" })).toBeNull();
  expect(screen.getByRole("button", { name: "Value for row 1" }).textContent).toBe("22k");
  const comps = store.visual.activePcb()!.components!;
  expect(comps.every((c) => c.value === "22k")).toBe(true);

  // Clicking Part name, modifying, then pressing Escape cancels edit mode
  const newPartBtn = screen.getByRole("button", { name: "Part name for row 1" });
  fireEvent.click(newPartBtn);
  const partInput = screen.getByRole("textbox", { name: "Part name for row 1" }) as HTMLInputElement;
  expect(partInput).toBeTruthy();
  fireEvent.input(partInput, { target: { value: "RES-CHANGED" } });
  fireEvent.keyDown(partInput, { key: "Escape" });

  expect(screen.queryByRole("textbox", { name: "Part name for row 1" })).toBeNull();
  expect(screen.getByRole("button", { name: "Part name for row 1" }).textContent).toBe("RES-10K");
  expect(comps.every((c) => c.partName === "RES-10K")).toBe(true);
});

it("supports keyboard activation, commit on blur, and placeholder for empty values", async () => {
  render(() => <BomPanel store={store} />);

  const partBtn = screen.getByRole("button", { name: "Part name for row 1" });
  fireEvent.keyDown(partBtn, { key: "Enter" });

  const partInput = screen.getByRole("textbox", { name: "Part name for row 1" }) as HTMLInputElement;
  expect(partInput).toBeTruthy();

  // Clear value and blur to commit empty string
  fireEvent.input(partInput, { target: { value: "" } });
  fireEvent.blur(partInput);

  expect(screen.queryByRole("textbox", { name: "Part name for row 1" })).toBeNull();
  const updatedBtn = screen.getByRole("button", { name: "Part name for row 1" });
  expect(updatedBtn.textContent).toBe("—");
  expect(updatedBtn.querySelector(".bom-editable-placeholder")).toBeTruthy();
});
