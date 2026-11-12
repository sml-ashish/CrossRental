import type { Crane } from "@/lib/fleet";

/**
 * Matching a load-chart file to a crane.
 *
 * The portal keeps one chart per crane, and the vendor names their files after
 * the crane they came from — so the serial number is the join key, exactly as it
 * is for duplicate detection (brief 6.2).
 *
 * Two rules keep this conservative:
 *
 * 1. **A wrong match is worse than no match.** Anything ambiguous is handed back
 *    for a human to resolve, never guessed.
 * 2. **Only active cranes are candidates.** Attaching a chart to a deactivated
 *    crane would be invisible work; that file is reported and the user picks an
 *    active crane instead.
 *
 * The prefix form handles the common `ISO-SERIAL-A-chart.pdf` and
 * `ISO-SERIAL-A (1).pdf`, but only when the next character is a separator — so
 * serial `CC 2500` never claims a chart for `CC 25000`.
 */

export type ChartMatch =
  | { kind: "matched"; crane: Crane; how: "exact" | "prefix" }
  | { kind: "ambiguous"; candidates: Crane[] }
  | { kind: "inactive"; crane: Crane }
  | { kind: "none" };

/** Lower-case, alphanumerics only: `AB-100` and `ab 100` are the same crane. */
export function normaliseSerial(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The file name without its final extension. */
export function fileBaseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
}

function longestFirst(cranes: Crane[]): Crane[] {
  return [...cranes].sort(
    (a, b) => b.serialRegistrationNo.length - a.serialRegistrationNo.length,
  );
}

export function matchChartFile(fileName: string, cranes: Crane[]): ChartMatch {
  const base = fileBaseName(fileName);
  const wanted = normaliseSerial(base);
  if (!wanted) return { kind: "none" };

  const active = cranes.filter((crane) => crane.isActive);

  const exact = active.filter(
    (crane) => normaliseSerial(crane.serialRegistrationNo) === wanted,
  );
  if (exact.length === 1) return { kind: "matched", crane: exact[0]!, how: "exact" };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  // `ISO-SERIAL-A-chart` / `ISO-SERIAL-A (1)`: the serial, then a separator.
  const baseLower = base.toLowerCase();
  const prefix = longestFirst(
    active.filter((crane) => {
      const serial = crane.serialRegistrationNo.trim().toLowerCase();
      if (!serial || !baseLower.startsWith(serial)) return false;
      const next = baseLower.charAt(serial.length);
      return next === "" || !/[a-z0-9]/.test(next);
    }),
  );
  if (prefix.length > 0) {
    const longest = prefix[0]!.serialRegistrationNo.trim().toLowerCase().length;
    const best = prefix.filter(
      (crane) => crane.serialRegistrationNo.trim().toLowerCase().length === longest,
    );
    if (best.length === 1) return { kind: "matched", crane: best[0]!, how: "prefix" };
    return { kind: "ambiguous", candidates: best };
  }

  // Cheap to be helpful: say when the only match is a deactivated crane.
  const inactive = cranes.filter(
    (crane) =>
      !crane.isActive &&
      normaliseSerial(crane.serialRegistrationNo) === wanted,
  );
  if (inactive.length === 1) return { kind: "inactive", crane: inactive[0]! };

  return { kind: "none" };
}
