import { save } from "@tauri-apps/plugin-dialog";
import { kicad, type KGraphic } from "../../bridge/kicad";
import type { ProjectDoc, Point } from "../placement/projectDoc";
import type { VisualPcb } from "../visual/model";
import type { ElectricalComponent, SchematicUnit, WireAnchor } from "./model";
import { distance, project as projectPoint } from "../visual/copper";

const q = (s: string) =>
  `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "")}"`;
const n = (value: number) => Number(value.toFixed(6));
export function stableUuid(value: string): string {
  const words = [0x811c9dc5, 0x12345678, 0xabcdef01, 0x98765432];
  for (const c of value)
    for (let i = 0; i < words.length; i++)
      words[i] =
        Math.imul(words[i] ^ c.charCodeAt(0), 0x01000193 + i * 2) >>> 0;
  const hex = words.map((w) => w.toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
const effects = (size = 1.27, hide = false) =>
  `(effects (font (size ${size} ${size}))${hide ? " (hide yes)" : ""})`;
function graphics(g: KGraphic): string {
  const p = g.points,
    stroke = `(stroke (width ${n(g.width || 0.15)}) (type default))`,
    fill = `(fill (type ${g.fill ? "background" : "none"}))`;
  if (!p.length) return "";
  if (g.kind === "rect" && p.length > 1)
    return `(rectangle (start ${n(p[0].x)} ${n(p[0].y)}) (end ${n(p[1].x)} ${n(p[1].y)}) ${stroke} ${fill})`;
  if (g.kind === "circle" && p.length > 1)
    return `(circle (center ${n(p[0].x)} ${n(p[0].y)}) (radius ${n(Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y))}) ${stroke} ${fill})`;
  if (g.kind === "arc" && p.length >= 3)
    return `(arc (start ${n(p[0].x)} ${n(p[0].y)}) (mid ${n(p[1].x)} ${n(p[1].y)}) (end ${n(p[2].x)} ${n(p[2].y)}) ${stroke} ${fill})`;
  if (g.kind === "text")
    return `(text ${q(g.text ?? "")} (at ${n(p[0].x)} ${n(p[0].y)} ${n(g.rotation ?? 0)}) (effects (font (size ${n(g.fontSize?.width ?? 1.27)} ${n(g.fontSize?.height ?? 1.27)}))))`;
  return `(${g.kind === "bezier" ? "bezier" : "polyline"} (pts ${p.map((p) => `(xy ${n(p.x)} ${n(p.y)})`).join(" ")}) ${stroke} ${fill})`;
}
function exportedPins(c: ElectricalComponent, unit: number, bodyStyle = 1) {
  if (!c.definition.symbol)
    return c.terminals.map((t, i) => ({
      number: t.number,
      name: t.number,
      x: -10,
      y: 5 - i * 2.54,
      rotation: 0,
      length: 2.54,
      electricalType: "passive",
    }));
  const result = c.definition.symbol.units
    .filter(
      (u) =>
        (u.unit === unit || u.unit === 0) &&
        (u.bodyStyle === 0 || u.bodyStyle === bodyStyle),
    )
    .flatMap((u) => u.pins)
    .flatMap((pin) => {
      const mapped = Object.entries(c.definition.pinMap)
        .filter(([, num]) => num === pin.number)
        .map(([number]) => ({ ...pin, number }));
      return mapped.length
        ? mapped
        : [{ ...pin, number: `UNMAPPED_SYMBOL_${pin.number}` }];
    });
  if (unit === 1)
    for (const t of c.terminals)
      if (!c.definition.pinMap[t.number])
        result.push({
          number: t.number,
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
function symbol(
  c: ElectricalComponent,
  name: string,
  placements: SchematicUnit[],
): string {
  const short = name.split(":").at(-1)!;
  const units = [
    ...new Set(
      c.definition.symbol?.units
        .filter((u) => u.unit > 0 && u.bodyStyle <= 1)
        .map((u) => u.unit) ?? [1],
    ),
  ];
  return `(symbol ${q(name)} (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" ${q(c.definition.referencePrefix || "U")} (at 0 10 0) ${effects()})
    (property "Value" ${q(c.value || c.partName || c.definition.name)} (at 0 7 0) ${effects()})
    ${(units.length ? units : [1])
      .map((unit) => {
        const bodyStyle =
          placements.find((u) => u.componentId === c.id && u.unit === unit)
            ?.bodyStyle ?? 1;
        return `(symbol ${q(`${short}_${unit}_1`)}
      ${(
        c.definition.symbol?.units
          .filter(
            (u) =>
              (u.unit === unit || u.unit === 0) &&
              (u.bodyStyle === 0 || u.bodyStyle === bodyStyle),
          )
          .flatMap((u) => u.graphics) ?? [
          {
            kind: "rect",
            points: [
              { x: -7.46, y: 7 },
              { x: 9.54, y: -Math.max(5, c.terminals.length * 2.54 - 5) },
            ],
            width: 0.254,
            fill: true,
          } as KGraphic,
        ]
      )
        .map(graphics)
        .join("\n")}
      ${exportedPins(c, unit, bodyStyle)
        .map(
          (pin) =>
            `(pin ${/^(input|output|bidirectional|tri_state|passive|free|unspecified|power_in|power_out|open_collector|open_emitter|no_connect)$/.test(pin.electricalType) ? pin.electricalType : "passive"} line (at ${n(pin.x)} ${n(pin.y)} ${n(pin.rotation)}) (length ${n(pin.length)}) (name ${q(pin.name || "~")} ${effects()}) (number ${q(pin.number)} ${effects()}))`,
        )
        .join("\n")})`;
      })
      .join("\n")})`;
}
function point(u: SchematicUnit, p: Point): Point {
  const r = (u.rotation * Math.PI) / 180,
    x = u.flip ? -p.x : p.x,
    y = -p.y;
  return {
    x: u.x + x * Math.cos(r) - y * Math.sin(r),
    y: u.y + x * Math.sin(r) + y * Math.cos(r),
  };
}
export function buildSchematicFiles(
  project: ProjectDoc,
  pcb: VisualPcb,
): { name: string; text: string }[] {
  const components = pcb.components ?? [],
    doc = structuredClone(
      pcb.schematic ?? { units: [], wires: [], labels: [] },
    ),
    root = stableUuid(`${pcb.id}/sheet`),
    warnings: string[] = [];
  const refs = new Set<string>();
  for (const c of components) {
    const required = [
      ...new Set(
        c.definition.symbol?.units
          .filter((u) => u.unit > 0 && u.bodyStyle <= 1)
          .map((u) => u.unit) ?? [1],
      ),
    ];
    for (const unit of required.length ? required : [1])
      if (!doc.units.some((u) => u.componentId === c.id && u.unit === unit)) {
        const i = doc.units.length;
        doc.units.push({
          id: `${c.id}/unit/${unit}`,
          componentId: c.id,
          unit,
          x: 25 + (i % 5) * 40,
          y: 25 + Math.floor(i / 5) * 45,
          rotation: 0,
        });
      }
  }
  for (const c of components) {
    if (!c.reference.trim() || refs.has(c.reference))
      throw new Error(`Duplicate or empty reference: ${c.reference}`);
    refs.add(c.reference);
    if (c.definition.symbol) {
      const exposed = doc.units
        .filter((u) => u.componentId === c.id)
        .flatMap((u) => exportedPins(c, u.unit, u.bodyStyle ?? 1));
      if (
        c.terminals.some(
          (t) => !exposed.some((pin) => pin.number === t.number),
        ) ||
        Object.keys(c.definition.pinMap).some(
          (number) => !c.terminals.some((t) => t.number === number),
        )
      )
        throw new Error(
          `${c.reference}: pin mapping refers to a missing pad or symbol pin.`,
        );
    }
    if (
      c.definition.footprint.diagnostics.length ||
      c.definition.symbol?.diagnostics.length
    )
      throw new Error(
        `${c.reference}: resolve unsupported library geometry before export.`,
      );
    if (c.terminals.some((t) => t.nc && t.netId))
      throw new Error(`${c.reference}: pin is both NC and assigned to a net.`);
    if (!c.definition.symbol)
      warnings.push(
        `${c.reference}: exported generic symbol; identify the component later.`,
      );
    if (
      c.definition.symbol?.units.some((u) =>
        u.pins.some(
          (pin) => !Object.values(c.definition.pinMap).includes(pin.number),
        ),
      )
    )
      warnings.push(
        `${c.reference}: unmapped symbol pins are preserved as unconnected UNMAPPED_SYMBOL terminals.`,
      );
    for (const t of c.terminals)
      if (!t.nc && !t.netId)
        warnings.push(`${c.reference}.${t.number}: unassigned terminal.`);
    if (
      c.definition.symbol &&
      c.terminals.some((t) => !c.definition.pinMap[t.number])
    )
      warnings.push(
        `${c.reference}: unmapped pads are represented by supplemental terminals.`,
      );
  }
  const names = new Map(
    components.map((c) => [
      c.id,
      `PCBRE:C_${c.id.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    ]),
  );
  const pinPoint = (a: WireAnchor) => {
    const c = components.find((c) => c.id === a.componentId),
      u = doc.units.find(
        (u) =>
          u.componentId === a.componentId && (!a.unit || u.unit === a.unit),
      );
    if (!c || !u) return undefined;
    const pin = exportedPins(c, u.unit, u.bodyStyle ?? 1).find(
      (p) => p.number === a.terminal,
    );
    return pin ? point(u, pin) : undefined;
  };
  const displayedWires = doc.wires.map((w) => {
    const points = w.points.map((p) => ({ ...p })),
      a = w.start && pinPoint(w.start),
      b = w.end && pinPoint(w.end);
    if (a) points[0] = a;
    if (b) points[points.length - 1] = b;
    const routed = points.flatMap((p, i) =>
      !i
        ? [p]
        : points[i - 1].x === p.x || points[i - 1].y === p.y
          ? [p]
          : [{ x: p.x, y: points[i - 1].y }, p],
    );
    return { ...w, points: routed };
  });
  const displayedLabels = doc.labels.map((l) => ({
    ...l,
    ...(l.anchor ? pinPoint(l.anchor) : undefined),
  }));
  const terminalPoints = doc.units.flatMap((u) => {
    const c = components.find((c) => c.id === u.componentId);
    return c
      ? exportedPins(c, u.unit, u.bodyStyle ?? 1).map((pin) => ({
          point: point(u, pin),
          identity: `${c.id}/${pin.number}`,
          terminal: c.terminals.find((t) => t.number === pin.number),
        }))
      : [];
  });
  for (let i = 0; i < displayedLabels.length; i++) {
    const label = displayedLabels[i];
    if (
      displayedLabels
        .slice(i + 1)
        .some(
          (other) =>
            other.netId !== label.netId && distance(label, other) < 1e-6,
        ) ||
      terminalPoints.some(
        (pin) =>
          distance(label, pin.point) < 1e-6 &&
          (pin.terminal?.netId !== label.netId || pin.terminal?.nc),
      )
    )
      throw new Error(
        "Schematic labels conflict with overlapping terminal or label assignments.",
      );
  }
  for (let i = 0; i < terminalPoints.length; i++)
    for (const other of terminalPoints.slice(i + 1)) {
      const a = terminalPoints[i];
      if (
        a.identity !== other.identity &&
        distance(a.point, other.point) < 1e-6 &&
        (!a.terminal?.netId ||
          a.terminal.netId !== other.terminal?.netId ||
          a.terminal.nc ||
          other.terminal?.nc)
      )
        throw new Error(
          "Overlapping schematic pins would introduce an implicit connection. Move them apart or explicitly assign their nets.",
        );
    }
  const onWire = (p: Point, w: (typeof displayedWires)[number]) =>
    w.points
      .slice(1)
      .some((b, i) => distance(p, projectPoint(p, w.points[i], b)) < 1e-6);
  const visited = new Set<string>();
  for (const seed of displayedWires) {
    if (visited.has(seed.id)) continue;
    const group = [seed];
    for (let i = 0; i < group.length; i++)
      for (const w of displayedWires)
        if (
          !group.includes(w) &&
          ([w.points[0], w.points.at(-1)!].some((p) => onWire(p, group[i])) ||
            [group[i].points[0], group[i].points.at(-1)!].some((p) =>
              onWire(p, w),
            ))
        )
          group.push(w);
    for (const w of group) visited.add(w.id);
    const ids = new Set(group.flatMap((w) => (w.netId ? [w.netId] : [])));
    for (const u of doc.units) {
      const c = components.find((c) => c.id === u.componentId);
      if (!c) continue;
      for (const pin of exportedPins(c, u.unit, u.bodyStyle ?? 1))
        if (group.some((w) => onWire(point(u, pin), w))) {
          const t = c.terminals.find((t) => t.number === pin.number);
          if (t?.nc)
            throw new Error(
              `${c.reference}.${pin.number}: NC terminal touches a wire.`,
            );
          if (t?.netId) ids.add(t.netId);
        }
    }
    for (const l of displayedLabels)
      if (group.some((w) => onWire(l, w))) ids.add(l.netId);
    if (ids.size > 1)
      throw new Error(
        "Drawn schematic wiring shorts different assigned nets. Resolve the connection before export.",
      );
  }
  const units = doc.units.map((u) => {
    const c = components.find((c) => c.id === u.componentId);
    if (!c) throw new Error("Schematic references a missing component.");
    const id = stableUuid(`${pcb.id}/${u.id}`),
      footprint = `PCBRE:C_${c.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    return `(symbol (lib_id ${q(names.get(c.id)!)}) (at ${n(u.x)} ${n(u.y)} ${n(u.flip ? u.rotation : (360 - u.rotation) % 360)}) (unit ${u.unit})${u.flip ? " (mirror y)" : ""} (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid ${id})
      (property "Reference" ${q(c.reference)} (at ${n(u.x)} ${n(u.y - 12)} 0) ${effects()})
      (property "Value" ${q(c.value || c.partName || "~")} (at ${n(u.x)} ${n(u.y - 9)} 0) ${effects()})
      (property "Footprint" ${q(footprint)} (at ${n(u.x)} ${n(u.y)} 0) ${effects(1.27, true)})
      ${exportedPins(c, u.unit, u.bodyStyle ?? 1)
        .map(
          (p) =>
            `(pin ${q(p.number)} (uuid ${stableUuid(`${id}/pin/${p.number}`)}))`,
        )
        .join("\n")}
      (instances (project "pcb-re-studio" (path ${q(`/${root}`)} (reference ${q(c.reference)}) (unit ${u.unit})))))`;
  });
  const wires = displayedWires.flatMap((w) => {
    const points = w.points.map((p) => ({ ...p })),
      a = w.start && pinPoint(w.start),
      b = w.end && pinPoint(w.end);
    if (a) points[0] = a;
    if (b) points[points.length - 1] = b;
    return points
      .slice(1)
      .map(
        (p, i) =>
          `(wire (pts (xy ${n(points[i].x)} ${n(points[i].y)}) (xy ${n(p.x)} ${n(p.y)})) (stroke (width 0) (type default)) (uuid ${stableUuid(`${pcb.id}/${w.id}/${i}`)}))`,
      );
  });
  const labels: string[] = [],
    nc: string[] = [];
  for (const u of doc.units) {
    const c = components.find((c) => c.id === u.componentId)!;
    for (const pin of exportedPins(c, u.unit, u.bodyStyle ?? 1)) {
      const t = c.terminals.find((t) => t.number === pin.number),
        p = point(u, pin),
        id = `${pcb.id}/${u.id}/${pin.number}`;
      if (t?.nc)
        nc.push(
          `(no_connect (at ${n(p.x)} ${n(p.y)}) (uuid ${stableUuid(`${id}/nc`)}))`,
        );
      else if (t?.netId) {
        const net = pcb.nets?.find((net) => net.id === t.netId);
        if (!net) throw new Error(`${c.reference}.${pin.number}: missing net.`);
        labels.push(
          `(label ${q(net.name)} (at ${n(p.x)} ${n(p.y)} 0) ${effects()} (uuid ${stableUuid(`${id}/label`)}))`,
        );
        if (
          !doc.wires.some((w) =>
            [w.start, w.end].some(
              (a) => a?.componentId === c.id && a.terminal === pin.number,
            ),
          )
        )
          warnings.push(
            `${c.reference}.${pin.number}: logical net ${net.name} preserved with a label; schematic wiring unfinished.`,
          );
      }
    }
  }
  for (const l of displayedLabels) {
    const net = pcb.nets?.find((n) => n.id === l.netId);
    if (net)
      labels.push(
        `(label ${q(net.name)} (at ${n(l.x)} ${n(l.y)} 0) ${effects()} (uuid ${stableUuid(`${pcb.id}/${l.id}`)}))`,
      );
  }
  const junctions = new Map<string, Point>();
  for (const w of displayedWires)
    for (const p of [w.points[0], w.points.at(-1)!]) {
      if (!p) continue;
      // A junction dot is needed only where an endpoint lands strictly
      // INSIDE another wire's segment (a T-join). End-to-end touches connect
      // in KiCad without a dot, and the wire's own segments never count, so
      // the old "more than one containing segment" test dotted every plain
      // two-wire corner.
      const tJoin = displayedWires.some(
        (other) =>
          other !== w &&
          other.points.slice(1).some((b, i) => {
            const a = other.points[i],
              cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
            return (
              Math.abs(cross) < 1e-6 &&
              p.x >= Math.min(a.x, b.x) - 1e-6 &&
              p.x <= Math.max(a.x, b.x) + 1e-6 &&
              p.y >= Math.min(a.y, b.y) - 1e-6 &&
              p.y <= Math.max(a.y, b.y) + 1e-6 &&
              distance(p, a) > 1e-6 &&
              distance(p, b) > 1e-6
            );
          }),
      );
      if (tJoin) junctions.set(`${p.x}/${p.y}`, p);
    }
  const sch = `(kicad_sch (version 20250114) (generator "pcb_re_studio") (uuid ${root}) (paper "A3") (lib_symbols ${components.map((c) => symbol(c, names.get(c.id)!, doc.units)).join("\n")}) ${wires.join("\n")} ${[...junctions].map(([id, p]) => `(junction (at ${n(p.x)} ${n(p.y)}) (diameter 0) (color 0 0 0 0) (uuid ${stableUuid(`${pcb.id}/junction/${id}`)}))`).join("\n")} ${labels.join("\n")} ${nc.join("\n")} ${units.join("\n")} (embedded_fonts no))`;
  const files = [
    { name: "pcb-re-studio.kicad_sch", text: sch },
    { name: "pcb-re-studio.kicad_pro", text: "{}" },
    {
      name: "PCBRE.kicad_sym",
      text: `(kicad_symbol_lib (version 20241209) (generator "pcb_re_studio") ${components.map((c) => symbol(c, names.get(c.id)!.split(":")[1], doc.units)).join("\n")})`,
    },
    {
      name: "sym-lib-table",
      text: '(sym_lib_table (lib (name "PCBRE")(type "KiCad")(uri "${KIPRJMOD}/PCBRE.kicad_sym")(options "")(descr "Embedded PCB RE Studio symbols")))',
    },
    {
      name: "fp-lib-table",
      text: '(fp_lib_table (lib (name "PCBRE")(type "KiCad")(uri "${KIPRJMOD}/PCBRE.pretty")(options "")(descr "Embedded PCB RE Studio footprints")))',
    },
    {
      name: "unfinished-work.txt",
      text: `${project.name} - ${pcb.name}\n\n${warnings.length ? warnings.join("\n") : "No unresolved electrical items detected."}\n\nPower connectivity is explicit. Hidden symbol pins are materialized; no symbol-name-based implicit power joins were generated.\n`,
    },
  ];
  for (const c of components) {
    const name = names.get(c.id)!.split(":")[1],
      footprint = c.definition.footprint;
    if (c.scale !== 1) {
      const s = c.scale;
      const pads = footprint.pads
        .map(
          (p) =>
            `(pad ${q(p.number)} ${p.type ?? (p.drill ? (p.plated ? "thru_hole" : "np_thru_hole") : "smd")} ${p.shape === "custom" ? "custom" : p.shape} (at ${n(p.x * s)} ${n(p.y * s)} ${n(p.rotation)}) (size ${n(p.width * s)} ${n(p.height * s)}) ${p.drill ? `(drill ${p.drill.width !== p.drill.height ? "oval " : ""}${n(p.drill.width * s)}${p.drill.width !== p.drill.height ? ` ${n(p.drill.height * s)}` : ""} (offset ${n(p.drill.x * s)} ${n(p.drill.y * s)}))` : ""} (layers ${p.layers.map(q).join(" ")})${p.shape === "roundrect" ? ` (roundrect_rratio ${p.roundrectRatio ?? 0.25})` : ""}${p.shape === "custom" ? ` (options (clearance outline) (anchor ${p.anchor ?? "rect"})) (primitives ${(p.primitives ?? []).map((g) => footprintGraphic(g, s, true)).join(" ")})` : ""})`,
        )
        .join("\n");
      files.push({
        name: `PCBRE.pretty/${name}.kicad_mod`,
        text: `(footprint ${q(name)} (version 20241229) (generator "pcb_re_studio") (layer "F.Cu") ${footprint.graphics.map((g) => footprintGraphic(g, s)).join("\n")} ${pads})`,
      });
    } else
      files.push({
        name: `PCBRE.pretty/${name}.kicad_mod`,
        text: footprint.raw.replace(
          /^\s*\((?:footprint|module)\s+(?:"(?:\\.|[^"\\])*"|[^\s()]+)/,
          `(footprint ${q(name)}`,
        ),
      });
  }
  return files;
}
function footprintGraphic(
  g: KGraphic,
  scale: number,
  primitive = false,
): string {
  const p = g.points.map((p) => ({ x: n(p.x * scale), y: n(p.y * scale) })),
    stroke = `(stroke (width ${n(g.width * scale)}) (type default))`,
    layer = primitive ? "" : `(layer ${q(g.layer ?? "F.SilkS")})`,
    type = primitive ? "gr" : "fp";
  if (g.kind === "text")
    return primitive
      ? ""
      : `(fp_text user ${q(g.text ?? "")} (at ${p[0]?.x ?? 0} ${p[0]?.y ?? 0} ${n(g.rotation ?? 0)}) ${layer} (effects (font (size ${n((g.fontSize?.width ?? 1.27) * scale)} ${n((g.fontSize?.height ?? 1.27) * scale)}))))`;
  if (!p.length) return "";
  if (g.kind === "circle" && p.length > 1)
    return `(${type}_circle (center ${p[0].x} ${p[0].y}) (end ${p[1].x} ${p[1].y}) ${stroke} (fill ${g.fill ? "solid" : "none"}) ${layer})`;
  if (g.kind === "arc" && p.length > 2)
    return `(${type}_arc (start ${p[0].x} ${p[0].y}) (mid ${p[1].x} ${p[1].y}) (end ${p[2].x} ${p[2].y}) ${stroke} ${layer})`;
  if (g.kind === "rect" && p.length > 1)
    return `(${type}_rect (start ${p[0].x} ${p[0].y}) (end ${p[1].x} ${p[1].y}) ${stroke} (fill ${g.fill ? "solid" : "none"}) ${layer})`;
  if (g.kind === "line" && p.length > 1)
    return `(${type}_line (start ${p[0].x} ${p[0].y}) (end ${p[1].x} ${p[1].y}) ${stroke} ${layer})`;
  return `(${type}_${g.kind === "bezier" ? "curve" : "poly"} (pts ${p.map((p) => `(xy ${p.x} ${p.y})`).join(" ")}) ${stroke} (fill ${g.fill ? "solid" : "none"}) ${layer})`;
}
export async function exportSchematicPackage(
  project: ProjectDoc,
  pcb: VisualPcb,
): Promise<void> {
  const files = buildSchematicFiles(project, pcb);
  const path = await save({
    defaultPath: "pcb-re-studio-kicad.zip",
    filters: [{ name: "KiCad project package", extensions: ["zip"] }],
  });
  if (path) await kicad.exportFiles(path, files);
}
