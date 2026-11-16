import { ActionIcon } from "../ActionIcon";
// Projects tab: the project home. With a project open it shows a card with
// editable metadata (name/description via updateProjectMeta), timestamps,
// the file path, a stats line, and the lifecycle actions (all flows live in
// the store so menus can share them). Without one it offers
// New/Open plus the recent-projects list. Browser preview disables the
// dialog-backed actions honestly.

import { Show, createEffect, createSignal } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import type { PlacementStore } from "../placement/store";
import { RecentProjects } from "./RecentProjects";

const PREVIEW_TITLE = "Projects are available in the desktop app.";

/** "YYYY-MM-DD HH:MM" (local time) from an RFC3339 string; "" when unparseable. */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectsPanel(props: {
  store: PlacementStore;
  onOpenSettings: () => void;
}) {
  const store = props.store;
  const preview = () => !isTauri();
  const previewTitle = () => (preview() ? PREVIEW_TITLE : undefined);
  const [nameDraft, setNameDraft] = createSignal("");
  const [descriptionDraft, setDescriptionDraft] = createSignal("");

  // Drafts follow the document so external renames (save-as adopts the file
  // base name) and project switches re-seed the fields; commits are the only
  // writes, so typing never touches the store.
  createEffect(() => {
    setNameDraft(store.doc()?.name ?? "");
    setDescriptionDraft(store.doc()?.description ?? "");
  });

  const commitName = () => {
    const current = store.doc();
    if (!current || nameDraft() === current.name) return;
    store.updateProjectMeta({ name: nameDraft() });
    // A rejected rename (empty after trim) reverts the field.
    setNameDraft(store.doc()?.name ?? current.name);
  };

  const commitDescription = () => {
    const current = store.doc();
    if (!current || descriptionDraft() === (current.description ?? "")) return;
    store.updateProjectMeta({ description: descriptionDraft() });
    // A rejected edit (over 4000 characters) reverts the field, like the name.
    setDescriptionDraft(store.doc()?.description ?? current.description ?? "");
  };

  const assetBytes = () => Object.values(store.doc()?.assets ?? {}).reduce(
    (sum, asset) => sum + asset.size, 0,
  );

  const actionButton = (
    label: string,
    run: () => void,
    title: string,
    extra?: { class?: string },
  ) => (
    <button
      class={extra?.class}
      onClick={run}
      disabled={preview()}
      title={previewTitle() ?? title}
    >
      <ActionIcon name={label} />{label}
    </button>
  );

  return (
    <div class="projects-panel">
      <Show when={store.panelError()}>
        <p class="projects-error" role="alert">
          {store.panelError()}
        </p>
      </Show>
      <Show
        when={store.doc()}
        fallback={
          <div class="empty-state projects-empty">
            <span class="empty-mark" aria-hidden="true">
              ▧
            </span>
            <h1>Projects</h1>
            <p>No project open.</p>
            <p class="muted">
              Create or open a .pcbre project to start documenting a board.
            </p>
            <div
              class="projects-actions"
              role="toolbar"
              aria-label="Project actions"
            >
              {actionButton(
                "New project…",
                () => void store.newProjectFlow(),
                "Create a new project file",
              )}
              {actionButton(
                "Open…",
                () => void store.openProjectFlow(),
                "Open an existing .pcbre project",
              )}
              {actionButton(
                "Import project…",
                () => void store.importProjectFlow(),
                "Copy an existing .pcbre project here",
              )}
            </div>
            <RecentProjects store={store} />
          </div>
        }
      >
        <div class="projects-card">
          <div class="projects-heading"><h1>Project overview</h1><p class="muted">Project details and board documentation at a glance.</p></div>
          <dl class="project-metrics" aria-label="Project statistics">
            <div><dt>Layers</dt><dd>{store.doc()?.boards.length ?? 0}</dd></div>
            <div><dt>Components</dt><dd>{store.doc()?.components.length ?? 0}</dd></div>
            <div><dt>Assets</dt><dd>{Object.keys(store.doc()?.assets ?? {}).length}</dd></div>
            <div><dt>Asset storage</dt><dd>{formatSize(assetBytes())}</dd></div>
          </dl>
          <label>
            <span>Project name</span>
            <input
              type="text"
              value={nameDraft()}
              onInput={(event) => setNameDraft(event.currentTarget.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <label>
            <span>Description</span>
            <textarea
              rows={3}
              placeholder="What this project documents…"
              value={descriptionDraft()}
              onInput={(event) =>
                setDescriptionDraft(event.currentTarget.value)
              }
              onBlur={commitDescription}
            />
          </label>
          <div class="projects-meta">
            <p>Created {formatDateTime(store.doc()?.createdAt) || "—"}</p>
            <p>Updated {formatDateTime(store.doc()?.updatedAt) || "—"}</p>
            <p class="projects-path" title={store.projectPath() ?? undefined}>
              {store.projectPath()}
            </p>
          </div>
          <div
            class="projects-actions"
            role="toolbar"
            aria-label="Project actions"
          >
            {actionButton(
              "New project…",
              () => void store.newProjectFlow(),
              "Create a new project file",
            )}
            {actionButton(
              "Open…",
              () => void store.openProjectFlow(),
              "Open an existing .pcbre project",
            )}
            {actionButton(
              "Save as…",
              () => void store.saveAsFlow(),
              "Save the project to a new file",
            )}
            {actionButton(
              "Export copy…",
              () => void store.exportCopyFlow(),
              "Export a standalone copy of this project",
            )}
            {actionButton(
              "Delete…",
              () => void store.deleteProjectFlow(),
              "Permanently delete the project file",
              { class: "danger" },
            )}
            <button
              onClick={() => void store.closeProjectFlow()}
              disabled={!store.doc()}
              title="Close the project and clear staged assets"
            ><ActionIcon name="Close project" />
              Close project
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
