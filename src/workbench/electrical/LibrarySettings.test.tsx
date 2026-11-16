import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { LibrarySettings } from "./LibrarySettings";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));

afterEach(() => {
  vi.restoreAllMocks();
  // Clipboard stubs from the paste test must not leak into other suites.
  delete (navigator as { clipboard?: unknown }).clipboard;
});

it("disables Browse in browser preview while Paste stays available", () => {
  render(() => <LibrarySettings />);
  expect(
    (screen.getByRole("button", { name: "Browse…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Paste" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("shows an inline alert when the clipboard is unavailable", async () => {
  render(() => <LibrarySettings />);
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "The clipboard is empty or unreadable.",
    ),
  );
  expect(
    (screen.getByLabelText("Source path") as HTMLInputElement).value,
  ).toBe("");
});

it("fills the source path from pasted clipboard text", async () => {
  const readText = vi.fn(async () => "  C:/KiCad/footprints.pretty  ");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText },
  });
  render(() => <LibrarySettings />);
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  const input = screen.getByLabelText("Source path") as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("C:/KiCad/footprints.pretty"));
  expect(readText).toHaveBeenCalledTimes(1);
});
