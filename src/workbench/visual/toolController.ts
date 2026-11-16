// Pure visual-editor tool state machine (DOM-free, store-free). The canvas
// (VisualCanvas.tsx) feeds pointer/keyboard/view events in here and receives
// two things back: ToolIntents (document commits, prompts, toasts — executed
// by the caller against store.visual actions) and VisualToolOverlay
// descriptors (drawn in screen space by overlays.ts). High-frequency state
// lives in this controller, OUTSIDE the reactive store; every gesture commits
// at most one document mutation.
//
// Tool semantics (user-facing contract):
//  measure   — crosshair. Two modes: press-drag-release, or click → the line
//              follows the cursor → click again fixes it. The last line stays
//              visible until the next measurement or tool exit. Label shows
//              px always, mm only when the PCB has pxPerMm (else a hint).
//  calibrate — same interaction; when a span ≥ 2 px completes, emit
//              promptCalibrate; the modal reply commits PCB pxPerMm = span/mm.
//  rotate    — gizmo ring + knob at the image anchor (radius = quarter of the
//              image's smaller on-screen dimension, floored so it stays
//              grabbable). Drag the knob (or anywhere with Shift) to rotate
//              about the crop center; Shift snaps to 15°. Drag a line along a
//              feature that should be level → the image rotates so that line
//              becomes horizontal or vertical (nearest axis).
//  align     — 4 numbered markers on the moving (selected) image, then 4
//              reference markers anywhere in the world (usually on the base
//              photo). A magnifier loupe follows the cursor. After the 8th
//              click: least-squares affine, composed left onto the image's
//              linear part (warp' = A·warp), anchor moves under A, residual
//              reported. Degenerate points → toast + markers reset.
//  crop      — drag a rect in the image's OWN pixel space (axis-aligned in
//              source px, so it appears glued to a rotated/warped image).
//              Preview shows the transformed footprint; commit stores an
//              integer CropRect clamped to the full image (re-crop wider to
//              recover previously cropped-away pixels).
//  resize    — step 1: drag a HORIZONTAL line across a known width (locked to
//              the anchor's y); step 2: a VERTICAL line (locked to anchor's x).
//              Each completed line prompts for the real mm; blank skips the
//              axis. factor = mm · pxPerMm / span; when pxPerMm is unset and
//              an axis is entered, that axis auto-calibrates (pxPerMm =
//              span/mm, factor 1). Applied as warp' = diag(fx,fy) · warp about
//              the image anchor (position unchanged).

import type { CropRect, Point } from "../placement/projectDoc";
import type { VisualImage, Warp2 } from "./model";
import {
  composeWarpLeft,
  imageAnchor,
  imageLinear,
  levelLine,
  maxResidualPx,
  normalizeRotation,
  rotationMatrix,
  snap15,
  solveAffine,
  sourceToWorld,
  visualCropRect,
  worldAabb,
  worldToSource,
} from "./transform";

export type VisualToolId = "measure" | "calibrate" | "rotate" | "align" | "crop" | "resize";

/** Document commits and UI prompts emitted by the controller. The caller
 * executes them: commits via store.visual actions (one mutate per commit),
 * prompts by opening the value modal, toasts as transient messages. */
export type ToolIntent =
  | { kind: "promptCalibrate"; spanPx: number }
  | { kind: "commitCalibrate"; pxPerMm: number }
  | { kind: "promptResizeAxis"; axis: "x" | "y"; spanPx: number }
  | { kind: "commitRotation"; imageId: string; patch: RotationPatch }
  | { kind: "commitCrop"; imageId: string; crop: CropRect }
  | { kind: "commitAlign"; imageId: string; patch: { x: number; y: number; warp: Warp2 }; residualPx: number }
  | { kind: "commitResize"; imageId: string; warp: Warp2 }
  | { kind: "toast"; message: string };

/** rotation: number sets (already normalized), null deletes the field;
 * warp: Warp2 sets, null deletes. Only the keys present change. */
export interface RotationPatch { rotation?: number | null; warp?: Warp2 | null }

/** View state injected by the canvas so the controller can convert between
 * world and CSS-screen coordinates (including view flips) for hit thresholds
 * and gizmo geometry. Pure data; tests inject identity views. */
export interface OverlayView {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Visual-only whole-canvas mirroring (toolbar flip buttons). */
  flipX: boolean;
  flipY: boolean;
  width: number;
  height: number;
}

/** Screen-space overlay descriptors; geometry is in WORLD px unless a field
 * is explicitly screen (the loupe anchor tracks the cursor). overlays.ts
 * maps world → screen (applying view flips) when drawing. */
export type VisualToolOverlay =
  | { kind: "banner"; text: string; tone: "neutral" | "accent" | "danger" }
  | { kind: "measure"; a: Point; b: Point; label: string; hint?: string; live: boolean }
  | { kind: "rotateGizmo"; center: Point; knob: Point; /** World-space ring radius. */ radius: number; dragging: boolean; line?: { a: Point; b: Point; axis: "horizontal" | "vertical" } }
  | { kind: "alignMarkers"; points: Array<{ p: Point; index: number; phase: "moving" | "reference" }>; loupe: { at: Point } | null }
  | { kind: "cropPreview"; /** Kept-region footprint polygon (world space, ≥ 4 pts). */ polygon: Point[] }
  | { kind: "resizeLine"; a: Point; b: Point; axis: "x" | "y"; step: 1 | 2 };

export interface VisualPointerEvent {
  phase: "down" | "move" | "up";
  world: Point;
  screen: Point;
  shift: boolean;
}

// ---------------------------------------------------------------------------
// The VisualToolController interface is a FROZEN contract; the canvas and
// panel are built against these signatures.
// ---------------------------------------------------------------------------

export interface VisualToolController {
  /** Activate a tool against a target image (captured at start — the align
   * target never changes mid-procedure, mirroring the reference app). Locked
   * images are rejected with a toast intent. Re-begin replaces prior state. */
  begin(tool: VisualToolId, image: VisualImage, pxPerMm: number | undefined): ToolIntent[];
  /** Esc: cancel any in-progress gesture and exit the tool. */
  cancel(): ToolIntent[];
  /** The active tool, or null when idle. */
  tool(): VisualToolId | null;
  /** The captured target image id, or null when idle. */
  targetId(): string | null;
  /** Current view for hit thresholds and gizmo geometry; call on every
   * view change (zoom, pan, flip, resize) before overlay(). */
  update(view: OverlayView): void;
  pointer(e: VisualPointerEvent): ToolIntent[];
  /** Cursor tracking without buttons (click-click measure follow, loupe). */
  hover(world: Point): void;
  /** Modal reply for promptCalibrate / promptResizeAxis; null = skipped. */
  modalResult(value: number | null): ToolIntent[];
  /** Overlay items to draw this frame; empty when idle. */
  overlay(): VisualToolOverlay[];
}

// ---------------------------------------------------------------------------
// Implementation. All pixel thresholds that "feel like" screen sizes are in
// CSS screen px; world-space equivalents divide by view.scale.
// ---------------------------------------------------------------------------

const CLICK_SLOP_PX = 3; // measure/calibrate: up within this of down = click
const MIN_SPAN_WORLD_PX = 2; // measure/calibrate: completed line minimum
const KNOB_SCREEN_PX = 11; // rotate gizmo knob radius
const KNOB_GRAB_SLACK_PX = 6; // extra grab tolerance around the knob
const LEVEL_LINE_MIN_PX = 8; // rotate level-line minimum screen span
const GIZMO_MIN_SCREEN_R_PX = 14; // ring stays grabbable when the image is tiny
const CROP_MIN_SCREEN_PX = 4; // crop drag minimum screen span
const CROP_MIN_SOURCE_PX = 1; // crop rect minimum per axis in source px
const RESIZE_LINE_MIN_PX = 8; // resize reference line minimum screen span
const RESIZE_NOOP_EPS = 1e-4; // both factors within this of 1 = no-op
const ROTATION_EPS = 1e-9; // gizmo released without turning = no commit

interface MeasureState {
  kind: "measure" | "calibrate";
  image: VisualImage;
  pxPerMm: number | undefined;
  phase: "idle" | "dragging" | "pending" | "fixed";
  a: Point;
  b: Point | null;
  downScreen: Point | null;
  /** Calibrate: span of the line that prompted the modal. */
  pendingSpanPx: number | null;
}

interface RotateState {
  kind: "rotate";
  image: VisualImage;
  gizmo: null | { startAngleDeg: number; deltaDeg: number };
  line: null | { a: Point; b: Point; downScreen: Point };
}

interface AlignState {
  kind: "align";
  image: VisualImage;
  points: Point[]; // 0..3 moving, 4..7 reference (world space)
  loupe: Point | null;
}

interface CropState {
  kind: "crop";
  image: VisualImage;
  drag: null | { anchor: Point; current: Point; downScreen: Point };
}

interface ResizeState {
  kind: "resize";
  image: VisualImage;
  pxPerMm: number | undefined;
  step: 1 | 2;
  fx: number;
  fy: number;
  line: null | { a: Point; b: Point };
  drag: null | { anchor: Point; downScreen: Point };
  awaiting: null | { axis: "x" | "y"; spanPx: number };
}

type ActiveTool = MeasureState | RotateState | AlignState | CropState | ResizeState;

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

const deg = (rad: number): number => (rad * 180) / Math.PI;

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

/** Normalized source-px rect between two corners, integer-clamped into the
 * image; degenerate axes collapse to 0 so the caller's min-size check fires. */
function clampedSourceRect(image: VisualImage, a: Point, b: Point): CropRect {
  const x0 = clampInt(Math.min(a.x, b.x), 0, image.width);
  const x1 = clampInt(Math.max(a.x, b.x), 0, image.width);
  const y0 = clampInt(Math.min(a.y, b.y), 0, image.height);
  const y1 = clampInt(Math.max(a.y, b.y), 0, image.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function createVisualToolController(): VisualToolController {
  let activeTool: VisualToolId | null = null;
  let active: ActiveTool | null = null;
  let view = { scale: 1, offsetX: 0, offsetY: 0, flipX: false, flipY: false, width: 800, height: 600 } as OverlayView;

  const clear = (): void => {
    activeTool = null;
    active = null;
  };

  /** World → CSS screen px (view flips mirror about the canvas center). */
  const toScreen = (p: Point): Point => ({
    x: view.flipX ? view.width - (p.x * view.scale + view.offsetX) : p.x * view.scale + view.offsetX,
    y: view.flipY ? view.height - (p.y * view.scale + view.offsetY) : p.y * view.scale + view.offsetY,
  });

  const banner = (text: string): VisualToolOverlay => ({ kind: "banner", text, tone: "accent" });

  // ---- rotate helpers ----------------------------------------------------

  const gizmoGeometry = (image: VisualImage): { center: Point; radius: number; knob: Point } => {
    const center = imageAnchor(image);
    const box = worldAabb([image]);
    const radius = Math.max(GIZMO_MIN_SCREEN_R_PX / Math.max(view.scale, 1e-6), Math.min(box.right - box.left, box.bottom - box.top) / 4);
    const L = imageLinear(image);
    const m = Math.hypot(L.a, L.b) || 1;
    const knob = { x: center.x + (L.a / m) * radius, y: center.y + (L.b / m) * radius };
    return { center, radius, knob };
  };

  /** World-space rotation delta → document patch. The linear part becomes
   * R(δ)·L, representable in exactly one of three ways:
   * a) warp present → fold R(δ) into it (rotation/flip/scale untouched);
   * b) no warp and flipH === flipV (F = ±I commutes) → into `rotation`;
   * c) no warp and a single-axis flip (R(δ)·F does not fold into F·R(δ′))
   *    → a fresh warp, rotation field untouched. Never rotation:null + warp. */
  const rotationPatch = (image: VisualImage, deltaDeg: number): RotationPatch => {
    if (image.warp) return { warp: composeWarpLeft(image.warp, rotationMatrix(deltaDeg)) };
    if (image.flipH === image.flipV) return { rotation: normalizeRotation((image.rotation ?? 0) + deltaDeg) };
    return { warp: rotationMatrix(deltaDeg) };
  };

  // ---- measure / calibrate -------------------------------------------------

  /** A line completed in either mode: measure keeps it fixed; calibrate
   * prompts and clears. Sub-minimum spans reset to empty in both. */
  const completeLine = (s: MeasureState, end: Point): ToolIntent[] => {
    const span = dist(s.a, end);
    if (span < MIN_SPAN_WORLD_PX) {
      s.phase = "idle";
      s.b = null;
      return [];
    }
    if (s.kind === "calibrate") {
      s.phase = "idle";
      s.b = null;
      s.pendingSpanPx = span;
      return [{ kind: "promptCalibrate", spanPx: span }];
    }
    s.b = end;
    s.phase = "fixed";
    return [];
  };

  const measureDown = (s: MeasureState, e: VisualPointerEvent): ToolIntent[] => {
    if (s.phase === "pending") return completeLine(s, e.world); // click 2 fixes
    s.phase = "dragging"; // fresh gesture (or restart of a lost one)
    s.a = e.world;
    s.b = e.world;
    s.downScreen = e.screen;
    return [];
  };

  const measureMove = (s: MeasureState, e: VisualPointerEvent): ToolIntent[] => {
    if (s.phase === "dragging") s.b = e.world;
    return [];
  };

  const measureUp = (s: MeasureState, e: VisualPointerEvent): ToolIntent[] => {
    if (s.phase !== "dragging" || !s.downScreen) return [];
    s.b = e.world;
    if (dist(s.downScreen, e.screen) < CLICK_SLOP_PX) {
      s.phase = "pending"; // click: the line follows hover until clicked again
      return [];
    }
    return completeLine(s, e.world); // drag-finish
  };

  const measureOverlay = (s: MeasureState): VisualToolOverlay[] => {
    const text = `${s.kind === "measure" ? "MEASURE" : "CALIBRATE"} — drag or click-click; Esc exits`;
    if (!s.b || s.phase === "idle") return [banner(text)];
    const px = dist(s.a, s.b);
    const label = s.pxPerMm === undefined ? `${px.toFixed(1)} px` : `${px.toFixed(1)} px = ${(px / s.pxPerMm).toFixed(2)} mm`;
    const hint = s.pxPerMm === undefined ? "Calibrate to show mm" : undefined;
    const item: VisualToolOverlay = hint === undefined
      ? { kind: "measure", a: s.a, b: s.b, label, live: s.phase === "dragging" || s.phase === "pending" }
      : { kind: "measure", a: s.a, b: s.b, label, hint, live: s.phase === "dragging" || s.phase === "pending" };
    return [banner(text), item];
  };

  const calibrateModal = (s: MeasureState, value: number | null): ToolIntent[] => {
    if (s.pendingSpanPx === null) return [];
    const spanPx = s.pendingSpanPx;
    s.pendingSpanPx = null;
    if (value !== null && value > 0) return [{ kind: "commitCalibrate", pxPerMm: spanPx / value }];
    return []; // 0 = no reply worth using, null = dismissed
  };

  // ---- rotate ---------------------------------------------------------------

  const rotateDown = (s: RotateState, e: VisualPointerEvent): ToolIntent[] => {
    const g = gizmoGeometry(s.image);
    if (dist(toScreen(g.knob), e.screen) <= KNOB_SCREEN_PX + KNOB_GRAB_SLACK_PX || e.shift) {
      s.line = null;
      s.gizmo = {
        startAngleDeg: deg(Math.atan2(e.world.y - g.center.y, e.world.x - g.center.x)),
        deltaDeg: 0,
      };
    } else {
      s.gizmo = null;
      s.line = { a: e.world, b: e.world, downScreen: e.screen };
    }
    return [];
  };

  const rotateMove = (s: RotateState, e: VisualPointerEvent): ToolIntent[] => {
    if (s.gizmo) {
      const g = gizmoGeometry(s.image);
      let angleDeg = deg(Math.atan2(e.world.y - g.center.y, e.world.x - g.center.x));
      if (e.shift) angleDeg = snap15(angleDeg); // snap the ABSOLUTE angle
      s.gizmo.deltaDeg = angleDeg - s.gizmo.startAngleDeg;
    } else if (s.line) {
      s.line.b = e.world;
    }
    return [];
  };

  const shortLineToast: ToolIntent = { kind: "toast", message: "Line too short — drag ALONG a feature that should be level" };

  const rotateUp = (s: RotateState, e: VisualPointerEvent): ToolIntent[] => {
    if (s.gizmo) {
      const deltaDeg = s.gizmo.deltaDeg;
      s.gizmo = null;
      if (Math.abs(deltaDeg) < ROTATION_EPS) return []; // knob grab with no turn
      return [{ kind: "commitRotation", imageId: s.image.id, patch: rotationPatch(s.image, deltaDeg) }];
    }
    if (!s.line) return [];
    const line = { a: s.line.a, b: e.world, downScreen: s.line.downScreen }; // the up position is final
    s.line = null;
    if (dist(line.downScreen, e.screen) < LEVEL_LINE_MIN_PX) return [shortLineToast];
    const level = levelLine(line.a, line.b);
    if (!level) return [shortLineToast]; // zero-length in world space despite screen span
    return [
      { kind: "commitRotation", imageId: s.image.id, patch: rotationPatch(s.image, level.deltaDeg) },
      { kind: "toast", message: `Straightened to ${level.axis}` },
    ];
  };

  const rotateOverlay = (s: RotateState): VisualToolOverlay[] => {
    const g = gizmoGeometry(s.image);
    // The knob shows the WOULD-BE +x axis: the current axis rotated by the
    // live delta (identity when not dragging).
    const deltaDeg = s.gizmo ? s.gizmo.deltaDeg : 0;
    const R = rotationMatrix(deltaDeg);
    const L = imageLinear(s.image);
    const rx = R.a * L.a + R.c * L.b;
    const ry = R.b * L.a + R.d * L.b;
    const m = Math.hypot(rx, ry) || 1;
    const knob = { x: g.center.x + (rx / m) * g.radius, y: g.center.y + (ry / m) * g.radius };
    const base = { kind: "rotateGizmo", center: g.center, knob, radius: g.radius, dragging: s.gizmo !== null } as const;
    if (!s.line) return [banner("ROTATE — drag the knob to rotate (Shift snaps to 15°), or drag a line along a feature to level; Esc exits"), base];
    const level = levelLine(s.line.a, s.line.b);
    const item: VisualToolOverlay = { ...base, line: { a: s.line.a, b: s.line.b, axis: level ? level.axis : "horizontal" } };
    return [banner("ROTATE — drag the knob to rotate (Shift snaps to 15°), or drag a line along a feature to level; Esc exits"), item];
  };

  // ---- align ----------------------------------------------------------------

  const alignDown = (s: AlignState, e: VisualPointerEvent): ToolIntent[] => {
    if (s.points.length >= 8) return [];
    s.points.push(e.world);
    if (s.points.length < 8) return [];
    const mov = s.points.slice(0, 4);
    const ref = s.points.slice(4);
    const T = solveAffine(mov, ref);
    if (!T) {
      s.points = []; // stay in the tool, start over
      return [{ kind: "toast", message: "Points are collinear — alignment aborted" }];
    }
    const image = s.image;
    const r = visualCropRect(image);
    const t = imageAnchor(image);
    const residualPx = maxResidualPx(T, mov, ref);
    const patch = {
      x: T.a * t.x + T.c * t.y + T.e - (r.x + r.w / 2),
      y: T.b * t.x + T.d * t.y + T.f - (r.y + r.h / 2),
      warp: composeWarpLeft(image.warp ?? null, { a: T.a, b: T.b, c: T.c, d: T.d }),
    };
    const intents: ToolIntent[] = [
      { kind: "commitAlign", imageId: image.id, patch, residualPx },
      { kind: "toast", message: `Aligned (max residual ${residualPx.toFixed(1)} px)` },
    ];
    clear(); // done: exit the tool
    return intents;
  };

  const alignOverlay = (s: AlignState): VisualToolOverlay[] => {
    const phase = s.points.length < 4 ? "moving" : "reference";
    const n = (s.points.length % 4) + 1;
    const text = phase === "moving"
      ? `click feature ${n}/4 on ${s.image.name}`
      : `now click matching feature ${n}/4 on the base image`;
    const points = s.points.map((p, i) => ({ p, index: (i % 4) + 1, phase: i < 4 ? ("moving" as const) : ("reference" as const) }));
    return [banner(text), { kind: "alignMarkers", points, loupe: s.loupe ? { at: s.loupe } : null }];
  };

  // ---- crop ---------------------------------------------------------------

  const cropDown = (s: CropState, e: VisualPointerEvent): ToolIntent[] => {
    const anchor = worldToSource(s.image, e.world);
    s.drag = { anchor, current: anchor, downScreen: e.screen };
    return [];
  };

  const cropMove = (s: CropState, e: VisualPointerEvent): ToolIntent[] => {
    if (s.drag) s.drag.current = worldToSource(s.image, e.world);
    return [];
  };

  const cropUp = (s: CropState, e: VisualPointerEvent): ToolIntent[] => {
    const drag = s.drag;
    if (!drag) return [];
    s.drag = null;
    const current = worldToSource(s.image, e.world); // the up position is final
    const crop = clampedSourceRect(s.image, drag.anchor, current);
    if (crop.w < CROP_MIN_SOURCE_PX || crop.h < CROP_MIN_SOURCE_PX || dist(drag.downScreen, e.screen) < CROP_MIN_SCREEN_PX) {
      return [{ kind: "toast", message: "Crop area too small — try again" }]; // stay in tool
    }
    const image = s.image;
    clear();
    return [{ kind: "commitCrop", imageId: image.id, crop }];
  };

  const cropOverlay = (s: CropState): VisualToolOverlay[] => {
    const items: VisualToolOverlay[] = [banner("drag a box (in the image's own axes) to KEEP")];
    if (!s.drag) return items;
    const { anchor, current } = s.drag;
    const x0 = Math.min(anchor.x, current.x), x1 = Math.max(anchor.x, current.x);
    const y0 = Math.min(anchor.y, current.y), y1 = Math.max(anchor.y, current.y);
    const polygon = [
      { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
    ].map((p) => sourceToWorld(s.image, p));
    items.push({ kind: "cropPreview", polygon });
    return items;
  };

  // ---- resize ---------------------------------------------------------------

  const resizeDown = (s: ResizeState, e: VisualPointerEvent): ToolIntent[] => {
    if (s.awaiting) return []; // modal open: gestures paused
    s.drag = { anchor: e.world, downScreen: e.screen };
    s.line = { a: e.world, b: e.world };
    return [];
  };

  const resizeMove = (s: ResizeState, e: VisualPointerEvent): ToolIntent[] => {
    if (!s.drag) return [];
    // Lock the second point to the axis being calibrated so the span is unambiguous.
    s.line = s.step === 1
      ? { a: s.drag.anchor, b: { x: e.world.x, y: s.drag.anchor.y } }
      : { a: s.drag.anchor, b: { x: s.drag.anchor.x, y: e.world.y } };
    return [];
  };

  const resizeUp = (s: ResizeState, e: VisualPointerEvent): ToolIntent[] => {
    const drag = s.drag;
    if (!drag || !s.line) return [];
    s.drag = null;
    // The up position is final: lock it to the axis being calibrated.
    const b = s.step === 1 ? { x: e.world.x, y: drag.anchor.y } : { x: drag.anchor.x, y: e.world.y };
    s.line = { a: drag.anchor, b };
    if (dist(drag.downScreen, e.screen) < RESIZE_LINE_MIN_PX) {
      s.line = null;
      return [{ kind: "toast", message: s.step === 1 ? "Drag across a feature of known width" : "Drag across a feature of known height" }];
    }
    const axis = s.step === 1 ? ("x" as const) : ("y" as const);
    const spanPx = axis === "x" ? Math.abs(b.x - drag.anchor.x) : Math.abs(b.y - drag.anchor.y);
    s.awaiting = { axis, spanPx };
    return [{ kind: "promptResizeAxis", axis, spanPx }];
  };

  const finishResize = (s: ResizeState): ToolIntent[] => {
    const { fx, fy } = s;
    const image = s.image;
    clear();
    if (Math.abs(fx - 1) < RESIZE_NOOP_EPS && Math.abs(fy - 1) < RESIZE_NOOP_EPS) {
      return [{ kind: "toast", message: "No resize applied (both axes unchanged)" }];
    }
    return [
      { kind: "commitResize", imageId: image.id, warp: composeWarpLeft(image.warp ?? null, { a: fx, b: 0, c: 0, d: fy }) },
      { kind: "toast", message: `Resized — X ×${fx.toFixed(3)}, Y ×${fy.toFixed(3)}` },
    ];
  };

  const resizeModal = (s: ResizeState, value: number | null): ToolIntent[] => {
    if (!s.awaiting) return [];
    const { axis, spanPx } = s.awaiting;
    s.awaiting = null;
    s.line = null;
    if (value === null) {
      if (axis === "x") {
        clear(); // cancel on step 1 aborts the whole procedure
        return [];
      }
      return finishResize(s); // cancel on step 2 commits with fy = 1
    }
    if (value > 0) {
      if (s.pxPerMm === undefined) {
        // Auto-calibrate: this measurement DEFINES pxPerMm; that axis is 1:1.
        s.pxPerMm = spanPx / value;
        if (axis === "x") {
          s.fx = 1;
          s.step = 2;
          return [{ kind: "commitCalibrate", pxPerMm: s.pxPerMm }];
        }
        s.fy = 1;
        return [{ kind: "commitCalibrate", pxPerMm: s.pxPerMm }, ...finishResize(s)];
      }
      const factor = (value * s.pxPerMm) / spanPx;
      if (axis === "x") {
        s.fx = factor;
        s.step = 2;
        return [];
      }
      s.fy = factor;
      return finishResize(s);
    }
    // value === 0: explicit skip of this axis.
    if (axis === "x") {
      s.fx = 1;
      s.step = 2;
      return [];
    }
    s.fy = 1;
    return finishResize(s);
  };

  const resizeOverlay = (s: ResizeState): VisualToolOverlay[] => {
    const text = s.step === 1
      ? "RESIZE 1/2 — drag a horizontal line across a feature of known width; Esc exits"
      : "RESIZE 2/2 — drag a vertical line across a feature of known height; Esc exits";
    const items: VisualToolOverlay[] = [banner(text)];
    if (s.line) items.push({ kind: "resizeLine", a: s.line.a, b: s.line.b, axis: s.step === 1 ? "x" : "y", step: s.step });
    return items;
  };

  // ---- controller surface ---------------------------------------------------

  const controller: VisualToolController = {
    begin: (tool, image, pxPerMm) => {
      if (image.locked) {
        clear();
        return [{ kind: "toast", message: "Image is locked" }];
      }
      const snapshot: VisualImage = { ...image }; // captured; commits address it by id
      activeTool = tool;
      switch (tool) {
        case "measure":
        case "calibrate":
          active = { kind: tool, image: snapshot, pxPerMm, phase: "idle", a: { x: 0, y: 0 }, b: null, downScreen: null, pendingSpanPx: null };
          break;
        case "rotate":
          active = { kind: "rotate", image: snapshot, gizmo: null, line: null };
          break;
        case "align":
          active = { kind: "align", image: snapshot, points: [], loupe: null };
          break;
        case "crop":
          active = { kind: "crop", image: snapshot, drag: null };
          break;
        case "resize":
          active = { kind: "resize", image: snapshot, pxPerMm, step: 1, fx: 1, fy: 1, line: null, drag: null, awaiting: null };
          break;
      }
      return [];
    },
    cancel: () => {
      clear();
      return [];
    },
    tool: () => activeTool,
    targetId: () => active?.image.id ?? null,
    update: (next) => {
      view = next;
    },
    pointer: (e) => {
      const s = active;
      if (!s) return [];
      switch (s.kind) {
        case "measure":
        case "calibrate":
          return e.phase === "down" ? measureDown(s, e) : e.phase === "move" ? measureMove(s, e) : measureUp(s, e);
        case "rotate":
          return e.phase === "down" ? rotateDown(s, e) : e.phase === "move" ? rotateMove(s, e) : rotateUp(s, e);
        case "align":
          return e.phase === "down" ? alignDown(s, e) : [];
        case "crop":
          return e.phase === "down" ? cropDown(s, e) : e.phase === "move" ? cropMove(s, e) : cropUp(s, e);
        case "resize":
          return e.phase === "down" ? resizeDown(s, e) : e.phase === "move" ? resizeMove(s, e) : resizeUp(s, e);
      }
    },
    hover: (world) => {
      const s = active;
      if (!s) return;
      if ((s.kind === "measure" || s.kind === "calibrate") && s.phase === "pending") s.b = world;
      else if (s.kind === "align") s.loupe = world;
    },
    modalResult: (value) => {
      const s = active;
      if (!s) return [];
      if (s.kind === "calibrate") return calibrateModal(s, value);
      if (s.kind === "resize") return resizeModal(s, value);
      return [];
    },
    overlay: () => {
      const s = active;
      if (!s) return [];
      switch (s.kind) {
        case "measure":
        case "calibrate":
          return measureOverlay(s);
        case "rotate":
          return rotateOverlay(s);
        case "align":
          return alignOverlay(s);
        case "crop":
          return cropOverlay(s);
        case "resize":
          return resizeOverlay(s);
      }
    },
  };
  return controller;
}
