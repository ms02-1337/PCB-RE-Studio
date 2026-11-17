import { render, screen, fireEvent, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { IssuesBrowser } from "./IssuesBrowser";
import type { PlacementStore } from "./placement/store";
import type { VisualPcb } from "./visual/model";

function setup() {
  const [pcbs, setPcbs] = createSignal<VisualPcb[]>([
    {
      id: "p",
      name: "Main PCB",
      layers: ["front"],
      images: [],
      traces: [
        {
          id: "trace",
          layerId: "front",
          width: 1,
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
          ],
        },
      ],
    },
  ]);
  const [session, setSession] = createSignal(1);
  const store = {
    doc: () => ({ name: "Project" }),
    projectSession: session,
    visual: { editor: () => ({ pcbs: pcbs() }) },
  } as unknown as PlacementStore;
  const reveal = vi.fn();
  render(() => <IssuesBrowser store={store} onReveal={reveal} />);
  return { setPcbs, setSession, reveal };
}
describe("Issues browser", () => {
  it("expands categories, filters severities, and restores focus after dismissal", () => {
    setup();
    const button = screen.getByRole("button", { name: "Issues (2)" });
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Project issues" });
    const category = within(dialog).getByRole("button", {
      name: /Trace issues/,
    });
    expect(category.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(category);
    expect(
      within(dialog).getAllByRole("button", { name: /Show on canvas/ }),
    ).toHaveLength(2);
    fireEvent.change(within(dialog).getByLabelText("Severity"), {
      target: { value: "Error" },
    });
    expect(
      within(dialog).getByText("No issues match these filters."),
    ).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
  it("reveals the exact endpoint with PCB/session identity and closes the modal", () => {
    const { reveal } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Issues (2)" }));
    fireEvent.click(screen.getByRole("button", { name: /Trace issues/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show on canvas: Trace trace: start is not connected",
      }),
    );
    expect(reveal.mock.calls[0][0]).toMatchObject({
      session: 1,
      issue: {
        pcbId: "p",
        target: { traceId: "trace", point: { x: 0, y: 0 } },
      },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("updates live and dismisses on project replacement", () => {
    const { setPcbs, setSession } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Issues (2)" }));
    setPcbs([]);
    expect(
      screen.getByText("No detected issues or unfinished work."),
    ).toBeTruthy();
    setSession(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Issues (0)" })).toBeTruthy();
  });
});
