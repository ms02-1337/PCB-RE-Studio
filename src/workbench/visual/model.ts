import type { ElectricalComponent, SchematicDocument } from "../electrical/model";
import type { AssetInfo, CropRect, Point } from "../placement/projectDoc";

/** 2x2 linear part in canvas transform order: for ctx.transform(a, b, c, d, …)
 * a point maps x' = a·x + c·y (+ e), y' = b·x + d·y (+ f). */
export interface Warp2 { a: number; b: number; c: number; d: number }

export interface VisualImage {
  id: string; name: string; assetHash: string; width: number; height: number;
  x: number; y: number; flipH: boolean; flipV: boolean; visible: boolean;
  opacity: number; locked: boolean; layerId?: string;
  /** Source-image pixel rect to keep; absent = full image. Cropped-away
   * parts are not rendered or hit-testable but stay in the document and
   * are recoverable by re-cropping wider (non-destructive, like Board.crop). */
  crop?: CropRect;
  /** Degrees clockwise about the crop-rect center; finite [0, 360); absent = 0. */
  rotation?: number;
  /** Per-axis display scale about the crop-rect center; invariant (0, 100]; absent = 1. */
  scaleX?: number; scaleY?: number;
  /** Left-composed affine correction set by 4-point Align (outermost factor of
   * the linear part L = warp · rotation · flip · scale). Absent = identity;
   * validated |det| > 1e-9. Mirrored mappings (negative det) are allowed. */
  warp?: Warp2;
}
export interface CopperNet { id: string; name: string; color: string }
export interface CopperTrace { id: string; layerId: string; points: Point[]; width: number; netId?: string }
export interface CopperZone { id: string; layerId: string; points: Point[]; netId?: string }
export interface CopperVia { id: string; x: number; y: number; diameter: number; drill: number; netId?: string }
export interface VisualPcb { components?: ElectricalComponent[]; schematic?: SchematicDocument; id: string; name: string; layers: string[]; images: VisualImage[]; nets?: CopperNet[]; traces?: CopperTrace[]; zones?: CopperZone[]; vias?: CopperVia[]; /** World px per real mm. */ pxPerMm?: number }
export interface VisualEditor { pcbs: VisualPcb[]; activePcbId: string }
/** Resource ceiling, not a copper-stack preset. */
export const MAX_VISUAL_LAYERS = 1024;
let sequence = 0;
export const visualId = () => `visual-${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
export function newVisualPcb(name = "PCB 1"): VisualPcb {
  return { id: visualId(), name, layers: [visualId(), visualId()], images: [] };
}
export function initialVisualEditor(): VisualEditor {
  const pcb = newVisualPcb();
  return { pcbs: [pcb], activePcbId: pcb.id };
}
export function layerLabel(index: number, count: number): string {
  return `L${index + 1}${count === 1 ? "" : index === 0 ? " — Front" : index === count - 1 ? " — Back" : ""}`;
}
/** Preserve physical outer identities while inserting/removing inner layers. */
export function resizeLayers(pcb: VisualPcb, count: number): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_VISUAL_LAYERS || count === pcb.layers.length) return;
  const old = pcb.layers;
  const front = old[0];
  const back = old.length > 1 ? old[old.length - 1] : visualId();
  const inners = old.slice(1, -1);
  const next = count === 1 ? [front] : [front, ...Array.from({ length: count - 2 }, (_, i) => inners[i] ?? visualId()), back];
  for (const image of pcb.images) {
    if (count === 1 && image.layerId === back) image.layerId = front;
    else if (image.layerId && !next.includes(image.layerId)) delete image.layerId;
  }
  pcb.layers = next;
}
export function makeVisualImage(name: string, asset: AssetInfo, width: number, height: number): VisualImage {
  return { id: visualId(), name, assetHash: asset.hash, width, height, x: 0, y: 0, flipH: false, flipV: false, visible: true, opacity: 1, locked: false };
}
/** Topmost visible image wins; comparison-only images never steal clicks.
 * With a `toSource` mapper (world → source-image px) the test is
 * transform-aware: containment is checked against the image's crop rect
 * (or full box when uncropped) in source pixels. The default keeps the
 * legacy axis-aligned world-rect behavior for untransformed images. */
export function hitVisualImage(images: VisualImage[], x: number, y: number, opacity: (image: VisualImage) => number = (image) => image.opacity, toSource?: (image: VisualImage, x: number, y: number) => Point): VisualImage | undefined {
  return [...images].reverse().find((image) => {
    if (!image.visible || opacity(image) <= 0) return false;
    if (!toSource) return x >= image.x && y >= image.y && x <= image.x + image.width && y <= image.y + image.height;
    const p = toSource(image, x, y);
    const r = image.crop ?? { x: 0, y: 0, w: image.width, h: image.height };
    return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;
  });
}

