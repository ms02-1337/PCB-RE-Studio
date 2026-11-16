import { padCopperContains, padContours, padHole } from "./padGeometry";
import type { Point } from "../placement/projectDoc";
import type { VisualPcb } from "../visual/model";
import { visualId } from "../visual/model";
import type { ElectricalComponent } from "./model";
import type { ComponentDefinition, KFootprint, KGraphic } from "../../bridge/kicad";

/** KiCad field placeholders (e.g. "${REFERENCE}") are substituted per placement, never painted literally. */
export function isPlaceholderText(g: KGraphic): boolean {
  return g.kind === "text" && (g.text?.includes("${") ?? false);
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
/** Axis-aligned limit of the drawn footprint geometry (graphics anchors plus pad extents), in local units. */
export function footprintBounds(fp: KFootprint): Bounds | undefined {
  const points: Point[] = [];
  for (const g of fp.graphics) {
    if (isPlaceholderText(g)) continue;
    points.push(...g.points);
  }
  for (const pad of fp.pads) {
    const r = Math.hypot(pad.width, pad.height) / 2;
    points.push({ x: pad.x - r, y: pad.y - r }, { x: pad.x + r, y: pad.y + r });
  }
  if (!points.length) return undefined;
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}
export function padPoint(
  c: ElectricalComponent,
  p: Point,
  pxPerMm: number,
): Point {
  const a = (c.rotation * Math.PI) / 180,
    s = c.scale * pxPerMm;
  return {
    x: c.x + (p.x * Math.cos(a) - p.y * Math.sin(a)) * s,
    y: c.y + (p.x * Math.sin(a) + p.y * Math.cos(a)) * s,
  };
}
export function localPoint(
  c: ElectricalComponent,
  p: Point,
  pxPerMm: number,
): Point {
  const a = (-c.rotation * Math.PI) / 180,
    s = c.scale * pxPerMm,
    x = (p.x - c.x) / s,
    y = (p.y - c.y) / s;
  return {
    x: x * Math.cos(a) - y * Math.sin(a),
    y: x * Math.sin(a) + y * Math.cos(a),
  };
}
export const padContains = padCopperContains;
export function terminalNumbers(d: ComponentDefinition) {
  return [
    ...new Set(
      d.footprint.pads
        .filter((p) => p.type !== "np_thru_hole" && !(p.drill && !p.plated))
        .map((p) => p.number)
        .filter(Boolean),
    ),
  ];
}
export function createInstance(
  pcb: VisualPcb,
  d: ComponentDefinition,
  p: Point,
  layerId: string,
): ElectricalComponent {
  let n = 1;
  const prefix = d.referencePrefix || "U";
  while (pcb.components?.some((c) => c.reference === prefix + n)) n++;
  return {
    id: visualId(),
    definition: structuredClone(d),
    reference: prefix + n,
    value: d.value,
    partName: d.partName,
    x: p.x,
    y: p.y,
    layerId,
    rotation: 0,
    scale: 1,
    terminals: terminalNumbers(d).map((number) => ({ number })),
  };
}
export function ensureSchematic(pcb: VisualPcb) {
  pcb.schematic ??= { units: [], wires: [], labels: [] };
  for (const c of pcb.components ?? []) {
    const units = [
      ...new Set(
        c.definition.symbol?.units
          .filter((u) => u.bodyStyle <= 1 && u.unit > 0)
          .map((u) => u.unit) ?? [1],
      ),
    ];
    for (const unit of units)
      if (
        !pcb.schematic.units.some(
          (u) => u.componentId === c.id && u.unit === unit,
        )
      ) {
        const n = pcb.schematic.units.length;
        pcb.schematic.units.push({
          id: visualId(),
          componentId: c.id,
          unit,
          x: 30 + (n % 5) * 50,
          y: 30 + Math.floor(n / 5) * 50,
          rotation: 0,
        });
      }
  }
}
export function mapReplacement(c: ElectricalComponent, d: ComponentDefinition) {
  const numbers = terminalNumbers(d);
  return {
    ...c,
    definition: structuredClone(d),
    terminals: numbers.map(
      (number) => c.terminals.find((t) => t.number === number) ?? { number },
    ),
  };
}
export function drawGraphics(
  ctx: CanvasRenderingContext2D,
  graphics: KGraphic[],
) {
  for (const g of graphics) {
    if (isPlaceholderText(g)) continue;
    ctx.lineWidth = g.width || 0.15;
    ctx.beginPath();
    const a = g.points[0],
      b = g.points[1];
    if (!a) continue;
    if (g.kind === "text") {
      ctx.font = "1px sans-serif";
      ctx.fillText(g.text ?? "", a.x, a.y);
      continue;
    }
    if (g.kind === "circle" && b)
      ctx.arc(a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y), 0, Math.PI * 2);
    else if (g.kind === "rect" && b) ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    else {
      ctx.moveTo(a.x, a.y);
      for (const p of g.points.slice(1)) ctx.lineTo(p.x, p.y);
    }
    if (g.fill) ctx.fill();
    ctx.stroke();
  }
}
export function drawFootprint(
  ctx: CanvasRenderingContext2D,
  c: ElectricalComponent,
  px: number,
  color: string,
  highlightPads?: Set<string>,
  dimmed?: boolean,
) {
  ctx.save();
  if (dimmed) ctx.globalAlpha *= 0.25;
  ctx.translate(c.x, c.y);
  ctx.rotate((c.rotation * Math.PI) / 180);
  ctx.scale(c.scale * px, c.scale * px);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  drawGraphics(ctx, c.definition.footprint.graphics);
  for (const p of c.definition.footprint.pads) {
    ctx.save();
    const isPadHl = highlightPads?.has(p.number);
    const hole = padHole(p);
    if (hole.length) {
      ctx.beginPath();
      ctx.rect(-1e6, -1e6, 2e6, 2e6);
      ctx.moveTo(hole[0].x, hole[0].y);
      for (const q of hole.slice(1)) ctx.lineTo(q.x, q.y);
      ctx.closePath();
      ctx.clip("evenodd");
    }
    if (isPadHl) {
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha *= 0.7;
    }
    for (const pts of padContours(p)) {
      if (!pts.length) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y);
      ctx.closePath();
      ctx.fill();
      if (isPadHl) {
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = Math.max(0.1, 2.5 / Math.max(0.001, c.scale * px));
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
    ctx.font = ".7px sans-serif";
    ctx.fillText(p.number, p.x, p.y - p.height / 2 - 0.25);
  }
  const bounds = footprintBounds(c.definition.footprint);
  if (c.reference) {
    ctx.font = "1px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      c.reference,
      bounds ? (bounds.minX + bounds.maxX) / 2 : 0,
      bounds ? bounds.minY - 0.25 : -2,
    );
  }
  ctx.restore();
}
export function replacementBoards(
  pcbs: VisualPcb[],
  ids: string[],
  definition: ComponentDefinition,
): { boards: VisualPcb[]; detached: string[] } {
  const boards = pcbs
      .filter((p) => p.components?.some((c) => ids.includes(c.id)))
      .map((p) => structuredClone(p)),
    detached: string[] = [];
  for (const p of boards) {
    for (const c of p.components ?? []) {
      if (!ids.includes(c.id)) continue;
      const allowed = new Set(terminalNumbers(definition));
      for (const t of c.terminals)
        if (!allowed.has(t.number) && t.netId)
          detached.push(c.reference + "." + t.number);
      Object.assign(c, mapReplacement(c, definition));
    }
    const terminals = new Map(
      (p.components ?? []).map((c) => [
        c.id,
        new Set(c.terminals.map((t) => t.number)),
      ]),
    );
    if (p.schematic) {
      p.schematic.wires = p.schematic.wires.filter((w) =>
        [w.start, w.end].every(
          (a) => !a || terminals.get(a.componentId)?.has(a.terminal),
        ),
      );
      p.schematic.labels = p.schematic.labels.filter(
        (l) =>
          !l.anchor ||
          terminals.get(l.anchor.componentId)?.has(l.anchor.terminal),
      );
      p.schematic.units = p.schematic.units.filter((u) => {
        const c = p.components?.find((c) => c.id === u.componentId);
        return (
          c &&
          (!c.definition.symbol
            ? u.unit === 1
            : c.definition.symbol.units.some((s) => s.unit === u.unit))
        );
      });
    }
    for (const t of p.traces ?? [])
      for (const key of ["startPad", "endPad"] as const) {
        const a = t[key];
        if (a && !terminals.get(a.componentId)?.has(a.terminal)) delete t[key];
      }
    ensureSchematic(p);
  }
  return { boards, detached };
}
/** Footprint extent boxes closer than this many millimetres count as
 * "very near" even without intersecting. Extent boxes are conservative
 * (graphics anchors plus circumscribed pad extents, not courtyard outlines),
 * so the threshold stays small to avoid flagging legitimate dense layouts. */
export const NEAR_OVERLAP_MM = 0.5;
export interface ComponentProximity {
  a: ElectricalComponent;
  b: ElectricalComponent;
  /** True when the extent boxes intersect; touching counts. */
  overlapping: boolean;
  /** Box separation in millimetres; 0 when overlapping. */
  gapMm: number;
}
/** World-space AABB of a placed component's footprint extents — the same
 * geometry used for body hit-testing, rotated, scaled and offset like
 * padPoint. */
export function componentWorldBounds(
  c: ElectricalComponent,
  pxPerMm: number,
): Bounds | undefined {
  const b = footprintBounds(c.definition.footprint);
  if (!b) return undefined;
  const a = (c.rotation * Math.PI) / 180,
    s = c.scale * pxPerMm,
    cos = Math.cos(a) * s,
    sin = Math.sin(a) * s,
    corners = [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.minX, y: b.maxY },
      { x: b.maxX, y: b.maxY },
    ].map((p) => ({
      x: c.x + p.x * cos - p.y * sin,
      y: c.y + p.x * sin + p.y * cos,
    }));
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxX: Math.max(...corners.map((p) => p.x)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}
/** Pairs of components whose footprint extent boxes overlap or sit closer
 * than `nearMm`. Same-layer pairs only: front and back components may stack
 * physically. Result order is deterministic so notifications stay stable
 * across redraws. */
export function componentProximities(
  components: ElectricalComponent[],
  pxPerMm: number,
  nearMm = NEAR_OVERLAP_MM,
): ComponentProximity[] {
  const px = pxPerMm > 0 ? pxPerMm : 1,
    near = nearMm * px,
    boxes = components.map((c) => ({
      c,
      box: componentWorldBounds(c, px),
    })),
    result: ComponentProximity[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const first = boxes[i];
    if (!first.box) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      const second = boxes[j];
      if (!second.box || first.c.layerId !== second.c.layerId) continue;
      const dx = Math.max(
          first.box.minX - second.box.maxX,
          second.box.minX - first.box.maxX,
        ),
        dy = Math.max(
          first.box.minY - second.box.maxY,
          second.box.minY - first.box.maxY,
        );
      if (dx > near || dy > near) continue;
      const gapPx = Math.hypot(Math.max(0, dx), Math.max(0, dy));
      if (gapPx > near) continue;
      result.push({
        a: first.c,
        b: second.c,
        overlapping: dx <= 0 && dy <= 0,
        gapMm: gapPx / px,
      });
    }
  }
  return result.sort(
    (x, y) =>
      x.a.reference.localeCompare(y.a.reference) ||
      x.b.reference.localeCompare(y.b.reference),
  );
}
/** Component body selection is deliberately broader than electrical copper hit testing. */
export function componentContains(
  c: ElectricalComponent,
  p: Point,
  px: number,
  layer: string,
): boolean {
  const local = localPoint(c, p, px);
  if (
    c.definition.footprint.pads.some(
      (pad) =>
        (c.layerId === layer || !!(pad.plated && pad.drill)) &&
        padContains(pad, local),
    )
  )
    return true;
  if (c.layerId !== layer) return false;
  const b = footprintBounds(c.definition.footprint);
  return (
    !!b &&
    local.x >= b.minX &&
    local.x <= b.maxX &&
    local.y >= b.minY &&
    local.y <= b.maxY
  );
}
