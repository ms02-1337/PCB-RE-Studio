import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { NetsPanel } from "./NetsPanel";
import type { VisualPcb } from "./model";

describe("NetsPanel", () => {
  let store: ReturnType<typeof createPlacementStore>;
  let navigateCalls = 0;
  const onNavigate = () => {
    navigateCalls++;
  };

  beforeEach(async () => {
    sessionStorage.clear();
    navigateCalls = 0;

    const pcb1: VisualPcb = {
      id: "pcb-1",
      name: "Main Board",
      layers: ["top", "bottom"],
      pxPerMm: 2,
      images: [],
      nets: [
        { id: "net-gnd", name: "GND", color: "#0000ff" },
        { id: "net-vcc", name: "VCC_3V3", color: "#ff0000" },
      ],
      components: [
        {
          id: "comp-1",
          reference: "U1",
          value: "MCU",
          partName: "STM32",
          x: 0,
          y: 0,
          layerId: "top",
          rotation: 0,
          scale: 1,
          definition: {
            id: "def-1",
            name: "QFP",
            partName: "",
            value: "",
            referencePrefix: "U",
            footprint: {
              id: "fp",
              name: "fp",
              source: "test",
              raw: "",
              pads: [],
              graphics: [],
              diagnostics: [],
            },
            pinMap: {},
          },
          terminals: [
            {
              number: "1",
              netId: "net-gnd",
              comment: "GND pin",
            },
            {
              number: "2",
              netId: "net-vcc",
            },
          ],
        },
      ],
      traces: [
        {
          id: "tr-1",
          layerId: "top",
          netId: "net-gnd",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          width: 0.5,
          comment: "Main ground feed",
        },
      ],
      vias: [
        {
          id: "via-1",
          netId: "net-gnd",
          x: 5,
          y: 5,
          diameter: 1.0,
          drill: 0.5,
        },
      ],
      zones: [
        {
          id: "zn-1",
          layerId: "bottom",
          netId: "net-vcc",
          points: [
            { x: 0, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 20 },
            { x: 0, y: 20 },
          ],
        },
      ],
    };

    const pcb2: VisualPcb = {
      id: "pcb-2",
      name: "Daughter Card",
      layers: ["top"],
      images: [],
      nets: [{ id: "net-sub", name: "CLK_OUT", color: "#00ff00" }],
      traces: [],
      vias: [],
      zones: [],
    };

    const doc: ProjectDoc = {
      schemaVersion: 1,
      name: "Nets Test",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      types: SEED_TYPES,
      boards: [],
      components: [],
      visualEditor: {
        pcbs: [pcb1, pcb2],
        activePcbId: "pcb-1",
      },
      assets: {},
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

  it("renders the header with PCB dropdown, title, count, and search/create toolbar", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    expect(screen.getByRole("heading", { name: "PCB nets" })).toBeDefined();
    expect(document.querySelector(".ve-nets-title-separator")).toBeTruthy();
    expect(screen.getByText(/2\s+nets/)).toBeDefined();

    const pcbSelect = screen.getByRole("combobox", {
      name: "Select PCB",
    }) as HTMLSelectElement;
    expect(pcbSelect.value).toBe("pcb-1");
    expect(screen.getByRole("option", { name: "Main Board" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Daughter Card" })).toBeDefined();

    expect(
      screen.getByRole("searchbox", { name: "Search nets" }),
    ).toBeDefined();
    expect(screen.getByPlaceholderText("New net name…")).toBeDefined();
    expect(screen.getByRole("button", { name: /Create net/i })).toBeDefined();
  });

  it("switches PCB via the header dropdown", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    const pcbSelect = screen.getByRole("combobox", {
      name: "Select PCB",
    }) as HTMLSelectElement;
    fireEvent.change(pcbSelect, { target: { value: "pcb-2" } });

    expect(store.visual.activePcb()?.id).toBe("pcb-2");
    expect(screen.getByText(/1\s+nets/)).toBeDefined();
    expect(screen.getByRole("button", { name: /CLK_OUT/i })).toBeDefined();
  });

  it("filters nets using the search input", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    expect(
      screen.getByRole("button", { name: /View elements in GND/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /View elements in VCC_3V3/i }),
    ).toBeDefined();

    const searchInput = screen.getByRole("searchbox", {
      name: "Search nets",
    }) as HTMLInputElement;
    searchInput.value = "vcc";
    fireEvent.input(searchInput);

    expect(
      screen.queryByRole("button", { name: /View elements in GND/i }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /View elements in VCC_3V3/i }),
    ).toBeDefined();
  });

  it("creates a new net and clears the input", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    const input = screen.getByPlaceholderText(
      "New net name…",
    ) as HTMLInputElement;
    const addBtn = screen.getByRole("button", { name: /Create net/i });

    input.value = "RESET_N";
    fireEvent.input(input);
    expect(addBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(addBtn);

    expect(
      screen.getByRole("button", { name: /View elements in RESET_N/i }),
    ).toBeDefined();
    expect(
      (store.visual.activePcb()?.nets ?? []).some((n) => n.name === "RESET_N"),
    ).toBe(true);
    expect(input.value).toBe("");
  });

  it("renders the nets table with proper columns and member counts", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    // Check table headers
    expect(screen.getByText("Color")).toBeDefined();
    expect(screen.getByText("Net name")).toBeDefined();
    expect(screen.getByText("Pads")).toBeDefined();
    expect(screen.getByText("Vias")).toBeDefined();
    expect(screen.getByText("Traces")).toBeDefined();
    expect(screen.getByText("Zones")).toBeDefined();
    expect(screen.getByText("Merge into")).toBeDefined();
    expect(screen.getByText("Actions")).toBeDefined();

    // GND has: 1 pad (U1 pin 1), 1 via (via-1), 1 trace (tr-1), 0 zones
    const gndRow = screen
      .getByRole("button", { name: /View elements in GND/i })
      .closest("tr")!;
    expect(gndRow).toBeDefined();

    const countCells = gndRow.querySelectorAll("td");
    // Column 0: Color, 1: Net name, 2: Pads, 3: Vias, 4: Traces, 5: Zones
    expect(countCells[2]?.textContent).toBe("1");
    expect(countCells[3]?.textContent).toBe("1");
    expect(countCells[4]?.textContent).toBe("1");
    expect(countCells[5]?.textContent).toBe("0");
  });

  it("opens the elements modal when clicking a net name", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    const gndButton = screen.getByRole("button", {
      name: /View elements in GND/i,
    });
    fireEvent.click(gndButton);

    // Modal dialog should be visible
    expect(
      screen.getByRole("dialog", { name: "Elements in net GND" }),
    ).toBeDefined();
    expect(screen.getByText(/Trace tr-1/)).toBeDefined();
    expect(screen.getByText(/Via via-1/)).toBeDefined();
    expect(screen.getByText(/U1 pin 1/)).toBeDefined();
  });

  it("reports via diameters in millimeters through the PCB calibration", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    fireEvent.click(
      screen.getByRole("button", { name: /View elements in GND/i }),
    );

    // Via diameters are stored in world pixels (1.0 px here); with the PCB
    // calibrated at 2 px/mm the listed size must be 0.50 mm, not "1.00mm"
    // mislabeled as millimeters.
    expect(screen.getByText(/Via via-1 \(Ø 0\.50mm\)/)).toBeDefined();
  });

  it("allows editing comments in the modal and persists changes", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    fireEvent.click(
      screen.getByRole("button", { name: /View elements in GND/i }),
    );

    // Find the comment input for the trace (existing comment: "Main ground feed")
    const traceCommentInput = screen.getByDisplayValue(
      "Main ground feed",
    ) as HTMLInputElement;
    fireEvent.change(traceCommentInput, {
      target: { value: "Updated ground return line" },
    });

    // Verify trace in store was updated
    const trace = store.visual.activePcb()?.traces?.find((t) => t.id === "tr-1");
    expect(trace?.comment).toBe("Updated ground return line");

    // Add comment to via
    const viaCommentInput = screen.getByRole("textbox", {
      name: /Comment for Via via-1/i,
    }) as HTMLInputElement;
    fireEvent.change(viaCommentInput, { target: { value: "Thermal via" } });
    const via = store.visual.activePcb()?.vias?.find((v) => v.id === "via-1");
    expect(via?.comment).toBe("Thermal via");

    // Add comment to pad
    const padCommentInput = screen.getByRole("textbox", {
      name: /Comment for U1 pin 1/i,
    }) as HTMLInputElement;
    fireEvent.change(padCommentInput, {
      target: { value: "Chassis GND pin" },
    });
    const comp = store.visual
      .activePcb()
      ?.components?.find((c) => c.id === "comp-1");
    const term = comp?.terminals?.find((t) => t.number === "1");
    expect(term?.comment).toBe("Chassis GND pin");
  });

  it("navigates to the editor and sets session storage when clicking Show in editor", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    fireEvent.click(
      screen.getByRole("button", { name: /View elements in GND/i }),
    );

    // Click "Show in editor →" on trace tr-1
    const showBtns = screen.getAllByRole("button", {
      name: /Show in editor/i,
    });
    fireEvent.click(showBtns[0]);

    expect(navigateCalls).toBe(1);
    const nav = sessionStorage.getItem("visual-net-navigation");
    expect(nav).not.toBeNull();
    const parsed = JSON.parse(nav!);
    expect(parsed.netId).toBe("net-gnd");
  });

  it("closes the modal on clicking Close button or pressing Escape", () => {
    render(() => <NetsPanel store={store} onNavigate={onNavigate} />);

    fireEvent.click(
      screen.getByRole("button", { name: /View elements in GND/i }),
    );
    expect(
      screen.getByRole("dialog", { name: "Elements in net GND" }),
    ).toBeDefined();

    // Click close button
    const closeBtn = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeBtn);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Open again and close with Escape
    fireEvent.click(
      screen.getByRole("button", { name: /View elements in GND/i }),
    );
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
