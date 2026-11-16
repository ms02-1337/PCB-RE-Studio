// Copper placement defaults (user preference, persisted locally - never in
// the project file). The copper editor seeds its trace/via parameters from
// these; the visual settings modal edits them. The bounds mirror the modal's
// input validation and the cross-field rule (drill < diameter) is enforced
// on read. Storage failures degrade to the defaults instead of throwing.

export interface CopperDefaults {
  /** Trace width in mm. */
  traceWidthMm: number;
  /** Via outer diameter in mm (strictly larger than the drill). */
  viaDiameterMm: number;
  /** Via drill in mm (strictly smaller than the diameter). */
  viaDrillMm: number;
  /** 45° routing on by default. */
  route45: boolean;
}

export const COPPER_DEFAULTS_STORAGE_KEY = "pcb-re-studio.copper-defaults";

export const MIN_COPPER_MM = 0.001;
export const MAX_COPPER_MM = 100;

export const DEFAULT_COPPER_DEFAULTS: CopperDefaults = {
  traceWidthMm: 0.5,
  viaDiameterMm: 1,
  viaDrillMm: 0.5,
  route45: false,
};

function dimension(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_COPPER_MM &&
    value <= MAX_COPPER_MM
    ? value
    : fallback;
}

/** Reads the stored defaults. Missing, corrupt, or wrongly shaped data falls
 * back field-by-field; a drill that no longer fits inside the diameter
 * reverts both via fields. */
export function loadCopperDefaults(): CopperDefaults {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COPPER_DEFAULTS_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_COPPER_DEFAULTS };
  }
  if (raw === null) return { ...DEFAULT_COPPER_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_COPPER_DEFAULTS };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_COPPER_DEFAULTS };
  }
  const record = parsed as {
    traceWidthMm?: unknown;
    viaDiameterMm?: unknown;
    viaDrillMm?: unknown;
    route45?: unknown;
  };
  let viaDiameterMm = dimension(record.viaDiameterMm, DEFAULT_COPPER_DEFAULTS.viaDiameterMm);
  let viaDrillMm = dimension(record.viaDrillMm, DEFAULT_COPPER_DEFAULTS.viaDrillMm);
  if (viaDrillMm >= viaDiameterMm) {
    viaDiameterMm = DEFAULT_COPPER_DEFAULTS.viaDiameterMm;
    viaDrillMm = DEFAULT_COPPER_DEFAULTS.viaDrillMm;
  }
  return {
    traceWidthMm: dimension(record.traceWidthMm, DEFAULT_COPPER_DEFAULTS.traceWidthMm),
    viaDiameterMm,
    viaDrillMm,
    route45:
      typeof record.route45 === "boolean" ? record.route45 : DEFAULT_COPPER_DEFAULTS.route45,
  };
}

/** Persists the defaults; storage failures keep the session usable. */
export function saveCopperDefaults(defaults: CopperDefaults): void {
  try {
    localStorage.setItem(COPPER_DEFAULTS_STORAGE_KEY, JSON.stringify(defaults));
  } catch {
    /* The defaults stay in effect for this session without storage. */
  }
}
