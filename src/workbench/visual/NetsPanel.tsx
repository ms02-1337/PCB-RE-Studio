import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ActionIcon } from "../ActionIcon";
import type { PlacementStore } from "../placement/store";
import { length, mergeNets, newNet } from "./copper";
import { layerLabel, type CopperNet, type VisualPcb } from "./model";
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

  const members = (id: string) =>
    [
      ...(pcb()?.traces ?? []),
      ...(pcb()?.vias ?? []),
      ...(pcb()?.zones ?? []),
    ].filter((e) => e.netId === id);

  const filteredNets = () => {
    const q = search().trim().toLowerCase();
    const all = pcb()?.nets ?? [];
    if (!q) return all;
    return all.filter((n) => n.name.toLowerCase().includes(q));
  };

  const getLayerName = (layerId?: string) => {
    const p = pcb();
    if (!layerId || !p?.layers) return "-";
    const idx = p.layers.indexOf(layerId);
    if (idx < 0) return layerId;
    return layerLabel(idx, p.layers.length);
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalNet()) {
        setModalNet(null);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="ve-nets">
      <Show
        when={props.store.doc()}
        fallback={<p class="muted">Open a project to manage nets.</p>}
      >
        <div class="ve-nets-header">
          <div class="ve-nets-title-row">
            <div class="ve-nets-title-group">
              <h1>PCB nets</h1>
              <span class="ve-nets-count">
                {pcb()?.nets?.length ?? 0} nets
              </span>
            </div>
            <div class="ve-nets-pcb-control">
              <label for="ve-nets-pcb-select">PCB</label>
              <select
                id="ve-nets-pcb-select"
                class="ve-nets-pcb-select"
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
            </div>
          </div>

          <div class="ve-nets-toolbar">
            <div class="ve-nets-search">
              <label for="ve-nets-search-input">Search nets</label>
              <input
                id="ve-nets-search-input"
                type="search"
                placeholder="Search nets by name…"
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
              />
            </div>
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
              <label for="ve-nets-new-input">New net name</label>
              <input
                id="ve-nets-new-input"
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
                  const padsCount = () =>
                    (pcb()?.components ?? [])
                      .flatMap((c) => c.terminals)
                      .filter((t) => t.netId === net.id).length;
                  const viasCount = () =>
                    members(net.id).filter((e) => !("points" in e)).length;
                  const tracesCount = () =>
                    members(net.id).filter((e) => "width" in e).length;
                  const zonesCount = () =>
                    members(net.id).filter(
                      (e) => "points" in e && !("width" in e),
                    ).length;
                  const totalElements = () =>
                    padsCount() + viasCount() + tracesCount() + zonesCount();

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

        <Show when={modalNet()}>
          {(activeNet) => {
            const netId = activeNet().id;

            const elements = () => {
              const p = pcb();
              if (!p) return [];
              const list: {
                type: string;
                name: string;
                layer: string;
                comment: string;
                onSaveComment: (comment: string) => void;
                onGoTo: () => void;
              }[] = [];

              // Pads / Component terminals
              for (const c of p.components ?? []) {
                for (const t of c.terminals ?? []) {
                  if (t.netId === netId) {
                    list.push({
                      type: "Pad",
                      name: `${c.reference} pin ${t.number}`,
                      layer: getLayerName(c.layerId),
                      comment: t.comment ?? "",
                      onSaveComment: (val) => {
                        edit((draft) => {
                          const comp = draft.components?.find(
                            (x) => x.id === c.id,
                          );
                          const term = comp?.terminals?.find(
                            (x) => x.number === t.number,
                          );
                          if (term) term.comment = val.trim() || undefined;
                        });
                      },
                      onGoTo: () => {
                        sessionStorage.setItem(
                          "electrical-navigation",
                          JSON.stringify({ componentId: c.id }),
                        );
                        sessionStorage.setItem(
                          "visual-net-navigation",
                          JSON.stringify({
                            pcbId: p.id,
                            elementId: c.id,
                            layerId: c.layerId,
                            netId,
                          }),
                        );
                        setModalNet(null);
                        props.onNavigate();
                      },
                    });
                  }
                }
              }

              // Traces
              for (const t of p.traces ?? []) {
                if (t.netId === netId) {
                  const lengthMm = (
                    p.pxPerMm ? length(t.points) / p.pxPerMm : 0
                  ).toFixed(2);
                  const widthMm = (
                    p.pxPerMm ? t.width / p.pxPerMm : 0
                  ).toFixed(2);
                  list.push({
                    type: "Trace",
                    name: `Trace ${t.id} (${widthMm}mm, ${lengthMm}mm)`,
                    layer: getLayerName(t.layerId),
                    comment: t.comment ?? "",
                    onSaveComment: (val) => {
                      edit((draft) => {
                        const tr = draft.traces?.find((x) => x.id === t.id);
                        if (tr) tr.comment = val.trim() || undefined;
                      });
                    },
                    onGoTo: () => {
                      sessionStorage.setItem(
                        "visual-net-navigation",
                        JSON.stringify({
                          pcbId: p.id,
                          elementId: t.id,
                          layerId: t.layerId,
                          netId,
                        }),
                      );
                      setModalNet(null);
                      props.onNavigate();
                    },
                  });
                }
              }

              // Vias
              for (const v of p.vias ?? []) {
                if (v.netId === netId) {
                  list.push({
                    type: "Via",
                    name: `Via ${v.id}${v.diameter != null ? ` (Ø ${v.diameter.toFixed(2)}mm)` : ""}`,
                    layer: "All layers",
                    comment: v.comment ?? "",
                    onSaveComment: (val) => {
                      edit((draft) => {
                        const via = draft.vias?.find((x) => x.id === v.id);
                        if (via) via.comment = val.trim() || undefined;
                      });
                    },
                    onGoTo: () => {
                      sessionStorage.setItem(
                        "visual-net-navigation",
                        JSON.stringify({
                          pcbId: p.id,
                          elementId: v.id,
                          netId,
                        }),
                      );
                      setModalNet(null);
                      props.onNavigate();
                    },
                  });
                }
              }

              // Zones
              for (const z of p.zones ?? []) {
                if (z.netId === netId) {
                  list.push({
                    type: "Zone",
                    name: `Zone ${z.id} (${z.points.length} vertices)`,
                    layer: getLayerName(z.layerId),
                    comment: z.comment ?? "",
                    onSaveComment: (val) => {
                      edit((draft) => {
                        const zone = draft.zones?.find((x) => x.id === z.id);
                        if (zone) zone.comment = val.trim() || undefined;
                      });
                    },
                    onGoTo: () => {
                      sessionStorage.setItem(
                        "visual-net-navigation",
                        JSON.stringify({
                          pcbId: p.id,
                          elementId: z.id,
                          layerId: z.layerId,
                          netId,
                        }),
                      );
                      setModalNet(null);
                      props.onNavigate();
                    },
                  });
                }
              }

              return list;
            };

            return (
              <div
                class="overlay overlay--center"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setModalNet(null);
                }}
              >
                <section
                  class="palette type-manager ve-net-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label={`Elements in net ${activeNet().name}`}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setModalNet(null);
                      return;
                    }
                    if (e.key !== "Tab") return;
                    const items = Array.from(
                      e.currentTarget.querySelectorAll<HTMLElement>(
                        "input:not([disabled]),button:not([disabled]),select:not([disabled])",
                      ),
                    );
                    const first = items[0];
                    const last = items[items.length - 1];
                    if (e.shiftKey && document.activeElement === first) {
                      e.preventDefault();
                      last?.focus();
                    } else if (!e.shiftKey && document.activeElement === last) {
                      e.preventDefault();
                      first?.focus();
                    }
                  }}
                >
                  <header class="type-dialog-header">
                    <div class="ve-net-modal-title">
                      <span
                        class="ve-net-dot"
                        style={{ background: activeNet().color }}
                        aria-hidden="true"
                      />
                      <h2>Elements in net {activeNet().name}</h2>
                      <span class="ve-net-count-pill">
                        {elements().length}
                      </span>
                    </div>
                  </header>

                  <div class="type-dialog-content">
                    <Show
                      when={elements().length > 0}
                      fallback={
                        <p class="muted">No elements assigned to this net.</p>
                      }
                    >
                      <table
                        class="type-table ve-net-elements-table"
                        aria-label="Net elements table"
                      >
                        <thead>
                          <tr>
                            <th scope="col" class="col-el-type">Type</th>
                            <th scope="col" class="col-el-name">Element name</th>
                            <th scope="col" class="col-el-layer">Layer</th>
                            <th scope="col" class="col-el-comment">Comment</th>
                            <th scope="col" class="col-el-actions">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={elements()}>
                            {(el) => (
                              <tr>
                                <td class="col-el-type">
                                  <span class="ve-element-badge">
                                    {el.type}
                                  </span>
                                </td>
                                <td class="col-el-name">
                                  <button
                                    type="button"
                                    class="ve-element-goto-link"
                                    title="Click to view and highlight in Visual Editor"
                                    onClick={el.onGoTo}
                                  >
                                    {el.name}
                                  </button>
                                </td>
                                <td class="col-el-layer muted">{el.layer}</td>
                                <td class="col-el-comment">
                                  <input
                                    type="text"
                                    class="ve-element-comment"
                                    placeholder="Add comment…"
                                    aria-label={`Comment for ${el.name}`}
                                    value={el.comment}
                                    onChange={(e) =>
                                      el.onSaveComment(e.currentTarget.value)
                                    }
                                  />
                                </td>
                                <td class="col-el-actions">
                                  <button
                                    type="button"
                                    class="ve-element-action-btn"
                                    title="Inspect in Visual Editor"
                                    onClick={el.onGoTo}
                                  >
                                    Show in editor →
                                  </button>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </Show>
                  </div>

                  <footer class="type-dialog-footer">
                    <button
                      type="button"
                      class="type-close"
                      onClick={() => setModalNet(null)}
                    >
                      <ActionIcon name="Close" />
                      Close
                    </button>
                  </footer>
                </section>
              </div>
            );
          }}
        </Show>
      </Show>
    </div>
  );
}
