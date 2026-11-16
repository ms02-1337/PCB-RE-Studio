// Refdes generation: max numeric suffix per prefix project-wide; gaps are
// never refilled; derived values are never stored.

import type { Component } from "./projectDoc";

export function refdesNumber(prefix: string, refdes: string): number | null {
  const match = new RegExp(`^${escapePrefix(prefix)}(\\d+)$`).exec(refdes);
  return match ? Number.parseInt(match[1], 10) : null;
}

function escapePrefix(prefix: string): string {
  return prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function nextRefdes(
  prefix: string,
  components: Pick<Component, "refdes">[],
): string {
  let max = 0;
  for (const component of components) {
    const number = refdesNumber(prefix, component.refdes);
    if (number !== null && number > max) max = number;
  }
  return `${prefix}${max + 1}`;
}

/** Refdes values used more than once; flagged inline and rejected on save. */
export function duplicateRefdes(components: Pick<Component, "refdes">[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const component of components) {
    if (seen.has(component.refdes)) duplicates.add(component.refdes);
    seen.add(component.refdes);
  }
  return duplicates;
}

export function refdesIsDuplicated(
  components: Pick<Component, "refdes">[],
  refdes: string,
): boolean {
  return duplicateRefdes(components).has(refdes);
}
