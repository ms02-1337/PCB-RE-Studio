import { createSignal, createEffect, For, Show } from "solid-js";
import type { PlacementStore } from "../placement/store";
import type { Point } from "../placement/projectDoc";
import type { ComponentDefinition } from "../../bridge/kicad";
import type { ElectricalComponent } from "./model";
import {
  createInstance,
  drawFootprint,
  ensureSchematic,
  localPoint,
  mapReplacement,
  padContains,
  padPoint,
} from "./domain";
import { connected, mergeNets, newNet } from "../visual/copper";
import type { VisualPcb } from "../visual/model";
import { ComponentManager } from "./ComponentManager";
export function createComponentEditor(
  store: PlacementStore,
  layer: () => string,
  active: () => boolean,
  changed: () => void,
  selectLayer: (id:string)=>void = ()=>{},
) {
  const pcb = store.visual.activePcb,
    [selected, setSelected] = createSignal(""),
    [manager, setManager] = createSignal(false),
    [replacement, setReplacement] = createSignal<string[]>([]),
    [armed, setArmed] = createSignal<ComponentDefinition>(),
    [error, setError] = createSignal(""),
    [pending, setPending] = createSignal<{
      next: VisualPcb;
      old: VisualPcb;
      ids: string[];
      seeds: string[];
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
      const raw=sessionStorage.getItem("component-replace");if(raw){sessionStorage.removeItem("component-replace");try{const ids=JSON.parse(raw) as string[];if(Array.isArray(ids)){setReplacement(ids);setManager(true);}}catch{/* stale navigation */}}
      const nav=sessionStorage.getItem("electrical-navigation");if(nav){sessionStorage.removeItem("electrical-navigation");try{const request=JSON.parse(nav) as {componentId:string};setSelected(request.componentId);const c=pcb()?.components?.find(c=>c.id===request.componentId);if(c)selectLayer(c.layerId);}catch{/* stale navigation */}}
    }
    if (pending()&&pending()!.old!==pcb())setPending(null);
    if (selected() && !current()) setSelected("");
  });
  const copy = () => structuredClone(pcb()!);
  const commit = (next: VisualPcb, seeds: string[]) => {
    const old = pcb();
    if (!old || old.id !== next.id) return;
    for(const seed of seeds){const group=connected(next,[seed]);const ids=[...new Set(group.map(c=>c.netId).filter((x):x is string=>Boolean(x)))];if(ids.length>1){setPending({next,old,ids,seeds});setSurvivor(ids[0]);return;}if(ids[0])for(const c of group)c.netId=ids[0];}
    if(pcb()===old)store.visual.replacePcb(next);
  };  const update = (fn: (c: ElectricalComponent, p: VisualPcb) => void) => {
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
    if (next.schematic) {
      next.schematic.units = next.schematic.units.filter(
        (u) => u.componentId !== c.id,
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
    for (const p of before.definition.footprint.pads) {
      const a = padPoint(before, p, next.pxPerMm ?? 1),
        b = padPoint(after, p, next.pxPerMm ?? 1);
      for (const t of next.traces ?? [])
        for (const index of [0, t.points.length - 1])
          if (
            Math.hypot(t.points[index].x - a.x, t.points[index].y - a.y) < 1e-5
          )
            t.points[index] = b;
    }
  };
  return {
    selected,
    current,
    open,
    remove,
    Inspector: () => (
      <Show when={current()} keyed>
        {(c) => (
          <div class="component-inspector">
            <h3>Component</h3>
            <For each={["reference", "value", "partName"] as const}>
              {(key) => (
                <label>
                  {key}
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
            <p>Symbol: {c.definition.symbol?.name ?? "Generic – unresolved"}</p>
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
                  {key}
                  <input
                    type="number"
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
            <label>
              <input
                type="checkbox"
                checked={c.locked}
                onChange={(e) =>
                  update((v) => {
                    v.locked = e.currentTarget.checked;
                  })
                }
              />
              Lock position
            </label>
            <label>
              Board mapping link
              <select
                value={c.markingId ?? ""}
                onChange={(e) =>
                  update((v) => {
                    const mark = store
                      .doc()
                      ?.components.find((m) => m.id === e.currentTarget.value);
                    v.markingId = mark?.id;
                    if (mark) {
                      v.reference = mark.refdes;
                      v.value = mark.value ?? v.value;
                      v.partName = mark.partNumber ?? v.partName;
                    }
                  })
                }
              >
                <option value="">Independent</option>
                <For each={store.doc()?.components}>
                  {(m) => <option value={m.id}>{m.refdes}</option>}
                </For>
              </select>
            </label>
            <table>
              <thead>
                <tr>
                  <th>Pad / pin</th>
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
                            update((v) => {
                              const term = v.terminals.find(
                                (x) => x.number === t.number,
                              )!;
                              term.nc = e.currentTarget.checked;
                              if (term.nc) delete term.netId;
                            });
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <button onClick={remove}>Delete component</button>
            <Show when={error()}>
              <p role="alert">{error()}</p>
            </Show>
          </div>
        )}
      </Show>
    ),
    Manager: () => (
      <>
        <Show when={pending()} keyed>
          {(state) => (
            <div class="overlay">
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
                  <button autofocus onClick={() => setPending(null)}>
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (pcb() === state.old) {
                        mergeNets(state.next, state.ids, survivor());
                        setPending(null); commit(state.next,state.seeds); return;
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
              pcb()?.components?.find((c) => replacement().includes(c.id))
                ?.definition
            }
            onClose={() => setManager(false)}
            onPlace={(d) => {
              setArmed(d);
              setManager(false);
            }}
            onApply={
              replacement().length
                ? (d) => {
                    const next = copy();
                    for (const c of next.components ?? []) {
                      if (!replacement().includes(c.id)) continue;
                      const removed = c.terminals.filter(
                        (t) =>
                          !d.footprint.pads.some((p) => p.number === t.number),
                      );
                      if (
                        removed.some((t) => t.netId) &&
                        !confirm(`Detach removed terminals on ${c.reference}?`)
                      )
                        return;
                      Object.assign(c, mapReplacement(c, d));
                    }
                    ensureSchematic(next);
                    commit(
                      next,
                      (next.components ?? []).flatMap((c) =>
                        c.terminals.map((t) => c.id + ":" + t.number),
                      ),
                    );
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
        .find(
          (c) =>
            c.layerId === layer() &&
            c.definition.footprint.pads.some((pad) =>
              padContains(pad, localPoint(c, p, pcb()?.pxPerMm ?? 1)),
            ),
        );
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
    cancel: () => {
      drag = null;
      setArmed(undefined);
      changed();
    },
    draw: (ctx: CanvasRenderingContext2D) => {
      for (const c of pcb()?.components ?? [])
        if (
          c.layerId === layer() ||
          c.definition.footprint.pads.some((p) => p.plated && p.drill)
        )
          drawFootprint(
            ctx,
            c,
            pcb()?.pxPerMm ?? 1,
            c.id === selected() ? "#ffffff" : "#ffcd11",
          );
      if (armed() && pcb()?.pxPerMm) {
        const c = createInstance(pcb()!, armed()!, cursor, layer());
        ctx.save();
        ctx.globalAlpha = 0.5;
        drawFootprint(ctx, c, pcb()!.pxPerMm!, "#ffcd11");
        ctx.restore();
      }
    },
    key: (key: string) => {
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





