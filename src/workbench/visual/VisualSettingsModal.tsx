import { onMount } from "solid-js";
import type { PlacementStore } from "../placement/store";
import { MAX_VISUAL_LAYERS } from "./model";

export function VisualSettingsModal(props: {
  store: PlacementStore;
  onClose: () => void;
  restoreFocusTo: HTMLElement | null;
}) {
  let countInput!: HTMLInputElement;
  onMount(() => countInput.focus());
  const close = () => {
    props.onClose();
    if (props.restoreFocusTo?.isConnected) props.restoreFocusTo.focus();
  };
  return (
    <div class="overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section class="palette ve-settings-dialog" role="dialog" aria-modal="true" aria-label="Visual editor settings"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); close(); return; }
          if (event.key !== "Tab") return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input:not([disabled]),button:not([disabled])"));
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <header class="dialog-header"><h2>Visual editor settings</h2></header>
        <div class="dialog-content">
          <label class="ve-layer-count">Copper layers <input ref={countInput} type="number" min="1" max={MAX_VISUAL_LAYERS} step="1"
            value={props.store.visual.activePcb()?.layers.length ?? 2}
            onChange={(event) => {
              const pcb = props.store.visual.activePcb(), count = Number(event.currentTarget.value);
              if (!pcb || !Number.isSafeInteger(count) || count < 1 || count > MAX_VISUAL_LAYERS) {
                event.currentTarget.value = String(pcb?.layers.length ?? 2); return;
              }
              const removed = pcb.layers.slice(Math.max(1, count - 1), -1);
              if (count < pcb.layers.length && pcb.images.some((image) => image.layerId && removed.includes(image.layerId))
                && !window.confirm("Photos on removed inner layers will become Unassigned. Continue?")) {
                event.currentTarget.value = String(pcb.layers.length); return;
              }
              props.store.visual.resizeLayers(count);
            }} /></label>
        </div>
        <div class="dialog-actions"><button onClick={close}>Close</button></div>
      </section>
    </div>
  );
}
