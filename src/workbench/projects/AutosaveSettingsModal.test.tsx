import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { createPlacementStore, type PlacementStore } from "../placement/store";
import type { AutosaveSettings } from "../settings";
import { AutosaveSettingsModal } from "./AutosaveSettingsModal";

function makeStore(): PlacementStore {
  return createPlacementStore({ save: vi.fn() });
}

type Handlers = {
  onApply: ReturnType<typeof vi.fn<(settings: AutosaveSettings) => void>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
};

function modal(
  store: PlacementStore,
  initial = { enabled: true, delayMs: 2000 },
): Handlers {
  const handlers: Handlers = {
    onApply: vi.fn<(settings: AutosaveSettings) => void>(),
    onClose: vi.fn<() => void>(),
  };
  render(() => (
    <Show when>
      <AutosaveSettingsModal
        store={store}
        initial={initial}
        theme="dark"
        appInfo="PCB RE Studio Browser preview"
        onToggleTheme={vi.fn()}
        onApply={(settings) => handlers.onApply(settings)}
        onClose={() => handlers.onClose()}
      />
    </Show>
  ));
  fireEvent.click(screen.getByRole("tab", { name: "Autosave" }));
  return handlers;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("seeds autosave fields and switches settings sections accessibly", () => {
  const store = makeStore();
  modal(store, { enabled: false, delayMs: 5000 });
  expect(
    screen.getByRole("tab", { name: "Autosave" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Autosave" }), {
    key: "ArrowUp",
  });
  expect(
    screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "General" }), {
    key: "ArrowDown",
  });
  expect(
    screen.getByRole("tab", { name: "Autosave" }).getAttribute("aria-selected"),
  ).toBe("true");
  const toggle = screen.getByLabelText("Enable autosave") as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(
    (screen.getByLabelText("Autosave delay (ms)") as HTMLInputElement).value,
  ).toBe("5000");
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "Autosave" }),
  );
  expect(screen.getByText("500-60000 ms")).toBeTruthy();
  expect(
    screen.getByText(
      "With autosave off, changes stay in memory until you save manually (Ctrl+S).",
    ),
  ).toBeTruthy();
});

it("Apply hands the edited settings to onApply and closes", () => {
  const store = makeStore();
  const handlers = modal(store);
  fireEvent.click(screen.getByLabelText("Enable autosave"));
  fireEvent.input(screen.getByLabelText("Autosave delay (ms)"), {
    target: { value: "5000" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(handlers.onApply).toHaveBeenCalledWith({
    enabled: false,
    delayMs: 5000,
  });
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("Cancel closes without applying", () => {
  const store = makeStore();
  const handlers = modal(store);
  fireEvent.input(screen.getByLabelText("Autosave delay (ms)"), {
    target: { value: "3000" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(handlers.onApply).not.toHaveBeenCalled();
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("Enter in the delay input applies", () => {
  const store = makeStore();
  const handlers = modal(store);
  fireEvent.input(screen.getByLabelText("Autosave delay (ms)"), {
    target: { value: "1500" },
  });
  fireEvent.keyDown(screen.getByLabelText("Autosave delay (ms)"), {
    key: "Enter",
  });
  expect(handlers.onApply).toHaveBeenCalledWith({
    enabled: true,
    delayMs: 1500,
  });
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("rejects out-of-range or empty delays without applying", () => {
  const store = makeStore();
  const handlers = modal(store);
  const delay = screen.getByLabelText("Autosave delay (ms)");
  for (const value of ["10", "100000", ""]) {
    fireEvent.input(delay, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter a delay between 500 and 60000 ms.",
    );
    expect(handlers.onApply).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  }
});

it("Escape closes and restores focus to the invoking element", () => {
  const store = makeStore();
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  const onClose = vi.fn();
  render(() => (
    <Show when>
      <AutosaveSettingsModal
        store={store}
        initial={{ enabled: true, delayMs: 2000 }}
        theme="dark"
        appInfo="PCB RE Studio Browser preview"
        onToggleTheme={vi.fn()}
        onApply={vi.fn()}
        onClose={onClose}
      />
    </Show>
  ));
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "General" }),
  );
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Settings" }), {
    key: "Escape",
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it("wraps Tab focus inside the dialog", () => {
  const store = makeStore();
  modal(store);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const close = screen.getByRole("button", { name: "Close settings" });
  const apply = screen.getByRole("button", { name: "Apply" });
  // From the last control, Tab wraps to the first.
  apply.focus();
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  // And shift-Tab from the first wraps to the last.
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(apply);
});
