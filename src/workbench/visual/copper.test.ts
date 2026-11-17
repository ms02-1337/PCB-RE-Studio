import { describe, it, expect } from "vitest";
import {
  openTraceEnds,
  layerResizePlan,
  connected,
  inside,
  mergeNets,
  newNet,
  touches,
  validPolygon,
} from "./copper";
import { newVisualPcb, type CopperTrace, type CopperVia } from "./model";
const trace = (id: string, layerId = "front", y = 0): CopperTrace => ({
  id,
  layerId,
  width: 2,
  points: [
    { x: 0, y },
    { x: 20, y },
  ],
});
const via = (id: string, x = 10, y = 0): CopperVia => ({
  id,
  x,
  y,
  diameter: 4,
  drill: 2,
});
describe("copper geometry", () => {
  it("requires a destination and reports nets joined by layer removal", () => {
    const p = newVisualPcb();
    p.layers = ["front", "inner", "back"];
    const a = newNet(p),
      b = newNet(p);
    p.traces = [
      { ...trace("a", "front"), netId: a.id },
      { ...trace("b", "inner"), netId: b.id },
    ];
    expect(layerResizePlan(p, 2)).toBeNull();
    const plan = layerResizePlan(p, 2, "front")!;
    expect(plan.conflicts.sort()).toEqual([a.id, b.id].sort());
    expect(plan.next.traces![1].layerId).toBe("front");
    expect(p.traces[1].layerId).toBe("inner");
  });
  it("joins parallel overlap and tangency, but separates layers", () => {
    expect(touches(trace("a"), trace("b", "front", 2))).toBe(true);
    expect(touches(trace("a"), trace("b", "front", 2.01))).toBe(false);
    expect(touches(trace("a"), trace("b", "back"))).toBe(false);
  });
  it("joins through vias across layers, ignoring zones", () => {
    const p = newVisualPcb();
    p.traces = [trace("a"), trace("b", "back")];
    p.vias = [via("v")];
    p.zones = [
      {
        id: "zone",
        layerId: "front",
        points: [
          { x: -10, y: -10 },
          { x: 30, y: -10 },
          { x: 30, y: 30 },
        ],
      },
    ];
    expect(
      connected(p, ["a"])
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b", "v"]);
  });
  it("does not count copper entirely inside a drill as contact", () => {
    const tiny = {
      ...trace("tiny"),
      width: 0.1,
      points: [
        { x: 9.9, y: 0 },
        { x: 10.1, y: 0 },
      ],
    };
    expect(touches(tiny, via("v"))).toBe(false);
    expect(touches(trace("a"), via("v"))).toBe(true);
  });
  it("validates concave polygons and rejects crossing/degenerate ones", () => {
    expect(
      validPolygon([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ]),
    ).toBe(true);
    expect(
      validPolygon([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 10, y: 0 },
      ]),
    ).toBe(false);
    expect(
      validPolygon([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ]),
    ).toBe(false);
    expect(
      inside({ x: 1, y: 1 }, [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 0, y: 5 },
      ]),
    ).toBe(true);
  });
  it("merges all references retaining survivor identity/color", () => {
    const p = newVisualPcb();
    const a = newNet(p),
      b = newNet(p);
    p.traces = [{ ...trace("t"), netId: a.id }];
    p.zones = [{ id: "z", layerId: "front", netId: a.id, points: [] }];
    mergeNets(p, [a.id, b.id], b.id);
    expect(p.nets).toEqual([b]);
    expect(p.traces[0].netId).toBe(b.id);
    expect(p.zones[0].netId).toBe(b.id);
  });
  it("auto-numbers nets case-insensitively around user-chosen names", () => {
    const p = newVisualPcb();
    newNet(p, "net1"); // user's lowercase name must block auto NET1
    newNet(p, "Net3");
    expect(newNet(p).name).toBe("NET2");
    expect(newNet(p).name).toBe("NET4");
  });
});

it("marks open ends of segmented traces and clears a physically reconnected end", () => {
  const pcb = newVisualPcb();
  const layer = pcb.layers[0];
  pcb.traces = [{id:"a",layerId:layer,width:2,points:[{x:0,y:0},{x:10,y:0},{x:10,y:10}]}];
  expect(openTraceEnds(pcb)).toHaveLength(2);
  pcb.vias = [via("v",10,10)];
  expect(openTraceEnds(pcb).map(e=>e.point)).toEqual([{x:0,y:0}]);
  pcb.vias[0].x = 100;
  expect(openTraceEnds(pcb)).toHaveLength(2);
  pcb.traces.push({id:"b",layerId:pcb.layers[1],width:2,points:[{x:0,y:0},{x:-10,y:0}]});
  expect(openTraceEnds(pcb).filter(e=>e.traceId==="a")).toHaveLength(2);
  pcb.traces[1].layerId = layer;
  expect(openTraceEnds(pcb).filter(e=>e.traceId==="a")).toHaveLength(1);
});

it("shows a loose endpoint after a component pad moves away and clears it on reconnection", () => {
  const pcb = newVisualPcb();
  const layerId = pcb.layers[0];
  pcb.pxPerMm = 1;
  pcb.components = [{id:"c",reference:"J1",value:"",partName:"",x:0,y:0,rotation:0,scale:1,layerId,
    terminals:[{number:"1"}],definition:{id:"d",name:"Connector",partName:"",value:"",referencePrefix:"J",pinMap:{"1":"1"},
      footprint:{id:"f",name:"Pad",source:"",raw:"",diagnostics:[],graphics:[],pads:[{number:"1",x:0,y:0,width:4,height:4,shape:"rect",rotation:0,plated:false,layers:["F.Cu"]}]}}}];
  pcb.traces = [{id:"trace",layerId,width:1,points:[{x:0,y:0},{x:10,y:0},{x:10,y:20}]}];
  expect(openTraceEnds(pcb).map(e=>e.point)).toEqual([{x:10,y:20}]);
  pcb.components[0].x = 20;
  expect(openTraceEnds(pcb)).toHaveLength(2);
  pcb.components[0].x = 0;
  expect(openTraceEnds(pcb)).toHaveLength(1);
});
