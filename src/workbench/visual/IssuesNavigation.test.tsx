import { expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { collectPcbIssues, type IssueReveal } from "../issues";
import { VisualPanel } from "./VisualPanel";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
it("reveals a back-layer trace, cancels a tool, and ignores a stale project request", async () => {
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  const doc: ProjectDoc = {
    schemaVersion: 1,
    name: "Test",
    createdAt: "t",
    updatedAt: "t",
    types: SEED_TYPES,
    boards: [],
    components: [],
    assets: {},
  };
  const store = createPlacementStore({
    openProject: async () => ({ doc, assets: {}, path: "C:\\test.pcbre" }),
    save: vi.fn(),
  });
  await store.openProject("C:\\test.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
  store.visual.initialize();
  const pcb = JSON.parse(JSON.stringify(store.visual.activePcb()!));
  pcb.pxPerMm = 10;
  pcb.traces = [
    {
      id: "trace",
      layerId: pcb.layers[1],
      width: 2,
      points: [
        { x: 1000, y: 1000 },
        { x: 1100, y: 1000 },
      ],
    },
  ];
  store.visual.replacePcb(pcb);
  const issue = collectPcbIssues(pcb)[0];
  const [request, setRequest] = createSignal<IssueReveal | null>(null);
  const view = render(() => (
    <VisualPanel store={store} active issueReveal={request()} />
  ));
  try {
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));
    setRequest({ issue, session: store.projectSession() - 1, token: 1 });
    await Promise.resolve();
    expect(
      screen
        .getByRole("button", { name: "Measure" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    setRequest({ issue, session: store.projectSession(), token: 2 });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Measure" })
          .getAttribute("aria-pressed"),
      ).toBe("false"),
    );
    expect(
      (screen.getByLabelText("Shown copper layer") as HTMLSelectElement).value,
    ).toBe(pcb.layers[1]);
    expect(screen.getByRole("button", { name: "Delete element" })).toBeTruthy();
    setRequest({ issue, session: store.projectSession(), token: 3 });
    await Promise.resolve();
    expect(screen.getByRole("button", { name: "Delete element" })).toBeTruthy();
  } finally {
    view.unmount();
    store.dispose();
    context.mockRestore();
  }
});
