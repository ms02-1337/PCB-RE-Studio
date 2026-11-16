import { it, expect } from "vitest";
import {
  bbox,
  center,
  distanceToSegment,
  ellipseFromAnchor,
  ellipseHandlePoints,
  insertPolygonVertex,
  movePolygonVertex,
  moveShape,
  nearPolygonEdge,
  normalizeRect,
  pointInPolygon,
  polygonIsCommittable,
  rectFromAnchor,
  rectHandlePoints,
  resizeEllipse,
  resizeRect,
  shapeHit,
} from "./geometry";

const triangle = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] };

it("normalizes rects in any drag direction", () => {
  expect(normalizeRect({ x: 10, y: 12 }, { x: 4, y: 3 })).toEqual({ x: 4, y: 3, w: 6, h: 9 });
  expect(normalizeRect({ x: 0, y: 0 }, { x: 8, y: 5 })).toEqual({ x: 0, y: 0, w: 8, h: 5 });
});

it("locks squares with Shift while drawing", () => {
  const shape = rectFromAnchor({ x: 0, y: 0 }, { x: 30, y: 10 }, true);
  expect(shape).toEqual({ rect: { x: 0, y: 0, w: 30, h: 30 } });
  const circle = ellipseFromAnchor({ x: 0, y: 0 }, { x: 30, y: 10 }, true);
  expect(circle).toEqual({ ellipse: { cx: 15, cy: 15, rx: 15, ry: 15 } });
  const free = rectFromAnchor({ x: 5, y: 5 }, { x: -5, y: 25 }, false);
  expect(free).toEqual({ rect: { x: -5, y: 5, w: 10, h: 20 } });
});

it("computes bboxes and centers for every shape", () => {
  expect(bbox({ rect: { x: 2, y: 3, w: 8, h: 10 } })).toEqual({ x: 2, y: 3, w: 8, h: 10 });
  expect(bbox({ ellipse: { cx: 10, cy: 20, rx: 3, ry: 5 } })).toEqual({
    x: 7,
    y: 15,
    w: 6,
    h: 10,
  });
  expect(bbox({ polygon: triangle })).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  expect(center({ polygon: triangle })).toEqual({ x: 5, y: 5 });
});

it("moves shapes without mutating them", () => {
  const shape = { rect: { x: 1, y: 1, w: 2, h: 2 } };
  expect(moveShape(shape, 10, 5)).toEqual({ rect: { x: 11, y: 6, w: 2, h: 2 } });
  expect(shape.rect.x).toBe(1);
  expect(moveShape({ polygon: { points: triangle.points } }, 1, 1)).toEqual({
    polygon: { points: [{ x: 1, y: 1 }, { x: 11, y: 1 }, { x: 1, y: 11 }] },
  });
});

it("hit tests rect, ellipse, and polygon with tolerance", () => {
  expect(shapeHit({ rect: { x: 0, y: 0, w: 10, h: 10 } }, { x: -3, y: 5 }, 4)).toBe(true);
  expect(shapeHit({ rect: { x: 0, y: 0, w: 10, h: 10 } }, { x: -7, y: 5 }, 4)).toBe(false);
  expect(shapeHit({ ellipse: { cx: 10, cy: 10, rx: 5, ry: 5 } }, { x: 16, y: 10 }, 2)).toBe(true);
  expect(shapeHit({ ellipse: { cx: 10, cy: 10, rx: 5, ry: 5 } }, { x: 16.5, y: 10 }, 1)).toBe(false);
  expect(shapeHit({ polygon: triangle }, { x: 1, y: 1 }, 0)).toBe(true);
  expect(shapeHit({ polygon: triangle }, { x: 8, y: 8 }, 0)).toBe(false);
  expect(shapeHit({ polygon: triangle }, { x: 5, y: 5 }, 0)).toBe(true);
  // Near-edge tolerance catches outline hits.
  expect(shapeHit({ polygon: triangle }, { x: 5, y: 0.5 }, 1)).toBe(true);
});

it("supports even-odd raycasting and segment distance", () => {
  expect(pointInPolygon(triangle.points, { x: 2, y: 2 })).toBe(true);
  expect(pointInPolygon(triangle.points, { x: 8, y: 8 })).toBe(false);
  expect(pointInPolygon([...triangle.points, { x: 5, y: 5 }], { x: 2, y: 4 })).toBe(false);
  expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  expect(distanceToSegment({ x: 5, y: 3 }, { x: 2, y: 2 }, { x: 2, y: 2 })).toBeCloseTo(
    Math.hypot(3, 1),
  );
  expect(nearPolygonEdge(triangle.points, { x: 20, y: 0 }, 5)).toBe(false);
});

it("resizes rects through zero and normalizes", () => {
  const rect = { x: 10, y: 10, w: 20, h: 20 };
  expect(resizeRect(rect, "e", { x: 60, y: 20 })).toEqual({ x: 10, y: 10, w: 50, h: 20 });
  // Dragging the east edge past the west edge inverts instead of collapsing.
  expect(resizeRect(rect, "e", { x: 0, y: 20 })).toEqual({ x: 0, y: 10, w: 10, h: 20 });
  expect(resizeRect(rect, "nw", { x: 5, y: 5 })).toEqual({ x: 5, y: 5, w: 25, h: 25 });
  expect(resizeRect(rect, "s", { x: 20, y: 2 })).toEqual({ x: 10, y: 2, w: 20, h: 8 });
});

it("resizes ellipse extents with the opposite extent fixed", () => {
  const ellipse = { cx: 10, cy: 10, rx: 5, ry: 5 };
  expect(resizeEllipse(ellipse, "e", { x: 20, y: 10 })).toEqual({
    cx: 12.5,
    cy: 10,
    rx: 7.5,
    ry: 5,
  });
  expect(resizeEllipse(ellipse, "n", { x: 10, y: 25 })).toEqual({
    cx: 10,
    cy: 20,
    rx: 5,
    ry: 5,
  });
  // Corner handles resize both axes at once.
  expect(resizeEllipse(ellipse, "se", { x: 20, y: 25 })).toEqual({
    cx: 12.5,
    cy: 15,
    rx: 7.5,
    ry: 10,
  });
  // Dragging a corner past the opposite one inverts through zero, normalized.
  expect(resizeEllipse(ellipse, "nw", { x: 20, y: 25 })).toEqual({
    cx: 17.5,
    cy: 20,
    rx: 2.5,
    ry: 5,
  });
});

it("exposes handle points for all shapes", () => {
  expect(rectHandlePoints({ x: 0, y: 0, w: 10, h: 10 })).toHaveLength(8);
  expect(rectHandlePoints({ x: 0, y: 0, w: 10, h: 10 })[4]).toEqual({
    handle: "se",
    point: { x: 10, y: 10 },
  });
  // Ellipses carry the four edge extents plus the four bbox corners.
  const ellipse = ellipseHandlePoints({ cx: 10, cy: 10, rx: 5, ry: 5 });
  expect(ellipse.map((h) => h.handle)).toEqual(["n", "e", "s", "w", "nw", "ne", "se", "sw"]);
  expect(ellipse[1].point).toEqual({ x: 15, y: 10 });
  expect(ellipse[7].point).toEqual({ x: 5, y: 15 });
});

it("inserts and moves polygon vertices", () => {
  const grown = insertPolygonVertex(triangle.points, 0);
  expect(grown).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]);
  expect(movePolygonVertex(grown, 1, { x: 6, y: 1 })[1]).toEqual({ x: 6, y: 1 });
});

it("only commits polygons with three distinct points", () => {
  expect(polygonIsCommittable(triangle.points)).toBe(true);
  expect(polygonIsCommittable([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(false);
  expect(
    polygonIsCommittable([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 }]),
  ).toBe(false);
  expect(
    polygonIsCommittable([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 5 }]),
  ).toBe(false);
});
