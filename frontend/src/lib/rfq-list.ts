import { cityOf } from "./format";
import type { MessageChannel, RfqListRow, RfqStatus } from "./rfqs";

/**
 * Client-side view logic for the RFQ tracking list.
 *
 * The list endpoint still does the search and the status/awaiting filter. These
 * helpers only narrow, sort and describe the rows that came back, so a change of
 * tab or sort never costs a request and the counts can be derived from the same
 * rows the list is showing.
 */

/** Optional fields the list service does not shape yet (see the backend asks). */
export interface RfqRow extends RfqListRow {
  quotationCount?: number;
  lowestQuoteTotal?: number | null;
  lastActivityAt?: string | null;
  createdByName?: string | null;
  lastChannels?: MessageChannel[];
  /** The service currently leaks Prisma's `_count`; read it when present. */
  _count?: { recipients?: number; quotations?: number };
}

export type ListSort =
  | "deadline"
  | "newest"
  | "oldest"
  | "replies-desc"
  | "replies-asc"
  | "site";

export type ListFilter =
  | "ready"
  | "awaiting"
  | "soon"
  | "quotes"
  | "failed"
  | "passed"
  | "unverified"
  | "tbc";

export const LIST_SORTS: ReadonlyArray<{ value: ListSort; label: string }> = [
  { value: "deadline", label: "Deadline soonest" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "replies-desc", label: "Most replies" },
  { value: "replies-asc", label: "Least replies" },
  { value: "site", label: "Site A–Z" },
];

export const LIST_FILTERS: ReadonlyArray<{ value: ListFilter; label: string }> = [
  { value: "awaiting", label: "Awaiting a reply" },
  { value: "soon", label: "Deadline within 48 h" },
  { value: "quotes", label: "Has quotes" },
  { value: "failed", label: "Failed delivery" },
  { value: "passed", label: "Deadline passed" },
  { value: "unverified", label: "Location unverified" },
  { value: "tbc", label: "Start date TBC" },
];

const SORT_VALUES = LIST_SORTS.map((entry) => entry.value);
const FILTER_VALUES = LIST_FILTERS.map((entry) => entry.value);

export function isListSort(value: string): value is ListSort {
  return (SORT_VALUES as string[]).includes(value);
}

export function isListFilter(value: string): value is ListFilter {
  return value === "ready" || (FILTER_VALUES as string[]).includes(value);
}

export function filterLabel(value: ListFilter): string {
  if (value === "ready") return "Drafts ready to send";
  return LIST_FILTERS.find((entry) => entry.value === value)?.label ?? value;
}

const HOUR = 3_600_000;

function deadlineMs(row: RfqRow): number {
  const value = new Date(row.submissionDeadline).getTime();
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

function isLive(row: RfqRow): boolean {
  return row.status === "SENT" || row.status === "DRAFT";
}

/** Quoted + declined: an expired recipient never answered. */
export function repliedCount(row: RfqRow): number {
  return row.recipients.filter(
    (recipient) =>
      recipient.responseStatus === "QUOTED" || recipient.responseStatus === "DECLINED",
  ).length;
}

export function declinedCount(row: RfqRow): number {
  return row.recipients.filter((recipient) => recipient.responseStatus === "DECLINED")
    .length;
}

/** The number of quotations, when the payload happened to include `_count`. */
export function quoteCount(row: RfqRow): number | null {
  const value = row.quotationCount ?? row._count?.quotations;
  return typeof value === "number" ? value : null;
}

export function matchesFilters(row: RfqRow, filters: readonly ListFilter[], now = Date.now()): boolean {
  if (filters.length === 0) return true;
  const deadline = deadlineMs(row);

  return filters.every((filter) => {
    switch (filter) {
      case "ready":
        return row.status === "DRAFT" && deadline > now;
      case "awaiting":
        return row.pendingCount > 0;
      case "soon":
        return (
          row.status === "SENT" &&
          row.pendingCount > 0 &&
          deadline > now &&
          deadline - now <= 48 * HOUR
        );
      case "quotes":
        return row.rollupStatus === "QUOTES_RECEIVED";
      case "failed":
        return row.failedCount > 0;
      case "passed":
        return isLive(row) && deadline < now;
      case "unverified":
        return row.siteLocationUnverified;
      case "tbc":
        return row.startDateTbc;
      default:
        return true;
    }
  });
}

function time(value: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortRows(rows: readonly RfqRow[], sort: ListSort): RfqRow[] {
  const ordered = [...rows];
  ordered.sort((a, b) => {
    switch (sort) {
      case "newest":
        return time(b.createdAt) - time(a.createdAt) || a.rfqNumber.localeCompare(b.rfqNumber);
      case "oldest":
        return time(a.createdAt) - time(b.createdAt) || a.rfqNumber.localeCompare(b.rfqNumber);
      case "replies-desc":
        return repliedCount(b) - repliedCount(a) || deadlineMs(a) - deadlineMs(b);
      case "replies-asc":
        return repliedCount(a) - repliedCount(b) || deadlineMs(a) - deadlineMs(b);
      case "site":
        return (
          cityOf(a).localeCompare(cityOf(b)) ||
          a.rfqNumber.localeCompare(b.rfqNumber)
        );
      default:
        return deadlineMs(a) - deadlineMs(b) || a.rfqNumber.localeCompare(b.rfqNumber);
    }
  });
  return ordered;
}

export interface SummaryStats {
  ready: number;
  soon: number;
  quotes: number;
  failed: number;
  overdue: number;
}

export function summaryStats(rows: readonly RfqRow[], now = Date.now()): SummaryStats {
  const deadline = (row: RfqRow) => deadlineMs(row);
  return {
    ready: rows.filter((row) => row.status === "DRAFT" && deadline(row) > now).length,
    soon: rows.filter(
      (row) =>
        row.status === "SENT" &&
        row.pendingCount > 0 &&
        deadline(row) > now &&
        deadline(row) - now <= 48 * HOUR,
    ).length,
    quotes: rows.filter((row) => row.rollupStatus === "QUOTES_RECEIVED").length,
    failed: rows.filter((row) => row.failedCount > 0).length,
    overdue: rows.filter((row) => isLive(row) && deadline(row) < now).length,
  };
}

export function tabCounts(rows: readonly RfqRow[]): Record<RfqStatus | "ALL", number> {
  const counts: Record<RfqStatus | "ALL", number> = {
    ALL: rows.length,
    SENT: 0,
    DRAFT: 0,
    CLOSED: 0,
    CANCELLED: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * Rows that are the same sourcing question twice.
 *
 * Same enquiry line and same status. Two drafts raised against one line are
 * alternatives; a draft and a sent RFQ are a progression, not a duplicate.
 */
export function duplicateKey(row: RfqRow): string {
  const line = row.enquiryLineId ?? `${row.enquiryNo}/${row.lineNo}`;
  return `${row.status}:${line}`;
}

/** Groups of 2+, keyed by the first row in list order. */
export function duplicateGroups(rows: readonly RfqRow[]): Map<string, RfqRow[]> {
  const byKey = new Map<string, RfqRow[]>();
  for (const row of rows) {
    const key = duplicateKey(row);
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }

  const groups = new Map<string, RfqRow[]>();
  for (const group of byKey.values()) {
    const leader = group[0];
    if (leader && group.length > 1) groups.set(leader.id, group);
  }
  return groups;
}

/** The copy to keep: the most recently touched one. The rest are cancellable. */
export function duplicateKeep(group: readonly RfqRow[]): RfqRow | null {
  return (
    [...group].sort((a, b) => time(b.updatedAt) - time(a.updatedAt))[0] ?? null
  );
}
