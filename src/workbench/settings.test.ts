import { it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AUTOSAVE_STORAGE_KEY,
  DEFAULT_AUTOSAVE_SETTINGS,
  loadAutosaveSettings,
  saveAutosaveSettings,
} from "./settings";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("returns the defaults when nothing is stored", () => {
  expect(loadAutosaveSettings()).toEqual(DEFAULT_AUTOSAVE_SETTINGS);
  expect(DEFAULT_AUTOSAVE_SETTINGS).toEqual({ enabled: true, delayMs: 2000 });
});

it("round-trips persisted settings", () => {
  saveAutosaveSettings({ enabled: false, delayMs: 5000 });
  expect(loadAutosaveSettings()).toEqual({ enabled: false, delayMs: 5000 });
});

it("falls back to the defaults on corrupt JSON", () => {
  localStorage.setItem(AUTOSAVE_STORAGE_KEY, "{not json");
  expect(loadAutosaveSettings()).toEqual(DEFAULT_AUTOSAVE_SETTINGS);
});

it("falls back to the defaults on non-object payloads", () => {
  localStorage.setItem(AUTOSAVE_STORAGE_KEY, "42");
  expect(loadAutosaveSettings()).toEqual(DEFAULT_AUTOSAVE_SETTINGS);
  localStorage.setItem(AUTOSAVE_STORAGE_KEY, "true");
  expect(loadAutosaveSettings()).toEqual(DEFAULT_AUTOSAVE_SETTINGS);
});

it("clamps out-of-bounds delays into 500-60000 ms", () => {
  localStorage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify({ enabled: true, delayMs: 10 }));
  expect(loadAutosaveSettings()).toEqual({ enabled: true, delayMs: 500 });
  localStorage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify({ enabled: true, delayMs: 999999 }));
  expect(loadAutosaveSettings()).toEqual({ enabled: true, delayMs: 60000 });
});

it("replaces non-boolean enabled and non-numeric delay values with defaults", () => {
  localStorage.setItem(
    AUTOSAVE_STORAGE_KEY,
    JSON.stringify({ enabled: "yes", delayMs: "2000" }),
  );
  expect(loadAutosaveSettings()).toEqual(DEFAULT_AUTOSAVE_SETTINGS);

  localStorage.setItem(
    AUTOSAVE_STORAGE_KEY,
    JSON.stringify({ enabled: 1, delayMs: Number.NaN }),
  );
  expect(loadAutosaveSettings()).toEqual(DEFAULT_AUTOSAVE_SETTINGS);
});

it("keeps the valid field when only one side is broken", () => {
  localStorage.setItem(
    AUTOSAVE_STORAGE_KEY,
    JSON.stringify({ enabled: false, delayMs: "fast" }),
  );
  expect(loadAutosaveSettings()).toEqual({ enabled: false, delayMs: 2000 });
});

it("tolerates unavailable storage on both read and write", () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  try {
    expect(loadAutosaveSettings()).toEqual(DEFAULT_AUTOSAVE_SETTINGS);
    expect(() => saveAutosaveSettings({ enabled: false, delayMs: 1000 })).not.toThrow();
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});
