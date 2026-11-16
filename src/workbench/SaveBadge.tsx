// Inline save-status badge for the workspace tab row: a colored state dot
// plus the store's status message ("Unsaved changes" / "Saving…" /
// "Saved HH:MM:SS" / "Save failed: …" / "Save blocked: …"). Hidden while no
// project is open; colors come from theme tokens via data-state.

import { Show } from "solid-js";
import type { PlacementStore } from "./placement/store";

export function SaveBadge(props: { store: PlacementStore }) {
  return (
    <Show when={props.store.doc()}>
      <span
        class="tab-save-badge"
        aria-live="polite"
        title={props.store.projectPath() ?? undefined}
      >
        <span class="tab-save-dot" data-state={props.store.saveState()} aria-hidden="true" />
        {props.store.statusMessage()}
      </span>
    </Show>
  );
}
