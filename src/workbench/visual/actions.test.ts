import { afterEach, describe, expect, it, vi } from "vitest";
import { createVisualActions, type VisualTransformPatch } from "./actions";
import { initialVisualEditor, type VisualImage } from "./model";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";

const asset = { hash: "a".repeat(64), size: 42, name: "photo.png" };
const identityWarp = { a: 1, b: 0, c: 0, d: 1 };
/** Sorted keys of a freshly added image: every transform field absent. */
const LEGACY_IMAGE_KEYS = ["assetHash", "flipH", "flipV", "height", "id", "locked", "name", "opacity", "visible", "width", "x", "y"];
const shape = (image: VisualImage) => Object.keys(image).sort();

/** Raw-fixture harness (same pattern as model.test.ts): actions mutate the
 * doc in place so field-level semantics can be asserted directly. */
function fixture() {
  const doc: ProjectDoc = { schemaVersion: 1, name: "Test", createdAt: "t", updatedAt: "t", types: SEED_TYPES, boards: [], components: [], assets: {}, visualEditor: initialVisualEditor() };
  const actions = createVisualActions(() => doc, (change) => change(doc));
  const add = (name: string) => { actions.addImage(actions.activePcb()!.id, asset, name, 200, 100); return actions.activePcb()!.images.at(-1)!; };
  return { doc, actions, add };
}

describe("updateImageTransform validation semantics", () => {
  it("ignores the whole patch while an image is locked", () => {
    const { actions, add } = fixture(); const image = add("Photo");
    actions.updateImage(image.id, { locked: true });
    actions.updateImageTransform(image.id, { rotation: 45, scaleX: 2, warp: { a: 2, b: 0, c: 0, d: 1 }, crop: { x: 0, y: 0, w: 50, h: 50 }, x: 9, y: 9 });
    expect(shape(image)).toEqual(LEGACY_IMAGE_KEYS);
    expect(image).toMatchObject({ x: 0, y: 0 });
  });

  it("drops invalid values silently while applying valid keys from the same patch", () => {
    const { actions, add } = fixture(); const image = add("Photo");
    actions.updateImageTransform(image.id, {
      rotation: Number.NaN, scaleX: 0, scaleY: 101, warp: { a: 1, b: 1, c: 1, d: 1 },
      crop: { x: Number.NaN, y: 0, w: 10, h: 10 }, x: Number.POSITIVE_INFINITY, y: 3,
    });
    expect(shape(image)).toEqual(LEGACY_IMAGE_KEYS);
    expect(image.x).toBe(0);
    expect(image.y).toBe(3);
    actions.updateImageTransform(image.id, { rotation: 359.9, scaleX: 100, scaleY: 0.01, warp: { a: -1, b: 0, c: 0, d: 1 } });
    expect(image).toMatchObject({ rotation: 359.9, scaleX: 100, scaleY: 0.01, warp: { a: -1, b: 0, c: 0, d: 1 } });
  });

  it("rejects out-of-range rotation instead of normalizing it", () => {
    const { actions, add } = fixture(); const image = add("Photo");
    for (const rotation of [-10, 360, 370, Number.NEGATIVE_INFINITY]) {
      actions.updateImageTransform(image.id, { rotation });
      expect(image.rotation).toBeUndefined();
    }
    actions.updateImageTransform(image.id, { rotation: 45 });
    actions.updateImageTransform(image.id, { rotation: 359.999999 });
    expect(image.rotation).toBe(359.999999);
  });

  it("rejects non-finite or degenerate warp matrices", () => {
    const { actions, add } = fixture(); const image = add("Photo");
    for (const warp of [{ a: Number.NaN, b: 0, c: 0, d: 1 }, { a: 1, b: 0, c: 0, d: Number.POSITIVE_INFINITY }, identityWarp, { a: 1e-5, b: 0, c: 0, d: 1e-5 }, { a: 0, b: 0, c: 0, d: 1 }]) {
      actions.updateImageTransform(image.id, { warp });
      expect(image.warp).toBeUndefined();
    }
    // Near-identity but detectable and mirrored matrices are accepted.
    actions.updateImageTransform(image.id, { warp: { a: 1, b: 0, c: 0, d: 1 + 1e-9 } });
    expect(image.warp).toEqual({ a: 1, b: 0, c: 0, d: 1 + 1e-9 });
    actions.updateImageTransform(image.id, { warp: { a: -2, b: 0, c: 0, d: 1 } });
    expect(image.warp).toEqual({ a: -2, b: 0, c: 0, d: 1 });
  });

  it("rounds crops to integers and clamps them inside the image", () => {
    const { actions, add } = fixture(); const image = add("Photo");
    actions.updateImageTransform(image.id, { crop: { x: 10.4, y: 20.6, w: 100.2, h: 50.4 } });
    expect(image.crop).toEqual({ x: 10, y: 21, w: 101, h: 50 });
    actions.updateImageTransform(image.id, { crop: { x: 150, y: 50, w: 500, h: 500 } });
    expect(image.crop).toEqual({ x: 150, y: 50, w: 50, h: 50 });
    // Dragged-in-reverse rects normalize to their positive-size equivalent.
    actions.updateImageTransform(image.id, { crop: { x: 100, y: 80, w: -60, h: -40 } });
    expect(image.crop).toEqual({ x: 40, y: 40, w: 60, h: 40 });
    // Crops smaller than 1px after the integer clamp drop the key.
    actions.updateImageTransform(image.id, { crop: { x: 0, y: 0, w: 0.4, h: 80 } });
    expect(image.crop).toEqual({ x: 40, y: 40, w: 60, h: 40 });
    actions.updateImageTransform(image.id, { crop: { x: 500, y: 0, w: 40, h: 80 } });
    expect(image.crop).toEqual({ x: 40, y: 40, w: 60, h: 40 });
    expect(shape(image)).toContain("crop");
  });

  it("deletes fields on identity values so files keep the legacy shape", () => {
    const { actions, add } = fixture(); const image = add("Photo");
    actions.updateImageTransform(image.id, { rotation: 45, scaleX: 2, scaleY: 0.5, warp: { a: 2, b: 0, c: 0, d: 2 }, crop: { x: 10, y: 10, w: 100, h: 50 } });
    expect(shape(image)).toEqual(["assetHash", "crop", "flipH", "flipV", "height", "id", "locked", "name", "opacity", "rotation", "scaleX", "scaleY", "visible", "warp", "width", "x", "y"]);
    actions.updateImageTransform(image.id, { rotation: 0, scaleX: 1, scaleY: 1, warp: identityWarp, crop: { x: 0, y: 0, w: 200, h: 100 } });
    expect(shape(image)).toEqual(LEGACY_IMAGE_KEYS);
    // An over-broad crop clamps to the full image, which is the identity.
    actions.updateImageTransform(image.id, { crop: { x: -20, y: -10, w: 400, h: 300 } });
    expect(image.crop).toBeUndefined();
    // Explicit null resets a field without touching the others.
    actions.updateImageTransform(image.id, { rotation: 12.5, warp: { a: 3, b: 0, c: 0, d: 1 } });
    const reset: VisualTransformPatch = { rotation: null, warp: null };
    actions.updateImageTransform(image.id, reset);
    expect(image.rotation).toBeUndefined();
    expect(image.warp).toBeUndefined();
  });

  it("calibrates the active PCB only for finite positive pxPerMm", () => {
    const { actions, add } = fixture(); add("Photo");
    const pcb = actions.activePcb()!;
    for (const bad of [0, -1.5, Number.NaN, Number.POSITIVE_INFINITY]) actions.calibratePcb(bad);
    expect(pcb.pxPerMm).toBeUndefined();
    actions.calibratePcb(3.78);
    expect(pcb.pxPerMm).toBe(3.78);
    actions.calibratePcb(0.1);
    expect(pcb.pxPerMm).toBe(0.1);
  });
});

describe("store-level transform commits", () => {
  const stores: ReturnType<typeof createPlacementStore>[] = [];
  afterEach(() => { for (const store of stores) store.dispose(); stores.length = 0; vi.restoreAllMocks(); });

  async function setup() {
    const doc: ProjectDoc = { schemaVersion: 1, name: "Test", createdAt: "t", updatedAt: "t", types: SEED_TYPES, boards: [], components: [], assets: {} };
    const store = createPlacementStore({ openProject: async () => ({ doc, assets: {}, path: "C:\\test.pcbre" }), save: vi.fn() });
    stores.push(store);
    await store.openProject("C:\\test.pcbre");
    store.configureAutosave({ enabled: false, delayMs: 2000 });
    store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 200, 100);
    return store;
  }

  it("commits a full transform gesture as exactly one undo entry and restores the pre-gesture values", async () => {
    const store = await setup();
    const image = store.visual.activePcb()!.images[0];
    const patch: VisualTransformPatch = { rotation: 45.5, crop: { x: 10, y: 20, w: 100, h: 50 }, scaleX: 2, scaleY: 0.5, warp: { a: 1.1, b: 0.1, c: -0.05, d: 0.9 }, x: 5, y: 7 };
    // addImage registered a new asset, which cleared history: the transform
    // commit is the first and only undo entry.
    expect(store.canUndo()).toBe(false);
    store.visual.updateImageTransform(image.id, patch);
    expect(store.visual.activePcb()!.images[0]).toMatchObject(patch as Record<string, unknown>);
    store.undo();
    expect(shape(store.visual.activePcb()!.images[0])).toEqual(LEGACY_IMAGE_KEYS);
    expect(store.visual.activePcb()!.images[0]).toMatchObject({ x: 0, y: 0 });
    store.redo();
    expect(store.visual.activePcb()!.images[0]).toMatchObject(patch as Record<string, unknown>);
    store.undo();
    expect(store.canUndo()).toBe(false);
    // A patch whose keys all drop mutates nothing and adds no entry.
    store.visual.updateImageTransform(image.id, { rotation: Number.NaN, scaleX: -1, warp: { a: 0, b: 0, c: 0, d: 0 } });
    expect(store.canUndo()).toBe(false);
    expect(store.visual.activePcb()!.images[0].rotation).toBeUndefined();
  });

  it("creates no history entry when every key of a patch drops or the image is locked", async () => {
    const store = await setup();
    const image = store.visual.activePcb()!.images[0];
    store.visual.updateImageTransform(image.id, { rotation: Number.NaN, scaleX: -3, warp: { a: 0, b: 0, c: 0, d: 0 }, crop: { x: 500, y: 500, w: 0, h: 0 } });
    expect(store.visual.activePcb()!.images[0].rotation).toBeUndefined();
    store.visual.updateImageTransform(image.id, { rotation: 30 });
    store.visual.updateImageTransform(image.id, { rotation: 720, scaleX: 0 });
    store.visual.updateImage(store.visual.activePcb()!.images[0].id, { locked: true });
    store.visual.updateImageTransform(image.id, { rotation: 80 });
    // The out-of-range patch and the locked patch both no-oped: the document
    // still carries rotation 30 behind the lock, and only the rotation
    // commit and the lock toggle created undo entries.
    expect(store.visual.activePcb()!.images[0]).toMatchObject({ rotation: 30, locked: true });
    store.undo();
    expect(store.visual.activePcb()!.images[0]).toMatchObject({ rotation: 30, locked: false });
    store.undo();
    expect(store.visual.activePcb()!.images[0].rotation).toBeUndefined();
    expect(store.canUndo()).toBe(false);
  });

  it("calibrates the active PCB in one undo entry and ignores invalid input", async () => {
    const store = await setup();
    store.visual.calibratePcb(3.78);
    expect(store.visual.activePcb()!.pxPerMm).toBe(3.78);
    store.undo();
    expect(store.visual.activePcb()!.pxPerMm).toBeUndefined();
    expect(store.canUndo()).toBe(false);
    store.visual.calibratePcb(0);
    store.visual.calibratePcb(Number.NaN);
    store.visual.calibratePcb(-2);
    expect(store.visual.activePcb()!.pxPerMm).toBeUndefined();
    expect(store.canUndo()).toBe(false);
  });

  it("keeps transform and calibration fields through a JSON round-trip of store.doc()", async () => {
    const store = await setup();
    const image = store.visual.activePcb()!.images[0];
    store.visual.updateImageTransform(image.id, { rotation: 45.5, crop: { x: 10, y: 20, w: 100, h: 50 }, scaleX: 2, scaleY: 0.5, warp: { a: 1.1, b: 0.1, c: -0.05, d: 0.9 } });
    store.visual.calibratePcb(3.78);
    const snapshot = JSON.parse(JSON.stringify(store.doc())) as ProjectDoc;
    expect(snapshot.visualEditor!.pcbs[0].images[0]).toMatchObject({ rotation: 45.5, crop: { x: 10, y: 20, w: 100, h: 50 }, scaleX: 2, scaleY: 0.5, warp: { a: 1.1, b: 0.1, c: -0.05, d: 0.9 } });
    expect(snapshot.visualEditor!.pcbs[0].pxPerMm).toBe(3.78);
    const reopened = createPlacementStore({ openProject: async () => ({ doc: snapshot, assets: snapshot.assets, path: "C:\\test.pcbre" }) });
    stores.push(reopened);
    await reopened.openProject("C:\\test.pcbre");
    expect(reopened.visual.activePcb()!.images[0]).toMatchObject({ rotation: 45.5, scaleX: 2, scaleY: 0.5, warp: { a: 1.1, b: 0.1, c: -0.05, d: 0.9 } });
    expect(reopened.visual.activePcb()!.pxPerMm).toBe(3.78);
  });
});
