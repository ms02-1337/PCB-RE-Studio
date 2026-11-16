import type { VisualPcb } from "../visual/model";
import type { WireAnchor } from "./model";
import { connected, mergeNets } from "../visual/copper";
export function assignTerminalNet(
  pcb: VisualPcb,
  anchors: WireAnchor[],
  netId: string,
) {
  const groups = anchors.flatMap((a) =>
    connected(pcb, [a.componentId + ":" + a.terminal]),
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
    apply: (survivor: string) => {
      mergeNets(pcb, ids, survivor);
      for (const g of groups) g.netId = survivor;
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
