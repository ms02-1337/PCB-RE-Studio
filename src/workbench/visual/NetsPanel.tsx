import { createSignal, For, Show } from "solid-js";
import type { PlacementStore } from "../placement/store";
import { mergeNets, newNet } from "./copper";
import type { VisualPcb } from "./model";
export function NetsPanel(props: {
  store: PlacementStore;
  onNavigate: () => void;
}) {
  const pcb = props.store.visual.activePcb;
  const [search, setSearch] = createSignal("");
  const [name, setName] = createSignal("");
  const [selected, setSelected] = createSignal("");
  const [target, setTarget] = createSignal("");
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
  return (
    <div class="ve-nets">
      <h1>PCB nets</h1>
      <Show
        when={props.store.doc()}
        fallback={<p>Open a project to manage nets.</p>}
      >
        <label>
          PCB
          <select
            value={pcb()?.id}
            onChange={(e) => {
              props.store.visual.activate(e.currentTarget.value);
              setSelected("");
            }}
          >
            <For each={props.store.visual.editor()?.pcbs}>
              {(p) => <option value={p.id}>{p.name}</option>}
            </For>
          </select>
        </label>
        <label>
          Search nets
          <input
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              name().trim() &&
              !pcb()?.nets?.some((n) => n.name === name().trim())
            ) {
              edit((p) => {
                newNet(p, name());
              });
              setName("");
            }
          }}
        >
          <label>
            New net name
            <input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </label>
          <button disabled={!name().trim()}>Create net</button>
        </form>
        <For
          each={pcb()?.nets?.filter((n) =>
            n.name.toLowerCase().includes(search().toLowerCase()),
          )}
        >
          {(net) => (
            <div class="ve-net-row">
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
              <button
                aria-pressed={selected() === net.id}
                onClick={() => setSelected(selected() === net.id ? "" : net.id)}
              >
                {net.name}
              </button>
              <span>
                {members(net.id).filter((e) => "width" in e).length} traces ·{" "}
                {members(net.id).filter((e) => !("points" in e)).length} vias ·{" "}
                {
                  members(net.id).filter(
                    (e) => "points" in e && !("width" in e),
                  ).length
                }{" "}
                zones
              </span>
              <input
                aria-label={`Rename ${net.name}`}
                value={net.name}
                onChange={(e) => {
                  const value = e.currentTarget.value.trim();
                  if (
                    value &&
                    !pcb()?.nets?.some(
                      (n) => n.id !== net.id && n.name === value,
                    )
                  )
                    edit((p) => {
                      p.nets!.find((n) => n.id === net.id)!.name = value;
                    });
                }}
              />
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete ${net.name} and unassign all its elements?`,
                    )
                  )
                    edit((p) => {
                      p.nets = p.nets?.filter((n) => n.id !== net.id);
                      for (const e of [
                        ...(p.traces ?? []),
                        ...(p.vias ?? []),
                        ...(p.zones ?? []),
                      ])
                        if (e.netId === net.id) delete e.netId;
                    });
                }}
              >
                Delete / unassign
              </button>
              <Show when={selected() === net.id}>
                <label>
                  Merge into
                  <select
                    value={target()}
                    onChange={(e) => setTarget(e.currentTarget.value)}
                  >
                    <option value="">Choose net</option>
                    <For each={pcb()?.nets?.filter((n) => n.id !== net.id)}>
                      {(n) => <option value={n.id}>{n.name}</option>}
                    </For>
                  </select>
                </label>
                <button
                  disabled={
                    !pcb()?.nets?.some(
                      (n) => n.id === target() && n.id !== net.id,
                    )
                  }
                  onClick={() => {
                    if (
                      window.confirm(
                        "Merge these nets and all member assignments?",
                      )
                    )
                      edit((p) => mergeNets(p, [net.id, target()], target()));
                  }}
                >
                  Merge
                </button>
                <For each={members(net.id)}>
                  {(e) => (
                    <button
                      onClick={() => {
                        sessionStorage.setItem(
                          "visual-net-navigation",
                          JSON.stringify({
                            pcbId: pcb()!.id,
                            elementId: e.id,
                            layerId: "points" in e ? e.layerId : undefined,
                            netId: net.id,
                          }),
                        );
                        props.onNavigate();
                      }}
                    >
                      {"width" in e ? "Trace" : "points" in e ? "Zone" : "Via"}{" "}
                      {e.id}
                    </button>
                  )}
                </For>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
