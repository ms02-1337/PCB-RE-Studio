// Screen-space overlay rendering for the visual editor tools. Pure drawing:
// consumes the controller's VisualToolOverlay descriptors plus the current
// view (zoom/pan/flips) and paints banners, measure lines + labels, the
// rotate gizmo, align badges + magnifier loupe, crop shading and resize tags.
// Everything draws in CSS-pixel space with ctx.setTransform(dpr, 0, 0, dpr,
// 0, 0) applied by the caller; world→screen conversion (including view
// flips) happens here through the same mapping the canvas uses for pointers,
// so overlays stay glued to the scene under whole-canvas mirroring. The loupe
// is drawn LAST via canvas self-copy (drawImage from the same canvas is only
// valid on already-painted pixels, with the source rect multiplied by the
// device pixel ratio). All helpers tolerate a null context for jsdom tests.

import type { Point } from "../placement/projectDoc";
import type { OverlayView, VisualToolOverlay } from "./toolController";

// ---------------------------------------------------------------------------
// View mapping — ONE pure module shared by the canvas and the overlays.
// ---------------------------------------------------------------------------

/** Screen → un-flipped base coordinates (undo only the view mirroring). */
export function screenToBase(view: OverlayView, p: Point): Point {
  return { x: view.flipX ? view.width - p.x : p.x, y: view.flipY ? view.height - p.y : p.y };
}

/** World px → CSS-screen px, mirroring about the canvas center under flips. */
export function worldToScreen(view: OverlayView, p: Point): Point {
  const base = { x: p.x * view.scale + view.offsetX, y: p.y * view.scale + view.offsetY };
  return { x: view.flipX ? view.width - base.x : base.x, y: view.flipY ? view.height - base.y : base.y };
}

/** Exact inverse of worldToScreen (CSS-screen px → world px). */
export function screenToWorld(view: OverlayView, p: Point): Point {
  const base = screenToBase(view, p);
  return { x: (base.x - view.offsetX) / view.scale, y: (base.y - view.offsetY) / view.scale };
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Short perpendicular tick segments at both ends of a→b (measure/resize). */
export function endTicks(a: Point, b: Point, half = 5): Array<{ a: Point; b: Point }> {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return [];
  const nx = (-dy / length) * half, ny = (dx / length) * half;
  return [
    { a: { x: a.x + nx, y: a.y + ny }, b: { x: a.x - nx, y: a.y - ny } },
    { a: { x: b.x + nx, y: b.y + ny }, b: { x: b.x - nx, y: b.y - ny } },
  ];
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Loupe destination: a square of `size` offset from the cursor away from the
 * nearest edge (toward the canvas center side), clamped into bounds, flipping
 * direction whenever the placement would cover the magnified source box
 * (cursor ± gap). Null when it cannot fit. Pure geometry. */
export function loupePlacement(cursor: Point, size: number, gap: number, width: number, height: number): Rect | null {
  if (size <= 0 || width < size || height < size) return null;
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const source: Rect = { x: cursor.x - gap, y: cursor.y - gap, w: gap * 2, h: gap * 2 };
  const overlaps = (r: Rect) => r.x < source.x + source.w && r.x + r.w > source.x && r.y < source.y + source.h && r.y + r.h > source.y;
  const distance = size / 2 + gap;
  const sx = cursor.x < width / 2 ? 1 : -1;
  const sy = cursor.y < height / 2 ? 1 : -1;
  const candidates: Array<[number, number]> = [[sx, 0], [-sx, 0], [0, sy], [0, -sy], [sx, sy], [-sx, -sy]];
  let last: Rect = { x: 0, y: 0, w: size, h: size };
  for (const [dx, dy] of candidates) {
    const rect: Rect = {
      x: clamp(cursor.x + dx * distance - size / 2, 0, width - size),
      y: clamp(cursor.y + dy * distance - size / 2, 0, height - size),
      w: size,
      h: size,
    };
    if (!overlaps(rect)) return rect;
    last = rect;
  }
  return last; // tiny canvas: anywhere legal beats dropping the loupe
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const ACCENT = "#ffcd11";
const BANNER_BG = "rgba(36, 69, 122, 0.92)";
const TONES = { neutral: "#7a8aa0", accent: ACCENT, danger: "#e5484d" } as const;
const FONT_STACK = '"Segoe UI", system-ui, sans-serif';
const KNOB_IDLE = "#7db4ff";
const KNOB_DRAG = ACCENT;
const MOVING = "#ffb648";
const REFERENCE = "#4fd07f";
const CROP_STROKE = "#4fd0ff";
const DARK = "#141a22";
const LOUPE_SIZE = 140;
const LOUPE_ZOOM = 4;

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  const rounded = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r?: number) => void };
  if (typeof rounded.roundRect === "function") rounded.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** Haloed screen-space label (readable over any photograph). */
function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, color: string, align: CanvasTextAlign = "left"): void {
  ctx.save();
  ctx.font = `600 12px ${FONT_STACK}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(15, 19, 26, 0.85)";
  ctx.strokeText(value, x, y);
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
  ctx.restore();
}

function strokeLine(ctx: CanvasRenderingContext2D, a: Point, b: Point, color: string, dashed: boolean): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function strokeTicks(ctx: CanvasRenderingContext2D, a: Point, b: Point, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (const tick of endTicks(a, b)) {
    ctx.beginPath();
    ctx.moveTo(tick.a.x, tick.a.y);
    ctx.lineTo(tick.b.x, tick.b.y);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function drawVisualOverlays(ctx: CanvasRenderingContext2D | null, items: VisualToolOverlay[], view: OverlayView): void {
  if (!ctx || items.length === 0) return;
  type BannerItem = Extract<VisualToolOverlay, { kind: "banner" }>;
  const banners: BannerItem[] = [];
  let loupe: { at: Point } | null = null;
  // Collect chrome first so scene-anchored shapes never paint over it and the
  // loupe self-copy runs after every other pass.
  for (const item of items) {
    if (item.kind === "banner") banners.push(item);
    else if (item.kind === "alignMarkers" && item.loupe) loupe = item.loupe;
  }
  for (const item of items) {
    if (item.kind === "banner") continue;
    drawItem(ctx, item, view);
  }
  drawBanners(ctx, banners, view);
  if (loupe) drawLoupe(ctx, loupe.at, view);
}

function drawItem(ctx: CanvasRenderingContext2D, item: VisualToolOverlay, view: OverlayView): void {
  switch (item.kind) {
    case "banner":
      return; // drawn as a group after the shapes
    case "measure": {
      const a = worldToScreen(view, item.a), b = worldToScreen(view, item.b);
      strokeLine(ctx, a, b, ACCENT, item.live);
      strokeTicks(ctx, a, b, ACCENT);
      const mid = midpoint(a, b);
      text(ctx, item.label, mid.x, mid.y - 11, ACCENT, "center");
      if (item.hint) text(ctx, item.hint, mid.x, mid.y + 12, "#c8d2e0", "center");
      return;
    }
    case "rotateGizmo": {
      const center = worldToScreen(view, item.center);
      const knob = worldToScreen(view, item.knob);
      const radius = Math.abs(item.radius * view.scale);
      ctx.save();
      ctx.strokeStyle = "rgba(125, 180, 255, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(center.x, center.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (item.line) {
        const la = worldToScreen(view, item.line.a), lb = worldToScreen(view, item.line.b);
        strokeLine(ctx, la, lb, "#ffd24d", true);
        const tag = item.line.axis === "horizontal" ? "→ horizontal" : "↕ vertical";
        text(ctx, tag, midpoint(la, lb).x, midpoint(la, lb).y - 11, "#ffd24d", "center");
      }
      drawKnob(ctx, knob, item.dragging);
      return;
    }
    case "alignMarkers": {
      for (const marker of item.points) {
        const p = worldToScreen(view, marker.p);
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
        ctx.fillStyle = marker.phase === "moving" ? MOVING : REFERENCE;
        ctx.fill();
        ctx.strokeStyle = DARK;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.font = `bold 12px ${FONT_STACK}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = DARK;
        ctx.fillText(String(marker.index), p.x, p.y + 0.5);
        ctx.restore();
      }
      return;
    }
    case "cropPreview": {
      const poly = item.polygon.map((p) => worldToScreen(view, p));
      if (poly.length < 3) return;
      ctx.save();
      // Dim everything outside the kept polygon: canvas rect + polygon under
      // the evenodd fill rule punches the kept region out of the shade.
      ctx.beginPath();
      ctx.rect(0, 0, view.width, view.height);
      ctx.moveTo(poly[0].x, poly[0].y);
      for (const corner of poly.slice(1)) ctx.lineTo(corner.x, corner.y);
      ctx.closePath();
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.fill("evenodd");
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (const corner of poly.slice(1)) ctx.lineTo(corner.x, corner.y);
      ctx.closePath();
      ctx.strokeStyle = CROP_STROKE;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }
    case "resizeLine": {
      const a = worldToScreen(view, item.a), b = worldToScreen(view, item.b);
      const color = item.step === 1 ? MOVING : REFERENCE;
      strokeLine(ctx, a, b, color, false);
      strokeTicks(ctx, a, b, color);
      const tag = item.axis === "x" ? "→ width" : "↕ height";
      const mid = midpoint(a, b);
      text(ctx, tag, mid.x, mid.y - 11, color, "center");
      return;
    }
  }
}

function drawBanners(ctx: CanvasRenderingContext2D, items: Array<Extract<VisualToolOverlay, { kind: "banner" }>>, view: OverlayView): void {
  if (!items.length) return;
  ctx.save();
  ctx.font = `600 12px ${FONT_STACK}`;
  let y = 10;
  for (const item of items) {
    const w = ctx.measureText(item.text).width + 22;
    const h = 22;
    const x = view.width / 2 - w / 2;
    pill(ctx, x, y, w, h, 11);
    ctx.fillStyle = BANNER_BG;
    ctx.fill();
    ctx.strokeStyle = TONES[item.tone];
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = TONES[item.tone];
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(item.text, x + w / 2, y + h / 2 + 0.5);
    y += h + 6;
  }
  ctx.restore();
}

/** Grabbable rotate knob: filled disc with a dark border and a small arc
 * arrow inside, hinting the drag direction (like the reference app). */
function drawKnob(ctx: CanvasRenderingContext2D, knob: Point, dragging: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(knob.x, knob.y, 11, 0, Math.PI * 2);
  ctx.fillStyle = dragging ? KNOB_DRAG : KNOB_IDLE;
  ctx.fill();
  ctx.strokeStyle = DARK;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const theta = Math.PI * 0.9;
  ctx.beginPath();
  ctx.arc(knob.x, knob.y, 6, -Math.PI * 0.2, theta);
  ctx.stroke();
  const tip = { x: knob.x + 6 * Math.cos(theta), y: knob.y + 6 * Math.sin(theta) };
  const tangent = { x: -Math.sin(theta), y: Math.cos(theta) };
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - tangent.x * 4 - Math.cos(theta) * 2, tip.y - tangent.y * 4 - Math.sin(theta) * 2);
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - tangent.x * 4 + Math.cos(theta) * 2, tip.y - tangent.y * 4 + Math.sin(theta) * 2);
  ctx.stroke();
  ctx.restore();
}

/** Magnifier loupe over the cursor's world point: copies an already-painted
 * CSS-px region of the canvas (scaled by the real backing ratio) into a
 * bordered square placed beside the cursor, never covering it. */
function drawLoupe(ctx: CanvasRenderingContext2D, at: Point, view: OverlayView): void {
  const canvas = ctx.canvas;
  if (!canvas || canvas.width < 2 || canvas.height < 2) return;
  const cssWidth = canvas.clientWidth || view.width;
  const cssHeight = canvas.clientHeight || view.height;
  if (cssWidth <= 0 || cssHeight <= 0) return;
  const center = worldToScreen(view, at);
  const sourceSize = LOUPE_SIZE / LOUPE_ZOOM;
  const rect = loupePlacement(center, LOUPE_SIZE, sourceSize / 2 + 2, cssWidth, cssHeight);
  if (!rect) return;
  const ratio = canvas.width / cssWidth; // real backing px per CSS px
  const sx = (center.x - sourceSize / 2) * ratio;
  const sy = (center.y - sourceSize / 2) * ratio;
  const sw = sourceSize * ratio;
  const sh = sourceSize * ratio;
  if (sx < 0 || sy < 0 || sx + sw > canvas.width || sy + sh > canvas.height) return;
  ctx.save();
  ctx.drawImage(canvas, sx, sy, sw, sh, rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
  ctx.strokeStyle = "rgba(255, 205, 17, 0.7)";
  ctx.lineWidth = 1;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  ctx.beginPath();
  ctx.moveTo(cx - 8, cy);
  ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8);
  ctx.lineTo(cx, cy + 8);
  ctx.stroke();
  text(ctx, `${LOUPE_ZOOM}×`, rect.x + 6, rect.y + 12, ACCENT);
  ctx.restore();
}
