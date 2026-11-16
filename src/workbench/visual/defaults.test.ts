import { beforeEach, expect, it } from "vitest";
import {
  COPPER_DEFAULTS_STORAGE_KEY,
  DEFAULT_COPPER_DEFAULTS,
  loadCopperDefaults,
  saveCopperDefaults,
} from "./defaults";

beforeEach(() => localStorage.clear());

it("returns the built-in defaults when nothing is stored", () => {
  expect(loadCopperDefaults()).toEqual(DEFAULT_COPPER_DEFAULTS);
});

it("round-trips saved defaults", () => {
  saveCopperDefaults({ traceWidthMm: 0.8, viaDiameterMm: 1.6, viaDrillMm: 0.6, route45: true });
  expect(loadCopperDefaults()).toEqual({
    traceWidthMm: 0.8,
    viaDiameterMm: 1.6,
    viaDrillMm: 0.6,
    route45: true,
  });
});

it("falls back field-by-field on corrupt or wrongly shaped data", () => {
  localStorage.setItem(COPPER_DEFAULTS_STORAGE_KEY, "{not json");
  expect(loadCopperDefaults()).toEqual(DEFAULT_COPPER_DEFAULTS);
  localStorage.setItem(COPPER_DEFAULTS_STORAGE_KEY, "42");
  expect(loadCopperDefaults()).toEqual(DEFAULT_COPPER_DEFAULTS);
  localStorage.setItem(
    COPPER_DEFAULTS_STORAGE_KEY,
    JSON.stringify({ traceWidthMm: 0.25, viaDiameterMm: "big", viaDrillMm: -1, route45: 1 }),
  );
  // A valid field survives next to broken ones.
  expect(loadCopperDefaults()).toEqual({ ...DEFAULT_COPPER_DEFAULTS, traceWidthMm: 0.25 });
});

it("rejects out-of-range dimensions", () => {
  localStorage.setItem(
    COPPER_DEFAULTS_STORAGE_KEY,
    JSON.stringify({ traceWidthMm: 1e9, viaDiameterMm: 2, viaDrillMm: 0.4, route45: true }),
  );
  expect(loadCopperDefaults()).toEqual({
    ...DEFAULT_COPPER_DEFAULTS,
    viaDiameterMm: 2,
    viaDrillMm: 0.4,
    route45: true,
  });
});

it("reverts the via pair when the drill no longer fits the diameter", () => {
  localStorage.setItem(
    COPPER_DEFAULTS_STORAGE_KEY,
    JSON.stringify({ traceWidthMm: 0.3, viaDiameterMm: 0.5, viaDrillMm: 0.8, route45: false }),
  );
  expect(loadCopperDefaults()).toEqual({ ...DEFAULT_COPPER_DEFAULTS, traceWidthMm: 0.3 });
});
