import type { VisualPcb } from "../visual/model";
import type { WireAnchor } from "./model";
import { connected, mergeNets, distance, project } from "../visual/copper";
interface NetMember {
  netId?: string;
  nc?: boolean;
}
export function electricalMembers(
  pcb: VisualPcb,
  seeds: string[],
): NetMember[] {
  const keys = new Set(seeds),
    members: NetMember[] = [],
    visited = new Set<string>();
  let more = true;
  const anchorKey = (a: WireAnchor) => a.componentId + ":" + a.terminal;
  while (more) {
    more = false;
    for (const seed of [...keys])
      for (const c of connected(pcb, [seed])) {
        if (!visited.has(c.id)) {
          visited.add(c.id);
          members.push(c);
          more = true;
        }
        if ("padTerminal" in c && !keys.has(c.padTerminal)) {
          keys.add(c.padTerminal);
          more = true;
        }
      }
    for (const c of pcb.components ?? [])
      for (const t of c.terminals)
        if (keys.has(c.id + ":" + t.number) && !members.includes(t)) {
          members.push(t);
          more = true;
        }
    for (const w of pcb.schematic?.wires ?? []) {
      const anchors = [w.start, w.end, ...(w.connections ?? [])].filter(
        (a): a is WireAnchor => Boolean(a),
      );
      const on = (p: { x: number; y: number }, other: typeof w) =>
        other.points
          .slice(1)
          .some((q, i) => distance(p, project(p, other.points[i], q)) < 1e-6);
      const touchesVisited = (pcb.schematic?.wires ?? []).some(
        (other) =>
          visited.has(other.id) &&
          ([w.points[0], w.points.at(-1)].some((p) => p && on(p, other)) ||
            [other.points[0], other.points.at(-1)].some((p) => p && on(p, w))),
      );
      if (
        !visited.has(w.id) &&
        (anchors.some((a) => keys.has(anchorKey(a))) || touchesVisited)
      ) {
        visited.add(w.id);
        members.push(w);
        for (const a of anchors) keys.add(anchorKey(a));
        more = true;
      }
    }
    for (const l of pcb.schematic?.labels ?? [])
      if (
        !members.includes(l) &&
        ((l.anchor && keys.has(anchorKey(l.anchor))) ||
          (pcb.schematic?.wires ?? []).some(
            (w) =>
              visited.has(w.id) &&
              w.points
                .slice(1)
                .some((q, i) => distance(l, project(l, w.points[i], q)) < 1e-6),
          ))
      ) {
        members.push(l);
        more = true;
      }
  }
  return members;
}
export function assignTerminalNet(
  pcb: VisualPcb,
  anchors: WireAnchor[],
  netId: string,
) {
  const groups = anchors.flatMap((a) =>
    electricalMembers(pcb, [a.componentId + ":" + a.terminal]),
  );
  const ids = [
    ...new Set(
      [
        ...groups.map((c) => c.netId),
        ...anchors.map(
          (a) =>
            pcb.components
              ?.find((c) => c.id === a.componentId)
              ?.terminals.find((t) => t.number === a.terminal)?.netId,
        ),
        netId,
      ].filter((n): n is string => Boolean(n)),
    ),
  ];
  return {
    conflicts: ids,
    hasNc: groups.some((g) => g.nc === true),
    apply: (survivor: string) => {
      mergeNets(pcb, ids, survivor);
      for (const g of groups) {
        g.netId = survivor;
        if (g.nc) g.nc = false;
      }
      for (const a of anchors) {
        const t = pcb.components
          ?.find((c) => c.id === a.componentId)
          ?.terminals.find((t) => t.number === a.terminal);
        if (t) {
          t.netId = survivor;
          t.nc = false;
        }
      }
    },
  };
}
