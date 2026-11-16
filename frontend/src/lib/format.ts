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
 * "Jamnagar, Gujarat" — the site as one line.
 *
 * The location is typed by hand and often already ends with the state, so the
 * state is only appended when it is not already there. Printing it twice makes
 * a single site read like two.
 */
export function siteLabel(row: {
  siteLocation: string;
  siteState?: { name: string } | null;
  siteStateCode?: string;
}): string {
  const location = titleCase(row.siteLocation.trim());
  const state = row.siteState?.name ? titleCase(row.siteState.name) : row.siteStateCode ?? "";
  if (state === "") return location;
  return location.toLowerCase().includes(state.toLowerCase()) ? location : `${location}, ${state}`;
}

/**
 * "Crawler Crane · 250 t" repeats the noun; next to a capacity the type alone is
 * what the buyer scans for, so the trailing "Crane" is dropped for display.
 */
export function craneTypeLabel(name: string | null | undefined): string {
  return (name ?? "Crane").replace(/\s+Crane$/i, "");
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

/**
 * A calendar date, printed as the UTC day it names.
 *
 * Brief 6.4 anchors calendar dates (required start, quote validity, available
 * from) at UTC midnight so the stored date means the same thing everywhere.
 * Formatting that instant in the browser's own zone shifts it by a day for
 * anyone west of UTC — `2026-01-01T00:00:00Z` would print as 31 December, which
 * is a deadline stated wrongly. Only calendar dates belong here; a real moment in
 * time, such as a submission deadline, still uses `formatDateTime`.
 */
export function formatCalendarDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { timeZone: "UTC" });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
