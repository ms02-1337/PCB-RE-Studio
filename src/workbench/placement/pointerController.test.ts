import { it, expect, describe } from "vitest";
import type { Component, Shape } from "./projectDoc";
import type { World, Draft } from "./pointerController";
import {
  MIN_SHAPE_SIZE,
  closePolygon,
  cursorForHandle,
  keyDown,
  none,
  pointerDown,
  pointerMove,
  pointerUp,
} from "./pointerController";

const view = { scale: 1, offsetX: 0, offsetY: 0 };

function component(id: string, shape: Shape, locked = false): Component {
  return {
    id,
    boardId: "b1",
    refdes: id.toUpperCase(),
    typeId: "ic",
    shape,
    status: "identified",
    locked,
  };
}

const bigRect = component("r1", { rect: { x: 100, y: 100, w: 80, h: 40 } });
const ellipse = component("e1", { ellipse: { cx: 300, cy: 120, rx: 40, ry: 20 } });
const triangle = component("p1", {
  polygon: { points: [{ x: 400, y: 200 }, { x: 480, y: 200 }, { x: 440, y: 260 }] },
});
const locked = component("l1", { rect: { x: 0, y: 0, w: 50, h: 50 } }, true);

function world(overrides: Partial<World> = {}): World {
  return {
    tool: "select",
    components: [bigRect, ellipse, triangle, locked],
    selectedId: null,
    scale: 1,
    view,
    spaceDown: false,
    ...overrides,
  };
}

const at = (x: number, y: number) => ({ boardPoint: { x, y }, screenPoint: { x, y }, button: 0, shift: false });
const middle = (x: number, y: number) => ({ boardPoint: { x, y }, screenPoint: { x, y }, button: 1, shift: false });

describe("draw tools", () => {
  it("commits rects only at the minimum size", () => {
    let draft: Draft = none;
    const start = pointerDown(draft, at(10, 10), world({ tool: "rect" }));
    draft = start.draft;
    expect(draft.kind).toBe("rect");
    const tiny = pointerMove(draft, at(11, 12), world({ tool: "rect" }));
    expect(tiny.preview).toEqual({ rect: { x: 10, y: 10, w: 1, h: 2 } });
    let up = pointerUp(draft, at(11, 12), world({ tool: "rect" }));
    expect(up.commands).toEqual([]); // below 3 board px → discard

    const bigger = pointerDown(none, at(10, 10), world({ tool: "rect" }));
    draft = bigger.draft;
    up = pointerUp(draft, at(10 + MIN_SHAPE_SIZE, 10 + MIN_SHAPE_SIZE), world({ tool: "rect" }));
    expect(up.commands).toEqual([
      { type: "add", shape: { rect: { x: 10, y: 10, w: MIN_SHAPE_SIZE, h: MIN_SHAPE_SIZE } } },
    ]);
  });

  it("locks squares with Shift while drawing", () => {
    const start = pointerDown(none, { boardPoint: { x: 0, y: 0 }, screenPoint: { x: 0, y: 0 }, button: 0, shift: true }, world({ tool: "rect" }));
    expect(start.draft).toMatchObject({ kind: "rect", shift: true });
    const withShift = (x: number, y: number) => ({ boardPoint: { x, y }, screenPoint: { x, y }, button: 0, shift: true });
    const moved = pointerMove(start.draft, withShift(30, 10), world({ tool: "rect" }));
    expect(moved.preview).toEqual({ rect: { x: 0, y: 0, w: 30, h: 30 } });
    const up = pointerUp(start.draft, withShift(30, 10), world({ tool: "rect" }));
    expect(up.commands[0]).toEqual({ type: "add", shape: { rect: { x: 0, y: 0, w: 30, h: 30 } } });

    const circleStart = pointerDown(none, withShift(0, 0), world({ tool: "ellipse" }));
    const preview = pointerMove(circleStart.draft, withShift(30, 10), world({ tool: "ellipse" })).preview;
    expect(preview).toEqual({ ellipse: { cx: 15, cy: 15, rx: 15, ry: 15 } });
  });

  it("square and circle tools stay constrained without Shift", () => {
    // Square: equal sides even with a very uneven drag and Shift released.
    let start = pointerDown(none, at(0, 0), world({ tool: "square" }));
    expect(start.draft).toMatchObject({ kind: "rect", shift: true, fixed: true });
    let moved = pointerMove(start.draft, at(40, 10), world({ tool: "square" }));
    expect(moved.preview).toEqual({ rect: { x: 0, y: 0, w: 40, h: 40 } });
    let up = pointerUp(start.draft, at(40, 10), world({ tool: "square" }));
    expect(up.commands[0]).toEqual({ type: "add", shape: { rect: { x: 0, y: 0, w: 40, h: 40 } } });

    // Circle: equal radii; the constraint survives Shift-less moves.
    start = pointerDown(none, at(0, 0), world({ tool: "circle" }));
    expect(start.draft).toMatchObject({ kind: "ellipse", shift: true, fixed: true });
    moved = pointerMove(start.draft, at(10, 24), world({ tool: "circle" }));
    expect(moved.preview).toEqual({ ellipse: { cx: 12, cy: 12, rx: 12, ry: 12 } });
    up = pointerUp(start.draft, at(10, 24), world({ tool: "circle" }));
    expect(up.commands[0]).toEqual({ type: "add", shape: { ellipse: { cx: 12, cy: 12, rx: 12, ry: 12 } } });
  });

  it("Escape discards an in-progress shape", () => {
    let { draft } = pointerDown(none, at(5, 5), world({ tool: "ellipse" }));
    draft = pointerMove(draft, at(50, 40), world({ tool: "ellipse" })).draft;
    const cancelled = keyDown(draft, "Escape", world({ tool: "ellipse" }));
    expect(cancelled.draft.kind).toBe("none");
    expect(cancelled.commands).toEqual([]);
  });
});

describe("polygon tool", () => {
  it("appends vertices, rubber-bands, and closes on double-click or Enter", () => {
    let draft = pointerDown(none, at(0, 0), world({ tool: "polygon" })).draft;
    expect(draft).toMatchObject({ kind: "polygon", points: [{ x: 0, y: 0 }] });
    draft = pointerDown(draft, at(10, 0), world({ tool: "polygon" })).draft;
    draft = pointerMove(draft, at(10, 10), world({ tool: "polygon" })).draft;
    expect(draft).toMatchObject({ kind: "polygon", cursor: { x: 10, y: 10 } });
    draft = pointerDown(draft, at(10, 10), world({ tool: "polygon" })).draft;
    // Double-click lands on the same spot; closePolygon dedupes it.
    const closed = closePolygon(draft);
    expect(closed.commands).toEqual([
      {
        type: "add",
        shape: {
          polygon: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
        },
      },
    ]);
    expect(closed.draft.kind).toBe("none");
  });

  it("requires three distinct points to commit", () => {
    let draft = pointerDown(none, at(0, 0), world({ tool: "polygon" })).draft;
    draft = pointerDown(draft, at(5, 5), world({ tool: "polygon" })).draft;
    const closed = closePolygon(draft);
    expect(closed.commands).toEqual([]);
    expect(closed.draft.kind).toBe("none");
  });

  it("Backspace removes the last vertex and Escape cancels", () => {
    let draft = pointerDown(none, at(0, 0), world({ tool: "polygon" })).draft;
    draft = pointerDown(draft, at(10, 0), world({ tool: "polygon" })).draft;
    draft = pointerDown(draft, at(10, 10), world({ tool: "polygon" })).draft;
    const fewer = keyDown(draft, "Backspace", world({ tool: "polygon" }));
    expect(fewer.draft).toMatchObject({ kind: "polygon", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const cancelled = keyDown(fewer.draft, "Escape", world({ tool: "polygon" }));
    expect(cancelled.draft.kind).toBe("none");
  });
});

describe("select tool", () => {
  it("prefers handles of the selected shape over body hits", () => {
    const w = world({ selectedId: "r1" });
    // SE corner handle sits at (180,140); a body point nearby must resize.
    const onHandle = pointerDown(none, at(180, 140), w);
    expect(onHandle.draft.kind).toBe("rectResize");
    expect(onHandle.commands).toEqual([{ type: "cursor", cursor: "nwse-resize" }]);
    const moved = pointerMove(onHandle.draft, at(200, 160), w);
    expect(moved.preview).toEqual({ rect: { x: 100, y: 100, w: 100, h: 60 } });
    const up = pointerUp(onHandle.draft, at(200, 160), w);
    expect(up.commands).toEqual([
      { type: "updateShape", id: "r1", shape: { rect: { x: 100, y: 100, w: 100, h: 60 } } },
    ]);
  });

  it("hits the top-most shape and moves it", () => {
    const w = world();
    const hit = pointerDown(none, at(140, 120), w);
    expect(hit.commands).toContainEqual({ type: "select", id: "r1" });
    expect(hit.draft.kind).toBe("move");
    const moved = pointerMove(hit.draft, at(160, 130), w);
    expect(moved.preview).toEqual({ rect: { x: 120, y: 110, w: 80, h: 40 } });
    const up = pointerUp(hit.draft, at(160, 130), w);
    expect(up.commands).toEqual([
      { type: "updateShape", id: "r1", shape: { rect: { x: 120, y: 110, w: 80, h: 40 } } },
    ]);
  });

  it("clears selection on empty canvas", () => {
    const step = pointerDown(none, at(900, 900), world({ selectedId: "r1" }));
    expect(step.commands).toEqual([{ type: "select", id: null }]);
    expect(step.draft.kind).toBe("none");
  });

  it("locked shapes select but never drag", () => {
    const step = pointerDown(none, at(25, 25), world());
    expect(step.commands).toContainEqual({ type: "select", id: "l1" });
    expect(step.draft.kind).toBe("lockedDrag");
    const moved = pointerMove(step.draft, at(80, 80), world());
    expect(moved.commands).toEqual([{ type: "cursor", cursor: "not-allowed" }]);
    expect(moved.preview).toBeUndefined();
    const up = pointerUp(step.draft, at(80, 80), world());
    expect(up.commands).toEqual([]);
  });

  it("polygon vertex handles drag and edge midpoints insert vertices", () => {
    const w = world({ selectedId: "p1" });
    // Bottom edge midpoint between (480,200) and (440,260) = (460,230).
    const insert = pointerDown(none, at(460, 230), w);
    expect(insert.draft.kind).toBe("vertexDrag");
    if (insert.draft.kind === "vertexDrag") {
      expect(insert.draft.index).toBe(2);
      expect(insert.draft.original).toEqual({
        polygon: { points: [{ x: 400, y: 200 }, { x: 480, y: 200 }, { x: 460, y: 230 }, { x: 440, y: 260 }] },
      });
      const dragged = pointerMove(insert.draft, at(460, 250), w);
      expect(dragged.preview).toEqual({
        polygon: { points: [{ x: 400, y: 200 }, { x: 480, y: 200 }, { x: 460, y: 250 }, { x: 440, y: 260 }] },
      });
      const up = pointerUp(insert.draft, at(460, 250), w);
      expect(up.commands[0]).toMatchObject({ type: "updateShape", id: "p1" });
    }
    // Existing vertex drag.
    const vertex = pointerDown(none, at(400, 200), w);
    expect(vertex.draft.kind).toBe("vertexDrag");
  });

  it("resizes ellipses from extent handles", () => {
    const w = world({ selectedId: "e1" });
    const handle = pointerDown(none, at(340, 120), w);
    expect(handle.draft.kind).toBe("ellipseResize");
    const up = pointerUp(handle.draft, at(370, 120), w);
    expect(up.commands).toEqual([
      { type: "updateShape", id: "e1", shape: { ellipse: { cx: 315, cy: 120, rx: 55, ry: 20 } } },
    ]);
  });

  it("resizes ellipses from corner handles on both axes", () => {
    const w = world({ selectedId: "e1" });
    // SE bbox corner of (cx 300, cy 120, rx 40, ry 20) sits at (340, 140).
    const handle = pointerDown(none, at(340, 140), w);
    expect(handle.draft.kind).toBe("ellipseResize");
    if (handle.draft.kind === "ellipseResize") expect(handle.draft.handle).toBe("se");
    const up = pointerUp(handle.draft, at(360, 150), w);
    expect(up.commands).toEqual([
      { type: "updateShape", id: "e1", shape: { ellipse: { cx: 310, cy: 125, rx: 50, ry: 25 } } },
    ]);
  });

  it("emits direction cursors when a pointer-down starts a resize", () => {
    // Ellipse SE corner resizes both axes.
    const corner = pointerDown(none, at(340, 140), world({ selectedId: "e1" }));
    expect(corner.draft.kind).toBe("ellipseResize");
    expect(corner.commands).toEqual([{ type: "cursor", cursor: "nwse-resize" }]);
    // Rect east handle resizes horizontally only.
    const east = pointerDown(none, at(180, 120), world({ selectedId: "r1" }));
    expect(east.draft.kind).toBe("rectResize");
    expect(east.commands).toEqual([{ type: "cursor", cursor: "ew-resize" }]);
    // A body hit still shows the move cursor; locked targets refuse.
    expect(pointerDown(none, at(140, 120), world()).commands).toContainEqual({ type: "cursor", cursor: "move" });
    expect(pointerDown(none, at(25, 25), world()).commands).toContainEqual({ type: "cursor", cursor: "not-allowed" });
  });

  it("maps every handle name to its direction cursor", () => {
    expect(cursorForHandle("n")).toBe("ns-resize");
    expect(cursorForHandle("s")).toBe("ns-resize");
    expect(cursorForHandle("e")).toBe("ew-resize");
    expect(cursorForHandle("w")).toBe("ew-resize");
    expect(cursorForHandle("nw")).toBe("nwse-resize");
    expect(cursorForHandle("se")).toBe("nwse-resize");
    expect(cursorForHandle("ne")).toBe("nesw-resize");
    expect(cursorForHandle("sw")).toBe("nesw-resize");
  });

  it("discards resizes that collapse below validity", () => {
    const w = world({ selectedId: "r1" });
    const handle = pointerDown(none, at(180, 140), w); // SE handle
    const up = pointerUp(handle.draft, at(100, 100), w); // exactly onto NW → 0×0
    // The rect can invert through zero, but an exact collapse is invalid.
    expect(up.commands).toEqual([]);
  });
});

describe("panning", () => {
  it("middle-drag pans via view commands", () => {
    const step = pointerDown(none, middle(100, 100), world());
    expect(step.draft.kind).toBe("pan");
    const moved = pointerMove(step.draft, at(140, 90), world());
    expect(moved.commands).toEqual([
      { type: "view", view: { scale: 1, offsetX: 40, offsetY: -10 } },
    ]);
    expect(pointerUp(step.draft, at(140, 90), world()).draft.kind).toBe("none");
  });

  it("Space or the Pan tool pans instead of editing", () => {
    expect(pointerDown(none, at(120, 110), world({ spaceDown: true })).draft.kind).toBe("pan");
    expect(pointerDown(none, at(120, 110), world({ tool: "pan" })).draft.kind).toBe("pan");
  });
});

it("Escape clears an existing selection when no draft is active", () => {
  const step = keyDown(none, "Escape", world({ selectedId: "r1" }));
  expect(step.commands).toEqual([{ type: "select", id: null }]);
});

  it("ignored keys keep the draft", () => {
    const draft = pointerDown(none, at(0, 0), world({ tool: "polygon" })).draft;
    const step = keyDown(draft, "q", world({ tool: "polygon" }));
    expect(step.draft).toBe(draft);
    expect(step.commands).toEqual([]);
  });

describe("board-transform-aware worlds", () => {
  // A 90°-rotated, horizontally flipped board: the composite scale is
  // view.scale × board.scale/100 = 2, and image px map to screen px through
  // the transform instead of the plain scale+offset formula.
  const rotatedWorld = (selectedId: string | null): World =>
    world({
      selectedId,
      scale: 2,
      view: { scale: 2, offsetX: 5, offsetY: 7 },
      imageToScreen: (p) => ({ x: -2 * p.y + 5, y: 2 * p.x + 7 }),
    });

  it("hits handles through the imageToScreen mapper", () => {
    const w = rotatedWorld("r1");
    // SE handle of the big rect sits at image (180, 140) → screen (5 − 280, 7 + 360).
    const handleScreen = { x: 5 - 2 * 140, y: 7 + 2 * 180 };
    const input = {
      boardPoint: { x: -1, y: -1 },
      screenPoint: handleScreen,
      button: 0,
      shift: false,
    };
    const step = pointerDown(none, input, w);
    expect(step.draft.kind).toBe("rectResize");
    // Direction cursors apply in rotated worlds too: the SE handle is nwse.
    expect(step.commands).toEqual([{ type: "cursor", cursor: "nwse-resize" }]);
  });

  it("body hits still work in board px with the composite tolerance", () => {
    const w = rotatedWorld(null);
    const step = pointerDown(none, at(140, 120), w);
    expect(step.commands).toContainEqual({ type: "select", id: "r1" });
    expect(step.draft.kind).toBe("move");
  });

  it("polygon vertices hit through the mapper", () => {
    const w = rotatedWorld("p1");
    // Vertex (400, 200) → screen (5 − 400, 7 + 800).
    const step = pointerDown(
      none,
      {
        boardPoint: { x: 0, y: 0 },
        screenPoint: { x: 5 - 2 * 200, y: 7 + 2 * 400 },
        button: 0,
        shift: false,
      },
      w,
    );
    expect(step.draft.kind).toBe("vertexDrag");
  });
});
