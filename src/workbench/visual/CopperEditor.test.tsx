import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { createCopperEditor, type CopperEditor } from "./CopperEditor";
import { saveCopperDefaults } from "./defaults";
let store: ReturnType<typeof createPlacementStore>;
let editor: CopperEditor;
beforeEach(async () => {
  localStorage.clear(); // isolate the persisted copper placement defaults
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Test",
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
  store.visual.calibratePcb(10);
  render(() => {
    editor = createCopperEditor(
      store,
      () => true,
      () => {},
    );
    return (
      <>
        <editor.Toolbar />
        <editor.Inspector />
        <editor.Dialog />
      </>
    );
  });
});
afterEach(() => store.dispose());
function trace(a: { x: number; y: number }, b: { x: number; y: number }) {
  fireEvent.click(screen.getByRole("button", { name: "Place trace" }));
  editor.down(a, 1, true, 0);
  editor.down(b, 1, true, 0);
  editor.finish();
}
it("creates isolated copper with persisted net/color and undo", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  const p = store.visual.activePcb()!;
  expect(p.traces).toHaveLength(1);
  expect(p.traces![0].width).toBe(5);
  expect(p.nets![0].color).toMatch(/^#[0-9a-f]{6}$/i);
  store.undo();
  expect(store.visual.activePcb()!.traces ?? []).toHaveLength(0);
});
it("seeds the placement parameters from the stored defaults", () => {
  cleanup(); // drop the beforeEach editor so a fresh one reads storage
  saveCopperDefaults({ traceWidthMm: 0.25, viaDiameterMm: 1.2, viaDrillMm: 0.4, route45: true });
  render(() => {
    editor = createCopperEditor(
      store,
      () => true,
      () => {},
    );
    return (
      <>
        <editor.Toolbar />
        <editor.Inspector />
        <editor.Dialog />
      </>
    );
  });
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  // 0.25 mm × 10 px/mm calibration; the selected trace's Width field shows mm.
  expect(store.visual.activePcb()!.traces![0].width).toBe(2.5);
  expect((screen.getByRole("spinbutton", { name: "Width (mm)" }) as HTMLInputElement).value).toBe("0.25");
});
it("applies new defaults mid-session to subsequent placements", () => {
  editor.applyDefaults({ traceWidthMm: 0.2, viaDiameterMm: 1.5, viaDrillMm: 0.7, route45: false });
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  expect(store.visual.activePcb()!.traces![0].width).toBe(2);
});
it("locks elements: selectable but immovable, structure frozen, net editable", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  editor.down({ x: 50, y: 0 }, 1, true, 0); // selects (drag starts, no move yet)
  editor.up({ x: 50, y: 0 });
  const net = screen.getByRole("combobox", { name: "Net" });
  fireEvent.click(screen.getByRole("button", { name: "Lock element" }));
  expect(store.visual.activePcb()!.traces![0].locked).toBe(true);
  expect(screen.getByRole("button", { name: "Unlock element" })).toBeTruthy();
  expect(screen.getByRole("spinbutton", { name: "Width (mm)" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("combobox", { name: "Net" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "Delete element" }).hasAttribute("disabled")).toBe(true);
  // Body drags are refused for locked elements.
  editor.down({ x: 50, y: 0 }, 1, true, 0);
  editor.move({ x: 60, y: 10 }, 1, true);
  editor.up({ x: 60, y: 10 });
  expect(store.visual.activePcb()!.traces![0].points).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  // Keyboard delete is refused with a message instead of mutating.
  editor.key("Delete");
  expect(store.visual.activePcb()!.traces).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain("locked");
  // Net assignment stays available while locked.
  fireEvent.change(net, { target: { value: "" } });
  expect(store.visual.activePcb()!.traces![0].netId).toBeUndefined();
});
it("locked vias still accept trace attachment", () => {
  fireEvent.click(screen.getByRole("button", { name: "Place via" }));
  editor.down({ x: 50, y: 50 }, 1, true, 0);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  editor.down({ x: 50, y: 50 }, 1, true, 0); // selects the via
  editor.up({ x: 50, y: 50 });
  fireEvent.click(screen.getByRole("button", { name: "Lock element" }));
  expect(store.visual.activePcb()!.vias![0].locked).toBe(true);
  // A trace drawn at the via snaps onto its center and finishes there
  // (shift=false keeps snapping enabled).
  fireEvent.click(screen.getByRole("button", { name: "Place trace" }));
  editor.down({ x: 0, y: 0 }, 1, false, 0);
  editor.down({ x: 52, y: 50 }, 1, false, 0);
  expect(store.visual.activePcb()!.traces![0].points[1]).toEqual({ x: 50, y: 50 });
  expect(store.visual.activePcb()!.vias![0]).toMatchObject({ x: 50, y: 50, locked: true });
});
it("prompts before joining nets and cancels without document mutation", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  trace({ x: 0, y: 100 }, { x: 100, y: 100 });
  const before = JSON.stringify(store.doc());
  trace({ x: 50, y: 0 }, { x: 50, y: 100 });
  expect(
    screen.getByRole("dialog", { name: "Join connected nets" }),
  ).toBeTruthy();
  expect(JSON.stringify(store.doc())).toBe(before);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(JSON.stringify(store.doc())).toBe(before);
});
it("joins atomically and undo restores separate nets", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  trace({ x: 0, y: 100 }, { x: 100, y: 100 });
  trace({ x: 50, y: 0 }, { x: 50, y: 100 });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(store.visual.activePcb()!.nets).toHaveLength(1);
  expect(store.visual.activePcb()!.traces).toHaveLength(3);
  store.undo();
  expect(store.visual.activePcb()!.nets).toHaveLength(2);
  expect(store.visual.activePcb()!.traces).toHaveLength(2);
});
it("destroys a zone whose net prompt is cancelled", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Place zone" }));
  editor.down({ x: -20, y: -20 }, 1, false, 0);
  editor.down({ x: 120, y: -20 }, 1, false, 0);
  editor.down({ x: 120, y: 120 }, 1, false, 0);
  editor.finish();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(store.visual.activePcb()!.zones ?? []).toHaveLength(0);
  expect(store.visual.activePcb()!.nets).toHaveLength(1);
  // Cancelling the prompt also returns the copper mode to Select.
  expect(editor.mode()).toBe("select");
});
it("does not commit stale copper drags after a PCB change", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  editor.down({ x: 0, y: 0 }, 1, false, 0);
  store.visual.addPcb();
  expect(() => editor.up({ x: 10, y: 10 })).not.toThrow();
  expect(store.visual.activePcb()!.traces ?? []).toHaveLength(0);
});
it("clears a deleted placement net before placing new isolated copper", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Place via" }));
  const p = store.visual.activePcb()!;
  fireEvent.change(screen.getByRole("combobox", { name: "Net" }), {
    target: { value: p.nets![0].id },
  });
  store.visual.replaceCopper(p.id, {
    nets: [],
    traces: p.traces!.map((t) => ({ ...t, netId: undefined })),
    zones: [],
    vias: [],
  });
  editor.down({ x: 200, y: 200 }, 1, true, 0);
  const next = store.visual.activePcb()!;
  expect(next.nets).toHaveLength(0);
  expect(next.vias![0].netId).toBeUndefined();
});
it("places isolated vias without creating a default net", () => {
  fireEvent.click(screen.getByRole("button", { name: "Place via" }));
  editor.down({ x: 200, y: 200 }, 1, true, 0);
  const p = store.visual.activePcb()!;
  expect(p.vias).toHaveLength(1);
  expect(p.vias![0].netId).toBeUndefined();
  expect(p.nets ?? []).toHaveLength(0);
});
it("filters the nets list and assigns net on click or add button", () => {
  trace({ x: 0, y: 0 }, { x: 100, y: 0 }); // creates net NET1
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  editor.down({ x: 50, y: 0 }, 1, true, 0);
  editor.up({ x: 50, y: 0 });

  const input = screen.getByRole("combobox", { name: "Net" });
  fireEvent.click(input);
  const list = screen.getByRole("listbox", { name: "Nets list" });
  expect(list.textContent).toContain("NET1");

  // Filter with no match
  fireEvent.input(input, { target: { value: "CUSTOM_BUS" } });
  expect(list.textContent).toContain("No matching nets");

  // Add new net with + button
  fireEvent.click(screen.getByRole("button", { name: "Add net" }));
  const pcb = store.visual.activePcb()!;
  const newNet = pcb.nets!.find((n) => n.name === "CUSTOM_BUS");
  expect(newNet).toBeDefined();
  expect(pcb.traces![0].netId).toBe(newNet!.id);

  // Filter matches new net in updated inspector
  const updatedInput = screen.getByRole("combobox", { name: "Net" });
  fireEvent.click(updatedInput);
  fireEvent.input(updatedInput, { target: { value: "CUSTOM" } });
  expect(screen.getByRole("listbox", { name: "Nets list" }).textContent).toContain("CUSTOM_BUS");

  // Clicking Unassigned clears the net assignment
  fireEvent.click(screen.getByText("Unassigned"));
  expect(store.visual.activePcb()!.traces![0].netId).toBeUndefined();
  expect(screen.queryByRole("listbox")).toBeNull();

  // Clicking an existing net in the list re-assigns it
  fireEvent.click(screen.getByRole("combobox", { name: "Net" }));
  fireEvent.click(screen.getByText("CUSTOM_BUS"));
  expect(store.visual.activePcb()!.traces![0].netId).toBe(newNet!.id);
  expect(screen.queryByRole("listbox")).toBeNull();

  // Pressing Enter in the input with a new net name adds and assigns it
  const enterInput = screen.getByRole("combobox", { name: "Net" });
  fireEvent.input(enterInput, { target: { value: "POWER_5V" } });
  fireEvent.keyDown(enterInput, { key: "Enter" });
  const pcb2 = store.visual.activePcb()!;
  const powerNet = pcb2.nets!.find((n) => n.name === "POWER_5V");
  expect(powerNet).toBeDefined();
  expect(pcb2.traces![0].netId).toBe(powerNet!.id);
});

it("snaps edited trace vertices to vias and other traces, with Shift bypass", () => {
  const pcb = structuredClone(store.visual.activePcb()!);
  const layerId = pcb.layers[0];
  pcb.traces = [{id:"a",layerId,width:2,points:[{x:0,y:0},{x:30,y:0},{x:30,y:30}]},
    {id:"b",layerId,width:2,points:[{x:80,y:0},{x:80,y:100}]}];
  pcb.vias = [{id:"via",x:50,y:50,diameter:4,drill:2}];
  store.visual.replacePcb(pcb);
  editor.down({x:30,y:30},1,false,0);
  editor.move({x:48,y:49},1,false);
  editor.up({x:48,y:49},1,false);
  expect(store.visual.activePcb()!.traces![0].points[2]).toEqual({x:50,y:50});
  const next = structuredClone(store.visual.activePcb()!); next.vias = []; store.visual.replacePcb(next);
  editor.down({x:50,y:50},1,false,0);
  editor.up({x:77,y:60},1,false);
  expect(store.visual.activePcb()!.traces![0].points[2]).toEqual({x:80,y:60});
  editor.down({x:80,y:60},1,true,0);
  editor.up({x:77,y:70},1,true);
  expect(store.visual.activePcb()!.traces![0].points[2]).toEqual({x:77,y:70});
});

it("records a pad anchor when an edited endpoint snaps to a component pin", () => {
  const pcb=structuredClone(store.visual.activePcb()!); const layerId=pcb.layers[0]; pcb.pxPerMm=1;
  pcb.components=[{id:"c",reference:"J1",value:"",partName:"",x:50,y:50,rotation:0,scale:1,layerId,terminals:[{number:"1"}],
    definition:{id:"d",name:"Pad",partName:"",value:"",referencePrefix:"J",pinMap:{"1":"1"},footprint:{id:"f",name:"Pad",source:"",raw:"",diagnostics:[],graphics:[],pads:[{number:"1",x:0,y:0,width:4,height:4,shape:"rect",rotation:0,plated:false,layers:["F.Cu"]}]}}}];
  pcb.traces=[{id:"t",layerId,width:2,points:[{x:0,y:0},{x:30,y:0},{x:30,y:30}]}];store.visual.replacePcb(pcb);
  editor.down({x:30,y:30},1,false,0);editor.up({x:48,y:49},1,false);
  expect(store.visual.activePcb()!.traces![0]).toMatchObject({endPad:{componentId:"c",terminal:"1"}});
  expect(store.visual.activePcb()!.traces![0].points[2]).toEqual({x:50,y:50});
  editor.down({x:50,y:50},1,true,0);editor.up({x:80,y:80},1,true);
  expect(store.visual.activePcb()!.traces![0].endPad).toBeUndefined();
});
