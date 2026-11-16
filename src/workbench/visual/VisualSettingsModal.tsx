import { onMount, createSignal, Show, For } from "solid-js";
import type { PlacementStore } from "../placement/store";
import { MAX_VISUAL_LAYERS } from "./model";
import { layerResizePlan } from "./copper";

export function VisualSettingsModal(props: {
  store: PlacementStore;
  onClose: () => void;
  restoreFocusTo: HTMLElement | null;
}) {
  let countInput!: HTMLInputElement;
  const [pendingCount, setPendingCount] = createSignal<number | null>(null);
  const [destination, setDestination] = createSignal("");
  const [conflicts, setConflicts] = createSignal<string[]>([]);
  const [survivor, setSurvivor] = createSignal("");
  const survivors = () => {
    const layers = props.store.visual.activePcb()?.layers ?? [];
    const count = pendingCount() ?? layers.length;
    return count === 1
      ? layers.slice(0, 1)
      : [...layers.slice(0, Math.max(1, count - 1)), layers.at(-1)!];
  };
  onMount(() => countInput.focus());
  const close = () => {
    props.onClose();
    if (props.restoreFocusTo?.isConnected) props.restoreFocusTo.focus();
  };
  return (
    <div
      class="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        class="palette ve-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Visual editor settings"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "input:not([disabled]),select:not([disabled]),button:not([disabled])",
            ),
          );
          const first = items[0],
            last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header class="dialog-header">
          <h2>Visual editor settings</h2>
        </header>
        <div class="dialog-content">
          <label class="ve-layer-count">
            Copper layers{" "}
            <input
              ref={countInput}
              type="number"
              min="1"
              max={MAX_VISUAL_LAYERS}
              step="1"
              value={props.store.visual.activePcb()?.layers.length ?? 2}
              onChange={(event) => {
                setConflicts([]);
                setSurvivor("");
                setPendingCount(null);
                const pcb = props.store.visual.activePcb(),
                  count = Number(event.currentTarget.value);
                if (
                  !pcb ||
                  !Number.isSafeInteger(count) ||
                  count < 1 ||
                  count > MAX_VISUAL_LAYERS
                ) {
                  event.currentTarget.value = String(pcb?.layers.length ?? 2);
                  return;
                }
                const removed = pcb.layers.slice(Math.max(1, count - 1), -1);
                const surviving =
                  count === 1
                    ? pcb.layers.slice(0, 1)
                    : [
                        ...pcb.layers.slice(0, Math.max(1, count - 1)),
                        pcb.layers.at(-1)!,
                      ];
                if (
                  count < pcb.layers.length &&
                  [...(pcb.traces ?? []), ...(pcb.zones ?? [])].some(
                    (e) => !surviving.includes(e.layerId),
                  )
                ) {
                  setPendingCount(count);
                  setDestination(surviving[0]);
                  return;
                }
                if (
                  count < pcb.layers.length &&
                  pcb.images.some(
                    (image) => image.layerId && removed.includes(image.layerId),
                  ) &&
                  !window.confirm(
                    "Photos on removed inner layers will become Unassigned. Continue?",
                  )
                ) {
                  event.currentTarget.value = String(pcb.layers.length);
                  return;
                }
                props.store.visual.resizeLayers(count);
              }}
            />
          </label>
          <Show when={pendingCount() !== null}>
            <p>Choose a destination for copper on removed layers.</p>
            <label>
              Destination layer
              <select
                value={destination()}
                onChange={(e) => {
                  setDestination(e.currentTarget.value);
                  setConflicts([]);
                }}
              >
                <For each={survivors()}>
                  {(id) => <option value={id}>{id}</option>}
                </For>
              </select>
            </label>
            <Show when={conflicts().length}>
              <p>
                Reassignment joins these nets. Choose the surviving net or
                cancel.
              </p>
              <label>
                Surviving net
                <select
                  value={survivor()}
                  onChange={(e) => setSurvivor(e.currentTarget.value)}
                >
                  <For
                    each={props.store.visual
                      .activePcb()
                      ?.nets?.filter((n) => conflicts().includes(n.id))}
                  >
                    {(n) => <option value={n.id}>{n.name}</option>}
                  </For>
                </select>
              </label>
            </Show>
            <button
              onClick={() => {
                const pcb = props.store.visual.activePcb();
                if (!pcb) return;
                const plan = layerResizePlan(
                  pcb,
                  pendingCount()!,
                  destination(),
                );
                if (!plan) return;
                if (plan.conflicts.length && !conflicts().length) {
                  setConflicts(plan.conflicts);
                  setSurvivor(plan.conflicts[0]);
                  return;
                }
                props.store.visual.resizeLayers(
                  pendingCount()!,
                  destination(),
                  survivor(),
                );
                setPendingCount(null);
                setConflicts([]);
              }}
            >
              Apply layer reassignment
            </button>
            <button
              onClick={() => {
                setPendingCount(null);
                setConflicts([]);
                countInput.value = String(
                  props.store.visual.activePcb()?.layers.length,
                );
              }}
            >
              Cancel reassignment
            </button>
          </Show>
        </div>
        <div class="dialog-actions">
          <button onClick={close}>Close</button>
        </div>
      </section>
    </div>
  );
}
