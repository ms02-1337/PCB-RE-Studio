import { ActionIcon } from "../ActionIcon";
// Reusable component-type combobox: filterable listbox over the store's
// types plus a "+" that opens a create-type modal (overlay/palette pattern
// with a focus trap, like TypeManager). Keyboard: ArrowUp/Down move the
// active option, Enter commits it (or an exact name match), Escape reverts,
// Tab closes.

import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import type { PlacementStore } from "./store";
import { UNASSIGNED_TYPE_ID } from "./projectDoc";
import { randomPaletteColor } from "./color";

const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export function TypeCombobox(props: {
  store: PlacementStore;
  label: string;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const store = props.store;
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [creating, setCreating] = createSignal(false);
  let input: HTMLInputElement | undefined;

  const listId = `typecombobox-${props.label.replace(/\s+/g, "-").toLowerCase()}`;
  const types = () => store.doc()?.types ?? [];
  const selected = () => types().find((type) => type.id === props.value);
  const filtered = () => {
    const query = filter().trim().toLowerCase();
    if (!query) return types();
    return types().filter(
      (type) =>
        type.name.toLowerCase().includes(query) || type.prefix.toLowerCase().includes(query),
    );
  };
  const activeId = () => filtered()[activeIndex()]?.id ?? "";

  const showList = () => {
    setOpen(true);
    setFilter("");
    const index = filtered().findIndex((type) => type.id === props.value);
    setActiveIndex(index >= 0 ? index : 0);
  };

  const close = () => {
    setOpen(false);
    setFilter("");
    // Revert the visible text to the selected type name.
    if (input) input.value = selected()?.name ?? "";
  };

  const commit = (id: string) => {
    if (id && types().some((type) => type.id === id)) props.onChange(id);
    close();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open()) showList();
      const count = filtered().length;
      if (!count) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + delta + count) % count);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!open()) {
        showList();
        return;
      }
      // Exact name match wins; otherwise the active option.
      const query = filter().trim().toLowerCase();
      const exact = types().find((type) => type.name.toLowerCase() === query);
      if (exact) commit(exact.id);
      else if (activeId()) commit(activeId());
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") close();
  };

  // Keep the closed input's text in sync when the selection changes elsewhere.
  createEffect(() => {
    void props.value;
    void store.doc();
    if (!open() && input) input.value = selected()?.name ?? "";
  });

  return (
    <span class="pl-combobox">
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label={props.label}
        aria-expanded={open()}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open() && activeId() ? `${listId}-opt-${activeId()}` : undefined}
        disabled={props.disabled}
        value={selected()?.name ?? ""}
        placeholder="Type"
        autocomplete="off"
        onFocus={() => showList()}
        onClick={() => showList()}
        onInput={(event) => {
          setFilter(event.currentTarget.value);
          if (!open()) setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Clicking an option blurs the input first; the option's
          // onmousedown prevents the default so the click still lands.
          window.setTimeout(() => {
            if (!creating()) close();
          }, 120);
        }}
      />
      <button
        type="button"
        class="pl-combobox-add"
        aria-label={`Add a new component type for ${props.label}`}
        title="Create a new type…"
        disabled={props.disabled}
        onClick={(event) => {
          event.preventDefault();
          setCreating(true);
        }}
      >
        +
      </button>
      <Show when={open() && !props.disabled}>
        <ul class="pl-listbox" id={listId} role="listbox" aria-label={props.label}>
          <For each={filtered()}>
            {(type, index) => (
              <li
                id={`${listId}-opt-${type.id}`}
                role="option"
                aria-selected={type.id === props.value}
                data-active={index() === activeIndex()}
                class="pl-option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(type.id)}
                onMouseEnter={() => setActiveIndex(index())}
              >
                <span class="pl-chip-dot" style={{ background: type.color }} aria-hidden="true" />
                <span class="pl-option-name">{type.name}</span>
                <small>({type.prefix})</small>
              </li>
            )}
          </For>
          <Show when={filtered().length === 0}>
            <li class="pl-option pl-option-empty" role="presentation">
              No matching type
            </li>
          </Show>
        </ul>
      </Show>
      <Show when={creating()}>
        <CreateTypeModal
          store={store}
          initialName={filter().trim()}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            props.onChange(id);
            if (input) input.value = store.typeById(id)?.name ?? "";
          }}
        />
      </Show>
    </span>
  );
}

function CreateTypeModal(props: {
  store: PlacementStore;
  initialName: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = createSignal(props.initialName);
  const [prefix, setPrefix] = createSignal(suggestPrefix(props.initialName));
  // Silent random default color from the shared palette; no color picker.
  const [color] = createSignal(randomPaletteColor());
  const [prefixTouched, setPrefixTouched] = createSignal(Boolean(props.initialName));
  const [message, setMessage] = createSignal("");
  let restoreFocus: HTMLElement | null = null;
  let nameInput: HTMLInputElement | undefined;

  onMount(() => {
    restoreFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameInput?.focus();
  });

  const close = () => {
    props.onClose();
    if (restoreFocus?.isConnected) restoreFocus.focus();
  };

  const types = () => props.store.doc()?.types ?? [];
  const prefixTaken = (candidate: string) =>
    types().some((type) => type.prefix.toUpperCase() === candidate.toUpperCase());

  const validate = (): string => {
    const trimmed = name().trim();
    if (!trimmed) return "Enter a type name.";
    if (!PREFIX_PATTERN.test(prefix().trim()))
      return "Prefix must start with a letter and contain only letters and digits.";
    if (prefixTaken(prefix().trim()))
      return `Prefix ${prefix().trim()} is already used by another type.`;
    return "";
  };

  const confirm = () => {
    const error = validate();
    if (error) {
      setMessage(error);
      return;
    }
    const id = props.store.addType({
      name: name().trim(),
      color: color().toLowerCase(),
      prefix: prefix().trim().toUpperCase(),
    });
    props.onCreated(id);
    if (restoreFocus?.isConnected) restoreFocus.focus();
  };

  return (
    <div
      class="overlay overlay--center"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        class="palette type-create"
        role="dialog"
        aria-modal="true"
        aria-label="Create component type"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            confirm();
            return;
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("input,button"),
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
          <h2>Create component type</h2>
        </header>
        <div class="type-dialog-content">
          <label>
            <span>Name</span>
            <input
              ref={nameInput}
              aria-label="New type name"
              value={name()}
              placeholder="e.g. Relay"
              onInput={(event) => {
                setName(event.currentTarget.value);
                // Auto-suggest the prefix until the user edits it directly.
                if (!prefixTouched()) setPrefix(suggestPrefix(event.currentTarget.value));
              }}
            />
          </label>
          <label>
            <span>Prefix</span>
            <input
              aria-label="New type prefix"
              value={prefix()}
              placeholder="e.g. K"
              onInput={(event) => {
                setPrefixTouched(true);
                setPrefix(event.currentTarget.value);
              }}
            />
          </label>
          <p class="pl-type-helper muted" role="status">
            {message() || `Prefixes must be unique; ${UNASSIGNED_TYPE_ID} is built in.`}
          </p>
        </div>
        <footer class="type-dialog-footer">
          <button onClick={confirm}><ActionIcon name="Add type" />Add type</button>
          <button onClick={close}><ActionIcon name="Cancel" />Cancel</button>
        </footer>
      </section>
    </div>
  );
}

/** Uppercased first letter of the name, when it is a letter. */
function suggestPrefix(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : "";
}
