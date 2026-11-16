import type { VisualEditor } from "../visual/model";
// Wire types for the `.pcbre` document schema (v1). These mirror
// src-tauri/src/project/schema.rs; keep both sides in sync.

import { imageToDisplay } from "./boardTransform";

export type ComponentStatus = "unknown" | "identified" | "verified";

export interface Point {
  x: number;
  y: number;
}

export type Shape =
  | { rect: { x: number; y: number; w: number; h: number } }
  | { ellipse: { cx: number; cy: number; rx: number; ry: number } }
  | { polygon: { points: Point[] } };

export interface ComponentType {
  id: string;
  name: string;
  color: string;
  prefix: string;
}

/** Crop rectangle in original image pixels; absent = full image. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Board {
  id: string;
  name: string;
  assetHash: string;
  /** ORIGINAL image dimensions; transforms never rewrite these. */
  width: number;
  height: number;
  crop?: CropRect;
  /** Degrees clockwise; absent = 0. Invariant (validated in Rust): finite
   * and within [0, 360); the UI writes 0.1-degree steps. */
  rotation?: number;
  /** Absent = false; applied in displayed (post-rotation) axes. */
  flipH?: boolean;
  flipV?: boolean;
  /** Percent; absent = 100. */
  scale?: number;
  /** Picture lock; absent = false. */
  locked?: boolean;
  /** Scene placement after the image's crop/rotate/flip/scale transform. */
  sceneX?: number;
  sceneY?: number;
}

export interface MappingTab {
  id: string;
  name: string;
  boardIds: string[];
}

export interface AssetInfo {
  hash: string;
  size: number;
  name: string;
}

export interface Component {
  id: string;
  boardId: string;
  refdes: string;
  typeId: string;
  shape: Shape;
  status: ComponentStatus;
  locked: boolean;
  partNumber?: string;
  value?: string;
  marking?: string;
  pkg?: string;
  manufacturer?: string;
  notes?: string;
  datasheetUrl?: string;
  datasheetHash?: string;
  imageHash?: string;
  imageHashes?: string[];
  /** Display names for component images keyed by asset sha256. Invariant
   * (validated in Rust): at most 64 entries, 64-char lowercase-hex keys,
   * values at most 200 chars - empty string clears a name; the UI passes the
   * complete record and absence leaves it unchanged. Keys do not create blob
   * references: image liveness still flows through imageHashes/imageHash. */
  imageNames?: Record<string, string>;
  description?: string;
  coordinateSpace?: "scene";
  mappingTabId?: string;
}

export interface ProjectDoc {
  visualEditor?: VisualEditor;
  schemaVersion: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  types: ComponentType[];
  boards: Board[];
  components: Component[];
  assets: Record<string, AssetInfo>;
  activeBoardId?: string;
  description?: string;
  mappingTabs?: MappingTab[];
  activeMappingTabId?: string;
}

/** Additive v1 migration. Existing image tabs retain their independent scenes. */
export function normalizeMappingTabs(doc: ProjectDoc): ProjectDoc {
  const next = { ...doc };
  next.mappingTabs = doc.mappingTabs?.length
    ? doc.mappingTabs.map((tab) => ({ ...tab, boardIds: [...tab.boardIds] }))
    : doc.boards.length
      ? doc.boards.map((board) => ({ id: `mapping-${board.id}`, name: board.name, boardIds: [board.id] }))
      : [{ id: "mapping-default", name: "Board 1", boardIds: [] }];
  // Attach ungrouped images from older/additive writers so none become hidden.
  const grouped = new Set(next.mappingTabs.flatMap((tab) => tab.boardIds));
  next.mappingTabs[0].boardIds.push(...doc.boards.filter((board) => !grouped.has(board.id)).map((board) => board.id));
  const active = next.mappingTabs.find((tab) => tab.id === doc.activeMappingTabId)
    ?? next.mappingTabs.find((tab) => doc.activeBoardId && tab.boardIds.includes(doc.activeBoardId))
    ?? next.mappingTabs[0];
  next.activeMappingTabId = active.id;
  next.activeBoardId = active.boardIds.includes(doc.activeBoardId ?? "") ? doc.activeBoardId : active.boardIds[0];
  return normalizeSceneComponents(next);
}

/** Convert historical image-local markings once, preserving their displayed geometry. */
export function normalizeSceneComponents(doc: ProjectDoc): ProjectDoc {
  return { ...doc, components: doc.components.map((component) => {
    if (component.coordinateSpace === "scene") return component;
    const board = doc.boards.find((entry) => entry.id === component.boardId);
    const tab = doc.mappingTabs?.find((entry) => entry.boardIds.includes(component.boardId));
    if (!board || !tab) return component;
    const point = (p: Point) => imageToDisplay(board, p);
    let shape: Shape;
    if ("polygon" in component.shape) {
      shape = { polygon: { points: component.shape.polygon.points.map(point) } };
    } else {
      const rect = "rect" in component.shape ? component.shape.rect : {
        x: component.shape.ellipse.cx - component.shape.ellipse.rx,
        y: component.shape.ellipse.cy - component.shape.ellipse.ry,
        w: component.shape.ellipse.rx * 2, h: component.shape.ellipse.ry * 2,
      };
      const corners = [point({ x: rect.x, y: rect.y }), point({ x: rect.x + rect.w, y: rect.y }), point({ x: rect.x, y: rect.y + rect.h }), point({ x: rect.x + rect.w, y: rect.y + rect.h })];
      const x = Math.min(...corners.map((p) => p.x)), y = Math.min(...corners.map((p) => p.y));
      const w = Math.max(...corners.map((p) => p.x)) - x, h = Math.max(...corners.map((p) => p.y)) - y;
      shape = "rect" in component.shape ? { rect: { x, y, w, h } } : { ellipse: { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 } };
    }
    return { ...component, shape, coordinateSpace: "scene", mappingTabId: tab.id };
  }) };
}

export const UNASSIGNED_TYPE_ID = "unassigned";
export const SCHEMA_VERSION = 1;

/** Types seeded by `project_new`; matches `schema::seed_types` in Rust. */
export const SEED_TYPES: ComponentType[] = [
  { id: "resistor", name: "Resistor", color: "#e5484d", prefix: "R" },
  { id: "capacitor", name: "Capacitor", color: "#4f8fdb", prefix: "C" },
  { id: "inductor", name: "Inductor", color: "#9b6dff", prefix: "L" },
  { id: "diode", name: "Diode", color: "#e08a2e", prefix: "D" },
  { id: "transistor", name: "Transistor", color: "#2fbfa8", prefix: "Q" },
  { id: "ic", name: "IC", color: "#52b788", prefix: "U" },
  { id: "crystal", name: "Crystal", color: "#40c4e0", prefix: "Y" },
  { id: "connector", name: "Connector", color: "#d9a406", prefix: "J" },
  { id: "test-point", name: "Test point", color: "#d8d8d8", prefix: "TP" },
  { id: UNASSIGNED_TYPE_ID, name: "Unassigned", color: "#8a8a8a", prefix: "X" },
];
