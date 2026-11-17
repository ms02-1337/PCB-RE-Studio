import { createSignal, For, Show } from "solid-js";
import { ActionIcon } from "../ActionIcon";
import type { PlacementStore } from "../placement/store";
import { mergeNets, netElements, newNet, type NetElement } from "./copper";
import type { CopperNet, VisualPcb } from "./model";
import { NetElementsModal } from "./NetElementsModal";
import "./visual.css";

export function NetsPanel(props: {
  store: PlacementStore;
  onNavigate: () => void;
}) {
  const pcb = props.store.visual.activePcb;
  const [search, setSearch] = createSignal("");
  const [name, setName] = createSignal("");
  const [modalNet, setModalNet] = createSignal<CopperNet | null>(null);
  const [targetMap, setTargetMap] = createSignal<Record<string, string>>({});

  const edit = (fn: (p: VisualPcb) => void) => {
    const p = pcb();
    if (!p) return;
    const next = JSON.parse(JSON.stringify(p)) as VisualPcb;
    fn(next);
    props.store.visual.replaceCopper(next.id, next);
  };

  const members = (id: string) => (pcb() ? netElements(pcb()!, id) : []);

  const filteredNets = () => {
    const q = search().trim().toLowerCase();
    const all = pcb()?.nets ?? [];
    if (!q) return all;
    return all.filter((n) => n.name.toLowerCase().includes(q));
  };

  return (
    <div class="ve-nets">
      <Show
        when={props.store.doc()}
        fallback={<p class="muted">Open a project to manage nets.</p>}
      >
        <div class="ve-nets-header">
          <h1>PCB nets</h1>
          <span class="ve-nets-title-separator" aria-hidden="true" />
          <span class="ve-nets-count">
            {pcb()?.nets?.length ?? 0} nets
          </span>
          <label>
            PCB{" "}
            <select
              aria-label="Select PCB"
              value={pcb()?.id}
              onChange={(e) => {
                props.store.visual.activate(e.currentTarget.value);
                setModalNet(null);
              }}
            >
              <For each={props.store.visual.editor()?.pcbs}>
                {(p) => <option value={p.id}>{p.name}</option>}
              </For>
            </select>
          </label>
          <input
            type="search"
            aria-label="Search nets"
            placeholder="Search nets by name…"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <form
            class="ve-nets-create-form"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name().trim();
              if (
                trimmed &&
                !pcb()?.nets?.some(
                  (n) => n.name.toLowerCase() === trimmed.toLowerCase(),
                )
              ) {
                edit((p) => {
                  newNet(p, trimmed);
                });
                setName("");
              }
            }}
          >
            <input
              aria-label="New net name"
              placeholder="New net name…"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <button type="submit" disabled={!name().trim()}>
              <ActionIcon name="Create" />
              Create net
            </button>
          </form>
        </div>

        <div class="ve-nets-table-wrapper">
          <table class="ve-nets-table" aria-label="PCB nets table">
            <thead>
              <tr>
                <th class="col-color">Color</th>
                <th class="col-name">Net name</th>
                <th class="col-stat">Pads</th>
                <th class="col-stat">Vias</th>
                <th class="col-stat">Traces</th>
                <th class="col-stat">Zones</th>
                <th class="col-merge">Merge into</th>
                <th class="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              <For
                each={filteredNets()}
                fallback={
                  <tr>
                    <td colspan={8} class="ve-nets-empty">
                      {search()
                        ? "No nets match your search."
                        : "No nets defined for this PCB."}
                    </td>
                  </tr>
                }
              >
                {(net) => {
                  const elements = () => members(net.id);
                  const padsCount = () =>
                    elements().filter((e) => e.kind === "pad").length;
                  const viasCount = () =>
                    elements().filter((e) => e.kind === "via").length;
                  const tracesCount = () =>
                    elements().filter((e) => e.kind === "trace").length;
                  const zonesCount = () =>
                    elements().filter((e) => e.kind === "zone").length;
                  const totalElements = () => elements().length;

                  return (
                    <tr>
                      <td class="col-color">
                        <input
                          type="color"
                          aria-label={`Color for ${net.name}`}
                          value={net.color}
                          onChange={(e) =>
                            edit((p) => {
                              p.nets!.find((n) => n.id === net.id)!.color =
                                e.currentTarget.value;
                            })
                          }
                        />
                      </td>
                      <td class="col-name">
                        <button
                          type="button"
                          class="ve-net-title-btn"
                          aria-label={`View elements in ${net.name}`}
                          title={`Click to view all ${totalElements()} elements in ${net.name}`}
                          onClick={() => setModalNet(net)}
                        >
                          <span
                            class="ve-net-dot"
                            style={{ background: net.color }}
                            aria-hidden="true"
                          />
                          <span class="ve-net-name-label">{net.name}</span>
                          <span class="ve-net-pill">{totalElements()}</span>
                        </button>
                      </td>
                      <td class="col-stat">{padsCount()}</td>
                      <td class="col-stat">{viasCount()}</td>
                      <td class="col-stat">{tracesCount()}</td>
                      <td class="col-stat">{zonesCount()}</td>
                      <td class="col-merge">
                        <div class="ve-net-merge-group">
                          <select
                            aria-label={`Merge ${net.name} into`}
                            value={targetMap()[net.id] ?? ""}
                            onChange={(e) =>
                              setTargetMap((prev) => ({
                                ...prev,
                                [net.id]: e.currentTarget.value,
                              }))
                            }
                          >
                            <option value="">Choose net…</option>
                            <For
                              each={pcb()?.nets?.filter((n) => n.id !== net.id)}
                            >
                              {(n) => <option value={n.id}>{n.name}</option>}
                            </For>
                          </select>
                          <button
                            type="button"
                            disabled={!targetMap()[net.id]}
                            onClick={() => {
                              const tId = targetMap()[net.id];
                              if (!tId) return;
                              const targetName = pcb()?.nets?.find(
                                (n) => n.id === tId,
                              )?.name;
                              if (
                                window.confirm(
                                  `Merge net "${net.name}" into "${targetName}" and combine all member assignments?`,
                                )
                              ) {
                                edit((p) => mergeNets(p, [net.id, tId], tId));
                                setTargetMap((prev) => ({
                                  ...prev,
                                  [net.id]: "",
                                }));
                              }
                            }}
                          >
                            Merge
                          </button>
                        </div>
                      </td>
                      <td class="col-actions">
                        <div class="ve-net-actions-group">
                          <input
                            class="ve-net-rename"
                            aria-label={`Rename ${net.name}`}
                            title="Rename net"
                            value={net.name}
                            onChange={(e) => {
                              const value = e.currentTarget.value.trim();
                              if (
                                value &&
                                !pcb()?.nets?.some(
                                  (n) =>
                                    n.id !== net.id &&
                                    n.name.toLowerCase() ===
                                      value.toLowerCase(),
                                )
                              ) {
                                edit((p) => {
                                  p.nets!.find((n) => n.id === net.id)!.name =
                                    value;
                                });
                              }
                            }}
                          />
                          <button
                            type="button"
                            class="danger"
                            title={`Delete ${net.name} and unassign its elements`}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Delete ${net.name} and unassign all its elements?`,
                                )
                              ) {
                                edit((p) => {
                                  p.nets = p.nets?.filter(
                                    (n) => n.id !== net.id,
                                  );
                                  for (const c of p.components ?? [])
                                    for (const t of c.terminals)
                                      if (t.netId === net.id) delete t.netId;
                                  for (const w of p.schematic?.wires ?? [])
                                    if (w.netId === net.id) delete w.netId;
                                  if (p.schematic)
                                    p.schematic.labels =
                                      p.schematic.labels.filter(
                                        (l) => l.netId !== net.id,
                                      );
                                  for (const e of [
                                    ...(p.traces ?? []),
                                    ...(p.vias ?? []),
                                    ...(p.zones ?? []),
                                  ])
                                    if (e.netId === net.id) delete e.netId;
                                });
                                if (modalNet()?.id === net.id)
                                  setModalNet(null);
                              }
                            }}
                          >
                            Delete / unassign
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>

        <Show when={modalNet()} keyed>
          {(activeNet) => (
            <NetElementsModal
              net={activeNet}
              pcb={pcb}
              elements={() => members(activeNet.id)}
              onClose={() => setModalNet(null)}
              onGoTo={(el) => {
                if (el.kind === "pad")
                  sessionStorage.setItem(
                    "electrical-navigation",
                    JSON.stringify({ componentId: el.id }),
                  );
                sessionStorage.setItem(
                  "visual-net-navigation",
                  JSON.stringify({
                    pcbId: pcb()!.id,
                    elementId: el.id,
                    ...(el.layerId ? { layerId: el.layerId } : {}),
                    netId: activeNet.id,
                  }),
                );
                setModalNet(null);
                props.onNavigate();
              }}
              onEditComment={(el: NetElement, comment: string) => {
                edit((draft) => {
                  const value = comment.trim() || undefined;
                  if (el.kind === "pad") {
                    const term = draft.components
                      ?.find((x) => x.id === el.id)
                      ?.terminals?.find((x) => x.number === el.terminal);
                    if (term) term.comment = value;
                  } else if (el.kind === "trace") {
                    const t = draft.traces?.find((x) => x.id === el.id);
                    if (t) t.comment = value;
                  } else if (el.kind === "via") {
                    const v = draft.vias?.find((x) => x.id === el.id);
                    if (v) v.comment = value;
                  } else {
                    const z = draft.zones?.find((x) => x.id === el.id);
                    if (z) z.comment = value;
                  }
                });
              }}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}
