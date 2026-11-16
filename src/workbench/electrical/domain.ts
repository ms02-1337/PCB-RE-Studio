import { padCopperContains,padContours,padHole } from "./padGeometry";
import type { Point } from "../placement/projectDoc";
import type { VisualPcb } from "../visual/model";
import { visualId } from "../visual/model";
import type { ElectricalComponent } from "./model";
import type { ComponentDefinition, KGraphic } from "../../bridge/kicad";
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
export const padContains=padCopperContains;
export function terminalNumbers(d: ComponentDefinition) {
  return [...new Set(d.footprint.pads.filter(p=>p.type!=="np_thru_hole"&&!(p.drill&&!p.plated)).map((p) => p.number).filter(Boolean))];
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
) {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate((c.rotation * Math.PI) / 180);
  ctx.scale(c.scale * px, c.scale * px);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  drawGraphics(ctx, c.definition.footprint.graphics);
  for(const p of c.definition.footprint.pads){ctx.beginPath();for(const pts of [...padContours(p),padHole(p)]){if(!pts.length)continue;ctx.moveTo(pts[0].x,pts[0].y);for(const q of pts.slice(1))ctx.lineTo(q.x,q.y);ctx.closePath();}ctx.globalAlpha=.7;ctx.fill('evenodd');ctx.globalAlpha=1;ctx.font='.7px sans-serif';ctx.fillText(p.number,p.x,p.y-p.height/2-.25);}  ctx.font = "1px sans-serif";
  ctx.fillText(c.reference, 0, -2);
  ctx.restore();
}



