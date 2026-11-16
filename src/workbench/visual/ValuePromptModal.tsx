// Themed numeric prompt used by Calibrate ("real length in mm") and Resize
// ("real width/height in mm"). Follows the VisualSettingsModal dialog
// contract from docs/design.md: viewport-centered modal overlay, autofocuses
// the input, Enter confirms, Escape/backdrop cancels without committing,
// focus restored to the invoking element, inline rejection of
// non-numeric/non-positive input. While open it swallows Escape (the pending
// tool gesture stays alive underneath — key events never reach the canvas
// because focus is inside the dialog subtree). The optional `skipLabel`
// button calls onConfirm(0): the controller treats 0 as "skip this axis".

import { createSignal, onMount, Show } from "solid-js";

export interface ValuePromptModalProps {
  title: string;
  message: string;
  unit?: string;
  onConfirm: (value: number) => void;
  onCancel: () => void;
  restoreFocusTo: HTMLElement | null;
  /** When set, an extra button with this label calls onConfirm(0) (skip). */
  skipLabel?: string;
}

export function ValuePromptModal(props: ValuePromptModalProps) {
  let input!: HTMLInputElement;
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal("");
  onMount(() => input.focus());
  const restoreFocus = () => { if (props.restoreFocusTo?.isConnected) props.restoreFocusTo.focus(); };
  const close = () => { props.onCancel(); restoreFocus(); };
  const parse = (): number | null => {
    const parsed = Number(value().trim());
    if (!Number.isFinite(parsed) || parsed <= 0) { setError("Enter a positive number."); return null; }
    return parsed;
  };
  const confirm = () => {
    const parsed = parse();
    if (parsed === null) return;
    props.onConfirm(parsed);
    restoreFocus();
  };
  const skip = () => {
    props.onConfirm(0);
    restoreFocus();
  };
  return (
    <div class="overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section class="palette ve-value-dialog" role="dialog" aria-modal="true" aria-label={props.title}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); close(); return; }
          if (event.key !== "Tab") return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input:not([disabled]),button:not([disabled])"));
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <header class="dialog-header"><h2>{props.title}</h2></header>
        <div class="dialog-content">
          <p class="ve-value-message">{props.message}</p>
          <label class="ve-value-field">
            <span>Value{props.unit ? ` (${props.unit})` : ""}</span>
            <input ref={input} type="text" inputMode="decimal" autocomplete="off" spellcheck={false}
              aria-label={`Value${props.unit ? ` in ${props.unit}` : ""}`}
              value={value()}
              onInput={(event) => { setValue(event.currentTarget.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); confirm(); } }} />
          </label>
          <Show when={error()}><p class="ve-value-error" role="alert">{error()}</p></Show>
        </div>
        <div class="dialog-actions">
          <button onClick={close}>Cancel</button>
          <Show when={props.skipLabel}><button onClick={skip}>{props.skipLabel}</button></Show>
          <button class="ve-value-confirm" onClick={confirm}>Confirm</button>
        </div>
      </section>
    </div>
  );
}
