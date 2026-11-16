import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
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
