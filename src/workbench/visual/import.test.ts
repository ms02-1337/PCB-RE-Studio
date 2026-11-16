import { afterEach, expect, it, vi } from "vitest";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
const pick = vi.hoisted(() => vi.fn());
vi.mock("../../bridge/dialog", () => ({ pickImageImport: pick }));
function doc(): ProjectDoc { return { schemaVersion: 1, name: "Test", createdAt: "t", updatedAt: "t", types: SEED_TYPES, boards: [], components: [], assets: {} }; }
const result = { path: "C:\\test.pcbre", bytes: 42, blobCount: 1, savedAt: "t" };
const stores: ReturnType<typeof createPlacementStore>[] = [];
afterEach(() => { for (const store of stores) store.dispose(); stores.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup(importAsset = vi.fn(async () => ({ hash: "a".repeat(64), size: 42, name: "photo.png" }))) {
  const save = vi.fn(async (savedDoc: ProjectDoc) => { expect(savedDoc.schemaVersion).toBe(1); return result; });
  const store = createPlacementStore({ openProject: async () => ({ doc: doc(), assets: {}, path: "C:\\test.pcbre" }), save }, { importAsset, readAsset: vi.fn(async () => new ArrayBuffer(0)) });
  stores.push(store); pick.mockResolvedValue("C:\\photo.png"); return { store, save };
}
it("imports into visual only and sends image references through the shared save lifecycle", async () => {
  const close = vi.fn(); vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 200, height: 100, close })));
  const { store, save } = setup(); await store.openProject("C:\\test.pcbre");
  await store.addVisualImageFlow(); expect(close).toHaveBeenCalledOnce(); expect(store.doc()!.boards).toHaveLength(0);
  expect(store.visual.activePcb()!.images[0]).toMatchObject({ width: 200, height: 100, x: 0, y: 0, opacity: 1 });
  await store.saveNow(); expect(save.mock.calls[0][0]).toMatchObject({ visualEditor: { pcbs: [{ images: [{ assetHash: "a".repeat(64) }] }] } });
});
it("discards pending imports when the target PCB changes", async () => {
  let finish!: (value: { hash: string; size: number; name: string }) => void;
  const importAsset = vi.fn(() => new Promise<{ hash: string; size: number; name: string }>((resolve) => { finish = resolve; }));
  const { store } = setup(importAsset); await store.openProject("C:\\test.pcbre");
  const pending = store.addVisualImageFlow(); await vi.waitFor(() => expect(importAsset).toHaveBeenCalled());
  store.visual.addPcb(); finish({ hash: "a".repeat(64), size: 42, name: "photo.png" }); await pending;
  expect(store.visual.editor()!.pcbs.every((pcb) => pcb.images.length === 0)).toBe(true); expect(store.doc()!.assets).toEqual({});
});
it("cancelled and failed imports leave existing photographs intact", async () => {
  const { store } = setup(vi.fn(async () => { throw new Error("Unreadable image"); })); await store.openProject("C:\\test.pcbre");
  pick.mockResolvedValue(null); await store.addVisualImageFlow(); expect(store.visual.activePcb()!.images).toHaveLength(0);
  pick.mockResolvedValue("C:\\photo.png"); await store.addVisualImageFlow(); expect(store.panelError()).toBe("Unreadable image"); expect(store.visual.activePcb()!.images).toHaveLength(0);
});
