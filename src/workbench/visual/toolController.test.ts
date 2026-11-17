// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Point } from "../placement/projectDoc";
import type { VisualImage, Warp2 } from "./model";
import { applyPerspective, composeWarpLeft, imageAnchor, normalizeRotation, rotationMatrix, sortQuadCorners, sourceToWorld, worldToSource } from "./transform";
import {
  createVisualToolController,
  type OverlayView,
  type ToolIntent,
  type VisualPointerEvent,
  type VisualToolController,
  type VisualToolId,
  type VisualToolOverlay,
} from "./toolController";

const mkImage = (over: Partial<VisualImage> = {}): VisualImage => ({
  id: "img-1", name: "Photo", assetHash: "a".repeat(64), width: 200, height: 100,
  x: 10, y: 20, flipH: false, flipV: false, visible: true, opacity: 1, locked: false, ...over,
});

const idView: OverlayView = { scale: 1, offsetX: 0, offsetY: 0, flipX: false, flipY: false, width: 800, height: 600 };

const ev = (phase: VisualPointerEvent["phase"], world: [number, number], screen: [number, number], shift = false): VisualPointerEvent =>
  ({ phase, world: { x: world[0], y: world[1] }, screen: { x: screen[0], y: screen[1] }, shift });

const item = <K extends VisualToolOverlay["kind"]>(c: VisualToolController, kind: K) =>
  c.overlay().find((o) => o.kind === kind) as Extract<VisualToolOverlay, { kind: K }> | undefined;

const start = (tool: VisualToolId, image: VisualImage, pxPerMm?: number, view: OverlayView = idView): VisualToolController => {
  const c = createVisualToolController();
  c.update(view);
  expect(c.begin(tool, image, pxPerMm)).toEqual([]);
  return c;
};

const rotOf = (intent: ToolIntent | undefined): number | null | undefined =>
  intent?.kind === "commitRotation" ? intent.patch.rotation : undefined;

const warpOf = (intent: ToolIntent | undefined): Warp2 | undefined =>
  intent?.kind === "commitResize" ? intent.warp : undefined;

describe("controller lifecycle", () => {
  it("rejects locked images for transforms but allows measure", () => {
    const c = createVisualToolController();
    expect(c.begin("rotate", mkImage({ locked: true }), undefined)).toEqual([{ kind: "toast", message: "Image is locked" }]);
    expect(c.tool()).toBeNull();
    expect(c.targetId()).toBeNull();
    expect(c.overlay()).toEqual([]);
    // Measure never mutates the image, so a lock must not block it.
    expect(c.begin("measure", mkImage({ locked: true }), undefined)).toEqual([]);
    expect(c.tool()).toBe("measure");
  });

  it("captures the target at begin, replaces state on re-begin, and exits on Esc", () => {
    const img = mkImage();
    const c = start("measure", img);
    expect(c.tool()).toBe("measure");
    expect(c.targetId()).toBe("img-1");
    c.pointer(ev("down", [30, 40], [30, 40]));
    c.pointer(ev("up", [90, 40], [90, 40]));
    expect(item(c, "measure")).toBeDefined();
    expect(c.begin("measure", img, undefined)).toEqual([]); // re-begin replaces
    expect(item(c, "measure")).toBeUndefined();
    expect(c.tool()).toBe("measure");
    expect(c.begin("align", img, undefined)).toEqual([]); // switching tools replaces too
    expect(c.tool()).toBe("align");
    expect(item(c, "alignMarkers")).toBeDefined();
    expect(c.cancel()).toEqual([]);
    expect(c.tool()).toBeNull();
    expect(c.overlay()).toEqual([]);
  });

  it("is DOM-free: runs under a node environment with no document", () => {
    expect(typeof document).toBe("undefined");
    expect(start("measure", mkImage()).tool()).toBe("measure");
  });
});

describe("measure (AC12)", () => {
  it("press-drag-release keeps a fixed line with px label and calibration hint", () => {
    const c = start("measure", mkImage());
    expect(item(c, "banner")!.text).toBe("MEASURE — drag or click-click; Esc exits");
    c.pointer(ev("down", [30, 40], [30, 40]));
    c.pointer(ev("move", [60, 40], [60, 40]));
    const live = item(c, "measure")!;
    expect(live.a).toEqual({ x: 30, y: 40 });
    expect(live.b).toEqual({ x: 60, y: 40 });
    expect(live.label).toBe("30.0 px");
    expect(live.hint).toBe("Calibrate to show mm");
    expect(live.live).toBe(true);
    expect(c.pointer(ev("up", [90, 40], [90, 40]))).toEqual([]);
    const fixed = item(c, "measure")!;
    expect(fixed.b).toEqual({ x: 90, y: 40 });
    expect(fixed.label).toBe("60.0 px");
    expect(fixed.live).toBe(false);
    // persistence: later motion never disturbs the fixed line
    c.hover({ x: 5, y: 5 });
    c.pointer(ev("move", [5, 5], [5, 5]));
    c.pointer(ev("up", [5, 5], [5, 5]));
    expect(item(c, "measure")!.b).toEqual({ x: 90, y: 40 });
    // a new pointerdown starts a fresh measurement
    c.pointer(ev("down", [10, 10], [10, 10]));
    const fresh = item(c, "measure")!;
    expect(fresh.a).toEqual({ x: 10, y: 10 });
    expect(fresh.live).toBe(true);
  });

  it("click-click: click → line follows hover → click fixes", () => {
    const c = start("measure", mkImage());
    c.pointer(ev("down", [30, 40], [30, 40]));
    c.pointer(ev("up", [31, 40], [31, 40])); // < 3 px → click, enter pending
    const pending = item(c, "measure")!;
    expect(pending.live).toBe(true);
    expect(pending.label).toBe("1.0 px");
    c.hover({ x: 90, y: 40 });
    const following = item(c, "measure")!;
    expect(following.b).toEqual({ x: 90, y: 40 });
    expect(following.label).toBe("60.0 px");
    c.pointer(ev("down", [90, 40], [90, 40])); // second click fixes at the hovered point
    const fixed = item(c, "measure")!;
    expect(fixed.b).toEqual({ x: 90, y: 40 });
    expect(fixed.live).toBe(false);
    c.pointer(ev("up", [90, 40], [90, 40])); // that click's own up must not restart
    expect(item(c, "measure")!.a).toEqual({ x: 30, y: 40 });
  });

  it("resets to empty when a completed span is under 2 world px", () => {
    const c = start("measure", mkImage());
    c.pointer(ev("down", [30, 40], [30, 40]));
    c.pointer(ev("up", [30, 40], [30, 40])); // click → pending
    c.hover({ x: 31, y: 40 });
    c.pointer(ev("down", [31, 40], [31, 40])); // fix at 1 px span → dropped
    expect(item(c, "measure")).toBeUndefined();
    // drag path: screen distance ≥ 3 px but world span < 2 px at 4× zoom
    c.update({ ...idView, scale: 4 });
    c.pointer(ev("down", [30, 40], [120, 160]));
    c.pointer(ev("up", [31, 40], [124, 160]));
    expect(item(c, "measure")).toBeUndefined();
  });

  it("labels mm when calibrated, and uses screen px for the click threshold", () => {
    const c = start("measure", mkImage(), 4);
    c.pointer(ev("down", [30, 40], [30, 40]));
    c.pointer(ev("up", [90, 40], [90, 40]));
    const fixed = item(c, "measure")!;
    expect(fixed.label).toBe("60.0 px = 15.00 mm");
    expect(fixed.hint).toBeUndefined();
    // 2× zoom: 2 screen px of travel is a CLICK even though the world moved 1 px
    c.update({ ...idView, scale: 2 });
    c.pointer(ev("down", [5, 5], [10, 10]));
    c.pointer(ev("up", [6, 5], [12, 10]));
    expect(item(c, "measure")!.live).toBe(true); // pending, not fixed
  });
});

describe("calibrate (AC13)", () => {
  it("prompts on span completion and commits pxPerMm = span/mm; stays for another round", () => {
    const c = start("calibrate", mkImage());
    expect(item(c, "banner")!.text).toBe("CALIBRATE — drag or click-click; Esc exits");
    c.pointer(ev("down", [30, 40], [30, 40]));
    expect(c.pointer(ev("up", [130, 40], [130, 40]))).toEqual([{ kind: "promptCalibrate", spanPx: 100 }]);
    expect(item(c, "measure")).toBeUndefined(); // line cleared immediately
    expect(c.tool()).toBe("calibrate");
    expect(c.modalResult(25)).toEqual([{ kind: "commitCalibrate", pxPerMm: 4 }]); // 100/25
    expect(c.modalResult(0)).toEqual([]);
    expect(c.modalResult(null)).toEqual([]);
    // still active: another measurement prompts again
    c.pointer(ev("down", [10, 10], [10, 10]));
    c.pointer(ev("up", [110, 10], [110, 10]));
    expect(c.modalResult(50)).toEqual([{ kind: "commitCalibrate", pxPerMm: 2 }]);
  });

  it("also prompts from click-click mode and ignores sub-2px spans", () => {
    const c = start("calibrate", mkImage());
    c.pointer(ev("down", [30, 40], [30, 40]));
    c.pointer(ev("up", [30, 40], [30, 40])); // click
    c.hover({ x: 130, y: 40 });
    expect(c.pointer(ev("down", [130, 40], [130, 40]))).toEqual([{ kind: "promptCalibrate", spanPx: 100 }]);
    expect(c.modalResult(null)).toEqual([]);
    c.pointer(ev("down", [30, 40], [30, 40]));
    c.pointer(ev("up", [30.5, 40], [30.5, 40]));
    c.hover({ x: 31, y: 40 });
    expect(c.pointer(ev("down", [31, 40], [31, 40]))).toEqual([]); // 1 px → no prompt
    expect(c.tool()).toBe("calibrate");
  });
});

describe("rotate (AC14)", () => {
  it("shows the gizmo centered on the anchor with a knob on the image's own +x axis", () => {
    const c = start("rotate", mkImage());
    const g = item(c, "rotateGizmo")!;
    expect(g.center).toEqual({ x: 110, y: 70 });
    expect(g.radius).toBe(25); // max(14 screen px, min(200,100)/4)
    expect(g.knob).toEqual({ x: 135, y: 70 });
    expect(g.dragging).toBe(false);
    expect(g.line).toBeUndefined();
  });

  it("knob drag rotates about the center and commits a normalized rotation", () => {
    const c = start("rotate", mkImage());
    c.pointer(ev("down", [135, 70], [135, 70])); // on the knob
    c.pointer(ev("move", [110, 95], [110, 95])); // 90° CCW-screen → +90° canvas
    const dragging = item(c, "rotateGizmo")!;
    expect(dragging.dragging).toBe(true);
    expect(dragging.knob.x).toBeCloseTo(110, 6);
    expect(dragging.knob.y).toBeCloseTo(95, 6);
    const intents = c.pointer(ev("up", [110, 95], [110, 95]));
    expect(intents).toEqual([{ kind: "commitRotation", imageId: "img-1", patch: { rotation: 90 } }]);
    expect(c.tool()).toBe("rotate");
  });

  it("composes into warp when one is present, leaving rotation/flip/scale untouched", () => {
    const warp: Warp2 = { a: 1.1, b: 0.15, c: -0.1, d: 0.95 };
    const c = start("rotate", mkImage({ warp }));
    c.pointer(ev("down", [110, 70], [110, 70], true)); // Shift forces gizmo from anywhere
    c.pointer(ev("move", [110, 95], [110, 95], true));
    const intents = c.pointer(ev("up", [110, 95], [110, 95], true));
    expect(intents).toEqual([{
      kind: "commitRotation", imageId: "img-1",
      patch: { warp: composeWarpLeft(warp, rotationMatrix(90)) }, // no rotation:null
    }]);
  });

  it("commits world-space rotation by the three-branch rule, landing exactly at R(δ)·(old mapping)", () => {
    const gizmoRotate = (over: Partial<VisualImage>, deltaDeg: number): ToolIntent[] => {
      const c = start("rotate", mkImage(over));
      const g = item(c, "rotateGizmo")!;
      const v = { x: g.knob.x - g.center.x, y: g.knob.y - g.center.y };
      const a0 = Math.atan2(v.y, v.x);
      const a1 = a0 + (deltaDeg * Math.PI) / 180;
      const r = Math.hypot(v.x, v.y);
      const p = { x: g.center.x + Math.cos(a1) * r, y: g.center.y + Math.sin(a1) * r };
      c.pointer(ev("down", [g.knob.x, g.knob.y], [g.knob.x, g.knob.y]));
      c.pointer(ev("move", [p.x, p.y], [p.x, p.y]));
      return c.pointer(ev("up", [p.x, p.y], [p.x, p.y]));
    };
    const branches: Array<{ name: string; over: Partial<VisualImage>; delta: number; expectRotation?: boolean; expectWarp?: boolean }> = [
      { name: "a) warp present", over: { warp: { a: 1.1, b: 0.15, c: -0.1, d: 0.95 }, rotation: 37 }, delta: 33, expectWarp: true },
      { name: "b) double flip commutes", over: { flipH: true, flipV: true, rotation: 350 }, delta: 20, expectRotation: true },
      { name: "c) single-axis flip needs a warp", over: { flipH: true, rotation: 30 }, delta: 25, expectWarp: true },
    ];
    for (const branch of branches) {
      const base = mkImage(branch.over);
      const intents = gizmoRotate(branch.over, branch.delta);
      const commit = intents[0];
      expect(commit.kind, branch.name).toBe("commitRotation");
      if (commit.kind !== "commitRotation") throw new Error("unreachable");
      const patch = commit.patch;
      expect(patch.warp !== undefined, branch.name).toBe(branch.expectWarp ?? false);
      expect(patch.rotation !== undefined, branch.name).toBe(branch.expectRotation ?? false);
      if (branch.expectRotation) {
        const rot = patch.rotation!;
        expect(rot, branch.name).toBeGreaterThanOrEqual(0);
        expect(rot, branch.name).toBeLessThan(360);
        expect(rot, branch.name).toBeCloseTo(normalizeRotation((branch.over.rotation ?? 0) + branch.delta), 6);
      }
      // recompute from the patched fields: every source point lands at R(δ) about the anchor
      const patched: VisualImage = { ...base, ...(patch as Partial<VisualImage>) };
      const anchor = imageAnchor(base);
      const R = rotationMatrix(branch.delta);
      for (const [sx, sy] of [[0, 0], [200, 0], [67, 33], [200, 100]] as const) {
        const w = sourceToWorld(base, { x: sx, y: sy });
        const want = {
          x: R.a * (w.x - anchor.x) + R.c * (w.y - anchor.y) + anchor.x,
          y: R.b * (w.x - anchor.x) + R.d * (w.y - anchor.y) + anchor.y,
        };
        const got = sourceToWorld(patched, { x: sx, y: sy });
        expect(Math.abs(got.x - want.x), branch.name).toBeLessThan(1e-6);
        expect(Math.abs(got.y - want.y), branch.name).toBeLessThan(1e-6);
      }
    }
  });

  it("snaps the ABSOLUTE angle to 15° steps only while Shift is held", () => {
    const ten = { x: 110 + 25 * Math.cos(Math.PI / 18), y: 70 + 25 * Math.sin(Math.PI / 18) };
    const c = start("rotate", mkImage());
    c.pointer(ev("down", [135, 70], [135, 70]));
    c.pointer(ev("move", [ten.x, ten.y], [ten.x, ten.y]));
    let intents = c.pointer(ev("up", [ten.x, ten.y], [ten.x, ten.y]));
    expect(rotOf(intents[0])).toBeCloseTo(10, 6); // free: 10°
    c.pointer(ev("down", [135, 70], [135, 70]));
    c.pointer(ev("move", [ten.x, ten.y], [ten.x, ten.y], true));
    intents = c.pointer(ev("up", [ten.x, ten.y], [ten.x, ten.y], true));
    expect(rotOf(intents[0])).toBeCloseTo(15, 6); // snapped: 15°
  });

  it("always emits rotation within [0, 360): 350° + 20° commits 10, not 370", () => {
    const c = start("rotate", mkImage({ rotation: 350 }));
    const knob = item(c, "rotateGizmo")!.knob; // sits at −10° (the image's own axis)
    const v = { x: knob.x - 110, y: knob.y - 70 };
    const rad = (20 * Math.PI) / 180;
    const swung = { x: 110 + v.x * Math.cos(rad) - v.y * Math.sin(rad), y: 70 + v.x * Math.sin(rad) + v.y * Math.cos(rad) };
    c.pointer(ev("down", [knob.x, knob.y], [knob.x, knob.y]));
    c.pointer(ev("move", [swung.x, swung.y], [swung.x, swung.y]));
    const rot = rotOf(c.pointer(ev("up", [swung.x, swung.y], [swung.x, swung.y]))[0])!;
    expect(rot).toBeGreaterThanOrEqual(0);
    expect(rot).toBeLessThan(360);
    expect(rot).toBeCloseTo(10, 6);
  });

  it("level-line drag straightens to the nearest axis with a normalized rotation", () => {
    const c = start("rotate", mkImage());
    c.pointer(ev("down", [30, 40], [30, 40])); // far from the knob, no Shift → line mode
    c.pointer(ev("move", [90, 55], [90, 55]));
    const withLine = item(c, "rotateGizmo")!;
    expect(withLine.line).toBeDefined();
    expect(withLine.line!.a).toEqual({ x: 30, y: 40 });
    expect(withLine.line!.b).toEqual({ x: 90, y: 55 });
    expect(withLine.line!.axis).toBe("horizontal");
    const intents = c.pointer(ev("up", [90, 55], [90, 55]));
    expect(intents).toHaveLength(2);
    expect(intents[0].kind).toBe("commitRotation");
    const rot = rotOf(intents[0])!;
    expect(rot).toBeGreaterThanOrEqual(0);
    expect(rot).toBeLessThan(360); // −14.04° normalized, never negative
    expect(rot).toBeCloseTo(345.964, 3);
    expect(intents[1]).toEqual({ kind: "toast", message: "Straightened to horizontal" });
    // a steep line levels to vertical
    c.pointer(ev("down", [30, 40], [30, 40]));
    const steep = c.pointer(ev("up", [40, 90], [40, 90]));
    expect(rotOf(steep[0])).toBeCloseTo(11.31, 2);
    expect(steep[1]).toEqual({ kind: "toast", message: "Straightened to vertical" });
  });

  it("rejects too-short level lines and no-op knob clicks", () => {
    const c = start("rotate", mkImage());
    c.pointer(ev("down", [30, 40], [30, 40]));
    expect(c.pointer(ev("up", [34, 40], [34, 40]))).toEqual([
      { kind: "toast", message: "Line too short — drag ALONG a feature that should be level" },
    ]);
    expect(c.tool()).toBe("rotate");
    c.pointer(ev("down", [135, 70], [135, 70])); // grab the knob, release without turning
    expect(c.pointer(ev("up", [135, 70], [135, 70]))).toEqual([]);
  });

  it("hit-tests the knob in screen space under a zoomed, X-flipped view", () => {
    const view: OverlayView = { scale: 2, offsetX: 100, offsetY: 50, flipX: true, flipY: false, width: 800, height: 600 };
    const c = start("rotate", mkImage(), undefined, view);
    const knob = item(c, "rotateGizmo")!.knob; // radius 7 at 2× zoom
    const knobScreen = { x: 800 - (knob.x * 2 + 100), y: knob.y * 2 + 50 };
    const moveScreen = { x: 800 - (110 * 2 + 100), y: 95 * 2 + 50 };
    c.pointer(ev("down", [knob.x, knob.y], [knobScreen.x, knobScreen.y]));
    c.pointer(ev("move", [110, 95], [moveScreen.x, moveScreen.y]));
    const intents = c.pointer(ev("up", [110, 95], [moveScreen.x, moveScreen.y]));
    expect(rotOf(intents[0])).toBeCloseTo(90, 6);
  });
});

describe("align (AC15)", () => {
  const click = (c: VisualToolController, p: [number, number]): ToolIntent[] => {
    c.pointer(ev("down", p, p));
    return c.pointer(ev("up", p, p));
  };
  const A = { a: 2, b: 0.1, c: -0.2, d: 1.5 };
  const moving: Point[] = [{ x: 30, y: 40 }, { x: 150, y: 40 }, { x: 150, y: 100 }, { x: 30, y: 100 }];
  const refs = moving.map((p) => ({ x: A.a * p.x + A.c * p.y + 5, y: A.b * p.x + A.d * p.y - 7 }));

  it("collects 4 moving then 4 reference markers, then commits and exits", () => {
    const c = start("align", mkImage());
    expect(item(c, "banner")!.text).toBe("click feature 1/4 on Photo");
    expect(item(c, "alignMarkers")!.points).toEqual([]);
    expect(item(c, "alignMarkers")!.loupe).toBeNull();
    c.hover({ x: 55, y: 66 }); // loupe follows the cursor
    expect(item(c, "alignMarkers")!.loupe).toEqual({ at: { x: 55, y: 66 } });
    for (let i = 0; i < 3; i++) click(c, [moving[i].x, moving[i].y]);
    expect(item(c, "banner")!.text).toBe("click feature 4/4 on Photo");
    click(c, [moving[3].x, moving[3].y]);
    expect(item(c, "banner")!.text).toBe("now click matching feature 1/4 on the base image");
    const points = item(c, "alignMarkers")!.points;
    expect(points.map((m) => m.phase)).toEqual(["moving", "moving", "moving", "moving"]);
    expect(points[2]).toEqual({ p: { x: 150, y: 100 }, index: 3, phase: "moving" });
    for (let i = 0; i < 3; i++) click(c, [refs[i].x, refs[i].y]);
    expect(item(c, "banner")!.text).toBe("now click matching feature 4/4 on the base image");
    expect(item(c, "alignMarkers")!.points[5]).toEqual({ p: refs[1], index: 2, phase: "reference" });
    const intents = c.pointer(ev("down", [refs[3].x, refs[3].y], [refs[3].x, refs[3].y])); // 8th click commits
    c.pointer(ev("up", [refs[3].x, refs[3].y], [refs[3].x, refs[3].y]));
    expect(intents).toHaveLength(2);
    const commit = intents[0];
    if (commit.kind !== "commitAlign") throw new Error("expected commitAlign");
    expect(commit.imageId).toBe("img-1");
    expect(commit.residualPx).toBeLessThan(1e-9);
    expect(Object.keys(commit.patch).sort()).toEqual(["warp", "x", "y"]); // other fields untouched
    expect(commit.patch.warp!.a).toBeCloseTo(A.a, 9);
    expect(commit.patch.warp!.b).toBeCloseTo(A.b, 9);
    expect(commit.patch.warp!.c).toBeCloseTo(A.c, 9);
    expect(commit.patch.warp!.d).toBeCloseTo(A.d, 9);
    expect(commit.patch.x).toBeCloseTo(111, 6); // anchor (110,70) under A + (5,−7), minus crop center (100,50)
    expect(commit.patch.y).toBeCloseTo(59, 6);
    expect(intents[1]).toEqual({ kind: "toast", message: "Aligned (max residual 0.0 px)" });
    expect(c.tool()).toBeNull(); // exits after committing
    // composition property: the clicked features land on the references through the patched transform
    const patched: VisualImage = { ...mkImage(), x: commit.patch.x, y: commit.patch.y, warp: commit.patch.warp };
    for (let i = 0; i < 4; i++) {
      const landed = sourceToWorld(patched, worldToSource(mkImage(), moving[i]));
      expect(Math.hypot(landed.x - refs[i].x, landed.y - refs[i].y)).toBeLessThan(1e-6);
    }
    expect(patched.rotation).toBeUndefined(); // untouched fields stay untouched
    expect(patched.flipH).toBe(false);
  });

  it("left-composes onto an existing warp", () => {
    const base: Warp2 = { a: 0.9, b: 0.2, c: -0.15, d: 1.1 };
    const c = start("align", mkImage({ warp: base }));
    for (const p of moving) click(c, [p.x, p.y]);
    for (let i = 0; i < 3; i++) click(c, [refs[i].x, refs[i].y]);
    const final = c.pointer(ev("down", [refs[3].x, refs[3].y], [refs[3].x, refs[3].y]));
    const commit = final[0];
    if (commit.kind !== "commitAlign") throw new Error("expected commitAlign");
    const expected = composeWarpLeft(base, { a: A.a, b: A.b, c: A.c, d: A.d });
    expect(commit.patch.warp!.a).toBeCloseTo(expected.a, 9);
    expect(commit.patch.warp!.b).toBeCloseTo(expected.b, 9);
    expect(commit.patch.warp!.c).toBeCloseTo(expected.c, 9);
    expect(commit.patch.warp!.d).toBeCloseTo(expected.d, 9);
  });

  it("aligns flipped images: clicked features still land on the references (AC9 under the new order)", () => {
    const base = mkImage({ flipH: true, flipV: true, rotation: 37.2 });
    const c = start("align", base);
    for (const p of moving) click(c, [p.x, p.y]);
    for (let i = 0; i < 3; i++) click(c, [refs[i].x, refs[i].y]);
    const intents = c.pointer(ev("down", [refs[3].x, refs[3].y], [refs[3].x, refs[3].y]));
    const commit = intents[0];
    if (commit.kind !== "commitAlign") throw new Error("expected commitAlign");
    expect(commit.residualPx).toBeLessThan(1e-9);
    const patched: VisualImage = { ...base, x: commit.patch.x, y: commit.patch.y, warp: commit.patch.warp };
    for (let i = 0; i < 4; i++) {
      const landed = sourceToWorld(patched, worldToSource(base, moving[i]));
      expect(Math.hypot(landed.x - refs[i].x, landed.y - refs[i].y)).toBeLessThan(1e-6);
    }
    expect(patched.flipH).toBe(true); // flip/rotation fields survive alignment untouched
    expect(patched.rotation).toBeCloseTo(37.2, 9);
  });

  it("aborts degenerate (collinear) points with a toast and resets the markers", () => {
    const c = start("align", mkImage());
    for (const [x] of [[30], [60], [90], [120]] as const) click(c, [x, 40]);
    for (const [x] of [[30], [60], [90]] as const) click(c, [x, 55]);
    const intents = c.pointer(ev("down", [120, 55], [120, 55]));
    expect(intents).toEqual([{ kind: "toast", message: "Points are collinear — alignment aborted" }]);
    expect(item(c, "alignMarkers")!.points).toEqual([]); // markers reset, still in tool
    expect(item(c, "banner")!.text).toBe("click feature 1/4 on Photo");
    expect(c.tool()).toBe("align");
    expect(c.cancel()).toEqual([]); // Esc exits
    expect(c.tool()).toBeNull();
  });

  it("aborts collinear REFERENCE points instead of committing a singular align", () => {
    const c = start("align", mkImage());
    // Non-degenerate moving quad, collinear reference quad: solveAffine
    // succeeds on the source side but the affine is singular — that must not
    // half-commit as a warp-less translation with a success toast.
    for (const [x, y] of [[30, 40], [60, 40], [60, 70], [30, 70]] as const) click(c, [x, y]);
    for (const [x] of [[130], [160], [190]] as const) click(c, [x, 55]);
    const intents = c.pointer(ev("down", [220, 55], [220, 55]));
    expect(intents).toEqual([{ kind: "toast", message: "Reference points are collinear — alignment aborted" }]);
    expect(item(c, "alignMarkers")!.points).toEqual([]);
    expect(c.tool()).toBe("align");
  });
});

describe("crop (AC16)", () => {
  it("drags in the image's own source pixels and commits an integer rect", () => {
    const c = start("crop", mkImage());
    c.pointer(ev("down", [50, 60], [50, 60])); // source (40,40)
    c.pointer(ev("move", [110, 120], [110, 120])); // source (100,100)
    expect(item(c, "cropPreview")!.polygon).toEqual([
      { x: 50, y: 60 }, { x: 110, y: 60 }, { x: 110, y: 120 }, { x: 50, y: 120 },
    ]);
    expect(c.pointer(ev("up", [110, 120], [110, 120]))).toEqual([
      { kind: "commitCrop", imageId: "img-1", patch: { crop: { x: 40, y: 40, w: 60, h: 60 }, x: 10, y: 20 } },
    ]);
    expect(c.tool()).toBeNull();
  });

  it("clamps the committed rect into the image with rounded integers", () => {
    const c = start("crop", mkImage());
    c.pointer(ev("down", [0, 10], [0, 10])); // source (−10,−10)
    const intents = c.pointer(ev("up", [220.4, 130.4], [220, 130])); // source (210.4, 110.4)
    expect(intents).toEqual([{ kind: "commitCrop", imageId: "img-1", patch: { crop: { x: 0, y: 0, w: 200, h: 100 }, x: 10, y: 20 } }]);
    expect(c.tool()).toBeNull();
  });

  it("rejects sub-pixel source rects even when the screen span passes", () => {
    const c = start("crop", mkImage(), undefined, { ...idView, scale: 10 });
    c.pointer(ev("down", [10.04, 10.06], [100.4, 100.6])); // source (0.04, 0.06)
    const intents = c.pointer(ev("up", [10.44, 10.06], [104.4, 100.6])); // 4 screen px, 0.4 source px
    expect(intents).toEqual([{ kind: "toast", message: "Crop area too small — try again" }]);
    expect(c.tool()).toBe("crop"); // stays in tool, nothing committed
  });

  it("rejects drags under 4 screen px even when the source span is large", () => {
    const c = start("crop", mkImage(), undefined, { ...idView, scale: 0.1 });
    c.pointer(ev("down", [50, 60], [5, 6]));
    expect(c.pointer(ev("up", [80, 60], [8, 6]))).toEqual([
      { kind: "toast", message: "Crop area too small — try again" },
    ]);
    expect(c.tool()).toBe("crop");
  });

  it("previews a rect glued to a rotated image (source axes, not world axes)", () => {
    const image = mkImage({ rotation: 37.2 });
    const c = start("crop", image);
    const s0 = { x: 20, y: 20 };
    const s1 = { x: 80, y: 70 };
    const w0 = sourceToWorld(image, s0);
    const w1 = sourceToWorld(image, s1);
    c.pointer(ev("down", [w0.x, w0.y], [w0.x, w0.y]));
    c.pointer(ev("move", [w1.x, w1.y], [w1.x, w1.y]));
    const polygon = item(c, "cropPreview")!.polygon;
    const expected = [s0, { x: 80, y: 20 }, s1, { x: 20, y: 70 }].map((p) => sourceToWorld(image, p));
    for (let i = 0; i < 4; i++) {
      expect(polygon[i].x).toBeCloseTo(expected[i].x, 6);
      expect(polygon[i].y).toBeCloseTo(expected[i].y, 6);
    }
    // glued: NOT the axis-aligned world rect between the down and up points
    expect(Math.abs(polygon[1].x - w1.x) + Math.abs(polygon[1].y - w0.y)).toBeGreaterThan(1);
    const [commit] = c.pointer(ev("up", [w1.x, w1.y], [w1.x, w1.y])) as [
      Extract<ToolIntent, { kind: "commitCrop" }>,
    ];
    expect(commit.kind).toBe("commitCrop");
    expect(commit.patch.crop).toEqual({ x: 20, y: 20, w: 60, h: 50 });
    // Pinning invariant: the compensated x/y keep every kept source pixel at
    // its current world position, matching the preview polygon exactly (the
    // raw crop would shift content by (I − L)·Δc ≈ (29, 34) px here).
    const pinned = { ...image, ...commit.patch };
    for (const p of [s0, s1, { x: 50, y: 45 }]) {
      const before = sourceToWorld(image, p);
      const after = sourceToWorld(pinned, p);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
    expect(pinned.x).toBeCloseTo(23.2, 1);
    expect(pinned.y).toBeCloseTo(-9.21, 1);
  });
});

describe("resize (AC17)", () => {
  it("walks both axis steps, locks the line to the axis, and commits anchored at the center", () => {
    const c = start("resize", mkImage(), 4);
    expect(item(c, "banner")!.text).toContain("horizontal");
    c.pointer(ev("down", [20, 50], [20, 50]));
    c.pointer(ev("move", [120, 80], [120, 80]));
    const h = item(c, "resizeLine")!;
    expect(h).toMatchObject({ axis: "x", step: 1 });
    expect(h.a).toEqual({ x: 20, y: 50 });
    expect(h.b).toEqual({ x: 120, y: 50 }); // y locked to the anchor
    expect(c.pointer(ev("up", [120, 80], [120, 80]))).toEqual([{ kind: "promptResizeAxis", axis: "x", spanPx: 100 }]);
    expect(c.modalResult(10)).toEqual([]); // fx = 10·4/100 = 0.4, advance to step 2
    expect(item(c, "banner")!.text).toContain("vertical");
    c.pointer(ev("down", [60, 30], [60, 30]));
    c.pointer(ev("move", [45, 90], [45, 90]));
    const v = item(c, "resizeLine")!;
    expect(v).toMatchObject({ axis: "y", step: 2 });
    expect(v.b).toEqual({ x: 60, y: 90 }); // x locked to the anchor
    expect(c.pointer(ev("up", [45, 90], [45, 90]))).toEqual([{ kind: "promptResizeAxis", axis: "y", spanPx: 60 }]);
    const intents = c.modalResult(12); // fy = 12·4/60 = 0.8
    expect(intents).toEqual([
      { kind: "commitResize", imageId: "img-1", warp: { a: 0.4, b: 0, c: 0, d: 0.8 } },
      { kind: "toast", message: "Resized — X ×0.400, Y ×0.800" },
    ]);
    expect(c.tool()).toBeNull();
    const warp = warpOf(intents[0])!;
    const patched: VisualImage = { ...mkImage(), warp };
    expect(imageAnchor(patched)).toEqual(imageAnchor(mkImage())); // center never moves
  });

  it("rejects short reference lines and stays on the same step", () => {
    const c = start("resize", mkImage(), 4);
    c.pointer(ev("down", [20, 50], [20, 50]));
    expect(c.pointer(ev("up", [24, 50], [24, 50]))).toEqual([
      { kind: "toast", message: "Drag across a feature of known width" },
    ]);
    expect(item(c, "banner")!.text).toContain("horizontal");
    expect(item(c, "resizeLine")).toBeUndefined();
    expect(c.tool()).toBe("resize");
  });

  it("skip (0) leaves the axis at factor 1; both skipped = no-op", () => {
    const c = start("resize", mkImage(), 4);
    c.pointer(ev("down", [20, 50], [20, 50]));
    c.pointer(ev("up", [120, 50], [120, 50]));
    expect(c.modalResult(0)).toEqual([]);
    expect(item(c, "banner")!.text).toContain("vertical");
    c.pointer(ev("down", [60, 30], [60, 30]));
    c.pointer(ev("up", [60, 90], [60, 90]));
    expect(c.modalResult(0)).toEqual([{ kind: "toast", message: "No resize applied (both axes unchanged)" }]);
    expect(c.tool()).toBeNull();
  });

  it("cancel (null) on step 1 aborts the whole procedure", () => {
    const c = start("resize", mkImage(), 4);
    c.pointer(ev("down", [20, 50], [20, 50]));
    c.pointer(ev("up", [120, 50], [120, 50]));
    expect(c.modalResult(null)).toEqual([]);
    expect(c.tool()).toBeNull();
    expect(c.overlay()).toEqual([]);
  });

  it("cancel (null) on step 2 commits with fy = 1", () => {
    const c = start("resize", mkImage(), 4);
    c.pointer(ev("down", [20, 50], [20, 50]));
    c.pointer(ev("up", [120, 50], [120, 50]));
    c.modalResult(10); // fx = 0.4
    c.pointer(ev("down", [60, 30], [60, 30]));
    c.pointer(ev("up", [60, 90], [60, 90]));
    expect(c.modalResult(null)).toEqual([
      { kind: "commitResize", imageId: "img-1", warp: { a: 0.4, b: 0, c: 0, d: 1 } },
      { kind: "toast", message: "Resized — X ×0.400, Y ×1.000" },
    ]);
    expect(c.tool()).toBeNull();
  });

  it("auto-calibrates an uncalibrated PCB and still scales the other axis", () => {
    const c = start("resize", mkImage(), undefined);
    c.pointer(ev("down", [20, 50], [20, 50]));
    c.pointer(ev("up", [120, 50], [120, 50])); // span 100
    expect(c.modalResult(10)).toEqual([{ kind: "commitCalibrate", pxPerMm: 10 }]); // 100/10, fx = 1
    c.pointer(ev("down", [60, 30], [60, 30]));
    c.pointer(ev("up", [60, 80], [60, 80])); // span 50
    expect(c.modalResult(10)).toEqual([ // fy = 10·10/50 = 2
      { kind: "commitResize", imageId: "img-1", warp: { a: 1, b: 0, c: 0, d: 2 } },
      { kind: "toast", message: "Resized — X ×1.000, Y ×2.000" },
    ]);
    expect(c.tool()).toBeNull();
  });

  it("auto-calibration followed by a skipped axis is a no-op resize but keeps the calibration", () => {
    const c = start("resize", mkImage(), undefined);
    c.pointer(ev("down", [20, 50], [20, 50]));
    c.pointer(ev("up", [120, 50], [120, 50]));
    const cal = c.modalResult(10);
    expect(cal).toEqual([{ kind: "commitCalibrate", pxPerMm: 10 }]);
    c.pointer(ev("down", [60, 30], [60, 30]));
    c.pointer(ev("up", [60, 90], [60, 90]));
    expect(c.modalResult(0)).toEqual([{ kind: "toast", message: "No resize applied (both axes unchanged)" }]);
    expect(c.tool()).toBeNull();
  });

  it("ignores pointer input while a modal reply is pending", () => {
    const c = start("resize", mkImage(), 4);
    c.pointer(ev("down", [20, 50], [20, 50]));
    c.pointer(ev("up", [120, 50], [120, 50])); // prompt open
    c.pointer(ev("down", [200, 200], [200, 200]));
    c.pointer(ev("up", [300, 200], [300, 200]));
    expect(item(c, "banner")!.text).toContain("1/2"); // still step 1, no new prompt
    expect(c.modalResult(10)).toEqual([]);
    expect(item(c, "banner")!.text).toContain("2/2");
  });
});

describe("deskew (AC9-AC12)", () => {
  /** mkImage() sits at (10,20) with 200x100: footprint (10,20)-(210,120).
   * The default 800x600 viewport contains it, so the initial quad is the
   * footprint inset by 20% on every side. */
  const initialQuad = [
    { x: 50, y: 40 }, { x: 170, y: 40 }, { x: 170, y: 100 }, { x: 50, y: 100 },
  ];

  it("begins with a 20%-inset quad inside the footprint, replaces on re-begin, cancels on Esc (AC9)", () => {
    const c = start("deskew", mkImage());
    const quad = item(c, "deskewQuad")!;
    expect(quad.corners).toEqual(initialQuad);
    expect(quad.dragging).toBeNull();
    expect(quad.moving).toBe(false);
    expect(item(c, "banner")!.text).toBe("DESKEW — drag the corner handles, or drag inside to move all; ENTER applies, ESC cancels");
    // the initial quad stays inside the photo through the inverse pipeline
    for (const p of quad.corners) {
      const s = worldToSource(mkImage(), p);
      expect(s.x).toBeGreaterThanOrEqual(-1);
      expect(s.x).toBeLessThanOrEqual(201);
      expect(s.y).toBeGreaterThanOrEqual(-1);
      expect(s.y).toBeLessThanOrEqual(101);
    }
    // re-begin replaces prior state with a fresh quad
    c.pointer(ev("down", [50, 40], [50, 40]));
    c.pointer(ev("move", [20, 25], [20, 25]));
    c.pointer(ev("up", [20, 25], [20, 25]));
    expect(item(c, "deskewQuad")!.corners[0]).toEqual({ x: 20, y: 25 });
    expect(c.begin("deskew", mkImage(), undefined)).toEqual([]);
    expect(item(c, "deskewQuad")!.corners).toEqual(initialQuad);
    // Esc exits through the canvas cancel path
    expect(c.cancel()).toEqual([]);
    expect(c.tool()).toBeNull();
    expect(c.overlay()).toEqual([]);
  });

  it("clips the initial quad to the intersection of viewport and footprint", () => {
    const view: OverlayView = { scale: 4, offsetX: 100, offsetY: 50, flipX: false, flipY: false, width: 800, height: 600 };
    const c = start("deskew", mkImage(), undefined, view);
    // world viewport (−25,−12.5)-(175,137.5) ∩ footprint (10,20)-(210,120)
    // = (10,20)-(175,120); inset 20% → (43,40)-(142,100)
    expect(item(c, "deskewQuad")!.corners).toEqual([
      { x: 43, y: 40 }, { x: 142, y: 40 }, { x: 142, y: 100 }, { x: 43, y: 100 },
    ]);
  });

  it("rejects locked images with a toast", () => {
    const c = createVisualToolController();
    expect(c.begin("deskew", mkImage({ locked: true }), undefined)).toEqual([{ kind: "toast", message: "Image is locked" }]);
    expect(c.tool()).toBeNull();
    expect(c.overlay()).toEqual([]);
  });

  it("dragging a handle moves only that corner; dragging inside translates all four (AC10)", () => {
    const c = start("deskew", mkImage());
    // 10.6 screen px from the TL handle (50,40) — inside the 14 px grab radius
    c.pointer(ev("down", [58, 47], [58, 47]));
    let quad = item(c, "deskewQuad")!;
    expect(quad.dragging).toBe(0);
    expect(quad.moving).toBe(false);
    c.pointer(ev("move", [14, 30], [14, 30]));
    quad = item(c, "deskewQuad")!;
    expect(quad.corners[0]).toEqual({ x: 14, y: 30 });
    expect(quad.corners[1]).toEqual({ x: 170, y: 40 }); // the other corners hold still
    expect(quad.corners[2]).toEqual({ x: 170, y: 100 });
    expect(quad.corners[3]).toEqual({ x: 50, y: 100 });
    c.pointer(ev("up", [14, 30], [14, 30]));
    expect(item(c, "deskewQuad")!.dragging).toBeNull();
    // inside drag: all four corners follow the pointer delta
    c.pointer(ev("down", [100, 70], [100, 70]));
    quad = item(c, "deskewQuad")!;
    expect(quad.moving).toBe(true);
    expect(quad.dragging).toBeNull();
    c.pointer(ev("move", [130, 90], [130, 90]));
    quad = item(c, "deskewQuad")!;
    expect(quad.corners).toEqual([
      { x: 44, y: 50 }, { x: 200, y: 60 }, { x: 200, y: 120 }, { x: 80, y: 120 },
    ]);
    c.pointer(ev("up", [130, 90], [130, 90]));
    // outside the quad: nothing grabs, nothing moves
    c.pointer(ev("down", [5, 5], [5, 5]));
    expect(item(c, "deskewQuad")!.moving).toBe(false);
    expect(item(c, "deskewQuad")!.dragging).toBeNull();
    c.pointer(ev("move", [40, 40], [40, 40]));
    expect(item(c, "deskewQuad")!.corners).toEqual([
      { x: 44, y: 50 }, { x: 200, y: 60 }, { x: 200, y: 120 }, { x: 80, y: 120 },
    ]);
  });

  it("Enter before any drag is a gentle no-op and other keys pass through (AC11)", () => {
    const c = start("deskew", mkImage());
    expect(c.key("Enter")).toEqual([{ kind: "toast", message: "No changes — nothing to deskew" }]);
    expect(c.tool()).toBe("deskew"); // stays
    expect(item(c, "deskewQuad")!.corners).toEqual(initialQuad);
    expect(c.key("Escape")).toEqual([]); // canvas cancel path handles Esc
    expect(c.key("0")).toEqual([]);
    expect(c.tool()).toBe("deskew");
    // non-deskew tools never handle keys
    const rotate = start("rotate", mkImage());
    expect(rotate.key("Enter")).toEqual([]);
  });

  it("Enter after a real drag commits the perspective and exits (AC11)", () => {
    const img = mkImage();
    const c = start("deskew", img);
    // pull the TL handle toward (60,30): quad stays convex and inside the photo
    c.pointer(ev("down", [50, 40], [50, 40]));
    c.pointer(ev("move", [60, 30], [60, 30]));
    const intents = c.key("Enter");
    expect(intents).toHaveLength(2);
    const commit = intents[0];
    if (commit.kind !== "commitDeskew") throw new Error("expected commitDeskew");
    expect(commit.imageId).toBe("img-1");
    const P = commit.perspective;
    // the produced map must pass the store's own validation domain:
    // finite, pole-free over the photo, corners mapped inside [0,w]x[0,h]
    for (const [x, y] of [[0, 0], [200, 0], [200, 100], [0, 100]] as const) {
      expect(1 + P.g * x + P.h * y).toBeGreaterThan(0);
      const mapped = applyPerspective(P, { x, y });
      expect(mapped.x).toBeGreaterThanOrEqual(-1e-6);
      expect(mapped.x).toBeLessThanOrEqual(200 + 1e-6);
      expect(mapped.y).toBeGreaterThanOrEqual(-1e-6);
      expect(mapped.y).toBeLessThanOrEqual(100 + 1e-6);
    }
    // the dragged corners (back in source px) rectify onto an axis-aligned rect
    const dragged = [{ x: 60, y: 30 }, { x: 170, y: 40 }, { x: 170, y: 100 }, { x: 50, y: 100 }];
    const sourceQuad = dragged.map((p) => worldToSource(img, p));
    const [tl, tr, br, bl] = sortQuadCorners(sourceQuad.map((p) => applyPerspective(P, p)));
    expect(tl.y).toBeCloseTo(tr.y, 6);
    expect(bl.y).toBeCloseTo(br.y, 6);
    expect(tl.x).toBeCloseTo(bl.x, 6);
    expect(tr.x).toBeCloseTo(br.x, 6);
    expect(intents[1]).toEqual({ kind: "toast", message: "Deskewed" });
    expect(c.tool()).toBeNull(); // exits after committing
    expect(c.overlay()).toEqual([]);
    expect(c.targetId()).toBeNull();
  });

  it("keeps the tool and the quad alive when the quad is invalid (AC12)", () => {
    const c = start("deskew", mkImage());
    // a corner dragged outside the photograph
    c.pointer(ev("down", [50, 40], [50, 40]));
    c.pointer(ev("move", [300, 250], [300, 250]));
    expect(c.key("Enter")).toEqual([{ kind: "toast", message: "Deskew corners must stay inside the photograph" }]);
    expect(c.tool()).toBe("deskew");
    expect(item(c, "deskewQuad")!.corners[0]).toEqual({ x: 300, y: 250 }); // retained for fixing
    // a non-convex (dart) quad, dragged handle by handle, in source-px terms
    // (10,10),(190,10),(95,15),(10,90) → world (20,30),(200,30),(105,35),(20,110)
    const c2 = start("deskew", mkImage());
    const handles = [[50, 40], [170, 40], [170, 100], [50, 100]];
    const targets = [[20, 30], [200, 30], [105, 35], [20, 110]];
    handles.forEach(([hx, hy], i) => {
      const [tx, ty] = targets[i];
      c2.pointer(ev("down", [hx, hy], [hx, hy]));
      c2.pointer(ev("move", [tx, ty], [tx, ty]));
      c2.pointer(ev("up", [tx, ty], [tx, ty]));
    });
    expect(c2.key("Enter")).toEqual([{ kind: "toast", message: "Deskew corners must form a convex quadrilateral" }]);
    expect(c2.tool()).toBe("deskew");
    expect(item(c2, "deskewQuad")!.corners).toEqual([
      { x: 20, y: 30 }, { x: 200, y: 30 }, { x: 105, y: 35 }, { x: 20, y: 110 },
    ]);
    // fixing the quad afterwards can still commit
    c2.pointer(ev("down", [105, 35], [105, 35]));
    c2.pointer(ev("move", [170, 100], [170, 100]));
    c2.pointer(ev("up", [170, 100], [170, 100]));
    const intents = c2.key("Enter");
    expect(intents[0].kind).toBe("commitDeskew");
    expect(intents[1]).toEqual({ kind: "toast", message: "Deskewed" });
    expect(c2.tool()).toBeNull();
  });
});
