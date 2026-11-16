import {
  createEffect,
  createMemo,
  createSignal,
  on,
  For,
  Show,
} from "solid-js";
import type { KGraphic, KPin } from "../../bridge/kicad";
import type { PlacementStore } from "../placement/store";
import type { Point } from "../placement/projectDoc";
import { visualId, type VisualPcb } from "../visual/model";
import { newNet, project, distance, ncContacts } from "../visual/copper";
import type {
  ElectricalComponent,
  SchematicDocument,
  SchematicUnit,
  SchematicWire,
  WireAnchor,
} from "./model";
import { exportSchematicPackage } from "./schematicExport";
import { assignTerminalNet } from "./actions";
import "./electrical.css";

export const emptySchematic = (): SchematicDocument => ({
  units: [],
  wires: [],
  labels: [],
});
const key = (a: WireAnchor) => `${a.componentId}/${a.terminal}`;
export function symbolPins(
  c: ElectricalComponent,
  unit: number,
  bodyStyle = 1,
): (KPin & { terminal: string })[] {
  if (!c.definition.symbol)
    return c.terminals.map((t, i) => ({
      number: t.number,
      terminal: t.number,
      name: t.number,
      x: -10,
      y: 5 - i * 2.54,
      rotation: 0,
      length: 2.54,
      electricalType: "passive",
      hidden: false,
    }));
  const pins = c.definition.symbol.units
    .filter(
      (u) =>
        (u.unit === unit || u.unit === 0) &&
        (u.bodyStyle === 0 || u.bodyStyle === bodyStyle),
    )
    .flatMap((u) => u.pins);
  const result = pins.flatMap((pin) => {
    const mapped = Object.entries(c.definition.pinMap)
      .filter(([, num]) => num === pin.number)
      .map(([terminal]) => ({ ...pin, terminal }));
    return mapped.length ? mapped : [{ ...pin, terminal: "" }];
  });
  if (unit === 1)
    for (const t of c.terminals)
      if (!c.definition.pinMap[t.number])
        result.push({
          number: t.number,
          terminal: t.number,
          name: "Unmapped",
          x: -15,
          y: -result.length * 2.54,
          rotation: 0,
          length: 2.54,
          electricalType: "passive",
          hidden: false,
        });
  return result;
}
export function schematicPoint(unit: SchematicUnit, p: Point): Point {
  const r = (unit.rotation * Math.PI) / 180,
    x = unit.flip ? -p.x : p.x,
    y = -p.y;
  return {
    x: unit.x + x * Math.cos(r) - y * Math.sin(r),
    y: unit.y + x * Math.sin(r) + y * Math.cos(r),
  };
}
export function initialUnits(
  components: ElectricalComponent[],
  existing: SchematicUnit[] = [],
): SchematicUnit[] {
  const result = existing.filter((u) =>
    components.some((c) => c.id === u.componentId),
  );
  for (const c of components) {
    const units = [
      ...new Set(
        c.definition.symbol?.units
          .filter((u) => u.unit > 0 && u.bodyStyle <= 1)
          .map((u) => u.unit) ?? [1],
      ),
    ];
    for (const unit of units.length ? units : [1])
      if (!result.some((u) => u.componentId === c.id && u.unit === unit)) {
        const i = result.length;
        result.push({
          id: visualId(),
          componentId: c.id,
          unit,
          x: 25 + (i % 5) * 40,
          y: 25 + Math.floor(i / 5) * 45,
          rotation: 0,
        });
      }
  }
  return result;
}
export function orthogonal(a: Point, b: Point): Point[] {
  return a.x === b.x || a.y === b.y ? [a, b] : [a, { x: b.x, y: a.y }, b];
}
export function resolveWireGeometry(
  pcb: VisualPcb,
  wire: SchematicWire,
): Point[] {
  const resolve = (anchor?: WireAnchor): Point | undefined => {
    if (!anchor) return;
    const c = pcb.components?.find((c) => c.id === anchor.componentId),
      u = pcb.schematic?.units.find(
        (u) =>
          u.componentId === anchor.componentId &&
          (!anchor.unit || u.unit === anchor.unit),
      );
    if (!c || !u) return;
    const pin = symbolPins(c, u.unit, u.bodyStyle ?? 1).find(
      (pin) => pin.terminal === anchor.terminal,
    );
    return pin ? schematicPoint(u, pin) : undefined;
  };
  const points = wire.points.map((p) => ({ ...p })),
    a = resolve(wire.start),
    b = resolve(wire.end);
  if (a) points[0] = a;
  if (b) points[points.length - 1] = b;
  return points.flatMap((p, i) =>
    i ? orthogonal(points[i - 1], p).slice(1) : [p],
  );
}
export function wiresJoined(a: SchematicWire, b: SchematicWire): boolean {
  const on = (p: Point, wire: SchematicWire) =>
    wire.points
      .slice(1)
      .some((q, i) => distance(p, project(p, wire.points[i], q)) < 1e-6);
  return (
    (!!a.points.length &&
      !!b.points.length &&
      [a.points[0], a.points.at(-1)!].some((p) => on(p, b))) ||
    (!!a.points.length &&
      !!b.points.length &&
      [b.points[0], b.points.at(-1)!].some((p) => on(p, a)))
  );
}
export function wireGroup(
  wires: SchematicWire[],
  seed: string,
): SchematicWire[] {
  const found = wires.filter((w) => w.id === seed);
  for (let i = 0; i < found.length; i++)
    for (const wire of wires)
      if (!found.includes(wire) && wiresJoined(found[i], wire))
        found.push(wire);
  return found;
}
export function segmentMidpoints(
  points: Point[],
): Array<Point & { seg: number }> {
  const out: Array<Point & { seg: number }> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i],
      b = points[i + 1];
    if (distance(a, b) > 1e-6)
      out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, seg: i });
  }
  return out;
}
export function Graphic(props: { graphic: KGraphic }) {
  const g = () => props.graphic,
    pts = () => g().points;
  return (
    <g
      fill={g().fill ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={Math.max(0.12, g().width)}
    >
      <Show when={g().kind === "circle" && pts().length > 1}>
        <circle
          cx={pts()[0].x}
          cy={-pts()[0].y}
          r={distance(pts()[0], pts()[1])}
        />
      </Show>
      <Show when={g().kind === "rect" && pts().length > 1}>
        <rect
          x={Math.min(pts()[0].x, pts()[1].x)}
          y={-Math.max(pts()[0].y, pts()[1].y)}
          width={Math.abs(pts()[1].x - pts()[0].x)}
          height={Math.abs(pts()[1].y - pts()[0].y)}
        />
      </Show>
      <Show when={g().kind === "text" && pts().length}>
        <text
          x={0}
          y={0}
          transform={`translate(${pts()[0].x} ${-pts()[0].y}) rotate(${-(g().rotation ?? 0)}) scale(${(g().fontSize?.width ?? 1.5) / (g().fontSize?.height ?? 1.5)} 1)`}
          fill="currentColor"
          stroke="none"
          font-size={String(g().fontSize?.height ?? 1.5)}
        >
          {g().text}
        </text>
      </Show>
      <Show when={!["circle", "rect", "text"].includes(g().kind)}>
        <path
          d={
            g().kind === "arc" && pts().length >= 3
              ? arcPath(pts())
              : g().kind === "bezier" && pts().length === 4
                ? `M ${pts()[0].x} ${-pts()[0].y} C ${pts()
                    .slice(1)
                    .map((p) => `${p.x} ${-p.y}`)
                    .join(" ")}`
                : pts()
                    .map((p, i) => `${i ? "L" : "M"} ${p.x} ${-p.y}`)
                    .join(" ")
          }
        />
      </Show>
    </g>
  );
}
export function arcPath(points: Point[]): string {
  const [a, b, c] = points.map((p) => ({ x: p.x, y: -p.y }));
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-10) return `M ${a.x} ${a.y} L ${c.x} ${c.y}`;
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  const center = {
    x: (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d,
    y: (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d,
  };
  const angle = (p: Point) => Math.atan2(p.y - center.y, p.x - center.x),
    mod = (v: number) => (v + Math.PI * 2) % (Math.PI * 2);
  const ccw = mod(angle(c) - angle(a)),
    middle = mod(angle(b) - angle(a)),
    sweep = middle <= ccw ? 1 : 0,
    span = sweep ? ccw : Math.PI * 2 - ccw,
    radius = distance(a, center);
  return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${c.x} ${c.y}`;
}
export function SchematicPanel(props: {
  store: PlacementStore;
  active?: boolean;
  onNavigate?: (id: string) => void;
  onReplace?: (ids: string[]) => void;
  onExport?: () => void;
}) {
  const pcb = props.store.visual.activePcb;
  const [selected, setSelected] = createSignal<string[]>([]),
    [selectedWire, setSelectedWire] = createSignal("");
  const [tool, setTool] = createSignal<
    "select" | "wire" | "label" | "junction"
  >("select");
  const [net, setNet] = createSignal(""),
    [message, setMessage] = createSignal("");
  const [view, setView] = createSignal({ x: 0, y: 0, w: 240, h: 160 });
  const [pending, setPending] = createSignal<{
      previous: VisualPcb;
      next: VisualPcb;
      nets: string[];
      apply: (survivor: string) => void;
    } | null>(null),
    [survivor, setSurvivor] = createSignal("");
  const [draft, setDraft] = createSignal<Point[]>([]),
    [cursor, setCursor] = createSignal<Point | null>(null);
  const [dragOffset, setDragOffset] = createSignal<Point | null>(null);
  const [wireDraft, setWireDraft] = createSignal<{
    id: string;
    points: Point[];
  } | null>(null);
  let wireDrag: { previous: VisualPcb; id: string; index: number } | null =
    null;
  let startAnchor: WireAnchor | undefined;
  let routeOrigin: VisualPcb | undefined;
  let drag: { point: Point; previous: VisualPcb; units: string[] } | null =
    null;
  let pan: {
    x: number;
    y: number;
    view: ReturnType<typeof view>;
    button: number;
    moved: boolean;
  } | null = null;
  // Right-drag panning must not mutate wires: contextmenu arrives after
  // pointerup on Windows and during the drag elsewhere.
  let skipContextJoint = false;
  let svg!: SVGSVGElement;
  let scope = "";
  const doc = () => pcb()?.schematic ?? emptySchematic();
  const components = () => pcb()?.components ?? [];
  const edit = (change: (p: VisualPcb) => void) => {
    const p = pcb();
    if (!p) return;
    const next = structuredClone(p);
    change(next);
    for (const w of next.schematic?.wires ?? [])
      w.points = resolveWireGeometry(next, w);
    props.store.visual.replacePcb(next);
  };
  const cancel = () => {
    setDraft([]);
    setCursor(null);
    drag = null;
    pan = null;
    setDragOffset(null);
    startAnchor = undefined;
    routeOrigin = undefined;
    wireDrag = null;
    setWireDraft(null);
  };
  createEffect(
    on([pcb, () => props.active, () => props.store.projectSession()], () => {
      const p = pcb();
      const s = `${props.store.projectSession()}/${p?.id}`;
      if (scope !== s) {
        scope = s;
        cancel();
        setSelected([]);
        setSelectedWire("");
        setPending(null);
        setNet("");
      }
      if (net() && !p?.nets?.some((n) => n.id === net())) setNet("");
      if (draft().length && routeOrigin !== p) cancel();
      if (props.active === false) {
        cancel();
        setPending(null);
        return;
      }
      const navigation = sessionStorage.getItem(
        "electrical-schematic-navigation",
      );
      if (navigation) {
        sessionStorage.removeItem("electrical-schematic-navigation");
        try {
          const request = JSON.parse(navigation) as { componentId: string };
          const requested =
            p?.schematic?.units.filter(
              (u) => u.componentId === request.componentId,
            ) ?? [];
          if (requested.length) {
            setSelected(requested.map((u) => u.id));
            const first = requested[0];
            setView({ x: first.x - 35, y: first.y - 25, w: 100, h: 70 });
          }
        } catch {
          /* Ignore stale navigation. */
        }
      }
      if (p && (p.components?.length ?? 0)) {
        const units = initialUnits(p.components!, [
          ...(p.schematic?.units ?? []),
        ]);
        if (
          units.length !== (p.schematic?.units.length ?? 0) ||
          units.some((u, i) => u.id !== p.schematic?.units[i]?.id)
        )
          edit((next) => {
            next.schematic ??= emptySchematic();
            next.schematic.units = units;
          });
      }
      if (drag && drag.previous !== p) {
        drag = null;
        setDragOffset(null);
      }
      if (pending() && pending()!.previous !== p) setPending(null);
    }),
  );
  const units = createMemo(() =>
    doc().units.map((u) => {
      const offset = dragOffset();
      return offset && selected().includes(u.id)
        ? { ...u, x: u.x + offset.x, y: u.y + offset.y }
        : u;
    }),
  );
  const pins = createMemo(() =>
    units().flatMap((u) => {
      const c = components().find((c) => c.id === u.componentId);
      return c
        ? symbolPins(c, u.unit, u.bodyStyle ?? 1)
            .filter((pin) => !!pin.terminal)
            .map((pin) => ({
              ...schematicPoint(u, pin),
              anchor: {
                componentId: c.id,
                terminal: pin.terminal,
                unit: u.unit,
              },
              pin,
              component: c,
            }))
        : [];
    }),
  );
  const anchorPoint = (anchor?: WireAnchor) =>
    anchor
      ? pins().find(
          (p) =>
            key(p.anchor) === key(anchor) &&
            (!anchor.unit || p.anchor.unit === anchor.unit),
        )
      : undefined;
  const wirePoints = (w: SchematicWire) => {
    const result = (
      wireDraft()?.id === w.id ? wireDraft()!.points : w.points
    ).map((p) => ({ ...p }));
    const a = anchorPoint(w.start),
      b = anchorPoint(w.end);
    if (a && result.length) result[0] = { x: a.x, y: a.y };
    if (b && result.length) result[result.length - 1] = { x: b.x, y: b.y };
    return result.flatMap((p, i) =>
      i ? orthogonal(result[i - 1], p).slice(1) : [p],
    );
  };
  const selectedWirePoints = () =>
    wirePoints(
      doc().wires.find((w) => w.id === selectedWire()) ?? {
        id: "",
        points: [],
      },
    );
  const coordinates = (event: PointerEvent | MouseEvent) => {
    if (svg.createSVGPoint && svg.getScreenCTM?.()) {
      const p = svg.createSVGPoint();
      p.x = event.clientX;
      p.y = event.clientY;
      const mapped = p.matrixTransform(svg.getScreenCTM()!.inverse());
      return { x: mapped.x, y: mapped.y };
    }
    const r = svg.getBoundingClientRect(),
      v = view();
    return {
      x: v.x + ((event.clientX - r.left) * v.w) / (r.width || 1),
      y: v.y + ((event.clientY - r.top) * v.h) / (r.height || 1),
    };
  };
  const grid = (p: Point) => ({
    x: Math.round(p.x / 1.27) * 1.27,
    y: Math.round(p.y / 1.27) * 1.27,
  });
  const snap = (p: Point) => {
    const threshold = view().w / 150;
    const pin = pins()
      .map((v) => ({ v, d: distance(v, p) }))
      .filter((v) => v.d < threshold)
      .sort((a, b) => a.d - b.d)[0]?.v;
    if (pin) return { point: { x: pin.x, y: pin.y }, anchor: pin.anchor };
    let best = threshold,
      point = grid(p);
    for (const w of doc().wires)
      for (let i = 1; i < w.points.length; i++) {
        const q = project(p, w.points[i - 1], w.points[i]),
          d = distance(p, q);
        if (d < best) {
          best = d;
          point = q;
        }
      }
    return { point, anchor: undefined };
  };
  const merge = (p: VisualPcb, ids: string[], id: string) => {
    for (const c of p.components ?? [])
      for (const t of c.terminals)
        if (t.netId && ids.includes(t.netId)) t.netId = id;
    for (const c of [
      ...(p.traces ?? []),
      ...(p.vias ?? []),
      ...(p.zones ?? []),
      ...(p.schematic?.wires ?? []),
      ...(p.schematic?.labels ?? []),
    ])
      if (c.netId && ids.includes(c.netId)) c.netId = id;
    p.nets = p.nets?.filter((n) => !ids.includes(n.id) || n.id === id);
  };
  const commitWires = (
    previous: VisualPcb,
    next: VisualPcb,
    group: SchematicWire[],
  ) => {
    for (const wire of group)
      wire.connections = pins()
        .filter((pin) =>
          wire.points
            .slice(1)
            .some(
              (p, i) => distance(pin, project(pin, wire.points[i], p)) < 1e-6,
            ),
        )
        .map((pin) => pin.anchor);
    const anchors = [
      ...group
        .flatMap((w) => [w.start, w.end, ...(w.connections ?? [])])
        .filter((a): a is WireAnchor => !!a),
      ...pins()
        .filter((pin) =>
          group.some((w) =>
            w.points
              .slice(1)
              .some(
                (p, i) => distance(pin, project(pin, w.points[i], p)) < 1e-6,
              ),
          ),
        )
        .map((pin) => pin.anchor),
    ];
    const terminals = anchors.flatMap(
      (a) =>
        next.components
          ?.find((c) => c.id === a.componentId)
          ?.terminals.filter((t) => t.number === a.terminal) ?? [],
    );
    if (
      terminals.some((t) => t.nc) &&
      !window.confirm(
        "This connection reaches NC pins. Clear their NC marks and connect?",
      )
    )
      return;
    const assignment = assignTerminalNet(next, anchors, net());
    if (
      assignment.hasNc &&
      !terminals.some((t) => t.nc) &&
      !window.confirm(
        "This connection reaches NC copper. Clear the NC marks and connect?",
      )
    )
      return;
    const ids = [
      ...new Set(
        [...assignment.conflicts, ...group.map((w) => w.netId)].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    const apply = (id: string) => {
      if (pcb() !== previous) return;
      const target = id || newNet(next).id;
      assignment.apply(target);
      merge(next, ids, target);
      for (const w of group) w.netId = target;
      props.store.visual.replacePcb(next);
    };
    cancel();
    if (ids.length > 1) {
      setSurvivor(ids[0]);
      setPending({ previous, next, nets: ids, apply });
    } else apply(ids[0] ?? "");
  };
  const finishWire = (end?: WireAnchor, final?: Point) => {
    const previous = pcb();
    if (!previous || draft().length < 1) return;
    const path = final
      ? [...draft(), ...orthogonal(draft().at(-1)!, final).slice(1)]
      : [...draft()];
    const points = path.filter((p, i) => !i || distance(p, path[i - 1]) > 1e-8);
    if (points.length < 2) return;
    const next = structuredClone(previous);
    next.schematic ??= emptySchematic();
    const wire: SchematicWire = {
      id: visualId(),
      points,
      start: startAnchor,
      end,
    };
    next.schematic.wires.push(wire);
    commitWires(previous, next, wireGroup(next.schematic.wires, wire.id));
  };
  const place = (event: PointerEvent) => {
    if (event.button === 1 || event.button === 2) {
      if (event.button === 2) skipContextJoint = false;
      pan = {
        x: event.clientX,
        y: event.clientY,
        view: view(),
        button: event.button,
        moved: false,
      };
      svg.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const hit = snap(coordinates(event));
    if (tool() === "label") {
      if (!net()) {
        setMessage("Choose a net before placing a label.");
        return;
      }
      const previous = pcb();
      if (!previous) return;
      const next = structuredClone(previous);
      next.schematic ??= emptySchematic();
      next.schematic.labels.push({
        id: visualId(),
        ...hit.point,
        netId: net(),
        anchor: hit.anchor,
      });
      const wire = next.schematic.wires.find((w) =>
        w.points
          .slice(1)
          .some(
            (p, i) =>
              distance(hit.point, project(hit.point, w.points[i], p)) < 1e-6,
          ),
      );
      if (wire)
        commitWires(previous, next, wireGroup(next.schematic.wires, wire.id));
      else if (hit.anchor) {
        const terminal = next.components
          ?.find((c) => c.id === hit.anchor?.componentId)
          ?.terminals.find((t) => t.number === hit.anchor?.terminal);
        if (terminal?.nc && !window.confirm("Clear NC and connect this label?"))
          return;
        const assignment = assignTerminalNet(next, [hit.anchor], net());
        if (
          assignment.hasNc &&
          !terminal?.nc &&
          !window.confirm(
            "This label reaches NC copper. Clear the NC marks and connect?",
          )
        )
          return;
        const apply = (target: string) => {
          if (pcb() !== previous) return;
          assignment.apply(target);
          next.schematic!.labels.at(-1)!.netId = target;
          props.store.visual.replacePcb(next);
        };
        if (assignment.conflicts.length > 1) {
          setSurvivor(net());
          setPending({ previous, next, nets: assignment.conflicts, apply });
        } else apply(net());
      } else props.store.visual.replacePcb(next);
      return;
    }
    if (tool() === "junction") {
      const previous = pcb();
      if (!previous) return;
      const next = structuredClone(previous);
      next.schematic ??= emptySchematic();
      const hits: SchematicWire[] = [];
      for (const w of [...next.schematic.wires])
        for (let i = 1; i < w.points.length; i++)
          if (
            distance(
              hit.point,
              project(hit.point, w.points[i - 1], w.points[i]),
            ) < 1e-6
          ) {
            if (
              distance(hit.point, w.points[0]) > 1e-6 &&
              distance(hit.point, w.points.at(-1)!) > 1e-6
            ) {
              const second: SchematicWire = {
                ...w,
                id: visualId(),
                points: [hit.point, ...w.points.slice(i)],
                start: undefined,
              };
              w.points = [...w.points.slice(0, i), hit.point];
              w.end = undefined;
              next.schematic.wires.push(second);
            }
            hits.push(w);
            break;
          }
      if (hits.length)
        commitWires(
          previous,
          next,
          wireGroup(next.schematic.wires, hits[0].id),
        );
      return;
    }
    if (tool() === "wire") {
      if (!draft().length) {
        routeOrigin = pcb();
        setDraft([hit.point]);
        startAnchor = hit.anchor;
      } else if (
        hit.anchor ||
        doc().wires.some((w) =>
          w.points
            .slice(1)
            .some(
              (p, i) =>
                distance(hit.point, project(hit.point, w.points[i], p)) < 1e-6,
            ),
        )
      )
        finishWire(hit.anchor, hit.point);
      else
        setDraft([
          ...draft(),
          ...orthogonal(draft().at(-1)!, hit.point).slice(1),
        ]);
      return;
    }
    setSelected([]);
    setSelectedWire("");
  };
  const unitDown = (e: PointerEvent, u: SchematicUnit) => {
    if (tool() !== "select" || e.button !== 0) return;
    e.stopPropagation();
    const ids = e.shiftKey
      ? selected().includes(u.id)
        ? selected().filter((id) => id !== u.id)
        : [...selected(), u.id]
      : selected().includes(u.id)
        ? selected()
        : [u.id];
    setSelected(ids);
    setSelectedWire("");
    const p = pcb();
    if (p) drag = { point: coordinates(e), previous: p, units: ids };
    svg.setPointerCapture?.(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (wireDrag) {
      const w = doc().wires.find((w) => w.id === wireDrag?.id);
      if (!w || pcb() !== wireDrag.previous) {
        wireDrag = null;
        setWireDraft(null);
        return;
      }
      const points = (wireDraft()?.points ?? wirePoints(w)).map((p) => ({
        ...p,
      }));
      points[wireDrag.index] = grid(coordinates(e));
      setWireDraft({ id: w.id, points });
      return;
    }
    if (pan) {
      const r = svg.getBoundingClientRect();
      if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 2)
        pan.moved = true;
      setView({
        ...pan.view,
        x: pan.view.x - ((e.clientX - pan.x) * pan.view.w) / (r.width || 1),
        y: pan.view.y - ((e.clientY - pan.y) * pan.view.h) / (r.height || 1),
      });
      return;
    }
    const p = coordinates(e);
    if (drag)
      setDragOffset(grid({ x: p.x - drag.point.x, y: p.y - drag.point.y }));
    else if (draft().length) setCursor(snap(p).point);
  };
  const up = () => {
    if (wireDrag) {
      const d = wireDrag,
        draft = wireDraft();
      wireDrag = null;
      if (pcb() === d.previous && draft) {
        const next = structuredClone(d.previous),
          w = next.schematic?.wires.find((w) => w.id === d.id);
        if (w) {
          w.points = draft.points.flatMap((p, i) =>
            i ? orthogonal(draft.points[i - 1], p).slice(1) : [p],
          );
          commitWires(d.previous, next, wireGroup(next.schematic!.wires, w.id));
        }
      }
      setWireDraft(null);
      return;
    }
    const d = drag,
      offset = dragOffset();
    drag = null;
    if (pan?.moved && pan.button === 2) skipContextJoint = true;
    pan = null;
    if (d && offset && pcb() === d.previous)
      edit((p) => {
        for (const u of p.schematic?.units ?? [])
          if (d.units.includes(u.id)) {
            u.x += offset.x;
            u.y += offset.y;
          }
        for (const w of p.schematic?.wires ?? []) w.points = wirePoints(w);
      });
    setDragOffset(null);
  };
  const transform = (rotate: boolean) =>
    edit((p) => {
      for (const u of p.schematic?.units ?? [])
        if (selected().includes(u.id)) {
          if (rotate) u.rotation = (u.rotation + 90) % 360;
          else u.flip = !u.flip;
        }
    });
  const remove = () => {
    if (selectedWire()) {
      edit((p) => {
        if (p.schematic)
          p.schematic.wires = p.schematic.wires.filter(
            (w) => w.id !== selectedWire(),
          );
      });
      setSelectedWire("");
    } else
      setMessage(
        "Components remain shared with the PCB. Delete them in the Visual editor; move their units here.",
      );
  };
  const addJoint = (seg: number) => {
    const previous = pcb(),
      w = doc().wires.find((x) => x.id === selectedWire());
    if (!previous || !w) return;
    const resolved = resolveWireGeometry(previous, w);
    if (seg < 0 || seg + 2 > resolved.length) return;
    const a = resolved[seg],
      b = resolved[seg + 1];
    if (distance(a, b) < 1e-6) return;
    const next = structuredClone(previous);
    next.schematic ??= emptySchematic();
    const target = next.schematic.wires.find((x) => x.id === w.id);
    if (!target) return;
    resolved.splice(seg + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    target.points = resolved.flatMap((p, i) =>
      i ? orthogonal(resolved[i - 1], p).slice(1) : [p],
    );
    commitWires(previous, next, wireGroup(next.schematic.wires, target.id));
  };
  // Splits the wire at an arbitrary clicked position: the point projects onto
  // the nearest segment and becomes a movable interior joint.
  const addJointAt = (wireId: string, point: Point) => {
    const previous = pcb(),
      w = doc().wires.find((x) => x.id === wireId);
    if (!previous || !w) return;
    const resolved = resolveWireGeometry(previous, w);
    let best = Infinity,
      seg = -1,
      spot: Point | null = null;
    for (let i = 0; i + 1 < resolved.length; i++) {
      const q = project(point, resolved[i], resolved[i + 1]),
        d = distance(point, q);
      if (d < best) {
        best = d;
        seg = i;
        spot = q;
      }
    }
    const a = seg >= 0 ? resolved[seg] : undefined,
      b = seg >= 0 ? resolved[seg + 1] : undefined;
    if (!spot || !a || !b || distance(a, b) < 1e-6) return;
    if (distance(spot, a) < 1e-6 || distance(spot, b) < 1e-6) return;
    const next = structuredClone(previous);
    next.schematic ??= emptySchematic();
    const target = next.schematic.wires.find((x) => x.id === w.id);
    if (!target) return;
    resolved.splice(seg + 1, 0, spot);
    target.points = resolved.flatMap((p, i) =>
      i ? orthogonal(resolved[i - 1], p).slice(1) : [p],
    );
    setSelectedWire(w.id);
    commitWires(previous, next, wireGroup(next.schematic.wires, target.id));
  };
  // Right-drag pans suppress the trailing contextmenu so wires are not edited.
  const contextJointOk = () => {
    if (skipContextJoint) {
      skipContextJoint = false;
      return false;
    }
    return !pan?.moved;
  };
  const removeJoint = (index: number) => {
    const previous = pcb(),
      w = doc().wires.find((x) => x.id === selectedWire());
    if (!previous || !w) return;
    const resolved = resolveWireGeometry(previous, w);
    if (index < 0 || index + 3 > resolved.length) return;
    const next = structuredClone(previous);
    next.schematic ??= emptySchematic();
    const target = next.schematic.wires.find((x) => x.id === w.id);
    if (!target) return;
    resolved.splice(index + 1, 1);
    target.points = resolved.flatMap((p, i) =>
      i ? orthogonal(resolved[i - 1], p).slice(1) : [p],
    );
    commitWires(previous, next, wireGroup(next.schematic.wires, target.id));
  };
  const fit = () => {
    const points = [
      ...units().map((u) => ({ x: u.x, y: u.y })),
      ...doc().wires.flatMap((w) => w.points),
    ];
    if (!points.length) return;
    const x = Math.min(...points.map((p) => p.x)) - 20,
      y = Math.min(...points.map((p) => p.y)) - 20;
    setView({
      x,
      y,
      w: Math.max(80, Math.max(...points.map((p) => p.x)) - x + 20),
      h: Math.max(60, Math.max(...points.map((p) => p.y)) - y + 20),
    });
  };
  const guides = createMemo(() => {
    const byNet = new Map<
      string,
      typeof pins extends () => infer T ? T : never
    >();
    for (const p of pins()) {
      const id = p.component.terminals.find(
        (t) => t.number === p.anchor.terminal,
      )?.netId;
      if (id && !byNet.get(id)?.some((v) => key(v.anchor) === key(p.anchor)))
        byNet.set(id, [...(byNet.get(id) ?? []), p]);
    }
    return [...byNet].flatMap(([netId, list]) => {
      const parent = list.map((_, i) => i),
        find = (i: number): number =>
          parent[i] === i ? i : (parent[i] = find(parent[i]));
      const union = (ids: number[]) => {
        for (const i of ids.slice(1)) parent[find(i)] = find(ids[0]);
      };
      const visited = new Set<string>();
      const netLabelMembers: number[] = [];
      for (const wire of doc().wires) {
        if (visited.has(wire.id)) continue;
        const group = wireGroup(doc().wires, wire.id);
        for (const w of group) visited.add(w.id);
        const reached = list.flatMap((pin, i) =>
          group.some((w) =>
            wirePoints(w)
              .slice(1)
              .some(
                (p, j) =>
                  distance(pin, project(pin, wirePoints(w)[j], p)) < 1e-6,
              ),
          )
            ? [i]
            : [],
        );
        union(reached);
        if (
          doc().labels.some(
            (label) =>
              label.netId === netId &&
              group.some((w) =>
                wirePoints(w)
                  .slice(1)
                  .some(
                    (p, i) =>
                      distance(
                        anchorPoint(label.anchor) ?? label,
                        project(
                          anchorPoint(label.anchor) ?? label,
                          wirePoints(w)[i],
                          p,
                        ),
                      ) < 1e-6,
                  ),
              ),
          )
        )
          netLabelMembers.push(...reached);
      }
      const labelled = list.flatMap((pin, i) =>
        doc().labels.some(
          (label) =>
            label.netId === netId &&
            (label.anchor
              ? key(label.anchor) === key(pin.anchor)
              : distance(pin, label) < 1e-6),
        )
          ? [i]
          : [],
      );
      union([...labelled, ...netLabelMembers]);
      const representatives = [...new Set(parent.map((_, i) => find(i)))].map(
        (i) => list[i],
      );
      return representatives
        .slice(1)
        .map((p, i) => ({ netId, a: representatives[i], b: p }));
    });
  });
  const diagnostics = () => [
    ...ncContacts(pcb() ?? { id: "", name: "", layers: [], images: [] }).map(
      (id) => `${id}: NC copper contact`,
    ),
    ...components().flatMap((c) =>
      [
        !c.definition.symbol
          ? `${c.reference}: generic symbol needs identification`
          : "",
        c.definition.symbol?.units.some((u) =>
          u.pins.some(
            (pin) => !Object.values(c.definition.pinMap).includes(pin.number),
          ),
        )
          ? `${c.reference}: symbol pins remain unmapped to PCB pads`
          : "",
        ...c.terminals.flatMap((t) => [
          !c.definition.pinMap[t.number] && c.definition.symbol
            ? `${c.reference}.${t.number}: unmapped terminal`
            : "",
          !t.netId && !t.nc ? `${c.reference}.${t.number}: unassigned` : "",
          t.netId && t.nc ? `${c.reference}.${t.number}: NC/net conflict` : "",
        ]),
      ].filter(Boolean),
    ),
  ];
  const selectedComponent = () =>
    components().find(
      (c) =>
        c.id === units().find((u) => selected().includes(u.id))?.componentId,
    );
  return (
    <section class="electrical-panel" aria-label="Schematic editor">
      <div class="electrical-toolbar">
        <h1>Schematic</h1>
        <label>
          PCB{" "}
          <select
            value={pcb()?.id}
            onChange={(e) => props.store.visual.activate(e.currentTarget.value)}
          >
            <For each={props.store.visual.editor()?.pcbs}>
              {(p) => <option value={p.id}>{p.name}</option>}
            </For>
          </select>
        </label>
        <For each={["select", "wire", "junction", "label"] as const}>
          {(id) => (
            <button
              aria-pressed={tool() === id}
              onClick={() => {
                cancel();
                setTool(id);
              }}
            >
              {id === "select"
                ? "Select"
                : id === "wire"
                  ? "Wire"
                  : id === "label"
                    ? "Net label"
                    : "Junction"}
            </button>
          )}
        </For>
        <label>
          Net{" "}
          <select value={net()} onChange={(e) => setNet(e.currentTarget.value)}>
            <option value="">Automatic</option>
            <For each={pcb()?.nets}>
              {(n) => <option value={n.id}>{n.name}</option>}
            </For>
          </select>
        </label>
        <button onClick={fit}>Fit</button>
        <button disabled={!selected().length} onClick={() => transform(true)}>
          Rotate
        </button>
        <button disabled={!selected().length} onClick={() => transform(false)}>
          Mirror
        </button>
        <button disabled={!selectedWire()} onClick={remove}>
          Delete wire
        </button>
        <button
          onClick={() =>
            props.onExport
              ? props.onExport()
              : void exportSchematicPackage(props.store.doc()!, pcb()!).catch(
                  (e) => setMessage(String(e)),
                )
          }
        >
          Export KiCad…
        </button>
      </div>
      <Show when={message()}>
        <p role="status">{message()}</p>
      </Show>
      <div class="schematic-body">
        <svg
          ref={svg}
          class="schematic-svg"
          aria-label="Schematic canvas"
          tabindex="0"
          viewBox={`${view().x} ${view().y} ${view().w} ${view().h}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={place}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            wireDrag = null;
            setWireDraft(null);
            drag = null;
            pan = null;
            setDragOffset(null);
          }}
          onLostPointerCapture={() => {
            wireDrag = null;
            setWireDraft(null);
            drag = null;
            pan = null;
            setDragOffset(null);
          }}
          onContextMenu={(e) => e.preventDefault()}
          onDblClick={(e) => {
            if (tool() === "wire")
              finishWire(undefined, snap(coordinates(e)).point);
          }}
          onWheel={(e) => {
            e.preventDefault();
            const v = view(),
              p = coordinates(e as unknown as MouseEvent),
              f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
            setView({
              x: p.x - (p.x - v.x) * f,
              y: p.y - (p.y - v.y) * f,
              w: Math.max(10, Math.min(5000, v.w * f)),
              h: Math.max(10, Math.min(5000, v.h * f)),
            });
          }}
          onKeyDown={(e) => {
            if (
              ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                e.key,
              ) &&
              selected().length
            ) {
              e.preventDefault();
              edit((p) => {
                for (const u of p.schematic?.units ?? [])
                  if (selected().includes(u.id)) {
                    u.x +=
                      e.key === "ArrowLeft"
                        ? -1.27
                        : e.key === "ArrowRight"
                          ? 1.27
                          : 0;
                    u.y +=
                      e.key === "ArrowUp"
                        ? -1.27
                        : e.key === "ArrowDown"
                          ? 1.27
                          : 0;
                  }
              });
            }
            if (e.key === "Escape") {
              cancel();
              setSelected([]);
              setSelectedWire("");
            }
            if (e.key === "Enter") finishWire();
            if (e.key === "Delete") remove();
            if (e.key.toLowerCase() === "r") transform(true);
          }}
        >
          <defs>
            <pattern
              id="schematic-grid"
              width="2.54"
              height="2.54"
              patternUnits="userSpaceOnUse"
            >
              <circle r=".1" fill="var(--border)" />
            </pattern>
          </defs>
          <rect
            x={view().x}
            y={view().y}
            width={view().w}
            height={view().h}
            fill="url(#schematic-grid)"
          />
          <For each={guides()}>
            {(g) => (
              <line
                x1={g.a.x}
                y1={g.a.y}
                x2={g.b.x}
                y2={g.b.y}
                stroke={
                  pcb()?.nets?.find((n) => n.id === g.netId)?.color ??
                  "var(--muted)"
                }
                opacity=".35"
                stroke-width=".15"
                stroke-dasharray="1 1"
              />
            )}
          </For>
          <For each={doc().wires}>
            {(w) => (
              <polyline
                points={wirePoints(w)
                  .map((p) => `${p.x},${p.y}`)
                  .join(" ")}
                fill="none"
                stroke={
                  selectedWire() === w.id
                    ? "var(--accent)"
                    : (pcb()?.nets?.find((n) => n.id === w.netId)?.color ??
                      "var(--text)")
                }
                stroke-width=".35"
                onPointerDown={(e) => {
                  if (tool() === "select") {
                    e.stopPropagation();
                    setSelected([]);
                    setSelectedWire(w.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (tool() !== "select" || !contextJointOk()) return;
                  addJointAt(w.id, coordinates(e));
                }}
              />
            )}
          </For>
          <Show when={selectedWire() && tool() === "select"}>
            <For each={selectedWirePoints().slice(1, -1)}>
              {(p, i) => (
                <rect
                  class="schematic-bend"
                  role="button"
                  tabindex="0"
                  aria-label={`Wire bend ${i() + 1}`}
                  x={p.x - 0.5}
                  y={p.y - 0.5}
                  width="1"
                  height="1"
                  fill="var(--accent)"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const previous = pcb(),
                      w = doc().wires.find((w) => w.id === selectedWire());
                    if (previous && w) {
                      wireDrag = { previous, id: w.id, index: i() + 1 };
                      setWireDraft({ id: w.id, points: wirePoints(w) });
                      svg.setPointerCapture?.(e.pointerId);
                    }
                  }}
                  onDblClick={(e) => {
                    e.stopPropagation();
                    removeJoint(i());
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!contextJointOk()) return;
                    removeJoint(i());
                  }}
                  onKeyDown={(e) => {
                    if (["Delete", "Backspace", "Enter", " "].includes(e.key)) {
                      e.preventDefault();
                      e.stopPropagation();
                      removeJoint(i());
                    }
                  }}
                >
                  <title>
                    Drag to move; double-click, right-click, or press Delete to
                    remove
                  </title>
                </rect>
              )}
            </For>
            <For each={segmentMidpoints(selectedWirePoints())}>
              {(m) => (
                <g
                  class="schematic-joint-add"
                  role="button"
                  tabindex="0"
                  aria-label={`Add joint on segment ${m.seg + 1}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    addJoint(m.seg);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      addJoint(m.seg);
                    }
                  }}
                >
                  <circle cx={m.x} cy={m.y} r="0.9" />
                  <path
                    d={`M ${m.x - 0.45} ${m.y} H ${m.x + 0.45} M ${m.x} ${m.y - 0.45} V ${m.y + 0.45}`}
                  />
                </g>
              )}
            </For>
          </Show>
          <For
            each={doc()
              .wires.flatMap((w) => [w.points[0], w.points.at(-1)!])
              .filter(
                (p) =>
                  p &&
                  doc().wires.filter((w) =>
                    w.points
                      .slice(1)
                      .some(
                        (q, i) =>
                          distance(p, project(p, w.points[i], q)) < 1e-6,
                      ),
                  ).length > 1,
              )}
          >
            {(p) => <circle cx={p.x} cy={p.y} r=".6" fill="var(--text)" />}
          </For>
          <For each={units()}>
            {(u) => {
              const c = () => components().find((c) => c.id === u.componentId);
              return (
                <Show when={c()} keyed>
                  {(component) => (
                    <g
                      class="schematic-unit"
                      tabindex="0"
                      role="button"
                      aria-label={`${component.reference} unit ${u.unit}`}
                      transform={`translate(${u.x} ${u.y}) rotate(${u.rotation}) scale(${u.flip ? -1 : 1} 1)`}
                      color="var(--text)"
                      onPointerDown={(e) => unitDown(e, u)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          setSelected([u.id]);
                      }}
                      onDblClick={() => props.onNavigate?.(component.id)}
                    >
                      <Show when={selected().includes(u.id)}>
                        <rect
                          class="symbol-selection"
                          x="-16"
                          y="-16"
                          width="32"
                          height="32"
                          fill="none"
                          stroke="var(--accent)"
                          stroke-width=".3"
                          stroke-dasharray="1 .5"
                        />
                      </Show>
                      <Show
                        when={component.definition.symbol}
                        fallback={
                          <rect
                            x="-7.46"
                            y="-7"
                            width="17"
                            height={Math.max(
                              12,
                              component.terminals.length * 2.54 + 2,
                            )}
                            fill="var(--raised)"
                            stroke="currentColor"
                            stroke-width=".25"
                          />
                        }
                      >
                        <For
                          each={component.definition.symbol?.units
                            .filter(
                              (s) =>
                                (s.unit === u.unit || s.unit === 0) &&
                                (s.bodyStyle === 0 ||
                                  s.bodyStyle === (u.bodyStyle ?? 1)),
                            )
                            .flatMap((s) => s.graphics)}
                        >
                          {(g) => <Graphic graphic={g} />}
                        </For>
                      </Show>
                      <For
                        each={symbolPins(component, u.unit, u.bodyStyle ?? 1)}
                      >
                        {(pin) => {
                          const angle = (pin.rotation * Math.PI) / 180,
                            t = () =>
                              component.terminals.find(
                                (t) => t.number === pin.terminal,
                              );
                          return (
                            <g>
                              <line
                                x1={pin.x}
                                y1={-pin.y}
                                x2={pin.x + Math.cos(angle) * pin.length}
                                y2={-pin.y - Math.sin(angle) * pin.length}
                                stroke="currentColor"
                                stroke-width=".2"
                              />
                              <circle
                                cx={pin.x}
                                cy={-pin.y}
                                r=".5"
                                fill={
                                  pcb()?.nets?.find((n) => n.id === t()?.netId)
                                    ?.color ?? "var(--surface)"
                                }
                                stroke="currentColor"
                                stroke-width=".2"
                              />
                              <text
                                x={pin.x + 0.7}
                                y={-pin.y - 0.7}
                                fill="currentColor"
                                font-size="1.3"
                              >
                                {pin.number} {pin.name}
                                {pin.hidden ? " (hidden)" : ""}
                              </text>
                              <Show when={t()?.nc}>
                                <path
                                  d={`M ${pin.x - 0.7} ${-pin.y - 0.7} l 1.4 1.4 m 0 -1.4 l -1.4 1.4`}
                                  stroke="var(--danger)"
                                  stroke-width=".3"
                                />
                              </Show>
                            </g>
                          );
                        }}
                      </For>
                      <text
                        x="0"
                        y="-12"
                        fill="currentColor"
                        font-size="2"
                        text-anchor="middle"
                      >
                        {component.reference}
                        {(component.definition.symbol?.units.filter(
                          (s) => s.unit > 0,
                        ).length ?? 1) > 1
                          ? ` / ${u.unit}`
                          : ""}
                      </text>
                      <text
                        x="0"
                        y="-9"
                        fill="currentColor"
                        font-size="1.6"
                        text-anchor="middle"
                      >
                        {component.value}
                      </text>
                    </g>
                  )}
                </Show>
              );
            }}
          </For>
          <For each={doc().labels}>
            {(label) => (
              <text
                x={(anchorPoint(label.anchor) ?? label).x}
                y={(anchorPoint(label.anchor) ?? label).y}
                font-size="2"
                fill={
                  pcb()?.nets?.find((n) => n.id === label.netId)?.color ??
                  "var(--text)"
                }
                onDblClick={() =>
                  edit((p) => {
                    if (p.schematic)
                      p.schematic.labels = p.schematic.labels.filter(
                        (l) => l.id !== label.id,
                      );
                  })
                }
              >
                {pcb()?.nets?.find((n) => n.id === label.netId)?.name}
              </text>
            )}
          </For>
          <Show when={draft().length}>
            <polyline
              points={[
                ...draft(),
                ...(cursor()
                  ? orthogonal(draft().at(-1)!, cursor()!).slice(1)
                  : []),
              ]
                .map((p) => `${p.x},${p.y}`)
                .join(" ")}
              fill="none"
              stroke="var(--accent)"
              stroke-width=".3"
            />
          </Show>
        </svg>
        <aside class="schematic-inspector">
          <h2>Selection details</h2>
          <Show when={selectedComponent()} keyed>
            {(c) => (
              <>
                <p>
                  {c.reference} · {c.value}
                </p>
                <p>{c.definition.symbol?.name ?? "Generic symbol"}</p>
                <button onClick={() => props.onNavigate?.(c.id)}>
                  Locate on PCB
                </button>
                <button
                  disabled={!props.onReplace}
                  onClick={() => props.onReplace?.([c.id])}
                >
                  Change footprint / symbol…
                </button>
              </>
            )}
          </Show>
          <Show when={selected().length === 1}>
            <label>
              Body style
              <select
                aria-label="Symbol body style"
                value={
                  units().find((u) => u.id === selected()[0])?.bodyStyle ?? 1
                }
                onChange={(e) =>
                  edit((p) => {
                    const u = p.schematic?.units.find(
                      (u) => u.id === selected()[0],
                    );
                    if (u) u.bodyStyle = +e.currentTarget.value;
                  })
                }
              >
                <For
                  each={[
                    ...new Set(
                      selectedComponent()
                        ?.definition.symbol?.units.filter(
                          (s) =>
                            s.unit === 0 ||
                            s.unit ===
                              units().find((u) => u.id === selected()[0])?.unit,
                        )
                        .map((s) => s.bodyStyle)
                        .filter((s) => s > 0) ?? [1],
                    ),
                  ]}
                >
                  {(s) => (
                    <option value={s}>
                      {s === 1 ? "Normal" : `Alternate ${s}`}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <h3>Reconstruction</h3>
          <p>{guides().length} connection guides remain.</p>
          <ul class="schematic-diagnostics">
            <For each={diagnostics()}>{(s) => <li>{s}</li>}</For>
          </ul>
          <p>
            Wires and net labels share PCB nets. Crossing wires need an endpoint
            or junction to connect. Deleting a wire keeps its logical net.
          </p>
        </aside>
      </div>
      <Show when={pending()} keyed>
        {(state) => (
          <div class="overlay overlay--center">
            <section
              class="palette"
              role="dialog"
              aria-modal="true"
              aria-label="Join schematic nets"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setPending(null);
                  queueMicrotask(() => svg?.focus());
                }
                if (e.key === "Tab") {
                  const items = Array.from(
                    e.currentTarget.querySelectorAll<HTMLElement>(
                      "select,button",
                    ),
                  );
                  if (e.shiftKey && document.activeElement === items[0]) {
                    e.preventDefault();
                    items.at(-1)?.focus();
                  } else if (
                    !e.shiftKey &&
                    document.activeElement === items.at(-1)
                  ) {
                    e.preventDefault();
                    items[0]?.focus();
                  }
                }
              }}
            >
              <header class="dialog-header">
                <h2>Join schematic nets</h2>
              </header>
              <div class="dialog-content">
                <p>
                  This wire joins assigned nets. Choose the surviving net or
                  cancel the complete edit.
                </p>
                <select
                  aria-label="Surviving net"
                  value={survivor()}
                  onChange={(e) => setSurvivor(e.currentTarget.value)}
                >
                  <For each={state.nets}>
                    {(id) => (
                      <option value={id}>
                        {state.previous.nets?.find((n) => n.id === id)?.name}
                      </option>
                    )}
                  </For>
                </select>
              </div>
              <footer class="dialog-actions">
                <button
                  onClick={() => {
                    setPending(null);
                    queueMicrotask(() => svg?.focus());
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setPending(null);
                    state.apply(survivor());
                    queueMicrotask(() => svg?.focus());
                  }}
                >
                  Join nets
                </button>
              </footer>
            </section>
          </div>
        )}
      </Show>
    </section>
  );
}
