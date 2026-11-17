import { describe, expect, it } from "vitest";
import { createVisualActions } from "./actions";
import { initialVisualEditor, layerLabel, MAX_VISUAL_LAYERS, hitVisualImage, makeVisualImage, newVisualPcb, type VisualImage } from "./model";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { fixtureComponent } from "../electrical/testFixtures";

const asset = { hash: "a".repeat(64), size: 42, name: "photo.png" };
function fixture() {
  const doc: ProjectDoc = { schemaVersion: 1, name: "Test", createdAt: "t", updatedAt: "t", types: SEED_TYPES, boards: [], components: [], assets: {}, visualEditor: initialVisualEditor() };
  const actions = createVisualActions(() => doc, (change) => change(doc));
  const add = (name: string) => { actions.addImage(actions.activePcb()!.id, asset, name, 200, 100); return actions.activePcb()!.images.at(-1)!; };
  return { doc, actions, add };
}
describe("visual photograph model", () => {
  it("supports eight-layer capture from either face and repeated physical-layer tags without orientation changes", () => {
    const { actions, add } = fixture(); actions.resizeLayers(8);
    const layers = actions.activePcb()!.layers;
    const front = add("Soldermask"), bare = add("Bare front"), back = add("Back"), inner = add("Inner exposed from back");
    actions.updateImage(front.id, { layerId: layers[0] }); actions.updateImage(bare.id, { layerId: layers[0], opacity: 0.4 });
    actions.updateImage(back.id, { layerId: layers[7], flipH: true }); actions.updateImage(inner.id, { layerId: layers[6], flipH: true, flipV: true });
    expect(front.layerId).toBe(bare.layerId); expect(front.opacity).toBe(1); expect(bare.opacity).toBe(0.4);
    expect(back.flipH).toBe(true); expect(inner.flipV).toBe(true); expect(front.flipH).toBe(false);
    expect(layerLabel(7, 8)).toBe("L8 — Back");
  });
  it("preserves outer layer identities, unassigns removed inners, and supports one-layer transitions", () => {
    const { actions, add } = fixture(); actions.resizeLayers(8);
    const layers = [...actions.activePcb()!.layers], back = add("Back"), removed = add("Inner");
    actions.updateImage(back.id, { layerId: layers[7] }); actions.updateImage(removed.id, { layerId: layers[5] });
    actions.resizeLayers(4); expect(back.layerId).toBe(layers[7]); expect(removed.layerId).toBeUndefined();
    expect(actions.activePcb()!.layers).toEqual([layers[0], layers[1], layers[2], layers[7]]);
    actions.resizeLayers(1); expect(back.layerId).toBe(layers[0]);
    actions.resizeLayers(2); expect(back.layerId).toBe(layers[0]);
    actions.resizeLayers(MAX_VISUAL_LAYERS + 1); expect(actions.activePcb()!.layers).toHaveLength(2);
  });
  it("enforces alignment locks while allowing comparison and card editing", () => {
    const { actions, add } = fixture(); const image = add("Photo");
    actions.updateImage(image.id, { x: 12, y: 20, flipH: true }); actions.updateImage(image.id, { locked: true });
    actions.updateImage(image.id, { x: 200, y: 300, flipH: false, flipV: true, opacity: 0, visible: false, name: "Renamed" });
    expect(image).toMatchObject({ x: 12, y: 20, flipH: true, flipV: false, opacity: 0, visible: false, name: "Renamed" });
    actions.updateImage(image.id, { locked: false }); actions.updateImage(image.id, { x: 200 }); expect(image.x).toBe(200);
  });
  it("reorders paint stack without changing coordinates or tags and isolates PCB deletion", () => {
    const { actions, add, doc } = fixture(); const a = add("A"), b = add("B");
    actions.updateImage(a.id, { x: 23, layerId: actions.activePcb()!.layers[0] }); const before = { ...a };
    actions.reorder(a.id, b.id); expect(actions.activePcb()!.images.map((i) => i.id)).toEqual([b.id, a.id]); expect(a).toEqual(before);
    const first = actions.activePcb()!.id; actions.addPcb(); add("Other"); actions.deletePcb(first);
    expect(actions.activePcb()!.images).toHaveLength(1); expect(doc.boards).toHaveLength(0); expect(doc.assets[asset.hash]).toEqual(asset);
    actions.deletePcb(actions.activePcb()!.id); expect(actions.editor()!.pcbs).toHaveLength(1); expect(actions.activePcb()!.images).toHaveLength(0);
  });
  it("rejects invalid image dimensions, foreign tags and opacity", () => {
    const { actions, add } = fixture(); actions.addImage(actions.activePcb()!.id, asset, "Invalid", 0, 1); expect(actions.activePcb()!.images).toHaveLength(0);
    const image = add("Valid"); actions.updateImage(image.id, { opacity: NaN, layerId: "foreign" }); expect(image.opacity).toBe(1); expect(image.layerId).toBeUndefined();
  });

  it("layer-resize net merge rewrites terminals and schematic alongside copper", () => {
    const { actions } = fixture();
    actions.resizeLayers(3);
    const pcb = actions.activePcb()!;
    const [front, inner] = pcb.layers;
    const netA = { id: "netA", name: "A", color: "#e5484d" };
    const netB = { id: "netB", name: "B", color: "#4f8fdb" };
    pcb.nets = [netA, netB];
    const component = fixtureComponent("c1", "R1");
    component.x = 100;
    component.y = 100;
    component.layerId = front;
    component.terminals = [{ number: "1", netId: "netB" }, { number: "2" }];
    pcb.components = [component];
    // The inner-layer trace lands on pad 1 (world ~(99,100)): forced onto the
    // front layer its connected group spans nets A and B.
    pcb.traces = [{ id: "t1", layerId: inner, points: [{ x: 99, y: 100 }, { x: 140, y: 100 }], width: 2, netId: netA.id }];
    pcb.schematic = {
      units: [],
      wires: [{ id: "w1", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], netId: netB.id }],
      labels: [{ id: "l1", x: 0, y: 0, netId: netB.id }],
    };
    actions.resizeLayers(2, front, netA.id);
    expect(pcb.layers).toHaveLength(2);
    expect(pcb.layers).toContain(front);
    expect(pcb.traces![0].layerId).toBe(front);
    expect(pcb.nets?.map((n) => n.id)).toEqual([netA.id]);
    // The whole plan is committed: terminals and schematic references must
    // not keep pointing at the net the merge deleted.
    expect(pcb.components![0].terminals[0].netId).toBe(netA.id);
    expect(pcb.schematic!.wires[0].netId).toBe(netA.id);
    expect(pcb.schematic!.labels[0].netId).toBe(netA.id);
  });
});

it("hit testing skips hidden and transparent images, but still selects locked images", () => {
  const { add } = fixture(); const bottom = add("Bottom"), top = add("Top");
  const images = [bottom, top];
  expect(hitVisualImage(images, 10, 10)?.id).toBe(top.id);
  top.visible = false; expect(hitVisualImage(images, 10, 10)?.id).toBe(bottom.id);
  top.visible = true; top.opacity = 0; expect(hitVisualImage(images, 10, 10)?.id).toBe(bottom.id);
  top.opacity = 1; top.locked = true; expect(hitVisualImage(images, 10, 10)?.id).toBe(top.id);
  expect(hitVisualImage(images, 210, 10)).toBeUndefined();
  expect(hitVisualImage(images, 10, 10, (image) => image.id === top.id ? 0 : image.opacity)?.id).toBe(bottom.id);
});

it("creates images and PCBs with the legacy shape: no transform or calibration fields", () => {
  const image = makeVisualImage("Photo", asset, 200, 100);
  expect(Object.keys(image).sort()).toEqual(["assetHash", "flipH", "flipV", "height", "id", "locked", "name", "opacity", "visible", "width", "x", "y"]);
  expect(image.crop).toBeUndefined();
  expect(image.rotation).toBeUndefined();
  expect(image.scaleX).toBeUndefined();
  expect(image.scaleY).toBeUndefined();
  expect(image.warp).toBeUndefined();
  expect("pxPerMm" in newVisualPcb()).toBe(false);
  expect("pxPerMm" in initialVisualEditor().pcbs[0]).toBe(false);
});

/** World → source-px mapper for the transform-aware seam. A plain offset is
 * enough here: the seam only consumes the mapped point and the crop rect. */
const offsetSource = (dx: number, dy: number) => (_image: VisualImage, x: number, y: number) => ({ x: x + dx, y: y + dy });

it("checks transform-aware hits against the crop rect in source pixels", () => {
  const { add } = fixture(); const image = add("Photo");
  const images = [image];
  const toSource = offsetSource(50, 40);
  // Without a crop the full source box (200×100) applies.
  expect(hitVisualImage(images, 0, 0, undefined, toSource)?.id).toBe(image.id);
  expect(hitVisualImage(images, 149, 59, undefined, toSource)?.id).toBe(image.id);
  expect(hitVisualImage(images, 151, 61, undefined, toSource)).toBeUndefined();

  image.crop = { x: 50, y: 40, w: 100, h: 60 };
  // Inside the crop rect (boundaries inclusive in source px).
  expect(hitVisualImage(images, 0, 0, undefined, toSource)?.id).toBe(image.id);
  expect(hitVisualImage(images, 50, 20, undefined, toSource)?.id).toBe(image.id);
  expect(hitVisualImage(images, 100, 60, undefined, toSource)?.id).toBe(image.id);
  // Cropped-away corners of the full image are no longer hit-testable…
  expect(hitVisualImage(images, 149, 59, undefined, toSource)).toBeUndefined();
  // …and points past the crop edge miss too.
  expect(hitVisualImage(images, 101, 61, undefined, toSource)).toBeUndefined();
  expect(hitVisualImage(images, -1, 0, undefined, toSource)).toBeUndefined();
  // The default (mapper-less) path keeps the world-rect behavior.
  expect(hitVisualImage(images, 150, 40)?.id).toBe(image.id);
  expect(hitVisualImage(images, 250, 40)).toBeUndefined();
});

it("keeps hidden and transparent exclusions on the transform-aware path while locked images stay hittable", () => {
  const { add } = fixture(); const image = add("Photo");
  const toSource = offsetSource(0, 0);
  image.crop = { x: 10, y: 10, w: 50, h: 50 };
  image.locked = true;
  expect(hitVisualImage([image], 20, 20, undefined, toSource)?.id).toBe(image.id);
  image.visible = false;
  expect(hitVisualImage([image], 20, 20, undefined, toSource)).toBeUndefined();
  image.visible = true; image.opacity = 0;
  expect(hitVisualImage([image], 20, 20, undefined, toSource)).toBeUndefined();
  expect(hitVisualImage([image], 20, 20, (entry) => entry.id === image.id ? 0.5 : entry.opacity, toSource)?.id).toBe(image.id);
});
