import { VisualPanel } from "../visual/VisualPanel";
import { VisualCanvas } from "../visual/VisualCanvas";
import { kicad } from "../../bridge/kicad";
import * as domain from "./domain";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { createComponentEditor } from "./ComponentEditor";
import type { ComponentDefinition } from "../../bridge/kicad";
let store: ReturnType<typeof createPlacementStore>,
  editor: ReturnType<typeof createComponentEditor>;
const definition: ComponentDefinition = {
  id: "d",
  name: "D",
  partName: "",
  value: "",
  referencePrefix: "U",
  pinMap: { "1": "1", "2": "2" },
  footprint: {
    id: "f",
    name: "F",
    source: "",
    raw: "",
    graphics: [],
    diagnostics: [],
    pads: [
      {
        number: "1",
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        shape: "rect",
        rotation: 0,
        plated: false,
        layers: ["F.Cu"],
      },
      {
        number: "2",
        x: 10,
        y: 0,
        width: 2,
        height: 2,
        shape: "rect",
        rotation: 0,
        plated: false,
        layers: ["F.Cu"],
      },
    ],
  },
};
beforeEach(async () => {
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "test",
    createdAt: "t",
    updatedAt: "t",
    types: SEED_TYPES,
    boards: [],
    components: [],
    assets: {},
  };
  store = createPlacementStore({
    openProject: async () => ({ doc, assets: {}, path: "test.pcbre" }),
    save: vi.fn(),
  });
  await store.openProject("test.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  store.visual.calibratePcb(1);
  render(() => {
    editor = createComponentEditor(
      store,
      () => store.visual.activePcb()!.layers[0],
      () => true,
      () => {},
    );
    return (
      <>
        <editor.Inspector />
        <editor.Manager />
      </>
    );
  });
});
afterEach(() => store.dispose());
it("places independent terminals and updates only physically connected group", () => {
  editor.arm(definition);
  editor.down({ x: 0, y: 0 });
  editor.key("Escape");
  editor.down({ x: 0, y: 0 });
  fireEvent.change(screen.getByLabelText("Net for U1 pad 1"), {
    target: { value: "new" },
  });
  const c = store.visual.activePcb()!.components![0];
  expect(c.terminals[0].netId).toBeTruthy();
  expect(c.terminals[1].netId).toBeUndefined();
  expect(store.visual.activePcb()!.schematic!.units).toHaveLength(1);
});
it("does not commit a stale component drag after undo removes it", () => {
  editor.arm(definition);
  editor.down({ x: 0, y: 0 });
  editor.key("Escape");
  editor.down({ x: 0, y: 0 });
  store.undo();
  expect(() => editor.up({ x: 20, y: 0 })).not.toThrow();
  expect(store.visual.activePcb()!.components ?? []).toHaveLength(0);
});
it("cancels all placement geometry and net changes when conflicting contact is declined", () => {
  const p = structuredClone(store.visual.activePcb()!);
  p.nets = [
    { id: "a", name: "A", color: "#ff0000" },
    { id: "b", name: "B", color: "#00ff00" },
  ];
  p.traces = [
    {
      id: "a",
      layerId: p.layers[0],
      width: 1,
      netId: "a",
      points: [
        { x: -2, y: 0 },
        { x: 2, y: 0 },
      ],
    },
    {
      id: "b",
      layerId: p.layers[0],
      width: 1,
      netId: "b",
      points: [
        { x: 0, y: -2 },
        { x: 0, y: 2 },
      ],
    },
  ];
  store.visual.replacePcb(p);
  const before = JSON.stringify(store.doc());
  editor.arm(definition);
  editor.down({ x: 0, y: 0 });
  expect(
    screen.getByRole("dialog", { name: "Join component nets" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(JSON.stringify(store.doc())).toBe(before);
});
it("moves explicitly anchored endpoints without moving coincident opposite-layer traces", () => {
  editor.arm(definition);
  editor.down({ x: 0, y: 0 });
  editor.key("Escape");
  const p = structuredClone(store.visual.activePcb()!),
    c = p.components![0];
  p.traces = [
    {
      id: "attached",
      layerId: p.layers[0],
      points: [
        { x: 0, y: 0 },
        { x: -20, y: 0 },
      ],
      width: 0.3,
      startPad: { componentId: c.id, terminal: "1" },
    },
    {
      id: "opposite",
      layerId: p.layers[1],
      points: [
        { x: 0, y: 0 },
        { x: -20, y: 0 },
      ],
      width: 0.3,
    },
  ];
  store.visual.replacePcb(p);
  editor.down({ x: 0, y: 0 });
  editor.move({ x: 5, y: 0 });
  editor.up({ x: 5, y: 0 });
  const next = store.visual.activePcb()!;
  expect(next.traces![0].points[0]).toEqual({ x: 5, y: 0 });
  expect(next.traces![1].points[0]).toEqual({ x: 0, y: 0 });
  store.undo();
  expect(store.visual.activePcb()!.components![0].x).toBe(0);
});
it("rejects a blank reference without changing the document", () => {
  editor.arm(definition);
  editor.down({ x: 0, y: 0 });
  editor.key("Escape");
  editor.down({ x: 0, y: 0 });
  const before = JSON.stringify(store.doc());
  fireEvent.change(screen.getByLabelText("Component reference"), {
    target: { value: "   " },
  });
  expect(JSON.stringify(store.doc())).toBe(before);
  expect(screen.getByRole("alert").textContent).toMatch(/References/);
});
it("reconciles schematic connected pins when assigning a terminal to another net", () => {
  editor.arm(definition);
  editor.down({ x: 0, y: 0 });
  editor.key("Escape");
  const p = structuredClone(store.visual.activePcb()!),
    c = p.components![0],
    other = structuredClone(c);
  other.id = "second";
  other.reference = "U2";
  other.x = 100;
  p.components!.push(other);
  p.nets = [
    { id: "a", name: "A", color: "#ff0000" },
    { id: "b", name: "B", color: "#00ff00" },
  ];
  c.terminals[0].netId = "a";
  other.terminals[0].netId = "a";
  p.schematic!.wires = [
    {
      id: "wire",
      netId: "a",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      start: { componentId: c.id, terminal: "1" },
      end: { componentId: other.id, terminal: "1" },
    },
  ];
  store.visual.replacePcb(p);
  editor.down({ x: 0, y: 0 });
  fireEvent.change(screen.getByLabelText("Net for U1 pad 1"), {
    target: { value: "b" },
  });
  expect(
    screen.getByRole("dialog", { name: "Join component nets" }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Surviving net"), {
    target: { value: "b" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Merge and apply" }));
  expect(
    store.visual.activePcb()!.components!.map((c) => c.terminals[0].netId),
  ).toEqual(["b", "b"]);
  expect(store.visual.activePcb()!.schematic!.wires[0].netId).toBe("b");
});
it("rotates an armed footprint with R and selects its empty body", () => {
  editor.arm(definition);
  editor.key("r");
  editor.down({ x: 0, y: 0 });
  expect(store.visual.activePcb()!.components![0].rotation).toBe(90);
  editor.key("Escape");
  expect(editor.down({ x: 0, y: 5 })).toBe(true);
  expect(editor.current()?.reference).toBe("U1");
});
it("renders a transient component drag without writing the document", () => {
  editor.arm(definition);
  editor.down({ x: 0, y: 0 });
  editor.key("Escape");
  editor.down({ x: 5, y: 0 });
  const before = JSON.stringify(store.doc());
  editor.move({ x: 15, y: 0 });
  const draw = vi.spyOn(domain, "drawFootprint").mockImplementation(() => {});
  try {
    editor.draw({} as CanvasRenderingContext2D);
    expect(draw.mock.calls[0][1].x).toBe(10);
    expect(JSON.stringify(store.doc())).toBe(before);
  } finally {
    draw.mockRestore();
  }
});

it("blocks uncalibrated arming with a visible error even without a selection", () => {
  const pcb = structuredClone(store.visual.activePcb()!);
  delete pcb.pxPerMm;
  store.visual.replacePcb(pcb);
  editor.arm(definition);
  expect(editor.placementActive()).toBe(false);
  expect(screen.getByRole("alert").textContent).toContain("Calibrate");
  expect(store.visual.activePcb()!.components ?? []).toHaveLength(0);
});
it("keeps armed preview transient and supports repeated placement until Escape", () => {
  const before = JSON.stringify(store.doc());
  editor.arm(definition);
  expect(editor.placementActive()).toBe(true);
  expect(editor.placementGeneration()).toBe(1);
  editor.move({ x: 45, y: 32 });
  editor.key("r");
  const draw = vi.spyOn(domain, "drawFootprint").mockImplementation(() => {});
  const ctx = { save: vi.fn(), restore: vi.fn(), globalAlpha: 1 };
  try {
    editor.draw(ctx as unknown as CanvasRenderingContext2D);
    expect(draw.mock.calls[0][1]).toMatchObject({ x: 45, y: 32, rotation: 90 });
    expect(ctx.globalAlpha).toBe(0.5);
    expect(JSON.stringify(store.doc())).toBe(before);
    editor.down({ x: 45, y: 32 });
    editor.down({ x: 145, y: 32 });
    expect(store.visual.activePcb()!.components).toHaveLength(2);
    expect(editor.placementActive()).toBe(true);
    editor.key("Escape");
    expect(editor.placementActive()).toBe(false);
  } finally { draw.mockRestore(); }
});

it("hands an actual library selection to armed canvas placement", async () => {
  const mocks = [
    vi.spyOn(kicad, "definitions").mockResolvedValue([definition]),
    vi.spyOn(kicad, "sources").mockResolvedValue([]),
    vi.spyOn(kicad, "search").mockResolvedValue({ entries: [], total: 0 }),
    vi.spyOn(kicad, "saveDefinition").mockResolvedValue(undefined),
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null),
  ];
  try {
    render(() => <VisualCanvas store={store} components={editor} selected={null} select={() => {}} active opacityDraft={null} tool={null} flipX flipY onToolEnd={() => {}} onPrompt={() => {}} />);
    editor.open();
    fireEvent.click(screen.getByRole("button", { name: "Use saved component" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    fireEvent.click(screen.getByRole("button", { name: /^Place$/ }));
    await waitFor(() => expect(editor.placementActive()).toBe(true));
    expect(screen.queryByRole("dialog", { name: "Component library" })).toBeNull();
    const canvas = screen.getByLabelText("Visual editor photographs");
    await waitFor(() => expect(document.activeElement).toBe(canvas));
    expect(screen.getByText("Click to place | R rotate | Esc cancel")).toBeTruthy();
    expect(screen.queryByText("Add photographs to compare PCB layers.")).toBeNull();
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const pointer = (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 23, clientY: 45 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      canvas.dispatchEvent(event);
    };
    pointer("pointermove");
    pointer("pointerdown");
    expect(store.visual.activePcb()!.components).toHaveLength(1);
    expect(store.visual.activePcb()!.components![0].layerId).toBe(store.visual.activePcb()!.layers[0]);
  } finally { mocks.forEach(mock => mock.mockRestore()); }
});

it("places through the integrated VisualPanel toolbar and library lifecycle", async () => {
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, { get: (target, key) => target[key as string] ?? (() => {}) }) as unknown as CanvasRenderingContext2D;
  const drawnAlphas: number[] = [];
  const mocks = [
    vi.spyOn(kicad, "definitions").mockResolvedValue([definition]),
    vi.spyOn(kicad, "sources").mockResolvedValue([]),
    vi.spyOn(kicad, "search").mockResolvedValue({ entries: [], total: 0 }),
    vi.spyOn(kicad, "saveDefinition").mockResolvedValue(undefined),
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx),
    vi.spyOn(domain, "drawFootprint").mockImplementation(context => { drawnAlphas.push(context.globalAlpha); }),
  ];
  try {
    render(() => <VisualPanel store={store} active />);
    fireEvent.click(screen.getByRole("button", { name: "Place component" }));
    fireEvent.click(screen.getByRole("button", { name: "Use saved component" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    fireEvent.click(screen.getByRole("button", { name: /^Place$/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Component library" })).toBeNull());
    expect(screen.getByText("Click to place | R rotate | Esc cancel")).toBeTruthy();
    const canvas = screen.getByLabelText("Visual editor photographs");
    await waitFor(() => expect(document.activeElement).toBe(canvas));
    await waitFor(() => expect(drawnAlphas).toContain(0.5));
    expect(store.visual.activePcb()!.components ?? []).toHaveLength(0);
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    for (const type of ["pointermove", "pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 23, clientY: 45 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      canvas.dispatchEvent(event);
    }
    expect(store.visual.activePcb()!.components).toHaveLength(1);
  } finally { mocks.forEach(mock => mock.mockRestore()); }
});

it("drags copper over a large component without moving the component", () => {
  const large = structuredClone(definition); large.footprint.pads[0].width=200; large.footprint.pads[0].height=200;
  editor.arm(large); editor.down({x:0,y:0}); editor.key("Escape");
  const pcb = structuredClone(store.visual.activePcb()!);
  pcb.traces = [{id:"t",layerId:pcb.layers[0],width:2,points:[{x:0,y:0},{x:100,y:0}]}];
  store.visual.replacePcb(pcb);
  const mock = vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null);
  try {
    render(()=><VisualPanel store={store} active />);
    const canvas=screen.getByLabelText("Visual editor photographs");
    Object.assign(canvas,{setPointerCapture:vi.fn(),hasPointerCapture:()=>false});
    for(const [type,x,y] of [["pointerdown",80,30],["pointermove",90,40],["pointerup",90,40]] as const){
      const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});
      Object.defineProperty(event,"pointerId",{value:1});canvas.dispatchEvent(event);
    }
    expect(store.visual.activePcb()!.components![0]).toMatchObject({x:0,y:0});
    expect(store.visual.activePcb()!.traces![0].points).toEqual([{x:10,y:10},{x:110,y:10}]);
  } finally {mock.mockRestore();}
});

it("renders standardized component inspector details: capitalized labels, step 0.1, lock button, trash delete, and board mapping combobox", async () => {
  const compId = store.addComponent({
    boardId: "",
    refdes: "R10",
    typeId: SEED_TYPES[0].id,
    shape: { rect: { x: 0, y: 0, w: 10, h: 10 } },
  });
  store.updateComponent(compId, { partNumber: "RES-10K", value: "10k" });

  editor.arm(definition);
  editor.down({ x: 0, y: 0 });
  editor.key("Escape");
  editor.down({ x: 0, y: 0 });

  expect(screen.getByText("Reference")).toBeTruthy();
  expect(screen.getByText("Value")).toBeTruthy();
  expect(screen.getByText("Part Name")).toBeTruthy();
  expect(screen.getByText("Rotation (°)")).toBeTruthy();
  expect(screen.getByText("Scale")).toBeTruthy();

  const rotInput = screen.getByLabelText("Component rotation") as HTMLInputElement;
  expect(rotInput.step).toBe("0.1");
  const scaleInput = screen.getByLabelText("Component scale") as HTMLInputElement;
  expect(scaleInput.step).toBe("0.1");

  expect(screen.getByText("Pad / Pin")).toBeTruthy();

  expect(screen.getByRole("button", { name: "Show in schematic" })).toBeTruthy();

  const lockBtn = screen.getByRole("button", { name: "Lock" });
  expect(lockBtn.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(lockBtn);
  expect(store.visual.activePcb()!.components![0].locked).toBe(true);
  expect(screen.getByRole("button", { name: "Locked" }).getAttribute("aria-pressed")).toBe("true");

  const delBtn = screen.getByRole("button", { name: "Delete component" }) as HTMLButtonElement;
  expect(delBtn.disabled).toBe(true);
  expect(delBtn.title).toBe("Component is locked");

  fireEvent.click(screen.getByRole("button", { name: "Locked" }));
  expect(store.visual.activePcb()!.components![0].locked).toBe(false);

  const bmInput = screen.getByRole("combobox", { name: "Board mapping link" });
  fireEvent.click(bmInput);
  expect(screen.getByRole("listbox", { name: "Board mapping components list" })).toBeTruthy();
  const option = screen.getByRole("button", { name: /R10 \(RES-10K\)/ });
  fireEvent.click(option);

  const comp = store.visual.activePcb()!.components![0];
  expect(comp.markingId).toBe(compId);
  expect(comp.reference).toBe("R10");
  expect(comp.value).toBe("10k");
  expect(comp.partName).toBe("RES-10K");
});
