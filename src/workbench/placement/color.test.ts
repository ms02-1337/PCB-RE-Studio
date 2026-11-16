import { it, expect } from "vitest";
import { COLOR_PALETTE, isValidColor, labelColor, parseColor, randomPaletteColor, withAlpha } from "./color";

it("validates and parses #rrggbb colors", () => {
  expect(isValidColor("#e5484d")).toBe(true);
  expect(isValidColor("#E5484D")).toBe(true);
  expect(isValidColor("#e548")).toBe(false);
  expect(isValidColor("e5484d")).toBe(false);
  expect(isValidColor("#g5484d")).toBe(false);
  expect(parseColor("#ffcd11")).toEqual({ r: 255, g: 205, b: 17 });
  expect(parseColor("nope")).toBeNull();
});

it("picks random new-type colors from the fixed palette", () => {
  expect(COLOR_PALETTE.length).toBeGreaterThan(0);
  for (const color of COLOR_PALETTE) expect(isValidColor(color)).toBe(true);
  for (let pick = 0; pick < 40; pick++) expect(COLOR_PALETTE).toContain(randomPaletteColor());
});

it("blends alpha fills", () => {
  expect(withAlpha("#ffcd11", 0.22)).toBe("rgba(255, 205, 17, 0.22)");
  expect(withAlpha("#000000", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
  expect(withAlpha("bad", 0.5)).toBe("bad");
});

it("picks contrasting label colors by YIQ luminance", () => {
  expect(labelColor("#d8d8d8")).toBe("#111827");
  expect(labelColor("#ffcd11")).toBe("#111827");
  expect(labelColor("#8a8a8a")).toBe("#111827");
  expect(labelColor("#707070")).toBe("#f9fafb");
  expect(labelColor("#e5484d")).toBe("#f9fafb");
  expect(labelColor("bad")).toBe("#f9fafb");
});
