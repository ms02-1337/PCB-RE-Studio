import { onMount, createSignal, Show, For } from "solid-js";
import { ActionIcon } from "../ActionIcon";
import type { PlacementStore } from "../placement/store";
import { MAX_VISUAL_LAYERS } from "./model";
import { layerResizePlan } from "./copper";
import {
  MAX_COPPER_MM,
  MIN_COPPER_MM,
  loadCopperDefaults,
  saveCopperDefaults,
  type CopperDefaults,
} from "./defaults";

export function VisualSettingsModal(props: {
  store: PlacementStore;
  onClose: () => void;
  restoreFocusTo: HTMLElement | null;
  /** Live-syncs the copper editor's placement parameters when the persisted
   * defaults change (drafts already in progress keep their captured values). */
  onCopperDefaults?: (defaults: CopperDefaults) => void;
}) {
  let countInput!: HTMLInputElement;
  onMount(() => countInput.focus());
  const [pendingCount, setPendingCount] = createSignal<number | null>(null);
  const [destination, setDestination] = createSignal("");
  const [conflicts, setConflicts] = createSignal<string[]>([]);
  const [survivor, setSurvivor] = createSignal("");
  const [copperDefaults, setCopperDefaults] = createSignal(loadCopperDefaults());
  const survivors = () => {
    const layers = props.store.visual.activePcb()?.layers ?? [];
    const count = pendingCount() ?? layers.length;
    return count === 1
      ? layers.slice(0, 1)
      : [...layers.slice(0, Math.max(1, count - 1)), layers.at(-1)!];
  };
  const close = () => {
    props.onClose();
    if (props.restoreFocusTo?.isConnected) props.restoreFocusTo.focus();
  };
  /** Applies one dimension default (like the layer count: valid changes take
   * effect immediately; invalid entries revert the field). The via pair is
   * cross-validated: the diameter must stay larger than the drill. */
  const setDimension = (
    event: Event & { currentTarget: HTMLInputElement },
    key: "traceWidthMm" | "viaDiameterMm" | "viaDrillMm",
  ) => {
    const value = Number(event.currentTarget.value);
    const current = copperDefaults();
    const valid =
      Number.isFinite(value) &&
      value >= MIN_COPPER_MM &&
      value <= MAX_COPPER_MM &&
      (key !== "viaDiameterMm" || value > current.viaDrillMm) &&
      (key !== "viaDrillMm" || value < current.viaDiameterMm);
    if (!valid) {
      event.currentTarget.value = String(current[key]);
      return;
    }
    const next = { ...current, [key]: value };
    setCopperDefaults(next);
    saveCopperDefaults(next);
    props.onCopperDefaults?.(next);
  };
  const setRoute45 = (checked: boolean) => {
    const next = { ...copperDefaults(), route45: checked };
    setCopperDefaults(next);
    saveCopperDefaults(next);
    props.onCopperDefaults?.(next);
  };
  return (
    <div
      class="overlay overlay--center"
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
          <div class="ve-copper-defaults">
            <h3>Copper placement defaults</h3>
            <label>
              Default trace width (mm)
              <input
                type="number"
                min={MIN_COPPER_MM}
                max={MAX_COPPER_MM}
                step="0.1"
                value={copperDefaults().traceWidthMm}
                onChange={(event) => setDimension(event, "traceWidthMm")}
              />
            </label>
            <label>
              Default via diameter (mm)
              <input
                type="number"
                min={MIN_COPPER_MM}
                max={MAX_COPPER_MM}
                step="0.1"
                value={copperDefaults().viaDiameterMm}
                onChange={(event) => setDimension(event, "viaDiameterMm")}
              />
            </label>
            <label>
              Default via drill (mm)
              <input
                type="number"
                min={MIN_COPPER_MM}
                max={MAX_COPPER_MM}
                step="0.05"
                value={copperDefaults().viaDrillMm}
                onChange={(event) => setDimension(event, "viaDrillMm")}
              />
            </label>
            <label>
              45° routing by default
              <input
                type="checkbox"
                checked={copperDefaults().route45}
                onChange={(event) => setRoute45(event.currentTarget.checked)}
              />
            </label>
          </div>
        </div>
        <footer class="type-dialog-footer">
          <button class="type-close" onClick={close}>
            <ActionIcon name="Close" />
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
