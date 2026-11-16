// Context menu behavior: viewport-clamped positioning, roving focus over
// enabled items with arrow keys, Escape close with focus restore, and item
// activation. jsdom reports zero-size rects, so clamping lands at
// innerWidth/innerHeight minus the 8px margin.

import { it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { ContextMenu, type MenuItem } from "./ContextMenu";

function makeItems(): MenuItem[] {
  return [
    { label: "Fit to view", shortcut: "0", run: vi.fn() },
    { label: "Zoom 100%", shortcut: "1", run: vi.fn() },
    { label: "Delete", disabled: true, reason: "Component is locked", run: vi.fn() },
  ];
}

function mount(items: MenuItem[], restoreFocus?: HTMLElement | null) {
  const onClose = vi.fn();
  render(() => (
    <ContextMenu x={40} y={30} items={items} onClose={onClose} restoreFocus={restoreFocus} />
  ));
  return { onClose };
}

const enabledItems = () =>
  screen
    .getAllByRole("menuitem")
    .filter((item) => !(item as HTMLButtonElement).disabled) as HTMLButtonElement[];

it("opens positioned at the pointer and focuses the first enabled item", () => {
  mount(makeItems());
  const menu = screen.getByRole("menu", { name: "Canvas actions" });
  expect(menu.style.left).toBe("40px");
  expect(menu.style.top).toBe("30px");
  const enabled = enabledItems();
  expect(enabled).toHaveLength(2);
  expect((screen.getByRole("menuitem", { name: /Delete/ }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(document.activeElement).toBe(enabled[0]);
});

it("clamps the menu inside the viewport", () => {
  render(() => (
    <ContextMenu x={5000} y={5000} items={makeItems()} onClose={vi.fn()} />
  ));
  const menu = screen.getByRole("menu", { name: "Canvas actions" });
  expect(menu.style.left).toBe(`${window.innerWidth - 8}px`);
  expect(menu.style.top).toBe(`${window.innerHeight - 8}px`);
});

it("arrow keys move focus through enabled items and wrap", () => {
  mount(makeItems());
  const menu = screen.getByRole("menu", { name: "Canvas actions" });
  const [first, second] = enabledItems();
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(first); // wraps past the end
  fireEvent.keyDown(menu, { key: "ArrowUp" });
  expect(document.activeElement).toBe(second);
  fireEvent.keyDown(menu, { key: "Home" });
  expect(document.activeElement).toBe(first);
});

it("Escape closes the menu and restores focus to the invoker", () => {
  const invoker = document.createElement("button");
  document.body.appendChild(invoker);
  invoker.focus();
  const { onClose } = mount(makeItems(), invoker);
  fireEvent.keyDown(screen.getByRole("menu", { name: "Canvas actions" }), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(invoker);
  invoker.remove();
});

it("activating an item runs its action and closes the menu", () => {
  const items = makeItems();
  const { onClose } = mount(items);
  const second = enabledItems()[1];
  fireEvent.click(second);
  expect(items[1].run).toHaveBeenCalledTimes(1);
  expect(items[0].run).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});
