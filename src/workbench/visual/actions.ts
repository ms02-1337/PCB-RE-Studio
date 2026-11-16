import { isInvertiblePerspective } from "./transform";
import type { Perspective3, VisualEditor, VisualImage, VisualPcb, Warp2 } from "./model";
import { initialVisualEditor, makeVisualImage, newVisualPcb, resizeLayers } from "./model";
import type { AssetInfo, CropRect, ProjectDoc } from "../placement/projectDoc";
import { layerResizePlan, mergeNets } from "./copper";

/** Transform-field patch: `null` deletes the field (reset to identity),
 * `undefined` leaves it untouched, values are validated and default-dropped
 * before mutating. x/y are plain finite-position updates. */
export interface VisualTransformPatch {
  crop?: CropRect | null;
  rotation?: number | null;
  scaleX?: number | null;
  scaleY?: number | null;
  warp?: Warp2 | null;
  perspective?: Perspective3 | null;
  x?: number;
  y?: number;
}

const ROTATION_MAX = 360;
const SCALE_MAX = 100;
const WARP_DET_MIN = 1e-9;
const IDENTITY_EPS = 1e-9;

/** Validated crop: integer rect clamped inside the image; null when it
 * covers the full image (field deleted) or is too small to keep. Any
 * non-finite input drops the key (NaN would survive the size comparison). */
function cleanCrop(image: VisualImage, crop: CropRect | null): CropRect | null | undefined {
  if (crop === null) return null;
  if (![crop.x, crop.y, crop.w, crop.h].every(Number.isFinite)) return undefined;
  const x0 = Math.max(0, Math.min(image.width, Math.round(Math.min(crop.x, crop.x + crop.w))));
  const y0 = Math.max(0, Math.min(image.height, Math.round(Math.min(crop.y, crop.y + crop.h))));
  const x1 = Math.max(0, Math.min(image.width, Math.round(Math.max(crop.x, crop.x + crop.w))));
  const y1 = Math.max(0, Math.min(image.height, Math.round(Math.max(crop.y, crop.y + crop.h))));
  if (x1 - x0 < 1 || y1 - y0 < 1) return undefined; // invalid — mutate nothing
  if (x0 === 0 && y0 === 0 && x1 === image.width && y1 === image.height) return null; // identity
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Validated rotation: finite and inside [0, 360), or null when ≈ 0
 * (identity). Out-of-range values drop the key instead of wrapping —
 * callers (tool gestures) normalize before committing, and Rust would
 * reject the stored value on save. */
function cleanRotation(rotation: number | null): number | null | undefined {
  if (rotation === null) return null;
  if (!Number.isFinite(rotation) || rotation < 0 || rotation >= ROTATION_MAX) return undefined;
  return Math.abs(rotation) < IDENTITY_EPS ? null : rotation;
}

/** Validated per-axis scale in (0, 100], or null when ≈ 1 (identity). */
function cleanScale(scale: number | null): number | null | undefined {
  if (scale === null) return null;
  if (!Number.isFinite(scale) || scale <= 0 || scale > SCALE_MAX) return undefined;
  return Math.abs(scale - 1) < IDENTITY_EPS ? null : scale;
}

/** Validated warp with |det| > 1e-9, or null when ≈ identity. */
function cleanWarp(warp: Warp2 | null): Warp2 | null | undefined {
  if (warp === null) return null;
  const { a, b, c, d } = warp;
  if (![a, b, c, d].every(Number.isFinite)) return undefined;
  if (Math.abs(a * d - b * c) <= WARP_DET_MIN) return undefined;
  const identity = Math.abs(a - 1) < 1e-12 && Math.abs(d - 1) < 1e-12 && Math.abs(b) < 1e-12 && Math.abs(c) < 1e-12;
  return identity ? null : { a, b, c, d };
}

/** Validated perspective (Deskew map), mirroring cleanWarp: null resets;
 * ≈ identity deletes; non-finite coefficients, |det| ≤ 1e-9, or a
 * denominator pole over the photograph (w = 1 + g·x + h·y must stay
 * > 1e-9 at the four image corners) drop the key. */
function cleanPerspective(
  perspective: Perspective3 | null,
  image: VisualImage,
): Perspective3 | null | undefined {
  if (perspective === null) return null;
  const { a, b, c, d, e, f, g, h } = perspective;
  if (![a, b, c, d, e, f, g, h].every(Number.isFinite)) return undefined;
  const det = a * (e - f * h) - b * (d - f * g) + c * (d * h - e * g);
  if (Math.abs(det) <= WARP_DET_MIN) return undefined;
  // invertPerspective divides by the linear part's determinant; a projective
  // map can be invertible as a 3x3 yet have that part singular (numerators
  // collapse onto a line) — reject it too (isInvertiblePerspective).
  if (!isInvertiblePerspective(perspective)) return undefined;
  const corners: Array<[number, number]> = [
    [0, 0],
    [image.width, 0],
    [image.width, image.height],
    [0, image.height],
  ];
  for (const [x, y] of corners)
    if (!(1 + g * x + h * y > WARP_DET_MIN)) return undefined;
  const identity =
    Math.abs(a - 1) < 1e-12 &&
    Math.abs(e - 1) < 1e-12 &&
    [b, c, d, f, g, h].every((value) => Math.abs(value) < 1e-12);
  return identity ? null : { a, b, c, d, e, f, g, h };
}

export function createVisualActions(doc: () => ProjectDoc | null, mutate: (change: (draft: ProjectDoc) => void) => void) {
  const synchronizeMarkings = (draft:ProjectDoc) => { for(const pcb of draft.visualEditor?.pcbs??[])for(const c of pcb.components??[]){if(!c.markingId)continue;const m=draft.components.find(m=>m.id===c.markingId);if(!m){delete c.markingId;continue;}m.refdes=c.reference;m.value=c.value;m.partNumber=c.partName;} };
  const editor = () => doc()?.visualEditor;
  const activePcb = () => editor()?.pcbs.find((pcb) => pcb.id === editor()?.activePcbId);
  const edit = (change: (editor: VisualEditor) => void) => mutate((draft) => { draft.visualEditor ??= initialVisualEditor(); change(draft.visualEditor); synchronizeMarkings(draft); });
  const editPcb = (change: (pcb: VisualPcb) => void) => edit((value) => { const pcb = value.pcbs.find((entry) => entry.id === value.activePcbId); if (pcb) change(pcb); });
  return {
    editor, activePcb,
    replacePcbs: (values: VisualPcb[]) => edit((state) => { for(const value of values){const index=state.pcbs.findIndex(p=>p.id===value.id);if(index>=0)state.pcbs[index]=value;} }),
    replacePcb: (value: VisualPcb) => edit((state) => { const index=state.pcbs.findIndex(p=>p.id===value.id); if(index>=0)state.pcbs[index]=value; }),
    replaceCopper: (pcbId: string, value: Pick<VisualPcb, "nets" | "traces" | "zones" | "vias">) => edit((state) => { const pcb = state.pcbs.find(p => p.id === pcbId); if (pcb) Object.assign(pcb, value); }),
    initialize: () => { if (doc() && !editor()) edit(() => {}); },
    activate: (id: string) => edit((value) => { if (value.pcbs.some((pcb) => pcb.id === id)) value.activePcbId = id; }),
    addPcb: () => edit((value) => { const pcb = newVisualPcb(`PCB ${value.pcbs.length + 1}`); value.pcbs.push(pcb); value.activePcbId = pcb.id; }),
    renamePcb: (id: string, name: string) => { if (name.trim()) edit((value) => { const pcb = value.pcbs.find((entry) => entry.id === id); if (pcb) pcb.name = name.trim(); }); },
    deletePcb: (id: string) => edit((value) => { value.pcbs = value.pcbs.filter((pcb) => pcb.id !== id); if (!value.pcbs.length) value.pcbs.push(newVisualPcb()); if (!value.pcbs.some((pcb) => pcb.id === value.activePcbId)) value.activePcbId = value.pcbs[0].id; }),
    resizeLayers: (count: number, destination?: string, survivor?: string) => editPcb((pcb) => {
      const plan=layerResizePlan(pcb,count,destination); if(!plan)return;
      if(plan.conflicts.length){if(!survivor||!plan.conflicts.includes(survivor))return;mergeNets(plan.next,plan.conflicts,survivor);}
      resizeLayers(pcb,count);
      Object.assign(pcb,{nets:plan.next.nets,traces:plan.next.traces,zones:plan.next.zones,vias:plan.next.vias});
    }),
    addImage: (pcbId: string, asset: AssetInfo, name: string, width: number, height: number) => mutate((draft) => {
      const pcb = draft.visualEditor?.pcbs.find((entry) => entry.id === pcbId);
      if (!pcb || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;
      draft.assets[asset.hash] = asset;
      pcb.images.push(makeVisualImage(name, asset, width, height));
    }),
    updateImage: (id: string, patch: Partial<Omit<VisualImage, "id" | "assetHash" | "width" | "height">>) => editPcb((pcb) => {
      const image = pcb.images.find((entry) => entry.id === id);
      if (!image) return;
      const { x, y, flipH, flipV, crop, rotation, scaleX, scaleY, warp, perspective, ...view } = patch;
      void crop; void rotation; void scaleX; void scaleY; void warp; void perspective; // transforms only via updateImageTransform
      if (view.name !== undefined && !view.name.trim()) delete view.name;
      if (view.opacity !== undefined && (!Number.isFinite(view.opacity) || view.opacity < 0 || view.opacity > 1)) delete view.opacity;
      if (view.layerId !== undefined && view.layerId !== "" && !pcb.layers.includes(view.layerId)) delete view.layerId;
      Object.assign(image, view);
      if (image.layerId === "") delete image.layerId;
      if (!image.locked) {
        if (x !== undefined && Number.isFinite(x)) image.x = x;
        if (y !== undefined && Number.isFinite(y)) image.y = y;
        if (flipH !== undefined) image.flipH = flipH;
        if (flipV !== undefined) image.flipV = flipV;
      }
    }),
    /** Transform-field commit shared by every tool gesture. Ignored entirely
     * while locked (defense in depth behind the disabled buttons); invalid
     * values drop their key silently; identity values delete the field so
     * legacy-shaped files stay minimal. */
    updateImageTransform: (id: string, patch: VisualTransformPatch) => editPcb((pcb) => {
      const image = pcb.images.find((entry) => entry.id === id);
      if (!image || image.locked) return;
      const crop = patch.crop !== undefined ? cleanCrop(image, patch.crop) : undefined;
      const rotation = patch.rotation !== undefined ? cleanRotation(patch.rotation) : undefined;
      const scaleX = patch.scaleX !== undefined ? cleanScale(patch.scaleX) : undefined;
      const scaleY = patch.scaleY !== undefined ? cleanScale(patch.scaleY) : undefined;
      const warp = patch.warp !== undefined ? cleanWarp(patch.warp) : undefined;
      const perspective = patch.perspective !== undefined ? cleanPerspective(patch.perspective, image) : undefined;
      if (crop === undefined && rotation === undefined && scaleX === undefined && scaleY === undefined && warp === undefined
        && perspective === undefined && patch.x === undefined && patch.y === undefined) return;
      if (crop !== undefined) { if (crop === null) delete image.crop; else image.crop = crop; }
      if (rotation !== undefined) { if (rotation === null) delete image.rotation; else image.rotation = rotation; }
      if (scaleX !== undefined) { if (scaleX === null) delete image.scaleX; else image.scaleX = scaleX; }
      if (scaleY !== undefined) { if (scaleY === null) delete image.scaleY; else image.scaleY = scaleY; }
      if (warp !== undefined) { if (warp === null) delete image.warp; else image.warp = warp; }
      if (perspective !== undefined) { if (perspective === null) delete image.perspective; else image.perspective = perspective; }
      if (patch.x !== undefined && Number.isFinite(patch.x)) image.x = patch.x;
      if (patch.y !== undefined && Number.isFinite(patch.y)) image.y = patch.y;
    }),
    /** Set the active PCB's world px-per-mm calibration; finite > 0 only. */
    calibratePcb: (pxPerMm: number) => editPcb((pcb) => {
      if (Number.isFinite(pxPerMm) && pxPerMm > 0) pcb.pxPerMm = pxPerMm;
    }),
    deleteImage: (id: string) => editPcb((pcb) => { pcb.images = pcb.images.filter((image) => image.id !== id); }),
    reorder: (id: string, targetId: string) => editPcb((pcb) => {
      const from = pcb.images.findIndex((image) => image.id === id), to = pcb.images.findIndex((image) => image.id === targetId);
      if (from < 0 || to < 0 || from === to) return;
      const [image] = pcb.images.splice(from, 1); pcb.images.splice(to, 0, image);
    }),
  };
}



