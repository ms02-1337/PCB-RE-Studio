import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { ActionIcon } from "../ActionIcon";
import type { PlacementStore } from "../placement/store";
import { netElements, type NetElement } from "./copper";
import type { CopperNet } from "./model";
import type { CopperEditor } from "./CopperEditor";
import { NetElementsModal } from "./NetElementsModal";

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 480;

/** Collapsible nets browser docked at the bottom of the Images sidebar:
 * a "Nets (N)" button when collapsed, and when expanded a resizable section
 * with a search box and a color/name/connections table. Clicking a net opens
 * the shared elements modal; jumping to an element selects and highlights it
 * on the canvas and focuses the camera on it. Read-only — editing lives in
 * the Nets workspace tab. */
export function NetsSidebar(props: {
  store: PlacementStore;
  copper: CopperEditor;
  onFocus: (bounds: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }) => void;
}) {
  const pcb = props.store.visual.activePcb;
  const [open, setOpen] = createSignal(false);
  const [height, setHeight] = createSignal(220);
  const [search, setSearch] = createSignal("");
  const [modalNet, setModalNet] = createSignal<CopperNet | null>(null);
  let modalAnchor: HTMLElement | undefined;

  // A PCB switch invalidates the open modal's element list.
  let openPcbId: string | undefined;
  createEffect(() => {
    const id = pcb()?.id;
    if (id !== openPcbId) {
      openPcbId = id;
      setModalNet(null);
    }
  });

  const nets = () => pcb()?.nets ?? [];
  const filteredNets = () => {
    const q = search().trim().toLowerCase();
    if (!q) return nets();
    return nets().filter((n) => n.name.toLowerCase().includes(q));
  };
  /** Element lists resolved once per PCB revision; rows read them for the
   * count cell, its tooltip and the row button's title on every render. */
  const membersByNet = createMemo(() => {
    const p = pcb();
    const map = new Map<string, NetElement[]>();
    if (p) for (const net of p.nets ?? []) map.set(net.id, netElements(p, net.id));
    return map;
  });
  const connections = (netId: string) => membersByNet().get(netId) ?? [];
  const breakdown = (netId: string) => {
    const list = connections(netId);
    const count = (kind: string) => list.filter((e) => e.kind === kind).length;
    return `${count("pad")} pads · ${count("via")} vias · ${count("trace")} traces · ${count("zone")} zones`;
  };
  const closeModal = () => {
    setModalNet(null);
    queueMicrotask(() => modalAnchor?.focus());
  };
  const clamp = (value: number) =>
    Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, value));
  let drag: { pointerId: number; startY: number; startHeight: number } | null =
    null;
  const finishDrag = () => {
    drag = null;
  };

  return (
    <Show
      when={open()}
      fallback={
        <button
          type="button"
          class="ve-nets-toggle"
          aria-expanded="false"
          aria-controls="ve-nets-section"
          onClick={() => setOpen(true)}
        >
          Nets ({nets().length})
        </button>
      }
    >
      <section
        id="ve-nets-section"
        class="ve-nets-section"
        aria-label="Nets"
        style={{ height: `${height()}px` }}
      >
        <div
          class="ve-nets-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize nets section"
          tabIndex={0}
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          aria-valuenow={height()}
          aria-valuetext={`${height()} pixels for the nets section`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            drag = {
              pointerId: e.pointerId,
              startY: e.clientY,
              startHeight: height(),
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag || drag.pointerId !== e.pointerId) return;
            // The section docks at the bottom: dragging the top edge up
            // makes it taller.
            setHeight(clamp(drag.startHeight - (e.clientY - drag.startY)));
          }}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
          onKeyDown={(e) => {
            const current = height();
            const next =
              e.key === "ArrowUp"
                ? current + 16
                : e.key === "ArrowDown"
                  ? current - 16
                  : e.key === "Home"
                    ? MIN_HEIGHT
                    : e.key === "End"
                      ? MAX_HEIGHT
                      : undefined;
            if (next === undefined) return;
            e.preventDefault();
            setHeight(clamp(next));
          }}
        />
        <div class="ve-nets-section-bar">
          <h3>Nets</h3>
          <span class="ve-nets-count-pill">{nets().length}</span>
          <button
            type="button"
            class="ve-nets-collapse"
            aria-label="Collapse nets"
            aria-expanded="true"
            aria-controls="ve-nets-section"
            onClick={() => setOpen(false)}
          >
            <ActionIcon name="Chevron down" />
          </button>
        </div>
        <Show
          when={pcb()}
          fallback={<p class="ve-nets-empty-line">Open a project to browse nets.</p>}
        >
          <input
            type="search"
            class="ve-nets-section-search"
            aria-label="Filter nets"
            placeholder="Filter nets…"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <div class="ve-nets-section-table">
            <table aria-label="Nets list">
              <thead>
                <tr>
                  <th scope="col" class="col-color">Color</th>
                  <th scope="col" class="col-name">Net</th>
                  <th scope="col" class="col-count">Connections</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={filteredNets()}
                  fallback={
                    <tr>
                      <td colspan={3} class="ve-nets-empty-line">
                        {search().trim()
                          ? "No nets match your filter."
                          : "No nets defined for this PCB."}
                      </td>
                    </tr>
                  }
                >
                  {(net) => (
                    <tr>
                      <td class="col-color">
                        <span
                          class="ve-net-dot ve-nets-swatch"
                          style={{ background: net.color }}
                          aria-hidden="true"
                        />
                      </td>
                      <td class="col-name">
                        <button
                          type="button"
                          class="ve-net-title-btn"
                          aria-label={`View elements in ${net.name}`}
                          title={`View all ${connections(net.id).length} elements in ${net.name}`}
                          onClick={(e) => {
                            modalAnchor = e.currentTarget;
                            setModalNet(net);
                          }}
                        >
                          {net.name}
                        </button>
                      </td>
                      <td class="col-count" title={breakdown(net.id)}>
                        {connections(net.id).length}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>
      <Show when={modalNet()} keyed>
        {(activeNet) => (
          <NetElementsModal
            net={activeNet}
            pcb={pcb}
            elements={() => connections(activeNet.id)}
            onClose={closeModal}
            onGoTo={(el) => {
              props.copper.locate(el.id, activeNet.id, el.layerId);
              props.onFocus(el.bounds);
              closeModal();
            }}
          />
        )}
      </Show>
    </Show>
  );
}
