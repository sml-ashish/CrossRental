import type {
  CandidateCrane,
  CandidateGroup,
  CandidateMode,
  RfqDetail,
  RfqListRow,
} from "@/lib/rfqs";

/**
 * The draft picker's decision logic, kept separate from its markup.
 *
 * Everything here is pure: it turns the server's candidate list into the one
 * short, ranked list of cranes the sales user reads. The server still owns
 * eligibility — this file never decides who *may* receive an RFQ, only which of
 * the eligible cranes to put in front of the user first.
 */

/** How many cranes the recommendation shows. */
export const TOP_CRANES = 10;

/** The words under the ranking switch, so the rule is always on screen. */
export const MODE_HINTS: Record<CandidateMode, string> = {
  technical:
    "Cranes that meet the capacity requirement, free in time, smallest adequate capacity first.",
  distance: "Cranes nearest to the job site first, including lighter cranes.",
};

/** Best fit is the technical order; nearest/farthest order the same cranes by distance. */
export type PickerSort = "best" | "nearest" | "farthest";

export const PICKER_SORT_OPTIONS: ReadonlyArray<{ value: PickerSort; label: string }> = [
  { value: "best", label: "Best fit" },
  { value: "nearest", label: "Nearest first ↑" },
  { value: "farthest", label: "Farthest first ↓" },
];

/** A row-sized distance: "≈ 291 km" keeps the approximation visible. */
export function shortDistance(km: number | null, approximate: boolean): string {
  if (km === null) return "—";
  const rounded = km >= 100 ? Math.round(km) : Math.round(km * 10) / 10;
  return `${approximate ? "≈ " : ""}${rounded.toLocaleString("en-IN")} km`;
}

/** "exact", "+50 t", or "below", measured against what the RFQ asks for. */
export function headroomShort(crane: CandidateCrane, requiredT: number): string {
  if (crane.belowRequiredCapacity) return "below";
  const headroom = crane.capacityT - requiredT;
  return headroom <= 0 ? "exact" : `+${headroom} t`;
}

// --- ranking ---------------------------------------------------------------

/** The fit order behind the Technical ranking. */
function fitTuple(crane: CandidateCrane): [number, number, number, number, number] {
  return [
    crane.availableInTime ? 0 : 1,
    crane.belowRequiredCapacity ? 1 : 0,
    crane.capacityT,
    crane.yom === null ? 9999 : -crane.yom,
    crane.distanceKm === null ? 9999 : crane.distanceKm,
  ];
}

/** Available in time, smallest adequate capacity, newest, then nearest. */
export function compareFit(left: CandidateCrane, right: CandidateCrane): number {
  const a = fitTuple(left);
  const b = fitTuple(right);
  for (let index = 0; index < a.length; index += 1) {
    const diff = a[index]! - b[index]!;
    if (diff !== 0) return diff;
  }
  return left.craneId.localeCompare(right.craneId);
}

export interface CraneRow {
  crane: CandidateCrane;
  group: CandidateGroup;
}

/** One flat row per crane, with the vendor it belongs to. */
export function craneRows(groups: CandidateGroup[]): CraneRow[] {
  const rows: CraneRow[] = [];
  for (const group of groups) {
    for (const crane of group.cranes) rows.push({ crane, group });
  }
  return rows;
}

/**
 * The recommendation: the best `limit` cranes for the ranking the user chose.
 *
 * Technical reads like a spec sheet — the crane that fits the job most closely
 * comes first. Distance reads like a map — the crane closest to the site comes
 * first, with fit only breaking ties. A crane with no distance never outranks
 * one with a distance in Distance mode.
 */
export function topCraneRows(
  groups: CandidateGroup[],
  mode: CandidateMode,
  limit: number = TOP_CRANES,
  sort: PickerSort = "best",
): CraneRow[] {
  const km = (row: CraneRow) => row.crane.distanceKm ?? Number.POSITIVE_INFINITY;
  const byFit = (a: CraneRow, b: CraneRow) =>
    compareFit(a.crane, b.crane) || a.group.vendorName.localeCompare(b.group.vendorName);

  const rows = craneRows(groups);
  if (sort !== "best") {
    // A crane with no distance sits last whichever way the list runs.
    const byDistance = (a: CraneRow, b: CraneRow) => {
      const x = a.crane.distanceKm;
      const y = b.crane.distanceKm;
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return sort === "nearest" ? x - y : y - x;
    };
    return rows.sort((a, b) => byDistance(a, b) || byFit(a, b)).slice(0, limit);
  }
  const sorted =
    mode === "distance"
      ? rows.sort((a, b) => {
          const gap = km(a) - km(b);
          if (Number.isFinite(gap) && gap !== 0) return gap;
          return byFit(a, b);
        })
      : rows.sort(byFit);

  return sorted.slice(0, limit);
}

/** The distinct vendors behind a list of rows, in first-seen order. */
export function vendorIdsOf(rows: CraneRow[]): string[] {
  return [...new Set(rows.map((row) => row.group.vendorId))];
}

// --- duplicate awareness ---------------------------------------------------

export interface ContactedVendor {
  /** The other RFQ that already went out, so the history line can link to it. */
  rfqId: string;
  rfqNumber: string;
  sentAt: string | null;
  responseStatus: string;
}

export interface ContactedIndex {
  byName: Map<string, ContactedVendor>;
  /** Other drafts on the same enquiry line, so the user knows why the line looks busy. */
  otherDrafts: RfqListRow[];
}

function normalised(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Which candidate vendors have already been contacted about this enquiry line.
 *
 * The list payload carries recipients by name rather than by id, so the join is
 * on the vendor name. That is exact enough for the demo vendors and is only ever
 * used to *warn*; the send itself still targets ids. A real join needs the list
 * recipient's `vendorId` (see the backend asks).
 */
export function buildContactedIndex(
  rows: RfqListRow[],
  rfq: Pick<RfqDetail, "id" | "enquiryLineId" | "enquiryNo" | "lineNo">,
): ContactedIndex {
  const byName = new Map<string, ContactedVendor>();
  const otherDrafts: RfqListRow[] = [];

  const sameLine = (row: RfqListRow) =>
    row.id !== rfq.id &&
    ((rfq.enquiryLineId !== null && row.enquiryLineId === rfq.enquiryLineId) ||
      (rfq.enquiryNo === row.enquiryNo && rfq.lineNo === row.lineNo));

  for (const row of rows) {
    if (!sameLine(row)) continue;
    if (row.status === "DRAFT") {
      otherDrafts.push(row);
      continue;
    }
    if (row.status === "CANCELLED") continue;
    for (const recipient of row.recipients) {
      const key = normalised(recipient.vendorName);
      // Keep the most recent send if a vendor appears twice on the line.
      const existing = byName.get(key);
      if (existing) {
        const before = existing.sentAt ? new Date(existing.sentAt).getTime() : 0;
        const next = row.sentAt ? new Date(row.sentAt).getTime() : 0;
        if (next <= before) continue;
      }
      byName.set(key, {
        rfqId: row.id,
        rfqNumber: row.rfqNumber,
        sentAt: row.sentAt,
        responseStatus: recipient.responseStatus,
      });
    }
  }

  return { byName, otherDrafts };
}

export function contactFor(
  index: ContactedIndex,
  vendorName: string,
): ContactedVendor | undefined {
  return index.byName.get(normalised(vendorName));
}
