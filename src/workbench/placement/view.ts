// View transforms between board-image pixels and CSS screen pixels. The
// canvas multiplies by devicePixelRatio itself; everything here is CSS px.

import type { Point } from "./projectDoc";

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM_FACTOR = 0.25;
export const MAX_SCALE = 32;
export const FIT_SCALE_CAP = 2;
export const WHEEL_ZOOM_FACTOR = 1.1;

export function boardToScreen(view: View, point: Point): Point {
  return {
    x: point.x * view.scale + view.offsetX,
    y: point.y * view.scale + view.offsetY,
  };
}

export function screenToBoard(view: View, point: Point): Point {
  return {
    x: (point.x - view.offsetX) / view.scale,
    y: (point.y - view.offsetY) / view.scale,
  };
}

export function scaleLimits(fitScale: number): { min: number; max: number } {
  return { min: fitScale * MIN_ZOOM_FACTOR, max: MAX_SCALE };
}

export function clampScale(scale: number, fitScale: number): number {
  const { min, max } = scaleLimits(fitScale);
  return Math.min(max, Math.max(min, scale));
}

/** Zoom keeping the board point under `screen` fixed. */
export function zoomAtPoint(
  view: View,
  screen: Point,
  factor: number,
  fitScale: number,
): View {
  const scale = clampScale(view.scale * factor, fitScale);
  const ratio = scale / view.scale;
  return {
    scale,
    offsetX: screen.x - (screen.x - view.offsetX) * ratio,
    offsetY: screen.y - (screen.y - view.offsetY) * ratio,
  };
}

/** Whole-board fit, centered, initial scale capped. */
export function fitView(viewport: Size, board: Size, cap = FIT_SCALE_CAP): View {
  const safeWidth = Math.max(1, board.width);
  const safeHeight = Math.max(1, board.height);
  const scale = Math.min(
    viewport.width / safeWidth,
    viewport.height / safeHeight,
    cap,
  );
  return {
    scale,
    offsetX: (viewport.width - safeWidth * scale) / 2,
    offsetY: (viewport.height - safeHeight * scale) / 2,
  };
}

/** 100% zoom around the viewport center. */
export function scaleTo100(view: View, viewport: Size, fitScale: number): View {
  return zoomAtPoint(
    view,
    { x: viewport.width / 2, y: viewport.height / 2 },
    1 / view.scale,
    fitScale,
  );
}

export function panBy(view: View, dx: number, dy: number): View {
  return { scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}
