import { electricalMembers } from "./actions";
import { createSignal, createEffect, For, Show } from "solid-js";
import type { PlacementStore } from "../placement/store";
import type { Point } from "../placement/projectDoc";
import type { ComponentDefinition } from "../../bridge/kicad";
import type { ElectricalComponent } from "./model";
import {
  createInstance,
  drawFootprint,
  ensureSchematic,
  componentContains,
  replacementBoards,
  padPoint,
} from "./domain";
import { mergeNets, newNet, ncContacts } from "../visual/copper";
import type { VisualPcb } from "../visual/model";
import { ComponentManager } from "./ComponentManager";
import { ActionIcon } from "../ActionIcon";
export function createComponentEditor(
  store: PlacementStore,
  layer: () => string,
  active: () => boolean,
  changed: () => void,
  selectLayer: (id: string) => void = () => {},
) {
  const pcb = store.visual.activePcb,
    [selected, setSelected] = createSignal(""),
    [manager, setManager] = createSignal(false),
    [replacement, setReplacement] = createSignal<string[]>([]),
    [armed, setArmed] = createSignal<ComponentDefinition>(),
    [placementGeneration, setPlacementGeneration] = createSignal(0),
    [placementRotation, setPlacementRotation] = createSignal(0),
    [error, setError] = createSignal(""),
    [pending, setPending] = createSignal<{
      next: VisualPcb;
      old: VisualPcb;
      ids: string[];
      seeds: string[];
      resume?: () => void;
    } | null>(null),
    [survivor, setSurvivor] = createSignal("");
  let cursor: Point = { x: 0, y: 0 },
    drag: { id: string; start: Point; origin: VisualPcb } | null = null,
    session = "";
  const current = () => pcb()?.components?.find((c) => c.id === selected());
  createEffect(() => {
    const key = store.projectSession() + ":" + pcb()?.id;
    if (key !== session) {
      session = key;
      setSelected("");
      setArmed(undefined);
      setManager(false);
      drag = null;
    }
    if (!active()) {
      setArmed(undefined);
      drag = null;
      setPending(null);
    }
    if (active()) {
      const raw = sessionStorage.getItem("component-replace");
      if (raw) {
        sessionStorage.removeItem("component-replace");
        try {
          const ids = JSON.parse(raw) as string[];
          if (Array.isArray(ids)) {
            setReplacement(ids);
            setManager(true);
          }
        } catch {
          /* stale navigation */
        }
      }
      const nav = sessionStorage.getItem("electrical-navigation");
      if (nav) {
        sessionStorage.removeItem("electrical-navigation");
        try {
          const request = JSON.parse(nav) as { componentId: string };
          setSelected(request.componentId);
          const c = pcb()?.components?.find(
            (c) => c.id === request.componentId,
          );
          if (c) selectLayer(c.layerId);
        } catch {
          /* stale navigation */
        }
      }
    }
    if (pending() && pending()!.old !== pcb()) setPending(null);
    if (selected() && !current()) setSelected("");
  });
  const copy = () => structuredClone(pcb()!);
  const validBoards = (values: VisualPcb[]) => {
    const all = (store.visual.editor()?.pcbs ?? []).map(
        (p) => values.find((v) => v.id === p.id) ?? p,
      ),
      marks = new Set<string>();
    for (const p of all) {
      const refs = new Set<string>();
      for (const c of p.components ?? []) {
        if (values.includes(p)) c.reference = c.reference.trim();
        const ref = c.reference.toLowerCase();
        if (!ref || c.reference.length > 200 || refs.has(ref)) {
          setError(
            "References must be nonempty and unique (case insensitive) within a PCB.",
          );
          return false;
        }
        refs.add(ref);
        if (c.markingId) {
          if (
            marks.has(c.markingId) ||
            !store.doc()?.components.some((m) => m.id === c.markingId)
          ) {
            setError(
              "A marking can be linked to only one electrical component.",
            );
            return false;
          }
          marks.add(c.markingId);
        }
        if (values.includes(p))
          c.definition.pinMap = Object.fromEntries(
            Object.entries(c.definition.pinMap).filter(([, v]) => Boolean(v)),
          );
        const pins = new Set(
          c.definition.symbol?.units.flatMap((u) =>
            u.pins.map((p) => p.number),
          ),
        );
        if (
          c.definition.footprint.diagnostics.length ||
          c.definition.symbol?.diagnostics.length ||
          (c.definition.symbol &&
            Object.entries(c.definition.pinMap).some(
              ([key, value]) =>
                !c.terminals.some((t) => t.number === key) || !pins.has(value),
            ))
        ) {
          setError(
            "Resolve unsupported geometry and invalid pin mappings before applying.",
          );
          return false;
        }
      }
    }
    return true;
  };
  const confirmNc = (next: VisualPcb, old: VisualPcb) => {
    const geo = (p: VisualPcb) =>
      JSON.stringify(
        p.components?.map((c) => [
          c.id,
          c.x,
          c.y,
          c.rotation,
          c.scale,
          c.layerId,
          c.definition.footprint,
        ]),
      );
    if (geo(next) === geo(old)) return true;
    const prior = new Set(ncContacts(old)),
      conflicts = ncContacts(next).filter((id) => !prior.has(id));
    if (!conflicts.length) return true;
    if (
      !confirm(
        `This edit contacts ${conflicts.length} NC terminal(s). Clear NC and connect?`,
      )
    )
      return false;
    for (const c of next.components ?? [])
      for (const t of c.terminals)
        if (conflicts.includes(c.id + ":" + t.number)) t.nc = false;
    return true;
  };
  const commit = (next: VisualPcb, seeds: string[]) => {
    const old = pcb();
    if (!old || old.id !== next.id) return;
    if (!validBoards([next])) return;
    if (!confirmNc(next, old)) return;
    for (const seed of seeds) {
      const group = electricalMembers(next, [seed]);
      const ids = [
        ...new Set(
          group.map((c) => c.netId).filter((x): x is string => Boolean(x)),
        ),
      ];
      if (ids.length > 1) {
        setPending({ next, old, ids, seeds });
        setSurvivor(ids[0]);
        return;
      }
      if (ids[0]) for (const c of group) c.netId = ids[0];
    }
    if (pcb() === old) store.visual.replacePcb(next);
  };
  const applyBatch = (values: VisualPcb[], origin = store.doc()) => {
    if (store.doc() !== origin || !validBoards(values)) return;
    for (const next of values) {
      const old = store.visual.editor()?.pcbs.find((p) => p.id === next.id);
      if (old && !confirmNc(next, old)) return;
      for (const c of next.components ?? [])
        for (const t of c.terminals) {
          const group = electricalMembers(next, [c.id + ":" + t.number]),
            ids = [
              ...new Set(
                group
                  .map((c) => c.netId)
                  .filter((n): n is string => Boolean(n)),
              ),
            ];
          if (ids.length > 1) {
            setPending({
              next,
              old: pcb()!,
              ids,
              seeds: [],
              resume: () => applyBatch(values, origin),
            });
            setSurvivor(ids[0]);
            return;
          }
          if (ids[0]) for (const g of group) g.netId = ids[0];
        }
    }
    store.visual.replacePcbs(values);
  };
  const update = (fn: (c: ElectricalComponent, p: VisualPcb) => void) => {
    const next = copy(),
      c = next.components?.find((c) => c.id === selected());
    if (!c) return;
    fn(c, next);
    commit(
      next,
      c.terminals.map((t) => c.id + ":" + t.number),
    );
  };
  const open = (ids: string[] = []) => {
    setReplacement(ids);
    setManager(true);
    setArmed(undefined);
  };
  const remove = () => {
    const c = current();
    if (!c) return;
    const next = copy();
    next.components = next.components?.filter((x) => x.id !== c.id);
    for (const t of next.traces ?? [])
      for (const key of ["startPad", "endPad"] as const)
        if (t[key]?.componentId === c.id) delete t[key];
    if (next.schematic) {
      next.schematic.units = next.schematic.units.filter(
        (u) => u.componentId !== c.id,
      );
      next.schematic.labels = next.schematic.labels.filter(
        (l) => l.anchor?.componentId !== c.id,
      );
      next.schematic.wires = next.schematic.wires.filter(
        (w) => w.start?.componentId !== c.id && w.end?.componentId !== c.id,
      );
    }
    store.visual.replacePcb(next);
    setSelected("");
  };
  const moveAttached = (
    before: ElectricalComponent,
    after: ElectricalComponent,
    next: VisualPcb,
  ) => {
    for (const t of next.traces ?? []) {
      for (const [key, index] of [
        ["startPad", 0],
        ["endPad", t.points.length - 1],
      ] as const) {
        const anchor = t[key];
        if (anchor?.componentId !== before.id) continue;
        const pad = after.definition.footprint.pads.find(
          (p) => p.number === anchor.terminal,
        );
        if (pad) t.points[index] = padPoint(after, pad, next.pxPerMm ?? 1);
        else delete t[key];
      }
    }
  };
  const arm = (d: ComponentDefinition) => {
    if (!pcb()?.pxPerMm) {
      setError("Calibrate the PCB before placement.");
      return;
    }
    setError("");
    setArmed(structuredClone(d));
    setPlacementRotation(0);
    setPlacementGeneration(n => n + 1);
    changed();
  };
  return {
    arm,
    placementGeneration,
    placementActive: () => Boolean(armed()),
    selected,
    setSelected: (id: string) => setSelected(id),
    hit: (p: Point) =>
      [...(pcb()?.components ?? [])]
        .reverse()
        .find((c) => componentContains(c, p, pcb()?.pxPerMm ?? 1, layer())),
    current,
    open,
    remove,
    Inspector: () => {
      const BoardMappingSelector = (props: {
        value: () => string | undefined;
        onChange: (id: string | undefined) => void;
      }) => {
        const [open, setOpen] = createSignal(false);
        const [filter, setFilter] = createSignal("");
        const markings = () => store.doc()?.components ?? [];
        const currentMarking = () =>
          markings().find((m) => m.id === props.value());
        const filteredMarkings = () => {
          const q = filter().trim().toLowerCase();
          if (!q) return markings();
          return markings().filter(
            (m) =>
              m.refdes.toLowerCase().includes(q) ||
              (m.partNumber && m.partNumber.toLowerCase().includes(q)) ||
              (m.value && m.value.toLowerCase().includes(q)),
          );
        };

        const handleSelect = (id: string | undefined) => {
          props.onChange(id);
          setOpen(false);
          setFilter("");
        };

        return (
          <div class="ve-net-selector">
            <div class="ve-net-selector-header">
              <span>Board mapping link</span>
              <span class="ve-net-current-badge">
                <Show
                  when={currentMarking()}
                  fallback={<span class="muted">Independent</span>}
                >
                  {(m) => <span>{m().refdes}</span>}
                </Show>
              </span>
            </div>
            <div class="ve-net-input-bar">
              <input
                type="text"
                role="combobox"
                aria-label="Board mapping link"
                aria-expanded={open()}
                aria-autocomplete="list"
                placeholder={
                  currentMarking() ? currentMarking()!.refdes : "Link component…"
                }
                value={open() ? filter() : (currentMarking()?.refdes ?? "")}
                onClick={() => {
                  if (!open()) {
                    setOpen(true);
                    setFilter("");
                  }
                }}
                onFocus={() => {
                  if (!open()) {
                    setOpen(true);
                    setFilter("");
                  }
                }}
                onInput={(e) => {
                  setFilter(e.currentTarget.value);
                  if (!open()) setOpen(true);
                }}
                onChange={(e) => {
                  const val = e.currentTarget.value.trim();
                  if (!val || val.toLowerCase() === "independent") {
                    handleSelect(undefined);
                    return;
                  }
                  const match = markings().find(
                    (m) =>
                      m.id === val ||
                      m.refdes.toLowerCase() === val.toLowerCase(),
                  );
                  if (match) {
                    handleSelect(match.id);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const val = filter().trim();
                    if (!val || val.toLowerCase() === "independent") {
                      handleSelect(undefined);
                      return;
                    }
                    const match =
                      filteredMarkings()[0] ??
                      markings().find(
                        (m) =>
                          m.id === val ||
                          m.refdes.toLowerCase() === val.toLowerCase(),
                      );
                    if (match) {
                      handleSelect(match.id);
                    }
                  } else if (e.key === "Escape") {
                    setOpen(false);
                    setFilter("");
                  }
                }}
                onBlur={() => {
                  window.setTimeout(() => {
                    if (open()) {
                      setOpen(false);
                      setFilter("");
                    }
                  }, 150);
                }}
              />
            </div>
            <Show when={open()}>
              <div
                class="ve-net-dropdown"
                role="listbox"
                aria-label="Board mapping components list"
              >
                <button
                  type="button"
                  class="ve-net-item"
                  data-selected={!props.value()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(undefined)}
                >
                  <span class="ve-net-item-name">Independent</span>
                  <Show when={!props.value()}>
                    <span class="ve-net-check">✓</span>
                  </Show>
                </button>
                <For each={filteredMarkings()}>
                  {(m) => (
                    <button
                      type="button"
                      class="ve-net-item"
                      data-selected={m.id === props.value()}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleSelect(m.id)}
                    >
                      <span class="ve-net-item-name">
                        {m.refdes}
                        {m.partNumber
                          ? ` (${m.partNumber})`
                          : m.value
                            ? ` (${m.value})`
                            : ""}
                      </span>
                      <Show when={m.id === props.value()}>
                        <span class="ve-net-check">✓</span>
                      </Show>
                    </button>
                  )}
                </For>
                <Show when={filteredMarkings().length === 0 && filter().trim()}>
                  <div class="ve-net-empty">No matching components</div>
                </Show>
              </div>
            </Show>
          </div>
        );
      };

      const fieldLabels = {
        reference: "Reference",
        value: "Value",
        partName: "Part Name",
      } as const;

      const numericLabels = {
        rotation: "Rotation (°)",
        scale: "Scale",
      } as const;

      return (
        <Show when={current()} keyed>
          {(c) => (
            <div class="component-inspector">
              <h3>Component</h3>
              <For each={["reference", "value", "partName"] as const}>
                {(key) => (
                  <label>
                    {fieldLabels[key]}
                    <input
                      aria-label={`Component ${key}`}
                      value={c[key]}
                      onChange={(e) =>
                        update((v) => {
                          if (
                            key === "reference" &&
                            pcb()?.components?.some(
                              (x) =>
                                x.id !== v.id &&
                                x.reference === e.currentTarget.value,
                            )
                          ) {
                            setError("Reference already exists.");
                            return;
                          }
                          v[key] = e.currentTarget.value;
                        })
                      }
                    />
                  </label>
                )}
              </For>
              <p>Footprint: {c.definition.footprint.name}</p>
              <p>Symbol: {c.definition.symbol?.name ?? "Generic - unresolved"}</p>
              <button onClick={() => open([c.id])}>
                Change footprint / symbol
              </button>
              <label>
                Layer
                <select
                  value={c.layerId}
                  onChange={(e) =>
                    update((v) => {
                      v.layerId = e.currentTarget.value;
                    })
                  }
                >
                  <For each={pcb()?.layers}>{(id) => <option>{id}</option>}</For>
                </select>
              </label>
              <For each={["rotation", "scale"] as const}>
                {(key) => (
                  <label>
                    {numericLabels[key]}
                    <input
                      type="number"
                      step="0.1"
                      aria-label={`Component ${key}`}
                      value={c[key]}
                      min={key === "scale" ? 0.001 : undefined}
                      onChange={(e) => {
                        const n = +e.currentTarget.value;
                        if (!Number.isFinite(n) || (key === "scale" && n <= 0))
                          return;
                        update((v, next) => {
                          const old = structuredClone(v);
                          v[key] =
                            key === "rotation" ? ((n % 360) + 360) % 360 : n;
                          moveAttached(old, v, next);
                        });
                      }}
                    />
                  </label>
                )}
              </For>
              <BoardMappingSelector
                value={() => c.markingId}
                onChange={(markingId) =>
                  update((v) => {
                    const mark = store
                      .doc()
                      ?.components.find((m) => m.id === markingId);
                    v.markingId = mark?.id;
                    if (mark) {
                      v.reference = mark.refdes;
                      v.value = mark.value ?? v.value;
                      v.partName = mark.partNumber ?? v.partName;
                    }
                  })
                }
              />
              <table>
                <thead>
                  <tr>
                    <th>Pad / Pin</th>
                    <th>Net</th>
                    <th>NC</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={c.terminals}>
                    {(t) => (
                      <tr>
                        <td>
                          {t.number} /{" "}
                          {c.definition.pinMap[t.number] ?? "Unmapped"}
                        </td>
                        <td>
                          <select
                            aria-label={`Net for ${c.reference} pad ${t.number}`}
                            value={t.netId ?? ""}
                            onChange={(e) => {
                              const value = e.currentTarget.value;
                              if (t.nc && !confirm("Clear NC and assign net?"))
                                return;
                              update((v, next) => {
                                const term = v.terminals.find(
                                  (x) => x.number === t.number,
                                )!;
                                term.nc = false;
                                term.netId =
                                  value === "new"
                                    ? newNet(next).id
                                    : value || undefined;
                              });
                            }}
                          >
                            <option value="">Unassigned</option>
                            <option value="new">Create net</option>
                            <For each={pcb()?.nets}>
                              {(n) => <option value={n.id}>{n.name}</option>}
                            </For>
                          </select>
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`NC ${c.reference} pad ${t.number}`}
                            checked={t.nc}
                            onChange={(e) => {
                              if (
                                e.currentTarget.checked &&
                                t.netId &&
                                !confirm("Detach net and mark pin NC?")
                              )
                                return;
                              update((v, next) => {
                                const term = v.terminals.find(
                                  (x) => x.number === t.number,
                                )!;
                                term.nc = e.currentTarget.checked;
                                if (term.nc) {
                                  delete term.netId;
                                  for (const w of next.schematic?.wires ?? []) {
                                    if (
                                      w.start?.componentId === v.id &&
                                      w.start.terminal === term.number
                                    )
                                      delete w.start;
                                    if (
                                      w.end?.componentId === v.id &&
                                      w.end.terminal === term.number
                                    )
                                      delete w.end;
                                    w.connections = w.connections?.filter(
                                      (a) =>
                                        a.componentId !== v.id ||
                                        a.terminal !== term.number,
                                    );
                                  }
                                  for (const l of next.schematic?.labels ?? [])
                                    if (
                                      l.anchor?.componentId === v.id &&
                                      l.anchor.terminal === term.number
                                    )
                                      delete l.anchor;
                                }
                              });
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <div class="component-inspector-actions">
                <button
                  type="button"
                  class="component-nav-btn"
                  onClick={() => {
                    sessionStorage.setItem(
                      "electrical-schematic-navigation",
                      JSON.stringify({ componentId: c.id }),
                    );
                    window.dispatchEvent(
                      new CustomEvent("electrical-navigate", {
                        detail: { tab: 3 },
                      }),
                    );
                  }}
                >
                  Show in schematic
                </button>
                <button
                  type="button"
                  class="component-lock-btn"
                  aria-pressed={c.locked ? "true" : "false"}
                  title={c.locked ? "Unlock component" : "Lock component"}
                  onClick={() =>
                    update((v) => {
                      v.locked = !v.locked;
                    })
                  }
                >
                  <ActionIcon name="Lock" />{c.locked ? "Locked" : "Lock"}
                </button>
                <button
                  type="button"
                  class="component-action-icon-btn danger"
                  disabled={c.locked}
                  aria-label="Delete component"
                  title={c.locked ? "Component is locked" : "Delete component"}
                  onClick={remove}
                >
                  <ActionIcon name="Delete" />
                </button>
              </div>
            </div>
          )}
        </Show>
      );
    },
    Manager: () => (
      <>
        <Show when={error()}><p role="alert">{error()}</p></Show>
        <Show when={pending()} keyed>
          {(state) => (
            <div class="overlay overlay--center">
              <section
                class="palette ve-value-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Join component nets"
              >
                <header class="dialog-header">
                  <h2>Join component nets</h2>
                </header>
                <div class="dialog-content">
                  <p>
                    This edit joins assigned nets. Select the net to retain.
                  </p>
                  <select
                    aria-label="Surviving net"
                    value={survivor()}
                    onChange={(e) => setSurvivor(e.currentTarget.value)}
                  >
                    <For each={state.ids}>
                      {(id) => (
                        <option value={id}>
                          {state.next.nets?.find((n) => n.id === id)?.name}
                        </option>
                      )}
                    </For>
                  </select>
                </div>
                <footer class="dialog-actions">
                  <button onClick={() => setPending(null)}>
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (pcb() === state.old) {
                        mergeNets(state.next, state.ids, survivor());
                        setPending(null);
                        if (state.resume) state.resume();
                        else commit(state.next, state.seeds);
                        return;
                      }
                      setPending(null);
                    }}
                  >
                    Merge and apply
                  </button>
                </footer>
              </section>
            </div>
          )}
        </Show>
        <Show when={manager()}>
          <ComponentManager
            initial={
              store.visual
                .editor()
                ?.pcbs.flatMap((p) => p.components ?? [])
                .find((c) => replacement().includes(c.id))?.definition
            }
            onClose={() => setManager(false)}
            placementUnavailableReason={!pcb()?.pxPerMm ? "Calibrate the PCB in the Visual Editor before placing a footprint." : undefined}
            onPlace={(d) => {
              if (!pcb()?.pxPerMm) return;
              setManager(false);
              arm(d);
            }}
            isInUse={(d) => {
              const pcbs = store.visual.editor()?.pcbs ?? [];
              return pcbs.some((p) =>
                (p.components ?? []).some(
                  (c) => c.definition.id === d.id || c.definition.name === d.name,
                ),
              );
            }}
            onApply={
              replacement().length
                ? (d) => {
                    const result = replacementBoards(
                      store.visual.editor()?.pcbs ?? [],
                      replacement(),
                      d,
                    );
                    if (
                      result.detached.length &&
                      !confirm(
                        `Detach removed connected terminals: ${result.detached.join(", ")}?`,
                      )
                    )
                      return;
                    applyBatch(result.boards);
                    setManager(false);
                  }
                : undefined
            }
          />
        </Show>
      </>
    ),
    down: (p: Point) => {
      if (!active()) return false;
      if (armed()) {
        if (!pcb()?.pxPerMm) {
          setError("Calibrate the PCB before placement.");
          return true;
        }
        const next = copy(),
          c = createInstance(next, armed()!, p, layer());
        c.rotation = placementRotation();
        (next.components ??= []).push(c);
        ensureSchematic(next);
        commit(
          next,
          c.terminals.map((t) => c.id + ":" + t.number),
        );
        setSelected(c.id);
        return true;
      }
      const c = [...(pcb()?.components ?? [])]
        .reverse()
        .find((c) => componentContains(c, p, pcb()?.pxPerMm ?? 1, layer()));
      if (!c) {
        setSelected("");
        return false;
      }
      setSelected(c.id);
      if (!c.locked) drag = { id: c.id, start: p, origin: pcb()! };
      return true;
    },
    move: (p: Point) => {
      cursor = p;
      changed();
    },
    up: (p: Point) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (pcb() !== d.origin) return;
      const next = copy(),
        c = next.components?.find((c) => c.id === d.id);
      if (!c) return;
      const before = structuredClone(c);
      c.x += p.x - d.start.x;
      c.y += p.y - d.start.y;
      moveAttached(before, c, next);
      commit(
        next,
        c.terminals.map((t) => c.id + ":" + t.number),
      );
    },
    cancelDrag: () => {
      drag = null;
      changed();
    },
    cancel: () => {
      drag = null;
      setArmed(undefined);
      changed();
    },
    draw: (
      ctx: CanvasRenderingContext2D,
      offset?: { ids: Set<string>; dx: number; dy: number },
      selectedIds?: Set<string>,
    ) => {
      for (const c of pcb()?.components ?? [])
        if (
          c.layerId === layer() ||
          c.definition.footprint.pads.some((p) => p.plated && p.drill)
        ) {
          const isMoved = Boolean(offset?.ids.has(c.id));
          const shiftX = isMoved && offset ? offset.dx : 0;
          const shiftY = isMoved && offset ? offset.dy : 0;
          const isSel = c.id === selected() || Boolean(selectedIds?.has(c.id));
          drawFootprint(
            ctx,
            drag?.id === c.id
              ? {
                  ...c,
                  x: c.x + cursor.x - drag.start.x,
                  y: c.y + cursor.y - drag.start.y,
                }
              : isMoved
              ? { ...c, x: c.x + shiftX, y: c.y + shiftY }
              : c,
            pcb()?.pxPerMm ?? 1,
            isSel ? "#ffffff" : "#ffcd11",
          );
        }
      if (armed() && pcb()?.pxPerMm) {
        const c = createInstance(pcb()!, armed()!, cursor, layer());
        c.rotation = placementRotation();
        ctx.save();
        ctx.globalAlpha = 0.5;
        drawFootprint(ctx, c, pcb()!.pxPerMm!, "#ffcd11");
        ctx.restore();
      }
    },
    key: (key: string) => {
      if (key.toLowerCase() === "r" && armed()) {
        setPlacementRotation((n) => (n + 90) % 360);
        changed();
        return true;
      }
      if (key === "Escape") {
        drag = null;
        setArmed(undefined);
        setSelected("");
        return false;
      }
      if (key === "Delete" && current()) {
        remove();
        return true;
      }
      return false;
    },
  };
}
