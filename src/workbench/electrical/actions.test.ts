import { describe, expect, it } from "vitest";
import { pruneComponentReferences } from "./actions";
import { fixtureComponent } from "./testFixtures";
import type { VisualPcb } from "../visual/model";

function fixture(): VisualPcb {
  return {
    id: "pcb",
    name: "PCB",
    layers: ["front", "back"],
    images: [],
    nets: [{ id: "n1", name: "SIG", color: "#e5484d" }],
    components: [fixtureComponent("r1", "R1"), fixtureComponent("r2", "R2")],
    traces: [
      {
        id: "t1",
        layerId: "front",
        width: 2,
        points: [
          { x: 0, y: 0 },
          { x: 9, y: 0 },
        ],
        startPad: { componentId: "r1", terminal: "1" },
        endPad: { componentId: "r2", terminal: "2" },
      },
    ],
    schematic: {
      units: [{ id: "u1", componentId: "r1", unit: 1, x: 0, y: 0, rotation: 0 }],
      wires: [
        {
          id: "w1",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
          start: { componentId: "r1", terminal: "1" },
        },
        {
          id: "w2",
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 10 },
          ],
          connections: [
            { componentId: "r1", terminal: "2" },
            { componentId: "r2", terminal: "1" },
          ],
        },
      ],
      labels: [
        { id: "l1", x: 0, y: 0, netId: "n1", anchor: { componentId: "r1", terminal: "1" } },
        { id: "l2", x: 5, y: 0, netId: "n1" },
      ],
    },
  };
}

describe("pruneComponentReferences", () => {
  it("strips every reference to the removed components but nothing else", () => {
    const pcb = fixture();
    pruneComponentReferences(pcb, ["r1"]);
    // Trace pad anchors pointing at r1 drop; r2's anchor survives
    expect(pcb.traces![0].startPad).toBeUndefined();
    expect(pcb.traces![0].endPad).toEqual({ componentId: "r2", terminal: "2" });
    // Schematic unit and anchored label for r1 are gone; the free label stays
    expect(pcb.schematic!.units).toEqual([]);
    expect(pcb.schematic!.labels.map((l) => l.id)).toEqual(["l2"]);
    // A wire anchored to a removed terminal is removed entirely, while a
    // mid-wire connection anchor is only filtered out
    expect(pcb.schematic!.wires.map((w) => w.id)).toEqual(["w2"]);
    expect(pcb.schematic!.wires[0].connections).toEqual([
      { componentId: "r2", terminal: "1" },
    ]);
  });

  it("is a no-op for an empty id list", () => {
    const pcb = fixture();
    const before = JSON.parse(JSON.stringify(pcb));
    pruneComponentReferences(pcb, []);
    expect(pcb).toEqual(before);
  });
});
