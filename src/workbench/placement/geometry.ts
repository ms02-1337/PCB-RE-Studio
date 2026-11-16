// Pure board-space geometry for shapes over the board image. Coordinates are
// board-image pixels, origin top-left, y down.

import type { Point, Shape } from "./projectDoc";

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RectHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
/** Edge extents plus the four bbox corners (same names as RectHandle). */
export type EllipseHandle = "n" | "e" | "s" | "w" | "nw" | "ne" | "se" | "sw";

export function normalizeRect(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Anchor-anchored rect preview; Shift locks a square. */
export function rectFromAnchor(anchor: Point, current: Point, shift: boolean): Shape {
  let end = current;
  if (shift) {
    const dx = current.x - anchor.x;
    const dy = current.y - anchor.y;
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    end = { x: anchor.x + Math.sign(dx || 1) * size, y: anchor.y + Math.sign(dy || 1) * size };
  }
  return { rect: normalizeRect(anchor, end) };
}

/** Anchor-anchored ellipse preview; Shift locks a circle. */
export function ellipseFromAnchor(anchor: Point, current: Point, shift: boolean): Shape {
  const rect = (rectFromAnchor(anchor, current, shift) as { rect: { x: number; y: number; w: number; h: number } }).rect;
  return {
    ellipse: {
      cx: rect.x + rect.w / 2,
      cy: rect.y + rect.h / 2,
      rx: rect.w / 2,
      ry: rect.h / 2,
    },
  };
}

export function bbox(shape: Shape): BBox {
  if ("rect" in shape) {
    return { x: shape.rect.x, y: shape.rect.y, w: shape.rect.w, h: shape.rect.h };
  }
  if ("ellipse" in shape) {
    const { cx, cy, rx, ry } = shape.ellipse;
    return { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 };
  }
  const xs = shape.polygon.points.map((p) => p.x);
  const ys = shape.polygon.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function center(shape: Shape): Point {
  const box = bbox(shape);
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  if ("rect" in shape) {
    return { rect: { ...shape.rect, x: shape.rect.x + dx, y: shape.rect.y + dy } };
  }
  if ("ellipse" in shape) {
    return { ellipse: { ...shape.ellipse, cx: shape.ellipse.cx + dx, cy: shape.ellipse.cy + dy } };
  }
  return {
    polygon: {
      points: shape.polygon.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    },
  };
}

export function pointInPolygon(points: Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const crosses = a.y > point.y !== b.y > point.y;
    if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function nearPolygonEdge(points: Point[], point: Point, tol: number): boolean {
  for (let i = 0; i < points.length; i++) {
    if (distanceToSegment(point, points[i], points[(i + 1) % points.length]) <= tol) {
      return true;
    }
  }
  return false;
}

/** Hit test with tolerance in board pixels (bbox prefilter inside). */
export function shapeHit(shape: Shape, point: Point, tol: number): boolean {
  const box = bbox(shape);
  if (
    point.x < box.x - tol ||
    point.x > box.x + box.w + tol ||
    point.y < box.y - tol ||
    point.y > box.y + box.h + tol
  ) {
    return false;
  }
  if ("rect" in shape) {
    return (
      point.x >= shape.rect.x - tol &&
      point.x <= shape.rect.x + shape.rect.w + tol &&
      point.y >= shape.rect.y - tol &&
      point.y <= shape.rect.y + shape.rect.h + tol
    );
  }
  if ("ellipse" in shape) {
    const { cx, cy, rx, ry } = shape.ellipse;
    const nx = (point.x - cx) / (rx + tol);
    const ny = (point.y - cy) / (ry + tol);
    return nx * nx + ny * ny <= 1;
  }
  return pointInPolygon(shape.polygon.points, point) || nearPolygonEdge(shape.polygon.points, point, tol);
}

export function rectHandlePoints(rect: { x: number; y: number; w: number; h: number }): {
  handle: RectHandle;
  point: Point;
}[] {
  const { x, y, w, h } = rect;
  return [
    { handle: "nw", point: { x, y } },
    { handle: "n", point: { x: x + w / 2, y } },
    { handle: "ne", point: { x: x + w, y } },
    { handle: "e", point: { x: x + w, y: y + h / 2 } },
    { handle: "se", point: { x: x + w, y: y + h } },
    { handle: "s", point: { x: x + w / 2, y: y + h } },
    { handle: "sw", point: { x, y: y + h } },
    { handle: "w", point: { x, y: y + h / 2 } },
  ];
}

export function ellipseHandlePoints(ellipse: {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}): { handle: EllipseHandle; point: Point }[] {
  const { cx, cy, rx, ry } = ellipse;
  return [
    { handle: "n", point: { x: cx, y: cy - ry } },
    { handle: "e", point: { x: cx + rx, y: cy } },
    { handle: "s", point: { x: cx, y: cy + ry } },
    { handle: "w", point: { x: cx - rx, y: cy } },
    { handle: "nw", point: { x: cx - rx, y: cy - ry } },
    { handle: "ne", point: { x: cx + rx, y: cy - ry } },
    { handle: "se", point: { x: cx + rx, y: cy + ry } },
    { handle: "sw", point: { x: cx - rx, y: cy + ry } },
  ];
}

export function polygonVertexPoints(points: Point[]): { index: number; point: Point }[] {
  return points.map((point, index) => ({ index, point }));
}

export function polygonEdgeMidpoints(points: Point[]): { index: number; point: Point }[] {
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    return { index, point: { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 } };
  });
}

export function insertPolygonVertex(points: Point[], edgeIndex: number): Point[] {
  const next = points[(edgeIndex + 1) % points.length];
  const midpoint = {
    x: (points[edgeIndex].x + next.x) / 2,
    y: (points[edgeIndex].y + next.y) / 2,
  };
  return [...points.slice(0, edgeIndex + 1), midpoint, ...points.slice(edgeIndex + 1)];
}

/** True for the four bbox-corner handles (nw/ne/se/sw, two letters). Edge
 * midpoints (n/e/s/w, one letter) are single-axis handles. */
export function isCornerHandle(handle: RectHandle | EllipseHandle): boolean {
  return handle.length === 2;
}

/** Corner resize that keeps the original w:h ratio. The opposite corner stays
 * anchored; the dominant relative delta (|dx|/baseW vs |dy|/baseH) picks the
 * scale and the other axis follows it. Like free resize the drag may invert
 * through zero, so the result is normalized. */
function proportionalResize(
  opposite: Point,
  point: Point,
  baseW: number,
  baseH: number,
): { x: number; y: number; w: number; h: number } {
  const dx = point.x - opposite.x;
  const dy = point.y - opposite.y;
  const scale = Math.max(Math.abs(dx) / baseW, Math.abs(dy) / baseH);
  return normalizeRect(opposite, {
    x: opposite.x + Math.sign(dx || 1) * scale * baseW,
    y: opposite.y + Math.sign(dy || 1) * scale * baseH,
  });
}

/** Rect resize with the opposite side/corner anchored: edge handles move one
 * axis, corner handles keep the w:h ratio. Either way the drag may invert
 * through zero, so the result is normalized. */
export function resizeRect(
  rect: { x: number; y: number; w: number; h: number },
  handle: RectHandle,
  point: Point,
): { x: number; y: number; w: number; h: number } {
  if (isCornerHandle(handle)) {
    const opposite = {
      x: handle.includes("e") ? rect.x : rect.x + rect.w,
      y: handle.includes("s") ? rect.y : rect.y + rect.h,
    };
    return proportionalResize(opposite, point, rect.w, rect.h);
  }
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes("w")) left = point.x;
  if (handle.includes("e")) right = point.x;
  if (handle.includes("n")) top = point.y;
  if (handle.includes("s")) bottom = point.y;
  return normalizeRect({ x: left, y: top }, { x: right, y: bottom });
}

/** Ellipse extent resize: edge handles move one axis, corner handles keep the
 * rx:ry ratio (a circle stays a circle). Like resizeRect the drag may invert
 * through zero, so the bbox is normalized. */
export function resizeEllipse(
  ellipse: { cx: number; cy: number; rx: number; ry: number },
  handle: EllipseHandle,
  point: Point,
): { cx: number; cy: number; rx: number; ry: number } {
  if (isCornerHandle(handle)) {
    const opposite = {
      x: handle.includes("e") ? ellipse.cx - ellipse.rx : ellipse.cx + ellipse.rx,
      y: handle.includes("s") ? ellipse.cy - ellipse.ry : ellipse.cy + ellipse.ry,
    };
    const box = proportionalResize(opposite, point, ellipse.rx * 2, ellipse.ry * 2);
    return {
      cx: box.x + box.w / 2,
      cy: box.y + box.h / 2,
      rx: box.w / 2,
      ry: box.h / 2,
    };
  }
  let top = ellipse.cy - ellipse.ry;
  let bottom = ellipse.cy + ellipse.ry;
  let left = ellipse.cx - ellipse.rx;
  let right = ellipse.cx + ellipse.rx;
  if (handle.includes("n")) top = point.y;
  if (handle.includes("s")) bottom = point.y;
  if (handle.includes("w")) left = point.x;
  if (handle.includes("e")) right = point.x;
  const box = normalizeRect({ x: left, y: top }, { x: right, y: bottom });
  return {
    cx: box.x + box.w / 2,
    cy: box.y + box.h / 2,
    rx: box.w / 2,
    ry: box.h / 2,
  };
}

export function movePolygonVertex(points: Point[], index: number, point: Point): Point[] {
  return points.map((existing, i) => (i === index ? { ...point } : existing));
}

/** A commit-safe polygon has >= 3 points with no duplicates. */
export function polygonIsCommittable(points: Point[]): boolean {
  if (points.length < 3) return false;
  const seen = new Set<string>();
  for (const point of points) {
    const key = `${point.x}:${point.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
