import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@solidjs/testing-library";
import { createPlacementStore } from "../placement/store";
import { SEED_TYPES, type ProjectDoc } from "../placement/projectDoc";
import { VisualPanel } from "./VisualPanel";
import { ValuePromptModal } from "./ValuePromptModal";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("../../bridge/project", async (original) => ({ ...await original<object>(), assetRead: vi.fn(async () => new ArrayBuffer(0)) }));
// The full parallel suite can starve workers on slower machines (userEvent
// awaits setTimeout(0) between events), which falsely trips the 5s default.
vi.setConfig({ testTimeout: 20000 });
const asset = { hash: "a".repeat(64), size: 42, name: "photo.png" };
let store: ReturnType<typeof createPlacementStore>;
beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const doc: ProjectDoc = { schemaVersion: 1, name: "Test", createdAt: "t", updatedAt: "t", types: SEED_TYPES, boards: [], components: [], assets: {} };
  store = createPlacementStore({ openProject: async () => ({ doc, assets: {}, path: "C:\\test.pcbre" }), save: vi.fn() });
  await store.openProject("C:\\test.pcbre");
  store.configureAutosave({ enabled: false, delayMs: 2000 });
});
afterEach(() => { store.dispose(); vi.restoreAllMocks(); });
it("flips both axes through focused controls and supports undo", async () => {
  const user = userEvent.setup();
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  render(() => <VisualPanel store={store} active />);
  await user.click(screen.getByText("Flip"));
  const horizontal = screen.getByRole("checkbox", { name: "Horizontal" });
  const vertical = screen.getByRole("checkbox", { name: "Vertical" });
  await user.click(horizontal);
  expect(store.visual.activePcb()!.images[0].flipH).toBe(true);
  expect(screen.getByRole("checkbox", { name: "Horizontal" })).toBe(horizontal);
  expect(document.activeElement).toBe(horizontal);
  expect(screen.getByText("Flip").closest("details")!.open).toBe(true);
  await user.click(vertical);
  expect(screen.getByRole("checkbox", { name: "Vertical" })).toBe(vertical);
  expect(document.activeElement).toBe(vertical);
  expect(store.visual.activePcb()!.images[0]).toMatchObject({ flipH: true, flipV: true });
  store.undo(); expect(store.visual.activePcb()!.images[0]).toMatchObject({ flipH: true, flipV: false });
  await user.click(screen.getByRole("checkbox", { name: "Horizontal" }));
  expect(store.visual.activePcb()!.images[0].flipH).toBe(false);
  await user.click(screen.getByRole("button", { name: "Lock Front" }));
  await user.click(screen.getByText("Flip"));
  const lockedHorizontal = screen.getByRole("checkbox", { name: "Horizontal" });
  expect(lockedHorizontal.hasAttribute("disabled")).toBe(true);
  await user.click(lockedHorizontal);
  expect(store.visual.activePcb()!.images[0].flipH).toBe(false);
});
it("dismisses the flip menu when focus leaves for a non-DOM target", () => {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  render(() => <VisualPanel store={store} active />);
  const details = screen.getByText("Flip").closest("details")!;
  details.open = true;
  const errors: unknown[] = [];
  const capture = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener("error", capture);
  try {
    fireEvent.focusOut(screen.getByRole("checkbox", { name: "Horizontal" }), { relatedTarget: new document.defaultView!.EventTarget() });
    expect(errors).toEqual([]);
    expect(details.open).toBe(false);
  } finally { window.removeEventListener("error", capture); }
});
it("shows the tool toolbar with gated enablement and independent PCB tabs", () => {
  render(() => <VisualPanel store={store} active />);
  const tools = screen.getByRole("toolbar", { name: "Visual editor tools" });
  const buttons = within(tools).getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual(["Add image", "Measure", "Calibrate", "Rotate", "Align", "Crop", "Resize", "Deskew", "", "", ""]);
  expect(buttons.slice(0, 8).every((button) => button.hasAttribute("disabled"))).toBe(true);
  expect(within(tools).getByRole("button", { name: "Flip view horizontally" }).hasAttribute("disabled")).toBe(false);
  expect(within(tools).getByRole("button", { name: "Flip view vertically" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("complementary", { name: "Selection details" }).textContent).toBe("Selection details›");
  fireEvent.click(screen.getByRole("button", { name: "Add visual PCB" }));
  expect(store.visual.editor()!.pcbs).toHaveLength(2); expect(store.mappingTabs()).toHaveLength(1);
});
it("enables tools only for a selection, gates transforms on lock and toggles aria-pressed", () => {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  render(() => <VisualPanel store={store} active />);
  const toolButtons = ["Measure", "Calibrate", "Rotate", "Align", "Crop", "Resize"].map((name) => screen.getByRole("button", { name }));
  for (const button of toolButtons) expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Front" }));
  for (const button of toolButtons) expect(button.hasAttribute("disabled")).toBe(false);
  const measure = screen.getByRole("button", { name: "Measure" });
  fireEvent.click(measure);
  expect(measure.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(measure);
  expect(measure.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Lock Front" }));
  for (const name of ["Rotate", "Align", "Crop", "Resize"]) expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
  for (const name of ["Measure", "Calibrate"]) expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "Deskew" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Deskew" }).title).toBe("Deskew is not implemented yet");
});
it("flips the view without marking the project dirty and resets on scene change", () => {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  render(() => <VisualPanel store={store} active />);
  const before = JSON.stringify(store.doc());
  const saveBefore = store.saveState();
  const flipH = screen.getByRole("button", { name: "Flip view horizontally" });
  const flipV = screen.getByRole("button", { name: "Flip view vertically" });
  expect(flipH.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(flipH);
  expect(flipH.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(flipV);
  expect(flipV.getAttribute("aria-pressed")).toBe("true");
  expect(store.saveState()).toBe(saveBefore);
  expect(JSON.stringify(store.doc())).toBe(before);
  store.visual.addPcb();
  expect(flipH.getAttribute("aria-pressed")).toBe("false");
  expect(flipV.getAttribute("aria-pressed")).toBe("false");
});
it("edits independent card settings and leaves details empty", () => {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  render(() => <VisualPanel store={store} active />);
  fireEvent.click(screen.getByRole("button", { name: "Hide Front" }));
  expect(store.visual.activePcb()!.images[0].visible).toBe(false);
  const slider = screen.getByRole("slider", { name: "Opacity for Front" });
  fireEvent.input(slider, { target: { value: "35" } }); fireEvent.change(slider, { target: { value: "35" } });
  expect(store.visual.activePcb()!.images[0].opacity).toBe(0.35);
  fireEvent.click(screen.getByRole("button", { name: "Lock Front" }));
  expect(store.visual.activePcb()!.images[0].locked).toBe(true);
  expect(screen.getByRole("checkbox", { name: "Horizontal", hidden: true }).hasAttribute("disabled")).toBe(true);
  fireEvent.dblClick(screen.getByRole("button", { name: "Front" }));
  fireEvent.input(screen.getByRole("textbox", { name: "Image name" }), { target: { value: "New name" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Image name" }), { key: "Enter" });
  expect(store.visual.activePcb()!.images[0].name).toBe("New name");
});
it("confirms assigned inner-layer removal and can cancel it", () => {
  store.visual.resizeLayers(8); store.visual.addImage(store.visual.activePcb()!.id, asset, "Inner", 100, 80);
  store.visual.updateImage(store.visual.activePcb()!.images[0].id, { layerId: store.visual.activePcb()!.layers[5] });
  render(() => <VisualPanel store={store} active />);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Visual editor settings" }));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "4" } });
  expect(confirm).toHaveBeenCalled(); expect(store.visual.activePcb()!.layers).toHaveLength(8);
  confirm.mockReturnValue(true); fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "4" } });
  expect(store.visual.activePcb()!.images[0].layerId).toBeUndefined();
});
it("groups opacity gestures in one undo entry and preserves image settings across save/reopen", async () => {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  render(() => <VisualPanel store={store} active />);
  const slider = screen.getByRole("slider", { name: "Opacity for Front" });
  fireEvent.input(slider, { target: { value: "80" } }); fireEvent.input(slider, { target: { value: "40" } }); fireEvent.change(slider, { target: { value: "40" } });
  expect(store.visual.activePcb()!.images[0].opacity).toBe(0.4); store.undo(); expect(store.visual.activePcb()!.images[0].opacity).toBe(1); store.redo();
  const snapshot = JSON.parse(JSON.stringify(store.doc())) as ProjectDoc;
  const reopened = createPlacementStore({ openProject: async () => ({ doc: snapshot, assets: snapshot.assets, path: "C:\\test.pcbre" }) });
  await reopened.openProject("C:\\test.pcbre"); expect(reopened.visual.activePcb()!.images[0].opacity).toBe(0.4); reopened.dispose();
});
it("opens settings only in a modal and contains/restores keyboard focus", () => {
  render(() => <VisualPanel store={store} active />);
  expect(screen.queryByRole("spinbutton")).toBeNull();
  const settings = screen.getByRole("button", { name: "Visual editor settings" });
  fireEvent.click(settings);
  const dialog = screen.getByRole("dialog", { name: "Visual editor settings" });
  const field = within(dialog).getByRole("spinbutton", { name: "Copper layers" });
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: "Tab", shiftKey: true });
  const close = within(dialog).getByRole("button", { name: "Close" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab" }); expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "8" } }); expect(store.visual.activePcb()!.layers).toHaveLength(8);
  fireEvent.change(field, { target: { value: "1025" } }); expect((field as HTMLInputElement).value).toBe("8");
  fireEvent.keyDown(field, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(settings);
  fireEvent.click(settings); fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(settings); fireEvent.click(screen.getByRole("dialog").parentElement!);
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(settings);
});
it("closes stale settings on PCB, workspace and project changes", async () => {
  const { createSignal } = await import("solid-js");
  const [active, setActive] = createSignal(true);
  render(() => <VisualPanel store={store} active={active()} />);
  const settings = screen.getByRole("button", { name: "Visual editor settings" });
  fireEvent.click(settings); store.visual.addPcb(); expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(settings); setActive(false); expect(screen.queryByRole("dialog")).toBeNull();
  setActive(true); fireEvent.click(settings); await store.openProject("C:\\test.pcbre");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("warns before transforming a warped photograph and honors declining", () => {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  const image = store.visual.activePcb()!.images[0];
  store.visual.updateImageTransform(image.id, { warp: { a: 1.04, b: 0.01, c: 0, d: 1 } });
  render(() => <VisualPanel store={store} active />);
  fireEvent.click(screen.getByRole("button", { name: "Front" }));
  const rotate = screen.getByRole("button", { name: "Rotate" });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(rotate);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0]).toContain("Front");
  expect(confirm.mock.calls[0][0]).toContain("alignments");
  expect(rotate.getAttribute("aria-pressed")).toBe("false");
  confirm.mockReturnValue(true);
  fireEvent.click(rotate);
  expect(rotate.getAttribute("aria-pressed")).toBe("true");
  // Measure needs no rewarp confirmation even while warps exist.
  fireEvent.click(screen.getByRole("button", { name: "Measure" }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Measure" }).getAttribute("aria-pressed")).toBe("true");
  expect(rotate.getAttribute("aria-pressed")).toBe("false");
});
it("warns when any sibling photograph carries a warp", () => {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Back", 100, 80);
  store.visual.updateImageTransform(store.visual.activePcb()!.images[1].id, { warp: { a: 1, b: 0.05, c: 0, d: 1 } });
  render(() => <VisualPanel store={store} active />);
  fireEvent.click(screen.getByRole("button", { name: "Front" }));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const crop = screen.getByRole("button", { name: "Crop" });
  fireEvent.click(crop);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(crop.getAttribute("aria-pressed")).toBe("false");
});

describe("ValuePromptModal contract", () => {
  const mount = (confirm: () => void, cancel: () => void, skipLabel?: string) => {
    const opener = document.createElement("button");
    opener.textContent = "Opener"; document.body.append(opener); opener.focus();
    const view = render(() => <ValuePromptModal title="Calibrate PCB scale" message="Measured 50.0 px. Enter the real length in mm:" unit="mm" skipLabel={skipLabel} onConfirm={confirm} onCancel={cancel} restoreFocusTo={opener} />);
    return { opener, view, input: screen.getByRole("textbox", { name: "Value in mm" }) as HTMLInputElement };
  };
  it("autofocuses, rejects invalid input inline and confirms on Enter", () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    const { opener, input } = mount(onConfirm, onCancel);
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: "junk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("positive");
    fireEvent.input(input, { target: { value: "-3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.input(input, { target: { value: "25" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(25);
    expect(document.activeElement).toBe(opener);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });
  it("closes on Escape, Cancel and backdrop and traps Tab focus", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(), onCancel = vi.fn();
    const { opener, view, input } = mount(onConfirm, onCancel, "Skip this axis");
    const dialog = screen.getByRole("dialog", { name: "Calibrate PCB scale" });
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Cancel", "Skip this axis", "Confirm"]);
    await user.tab({ shift: true });
    expect(document.activeElement?.textContent).toBe("Confirm");
    await user.tab();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(view.container.querySelector(".overlay")!);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });
  it("sends the skip reply as zero", () => {
    const onConfirm = vi.fn();
    const { input } = mount(onConfirm, vi.fn(), "Skip this axis");
    fireEvent.click(screen.getByRole("button", { name: "Skip this axis" }));
    expect(onConfirm).toHaveBeenCalledWith(0);
    expect(input.value).toBe("");
  });
});

/** Canvas pointer helper: MouseEvent + pointer fields (jsdom has no
 * PointerEvent constructor), with capture stubs like the reorder fixture. */
function canvasFixture() {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Front", 100, 80);
  const view = render(() => <VisualPanel store={store} active />);
  fireEvent.click(screen.getByRole("button", { name: "Front" }));
  const canvas = view.container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
  Object.defineProperties(canvas, {
    setPointerCapture: { value: vi.fn() },
    hasPointerCapture: { value: () => false },
    releasePointerCapture: { value: vi.fn() },
  });
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, "pointerId", { value: 3 });
    Object.defineProperty(event, "buttons", { value: type === "pointerup" ? 0 : 1 });
    fireEvent(canvas, event);
  };
  return { canvas, pointer, view };
}

// The two flows below exercise the full canvas → controller → modal → store
// path. They depend on the real toolController implementation (sibling-owned);
// with the placeholder controller they fail at the first dialog lookup.
it("calibrates the PCB through the canvas calibrate flow and the value modal", async () => {
  const { pointer } = canvasFixture();
  fireEvent.click(screen.getByRole("button", { name: "Calibrate" }));
  expect(screen.getByRole("button", { name: "Calibrate" }).getAttribute("aria-pressed")).toBe("true");
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 150, 100);
  pointer("pointerup", 150, 100);
  const dialog = await screen.findByRole("dialog", { name: "Calibrate PCB scale" });
  expect(within(dialog).getByText("Measured 50.0 px. Enter the real length in mm:")).toBeTruthy();
  fireEvent.input(within(dialog).getByRole("textbox", { name: "Value in mm" }), { target: { value: "5" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  expect(store.visual.activePcb()!.pxPerMm).toBeCloseTo(10, 6);
});
it("keeps the tool alive when the modal is dismissed with Escape", async () => {
  const { pointer } = canvasFixture();
  fireEvent.click(screen.getByRole("button", { name: "Calibrate" }));
  pointer("pointerdown", 100, 100);
  pointer("pointerup", 150, 100);
  const dialog = await screen.findByRole("dialog", { name: "Calibrate PCB scale" });
  fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "Value in mm" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Calibrate" }).getAttribute("aria-pressed")).toBe("true");
});
it("skips a resize axis with zero and commits nothing yet", async () => {
  const { pointer } = canvasFixture();
  fireEvent.click(screen.getByRole("button", { name: "Resize" }));
  pointer("pointerdown", 100, 100);
  pointer("pointerup", 150, 100);
  const dialog = await screen.findByRole("dialog", { name: "Set real width" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Skip this axis" }));
  expect(store.visual.activePcb()!.images[0].warp).toBeUndefined();
  pointer("pointerdown", 100, 100);
  pointer("pointerup", 100, 150);
  const second = await screen.findByRole("dialog", { name: "Set real height" });
  fireEvent.keyDown(within(second).getByRole("textbox", { name: "Value in mm" }), { key: "Escape" });
  expect(store.visual.activePcb()!.images[0].warp).toBeUndefined();
});

function pointer(target: HTMLElement, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}
function reorderFixture() {
  store.visual.addImage(store.visual.activePcb()!.id, asset, "First", 100, 80);
  store.visual.addImage(store.visual.activePcb()!.id, asset, "Second", 100, 80);
  const view = render(() => <VisualPanel store={store} active />);
  const handle = screen.getByRole("button", { name: "Reorder First" });
  const source = handle.closest<HTMLElement>("article")!;
  const target = screen.getByRole("button", { name: "Second" }).closest<HTMLElement>("article")!;
  Object.defineProperties(handle, {
    setPointerCapture: { value: vi.fn() }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: vi.fn() },
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
  return { ...view, handle, source, target };
}
it("previews pointer reorder without changing order, commits once and supports undo", () => {
  const { handle, source, target } = reorderFixture();
  const original = store.visual.activePcb()!.images.map((image) => image.id);
  pointer(handle, "pointerdown", 10, 10);
  pointer(handle, "pointermove", 11, 11);
  expect(source.classList.contains("is-dragging")).toBe(false);
  pointer(handle, "pointermove", 10, 100);
  expect(source.classList.contains("is-dragging")).toBe(true);
  expect(target.classList.contains("is-drop-target")).toBe(true);
  expect(store.visual.activePcb()!.images.map((image) => image.id)).toEqual(original);
  pointer(handle, "pointerup", 10, 100);
  expect(store.visual.activePcb()!.images.map((image) => image.id)).toEqual([...original].reverse());
  store.undo(); expect(store.visual.activePcb()!.images.map((image) => image.id)).toEqual(original);
});
it.each(["pointercancel", "lostpointercapture", "escape", "outside"])("cancels reorder for %s", (reason) => {
  const { handle, target } = reorderFixture();
  const original = store.visual.activePcb()!.images.map((image) => image.id);
  pointer(handle, "pointerdown", 10, 10); pointer(handle, "pointermove", 10, 100);
  if (reason === "escape") fireEvent.keyDown(handle, { key: "Escape" });
  else if (reason === "outside") Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
  else pointer(handle, reason, 10, 100);
  pointer(handle, "pointerup", 10, 100);
  expect(store.visual.activePcb()!.images.map((image) => image.id)).toEqual(original);
  expect(target.classList.contains("is-drop-target")).toBe(false);
});
it("keeps keyboard reorder and visibly marks a closed locked icon", async () => {
  const { handle } = reorderFixture();
  const unlockedPath = screen.getByRole("button", { name: "Lock First" }).querySelector("path")!.getAttribute("d");
  fireEvent.click(screen.getByRole("button", { name: "Lock First" }));
  const locked = screen.getByRole("button", { name: "Unlock First" });
  expect(locked.classList.contains("is-locked")).toBe(true);
  expect(locked.getAttribute("aria-pressed")).toBe("true");
  expect(locked.querySelector("path")!.getAttribute("d")).not.toBe(unlockedPath);
  const original = store.visual.activePcb()!.images.map((image) => image.id);
  fireEvent.keyDown(screen.getByRole("button", { name: "Reorder First" }), { key: "ArrowUp" });
  expect(store.visual.activePcb()!.images.map((image) => image.id)).toEqual([...original].reverse());
  expect(handle.hasAttribute("draggable")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Unlock First" }));
  expect(screen.getByRole("button", { name: "Lock First" }).classList.contains("is-locked")).toBe(false);
});
