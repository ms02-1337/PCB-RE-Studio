import { afterEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { ComponentManager } from "./ComponentManager";
import { kicad } from "../../bridge/kicad";
import { pickKiCadLibraryFiles } from "../../bridge/dialog";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("../../bridge/dialog", () => ({ pickKiCadLibraryFiles: vi.fn(), pickDirectory: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); });

function setup() {
  vi.spyOn(kicad, "sources").mockResolvedValue([]);
  vi.spyOn(kicad, "definitions").mockResolvedValue([]);
  vi.spyOn(kicad, "search").mockResolvedValue({ entries: [], total: 0 });
  vi.spyOn(kicad, "importFiles").mockResolvedValue([]);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  render(() => <ComponentManager onClose={vi.fn()} onPlace={vi.fn()} />);
}
async function openFootprintBrowser() {
  fireEvent.click(screen.getByRole("button", { name: "Create new component" }));
  const button = await screen.findByRole("button", { name: "Import…" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
}

it("imports downloaded files, reports the entry count and refreshes the browser", async () => {
  setup();
  const button = await openFootprintBrowser();
  vi.mocked(pickKiCadLibraryFiles).mockResolvedValue(["C:/Downloads/R_0603.kicad_mod"]);
  vi.mocked(kicad.importFiles).mockResolvedValue([
    { file: "R_0603.kicad_mod", library: "Imported", entries: [{ id: "e1", name: "Imported:R_0603", sourceId: "pcbre-local-imports", kind: "footprint" }] },
  ]);
  fireEvent.click(button);
  await waitFor(() => expect(kicad.importFiles).toHaveBeenCalledWith(["C:/Downloads/R_0603.kicad_mod"]));
  expect(await screen.findByText("Imported 1 entry into the local library.")).toBeTruthy();
  await waitFor(() => expect(kicad.search).toHaveBeenCalledTimes(2));
  // ComponentManager mount + hidden LibrarySettings mount + post-import refresh.
  expect(kicad.sources).toHaveBeenCalledTimes(3);
});

it("reports per-file import failures without refreshing the browser", async () => {
  setup();
  const button = await openFootprintBrowser();
  vi.mocked(pickKiCadLibraryFiles).mockResolvedValue(["C:/Downloads/bad.kicad_mod"]);
  vi.mocked(kicad.importFiles).mockResolvedValue([
    { file: "bad.kicad_mod", library: "", entries: [], error: "Unsupported electrical pad shape." },
  ]);
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("bad.kicad_mod"));
  expect(screen.getByRole("alert").textContent).toContain("Unsupported electrical pad shape.");
  expect(screen.queryByRole("status", { name: "Import result" })).toBeNull();
  expect(kicad.search).toHaveBeenCalledTimes(1);
});

it("does nothing when the picker is cancelled", async () => {
  setup();
  const button = await openFootprintBrowser();
  vi.mocked(pickKiCadLibraryFiles).mockResolvedValue(null);
  fireEvent.click(button);
  await waitFor(() => expect(pickKiCadLibraryFiles).toHaveBeenCalled());
  expect(kicad.importFiles).not.toHaveBeenCalled();
});
