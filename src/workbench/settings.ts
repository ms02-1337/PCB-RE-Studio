// Autosave user preference, persisted locally (never in the project file).
// The bounds mirror the store's runtime clamps in configureAutosave; this
// module owns persistence plus validation-on-read. Storage failures degrade
// to the defaults instead of throwing.

import {
  AUTOSAVE_DELAY_MS,
  MAX_AUTOSAVE_DELAY_MS,
  MIN_AUTOSAVE_DELAY_MS,
} from "./placement/store";

export interface AutosaveSettings {
  enabled: boolean;
  delayMs: number;
}

export const AUTOSAVE_STORAGE_KEY = "pcb-re-studio.autosave";

export const DEFAULT_AUTOSAVE_SETTINGS: AutosaveSettings = {
  enabled: true,
  delayMs: AUTOSAVE_DELAY_MS,
};

function clampDelay(value: number): number {
  return Math.min(MAX_AUTOSAVE_DELAY_MS, Math.max(MIN_AUTOSAVE_DELAY_MS, value));
}

/** Reads the stored settings. Missing, corrupt, or wrongly shaped data falls
 * back to the defaults; a valid field survives next to a broken one. */
export function loadAutosaveSettings(): AutosaveSettings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(AUTOSAVE_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_AUTOSAVE_SETTINGS };
  }
  if (raw === null) return { ...DEFAULT_AUTOSAVE_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_AUTOSAVE_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_AUTOSAVE_SETTINGS };
  }
  const record = parsed as { enabled?: unknown; delayMs?: unknown };
  const enabled =
    typeof record.enabled === "boolean"
      ? record.enabled
      : DEFAULT_AUTOSAVE_SETTINGS.enabled;
  const delayMs =
    typeof record.delayMs === "number" && Number.isFinite(record.delayMs)
      ? clampDelay(record.delayMs)
      : DEFAULT_AUTOSAVE_SETTINGS.delayMs;
  return { enabled, delayMs };
}

/** Persists the settings; storage failures keep the session usable. */
export function saveAutosaveSettings(settings: AutosaveSettings): void {
  try {
    localStorage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Settings stay in effect for this session without storage. */
  }
}
