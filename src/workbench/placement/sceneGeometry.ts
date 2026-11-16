import type { Board, Component, Point } from "./projectDoc";
import { bbox } from "./geometry";
import type { Size, View } from "./view";
import { displaySize, displayToImage, visibleImageRect } from "./boardTransform";
import { fitView } from "./view";

export function sceneBounds(boards: Board[], components: Component[] = []) {
  if (!boards.length && !components.length) return { x: 0, y: 0, width: 1, height: 1 };
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const board of boards) {
    const size = displaySize(board);
    const left = board.sceneX ?? 0, top = board.sceneY ?? 0;
    x = Math.min(x, left); y = Math.min(y, top);
    right = Math.max(right, left + size.width); bottom = Math.max(bottom, top + size.height);
  }
  for (const component of components) {
    const box = bbox(component.shape);
    x = Math.min(x, box.x); y = Math.min(y, box.y);
    right = Math.max(right, box.x + box.w); bottom = Math.max(bottom, box.y + box.h);
  }
  return { x, y, width: right - x, height: bottom - y };
}

export function fitScene(viewport: Size, boards: Board[], cap?: number, components: Component[] = []): View {
  const bounds = sceneBounds(boards, components);
  const fitted = fitView(viewport, bounds, cap);
  return { ...fitted, offsetX: fitted.offsetX - bounds.x * fitted.scale, offsetY: fitted.offsetY - bounds.y * fitted.scale };
}

/** Last image is visually on top. Cropping/transforms use original-pixel hit tests. */
export function hitSceneImage(boards: Board[], point: Point): Board | undefined {
  for (let index = boards.length - 1; index >= 0; index--) {
    const board = boards[index];
    const local = displayToImage(board, point);
    const rect = visibleImageRect(board);
    if (local.x >= rect.x && local.y >= rect.y && local.x <= rect.x + rect.w && local.y <= rect.y + rect.h) return board;
  }
  return undefined;
}

/** Labels below 8 CSS pixels are omitted rather than moved outside a marking. */
export function labelFontSize(width: number, height: number, textLength: number): number | null {
  const size = Math.min(16, (width - 6) / Math.max(1, textLength * 0.8), (height - 4) * 0.7);
  return size >= 8 ? size : null;
}
