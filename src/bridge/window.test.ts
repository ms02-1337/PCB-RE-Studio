import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  native: false,
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  startDragging: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.native }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks }));
import { runWindowAction, watchMaximized } from "./window";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.native = false;
});
it("keeps browser preview free of native calls", async () => {
  await runWindowAction("close");
  const stop = await watchMaximized(vi.fn());
  stop();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.onResized).not.toHaveBeenCalled();
});
it("dispatches native actions and normalizes failures", async () => {
  mocks.native = true;
  await runWindowAction("toggleMaximize");
  expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
  mocks.close.mockRejectedValue("internal native detail");
  await expect(runWindowAction("close")).rejects.toThrow(
    "The window action could not be completed.",
  );
});
it("tracks maximize changes and unregisters its listener", async () => {
  mocks.native = true;
  const unlisten = vi.fn();
  let resize: (() => void) | undefined;
  mocks.onResized.mockImplementation((callback: () => void) => {
    resize = callback;
    return Promise.resolve(unlisten);
  });
  mocks.isMaximized.mockResolvedValue(false);
  const changed = vi.fn();
  const stop = await watchMaximized(changed);
  expect(changed).toHaveBeenLastCalledWith(false);
  mocks.isMaximized.mockResolvedValue(true);
  resize?.();
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
  stop();
  expect(unlisten).toHaveBeenCalledOnce();
});
it("cleans up if the initial window state query fails", async () => {
  mocks.native = true;
  const unlisten = vi.fn();
  mocks.onResized.mockResolvedValue(unlisten);
  mocks.isMaximized.mockRejectedValue("native detail");
  await expect(watchMaximized(vi.fn())).rejects.toThrow(
    "Window state could not be loaded.",
  );
  expect(unlisten).toHaveBeenCalledOnce();
});
