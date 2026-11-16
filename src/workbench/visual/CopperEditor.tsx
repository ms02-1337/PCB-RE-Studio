import { createEffect, createSignal, createMemo, For, Show } from "solid-js";
import type { PlacementStore } from "../placement/store";
import { ActionIcon } from "../ActionIcon";
import type { Point } from "../placement/projectDoc";
import {
  layerLabel,
  visualId,
  type VisualPcb,
  type CopperTrace,
  type CopperZone,
  type CopperVia,
} from "./model";
import {
  area,
  connected,
  copperIndex,
  distance,
  inside,
  length,
  mergeNets,
  newNet,
  project,
  validPolygon,
  zoneCensus,
} from "./copper";

type Element = CopperTrace | CopperZone | CopperVia;
type Mode = "select" | "trace" | "zone" | "via";
export function createCopperEditor(
  store: PlacementStore,
  enabled: () => boolean,
  changed: () => void,
  activate: () => void = () => {},
  placeComponent: () => void = () => {},
) {
  const pcb = store.visual.activePcb;
  const spatial = createMemo(() => (pcb() ? copperIndex(pcb()!) : null));
  const [layer, setLayer] = createSignal("");
  const [mode, setMode] = createSignal<Mode>("select");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [highlight, setHighlight] = createSignal("");
  const [width, setWidth] = createSignal(0.5),
    [diameter, setDiameter] = createSignal(1),
    [drill, setDrill] = createSignal(0.5);
  const [placementNet, setPlacementNet] = createSignal("");
  const [angle, setAngle] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [modal, setModal] = createSignal<{
    title: string;
    choices: { id: string; name: string }[];
    confirm: (id: string, name: string) => void;
    /** Runs when the dialog is dismissed without confirming (Cancel button,
     * Escape or backdrop). */
    cancel?: () => void;
  } | null>(null);
  const [choice, setChoice] = createSignal(""),
    [netName, setNetName] = createSignal("");
  let points: Point[] = [],
    cursor: Point | null = null,
    draftLayer = "",
    draftWidth = 0,
    draftNet = "",
    origin: VisualPcb | undefined;
  let drag: {
    start: Point;
    element: Element;
    vertex: number;
    pcb: VisualPcb | undefined;
  } | null = null;
  let revision: VisualPcb | undefined;
  let projectSession = -1;
  const elements = (): Element[] => [
    ...(pcb()?.traces ?? []),
    ...(pcb()?.vias ?? []),
    ...(pcb()?.zones ?? []),
  ];
  const element = () => elements().find((e) => e.id === selected());
  const cancel = () => {
    points = [];
    cursor = null;
    drag = null;
    origin = undefined;
    changed();
  };
  const setActiveLayer = (id: string) => {
    cancel();
    setLayer(id);
    setSelected(null);
  };
  createEffect(() => {
    const p = pcb();
    if (p?.id !== revision?.id || projectSession !== store.projectSession()) {
      projectSession = store.projectSession();
      setLayer(p?.layers[0] ?? "");
      setSelected(null);
      setMode("select");
      setPlacementNet("");
      setHighlight("");
      setModal(null);
      cancel();
    }
    if (p && !p.layers.includes(layer())) setLayer(p.layers[0]);
    if (placementNet() && !p?.nets?.some((n) => n.id === placementNet()))
      setPlacementNet("");
    if (p !== revision) {
      if (modal()) setModal(null);
      revision = p;
    }
    if (!enabled()) {
      cancel();
      setModal(null);
    }
    if (enabled()) {
      const raw = sessionStorage.getItem("visual-net-navigation");
      if (raw) {
        sessionStorage.removeItem("visual-net-navigation");
        try {
          const nav = JSON.parse(raw) as {
            pcbId: string;
            elementId: string;
            layerId?: string;
            netId: string;
          };
          if (nav.pcbId === p?.id) {
            if (nav.layerId && p.layers.includes(nav.layerId))
              setLayer(nav.layerId);
            setSelected(nav.elementId);
            setHighlight(nav.netId);
            changed();
          }
        } catch {
          /* A stale navigation request is harmless. */
        }
      }
    }
  });
  const copy = () => JSON.parse(JSON.stringify(pcb())) as VisualPcb;
  function commit(next: VisualPcb, seeds: string[], auto = false) {
    const previous = pcb();
    if (!previous || previous.id !== next.id) return;
    const validNets = new Set(next.nets?.map((n) => n.id) ?? []);
    for (const e of [
      ...(next.traces ?? []),
      ...(next.vias ?? []),
      ...(next.zones ?? []),
    ])
      if (e.netId && !validNets.has(e.netId)) delete e.netId;
    const group = connected(next, seeds);
    const ids = [
      ...new Set(
        group.map((e) => e.netId).filter((id): id is string => Boolean(id)),
      ),
    ];
    const apply = (netId?: string) => {
      if (pcb() !== previous) return;
      if (netId) {
        mergeNets(next, ids, netId);
        for (const e of group) e.netId = netId;
      }
      store.visual.replaceCopper(next.id, next);
    };
    if (ids.length > 1) {
      openModal(
        "Join connected nets",
        next.nets!.filter((n) => ids.includes(n.id)),
        (id, name) => {
          if (name.trim()) {
            if (
              next.nets!.some(
                (n) =>
                  n.id !== id && !ids.includes(n.id) && n.name === name.trim(),
              )
            ) {
              setMessage("Net name already exists.");
              return;
            }
            next.nets!.find((n) => n.id === id)!.name = name.trim();
          }
          apply(id);
        },
      );
      return;
    }
    apply(ids[0] ?? (auto ? newNet(next).id : undefined));
  }
  function openModal(
    title: string,
    choices: { id: string; name: string }[],
    confirm: (id: string, name: string) => void,
    cancel?: () => void,
  ) {
    setChoice(choices[0]?.id ?? "");
    setNetName("");
    setModal({ title, choices, confirm, cancel });
  }
  function netForZone(id: string) {
    const current = pcb();
    if (!current) return;
    openModal(
      "Zone net",
      current.nets ?? [],
      (netId, name) => {
        if (pcb() !== current) return;
        const next = copy();
        const net = name.trim()
          ? (next.nets?.find((n) => n.name === name.trim()) ?? newNet(next, name))
          : next.nets?.find((n) => n.id === netId);
        next.zones!.find((z) => z.id === id)!.netId = net?.id;
        store.visual.replaceCopper(next.id, next);
      },
      () => {
        // Cancelling the net prompt destroys the just-drawn zone.
        if (pcb() !== current) return;
        const next = copy();
        next.zones = next.zones?.filter((z) => z.id !== id);
        store.visual.replaceCopper(next.id, next);
        setSelected(null);
        setMode("select");
      },
    );
  }
  function finish() {
    const p = pcb();
    if (!p || p !== origin) return cancel();
    const clean = points.filter(
      (v, i) => !i || distance(v, points[i - 1]) > 1e-8,
    );
    const next = copy();
    const id = visualId();
    if (mode() === "zone") {
      if (!validPolygon(clean)) {
        setMessage("Use at least three corners without crossing edges.");
        return;
      }
      (next.zones ??= []).push({ id, layerId: draftLayer, points: clean });
      cancel();
      store.visual.replaceCopper(next.id, next);
      setSelected(id);
      netForZone(id);
    } else if (clean.length >= 2) {
      (next.traces ??= []).push({
        id,
        layerId: draftLayer,
        points: clean,
        width: draftWidth,
        netId: draftNet || undefined,
      });
      cancel();
      commit(next, [id], true);
      setSelected(id);
    } else cancel();
  }
  function snap(p: Point, scale: number, shift: boolean) {
    if (shift) return { point: p, hit: false };
    let nearest = p,
      best = Infinity,
      hit = false;
    for (const e of spatial()?.query({
      left: p.x - 8 / scale,
      right: p.x + 8 / scale,
      top: p.y - 8 / scale,
      bottom: p.y + 8 / scale,
    }) ?? []) {
      if ("points" in e) {
        if (!("width" in e) || e.layerId !== layer()) continue;
        for (let i = 1; i < e.points.length; i++) {
          const q = project(p, e.points[i - 1], e.points[i]);
          const d = distance(p, q);
          if (d <= 8 / scale + e.width / 2 && d < best) {
            nearest = q;
            best = d;
            hit = true;
          }
        }
      } else {
        const d = distance(p, e);
        if (d <= Math.max(8 / scale, e.diameter / 2) && d < best) {
          nearest = { x: e.x, y: e.y };
          best = d;
          hit = true;
        }
      }
    }
    return { point: nearest, hit };
  }
  function hit(p: Point, scale: number) {
    return (
      elements().find(
        (e) => !("points" in e) && distance(p, e) <= e.diameter / 2 + 5 / scale,
      ) ??
      elements().find(
        (e) =>
          "width" in e &&
          e.layerId === layer() &&
          e.points
            .slice(1)
            .some(
              (q, i) =>
                distance(p, project(p, e.points[i], q)) <=
                e.width / 2 + 5 / scale,
            ),
      ) ??
      elements().find(
        (e) =>
          "points" in e &&
          !("width" in e) &&
          e.layerId === layer() &&
          inside(p, e.points),
      )
    );
  }
  function down(p: Point, scale: number, shift: boolean, button: number) {
    if (!enabled() || modal()) return false;
    if (button === 2 && points.length) {
      finish();
      return true;
    }
    if (button !== 0) return false;
    if (mode() === "select") {
      setHighlight("");
      const e = hit(p, scale);
      setSelected(e?.id ?? null);
      if (!e) return false;
      const vertex =
        "points" in e
          ? e.points.findIndex((q) => distance(p, q) < 8 / scale)
          : -1;
      drag = {
        pcb: pcb(),
        start: p,
        element: JSON.parse(JSON.stringify(e)) as Element,
        vertex,
      };
      return true;
    }
    if (!pcb()?.pxPerMm) return true;
    const s =
      mode() === "zone" ? { point: p, hit: false } : snap(p, scale, shift);
    if (angle() && points.length && mode() === "trace" && !s.hit) {
      const a = points.at(-1)!,
        ray =
          (Math.round(Math.atan2(p.y - a.y, p.x - a.x) / (Math.PI / 4)) *
            Math.PI) /
          4;
      const d = (p.x - a.x) * Math.cos(ray) + (p.y - a.y) * Math.sin(ray);
      s.point = { x: a.x + d * Math.cos(ray), y: a.y + d * Math.sin(ray) };
    }
    cursor = s.point;
    if (mode() === "via") {
      const next = copy(),
        id = visualId(),
        unit = next.pxPerMm!;
      (next.vias ??= []).push({
        id,
        x: s.point.x,
        y: s.point.y,
        diameter: diameter() * unit,
        drill: drill() * unit,
        netId: placementNet() || undefined,
      });
      commit(next, [id], true);
      setSelected(id);
      return true;
    }
    if (!points.length) {
      origin = pcb();
      draftLayer = layer();
      draftWidth = width() * pcb()!.pxPerMm!;
      draftNet = placementNet();
      const start = hit(p, scale);
      if (start && "width" in start) draftWidth = Number(start.width);
    }
    if (
      mode() === "zone" &&
      points.length >= 3 &&
      distance(s.point, points[0]) < 9 / scale
    ) {
      finish();
      return true;
    }
    points.push(s.point);
    if (mode() === "trace" && s.hit && points.length > 1) finish();
    changed();
    return true;
  }
  function move(p: Point, scale: number, shift: boolean) {
    if (drag) {
      cursor = p;
      changed();
      return;
    }
    cursor = snap(p, scale, shift).point;
    if (mode() === "zone") cursor = p;
    if (
      angle() &&
      points.length &&
      mode() === "trace" &&
      !snap(p, scale, shift).hit
    ) {
      const a = points.at(-1)!,
        r =
          (Math.round(Math.atan2(p.y - a.y, p.x - a.x) / (Math.PI / 4)) *
            Math.PI) /
          4,
        d = (p.x - a.x) * Math.cos(r) + (p.y - a.y) * Math.sin(r);
      cursor = { x: a.x + d * Math.cos(r), y: a.y + d * Math.sin(r) };
    }
    changed();
  }
  function up(p: Point) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (pcb() !== d.pcb) return;
    const next = copy(),
      all = [
        ...(next.traces ?? []),
        ...(next.vias ?? []),
        ...(next.zones ?? []),
      ],
      e = all.find((x) => x.id === d.element.id)!;
    const dx = p.x - d.start.x,
      dy = p.y - d.start.y;
    if (Math.hypot(dx, dy) < 1e-8) return;
    if ("points" in e) {
      if (d.vertex >= 0) {
        const before = { ...e.points[d.vertex] };
        for (const other of all)
          if (
            "points" in other &&
            "width" in other &&
            "width" in e &&
            other.layerId === e.layerId
          )
            for (const q of other.points)
              if (distance(q, before) < 1e-8) {
                q.x += dx;
                q.y += dy;
              }
        if (!("width" in e))
          e.points[d.vertex] = { x: before.x + dx, y: before.y + dy };
      } else e.points = e.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      if (!("width" in e) && !validPolygon(e.points)) {
        setMessage("Zone edges cannot cross.");
        return;
      }
    } else {
      for (const t of next.traces ?? [])
        for (const q of t.points)
          if (distance(q, e) < 1e-8) {
            q.x += dx;
            q.y += dy;
          }
      e.x += dx;
      e.y += dy;
    }
    commit(next, [e.id]);
    changed();
  }
  const remove = () => {
    const e = element();
    if (!e) return;
    const next = copy();
    next.traces = next.traces?.filter((x) => x.id !== e.id);
    next.vias = next.vias?.filter((x) => x.id !== e.id);
    next.zones = next.zones?.filter((x) => x.id !== e.id);
    store.visual.replaceCopper(next.id, next);
    setSelected(null);
  };
  function patch(change: (e: Element) => void) {
    const e = element();
    if (!e) return;
    const next = copy();
    const target = [
      ...(next.traces ?? []),
      ...(next.vias ?? []),
      ...(next.zones ?? []),
    ].find((x) => x.id === e.id)!;
    change(target);
    commit(next, [e.id]);
  }
  function draw(ctx: CanvasRenderingContext2D, scale: number) {
    const p = pcb();
    if (!p) return;
    const color = (e: Element) =>
      p.nets?.find((n) => n.id === e.netId)?.color ?? "#a0a0a0";
    for (const e of [
      ...(p.zones ?? []),
      ...(p.traces ?? []),
      ...(p.vias ?? []),
    ]) {
      if ("points" in e && e.layerId !== layer()) continue;
      ctx.save();
      if (drag?.element.id === e.id && cursor) {
        if (!("points" in e) || drag.vertex < 0)
          ctx.translate(cursor.x - drag.start.x, cursor.y - drag.start.y);
      }
      if (highlight() && e.netId !== highlight()) ctx.globalAlpha = 0.2;
      ctx.strokeStyle = selected() === e.id ? "#ffcd11" : color(e);
      ctx.fillStyle = color(e);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      if ("points" in e) {
        e.points.forEach((q, i) => {
          const moved =
            drag?.element.id === e.id && drag.vertex === i && cursor
              ? {
                  x: q.x + cursor.x - drag.start.x,
                  y: q.y + cursor.y - drag.start.y,
                }
              : q;
          if (i) ctx.lineTo(moved.x, moved.y);
          else ctx.moveTo(moved.x, moved.y);
        });
        if ("width" in e) {
          ctx.lineWidth = Number(e.width);
          ctx.stroke();
        } else {
          ctx.closePath();
          ctx.globalAlpha = 0.22;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1.5 / scale;
          if (!e.netId) ctx.setLineDash([5 / scale, 4 / scale]);
          ctx.stroke();
        }
        if (selected() === e.id) {
          ctx.setLineDash([]);
          ctx.fillStyle = "#ffcd11";
          for (const q of e.points)
            ctx.fillRect(
              q.x - 3 / scale,
              q.y - 3 / scale,
              6 / scale,
              6 / scale,
            );
        }
      } else {
        ctx.arc(e.x, e.y, (e.diameter + e.drill) / 4, 0, Math.PI * 2);
        ctx.lineWidth = (e.diameter - e.drill) / 2;
        ctx.stroke();
      }
      ctx.restore();
    }
    if (points.length) {
      ctx.save();
      ctx.strokeStyle = "#ffcd11";
      ctx.lineWidth = mode() === "trace" ? draftWidth : 1.5 / scale;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      [...points, ...(cursor ? [cursor] : [])].forEach((q, i) =>
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y),
      );
      if (mode() === "zone") {
        // Zones preview their fill while being drawn, like committed zones.
        ctx.closePath();
        ctx.fillStyle = "#ffcd11";
        ctx.globalAlpha = 0.22;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
      ctx.restore();
    } else if (enabled() && (mode() === "via" || mode() === "trace") && cursor && !drag && !modal()) {
      // Transparent placement preview riding the cursor until the next click;
      // committed elements keep their real (net) colors.
      const unit = p.pxPerMm;
      if (unit) {
        const netColor =
          p.nets?.find((n) => n.id === placementNet())?.color ?? "#a0a0a0";
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = netColor;
        ctx.fillStyle = netColor;
        if (mode() === "via") {
          const d = diameter() * unit,
            dr = drill() * unit;
          ctx.beginPath();
          ctx.arc(cursor.x, cursor.y, (d + dr) / 4, 0, Math.PI * 2);
          ctx.lineWidth = (d - dr) / 2;
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(cursor.x, cursor.y, (width() * unit) / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }
  const netSelect = (value: () => string, change: (id: string) => void) => (
    <select
      aria-label="Net"
      value={value()}
      onChange={(e) => change(e.currentTarget.value)}
    >
      <option value="">Unassigned / automatic</option>
      <For each={pcb()?.nets}>
        {(n) => <option value={n.id}>{n.name}</option>}
      </For>
    </select>
  );
  const Toolbar = () => (
    <>
      <label>
        Layer{" "}
        <select
          aria-label="Shown copper layer"
          value={layer()}
          onChange={(e) => setActiveLayer(e.currentTarget.value)}
        >
          <For each={pcb()?.layers}>
            {(id, i) => (
              <option value={id}>
                {layerLabel(i(), pcb()!.layers.length)}
              </option>
            )}
          </For>
        </select>
      </label>
      <span class="ve-tool-separator" aria-hidden="true" />
      <For each={["select", "trace", "zone", "via"] as Mode[]}>
        {(m) => (
          <button
            aria-pressed={mode() === m}
            aria-label={m === "select" ? "Select" : `Place ${m}`}
            disabled={!pcb() || (m !== "select" && !pcb()?.pxPerMm)}
            title={
              m !== "select" && !pcb()?.pxPerMm
                ? "Calibrate the PCB first"
                : m === "select"
                  ? "Select"
                  : `Place ${m}`
            }
            onClick={() => {
              activate();
              cancel();
              setMode(m);
              setSelected(null);
            }}
          >
            <ActionIcon name={m === "select" ? "Select tool" : `Place ${m}`} />
          </button>
        )}
      </For>
      <button
        aria-label="Place component"
        title="Place component"
        disabled={!pcb()}
        onClick={() => {
          activate();
          setMode("select");
          placeComponent();
        }}
      >
        <ActionIcon name="Place component" />
      </button>
    </>
  );
  const Inspector = () => (
    <div class="ve-copper-inspector">
      <Show when={!pcb()?.pxPerMm}>
        <p>Calibrate the PCB to place copper.</p>
      </Show>
      <Show when={message()}>
        <p role="alert">{message()}</p>
      </Show>
      <Show
        when={element()}
        keyed
        fallback={
          <Show when={mode() !== "select"}>
            <p>New {mode()}</p>
            {netSelect(placementNet, setPlacementNet)}
            <label>
              Trace width (mm)
              <input
                type="number"
                min="0.001"
                step="0.1"
                value={width()}
                onChange={(e) => {
                  const v = +e.currentTarget.value;
                  if (Number.isFinite(v) && v > 0) setWidth(v);
                }}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={angle()}
                onChange={(e) => setAngle(e.currentTarget.checked)}
              />
              45° routing
            </label>
            <label>
              Via diameter (mm)
              <input
                type="number"
                min="0.001"
                value={diameter()}
                onChange={(e) => {
                  const v = +e.currentTarget.value;
                  if (Number.isFinite(v) && v > drill()) setDiameter(v);
                }}
              />
            </label>
            <label>
              Drill (mm)
              <input
                type="number"
                min="0.001"
                value={drill()}
                onChange={(e) => {
                  const v = +e.currentTarget.value;
                  if (Number.isFinite(v) && v > 0 && v < diameter())
                    setDrill(v);
                }}
              />
            </label>
          </Show>
        }
      >
        {(e) => (
          <>
            <p>
              {"width" in e ? "Trace" : "points" in e ? "Zone" : "Through via"}
            </p>
            {netSelect(
              () => e.netId ?? "",
              (id) =>
                patch((target) => {
                  target.netId = id || undefined;
                }),
            )}
            <Show when={"points" in e}>
              <label>
                Layer
                <select
                  aria-label="Element layer"
                  value={"points" in e ? e.layerId : ""}
                  onChange={(ev) =>
                    patch((target) => {
                      if ("points" in target)
                        target.layerId = ev.currentTarget.value;
                    })
                  }
                >
                  <For each={pcb()?.layers}>
                    {(id, i) => (
                      <option value={id}>
                        {layerLabel(i(), pcb()!.layers.length)}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Show>
            <Show when={"width" in e}>
              <label>
                Width (mm)
                <input
                  type="number"
                  min="0.001"
                  step="0.1"
                  value={"width" in e ? e.width / (pcb()?.pxPerMm ?? 1) : 0}
                  onChange={(ev) => {
                    const v = +ev.currentTarget.value;
                    if (Number.isFinite(v) && v > 0)
                      patch((t) => {
                        if ("width" in t) t.width = v * pcb()!.pxPerMm!;
                      });
                  }}
                />
              </label>
              <p>
                Length:{" "}
                {"points" in e
                  ? (length(e.points) / (pcb()?.pxPerMm ?? 1)).toFixed(3)
                  : ""}{" "}
                mm
              </p>
            </Show>
            <Show when={!("points" in e)}>
              <p>All copper layers</p>
              <label>
                Diameter (mm)
                <input
                  type="number"
                  min="0.001"
                  value={
                    !("points" in e) ? e.diameter / (pcb()?.pxPerMm ?? 1) : 0
                  }
                  onChange={(ev) => {
                    const v = +ev.currentTarget.value * pcb()!.pxPerMm!;
                    if (!("points" in e) && v > e.drill)
                      patch((t) => {
                        if (!("points" in t)) t.diameter = v;
                      });
                  }}
                />
              </label>
              <label>
                Drill (mm)
                <input
                  type="number"
                  min="0.001"
                  value={!("points" in e) ? e.drill / (pcb()?.pxPerMm ?? 1) : 0}
                  onChange={(ev) => {
                    const v = +ev.currentTarget.value * pcb()!.pxPerMm!;
                    if (!("points" in e) && v > 0 && v < e.diameter)
                      patch((t) => {
                        if (!("points" in t)) t.drill = v;
                      });
                  }}
                />
              </label>
            </Show>
            <Show when={"points" in e && !("width" in e)}>
              <p>
                {"points" in e ? e.points.length : 0} vertices · area{" "}
                {"points" in e
                  ? (area(e.points) / (pcb()?.pxPerMm ?? 1) ** 2).toFixed(3)
                  : 0}{" "}
                mm²
              </p>
              <p>
                Perimeter:{" "}
                {"points" in e
                  ? (
                      length([...e.points, e.points[0]]) / (pcb()?.pxPerMm ?? 1)
                    ).toFixed(3)
                  : 0}{" "}
                mm
              </p>
              <p>Zones are manually netted; enclosed copper is independent.</p>
              <p>
                {"points" in e ? zoneCensus(pcb()!, e).traces : 0} traces ·{" "}
                {"points" in e ? zoneCensus(pcb()!, e).vias : 0} vias
                enclosed/intersecting
              </p>
            </Show>
            <button onClick={remove}>Delete element</button>
          </>
        )}
      </Show>
    </div>
  );
  const Dialog = () => (
    <Show when={modal()} keyed>
      {(state) => {
        const restore = document.activeElement as HTMLElement | null;
        const close = () => {
          setModal(null);
          state.cancel?.();
          restore?.focus();
        };
        return (
          <div
            class="overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <section
              class="palette ve-value-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={state.title}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  close();
                }
                if (e.key === "Tab") {
                  const items = Array.from(
                    e.currentTarget.querySelectorAll<HTMLElement>(
                      "input,select,button",
                    ),
                  );
                  if (!e.shiftKey && document.activeElement === items.at(-1)) {
                    e.preventDefault();
                    items[0]?.focus();
                  }
                  if (e.shiftKey && document.activeElement === items[0]) {
                    e.preventDefault();
                    items.at(-1)?.focus();
                  }
                }
              }}
            >
              <header class="dialog-header">
                <h2>{state.title}</h2>
              </header>
              <div class="dialog-content">
                <Show when={message()}>
                  <p role="alert">{message()}</p>
                </Show>
                <Show
                  when={!state.title.startsWith("Place component")}
                  fallback={
                    <p>
                      Component selection and placement are not implemented yet.
                    </p>
                  }
                >
                  <label>
                    Net
                    <select
                      autofocus
                      value={choice()}
                      onChange={(e) => setChoice(e.currentTarget.value)}
                    >
                      <option value="">Unassigned</option>
                      <For each={state.choices}>
                        {(n) => <option value={n.id}>{n.name}</option>}
                      </For>
                    </select>
                  </label>
                  <label>
                    New name (optional)
                    <input
                      value={netName()}
                      onInput={(e) => setNetName(e.currentTarget.value)}
                    />
                  </label>
                </Show>
              </div>
              <footer class="dialog-actions">
                <button autofocus onClick={close}>
                  Cancel
                </button>
                <Show when={!state.title.startsWith("Place component")}>
                  <button
                    disabled={state.title.startsWith("Join") && !choice()}
                    onClick={() => {
                      if (
                        state.title.startsWith("Join") &&
                        netName().trim() &&
                        pcb()?.nets?.some(
                          (n) =>
                            n.id !== choice() &&
                            !state.choices.some((c) => c.id === n.id) &&
                            n.name === netName().trim(),
                        )
                      ) {
                        setMessage("Net name already exists.");
                        return;
                      }
                      setModal(null);
                      state.confirm(choice(), netName());
                      restore?.focus();
                    }}
                  >
                    Confirm
                  </button>
                </Show>
              </footer>
            </section>
          </div>
        );
      }}
    </Show>
  );
  return {
    layer,
    selectLayer: setActiveLayer,
    mode,
    selected,
    Toolbar,
    Inspector,
    Dialog,
    down,
    move,
    up,
    draw,
    cancel,
    finish,
    remove,
    key: (key: string) => {
      if (key === "Escape") {
        const handled = points.length > 0 || Boolean(selected());
        cancel();
        setSelected(null);
        setMode("select");
        return handled;
      }
      if (key === "Enter" && points.length) {
        finish();
        return true;
      }
      if (key === "Delete" && element()) {
        remove();
        return true;
      }
      return false;
    },
    drawing: () => mode() !== "select",
    cancelDrag: () => {
      drag = null;
      changed();
    },
  };
}
export type CopperEditor = ReturnType<typeof createCopperEditor>;



