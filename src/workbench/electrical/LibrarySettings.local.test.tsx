import { it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { LibrarySettings } from "./LibrarySettings";
import { kicad } from "../../bridge/kicad";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

afterEach(() => {
  vi.restoreAllMocks();
});

it("protects the app-managed local library source row", async () => {
  vi.spyOn(kicad, "sources").mockResolvedValue([
    { id: "pcbre-local-imports", path: "C:/AppData/Roaming/PCB RE Studio/kicad-local", name: "Imported files", diagnostics: [], local: true },
    { id: "user", path: "C:/KiCad/9.0/share/kicad", name: "9.0", diagnostics: [], variables: {} },
  ]);
  render(() => <LibrarySettings />);
  await waitFor(() => expect(screen.getByText("Imported files")).toBeTruthy());
  expect(screen.getByText("App-managed copies of imported footprint and symbol files.")).toBeTruthy();
  expect(screen.getByText("Managed by the app")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Rescan" })).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Change path" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Remove source" })).toHaveLength(1);
});
