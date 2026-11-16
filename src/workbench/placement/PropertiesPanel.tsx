import { ComponentPhoto } from "./ComponentPhoto";
import { ActionIcon } from "../ActionIcon";
// Right-side properties panel (tab-local; the shell Inspector is untouched).
// Selection priority: component > board picture > generic info. The board
// picture state exposes the board transform controls (rotate/flip/scale/lock
// and the pending crop).

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { Component } from "./projectDoc";
import type { PlacementStore } from "./store";
import { TypeCombobox } from "./TypeCombobox";
import { displaySize } from "./boardTransform";
import { assetExport, assetImport, assetImportClipboardImage } from "../../bridge/project";
import { isTauri } from "@tauri-apps/api/core";
import { pickDatasheetImport, pickExportPath, pickImageImport } from "../../bridge/dialog";

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function PropertiesPanel(props: {
  store: PlacementStore;
  onOpenProjectsTab: () => void;
  onAddBoard: () => void;
}) {
  const store = props.store;
  const [error, setError] = createSignal("");
  const [imageBusy, setImageBusy] = createSignal(false);
  let panelElement!: HTMLElement;
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const component = () => store.selectedComponent();
  const board = () => store.activeBoard();
  const preview = () => !isTauri();
  const duplicates = () => store.duplicateRefdesSet();

  const attachImage = async (clipboard: boolean) => {
    const target = component();
    if (!target || target.locked || imageBusy() || preview()) return;
    const id = target.id;
    const session = store.projectSession();
    const path = store.projectPath();
    const valid = () => !disposed && session === store.projectSession() && path === store.projectPath();
    setImageBusy(true);
    setError("");
    try {
      const source = clipboard ? null : await pickImageImport();
      if (!valid() || (!clipboard && !source)) return;
      const info = clipboard ? await assetImportClipboardImage() : await assetImport(source!);
      if (!valid()) return;
      const current = store.doc()?.components.find((item) => item.id === id);
      if (!current || current.locked) return;
      store.registerAsset(info);
      const images = current.imageHashes ?? (current.imageHash ? [current.imageHash] : []);
      store.updateComponent(id, { imageHash: undefined, imageHashes: [...new Set([...images, info.hash])] });
    } catch (failure) {
      if (valid()) setError(failure instanceof Error ? failure.message : "The image could not be attached.");
    } finally {
      if (!disposed) setImageBusy(false);
    }
  };

  onMount(() => {
    const paste = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "v") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog'], dialog")) return;
      if (panelElement.closest("[hidden], [inert]") || store.typeManagerOpen() || document.querySelector("[role='dialog'], dialog[open]")) return;
      if (preview() || !component() || component()!.locked || imageBusy()) return;
      event.preventDefault();
      void attachImage(true);
    };
    document.addEventListener("keydown", paste);
    onCleanup(() => document.removeEventListener("keydown", paste));
  });

  const text = (key: "partNumber" | "value" | "marking" | "pkg" | "manufacturer" | "notes" | "description" | "datasheetUrl") => ({
    value: component()?.[key] ?? "",
    onInput: (event: InputEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      const id = component()?.id;
      if (id) store.updateComponent(id, { [key]: event.currentTarget.value } as never);
    },
  });

  /** Copies a field to the clipboard, re-reading the document at click time
   * so the committed value (never a stale closure) is copied. Copying stays
   * available while the component is locked; failures surface via the alert. */
  const copyField = async (key: "partNumber" | "value" | "datasheetUrl" | "description" | "notes", label: string) => {
    const id = component()?.id;
    const value = (id ? store.doc()?.components.find((item) => item.id === id)?.[key] : undefined) ?? "";
    setError("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
    } catch {
      setError(`The ${label.toLowerCase()} could not be copied to the clipboard.`);
    }
  };

  const attachDatasheet = async () => {
    const id = component()?.id;
    if (!id) return;
    setError("");
    try {
      const path = await pickDatasheetImport();
      if (!path) return;
      const info = await assetImport(path);
      store.registerAsset(info);
      store.updateComponent(id, { datasheetHash: info.hash });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The datasheet could not be attached.");
    }
  };

  const exportDatasheet = async () => {
    const current = component();
    if (!current?.datasheetHash) return;
    setError("");
    try {
      const asset = store.doc()?.assets[current.datasheetHash];
      const dest = await pickExportPath(asset?.name ?? "datasheet.pdf");
      if (!dest) return;
      await assetExport(current.datasheetHash, dest);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The datasheet could not be exported.");
    }
  };

  return (
    <aside ref={panelElement} class="pl-properties" aria-label="Component properties">
      <Show
        when={store.doc()}
        fallback={
          <div class="pl-empty">
            <h2>Properties</h2>
            <p>No project open.</p>
            <p class="muted">
              {preview()
                ? "Projects are available in the desktop app."
                : "Create or open a project to start marking components."}
            </p>
            <div class="pl-empty-actions">
              <button
                onClick={props.onOpenProjectsTab}
                title="Go to the Projects tab for project actions"
              ><ActionIcon name="Open the Projects tab" />
                Open the Projects tab
              </button>
            </div>
          </div>
        }
      >
        <Show
          when={board() || component()}
          fallback={
            <div class="pl-empty">
              <h2>Properties</h2>
              <p>Add a board image to start marking components.</p>
              <div class="pl-empty-actions">
                <button onClick={props.onAddBoard}><ActionIcon name="Add board image…" />Add board image…</button>
              </div>
            </div>
          }
        >
          {/* Non-keyed on purpose: children are created once per selection and
              read `component()` reactively, so per-keystroke doc swaps do not
              rebuild the form (which would drop focus mid-typing). */}
          <Show
            when={component()}
            fallback={
              <Show
                when={store.boardSelected() && board()}
                fallback={
                  <div class="pl-empty">
                    <h2>Properties</h2>
                    <p>
                      {board()!.name} — {Math.round(displaySize(board()!).width)} ×{" "}
                      {Math.round(displaySize(board()!).height)} px displayed
                    </p>
                    <p>
                      {store.componentCount(board()!.id)} component
                      {store.componentCount(board()!.id) === 1 ? "" : "s"} marked.
                    </p>
                    <p class="muted">
                      Draw a rect, ellipse, or polygon over a component to add it, select an
                      existing marking to edit its fields, or click the picture to transform it.
                    </p>
                  </div>
                }
              >
                <BoardInspector store={store} />
              </Show>
            }
          >
            <div class="pl-form">
              <header class="pl-component-identification"><label><span>Component ID / reference designator</span>                <input
                  class="pl-refdes"
                  aria-label="Reference designator"
                  value={component()!.refdes}
                  disabled={component()!.locked}
                  onInput={(event) => {
                    const id = component()?.id;
                    if (id) store.updateComponent(id, { refdes: event.currentTarget.value });
                  }}
                />
</label></header>
              <Show when={duplicates().has(component()!.refdes)}>
                <p class="pl-error" role="alert">
                  Refdes “{component()!.refdes}” is already used — refdes values must be unique
                  project-wide; saving is blocked.
                </p>
              </Show>
              <Show when={component()!.locked}>
                <p class="muted">Component is locked — unlock to edit.</p>
              </Show>
              <Show when={error()}>
                <p class="pl-error" role="alert">
                  {error()}
                </p>
              </Show>

              <fieldset>
                <legend>Identification</legend>
                <div class="pl-type-field">
                  <span>Type</span>
                  <TypeCombobox
                    store={store}
                    label="Type"
                    value={component()!.typeId}
                    disabled={component()!.locked}
                    onChange={(typeId) => {
                      const id = component()?.id;
                      if (id) store.updateComponent(id, { typeId });
                    }}
                  />
                </div>
                <label>
                  <span>Part number</span>
                  <div class="pl-copy-row">
                    <input disabled={component()!.locked} {...text("partNumber")} placeholder="e.g. LM358" />
                    <CopyFieldButton label="Part number" onClick={() => void copyField("partNumber", "Part number")} />
                  </div>
                </label>
                <label>
                  <span>Value</span>
                  <div class="pl-copy-row">
                    <input disabled={component()!.locked} {...text("value")} placeholder="e.g. 10k" />
                    <CopyFieldButton label="Value" onClick={() => void copyField("value", "Value")} />
                  </div>
                </label>
                <label>
                  <span>Marking</span>
                  <input disabled={component()!.locked} {...text("marking")} placeholder="Silk text" />
                </label>
                <label>
                  <span>Package</span>
                  <input disabled={component()!.locked} {...text("pkg")} placeholder="e.g. SOIC-8" />
                </label>
                <label>
                  <span>Manufacturer</span>
                  <input disabled={component()!.locked} {...text("manufacturer")} />
                </label>
                <label>
                  <span>Status</span>
                  <select
                    disabled={component()!.locked}
                    value={component()!.status}
                    onChange={(event) => {
                      const id = component()?.id;
                      if (id) {
                        store.updateComponent(id, {
                          status: event.currentTarget.value as Component["status"],
                        });
                      }
                    }}
                  >
                    <option value="unknown">Unknown</option>
                    <option value="identified">Identified</option>
                    <option value="verified">Verified</option>
                  </select>
                </label>
              </fieldset>

              <fieldset>
                <legend>Datasheet</legend>
                <label>
                  <span>URL</span>
                  <div class="pl-copy-row">
                    <input
                      disabled={component()!.locked}
                      {...text("datasheetUrl")}
                      placeholder="https://…"
                    />
                    <CopyFieldButton label="URL" onClick={() => void copyField("datasheetUrl", "URL")} />
                  </div>
                </label>
                <Show
                  when={component()!.datasheetHash}
                  fallback={
                    <div class="pl-file-row">
                      <span class="muted">No datasheet file attached.</span>
                      <button disabled={component()!.locked} onClick={() => void attachDatasheet()}><ActionIcon name="Attach…" />
                        Attach…
                      </button>
                    </div>
                  }
                >
                  <div class="pl-file-row">
                    <span>
                      {store.doc()?.assets[component()!.datasheetHash!]?.name ?? "datasheet"}{" "}
                      <small>
                        {formatSize(store.doc()?.assets[component()!.datasheetHash!]?.size ?? 0)}
                      </small>
                    </span>
                    <button disabled={component()!.locked} onClick={() => void exportDatasheet()}><ActionIcon name="Export…" />
                      Export…
                    </button>
                    <button
                      disabled={component()!.locked}
                      onClick={() => {
                        const id = component()?.id;
                        if (id) store.updateComponent(id, { datasheetHash: undefined });
                      }}
                    ><ActionIcon name="Detach" />
                      Detach
                    </button>
                  </div>
                </Show>
              </fieldset>

              <fieldset>
                <legend>Images</legend>
                <Show when={(component()!.imageHashes ?? (component()!.imageHash ? [component()!.imageHash!] : [])).length} fallback={<p class="muted">No component image attached.</p>}>
                  <For each={component()!.imageHashes ?? (component()!.imageHash ? [component()!.imageHash!] : [])}>{hash =>
                    <ComponentPhoto
                      hash={hash}
                      refdes={component()!.refdes}
                      imageNames={component()!.imageNames}
                      disabled={component()!.locked || imageBusy()}
                      onNameChange={(names) => {
                        const selected = component();
                        if (selected) store.updateComponent(selected.id, { imageNames: names });
                      }}
                      onDetach={() => {
                        const selected = component();
                        if (!selected || selected.locked) return;
                        store.updateComponent(selected.id, { imageHash: undefined, imageHashes: (selected.imageHashes ?? (selected.imageHash ? [selected.imageHash] : [])).filter(value => value !== hash) });
                      }}
                    />
                  }</For>
                </Show>
                <div class="pl-file-actions">
                  <button disabled={preview() || component()!.locked || imageBusy()} onClick={() => void attachImage(false)}><ActionIcon name="Browse" />Browse…</button>
                  <button disabled={preview() || component()!.locked || imageBusy()} title="Paste a component image from the clipboard (Ctrl+V / Cmd+V)" onClick={() => void attachImage(true)}><ActionIcon name="Paste" />Paste image</button>
                </div>
              </fieldset>
              <fieldset>
                <legend>Description</legend>
                <div class="pl-copy-row">
                  <textarea aria-label="Description" rows={3} maxLength={4000} disabled={component()!.locked} {...text("description")} placeholder="Describe this component…" />
                  <CopyFieldButton label="Description" onClick={() => void copyField("description", "Description")} />
                </div>
              </fieldset>
              <fieldset>
                <legend>Notes</legend>
                <div class="pl-copy-row">
                  <textarea
                    aria-label="Notes"
                    rows={4}
                    disabled={component()!.locked}
                    {...text("notes")}
                    placeholder="Observations, measurements, hints…"
                  />
                  <CopyFieldButton label="Notes" onClick={() => void copyField("notes", "Notes")} />
                </div>
              </fieldset>
              <div class="pl-component-actions">                <button
                  aria-pressed={component()!.locked}
                  title={component()!.locked ? "Unlock component" : "Lock component"}
                  onClick={() => {
                    const current = component();
                    if (current) store.updateComponent(current.id, { locked: !current.locked });
                  }}
                >
                  <ActionIcon name="Lock" />{component()!.locked ? "Locked" : "Lock"}
                </button>
                <button
                  title="Duplicate this component (+12, +12 board px)"
                  onClick={() => {
                    const id = component()?.id;
                    if (id) store.duplicateComponent(id);
                  }}
                ><ActionIcon name="Duplicate" />
                  Duplicate
                </button>
                <button
                  disabled={component()!.locked}
                  title={component()!.locked ? "Component is locked" : "Delete this component"}
                  onClick={() => {
                    const id = component()?.id;
                    if (id) store.deleteComponent(id);
                  }}
                ><ActionIcon name="Delete" />
                  Delete
                </button>
<button disabled={!store.doc()} onClick={() => void store.requestSave()}><ActionIcon name="Save" />Save</button></div>
            </div>
          </Show>
        </Show>
      </Show>
    </aside>
  );
}

/** Icon-only clipboard button beside a field value; always enabled so a
 * locked component's committed values can still be copied out. */
function CopyFieldButton(props: { label: string; onClick: () => void }) {
  return (
    <button
      class="pl-copy"
      aria-label={`Copy ${props.label}`}
      title={`Copy ${props.label} to the clipboard`}
      onClick={props.onClick}
    ><ActionIcon name="Copy" /></button>
  );
}

/** Board-picture inspector: transform controls for the active board. Every
 * control except the lock toggle is disabled while the picture is locked. */
function BoardInspector(props: { store: PlacementStore }) {
  const store = props.store;
  const board = () => store.activeBoard()!;
  const locked = () => board().locked ?? false;
  const scalePercent = () => String(board().scale ?? 100);
  // One-decimal display; the store keeps rotation in 0.1° steps.
  const rotationText = () => `${Math.round((board().rotation ?? 0) * 10) / 10}°`;

  const [nameDraft, setNameDraft] = createSignal(board().name);
  // The draft follows the document so external renames and board switches
  // re-seed the field; commits are the only writes.
  createEffect(() => setNameDraft(board().name));

  /** Renames on commit; an empty trimmed draft reverts to the stored name.
   * Renaming is allowed while the picture is locked. */
  const commitName = () => {
    const current = board();
    const trimmed = nameDraft().trim();
    if (!trimmed || trimmed === current.name) {
      setNameDraft(current.name);
      return;
    }
    store.renameBoard(current.id, trimmed);
  };

  return (
    <div class="pl-form pl-board-inspector">
      <header class="pl-form-header">
        <input
          class="pl-board-title"
          aria-label="Board name"
          value={nameDraft()}
          onInput={(event) => setNameDraft(event.currentTarget.value)}
          onBlur={commitName}
          onChange={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitName();
            }
          }}
        />
      </header>
      <p class="muted">Board picture selected — transform how it is displayed.</p>
      <Show when={locked()}>
        <p class="muted">Picture is locked — unlock to transform.</p>
      </Show>
      <fieldset>
        <legend>Board picture</legend>
        <div class="pl-transform-row">
          <button
            aria-label="Rotate 90° CCW"
            title="Rotate 90° counterclockwise"
            disabled={locked()}
            onClick={() => store.rotateBoard(board().id, -1)}
          ><ActionIcon name="Rotate 90° CCW" /></button>
          <button
            aria-label="Rotate 90° CW"
            title="Rotate 90° clockwise"
            disabled={locked()}
            onClick={() => store.rotateBoard(board().id, 1)}
          ><ActionIcon name="Rotate 90° CW" /></button>
          <button
            aria-label="Mirror horizontal"
            title="Mirror horizontally"
            disabled={locked()}
            onClick={() => store.flipBoard(board().id, "h")}
          ><ActionIcon name="Mirror horizontal" /></button>
          <button
            aria-label="Mirror vertical"
            title="Mirror vertically"
            disabled={locked()}
            onClick={() => store.flipBoard(board().id, "v")}
          ><ActionIcon name="Mirror vertical" /></button>
        </div>
        <div class="pl-rotation-row">
          <span>Rotation</span>
          <div class="pl-rotation-controls">
            <button
              aria-label="Rotate 0.1° counterclockwise"
              title="Rotate 0.1° counterclockwise"
              disabled={locked()}
              onClick={() => store.rotateBoardBy(board().id, -0.1)}
            >−</button>
            <span class="pl-rotation-value">{rotationText()}</span>
            <button
              aria-label="Rotate 0.1° clockwise"
              title="Rotate 0.1° clockwise"
              disabled={locked()}
              onClick={() => store.rotateBoardBy(board().id, 0.1)}
            >+</button>
          </div>
        </div>
        <label>
          <span>Scale %</span>
          <input
            type="number"
            min={10}
            max={800}
            step={1}
            disabled={locked()}
            value={scalePercent()}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value)) store.setBoardScale(board().id, value);
            }}
          />
        </label>
        <p class="muted">
          Crop: pick the Crop tool (C) and drag over the picture to choose the visible area.
        </p>
        <Show when={store.cropDraft()}>
          <div class="pl-file-row" role="group" aria-label="Pending crop">
            <span>
              Apply the cropped area ({Math.round(store.cropDraft()!.w)} ×{" "}
              {Math.round(store.cropDraft()!.h)} px)?
            </span>
            <button class="pl-crop-apply" disabled={locked()} onClick={() => store.applyCrop()}><ActionIcon name="Apply" />
              Apply
            </button>
            <button class="pl-crop-cancel" onClick={() => store.cancelCrop()}><ActionIcon name="Cancel" />
              Cancel
            </button>
          </div>
        </Show>
      </fieldset>
      <div class="pl-component-actions">
        <button
          aria-pressed={locked()}
          title={locked() ? "Unlock the board picture" : "Lock the board picture"}
          onClick={() => store.updateBoard(board().id, { locked: !locked() })}
        >
          <ActionIcon name="Lock" />{locked() ? "Locked" : "Lock"}
        </button>
        <button
          disabled={locked()}
          title={locked() ? "Picture is locked" : "Delete this image and its components"}
          onClick={() => {
            const selected = board();
            if (window.confirm(`Delete image '${selected.name}' and its ${store.componentCount(selected.id)} components?`)) store.deleteBoard(selected.id);
          }}
        ><ActionIcon name="Delete image" />
          Delete image
        </button>
      </div>
    </div>
  );
}
