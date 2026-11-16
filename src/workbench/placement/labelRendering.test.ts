import { expect, it, vi } from "vitest";
import type { Component, Shape } from "./projectDoc";
import { drawLabel } from "./CanvasStage";

function context() {
  const calls: string[] = [];
  const fake = Object.fromEntries(["save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "ellipse", "clip", "strokeText", "fillText"].map((name) => [name, vi.fn(() => calls.push(name))]));
  return { fake, calls, ctx: fake as unknown as CanvasRenderingContext2D };
}
const component = (shape: Shape): Component => ({ id: "c", boardId: "b", refdes: "R1", typeId: "r", locked: false, status: "unknown", shape });

it.each<Shape>([
  { rect: { x: 0, y: 0, w: 100, h: 60 } },
  { ellipse: { cx: 50, cy: 30, rx: 50, ry: 30 } },
  { polygon: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 60 }] } },
])("clips labels to their actual shape before drawing text: %j", (shape) => {
  const { fake, calls, ctx } = context();
  drawLabel(ctx, component(shape), "#ffcd11", (point) => point);
  expect(fake.clip).toHaveBeenCalledOnce();
  expect(calls.indexOf("clip")).toBeLessThan(calls.indexOf("fillText"));
  expect(fake.fillText).toHaveBeenCalledOnce();
  if ("ellipse" in shape) expect(fake.ellipse).toHaveBeenCalledWith(50, 30, 50, 30, 0, 0, Math.PI * 2);
  else expect(fake.closePath).toHaveBeenCalledOnce();
  expect(calls.at(-1)).toBe("restore");
});

it("does no canvas label work when zoom makes the marking unreadable", () => {
  const { calls, ctx } = context();
  drawLabel(ctx, component({ rect: { x: 0, y: 0, w: 100, h: 60 } }), "#ffcd11", (point) => ({ x: point.x * 0.05, y: point.y * 0.05 }));
  expect(calls).toEqual([]);
});
