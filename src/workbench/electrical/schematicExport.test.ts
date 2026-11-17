import { expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { buildSchematicFiles, stableUuid } from "./schematicExport";
import { fixtureComponent } from "./testFixtures";
import type { ProjectDoc } from "../placement/projectDoc";
import type { VisualPcb } from "../visual/model";
const project: ProjectDoc = {
  schemaVersion: 1,
  name: "Export fixture",
  createdAt: "t",
  updatedAt: "t",
  types: [],
  boards: [],
  components: [],
  assets: {},
};
function fixture(): VisualPcb {
  return {
    id: "export-fixture",
    name: "Board",
    layers: ["front", "back"],
    images: [],
    nets: [
      { id: "signal", name: "SIGNAL", color: "#ffcd11" },
      { id: "ground", name: "USER_GROUND", color: "#e5484d" },
    ],
    components: [fixtureComponent("r1", "R1"), fixtureComponent("r2", "R2")],
    schematic: {
      units: [
        { id: "u1", componentId: "r1", unit: 1, x: 30, y: 30, rotation: 0 },
        { id: "u2", componentId: "r2", unit: 1, x: 70, y: 30, rotation: 0 },
      ],
      wires: [
        {
          id: "w1",
          points: [
            { x: 25, y: 30 },
            { x: 25, y: 20 },
            { x: 65, y: 20 },
            { x: 65, y: 30 },
          ],
          start: { componentId: "r1", terminal: "1", unit: 1 },
          end: { componentId: "r2", terminal: "1", unit: 1 },
          netId: "signal",
        },
      ],
      labels: [],
    },
  };
}
it("exports deterministic portable KiCad9 files and materializes assigned-net labels", () => {
  const p = fixture(),
    files = buildSchematicFiles(project, p),
    schematic = files.find((f) => f.name.endsWith(".kicad_sch"))!.text;
  expect(buildSchematicFiles(project, p)).toEqual(files);
  expect(stableUuid("test")).toMatch(/^[a-f0-9-]{36}$/);
  expect(schematic).toContain('(label "USER_GROUND"');
  expect(schematic).toContain('(pin "1"');
  expect(schematic).not.toContain("(power)");
  expect(files.find((f) => f.name === "unfinished-work.txt")?.text).toContain(
    "wiring unfinished",
  );
  const output = join(process.cwd(), ".task-snapshots", "kicad-export");
  for (const file of files) {
    const path = join(output, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
  }
  writeFileSync(
    join(output, "expected-nets.json"),
    JSON.stringify(
      { SIGNAL: ["R1.1", "R2.1"], USER_GROUND: ["R1.2", "R2.2"] },
      null,
      2,
    ),
  );
});
it("places junction dots only at strict T-joins, not corners or end-to-end touches", () => {
  const p = fixture();
  p.components = [];
  p.schematic = {
    units: [],
    wires: [
      { id: "wa", points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] },
      // end-to-end with wa at (40,0): connected in KiCad WITHOUT a dot
      { id: "wb", points: [{ x: 40, y: 0 }, { x: 40, y: 30 }] },
      // starts strictly inside wa's segment: a true T-join needing a dot
      { id: "wc", points: [{ x: 10, y: 0 }, { x: 10, y: 25 }] },
      // end-to-end with wa at (0,0) — wa's own corner region, still no dot
      { id: "wd", points: [{ x: 0, y: -20 }, { x: 0, y: 0 }] },
    ],
    labels: [],
  };
  const schematic = buildSchematicFiles(project, p).find((f) => f.name.endsWith(".kicad_sch"))!.text;
  // Exactly one junction: the T at (10,0). The old containment test also
  // dotted every corner/end-to-end touch ((0,0) and (40,0) here).
  expect(schematic.match(/\(junction/g)?.length).toBe(1);
  expect(schematic).toContain("(junction (at 10 0)");
});
it("exports alternate unit bodies and all multi-unit gates", () => {
  const p = fixture(),
    c = p.components![0];
  c.definition.symbol!.units.push({
    unit: 1,
    bodyStyle: 2,
    graphics: [],
    pins: c.definition.symbol!.units[0].pins.map((pin) => ({
      ...pin,
      name: "ALTERNATE",
    })),
  });
  p.schematic!.units[0].bodyStyle = 2;
  expect(buildSchematicFiles(project, p)[0].text).toContain('name "ALTERNATE"');
});
it("blocks contradictory NC or drawn shorts rather than silently changing connectivity", () => {
  const p = fixture();
  p.components![0].terminals[0].nc = true;
  expect(() => buildSchematicFiles(project, p)).toThrow("NC");
  p.components![0].terminals[0].nc = false;
  p.schematic!.wires[0].netId = "ground";
  expect(() => buildSchematicFiles(project, p)).toThrow("shorts");
});
it("preserves multi-unit pin remapping, alternate bodies, explicit hidden power and NC in a portable fixture", () => {
  const p = fixture(),
    c = fixtureComponent("logic", "U1");
  c.definition.referencePrefix = "U";
  c.definition.symbol!.name = "Dual gate";
  c.terminals = [
    { number: "A", netId: "signal" },
    { number: "B", netId: "ground" },
    { number: "C", nc: true },
    { number: "D", netId: "signal" },
    { number: "P", netId: "ground" },
  ];
  c.definition.pinMap = { A: "1", B: "2", C: "3", D: "4", P: "5" };
  const pin = (number: string, x: number, y: number, hidden = false) => ({
    number,
    name: hidden ? "VCC" : `PIN${number}`,
    x,
    y,
    rotation: 0,
    length: 2.54,
    electricalType: hidden ? "power_in" : "passive",
    hidden,
  });
  c.definition.symbol!.units = [
    { unit: 0, bodyStyle: 0, graphics: [], pins: [pin("5", 0, -10, true)] },
    {
      unit: 1,
      bodyStyle: 1,
      graphics: [],
      pins: [pin("1", -5, 0), pin("2", 5, 0)],
    },
    {
      unit: 1,
      bodyStyle: 2,
      graphics: [
        {
          kind: "circle",
          points: [
            { x: 0, y: 0 },
            { x: 2, y: 0 },
          ],
          width: 0.2,
          fill: false,
        },
      ],
      pins: [pin("1", -7.62, 0), pin("2", 7.62, 0)],
    },
    {
      unit: 2,
      bodyStyle: 1,
      graphics: [],
      pins: [pin("3", -5, 0), pin("4", 5, 0)],
    },
  ];
  c.definition.footprint.pads = c.terminals.map((t, i) => ({
    ...c.definition.footprint.pads[0],
    number: t.number,
    x: i * 2,
  }));
  c.scale = 1.2;
  p.components = [c];
  p.schematic = {
    units: [
      {
        id: "gate1",
        componentId: c.id,
        unit: 1,
        x: 40,
        y: 40,
        rotation: 90,
        flip: true,
        bodyStyle: 2,
      },
      { id: "gate2", componentId: c.id, unit: 2, x: 90, y: 40, rotation: 180 },
    ],
    wires: [],
    labels: [],
  };
  const files = buildSchematicFiles(project, p),
    text = files[0].text;
  expect(text).toContain("(unit 2)");
  expect(text).toContain('(pin "A"');
  expect(text).toContain('(pin "P"');
  expect(text).toContain("(no_connect");
  expect(text).not.toContain('(label "VCC"');
  expect(text).toContain("(circle");
  const output = join(process.cwd(), ".task-snapshots", "kicad-export-multi");
  for (const file of files) {
    const path = join(output, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
  }
  writeFileSync(
    join(output, "expected-nets.json"),
    JSON.stringify(
      { SIGNAL: ["U1.A", "U1.D"], USER_GROUND: ["U1.B", "U1.P"], nc: ["U1.C"] },
      null,
      2,
    ),
  );
});
it("does not omit components when the schematic has never been opened", () => {
  const p = fixture();
  delete p.schematic;
  const text = buildSchematicFiles(project, p)[0].text;
  expect(text).toContain('(property "Reference" "R1"');
  expect(text).toContain('(property "Reference" "R2"');
});
const cli = "C:\\Program Files\\KiCad\\9.0\\bin\\kicad-cli.exe";
it.skipIf(!existsSync(cli))(
  "KiCad9 netlist agrees with terminal nets for every rotation and mirror",
  () => {
    const output = join(
      process.cwd(),
      ".task-snapshots",
      "kicad-transform-check",
    );
    mkdirSync(output, { recursive: true });
    for (const rotation of [0, 90, 180, 270])
      for (const flip of [false, true]) {
        const p = fixture();
        p.schematic!.wires = [];
        p.schematic!.units[0].rotation = rotation;
        p.schematic!.units[0].flip = flip;
        const file = buildSchematicFiles(project, p)[0],
          input = join(output, `${rotation}-${flip}.kicad_sch`),
          netlist = join(output, `${rotation}-${flip}.xml`);
        writeFileSync(input, file.text);
        execFileSync(
          cli,
          [
            "sch",
            "export",
            "netlist",
            "--format",
            "kicadxml",
            "--output",
            netlist,
            input,
          ],
          { windowsHide: true, stdio: "pipe" },
        );
        const xml = readFileSync(netlist, "utf8"),
          result: Record<string, string[]> = {};
        for (const match of xml.matchAll(
          /<net\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/net>/g,
        )) {
          if (match[1].includes("unconnected")) continue;
          result[match[1].replace(/^\//, "")] = [
            ...match[2].matchAll(
              /<node\b[^>]*ref="([^"]+)"[^>]*pin="([^"]+)"/g,
            ),
          ]
            .map((m) => `${m[1]}.${m[2]}`)
            .sort();
        }
        expect(result, `${rotation} degrees, mirror ${flip}`).toEqual({
          SIGNAL: ["R1.1", "R2.1"],
          USER_GROUND: ["R1.2", "R2.2"],
        });
      }
  },
  30000,
);
