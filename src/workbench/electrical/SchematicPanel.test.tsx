import { fixtureComponent } from "./testFixtures";
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import type { ProjectDoc } from "../placement/projectDoc";
import { SchematicPanel } from "./SchematicPanel";
import {
  initialUnits,
  orthogonal,
  schematicPoint,
  resolveWireGeometry,
  symbolPins,
  wireGroup,
  wiresJoined,
  segmentMidpoints,
} from "./SchematicPanel";
import { groupBom, bomCsv } from "./BomPanel";
import type { SchematicWire } from "./model";
afterEach(cleanup);
it("materializes all units exactly once and retains existing positions", () => {
  const c = fixtureComponent();
  c.definition.symbol!.units.push({
    unit: 2,
    bodyStyle: 1,
    graphics: [],
    pins: [],
  });
  const first = initialUnits([c]);
  expect(first.map((u) => u.unit)).toEqual([1, 2]);
  first[0].x = 999;
  expect(initialUnits([c], first)).toEqual(first);
  expect(initialUnits([], first)).toEqual([]);
});
it("maps symbol terminals by number, keeps unmapped pads and selected alternate body", () => {
  const c = fixtureComponent();
  c.definition.pinMap = { "1": "2" };
  expect(symbolPins(c, 1).map((p) => [p.number, p.terminal])).toEqual([
    ["1", ""],
    ["2", "1"],
    ["2", "2"],
  ]);
  c.definition.symbol!.units.push({
    unit: 1,
    bodyStyle: 2,
    graphics: [],
    pins: [
      {
        ...c.definition.symbol!.units[0].pins[0],
        name: "Alternate",
        number: "2",
      },
    ],
  });
  expect(symbolPins(c, 1, 2)[0].name).toBe("Alternate");
});
it("rotates and mirrors points independently of PCB placement", () => {
  expect(
    schematicPoint(
      { id: "u", componentId: "c", unit: 1, x: 20, y: 30, rotation: 90 },
      { x: 2, y: 3 },
    ),
  ).toEqual({ x: 23, y: 32 });
  expect(
    schematicPoint(
      {
        id: "u",
        componentId: "c",
        unit: 1,
        x: 0,
        y: 0,
        rotation: 0,
        flip: true,
      },
      { x: 2, y: 3 },
    ),
  ).toEqual({ x: -2, y: -3 });
});
it("crossings stay separate while endpoint branches form connected wire groups", () => {
  const a: SchematicWire = {
      id: "a",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    },
    b: SchematicWire = {
      id: "b",
      points: [
        { x: 5, y: -5 },
        { x: 5, y: 5 },
      ],
    },
    branch: SchematicWire = {
      id: "c",
      points: [
        { x: 5, y: 0 },
        { x: 5, y: 4 },
      ],
    };
  expect(wiresJoined(a, b)).toBe(false);
  expect(wireGroup([a, b], "a")).toEqual([a]);
  expect(wireGroup([a, branch], "a")).toEqual([a, branch]);
  expect(orthogonal({ x: 0, y: 0 }, { x: 5, y: 3 })).toEqual([
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 3 },
  ]);
});
it("groups exact part fields, naturally sorts references and escapes CSV", () => {
  const a = fixtureComponent("a", "R10"),
    b = fixtureComponent("b", "R2"),
    c = fixtureComponent("c", "R1");
  c.value = '1k, "precision"';
  const rows = groupBom(
    [a, b, c].map((component) => ({ pcbId: "pcb", pcbName: "PCB", component })),
  );
  expect(rows).toHaveLength(2);
  expect(rows[0].members.map((m) => m.component.reference)).toEqual([
    "R2",
    "R10",
  ]);
  expect(bomCsv(rows)).toContain('"1k, ""precision"""');
  expect(bomCsv(rows, true)).toContain("PCB:R2, PCB:R10");
});
it("cancels conflicting wires unchanged and commits accepted joins as one undo entry", async () => {
  const a = fixtureComponent("a", "R1"),
    b = fixtureComponent("b", "R2");
  b.x = 100;
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Schematic",
    createdAt: "t",
    updatedAt: "t",
    types: [],
    boards: [],
    components: [],
    assets: {},
    visualEditor: {
      activePcbId: "pcb",
      pcbs: [
        {
          id: "pcb",
          name: "PCB",
          layers: ["front", "back"],
          pxPerMm: 10,
          images: [],
          components: [a, b],
          nets: [
            { id: "signal", name: "SIGNAL", color: "#ffcd11" },
            { id: "ground", name: "GROUND", color: "#e5484d" },
          ],
          schematic: {
            units: [
              {
                id: "ua",
                componentId: "a",
                unit: 1,
                x: 30,
                y: 30,
                rotation: 0,
              },
              {
                id: "ub",
                componentId: "b",
                unit: 1,
                x: 70,
                y: 30,
                rotation: 0,
              },
            ],
            wires: [],
            labels: [],
          },
        },
      ],
    },
  };
  const store = createPlacementStore({
    openProject: async () => ({ doc, assets: {}, path: "schematic.pcbre" }),
    save: vi.fn(),
  });
  await store.openProject("schematic.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  render(() => <SchematicPanel store={store} active />);
  const svg = screen.getByLabelText("Schematic canvas");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 240,
    bottom: 160,
    width: 240,
    height: 160,
    toJSON() {},
  });
  fireEvent.click(screen.getByRole("button", { name: "Wire" }));
  const connect = () => {
    fireEvent.pointerDown(svg, { clientX: 25, clientY: 30, button: 0 });
    fireEvent.pointerDown(svg, { clientX: 75, clientY: 30, button: 0 });
  };
  const before = JSON.stringify(store.visual.activePcb());
  connect();
  expect(
    screen.getByRole("dialog", { name: "Join schematic nets" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(JSON.stringify(store.visual.activePcb())).toBe(before);
  connect();
  fireEvent.click(screen.getByRole("button", { name: "Join nets" }));
  expect(store.visual.activePcb()?.schematic?.wires).toHaveLength(1);
  expect(
    store.visual.activePcb()?.schematic?.wires[0].connections,
  ).toHaveLength(4);
  expect(store.visual.activePcb()?.nets).toHaveLength(1);
  store.undo();
  expect(JSON.stringify(store.visual.activePcb())).toBe(before);
  store.dispose();
});
it("persists moved and rotated terminal anchors with orthogonal wire geometry", () => {
  const c = fixtureComponent();
  const wire: SchematicWire = {
    id: "wire",
    points: [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
    ],
    start: { componentId: c.id, terminal: "1", unit: 1 },
  };
  const p = {
    id: "pcb",
    name: "PCB",
    layers: ["front"],
    images: [],
    components: [c],
    schematic: {
      units: [
        { id: "u", componentId: c.id, unit: 1, x: 40, y: 40, rotation: 90 },
      ],
      wires: [wire],
      labels: [],
    },
  };
  const points = resolveWireGeometry(p, wire);
  expect(points[0]).toEqual({ x: 40, y: 35 });
  expect(
    points
      .slice(1)
      .every((point, i) => point.x === points[i].x || point.y === points[i].y),
  ).toBe(true);
});
it("lists addable joint midpoints per segment and skips zero-length segments", () => {
  expect(
    segmentMidpoints([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]),
  ).toEqual([
    { x: 10, y: 0, seg: 0 },
    { x: 20, y: 5, seg: 2 },
  ]);
});
it("adds and removes mid-wire joints with one undo entry each", async () => {
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Schematic",
    createdAt: "t",
    updatedAt: "t",
    types: [],
    boards: [],
    components: [],
    assets: {},
    visualEditor: {
      activePcbId: "pcb",
      pcbs: [
        {
          id: "pcb",
          name: "PCB",
          layers: ["front", "back"],
          pxPerMm: 10,
          images: [],
          components: [],
          nets: [],
          schematic: {
            units: [],
            wires: [
              {
                id: "wire",
                points: [
                  { x: 0, y: 0 },
                  { x: 0, y: 20 },
                  { x: 30, y: 20 },
                ],
              },
            ],
            labels: [],
          },
        },
      ],
    },
  };
  const store = createPlacementStore({
    openProject: async () => ({ doc, assets: {}, path: "joints.pcbre" }),
    save: vi.fn(),
  });
  await store.openProject("joints.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  render(() => <SchematicPanel store={store} active />);
  const svg = screen.getByLabelText("Schematic canvas");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 240,
    bottom: 160,
    width: 240,
    height: 160,
    toJSON() {},
  });
  const polyline = svg.querySelector("polyline");
  expect(polyline).toBeTruthy();
  fireEvent.pointerDown(polyline as SVGPolylineElement, { button: 0 });
  const points = () => store.visual.activePcb()?.schematic?.wires[0].points;
  const before = JSON.stringify(store.visual.activePcb());
  expect(screen.getByRole("button", { name: "Wire bend 1" })).toBeTruthy();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Add joint on segment 1" }),
  );
  expect(points()).toEqual([
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 0, y: 20 },
    { x: 30, y: 20 },
  ]);
  expect(screen.getByRole("button", { name: "Wire bend 2" })).toBeTruthy();
  store.undo();
  expect(JSON.stringify(store.visual.activePcb())).toBe(before);
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Add joint on segment 2" }),
    { key: "Enter" },
  );
  expect(points()).toHaveLength(4);
  store.undo();
  expect(JSON.stringify(store.visual.activePcb())).toBe(before);
  fireEvent.dblClick(screen.getByRole("button", { name: "Wire bend 1" }));
  expect(points()).toEqual([
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 20 },
  ]);
  store.undo();
  expect(JSON.stringify(store.visual.activePcb())).toBe(before);
  fireEvent.keyDown(screen.getByRole("button", { name: "Wire bend 1" }), {
    key: "Delete",
  });
  expect(points()).toHaveLength(3);
  store.dispose();
});
it("renders joint handles only for the selected wire", async () => {
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Schematic",
    createdAt: "t",
    updatedAt: "t",
    types: [],
    boards: [],
    components: [],
    assets: {},
    visualEditor: {
      activePcbId: "pcb",
      pcbs: [
        {
          id: "pcb",
          name: "PCB",
          layers: ["front", "back"],
          pxPerMm: 10,
          images: [],
          components: [],
          nets: [],
          schematic: {
            units: [],
            wires: [
              {
                id: "bent",
                points: [
                  { x: 0, y: 0 },
                  { x: 0, y: 20 },
                  { x: 30, y: 20 },
                ],
              },
              {
                id: "straight",
                points: [
                  { x: 100, y: 0 },
                  { x: 140, y: 0 },
                ],
              },
            ],
            labels: [],
          },
        },
      ],
    },
  };
  const store = createPlacementStore({
    openProject: async () => ({ doc, assets: {}, path: "joints.pcbre" }),
    save: vi.fn(),
  });
  await store.openProject("joints.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  render(() => <SchematicPanel store={store} active />);
  const svg = screen.getByLabelText("Schematic canvas");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 240,
    bottom: 160,
    width: 240,
    height: 160,
    toJSON() {},
  });
  fireEvent.pointerDown(svg.querySelector("polyline")!, { button: 0 });
  expect(screen.getAllByRole("button", { name: /^Add joint/ })).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: /^Wire bend/ })).toHaveLength(1);
  store.dispose();
});
