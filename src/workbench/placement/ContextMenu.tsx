// Keyboard-operable context menu (role="menu") used by the placement canvas.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { ActionIcon } from "../ActionIcon";

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** Explanation shown when disabled (e.g. locked components). */
  reason?: string;
  run?: () => void;
}

export function ContextMenu(props: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  restoreFocus?: HTMLElement | null;
}) {
  let menu: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal({ x: props.x, y: props.y });

  const enabled = () => props.items.filter((item) => !item.disabled);
  const focusItem = (index: number) => {
    const items = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
    items?.[index]?.focus();
  };

  onMount(() => {
    if (menu) {
      const rect = menu.getBoundingClientRect();
      setPosition({
        x: Math.min(props.x, window.innerWidth - rect.width - 8),
        y: Math.min(props.y, window.innerHeight - rect.height - 8),
      });
    }
    focusItem(0);
    const onPointerDown = (event: PointerEvent) => {
      if (menu && !menu.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => window.removeEventListener("pointerdown", onPointerDown, true));
  });

  const close = () => {
    props.onClose();
    props.restoreFocus?.focus?.();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const items = enabled();
    const current = items.findIndex((item) => item.label === (document.activeElement as HTMLElement)?.dataset?.label);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = (Math.max(current, 0) + delta + items.length) % items.length;
      focusItem(next);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!items.length) return;
      focusItem(event.key === "Home" ? 0 : items.length - 1);
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  return (
    <div class="ctx-backdrop" onPointerDown={(event) => event.preventDefault()}>
      <div
        ref={menu}
        class="ctx-menu"
        role="menu"
        aria-label="Canvas actions"
        style={{ left: `${position().x}px`, top: `${position().y}px` }}
        onKeyDown={onKeyDown}
      >
        <For each={props.items}>
          {(item) => (
            <button
              role="menuitem"
              data-label={item.label}
              disabled={item.disabled}
              title={item.disabled ? (item.reason ?? item.label) : item.label}
              onClick={() => {
                if (item.disabled) return;
                item.run?.();
                close();
              }}
            >
              <span><ActionIcon name={item.label} />{item.label}</span>
              <Show when={item.shortcut}>
                <span class="ctx-shortcut">{item.shortcut}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
