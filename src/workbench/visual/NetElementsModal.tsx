import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ActionIcon } from "../ActionIcon";
import { layerLabel, type CopperNet, type VisualPcb } from "./model";
import type { NetElement } from "./copper";

const kindLabels = {
  pad: "Pad",
  trace: "Trace",
  via: "Via",
  zone: "Zone",
} as const;

/** The "elements in net" review modal shared by the Nets workspace tab and
 * the visual editor's nets sidebar: one row per pad/trace/via/zone with its
 * layer, optional comment and a jump-to-element action. Focus is trapped
 * inside; Escape and the backdrop dismiss it. */
export function NetElementsModal(props: {
  net: CopperNet;
  pcb: () => VisualPcb | undefined;
  elements: () => NetElement[];
  onClose: () => void;
  onGoTo: (element: NetElement) => void;
  /** Omit in read-only contexts: the comment column becomes plain text. */
  onEditComment?: (element: NetElement, comment: string) => void;
}) {
  const layerName = (layerId?: string) => {
    const p = props.pcb();
    if (!layerId || !p?.layers) return "-";
    const idx = p.layers.indexOf(layerId);
    if (idx < 0) return layerId;
    return layerLabel(idx, p.layers.length);
  };
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  const [closeBtn, setCloseBtn] = createSignal<HTMLButtonElement | undefined>();
  onMount(() => closeBtn()?.focus());
  return (
    <div
      class="overlay overlay--center"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <section
        class="palette type-manager ve-net-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Elements in net ${props.net.name}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
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
              style={{ background: props.net.color }}
              aria-hidden="true"
            />
            <h2>Elements in net {props.net.name}</h2>
            <span class="ve-net-count-pill">{props.elements().length}</span>
          </div>
        </header>

        <div class="type-dialog-content">
          <Show
            when={props.elements().length > 0}
            fallback={<p class="muted">No elements assigned to this net.</p>}
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
                <For each={props.elements()}>
                  {(el) => (
                    <tr>
                      <td class="col-el-type">
                        <span class="ve-element-badge">
                          {kindLabels[el.kind]}
                        </span>
                      </td>
                      <td class="col-el-name">
                        <button
                          type="button"
                          class="ve-element-goto-link"
                          title="Click to view and highlight in Visual Editor"
                          onClick={() => props.onGoTo(el)}
                        >
                          {el.name}
                        </button>
                      </td>
                      <td class="col-el-layer muted">
                        {el.kind === "via" ? "All layers" : layerName(el.layerId)}
                      </td>
                      <td class="col-el-comment">
                        <Show
                          when={props.onEditComment}
                          fallback={
                            <span class="muted">{el.comment || "—"}</span>
                          }
                        >
                          {(save) => (
                            <input
                              type="text"
                              class="ve-element-comment"
                              placeholder="Add comment…"
                              aria-label={`Comment for ${el.name}`}
                              value={el.comment ?? ""}
                              onChange={(e) =>
                                save()(el, e.currentTarget.value)
                              }
                            />
                          )}
                        </Show>
                      </td>
                      <td class="col-el-actions">
                        <button
                          type="button"
                          class="ve-element-action-btn"
                          title="Inspect in Visual Editor"
                          onClick={() => props.onGoTo(el)}
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
            ref={setCloseBtn}
            onClick={props.onClose}
          >
            <ActionIcon name="Close" />
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
