// Pure pointer/drawing state machine. The stage owns one mutable Draft at a
// time; geometry lives here during drags and commits to the store as a single
// write on pointer-up. Board coordinates in, commands out.

import type { Component, Point, Shape } from "./projectDoc";
import type { Tool } from "./store";
import type { View } from "./view";
import { panBy } from "./view";
import type { EllipseHandle, RectHandle } from "./geometry";
import {
  bbox,
  ellipseFromAnchor,
  ellipseHandlePoints,
  insertPolygonVertex,
  movePolygonVertex,
  moveShape,
  polygonIsCommittable,
  rectFromAnchor,
  rectHandlePoints,
  resizeEllipse,
  resizeRect,
  shapeHit,
} from "./geometry";

export const MIN_SHAPE_SIZE = 3;
export const HIT_TOLERANCE = 6;
const HANDLE_HIT_RADIUS = 4;

export interface PointerInput {
  boardPoint: Point;
  screenPoint: Point;
  button: number;
  shift: boolean;
}

export interface World {
  tool: Tool;
  components: Component[];
  selectedId: string | null;
  /** Composite screen/board scale (view.scale × board.scale/100); keeps the
   * hit tolerance in screen px regardless of the board transform. */
  scale: number;
  view: View;
  spaceDown: boolean;
  /** Image px → screen px through the board transform; when present it
   * replaces the plain scale+offset formula (rotated/flipped boards). */
  imageToScreen?: (point: Point) => Point;
}

export type Draft =
  | { kind: "none" }
  | { kind: "rect"; anchor: Point; current: Point; shift: boolean; fixed?: boolean }
  | { kind: "ellipse"; anchor: Point; current: Point; shift: boolean; fixed?: boolean }
  | { kind: "polygon"; points: Point[]; cursor: Point }
  | { kind: "move"; id: string; original: Shape; startBoard: Point; currentBoard: Point }
  | { kind: "rectResize"; id: string; handle: RectHandle; original: Shape }
  | { kind: "ellipseResize"; id: string; handle: EllipseHandle; original: Shape }
  | { kind: "vertexDrag"; id: string; original: Shape; index: number }
  | { kind: "pan"; lastScreen: Point; origin: View }
  | { kind: "lockedDrag"; id: string };

/** CSS cursors the controller can request. Direction cursors map 1:1 to
 * handle names because the scene itself never rotates. */
export type Cursor =
  | "default"
  | "not-allowed"
  | "move"
  | "crosshair"
  | "nwse-resize"
  | "nesw-resize"
  | "ns-resize"
  | "ew-resize";

export type Command =
  | { type: "select"; id: string | null }
  | { type: "add"; shape: Shape }
  | { type: "updateShape"; id: string; shape: Shape }
  | { type: "view"; view: View }
  | { type: "cursor"; cursor: Cursor };

export interface Step {
  draft: Draft;
  commands: Command[];
  /** Live shape preview while a drag is active. */
  preview?: Shape;
}

export const none: Draft = { kind: "none" };

const tol = (world: World) => HIT_TOLERANCE / Math.max(world.scale, 0.0001);

/** Direction cursor for a rect/ellipse resize handle in screen axes (corner
 * letters pick the diagonal, single letters the axis). */
export function cursorForHandle(handle: RectHandle | EllipseHandle): Cursor {
  const vertical = handle.includes("n") || handle.includes("s");
  const horizontal = handle.includes("e") || handle.includes("w");
  if (vertical && horizontal) {
    return handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize";
  }
  return vertical ? "ns-resize" : "ew-resize";
}

function selected(world: World): Component | undefined {
  return world.components.find((component) => component.id === world.selectedId);
}

function topHit(world: World, point: Point): Component | undefined {
  for (let index = world.components.length - 1; index >= 0; index--) {
    const component = world.components[index];
    if (shapeHit(component.shape, point, tol(world))) return component;
  }
  return undefined;
}

function toScreen(world: World, point: Point): Point {
  if (world.imageToScreen) return world.imageToScreen(point);
  return { x: point.x * world.scale + world.view.offsetX, y: point.y * world.scale + world.view.offsetY };
}

/** Handle hit for the selected, unlocked shape (screen-space radius). */
export function handleHit(world: World, screenPoint: Point): Draft | null {
  const component = selected(world);
  if (!component || component.locked) return null;
  const shape = component.shape;
  if ("rect" in shape) {
    for (const handle of rectHandlePoints(shape.rect)) {
      if (Math.hypot(toScreen(world, handle.point).x - screenPoint.x, toScreen(world, handle.point).y - screenPoint.y) <= HANDLE_HIT_RADIUS) {
        return { kind: "rectResize", id: component.id, handle: handle.handle, original: shape };
      }
    }
  } else if ("ellipse" in shape) {
    for (const handle of ellipseHandlePoints(shape.ellipse)) {
      if (Math.hypot(toScreen(world, handle.point).x - screenPoint.x, toScreen(world, handle.point).y - screenPoint.y) <= HANDLE_HIT_RADIUS) {
        return { kind: "ellipseResize", id: component.id, handle: handle.handle, original: shape };
      }
    }
  } else {
    for (const vertex of shape.polygon.points) {
      const screen = toScreen(world, vertex);
      if (Math.hypot(screen.x - screenPoint.x, screen.y - screenPoint.y) <= HANDLE_HIT_RADIUS) {
        return {
          kind: "vertexDrag",
          id: component.id,
          original: shape,
          index: shape.polygon.points.indexOf(vertex),
        };
      }
    }
    for (let edge = 0; edge < shape.polygon.points.length; edge++) {
      const a = shape.polygon.points[edge];
      const b = shape.polygon.points[(edge + 1) % shape.polygon.points.length];
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const screen = toScreen(world, midpoint);
      if (Math.hypot(screen.x - screenPoint.x, screen.y - screenPoint.y) <= HANDLE_HIT_RADIUS) {
        const points = insertPolygonVertex(shape.polygon.points, edge);
        return {
          kind: "vertexDrag",
          id: component.id,
          original: { polygon: { points } },
          index: edge + 1,
        };
      }
    }
  }
  return null;
}

export function pointerDown(draft: Draft, input: PointerInput, world: World): Step {
  const commands: Command[] = [];
  // Panning wins over everything: middle button, Space, or the Pan tool.
  if (input.button === 1 || world.spaceDown || world.tool === "pan") {
    return { draft: { kind: "pan", lastScreen: input.screenPoint, origin: world.view }, commands };
  }
  if (input.button !== 0) return { draft, commands };

  if (world.tool === "rect" || world.tool === "ellipse" || world.tool === "square" || world.tool === "circle") {
    // Square/Circle are the constrained twins of rect/ellipse: the 1:1 lock
    // stays on for the whole drag (Shift gives the same result transiently).
    const constrained = world.tool === "square" || world.tool === "circle";
    return {
      draft: {
        kind: world.tool === "rect" || world.tool === "square" ? "rect" : "ellipse",
        anchor: input.boardPoint,
        current: input.boardPoint,
        shift: constrained || input.shift,
        ...(constrained ? { fixed: true } : {}),
      } as Extract<Draft, { kind: "rect" | "ellipse" }>,
      commands,
    };
  }
  if (world.tool === "polygon") {
    if (draft.kind === "polygon") {
      return { draft: { ...draft, points: [...draft.points, input.boardPoint] }, commands };
    }
    return { draft: { kind: "polygon", points: [input.boardPoint], cursor: input.boardPoint }, commands };
  }

  // Select tool.
  const handle = handleHit(world, input.screenPoint);
  if (handle) {
    // Starting a resize shows the handle's direction cursor; polygon
    // vertices drag freely, so they keep the move cursor.
    const cursor: Cursor =
      handle.kind === "rectResize" || handle.kind === "ellipseResize"
        ? cursorForHandle(handle.handle)
        : "move";
    return { draft: handle, commands: [{ type: "cursor", cursor }] };
  }
  const hit = topHit(world, input.boardPoint);
  if (hit) {
    commands.push({ type: "select", id: hit.id });
    if (hit.locked) {
      return { draft: { kind: "lockedDrag", id: hit.id }, commands: [...commands, { type: "cursor", cursor: "not-allowed" }] };
    }
    return {
      draft: { kind: "move", id: hit.id, original: hit.shape, startBoard: input.boardPoint, currentBoard: input.boardPoint },
      commands: [...commands, { type: "cursor", cursor: "move" }],
    };
  }
  commands.push({ type: "select", id: null });
  return { draft: none, commands };
}

function draftShape(draft: Draft, input: PointerInput): Shape | undefined {
  switch (draft.kind) {
    case "rect":
      return rectFromAnchor(draft.anchor, input.boardPoint, draft.shift);
    case "ellipse":
      return ellipseFromAnchor(draft.anchor, input.boardPoint, draft.shift);
    case "move":
      return moveShape(
        draft.original,
        input.boardPoint.x - draft.startBoard.x,
        input.boardPoint.y - draft.startBoard.y,
      );
    case "rectResize": {
      const rect = "rect" in draft.original ? draft.original.rect : { x: 0, y: 0, w: 1, h: 1 };
      return { rect: resizeRect(rect, draft.handle, input.boardPoint) };
    }
    case "ellipseResize": {
      const ellipse = "ellipse" in draft.original
        ? draft.original.ellipse
        : { cx: 0, cy: 0, rx: 1, ry: 1 };
      return { ellipse: resizeEllipse(ellipse, draft.handle, input.boardPoint) };
    }
    case "vertexDrag": {
      if (!("polygon" in draft.original)) return undefined;
      return {
        polygon: { points: movePolygonVertex(draft.original.polygon.points, draft.index, input.boardPoint) },
      };
    }
    default:
      return undefined;
  }
}

export function shapeIsValid(shape: Shape | undefined): boolean {
  if (!shape) return false;
  if ("rect" in shape) return shape.rect.w > 0 && shape.rect.h > 0;
  if ("ellipse" in shape) return shape.ellipse.rx > 0 && shape.ellipse.ry > 0;
  return polygonIsCommittable(shape.polygon.points);
}

export function pointerMove(draft: Draft, input: PointerInput, _world: World): Step {
  void _world;
  const commands: Command[] = [];
  switch (draft.kind) {
    case "rect":
    case "ellipse": {
      // `fixed` (Square/Circle tools) keeps the 1:1 constraint locked for the
      // whole drag regardless of the live Shift state.
      const next = { ...draft, current: input.boardPoint, shift: draft.fixed ? true : input.shift };
      return { draft: next, commands, preview: draftShape(next, input) };
    }
    case "polygon":
      return { draft: { ...draft, cursor: input.boardPoint }, commands };
    case "move":
    case "rectResize":
    case "ellipseResize":
    case "vertexDrag":
      return { draft, commands, preview: draftShape(draft, input) };
    case "pan": {
      const view = panBy(draft.origin, input.screenPoint.x - draft.lastScreen.x, input.screenPoint.y - draft.lastScreen.y);
      return { draft, commands: [{ type: "view", view }] };
    }
    case "lockedDrag":
      return { draft, commands: [{ type: "cursor", cursor: "not-allowed" }] };
    default:
      return { draft, commands };
  }
}

export function pointerUp(draft: Draft, input: PointerInput, _world: World): Step {
  void _world;
  const commands: Command[] = [];
  switch (draft.kind) {
    case "rect":
    case "ellipse": {
      const preview = draftShape(draft, input);
      const box = preview ? bbox(preview) : { w: 0, h: 0 };
      if (box.w >= MIN_SHAPE_SIZE && box.h >= MIN_SHAPE_SIZE && preview) {
        commands.push({ type: "add", shape: preview });
      }
      return { draft: none, commands };
    }
    case "move":
    case "rectResize":
    case "ellipseResize":
    case "vertexDrag": {
      const preview = draftShape(draft, input);
      if (shapeIsValid(preview)) commands.push({ type: "updateShape", id: draft.id, shape: preview! });
      return { draft: none, commands };
    }
    default:
      return { draft: none, commands };
  }
}

/** Finishes a polygon draft: >= 3 distinct points commit, otherwise discard. */
export function closePolygon(draft: Draft): Step {
  if (draft.kind !== "polygon") return { draft, commands: [] };
  const commands: Command[] = [];
  const points = draft.points.filter(
    (point, index) => index === draft.points.length - 1 || point.x !== draft.points[index + 1].x || point.y !== draft.points[index + 1].y,
  );
  if (polygonIsCommittable(points)) {
    commands.push({ type: "add", shape: { polygon: { points } } });
  }
  return { draft: none, commands };
}

export function keyDown(draft: Draft, key: string, world: World): Step {
  if (draft.kind === "polygon") {
    if (key === "Enter") return closePolygon(draft);
    if (key === "Backspace") {
      if (draft.points.length <= 1) return { draft: none, commands: [] };
      return { draft: { ...draft, points: draft.points.slice(0, -1) }, commands: [] };
    }
    if (key === "Escape") return { draft: none, commands: [] };
    return { draft, commands: [] };
  }
  if (key === "Escape" && draft.kind !== "none") return { draft: none, commands: [] };
  if (key === "Escape" && world.selectedId) {
    return { draft: none, commands: [{ type: "select", id: null }] };
  }
  return { draft, commands: [] };
}
