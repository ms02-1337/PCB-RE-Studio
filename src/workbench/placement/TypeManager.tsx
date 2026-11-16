import { ActionIcon } from "../ActionIcon";
// Component type manager modal (existing overlay pattern): add, rename,
// delete with reassignment to Unassigned. Colors are read-only here; new
// types get a random palette color.

import { For, Show, createSignal, onMount } from "solid-js";
import type { PlacementStore } from "./store";
import { UNASSIGNED_TYPE_ID } from "./projectDoc";
import { randomPaletteColor } from "./color";

const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export function TypeManager(props: { store: PlacementStore; onClose: () => void }) {
  const store = props.store;
  const [name, setName] = createSignal("");
  const [prefix, setPrefix] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [draftName, setDraftName] = createSignal("");
  let restoreFocus: HTMLElement | null = null;
  let nameInput: HTMLInputElement | undefined;

  // Command-palette pattern: remember the invoking element, move focus into
  // the dialog, restore on close if it is still in the document.
  onMount(() => {
    restoreFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameInput?.focus();
  });

  const close = () => {
    props.onClose();
    if (restoreFocus?.isConnected) restoreFocus.focus();
  };

  const types = () => store.doc()?.types ?? [];
  const usedCount = (id: string) =>
    store.doc()?.components.filter((component) => component.typeId === id).length ?? 0;

  const prefixTaken = (candidate: string) =>
    types().some((type) => type.prefix.toUpperCase() === candidate.toUpperCase());

  const add = () => {
    const trimmed = name().trim();
    if (!trimmed) {
      setMessage("Enter a type name.");
      return;
    }
    if (!PREFIX_PATTERN.test(prefix())) {
      setMessage("Prefix must start with a letter and contain only letters and digits.");
      return;
    }
    if (prefixTaken(prefix())) {
      setMessage(`Prefix ${prefix()} is already used by another type.`);
      return;
    }
    store.addType({ name: trimmed, color: randomPaletteColor(), prefix: prefix() });
    setName("");
    setPrefix("");
    setMessage("");
  };

  const remove = (id: string, typeName: string) => {
    const count = usedCount(id);
    const message =
      count > 0
        ? `${count} component${count === 1 ? "" : "s"} will be reassigned to Unassigned. Delete type '${typeName}'?`
        : `Delete type '${typeName}'?`;
    if (window.confirm(message)) store.deleteType(id);
  };

  const commitRename = () => {
    const id = renamingId();
    const trimmed = draftName().trim();
    if (id && trimmed) store.updateType(id, { name: trimmed });
    setRenamingId(null);
  };

  return (
    <div
      class="overlay overlay--center"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        class="palette type-manager"
        role="dialog"
        aria-modal="true"
        aria-label="Manage component types"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("input,button,select"),
          );
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header class="type-dialog-header">
          <h2>Manage component types</h2>
        </header>
        <div class="type-dialog-content">
          <table class="type-table">
            <thead>
              <tr>
                <th scope="col">Color</th>
                <th scope="col">Name</th>
                <th scope="col">Prefix</th>
                <th scope="col">Used by</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={types()}>
                {(type) => (
                  <tr>
                    <td>
                      <span
                        class="pl-chip-dot"
                        style={{ background: type.color }}
                        title={type.color}
                        aria-hidden="true"
                      />
                    </td>
                    <td>
                      <Show
                        when={renamingId() !== type.id}
                        fallback={
                          <input
                            class="type-rename"
                            aria-label={`Rename ${type.name}`}
                            value={draftName()}
                            autofocus
                            onInput={(event) => setDraftName(event.currentTarget.value)}
                            onBlur={commitRename}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") commitRename();
                              if (event.key === "Escape") {
                                // Cancel the inline rename without closing the modal.
                                event.stopPropagation();
                                setRenamingId(null);
                              }
                            }}
                          />
                        }
                      >
                        <button
                          class="type-name"
                          title="Rename this type"
                          onClick={() => {
                            setRenamingId(type.id);
                            setDraftName(type.name);
                          }}
                        >
                          {type.name}
                        </button>
                      </Show>
                    </td>
                    <td>{type.prefix}</td>
                    <td>{usedCount(type.id)}</td>
                    <td>
                      <Show
                        when={type.id !== UNASSIGNED_TYPE_ID}
                        fallback={
                          <button disabled title="Unassigned is the built-in fallback type and cannot be deleted"><ActionIcon name="Delete" />
                            Delete
                          </button>
                        }
                      >
                        <button onClick={() => remove(type.id, type.name)}><ActionIcon name="Delete" />Delete</button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <div class="type-add">
            <label>
              <span>Name</span>
              <input
                ref={nameInput}
                aria-label="New type name"
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
                placeholder="e.g. Relay"
              />
            </label>
            <label>
              <span>Prefix</span>
              <input
                aria-label="New type prefix"
                value={prefix()}
                onInput={(event) => setPrefix(event.currentTarget.value)}
                placeholder="e.g. K"
              />
            </label>
            <button onClick={add}><ActionIcon name="Add type" />Add type</button>
          </div>
          <Show when={message()}>
            <p class="pl-error" role="alert">
              {message()}
            </p>
          </Show>
        </div>
        <footer class="type-dialog-footer">
          <button class="type-close" onClick={close}><ActionIcon name="Close" />
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
