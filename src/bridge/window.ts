import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const hasNativeWindow = () => isTauri();
export type WindowAction =
  "minimize" | "toggleMaximize" | "close" | "startDragging";
export async function runWindowAction(action: WindowAction): Promise<void> {
  if (!isTauri()) return;
  try {
    await getCurrentWindow()[action]();
  } catch {
    throw new Error("The window action could not be completed.");
  }
}
export async function watchMaximized(
  onChange: (value: boolean) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    const appWindow = getCurrentWindow();
    let active = true;
    const update = async () => {
      const value = await appWindow.isMaximized();
      if (active) onChange(value);
    };
    const unlisten = await appWindow.onResized(() => {
      void update().catch(() => {});
    });
    try {
      await update();
    } catch {
      unlisten();
      throw new Error();
    }
    return () => {
      active = false;
      unlisten();
    };
  } catch {
    throw new Error("Window state could not be loaded.");
  }
}
