import { describe, expect, it } from "vitest";
import { collectPcbIssues } from "./issues";
import { fixtureComponent } from "./electrical/testFixtures";
import type { VisualPcb } from "./visual/model";

const pcb = (): VisualPcb => ({
  id: "board",
  name: "Main",
  layers: ["front", "back"],
  images: [],
  pxPerMm: 10,
});
describe("project issues", () => {
  it("keeps healthy components clear and does not mutate source data", () => {
    const p = pcb();
    p.components = [fixtureComponent()];
    const before = JSON.stringify(p);
    expect(collectPcbIssues(p)).toEqual([]);
    expect(JSON.stringify(p)).toBe(before);
  });
  it("separates invalid library data, assignments and unfinished identification", () => {
    const p = pcb(),
      c = fixtureComponent();
    p.components = [c];
    c.definition.footprint.diagnostics = ["Unsupported arc"];
    c.definition.pinMap["1"] = "missing";
    c.terminals[0] = { number: "1", nc: true, netId: "signal" };
    c.terminals[1] = { number: "2" };
    const rows = collectPcbIssues(p);
    expect(
      rows.some(
        (r) =>
          r.category === "Component issues" &&
          r.severity === "Error" &&
          r.message.includes("missing pad"),
      ),
    ).toBe(true);
    expect(
      rows.some(
        (r) =>
          r.category === "Electrical conflicts" && r.target?.terminal === "1",
      ),
    ).toBe(true);
    expect(
      rows.some(
        (r) => r.severity === "Unfinished" && r.message.includes("unassigned"),
      ),
    ).toBe(true);
    c.definition.symbol = undefined;
    expect(
      collectPcbIssues(p).some((r) => r.message.includes("generic symbol")),
    ).toBe(true);
  });
  it("counts proximity pairs once on the same layer only", () => {
    const p = pcb();
    p.components = [fixtureComponent(), fixtureComponent("r2", "R2")];
    expect(
      collectPcbIssues(p).filter((r) => r.message.includes("overlaps")),
    ).toHaveLength(1);
    p.components[1].layerId = "back";
    expect(collectPcbIssues(p)).toHaveLength(0);
  });
  it("counts endpoints separately, keeps identities stable, and ignores logical membership and zones", () => {
    const p = pcb();
    p.traces = [
      {
        id: "t",
        layerId: "front",
        width: 1,
        netId: "n",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
    ];
    p.zones = [
      {
        id: "z",
        layerId: "front",
        netId: "n",
        points: [
          { x: -10, y: -10 },
          { x: 110, y: -10 },
          { x: 110, y: 10 },
          { x: -10, y: 10 },
        ],
      },
    ];
    const rows = collectPcbIssues(p);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    p.traces[0].points[1].x = 200;
    expect(collectPcbIssues(p).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    p.traces[0].points[1] = { x: 0, y: 0 };
    expect(collectPcbIssues(p)).toHaveLength(0);
  });
  it("closes an endpoint against a via and identifies NC pad contact", () => {
    const p = pcb();
    p.components = [fixtureComponent()];
    p.components[0].terminals[0] = { number: "1", nc: true };
    p.traces = [
      {
        id: "t",
        layerId: "front",
        width: 1,
        points: [
          { x: -10, y: 0 },
          { x: 100, y: 0 },
        ],
      },
    ];
    p.vias = [{ id: "v", x: 100, y: 0, diameter: 4, drill: 1 }];
    // NC pads deliberately do not close physical endpoint indicators.
    expect(
      collectPcbIssues(p).filter((r) => r.category === "Trace issues"),
    ).toHaveLength(1);
    expect(
      collectPcbIssues(p).some((r) => r.message.includes("NC copper contact")),
    ).toBe(true);
  });
});
