import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { NetsSidebar } from "./NetsSidebar";
import type { CopperEditor } from "./CopperEditor";
import type { VisualPcb } from "./model";

describe("NetsSidebar", () => {
  let store: ReturnType<typeof createPlacementStore>;
  const locate = vi.fn();
  const onFocus = vi.fn();
  const copper = { locate } as unknown as CopperEditor;

  beforeEach(async () => {
    sessionStorage.clear();
    locate.mockClear();
    onFocus.mockClear();

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
            { number: "1", netId: "net-gnd", comment: "GND pin" },
            { number: "2", netId: "net-vcc" },
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

    const doc: ProjectDoc = {
      schemaVersion: 1,
      name: "Nets Sidebar Test",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      types: SEED_TYPES,
      boards: [],
      components: [],
      visualEditor: { pcbs: [pcb1], activePcbId: "pcb-1" },
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

  it("starts collapsed, expands into a searchable table, and collapses again", () => {
    render(() => (
      <NetsSidebar store={store} copper={copper} onFocus={onFocus} />
    ));

    const toggle = screen.getByRole("button", { name: "Nets (2)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.click(toggle);
    const section = screen.getByRole("region", { name: "Nets" });
    expect(section).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    const table = screen.getByRole("table", { name: "Nets list" });
    expect(table).toBeTruthy();
    // GND: 1 pad + 1 trace + 1 via; VCC: 1 pad + 1 zone
    expect(screen.getByRole("button", { name: "View elements in GND" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View elements in VCC_3V3" })).toBeTruthy();
    const gndRow = screen
      .getByRole("button", { name: "View elements in GND" })
      .closest("tr")!;
    expect(gndRow.querySelectorAll("td")[2]?.textContent).toBe("3");
    const vccRow = screen
      .getByRole("button", { name: "View elements in VCC_3V3" })
      .closest("tr")!;
    expect(vccRow.querySelectorAll("td")[2]?.textContent).toBe("2");
    expect(gndRow.querySelectorAll("td")[2]?.getAttribute("title")).toContain("1 pads");

    fireEvent.click(screen.getByRole("button", { name: "Collapse nets" }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Nets (2)" })).toBeTruthy();
  });

  it("filters nets by name as the user types", () => {
    render(() => (
      <NetsSidebar store={store} copper={copper} onFocus={onFocus} />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Nets (2)" }));

    const filter = screen.getByRole("searchbox", { name: "Filter nets" });
    fireEvent.input(filter, { target: { value: "gnd" } });
    expect(screen.getByRole("button", { name: "View elements in GND" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "View elements in VCC_3V3" }),
    ).toBeNull();

    fireEvent.input(filter, { target: { value: "zzz" } });
    expect(screen.getByText("No nets match your filter.")).toBeTruthy();
  });

  it("resizes by keyboard within bounds", () => {
    render(() => (
      <NetsSidebar store={store} copper={copper} onFocus={onFocus} />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Nets (2)" }));

    const resizer = screen.getByRole("separator", {
      name: "Resize nets section",
    });
    expect(resizer.getAttribute("aria-valuemin")).toBe("140");
    expect(resizer.getAttribute("aria-valuemax")).toBe("480");
    expect(resizer.getAttribute("aria-valuenow")).toBe("220");

    fireEvent.keyDown(resizer, { key: "ArrowUp" });
    expect(Number(resizer.getAttribute("aria-valuenow"))).toBe(236);
    fireEvent.keyDown(resizer, { key: "Home" });
    expect(resizer.getAttribute("aria-valuenow")).toBe("140");
    fireEvent.keyDown(resizer, { key: "End" });
    expect(resizer.getAttribute("aria-valuenow")).toBe("480");
  });

  it("opens the elements modal and locating an element selects, highlights and focuses it", async () => {
    render(() => (
      <NetsSidebar store={store} copper={copper} onFocus={onFocus} />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Nets (2)" }));

    const anchor = screen.getByRole("button", { name: "View elements in GND" });
    fireEvent.click(anchor);
    expect(
      screen.getByRole("dialog", { name: "Elements in net GND" }),
    ).toBeTruthy();
    expect(screen.getByText(/U1 pin 1/)).toBeTruthy();
    expect(screen.getByText(/Trace tr-1/)).toBeTruthy();
    expect(screen.getByText(/Via via-1/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /Show in editor/i })[0]);
    expect(locate).toHaveBeenCalledWith("comp-1", "net-gnd", "top");
    expect(onFocus).toHaveBeenCalledTimes(1);
    const box = onFocus.mock.calls[0][0];
    expect(box.left).toBeLessThanOrEqual(box.right);
    expect(box.top).toBeLessThanOrEqual(box.bottom);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Focus returns to the invoking net row (restored in a microtask).
    await Promise.resolve();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "View elements in GND" }),
    );
  });

  it("switching the active PCB closes the open modal", () => {
    const pcb1 = store.visual.activePcb()!;
    const doc = store.doc()!;
    const pcb2: VisualPcb = {
      id: "pcb-2",
      name: "Daughter Card",
      layers: ["top"],
      images: [],
      nets: [{ id: "net-sub", name: "CLK_OUT", color: "#00ff00" }],
    };
    doc.visualEditor = {
      pcbs: [pcb1, pcb2],
      activePcbId: "pcb-1",
    };
    store.visual.replaceCopper(pcb1.id, structuredClone(pcb1));

    render(() => (
      <NetsSidebar store={store} copper={copper} onFocus={onFocus} />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Nets (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "View elements in GND" }));
    expect(screen.getByRole("dialog", { name: "Elements in net GND" })).toBeTruthy();

    store.visual.activate("pcb-2");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "View elements in CLK_OUT" })).toBeTruthy();
  });
});
