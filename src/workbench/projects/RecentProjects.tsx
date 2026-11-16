// Recent-projects list for the Projects tab: click an entry to open it (the
// store's openRecentFlow flush-saves unsaved work), × to forget an entry.
// The list reloads whenever the store's project identity changes, because
// open/new/save-as record entries and delete removes one.

import { For, Show, createEffect, createSignal } from "solid-js";
import type { PlacementStore } from "../placement/store";
import { ActionIcon } from "../ActionIcon";
import { formatRecentAt, loadRecent, removeRecent, type RecentProject } from "./recent";

export function RecentProjects(props: { store: PlacementStore }) {
  const [entries, setEntries] = createSignal<RecentProject[]>(loadRecent());
  const refresh = () => setEntries(loadRecent());

  createEffect(() => {
    void props.store.doc();
    void props.store.projectPath();
    refresh();
  });

  return (
    <section class="recent-projects" aria-label="Recent projects">
      <h2>Recent</h2>
      <Show
        when={entries().length > 0}
        fallback={<p class="muted recent-empty">No recent projects yet.</p>}
      >
        <ul class="recent-list">
          <For each={entries()}>
            {(entry) => (
              <li class="recent-item">
                <button
                  class="recent-open"
                  title={entry.path}
                  onClick={() => void props.store.openRecentFlow(entry.path)}
                >
                  <span class="recent-name"><ActionIcon name="Open" />{entry.name}</span>
                  <span class="recent-path">{entry.path}</span>
                </button>
                <span class="recent-at">{formatRecentAt(entry.at)}</span>
                <button
                  class="recent-remove"
                  aria-label={`Remove ${entry.name} from recent projects`}
                  title="Remove from recent projects"
                  onClick={() => {
                    removeRecent(entry.path);
                    refresh();
                  }}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
