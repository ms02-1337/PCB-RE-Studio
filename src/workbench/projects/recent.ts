// Recent-projects list, persisted locally (never in the project file).
// Pure storage helpers: the store records entries when a project is
// created/opened/saved-as and forgets one when its file is deleted.

export interface RecentProject {
  path: string;
  name: string;
  /** Epoch milliseconds of the last open. */
  at: number;
}

export const RECENT_STORAGE_KEY = "pcb-re-studio.recentProjects";
export const RECENT_LIMIT = 10;

function isValidEntry(value: unknown): value is RecentProject {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { path?: unknown; name?: unknown; at?: unknown };
  return (
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    typeof entry.name === "string" &&
    typeof entry.at === "number" &&
    Number.isFinite(entry.at)
  );
}

/** Loads the list; corrupt JSON, non-array payloads, and invalid entries
 * are dropped so one bad row never blanks the list. */
export function loadRecent(): RecentProject[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(RECENT_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidEntry);
}

function saveRecent(entries: RecentProject[]): void {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* Recents are best-effort; storage failures keep the session usable. */
  }
}

/** Records (or re-records) a project: deduped by exact path string,
 * most-recent-first, capped at RECENT_LIMIT entries. */
export function addRecent(path: string, name: string): void {
  const entries = loadRecent().filter((entry) => entry.path !== path);
  entries.unshift({ path, name, at: Date.now() });
  saveRecent(entries.slice(0, RECENT_LIMIT));
}

export function removeRecent(path: string): void {
  saveRecent(loadRecent().filter((entry) => entry.path !== path));
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Nov 15 12:03"-style local stamp for a recent entry; "" when invalid. */
export function formatRecentAt(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
