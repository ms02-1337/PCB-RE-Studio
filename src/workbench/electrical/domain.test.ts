import { describe, it, expect } from "vitest";
import { padCopperContains, padContours } from "./padGeometry";
import {
  drawFootprint,
  drawGraphics,
  createInstance,
  footprintBounds,
  replacementBoards,
  ensureSchematic,
  terminalNumbers,
} from "./domain";
import { connected, mergeNets, padConductors, touches } from "../visual/copper";
import type { ComponentDefinition, KPad } from "../../bridge/kicad";
import type { VisualPcb } from "../visual/model";
const pad: KPad = {
  number: "1",
  x: 0,
  y: 0,
  width: 4,
  height: 2,
  rotation: 0,
  shape: "oval",
  plated: false,
  layers: ["F.Cu"],
};
const definition: ComponentDefinition = {
  id: "def",
  name: "test",
  partName: "",
  value: "",
  referencePrefix: "U",
  footprint: {
    id: "fp",
    name: "fp",
    source: "test",
    raw: "",
    pads: [pad, { ...pad, number: "2", x: 10 }],
    graphics: [],
    diagnostics: [],
  },
  pinMap: { "1": "1", "2": "2" },
};
const board = (): VisualPcb => ({
  id: "pcb",
  name: "pcb",
  layers: ["front", "back"],
  images: [],
  pxPerMm: 1,
  nets: [
    { id: "a", name: "A", color: "#ff0000" },
    { id: "b", name: "B", color: "#00ff00" },
  ],
});
describe("electrical components", () => {
  it("uses true oval copper rather than a bounding rectangle", () => {
    expect(padCopperContains(pad, { x: 1.9, y: 0.9 })).toBe(false);
    expect(padCopperContains(pad, { x: 1, y: 0.9 })).toBe(true);
    expect(padContours(pad)[0].length).toBeGreaterThan(30);
  });
  it("excludes slotted holes from copper and excludes NPTH terminals", () => {
    const hole = {
      ...pad,
      plated: true,
      drill: { width: 2, height: 1, x: 0, y: 0 },
    };
    expect(padCopperContains(hole, { x: 0, y: 0 })).toBe(false);
    expect(padCopperContains(hole, { x: 1.7, y: 0 })).toBe(true);
    const d = structuredClone(definition);
    d.footprint.pads.push({
      ...hole,
      number: "3",
      plated: false,
      type: "np_thru_hole",
    });
    expect(terminalNumbers(d)).toEqual(["1", "2"]);
  });
  it("keeps unrelated component terminals as independent connected groups", () => {
    const p = board(),
      c = createInstance(p, definition, { x: 0, y: 0 }, "front");
    c.terminals[0].netId = "a";
    c.terminals[1].netId = "b";
    p.components = [c];
    expect(new Set(connected(p, [c.id + ":1"]).map((e) => e.netId))).toEqual(
      new Set(["a"]),
    );
  });
  it("joins a contacting trace to a pad and preserves cross-layer separation", () => {
    const p = board(),
      c = createInstance(p, definition, { x: 0, y: 0 }, "front");
    c.terminals[0].netId = "a";
    p.components = [c];
    p.traces = [
      {
        id: "trace",
        layerId: "front",
        points: [
          { x: -3, y: 0 },
          { x: 0, y: 0 },
        ],
        width: 0.3,
      },
      {
        id: "backtrace",
        layerId: "back",
        points: [
          { x: -3, y: 0 },
          { x: 0, y: 0 },
        ],
        width: 0.3,
      },
    ];
    const group = connected(p, ["trace"]);
    expect(group.some((e) => "padTerminal" in e)).toBe(true);
    expect(group.some((e) => e.id === "backtrace")).toBe(false);
    mergeNets(p, ["a", "b"], "a");
    expect(c.terminals[0].netId).toBe("a");
  });
  it("creates all schematic units exactly once", () => {
    const p = board(),
      d = structuredClone(definition);
    d.symbol = {
      id: "s",
      name: "s",
      source: "s",
      raw: "",
      reference: "U",
      diagnostics: [],
      units: [
        { unit: 1, bodyStyle: 1, pins: [], graphics: [] },
        { unit: 2, bodyStyle: 1, pins: [], graphics: [] },
        { unit: 1, bodyStyle: 2, pins: [], graphics: [] },
      ],
    };
    p.components = [createInstance(p, d, { x: 0, y: 0 }, "front")];
    ensureSchematic(p);
    ensureSchematic(p);
    expect(p.schematic!.units.map((u) => u.unit)).toEqual([1, 2]);
  });
});
it("excludes a small conductor entirely inside a plated drill opening", () => {
  const p = board(),
    d = structuredClone(definition);
  d.footprint.pads[0] = {
    ...pad,
    shape: "circle",
    width: 4,
    height: 4,
    plated: true,
    drill: { width: 2, height: 2, x: 0, y: 0 },
  };
  p.components = [createInstance(p, d, { x: 0, y: 0 }, "front")];
  p.traces = [
    {
      id: "inside-hole",
      layerId: "front",
      points: [
        { x: -0.1, y: 0 },
        { x: 0.1, y: 0 },
      ],
      width: 0.1,
    },
  ];
  expect(connected(p, ["inside-hole"]).some((c) => "padTerminal" in c)).toBe(
    false,
  );
});
it("prepares replacements across PCBs without mutating originals or dropping matching net assignments", () => {
  const a = board(),
    b = board();
  b.id = "pcb2";
  a.components = [createInstance(a, definition, { x: 0, y: 0 }, "front")];
  b.components = [createInstance(b, definition, { x: 0, y: 0 }, "front")];
  a.components[0].terminals[0].netId = "a";
  b.components[0].terminals[0].netId = "b";
  const d = structuredClone(definition);
  d.name = "replacement";
  const result = replacementBoards(
    [a, b],
    [a.components[0].id, b.components[0].id],
    d,
  );
  expect(result.boards).toHaveLength(2);
  expect(result.boards.map((p) => p.components![0].definition.name)).toEqual([
    "replacement",
    "replacement",
  ]);
  expect(a.components[0].definition.name).toBe("test");
  expect(result.boards.map((p) => p.components![0].terminals[0].netId)).toEqual(
    ["a", "b"],
  );
});

it("detects nested copper pads symmetrically without a boundary crossing", () => {
  const p = board(),
    small = createInstance(p, definition, { x: 0, y: 0 }, "front"),
    d = structuredClone(definition);
  d.footprint.pads = [{ ...pad, width: 20, height: 20, shape: "rect" }];
  const large = createInstance(p, d, { x: 0, y: 0 }, "front");
  large.id = "large";
  p.components = [small, large];
  const [a, b] = [
    padConductors(p).find((c) => c.padTerminal === small.id + ":1")!,
    padConductors(p).find((c) => c.padTerminal === large.id + ":1")!,
  ];
  expect(touches(a, b)).toBe(true);
  expect(touches(b, a)).toBe(true);
});

it("preserves inherited footprint opacity for every pad and restores the context", () => {
  const stack: number[] = [], fills: number[] = [];
  const state: Record<string, unknown> = { globalAlpha: 0.5 };
  state.save = () => stack.push(state.globalAlpha as number);
  state.restore = () => { state.globalAlpha = stack.pop(); };
  state.fill = () => fills.push(state.globalAlpha as number);
  const ctx = new Proxy(state, { get: (target, key) => target[key as string] ?? (() => {}) }) as unknown as CanvasRenderingContext2D;
  drawFootprint(ctx, createInstance(board(), definition, { x: 0, y: 0 }, "front"), 1, "yellow");
  expect(fills).toEqual([0.35, 0.35]);
  expect(ctx.globalAlpha).toBe(0.5);
});

function fakeCtx() {
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get: (target, key) =>
      key === "fillText"
        ? (text: string, x: number, y: number) => texts.push({ text, x, y })
        : target[key as string] ?? (() => {}),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

it("computes footprint bounds from graphics and pad extents, ignoring KiCad placeholders", () => {
  const d = structuredClone(definition);
  d.footprint.graphics = [
    { kind: "line", points: [{ x: 12, y: 0 }, { x: 12, y: 3 }], width: 0.15, fill: false },
    { kind: "text", points: [{ x: 100, y: 100 }], width: 0.15, fill: false, text: "${REFERENCE}" },
    { kind: "text", points: [{ x: -5, y: 0 }], width: 0.15, fill: false, text: "220nF" },
  ];
  const b = footprintBounds(d.footprint)!;
  expect(b.minX).toBeCloseTo(-5);
  expect(b.maxX).toBeCloseTo(12.236);
  expect(b.minY).toBeCloseTo(-2.236);
  expect(b.maxY).toBeCloseTo(3);
  expect(
    footprintBounds({ ...d.footprint, graphics: [], pads: [] }),
  ).toBeUndefined();
});

it("never paints KiCad field placeholder text but keeps real annotations", () => {
  const { ctx, texts } = fakeCtx();
  drawGraphics(ctx, [
    { kind: "text", points: [{ x: 1, y: 2 }], width: 0.15, fill: false, text: "${REFERENCE}" },
    { kind: "text", points: [{ x: 3, y: 4 }], width: 0.15, fill: false, text: "220nF" },
  ]);
  expect(texts).toEqual([{ text: "220nF", x: 3, y: 4 }]);
});

it("draws the reference centered above the top edge of the footprint extents", () => {
  const { ctx, texts } = fakeCtx();
  drawFootprint(ctx, createInstance(board(), definition, { x: 0, y: 0 }, "front"), 1, "yellow");
  const label = texts.find((t) => t.text === "U1");
  expect(label).toBeDefined();
  expect(label!.x).toBeCloseTo(5);
  expect(label!.y).toBeCloseTo(-2.486);
  expect(ctx.textAlign).toBe("center");
  expect(ctx.textBaseline).toBe("bottom");
});
