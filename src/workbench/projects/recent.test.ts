import { it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  addRecent,
  formatRecentAt,
  loadRecent,
  removeRecent,
} from "./recent";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("starts empty and records entries most-recent-first", () => {
  expect(loadRecent()).toEqual([]);
  addRecent("C:\\a\\one.pcbre", "One");
  addRecent("C:\\a\\two.pcbre", "Two");
  const entries = loadRecent();
  expect(entries.map((entry) => entry.name)).toEqual(["Two", "One"]);
  expect(entries[0].at).toBeGreaterThanOrEqual(entries[1].at);
});

it("dedupes by exact path string and refreshes the name", () => {
  addRecent("C:\\a\\one.pcbre", "One");
  addRecent("C:\\a\\two.pcbre", "Two");
  addRecent("C:\\a\\one.pcbre", "One renamed");
  const entries = loadRecent();
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ path: "C:\\a\\one.pcbre", name: "One renamed" });
  expect(entries[1].name).toBe("Two");
});

it("caps the list at ten entries, dropping the oldest", () => {
  for (let index = 0; index < RECENT_LIMIT + 2; index += 1) {
    addRecent(`C:\\a\\p${index}.pcbre`, `P${index}`);
  }
  const entries = loadRecent();
  expect(entries).toHaveLength(RECENT_LIMIT);
  expect(entries[0].path).toBe(`C:\\a\\p${RECENT_LIMIT + 1}.pcbre`);
  expect(entries[entries.length - 1].path).toBe("C:\\a\\p2.pcbre");
});

it("removes a single entry by path", () => {
  addRecent("C:\\a\\one.pcbre", "One");
  addRecent("C:\\a\\two.pcbre", "Two");
  removeRecent("C:\\a\\one.pcbre");
  expect(loadRecent().map((entry) => entry.path)).toEqual(["C:\\a\\two.pcbre"]);
  // Removing an unknown path is a no-op.
  removeRecent("C:\\a\\missing.pcbre");
  expect(loadRecent()).toHaveLength(1);
});

it("returns an empty list on corrupt JSON or non-array payloads", () => {
  localStorage.setItem(RECENT_STORAGE_KEY, "{not json");
  expect(loadRecent()).toEqual([]);
  localStorage.setItem(RECENT_STORAGE_KEY, '{"path":"x"}');
  expect(loadRecent()).toEqual([]);
});

it("drops invalid entries and keeps the valid ones", () => {
  localStorage.setItem(
    RECENT_STORAGE_KEY,
    JSON.stringify([
      { path: "C:\\ok.pcbre", name: "Ok", at: 123 },
      "C:\\not-an-object.pcbre",
      { name: "No path", at: 1 },
      { path: 7, name: "Bad path", at: 1 },
      { path: "C:\\bad-at.pcbre", name: "Bad at", at: "yesterday" },
      { path: "", name: "Empty path", at: 1 },
    ]),
  );
  expect(loadRecent()).toEqual([{ path: "C:\\ok.pcbre", name: "Ok", at: 123 }]);
});

it("tolerates unavailable storage", () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  try {
    expect(loadRecent()).toEqual([]);
    expect(() => addRecent("C:\\a\\one.pcbre", "One")).not.toThrow();
    expect(() => removeRecent("C:\\a\\one.pcbre")).not.toThrow();
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});

it("formats recent stamps as 'Mon DD HH:MM' and blanks invalid ones", () => {
  const at = new Date(2026, 10, 15, 12, 3).getTime();
  expect(formatRecentAt(at)).toBe("Nov 15 12:03");
  expect(formatRecentAt(Number.NaN)).toBe("");
});
