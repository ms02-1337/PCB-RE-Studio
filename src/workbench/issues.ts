import {
  componentProximities,
  componentWorldBounds,
  padPoint,
} from "./electrical/domain";
import { ncContacts, openTraceEnds } from "./visual/copper";
import type { VisualPcb } from "./visual/model";
import type { Point } from "./placement/projectDoc";

export const issueCategories = [
  "Component issues",
  "Trace issues",
  "Electrical conflicts",
  "Unfinished work",
] as const;
export type IssueCategory = (typeof issueCategories)[number];
export type IssueSeverity = "Error" | "Warning" | "Unfinished";
export interface IssueTarget {
  componentIds?: string[];
  traceId?: string;
  terminal?: string;
  layerId: string;
  point?: Point;
  bounds: { left: number; right: number; top: number; bottom: number };
}
export interface ProjectIssue {
  id: string;
  pcbId: string;
  pcbName: string;
  category: IssueCategory;
  severity: IssueSeverity;
  message: string;
  target?: IssueTarget;
}
export interface IssueReveal {
  issue: ProjectIssue;
  session: number;
  token: number;
}

export function collectPcbIssues(pcb: VisualPcb): ProjectIssue[] {
  const result: ProjectIssue[] = [];
  const components = pcb.components ?? [];
  const target = (ids: string[], terminal?: string): IssueTarget => {
    const c = components.find((c) => c.id === ids[0])!;
    const boxes = components
      .filter((c) => ids.includes(c.id))
      .map((c) => componentWorldBounds(c, pcb.pxPerMm ?? 1))
      .filter((b) => !!b);
    const pad = terminal
      ? c.definition.footprint.pads.find((p) => p.number === terminal)
      : undefined;
    const point = pad ? padPoint(c, pad, pcb.pxPerMm ?? 1) : undefined;
    return {
      componentIds: ids,
      terminal,
      layerId: c.layerId,
      point,
      bounds: point
        ? {
            left: point.x - 10,
            right: point.x + 10,
            top: point.y - 10,
            bottom: point.y + 10,
          }
        : boxes.length
          ? {
              left: Math.min(...boxes.map((b) => b.minX)),
              right: Math.max(...boxes.map((b) => b.maxX)),
              top: Math.min(...boxes.map((b) => b.minY)),
              bottom: Math.max(...boxes.map((b) => b.maxY)),
            }
          : {
              left: c.x - 10,
              right: c.x + 10,
              top: c.y - 10,
              bottom: c.y + 10,
            },
    };
  };
  const add = (
    key: string,
    category: IssueCategory,
    severity: IssueSeverity,
    message: string,
    location?: IssueTarget,
  ) =>
    result.push({
      id: JSON.stringify([pcb.id, key]),
      pcbId: pcb.id,
      pcbName: pcb.name,
      category,
      severity,
      message,
      target: location,
    });
  for (const c of components) {
    const loc = target([c.id]);
    const addComponent = (
      key: string,
      message: string,
      severity: IssueSeverity = "Unfinished",
      terminal?: string,
    ) =>
      add(
        `${c.id}/${key}`,
        severity === "Unfinished" ? "Unfinished work" : "Component issues",
        severity,
        `${c.reference || "Unnamed component"}${terminal ? `.${terminal}` : ""}: ${message}`,
        terminal ? target([c.id], terminal) : loc,
      );
    if (
      !c.reference.trim() ||
      components.some(
        (other) => other.id !== c.id && other.reference === c.reference,
      )
    )
      addComponent("reference", "empty or duplicate reference", "Error");
    for (const [kind, diagnostics] of [
      ["Footprint", c.definition.footprint.diagnostics],
      ["Symbol", c.definition.symbol?.diagnostics ?? []],
    ] as const)
      diagnostics.forEach((d, i) =>
        addComponent(`${kind}/${i}`, `${kind}: ${d}`, "Error"),
      );
    const pins = new Set(
      c.definition.symbol?.units.flatMap((u) => u.pins.map((p) => p.number)) ??
        [],
    );
    if (
      c.definition.symbol &&
      Object.entries(c.definition.pinMap).some(
        ([pad, pin]) =>
          !c.terminals.some((t) => t.number === pad) || !pins.has(pin),
      )
    )
      addComponent(
        "invalid-map",
        "pin mapping references a missing pad or symbol pin",
        "Error",
      );
    if (!c.definition.symbol)
      addComponent("generic", "generic symbol needs identification");
    else if (
      [...pins].some((pin) => !Object.values(c.definition.pinMap).includes(pin))
    )
      addComponent("symbol-map", "symbol pins remain unmapped to PCB pads");
    for (const t of c.terminals) {
      if (c.definition.symbol && !c.definition.pinMap[t.number])
        addComponent(
          `unmapped/${t.number}`,
          "unmapped terminal",
          "Unfinished",
          t.number,
        );
      if (!t.netId && !t.nc)
        addComponent(
          `unassigned/${t.number}`,
          "unassigned terminal",
          "Unfinished",
          t.number,
        );
      if (t.netId && t.nc)
        add(
          `${c.id}/nc-net/${t.number}`,
          "Electrical conflicts",
          "Error",
          `${c.reference}.${t.number}: both NC and assigned to a net`,
          target([c.id], t.number),
        );
    }
  }
  for (const pair of componentProximities(components, pcb.pxPerMm ?? 1))
    add(
      `pair/${[pair.a.id, pair.b.id].sort().join("/")}`,
      "Component issues",
      "Warning",
      `${pair.a.reference} ${pair.overlapping ? "overlaps" : "near"} ${pair.b.reference}${pair.overlapping ? "" : ` (${pair.gapMm.toFixed(2)} ${pcb.pxPerMm ? "mm" : "px"})`}`,
      target([pair.a.id, pair.b.id]),
    );
  for (const end of openTraceEnds(pcb)) {
    const trace = pcb.traces!.find((t) => t.id === end.traceId)!;
    const start = trace.points[0];
    const side =
      start.x === end.point.x && start.y === end.point.y ? "start" : "end";
    add(
      `${end.traceId}/${side}`,
      "Trace issues",
      "Warning",
      `Trace ${end.traceId}: ${side} is not connected`,
      {
        traceId: end.traceId,
        layerId: end.layerId,
        point: end.point,
        bounds: {
          left: end.point.x - 10,
          right: end.point.x + 10,
          top: end.point.y - 10,
          bottom: end.point.y + 10,
        },
      },
    );
  }
  const nc = new Set(ncContacts(pcb));
  for (const c of components)
    for (const t of c.terminals)
      if (nc.has(`${c.id}:${t.number}`))
        add(
          `${c.id}/nc-contact/${t.number}`,
          "Electrical conflicts",
          "Error",
          `${c.reference}.${t.number}: NC copper contact`,
          target([c.id], t.number),
        );
  return result.sort(
    (a, b) =>
      a.message.localeCompare(b.message, undefined, { numeric: true }) ||
      a.id.localeCompare(b.id),
  );
}
