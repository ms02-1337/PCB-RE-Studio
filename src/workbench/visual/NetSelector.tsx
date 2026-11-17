import { createSignal, For, Show } from "solid-js";
import type { CopperNet } from "./model";

/** Filterable net combobox shared by copper elements and component
 * terminals: a text input with the matching nets listed directly below it.
 * Typing filters the list; Enter or the "+" button creates a net from the
 * typed name; "unassigned" (or the Unassigned item) clears the assignment;
 * Escape or blur dismisses the list without changing the value. */
export function NetSelector(props: {
  nets: () => CopperNet[];
  value: () => string;
  onChange: (id: string) => void;
  onAdd?: (name: string) => void;
  disabled?: boolean;
  /** Heading text next to the current-net badge. */
  label?: string;
  /** Accessible name of the input; defaults to the heading text. */
  ariaLabel?: string;
  /** Accessible name of the dropdown listbox. */
  listLabel?: string;
  /** Hide the heading row (used inside tables whose column is labeled). */
  compact?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [dropUp, setDropUp] = createSignal(false);
  const [dropdownMaxHeight, setDropdownMaxHeight] = createSignal(160);
  let inputRef: HTMLInputElement | undefined;
  const nets = () => props.nets();
  const label = () => props.label ?? "Net";
  const currentNet = () => nets().find((n) => n.id === props.value());
  const filteredNets = () => {
    const q = filter().trim().toLowerCase();
    if (!q) return nets();
    return nets().filter((n) => n.name.toLowerCase().includes(q));
  };

  const handleAdd = () => {
    const val = filter().trim();
    if (!val || !props.onAdd) return;
    props.onAdd(val);
    setFilter("");
    setOpen(false);
  };

  const commit = (id: string) => {
    props.onChange(id);
    setOpen(false);
    setFilter("");
  };

  /** Flip the list above the input when the scrolling inspector lacks room
   * below, mirroring the board-mapping selector's placement logic. */
  const measure = () => {
    if (!inputRef) return;
    const rect = inputRef.getBoundingClientRect();
    const container =
      inputRef.closest(".component-inspector") ??
      inputRef.closest(".ve-copper-inspector") ??
      inputRef.closest(".ve-sidebar");
    const bounds = container
      ? container.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight || 800 };
    if (bounds.bottom === 0 && bounds.top === 0) {
      setDropUp(false);
      setDropdownMaxHeight(160);
      return;
    }
    const spaceBelow = Math.max(0, bounds.bottom - rect.bottom - 12);
    const spaceAbove = Math.max(0, rect.top - bounds.top - 12);
    if (spaceBelow < 120 && spaceAbove > spaceBelow) {
      setDropUp(true);
      setDropdownMaxHeight(Math.max(80, Math.min(180, Math.floor(spaceAbove))));
    } else {
      setDropUp(false);
      setDropdownMaxHeight(Math.max(80, Math.min(180, Math.floor(spaceBelow))));
    }
  };
  const openDropdown = () => {
    measure();
    setOpen(true);
    setFilter("");
  };

  return (
    <div class="ve-net-selector">
      <Show when={!props.compact}>
        <div class="ve-net-selector-header">
          <span>{label()}</span>
          <span class="ve-net-current-badge">
            <Show
              when={currentNet()}
              fallback={<span class="muted">Unassigned</span>}
            >
              {(net) => (
                <>
                  <span
                    class="ve-net-dot"
                    style={{ background: net().color }}
                    aria-hidden="true"
                  />
                  {net().name}
                </>
              )}
            </Show>
          </span>
        </div>
      </Show>
      <div class="ve-net-input-bar">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={props.ariaLabel ?? label()}
          aria-expanded={open()}
          aria-autocomplete="list"
          disabled={props.disabled}
          placeholder={currentNet() ? currentNet()!.name : "Assign net…"}
          value={open() ? filter() : (currentNet()?.name ?? "")}
          onClick={() => {
            if (!open()) openDropdown();
          }}
          onFocus={() => {
            if (!open()) openDropdown();
          }}
          onInput={(e) => {
            setFilter(e.currentTarget.value);
            // Opening from a closed state must keep the typed filter so the
            // first keystroke is already searchable (and committable by Enter).
            if (!open()) {
              measure();
              setOpen(true);
            } else {
              measure();
            }
          }}
          onChange={(e) => {
            const val = e.currentTarget.value.trim();
            if (!val || val.toLowerCase() === "unassigned") {
              commit("");
              return;
            }
            const match = nets().find(
              (n) =>
                n.id === val || n.name.toLowerCase() === val.toLowerCase(),
            );
            if (match) {
              commit(match.id);
            } else if (props.onAdd) {
              props.onAdd(val);
              setOpen(false);
              setFilter("");
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const val = filter().trim();
              if (!val || val.toLowerCase() === "unassigned") {
                commit("");
                return;
              }
              const match = nets().find(
                (n) =>
                  n.id === val || n.name.toLowerCase() === val.toLowerCase(),
              );
              if (match) {
                commit(match.id);
              } else {
                handleAdd();
              }
            } else if (e.key === "Escape") {
              setOpen(false);
              setFilter("");
            }
          }}
          onBlur={() => {
            window.setTimeout(() => {
              if (open()) {
                setOpen(false);
                setFilter("");
              }
            }, 150);
          }}
        />
        <Show when={props.onAdd}>
          <button
            type="button"
            class="ve-net-add-btn"
            aria-label="Add net"
            title="Add net"
            disabled={props.disabled || !filter().trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleAdd}
          >
            +
          </button>
        </Show>
      </div>
      <Show when={open()}>
        <div
          class="ve-net-dropdown"
          role="listbox"
          aria-label={props.listLabel ?? "Nets list"}
          style={{
            ...(dropUp()
              ? {
                  bottom: "100%",
                  top: "auto",
                  "margin-bottom": "3px",
                  "margin-top": "0",
                }
              : {
                  top: "100%",
                  bottom: "auto",
                  "margin-top": "3px",
                  "margin-bottom": "0",
                }),
            "max-height": `${dropdownMaxHeight()}px`,
          }}
        >
          <button
            type="button"
            class="ve-net-item"
            data-selected={!props.value()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit("")}
          >
            <span class="ve-net-dot unassigned" aria-hidden="true" />
            <span class="ve-net-item-name">Unassigned</span>
            <Show when={!props.value()}>
              <span class="ve-net-check">✓</span>
            </Show>
          </button>
          <For each={filteredNets()}>
            {(n) => (
              <button
                type="button"
                class="ve-net-item"
                data-selected={n.id === props.value()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(n.id)}
              >
                <span
                  class="ve-net-dot"
                  style={{ background: n.color }}
                  aria-hidden="true"
                />
                <span class="ve-net-item-name">{n.name}</span>
                <Show when={n.id === props.value()}>
                  <span class="ve-net-check">✓</span>
                </Show>
              </button>
            )}
          </For>
          <Show when={filteredNets().length === 0 && filter().trim()}>
            <div class="ve-net-empty">No matching nets</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
