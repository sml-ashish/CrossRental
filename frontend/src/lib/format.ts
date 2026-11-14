/**
 * Display-only text helpers.
 *
 * These never touch stored data. The CR team types site names by hand — one
 * enquiry says "pune testing" — and a list that prints that next to "Pune,
 * Maharashtra" looks like two different places. Re-casing at render time fixes
 * the list without a migration rewriting what someone actually typed.
 */

/** "pune testing" → "Pune Testing". Leaves stored values untouched. */
export function titleCase(value: string): string {
  return value.replace(/[A-Za-z][A-Za-z'’-]*/g, (word) => {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/** The city part of a free-typed site location, re-cased for display. */
export function cityOf(row: { siteLocation: string }): string {
  return titleCase(row.siteLocation.split(",")[0]?.trim() || row.siteLocation);
}

/**
 * "Crawler Crane · 250 t" repeats the noun; next to a capacity the type alone is
 * what the buyer scans for, so the trailing "Crane" is dropped for display.
 */
export function craneTypeLabel(name: string | null | undefined): string {
  return (name ?? "Crane").replace(/\s+Crane$/i, "");
}
