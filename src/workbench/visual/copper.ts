import { padContours, padHole } from "../electrical/padGeometry";
import { padPoint } from "../electrical/domain";
import type { Point } from "../placement/projectDoc";
import {
  visualId,
  resizeLayers,
  type VisualPcb,
  type CopperTrace,
  type CopperVia,
} from "./model";

export const distance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);
export function layerResizePlan(
  pcb: VisualPcb,
  count: number,
  destination?: string,
) {
  const next = JSON.parse(JSON.stringify(pcb)) as VisualPcb;
  resizeLayers(next, count);
  const moved = [...(next.traces ?? []), ...(next.zones ?? [])].filter(
    (e) => !next.layers.includes(e.layerId),
  );
  if (moved.length && (!destination || !next.layers.includes(destination)))
    return null;
  for (const e of moved) e.layerId = destination!;
  const ids = new Set<string>();
  for (const e of moved) {
    const group = connected(next, [e.id]);
    const nets = [
      ...new Set(
        group.map((c) => c.netId).filter((id): id is string => Boolean(id)),
      ),
    ];
    if (nets.length > 1) for (const id of nets) ids.add(id);
    else if (nets.length === 1) for (const c of group) c.netId = nets[0];
  }
  return { next, conflicts: [...ids] };
}
export function project(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  return { x: a.x + t * dx, y: a.y + t * dy };
}
export function segmentsDistance(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): number {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (
    cross(a, b, c) * cross(a, b, d) < 0 &&
    cross(c, d, a) * cross(c, d, b) < 0
  )
    return 0;
  return Math.min(
    distance(a, project(a, c, d)),
    distance(b, project(b, c, d)),
    distance(c, project(c, a, b)),
    distance(d, project(d, a, b)),
  );
}
export function inside(p: Point, points: Point[]): boolean {
  let yes = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (distance(p, project(p, a, b)) < 1e-8) return true;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      yes = !yes;
  }
  return yes;
}
export const length = (points: Point[]) =>
  points.slice(1).reduce((n, p, i) => n + distance(points[i], p), 0);
export const area = (points: Point[]) =>
  Math.abs(
    points.reduce((n, p, i) => {
      const q = points[(i + 1) % points.length];
      return n + p.x * q.y - q.x * p.y;
    }, 0),
  ) / 2;
export function validPolygon(points: Point[]): boolean {
  if (
    points.length < 3 ||
    points.length > 4096 ||
    !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ||
    area(points) < 1e-8
  )
    return false;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (
        segmentsDistance(
          points[i],
          points[(i + 1) % points.length],
          points[j],
          points[(j + 1) % points.length],
        ) < 1e-8
      )
        return false;
    }
  return true;
}
export interface PadConductor extends CopperTrace {
  padTerminal: string;
  padCenter: Point;
  attachment: { componentId: string; terminal: string };
  hole?: Point[];
}
export type Conductor = CopperTrace | CopperVia | PadConductor;
export function padConductors(
  pcb: VisualPcb,
  includeNc = false,
): PadConductor[] {
  return (pcb.components ?? []).flatMap((c) =>
    c.definition.footprint.pads.flatMap((p, i) => {
      if (!p.number || p.type === "np_thru_hole" || (!p.plated && p.drill))
        return [];
      const terminal = c.terminals.find((t) => t.number === p.number);
      if (!terminal || (!includeNc && terminal.nc)) return [];
      const layers = p.plated && p.drill ? pcb.layers : [c.layerId];
      const hole = padHole(p).map((v) => padPoint(c, v, pcb.pxPerMm ?? 1));
      return padContours(p).flatMap((contour, k) => {
        const pts = contour.map((v) => padPoint(c, v, pcb.pxPerMm ?? 1));
        if (pts.length < 3) return [];
        return layers.map((layerId) => ({
          id: c.id + ":" + p.number + ":" + layerId + ":" + i + ":" + k,
          padTerminal: c.id + ":" + p.number,
          attachment: { componentId: c.id, terminal: p.number },
          padCenter: padPoint(c, p, pcb.pxPerMm ?? 1),
          layerId,
          points: [...pts, pts[0]],
          hole,
          width: 0,
          get netId() {
            return terminal.netId;
          },
          set netId(value: string | undefined) {
            terminal.netId = value;
          },
        }));
      });
    }),
  );
}
interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
function bounds(c: Conductor): Bounds {
  const points = "points" in c ? c.points : [c];
  const radius = "points" in c ? c.width / 2 : c.diameter / 2;
  return {
    left: Math.min(...points.map((p) => p.x)) - radius,
    right: Math.max(...points.map((p) => p.x)) + radius,
    top: Math.min(...points.map((p) => p.y)) - radius,
    bottom: Math.max(...points.map((p) => p.y)) + radius,
  };
}
/** Immutable-document index; broad-phase bounds avoid pairwise geometry scans. */
export function copperIndex(pcb: VisualPcb) {
  const entries: { element: Conductor; box: Bounds }[] = [
    ...(pcb.traces ?? []),
    ...(pcb.vias ?? []),
    ...padConductors(pcb),
  ]
    .map((element) => ({ element, box: bounds(element) }))
    .sort((a, b) => a.box.left - b.box.left);
  return {
    query: (box: Bounds) => {
      const found: Conductor[] = [];
      for (const item of entries) {
        if (item.box.left > box.right) break;
        if (
          item.box.right >= box.left &&
          item.box.top <= box.bottom &&
          item.box.bottom >= box.top
        )
          found.push(item.element);
      }
      return found;
    },
  };
}
export function touches(a: Conductor, b: Conductor): boolean {
  if (
    "padTerminal" in a &&
    "padTerminal" in b &&
    a.padTerminal === b.padTerminal
  )
    return true;
  if ("padTerminal" in a || "padTerminal" in b) {
    const p = ("padTerminal" in a ? a : b) as PadConductor,
      o = p === a ? b : a;
    if ("points" in o) {
      if (p.layerId !== o.layerId) return false;
      if (
        "padTerminal" in o &&
        p.points.some(
          (q) =>
            inside(q, o.points) &&
            !(o.hole?.length && inside(q, o.hole)) &&
            !(p.hole?.length && inside(q, p.hole)),
        )
      )
        return true;
      if (
        o.points.some(
          (q) => inside(q, p.points) && !(p.hole?.length && inside(q, p.hole)),
        )
      )
        return true;
    } else if (
      inside(o, p.points) &&
      !(p.hole?.length && inside(o, p.hole)) &&
      !p.points.every((q) => distance(q, o) < o.drill / 2)
    )
      return true;
  }
  if ("points" in a && "points" in b)
    return (
      a.layerId === b.layerId &&
      a.points
        .slice(1)
        .some((p, i) =>
          b.points
            .slice(1)
            .some(
              (q, j) =>
                segmentsDistance(a.points[i], p, b.points[j], q) <=
                (a.width + b.width) / 2 + 1e-8,
            ),
        )
    );
  if (!("points" in a) && !("points" in b)) {
    const d = distance(a, b);
    return (
      d <= (a.diameter + b.diameter) / 2 + 1e-8 &&
      d + a.diameter / 2 >= b.drill / 2 - 1e-8 &&
      d + b.diameter / 2 >= a.drill / 2 - 1e-8
    );
  }
  const t = ("points" in a ? a : b) as CopperTrace,
    v = ("points" in a ? b : a) as CopperVia;
  return t.points
    .slice(1)
    .some(
      (p, i) =>
        distance(v, project(v, t.points[i], p)) <=
          (v.diameter + t.width) / 2 + 1e-8 &&
        Math.max(distance(v, t.points[i]), distance(v, p)) + t.width / 2 >=
          v.drill / 2 - 1e-8,
    );
}
export function newNet(pcb: VisualPcb, name?: string) {
  pcb.nets ??= [];
  let n = 1;
  // Case-insensitive: a user net "net1" must still block auto "NET1" —
  // NetsPanel's duplicate check is case-insensitive too.
  while (pcb.nets.some((net) => net.name.toLowerCase() === `net${n}`)) n++;
  const palette = [
    "#e5484d",
    "#4f8fdb",
    "#9b6dff",
    "#e08a2e",
    "#2fbfa8",
    "#52b788",
    "#d9a406",
    "#d46cc1",
  ];
  const net = {
    id: visualId(),
    name: name?.trim() || `NET${n}`,
    color: palette[Math.floor(Math.random() * palette.length)],
  };
  pcb.nets.push(net);
  return net;
}
/** Resolve physical connectivity on a proposed copy, before a single store commit. */
export function connected(pcb: VisualPcb, seeds: string[]): Conductor[] {
  const all: Conductor[] = [
    ...(pcb.traces ?? []),
    ...(pcb.vias ?? []),
    ...padConductors(pcb),
  ];
  const result = all.filter((c) =>
    seeds.some(
      (id) => c.id === id || ("padTerminal" in c && c.padTerminal === id),
    ),
  );
  const index = copperIndex(pcb);
  for (let i = 0; i < result.length; i++)
    for (const c of [
      ...index.query(bounds(result[i])),
      ...all.filter(
        (c) =>
          "padTerminal" in c &&
          "padTerminal" in result[i] &&
          c.padTerminal === (result[i] as PadConductor).padTerminal,
      ),
    ])
      if (!result.some((r) => r.id === c.id) && touches(result[i], c))
        result.push(c);
  return result;
}
export function mergeNets(pcb: VisualPcb, ids: string[], survivor: string) {
  for (const c of [
    ...(pcb.traces ?? []),
    ...(pcb.vias ?? []),
    ...padConductors(pcb),
    ...(pcb.zones ?? []),
  ])
    if (c.netId && ids.includes(c.netId)) c.netId = survivor;
  for (const c of pcb.components ?? [])
    for (const t of c.terminals)
      if (t.netId && ids.includes(t.netId)) t.netId = survivor;
  for (const w of pcb.schematic?.wires ?? [])
    if (w.netId && ids.includes(w.netId)) w.netId = survivor;
  for (const l of pcb.schematic?.labels ?? [])
    if (ids.includes(l.netId)) l.netId = survivor;
  pcb.nets = pcb.nets?.filter((n) => !ids.includes(n.id) || n.id === survivor);
}

/** One member of a net: a component pad or a copper element, with the data
 * the net tables, the elements modal and canvas focusing all need. */
export interface NetElement {
  kind: "pad" | "trace" | "via" | "zone";
  /** Copper elements use their own id; pads use the owning component id. */
  id: string;
  /** Pad terminal number; absent for copper elements. */
  terminal?: string;
  name: string;
  layerId?: string;
  comment?: string;
  /** World-space AABB for canvas focusing. */
  bounds: { left: number; right: number; top: number; bottom: number };
}

/** Every element assigned to a net: component terminals first, then traces,
 * vias and zones — the single source for counts, listings and navigation. */
export function netElements(pcb: VisualPcb, netId: string): NetElement[] {
  const pxPerMm = pcb.pxPerMm ?? 1;
  const out: NetElement[] = [];
  for (const c of pcb.components ?? [])
    for (const t of c.terminals ?? []) {
      if (t.netId !== netId) continue;
      const pad = c.definition.footprint.pads.find(
        (p) => p.number === t.number,
      );
      const center = pad ? padPoint(c, pad, pxPerMm) : { x: c.x, y: c.y };
      const radius = pad ? Math.max(pad.width, pad.height) / 2 : 2;
      out.push({
        kind: "pad",
        id: c.id,
        terminal: t.number,
        name: `${c.reference} pin ${t.number}`,
        layerId: c.layerId,
        comment: t.comment,
        bounds: {
          left: center.x - radius,
          right: center.x + radius,
          top: center.y - radius,
          bottom: center.y + radius,
        },
      });
    }
  for (const t of pcb.traces ?? []) {
    if (t.netId !== netId) continue;
    const xs = t.points.map((p) => p.x);
    const ys = t.points.map((p) => p.y);
    const left = Math.min(...xs) - t.width / 2;
    const right = Math.max(...xs) + t.width / 2;
    const top = Math.min(...ys) - t.width / 2;
    const bottom = Math.max(...ys) + t.width / 2;
    const widthMm = pcb.pxPerMm ? (t.width / pxPerMm).toFixed(2) : "0.00";
    const lengthMm = pcb.pxPerMm ? (length(t.points) / pxPerMm).toFixed(2) : "0.00";
    out.push({
      kind: "trace",
      id: t.id,
      name: `Trace ${t.id} (${widthMm}mm, ${lengthMm}mm)`,
      layerId: t.layerId,
      comment: t.comment,
      bounds: { left, right, top, bottom },
    });
  }
  for (const v of pcb.vias ?? []) {
    if (v.netId !== netId) continue;
    out.push({
      kind: "via",
      id: v.id,
      name: `Via ${v.id} (Ø ${(v.diameter / pxPerMm).toFixed(2)}mm)`,
      comment: v.comment,
      bounds: {
        left: v.x - v.diameter / 2,
        right: v.x + v.diameter / 2,
        top: v.y - v.diameter / 2,
        bottom: v.y + v.diameter / 2,
      },
    });
  }
  for (const z of pcb.zones ?? []) {
    if (z.netId !== netId) continue;
    const xs = z.points.map((p) => p.x);
    const ys = z.points.map((p) => p.y);
    out.push({
      kind: "zone",
      id: z.id,
      name: `Zone ${z.id} (${z.points.length} vertices)`,
      layerId: z.layerId,
      comment: z.comment,
      bounds: {
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys),
      },
    });
  }
  return out;
}

/** Passive census only: a zone never electrically joins its contents. */
export function zoneCensus(
  pcb: VisualPcb,
  zone: { layerId: string; points: Point[] },
) {
  const edges = zone.points.map((p, i) => [
    p,
    zone.points[(i + 1) % zone.points.length],
  ]);
  const traces = (pcb.traces ?? []).filter(
    (t) =>
      t.layerId === zone.layerId &&
      (t.points.some((p) => inside(p, zone.points)) ||
        t.points
          .slice(1)
          .some((p, i) =>
            edges.some(
              ([a, b]) => segmentsDistance(t.points[i], p, a, b) <= t.width / 2,
            ),
          )),
  ).length;
  const vias = (pcb.vias ?? []).filter(
    (v) =>
      inside(v, zone.points) ||
      edges.some(([a, b]) => distance(v, project(v, a, b)) <= v.diameter / 2),
  ).length;
  return { traces, vias };
}

export function ncContacts(pcb: VisualPcb): string[] {
  const nc = new Set(
    (pcb.components ?? []).flatMap((c) =>
      c.terminals.filter((t) => t.nc).map((t) => c.id + ":" + t.number),
    ),
  );
  const pads = padConductors(pcb, true).filter((p) => nc.has(p.padTerminal));
  return [
    ...new Set(
      pads
        .filter((p) =>
          [
            ...(pcb.traces ?? []),
            ...(pcb.vias ?? []),
            ...padConductors(pcb),
          ].some((c) => c.id !== p.id && touches(p, c)),
        )
        .map((p) => p.padTerminal),
    ),
  ];
}

/** Open ends use physical contact, independent of logical net assignments. */
export function openTraceEnds(pcb: VisualPcb): { traceId: string; layerId: string; point: Point }[] {
  const index = copperIndex(pcb);
  return (pcb.traces ?? []).flatMap(trace => {
    if (trace.points.length < 2) return [];
    return [trace.points[0], trace.points[trace.points.length - 1]].flatMap(point => {
      const radius = trace.width / 2;
      const tip: CopperTrace = { ...trace, points: [point, point] };
      const contact = index.query({ left: point.x-radius, right: point.x+radius, top: point.y-radius, bottom: point.y+radius })
        .some(other => other.id !== trace.id && touches(tip, other));
      // A closed loop has no open ends.
      return contact || distance(trace.points[0], trace.points[trace.points.length-1]) < 1e-8
        ? [] : [{ traceId: trace.id, layerId: trace.layerId, point }];
    });
  });
}
