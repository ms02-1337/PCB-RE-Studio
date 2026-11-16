import { ActionIcon } from "../ActionIcon";
// "Board mapping" tab (formerly Component placement): header (add image /
// export HTML / manage types + the new-component TypeCombobox + project
// name/path + inline save status), body (vertical toolbar + canvas/
// properties split), and the board bar below the split. Project lifecycle
// actions moved to the Projects tab; the flows stay in the store so the
// command palette shares them.

import { Show, createSignal } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import { Toolbar } from "./Toolbar";
import { BoardBar } from "./BoardBar";
import { CanvasStage } from "./CanvasStage";
import { PropertiesPanel } from "./PropertiesPanel";
import { TypeManager } from "./TypeManager";
import { createPlacementStore, type PlacementStore } from "./store";

export function PlacementPanel(props: {
  store?: PlacementStore;
  onOpenProjectsTab: () => void;
}) {
  const store = props.store ?? createPlacementStore();
  const preview = () => !isTauri();
  const previewTitle = () =>
    preview() ? "Projects are available in the desktop app." : undefined;
  const [detailsOpen, setDetailsOpen] = createSignal(true);
  const [detailsWidth, setDetailsWidth] = createSignal(300);
  let split!: HTMLDivElement;
  let resizing: { x: number; width: number; splitWidth: number } | null = null;
  // splitWidth is captured once per gesture (pointerdown): reading
  // split.clientWidth here keeps the per-pointermove clamp free of forced
  // layout reads, which used to stutter the canvas beside the resizer.
  // The keyboard path keeps the default (one read per keypress is fine).
  const changeWidth = (width: number, splitWidth = split?.clientWidth || 800) => setDetailsWidth(Math.max(220, Math.min(width, Math.max(220, splitWidth - 220), 600)));
  return (
    <div class="placement-panel">
      <div class="pl-actions" role="toolbar" aria-label="Project actions">
        <button
          onClick={() => void store.addBoardFlow()}
          disabled={!store.doc()}
          title={store.doc() ? "Import an image as a new board" : previewTitle()}
        ><ActionIcon name="Add image…" />
          Add image…
        </button>
        <button
          onClick={() => void store.exportHtmlFlow()}
          disabled={preview() || !store.doc()}
          title={
            preview()
              ? previewTitle()
              : store.doc()
                ? "Export a standalone HTML report of this project"
                : previewTitle()
          }
        ><ActionIcon name="Export HTML…" />
          Export HTML…
        </button>
        <button
          onClick={() => store.setTypeManagerOpen(true)}
          disabled={!store.doc()}
          title="Manage component types"
        ><ActionIcon name="Manage types…" />
          Manage types…
        </button>
        <button disabled={!store.doc()} onClick={() => void store.requestSave()}><ActionIcon name="Save" />Save</button>
      </div>
      <Show when={store.panelError()}>
        <p class="pl-error pl-panel-error" role="alert">
          {store.panelError()}
        </p>
      </Show>
      <div class="pl-body">
        <Toolbar store={store} />
        <div class="pl-split" ref={split}>
          <CanvasStage store={store} onAddBoard={() => void store.addBoardFlow()} />
          <div class="pl-inspector" classList={{ "is-collapsed": !detailsOpen() }} style={{ width: detailsOpen() ? `${detailsWidth()}px` : "34px" }}>
            <Show when={detailsOpen()}>
              <div class="pl-inspector-resizer" role="separator" aria-label="Resize selection details" aria-orientation="vertical" tabIndex={0} aria-valuemin={220} aria-valuemax={600} aria-valuenow={detailsWidth()}
                onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); resizing = { x: event.clientX, width: detailsWidth(), splitWidth: split.clientWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={(event) => { if (resizing) changeWidth(resizing.width + resizing.x - event.clientX, resizing.splitWidth); }}
                onPointerUp={(event) => { resizing = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                onPointerCancel={() => { resizing = null; }} onLostPointerCapture={() => { resizing = null; }}
                onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); changeWidth(detailsWidth() + (event.key === "ArrowLeft" ? 20 : -20)); } }} />
            </Show>
            <div class="pl-inspector-heading">
              <Show when={detailsOpen()}><h2>Selection details</h2></Show>
              <button aria-label={detailsOpen() ? "Hide selection details" : "Show selection details"} aria-expanded={detailsOpen()} onClick={() => setDetailsOpen(!detailsOpen())}>{detailsOpen() ? "›" : "‹"}</button>
            </div>
            <div class="pl-inspector-content" hidden={!detailsOpen()}>
          <PropertiesPanel
            store={store}
            onOpenProjectsTab={props.onOpenProjectsTab}
            onAddBoard={() => void store.addBoardFlow()}
          />
            </div>
          </div>
        </div>
      </div>
      <BoardBar store={store} onAddBoard={() => void store.addBoardFlow()} />
      <Show when={store.typeManagerOpen()}>
        <TypeManager store={store} onClose={() => store.setTypeManagerOpen(false)} />
      </Show>
    </div>
  );
}
