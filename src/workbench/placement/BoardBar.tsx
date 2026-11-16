// Board bar: segmented board list with add/switch/rename/delete.

import { For, Show, createSignal } from "solid-js";
import type { PlacementStore } from "./store";
import { ActionIcon } from "../ActionIcon";
import { ContextMenu } from "./ContextMenu";

export function BoardBar(props: { store: PlacementStore; onAddBoard: () => void }) {
  const store = props.store;
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [draftName, setDraftName] = createSignal("");
  const [menu, setMenu] = createSignal<{ id: string; name: string; x: number; y: number; target: HTMLElement } | null>(null);


  const commitRename = () => {
    const id = renamingId();
    if (id) store.renameMappingTab(id, draftName());
    setRenamingId(null);
  };

  const startRename = (id: string, name: string) => {
    setRenamingId(id);
    setDraftName(name);
  };

  const removeBoard = (id: string, name: string) => {
    if (window.confirm(`Delete mapping tab '${name}' and its images and components?`)) store.deleteMappingTab(id);
  };

  return (
    <div class="pl-boardbar" role="toolbar" aria-label="Boards">
      <For each={store.mappingTabs()}>
        {(board) => (
          <Show
            when={renamingId() !== board.id}
            fallback={
              <input
                class="pl-board-rename"
                aria-label={`Rename mapping tab ${board.name}`}
                value={draftName()}
                autofocus
                onInput={(event) => setDraftName(event.currentTarget.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") setRenamingId(null);
                }}
              />
            }
          >
            <span class="pl-board-chip">
              <button
                class="pl-board-tab"
                aria-current={store.activeMappingTab()?.id === board.id ? "true" : undefined}
                title={`${board.name} — double-click or F2 to rename`}
                onClick={() => store.activateMappingTab(board.id)}
                onDblClick={() => startRename(board.id, board.name)}
                onContextMenu={(event) => { event.preventDefault(); setMenu({ id: board.id, name: board.name, x: event.clientX, y: event.clientY, target: event.currentTarget }); }}
                onKeyDown={(event) => {
                  if (event.key === "F2") startRename(board.id, board.name);
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ id: board.id, name: board.name, x: rect.left, y: rect.top, target: event.currentTarget });
                  }
                }}
              >
                <span><ActionIcon name="Board" />{board.name}</span>
              </button>
            </span>
          </Show>
        )}
      </For>
      <button class="pl-board-add" disabled={!store.doc()} onClick={() => store.addMappingTab()} aria-label="Add mapping tab" title="Add mapping tab">
        +
      </button>
      <Show when={menu()} keyed>{(current) => <ContextMenu x={current.x} y={current.y} restoreFocus={current.target} onClose={() => setMenu(null)} items={[{ label: "Delete tab", run: () => removeBoard(current.id, current.name) }]} />}</Show>
    </div>
  );
}
