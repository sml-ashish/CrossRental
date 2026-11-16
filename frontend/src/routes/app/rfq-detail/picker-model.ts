import type {
  CandidateCrane,
  CandidateGroup,
  RfqDetail,
  RfqListRow,
} from "@/lib/rfqs";

/**
 * The draft picker's decision logic, kept separate from its markup.
 *
 * Everything here is pure: it turns the server's candidate list into the one
 * order, the one set of counts and the one safety signal the screen shows. The
 * server still owns eligibility — this file never decides who *may* receive an
 * RFQ, only which of the eligible vendors should be read first, and which are
 * safe to put in front of the user already ticked.
 */

export type SortMode = "best" | "nearest" | "cranes" | "name";

export const SORT_LABELS: Record<SortMode, string> = {
  best: "Best match",
  nearest: "Nearest",
  cranes: "Most matching cranes",
  name: "Name A–Z",
};

export const SORT_HINTS: Record<SortMode, string> = {
  best: "Available in time first, then nearest, then the fewest stale crane records.",
  nearest: "The vendor whose closest crane is nearest to the job site.",
  cranes: "The vendor with the most cranes matching this RFQ.",
  name: "Alphabetical by vendor name.",
};

/** Distance bands offered as filters. `0` means no limit. */
export const DISTANCE_BANDS = [0, 100, 300, 500] as const;
export type DistanceBand = (typeof DISTANCE_BANDS)[number];

/** The pre-selection rule, named so the tooltip and the code cannot drift. */
export const RECOMMENDED_MAX_KM = 500;
export const RECOMMENDED_MAX_VENDORS = 5;
/** Past this, a vendor is never pre-selected and is called out as far. */
export const FAR_KM = 800;

export interface PickerFilters {
  band: DistanceBand;
  /** Crane-level filters, shown in the "Cranes" popover. */
  minCapacity: number;
  yearFrom: number;
  availableOnly: boolean;
  hideStale: boolean;
  chartOnly: boolean;
  /** A state code, or "" for any state. */
  state: string;
}

export const EMPTY_FILTERS: PickerFilters = {
  band: 0,
  minCapacity: 0,
  yearFrom: 0,
  availableOnly: false,
  hideStale: false,
  chartOnly: false,
  state: "",
};

export function filtersActive(filters: PickerFilters): boolean {
  return (
    filters.band !== 0 ||
    filters.minCapacity > 0 ||
    filters.yearFrom > 0 ||
    filters.availableOnly ||
    filters.hideStale ||
    filters.chartOnly ||
    filters.state !== ""
  );
}

/** How many *crane* filters the popover is carrying, for its badge. */
export function craneFilterCount(filters: PickerFilters): number {
  return (
    Number(filters.minCapacity > 0) +
    Number(filters.yearFrom > 0) +
    Number(filters.availableOnly) +
    Number(filters.hideStale) +
    Number(filters.chartOnly)
  );
}

/** One crane passes when every active filter agrees. */
export function cranePasses(crane: CandidateCrane, filters: PickerFilters): boolean {
  if (filters.band !== 0) {
    if (crane.distanceKm === null) return false;
    if (crane.distanceKm > filters.band) return false;
  }
  if (filters.minCapacity > 0 && crane.capacityT < filters.minCapacity) return false;
  if (filters.yearFrom > 0 && (crane.yom === null || crane.yom < filters.yearFrom)) return false;
  if (filters.availableOnly && !crane.availableInTime) return false;
  if (filters.hideStale && crane.stale) return false;
  if (filters.chartOnly && !crane.loadChartFileName) return false;
  if (filters.state !== "" && crane.stateCode !== filters.state) return false;
  return true;
}

/**
 * Narrow a vendor to the cranes that survive the filters and the search.
 *
 * A search hit on the vendor's own name keeps all of its (filtered) cranes —
 * typing a vendor name means "show me that vendor", not "hide its cranes".
 * `null` means the vendor drops out of the list entirely, which is what feeds
 * the "N hidden by filters" count.
 */
export function narrowGroup(
  group: CandidateGroup,
  filters: PickerFilters,
  query: string,
): CandidateGroup | null {
  const term = query.trim().toLowerCase();
  const vendorMatches =
    term === "" ||
    group.vendorName.toLowerCase().includes(term) ||
    group.cranes.some((crane) =>
      `${crane.make} ${crane.model} ${crane.typeOfCraneName}`.toLowerCase().includes(term),
    );

  if (!vendorMatches) return null;

  const nameHit = term !== "" && group.vendorName.toLowerCase().includes(term);
  const cranes = group.cranes.filter(
    (crane) =>
      cranePasses(crane, filters) &&
      (nameHit ||
        term === "" ||
        `${crane.make} ${crane.model} ${crane.typeOfCraneName}`.toLowerCase().includes(term)),
  );

  if (cranes.length === 0) return null;

  const nearest = cranes.reduce<number | null>(
    (best, crane) =>
      crane.distanceKm === null ? best : best === null ? crane.distanceKm : Math.min(best, crane.distanceKm),
    null,
  );

  return {
    ...group,
    cranes,
    nearestKm: nearest ?? group.nearestKm,
  };
}

export interface VendorStats {
  count: number;
  /** Cranes free on or before the required start (all cranes when the start is TBC). */
  availableCount: number;
  staleCount: number;
  chartCount: number;
  belowCount: number;
  newestYom: number | null;
  nearestKm: number | null;
  approximate: boolean;
  states: string[];
  best: CandidateCrane | null;
  /** Best three, in the same order as `best` — what the card shows unclicked. */
  top: CandidateCrane[];
}

/** The fit order behind "Best match" and the order of the cranes in a card. */
function fitTuple(crane: CandidateCrane): [number, number, number, number, number] {
  return [
    crane.availableInTime ? 0 : 1,
    crane.belowRequiredCapacity ? 1 : 0,
    crane.capacityT,
    crane.yom === null ? 9999 : -crane.yom,
    crane.distanceKm === null ? 9999 : crane.distanceKm,
  ];
}

export function compareFit(left: CandidateCrane, right: CandidateCrane): number {
  const a = fitTuple(left);
  const b = fitTuple(right);
  for (let index = 0; index < a.length; index += 1) {
    const diff = a[index]! - b[index]!;
    if (diff !== 0) return diff;
  }
  return left.craneId.localeCompare(right.craneId);
}

/** Cranes in fit order: available in time, smallest adequate, nearest, newest. */
export function rankCranes(cranes: CandidateCrane[]): CandidateCrane[] {
  return [...cranes].sort(compareFit);
}

export function vendorStats(group: CandidateGroup): VendorStats {
  const cranes = group.cranes;
  const ranked = rankCranes(cranes);
  return {
    count: cranes.length,
    availableCount: cranes.filter((crane) => crane.availableInTime).length,
    staleCount: cranes.filter((crane) => crane.stale).length,
    chartCount: cranes.filter((crane) => crane.loadChartFileName).length,
    belowCount: cranes.filter((crane) => crane.belowRequiredCapacity).length,
    newestYom: cranes.reduce<number | null>(
      (newest, crane) =>
        crane.yom === null ? newest : newest === null ? crane.yom : Math.max(newest, crane.yom),
      null,
    ),
    nearestKm: group.nearestKm,
    approximate: group.distanceApproximate,
    states: [...new Set(cranes.map((crane) => crane.stateName))].sort(),
    best: ranked[0] ?? null,
    top: ranked.slice(0, 3),
  };
}

/** "exact fit" or "+50 t headroom", measured against what the RFQ asks for. */
export function headroomLabel(crane: CandidateCrane | null, requiredT: number): string {
  if (!crane) return "—";
  if (crane.belowRequiredCapacity) return `${crane.capacityT} t, below the requirement`;
  const headroom = crane.capacityT - requiredT;
  if (headroom <= 0) return `${crane.capacityT} t, exact fit`;
  return `${crane.capacityT} t, +${headroom} t headroom`;
}

/** The same fact, at table width: "+50 t", "exact", or "below". */
export function headroomShort(crane: CandidateCrane, requiredT: number): string {
  if (crane.belowRequiredCapacity) return "below";
  const headroom = crane.capacityT - requiredT;
  return headroom <= 0 ? "exact" : `+${headroom} t`;
}

/** A row-sized distance: "≈ 291 km" keeps the approximation visible. */
export function shortDistance(km: number | null, approximate: boolean): string {
  if (km === null) return "—";
  const rounded = km >= 100 ? Math.round(km) : Math.round(km * 10) / 10;
  return `${approximate ? "≈ " : ""}${rounded.toLocaleString("en-IN")} km`;
}

export function sortGroups(groups: CandidateGroup[], sort: SortMode): CandidateGroup[] {
  const sorted = [...groups];
  const km = (group: CandidateGroup) => group.nearestKm ?? Number.POSITIVE_INFINITY;
  switch (sort) {
    case "nearest":
      return sorted.sort((a, b) => km(a) - km(b) || a.vendorName.localeCompare(b.vendorName));
    case "cranes":
      return sorted.sort(
        (a, b) => b.cranes.length - a.cranes.length || km(a) - km(b) || a.vendorName.localeCompare(b.vendorName),
      );
    case "name":
      return sorted.sort((a, b) => a.vendorName.localeCompare(b.vendorName));
    default: {
      // "Best match" is availability first, then distance, then freshness. The
      // counts come from the narrowed group, so the order agrees with the row.
      const stats = new Map(groups.map((group) => [group.vendorId, vendorStats(group)]));
      return sorted.sort((a, b) => {
        const left = stats.get(a.vendorId);
        const right = stats.get(b.vendorId);
        const availability =
          Number((right?.availableCount ?? 0) > 0) - Number((left?.availableCount ?? 0) > 0);
        if (availability !== 0) return availability;
        const distance = km(a) - km(b);
        if (Number.isFinite(distance) && distance !== 0) return distance;
        const stale = (left?.staleCount ?? 0) - (right?.staleCount ?? 0);
        if (stale !== 0) return stale;
        return a.vendorName.localeCompare(b.vendorName);
      });
    }
  }
}

/**
 * "5 of 7 available before start", or a warning when none is.
 *
 * With a TBC start the server skipped the date check, so claiming availability
 * would be a fact the data does not carry.
 */
export function availabilityLine(
  stats: VendorStats,
  startDateTbc: boolean,
  startLabel: string,
): { text: string; tone: "neutral" | "warning" } {
  if (startDateTbc) {
    return { text: "Availability not checked — start date TBC", tone: "neutral" };
  }
  if (stats.availableCount === 0) {
    return { text: `None available before ${startLabel}`, tone: "warning" };
  }
  return {
    text: `${stats.availableCount} of ${stats.count} available before ${startLabel}`,
    tone: "neutral",
  };
}

// --- all-cranes view -------------------------------------------------------

export type CraneSortKey =
  | "best"
  | "crane"
  | "capacity"
  | "year"
  | "availability"
  | "location"
  | "distance"
  | "vendor";

export const CRANE_SORT_LABELS: Record<CraneSortKey, string> = {
  best: "Best match",
  crane: "Crane",
  capacity: "Capacity",
  year: "Year",
  availability: "Availability",
  location: "Location",
  distance: "Distance",
  vendor: "Vendor",
};

export interface CraneRow {
  crane: CandidateCrane;
  group: CandidateGroup;
}

/** One flat row per matching crane, with the vendor it belongs to. */
export function craneRows(groups: CandidateGroup[]): CraneRow[] {
  const rows: CraneRow[] = [];
  for (const group of groups) {
    for (const crane of group.cranes) rows.push({ crane, group });
  }
  return rows;
}

const compareText = (a: string, b: string) => a.localeCompare(b);

export function sortCraneRows(rows: CraneRow[], sort: CraneSortKey): CraneRow[] {
  const sorted = [...rows];
  const km = (row: CraneRow) => row.crane.distanceKm ?? Number.POSITIVE_INFINITY;
  const name = (row: CraneRow) => `${row.crane.make} ${row.crane.model}`;
  switch (sort) {
    case "crane":
      return sorted.sort((a, b) => compareText(name(a), name(b)));
    case "capacity":
      return sorted.sort((a, b) => a.crane.capacityT - b.crane.capacityT);
    case "year":
      return sorted.sort((a, b) => (a.crane.yom ?? 0) - (b.crane.yom ?? 0));
    case "availability": {
      const order = (row: CraneRow) =>
        row.crane.availableInTime ? 0 : 1;
      return sorted.sort(
        (a, b) =>
          order(a) - order(b) ||
          (a.crane.availableFrom ?? "").localeCompare(b.crane.availableFrom ?? ""),
      );
    }
    case "location":
      return sorted.sort((a, b) =>
        compareText(`${a.crane.currentLocation}`, `${b.crane.currentLocation}`),
      );
    case "distance":
      return sorted.sort((a, b) => km(a) - km(b));
    case "vendor":
      return sorted.sort((a, b) =>
        compareText(a.group.vendorName, b.group.vendorName) || compareFit(a.crane, b.crane),
      );
    default:
      // Fit compares two cranes on the same terms the cards rank them by; the
      // vendor name only breaks a tie so the order is stable when scrolling.
      return sorted.sort(
        (a, b) => compareFit(a.crane, b.crane) || compareText(a.group.vendorName, b.group.vendorName),
      );
  }
}

/**
 * The vendors that are safe to tick before the user has read anything.
 *
 * "Safe" is deliberately conservative: the vendor has a crane free in time, its
 * nearest crane is within the named constant (when the server could measure),
 * and it has not already been sent this enquiry line. The cap exists so a big
 * fleet does not become a default mass-send.
 */
export function recommendedVendorIds(
  groups: CandidateGroup[],
  options: {
    distancesAvailable: boolean;
    contacted: (vendorName: string) => boolean;
    cap?: number;
  },
): string[] {
  const eligible = groups.filter((group) => {
    if (options.contacted(group.vendorName)) return false;
    if (!group.cranes.some((crane) => crane.availableInTime)) return false;
    if (group.nearestKm !== null && group.nearestKm > FAR_KM) return false;
    if (!options.distancesAvailable) return true;
    return group.nearestKm !== null && group.nearestKm <= RECOMMENDED_MAX_KM;
  });

  return sortGroups(eligible, "best")
    .slice(0, options.cap ?? RECOMMENDED_MAX_VENDORS)
    .map((group) => group.vendorId);
}

/** What the rail says is "in play", from the selected groups as they stand. */
export function selectionStats(groups: CandidateGroup[]): {
  vendors: number;
  cranes: number;
  nearestKm: number | null;
  farthestKm: number | null;
  approximate: boolean;
  farNames: string[];
} {
  const distances = groups
    .filter((group) => group.nearestKm !== null)
    .map((group) => ({ km: group.nearestKm as number, approximate: group.distanceApproximate }));

  const nearest = distances.reduce<{ km: number; approximate: boolean } | null>(
    (best, entry) => (best === null || entry.km < best.km ? entry : best),
    null,
  );
  const farthest = distances.reduce<{ km: number; approximate: boolean } | null>(
    (worst, entry) => (worst === null || entry.km > worst.km ? entry : worst),
    null,
  );

  return {
    vendors: groups.length,
    cranes: groups.reduce((total, group) => total + group.cranes.length, 0),
    nearestKm: nearest?.km ?? null,
    farthestKm: farthest?.km ?? null,
    approximate: Boolean(nearest?.approximate ?? farthest?.approximate),
    farNames: groups
      .filter((group) => group.nearestKm !== null && group.nearestKm > FAR_KM)
      .map((group) => group.vendorName),
  };
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

/**
 * The quick presets replace the selection rather than add to it, so "Nearest 3"
 * means three vendors even when the list already had a shortlist.
 */
export function presetNearest(groups: CandidateGroup[], count: number): string[] {
  return [...groups]
    .sort((a, b) => (a.nearestKm ?? Infinity) - (b.nearestKm ?? Infinity))
    .slice(0, count)
    .map((group) => group.vendorId);
}

export function presetWithin(groups: CandidateGroup[], km: number): string[] {
  return groups
    .filter((group) => group.nearestKm !== null && group.nearestKm <= km)
    .map((group) => group.vendorId);
}

export function presetAvailable(groups: CandidateGroup[]): string[] {
  return groups
    .filter((group) => group.cranes.some((crane) => crane.availableInTime))
    .map((group) => group.vendorId);
}
