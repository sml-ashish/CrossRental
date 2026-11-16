import { TRAIL_LABELS } from "@/lib/enquiries";
import { titleCase } from "@/lib/format";
import { REPORT_VIEW_LABELS, type Report, type ReportView } from "@/lib/reports";

/**
 * The display logic behind the Reports screen.
 *
 * The server owns the numbers and the rows; this module only decides how to
 * read them. Keeping it pure means the page stays a layout: period arithmetic,
 * the previous-period comparison, the column formatters, the plain-language
 * sentences, the chart buckets and the URL contract can all be checked without
 * rendering anything.
 */

// ---------------------------------------------------------------------------
// periods and dates
// ---------------------------------------------------------------------------

export type PeriodPreset =
  | "this-month"
  | "last-month"
  | "last-30-days"
  | "this-quarter"
  | "this-year"
  | "all-time"
  | "custom";

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  "this-month": "This month",
  "last-month": "Last month",
  "last-30-days": "Last 30 days",
  "this-quarter": "This quarter",
  "this-year": "This year",
  "all-time": "All time",
  custom: "Custom",
};

export const PERIOD_OPTIONS: Array<{ value: PeriodPreset; label: string }> = (
  [
    "this-month",
    "last-month",
    "last-30-days",
    "this-quarter",
    "this-year",
    "all-time",
    "custom",
  ] as PeriodPreset[]
).map((value) => ({ value, label: PERIOD_LABELS[value] }));

export interface DateRange {
  from: string | null;
  to: string | null;
}

export interface ResolvedPeriod extends DateRange {
  preset: PeriodPreset;
}

const MONTHS_SHORT = [
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
] as const;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function monthShort(index: number): string {
  return MONTHS_SHORT[index] ?? "Jan";
}

/** The local calendar day, never shifted by a UTC conversion. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseIsoDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = ISO_DAY.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  if (!yearText || !monthText || !dayText) return null;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function addDaysIso(value: string, days: number): string {
  const date = parseIsoDay(value);
  if (!date) return value;
  date.setDate(date.getDate() + days);
  return isoDay(date);
}

export function diffDays(from: string, to: string): number {
  const start = parseIsoDay(from);
  const end = parseIsoDay(to);
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Resolve a preset against today's local date. "This month" ends today rather
 * than at the end of the month, so the report never claims future activity.
 */
export function resolvePeriod(
  preset: PeriodPreset,
  custom: DateRange = { from: null, to: null },
  now: Date = new Date(),
): ResolvedPeriod {
  const today = isoDay(now);
  const year = now.getFullYear();
  const month = now.getMonth();

  switch (preset) {
    case "this-month":
      return { preset, from: isoDay(new Date(year, month, 1)), to: today };
    case "last-month":
      return {
        preset,
        from: isoDay(new Date(year, month - 1, 1)),
        to: isoDay(new Date(year, month, 0)),
      };
    case "last-30-days":
      return { preset, from: addDaysIso(today, -29), to: today };
    case "this-quarter": {
      const quarterStart = Math.floor(month / 3) * 3;
      return { preset, from: isoDay(new Date(year, quarterStart, 1)), to: today };
    }
    case "this-year":
      return { preset, from: isoDay(new Date(year, 0, 1)), to: today };
    case "all-time":
      return { preset, from: null, to: null };
    case "custom": {
      const from = parseIsoDay(custom.from);
      const to = parseIsoDay(custom.to);
      if (from && to) {
        const start = isoDay(from);
        const end = isoDay(to);
        return start <= end ? { preset, from: start, to: end } : { preset, from: end, to: start };
      }
      if (from) {
        const value = isoDay(from);
        return { preset, from: value, to: value };
      }
      if (to) {
        const value = isoDay(to);
        return { preset, from: value, to: value };
      }
      return { preset, from: isoDay(new Date(year, month, 1)), to: today };
    }
  }
}

/** The immediately preceding period of the same length, or null for all time. */
export function previousRange(range: ResolvedPeriod): DateRange | null {
  if (range.preset === "all-time" || !range.from || !range.to) return null;
  const length = diffDays(range.from, range.to) + 1;
  const to = addDaysIso(range.from, -1);
  return { from: addDaysIso(to, -(length - 1)), to };
}

/** "13 Nov 2026". */
export function formatDay(value: string | null | undefined): string {
  const date = parseIsoDay(value);
  if (!date) return "—";
  return `${date.getDate()} ${monthShort(date.getMonth())} ${date.getFullYear()}`;
}

/** "1 to 14 Nov 2026", shortening the parts both ends share. */
export function formatRange(from: string | null, to: string | null): string {
  if (!from && !to) return "All time";
  if (!from) return formatDay(to);
  if (!to) return formatDay(from);
  if (from === to) return formatDay(from);
  const start = parseIsoDay(from);
  const end = parseIsoDay(to);
  if (!start || !end) return `${formatDay(from)} to ${formatDay(to)}`;
  if (start.getFullYear() === end.getFullYear()) {
    if (start.getMonth() === end.getMonth()) {
      return `${start.getDate()} to ${end.getDate()} ${monthShort(end.getMonth())} ${end.getFullYear()}`;
    }
    return `${start.getDate()} ${monthShort(start.getMonth())} to ${end.getDate()} ${monthShort(end.getMonth())} ${end.getFullYear()}`;
  }
  return `${formatDay(from)} to ${formatDay(to)}`;
}

/** "14 Nov 2026, 9:32 pm" — the report's generated stamp. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const hours = date.getHours();
  const suffix = hours >= 12 ? "pm" : "am";
  const hour = hours % 12 || 12;
  return `${date.getDate()} ${monthShort(date.getMonth())} ${date.getFullYear()}, ${hour}:${pad2(date.getMinutes())} ${suffix}`;
}

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-IN");
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${round1(value)}%`;
}

/** Hours as the unit a person actually reads: minutes, hours, then days. */
export function formatDuration(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return "—";
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${minutes} min`;
  if (hours < 24) return `${round1(hours)} h`;
  return `${round1(hours / 24)} days`;
}

export function formatKm(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${formatNumber(Math.round(value))} km`;
}

export function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `₹ ${formatNumber(Math.round(value))}`;
}

export type KpiFormat = "count" | "percent" | "hours" | "km" | "money" | "ratio";

export function formatMetric(value: number | null, format: KpiFormat): string {
  switch (format) {
    case "count":
      return formatNumber(value);
    case "percent":
      return formatPercent(value);
    case "hours":
      return formatDuration(value);
    case "km":
      return formatKm(value);
    case "money":
      return formatMoney(value);
    case "ratio":
      return value === null || !Number.isFinite(value) ? "—" : `${round1(value)}`;
  }
}

// ---------------------------------------------------------------------------
// KPI specs
// ---------------------------------------------------------------------------

export type BetterDirection = "higher" | "lower" | "neutral";

export interface KpiSpec {
  id: string;
  /** Plain words, not the backend's metric name. */
  label: string;
  /** Shown on hover and focus; written from how the backend computes it. */
  definition: string;
  format: KpiFormat;
  /** Which direction counts as good. */
  better: BetterDirection;
  value: (report: Report) => number | null;
  /** The counts behind the number, when the loaded rows can supply them. */
  hint?: (report: Report) => string | null;
}

function columnTotal(report: Report, key: string): number {
  return report.rows.reduce((total, row) => total + (asNumber(row[key]) ?? 0), 0);
}

function hasColumn(report: Report, key: string): boolean {
  return report.columns.some((column) => column.key === key);
}

function count(value: number, one: string, many: string): string {
  return `${formatNumber(value)} ${value === 1 ? one : many}`;
}

const enquiriesKpi: KpiSpec = {
  id: "enquiries",
  label: "Enquiries",
  definition: "Enquiries created in the period, counted by their enquiry date.",
  format: "count",
  better: "higher",
  value: (report) => report.summary.enquiriesProcessed,
  hint: (report) => `${count(report.summary.linesProcessed, "line", "lines")} in total`,
};

const linesKpi: KpiSpec = {
  id: "lines",
  label: "Lines",
  definition: "Enquiry lines created in the period. One enquiry can ask for several cranes.",
  format: "count",
  better: "higher",
  value: (report) => report.summary.linesProcessed,
  hint: (report) => count(report.summary.enquiriesProcessed, "enquiry", "enquiries"),
};

const linesPerEnquiryKpi: KpiSpec = {
  id: "lines-per-enquiry",
  label: "Lines per enquiry",
  definition: "Lines divided by enquiries in the period — how much work each enquiry carries.",
  format: "ratio",
  better: "neutral",
  value: (report) =>
    report.summary.enquiriesProcessed === 0
      ? null
      : round1(report.summary.linesProcessed / report.summary.enquiriesProcessed),
  hint: (report) =>
    `${count(report.summary.linesProcessed, "line", "lines")} across ${count(
      report.summary.enquiriesProcessed,
      "enquiry",
      "enquiries",
    )}`,
};

const responseRateKpi: KpiSpec = {
  id: "response-rate",
  label: "RFQs answered",
  definition: "The share of RFQs sent where at least one vendor submitted a quotation.",
  format: "percent",
  better: "higher",
  value: (report) => report.summary.rfqResponseRate,
};

const firstReplyKpi: KpiSpec = {
  id: "first-reply",
  label: "Time to first reply",
  definition: "Average time from an RFQ being sent to the first quotation arriving on it.",
  format: "hours",
  better: "lower",
  value: (report) => report.summary.rfqTurnaroundFirstHours,
};

const lastReplyKpi: KpiSpec = {
  id: "last-reply",
  label: "Time to last reply",
  definition: "Average time from an RFQ being sent to the last quotation arriving on it.",
  format: "hours",
  better: "lower",
  value: (report) => report.summary.rfqTurnaroundLastHours,
};

const participationKpi: KpiSpec = {
  id: "participation",
  label: "Vendors who replied",
  definition: "The share of vendor invitations that got a reply — a quotation or a decline.",
  format: "percent",
  better: "higher",
  value: (report) => report.summary.vendorParticipationRate,
  hint: (report) => {
    if (!hasColumn(report, "recipients")) return null;
    const invitations = columnTotal(report, "recipients");
    if (invitations === 0) return null;
    const answered = columnTotal(report, "quoted") + columnTotal(report, "declined");
    return `${formatNumber(answered)} of ${formatNumber(invitations)} invitations answered`;
  },
};

const responseTimeKpi: KpiSpec = {
  id: "response-time",
  label: "Typical reply time",
  definition: "Average time from sending an RFQ to a vendor replying with a quotation.",
  format: "hours",
  better: "lower",
  value: (report) => report.summary.averageResponseTimeHours,
  hint: (report) => {
    if (!hasColumn(report, "quoted")) return null;
    const replies = columnTotal(report, "quoted");
    return replies > 0 ? `${count(replies, "quoted reply", "quoted replies")} timed` : null;
  },
};

const conversionKpi: KpiSpec = {
  id: "conversion",
  label: "Quotations awarded",
  definition: "The share of submitted quotations that were selected — the ones that turned into work.",
  format: "percent",
  better: "higher",
  value: (report) => report.summary.quotationConversionRate,
  hint: (report) => {
    if (!hasColumn(report, "submitted")) return null;
    const submitted = columnTotal(report, "submitted");
    if (submitted === 0) return null;
    const awarded = columnTotal(report, "awarded");
    return `${formatNumber(awarded)} of ${formatNumber(submitted)} quotations awarded`;
  },
};

const winningVendorsKpi: KpiSpec = {
  id: "winning-vendors",
  label: "Vendors with a win",
  definition: "Vendors that had at least one quotation selected in the period.",
  format: "count",
  better: "higher",
  value: (report) => {
    if (report.rows.length === 0) return null;
    return report.rows.filter((row) => (asNumber(row.awarded) ?? 0) > 0).length;
  },
  hint: (report) => {
    if (report.rows.length === 0) return null;
    const winners = report.rows.filter((row) => (asNumber(row.awarded) ?? 0) > 0).length;
    return `${formatNumber(winners)} of ${formatNumber(report.rows.length)} vendors won something`;
  },
};

const distanceKpi: KpiSpec = {
  id: "distance",
  label: "Average distance",
  definition: "Average distance from the winning vendor to site, across awarded quotations.",
  format: "km",
  better: "lower",
  value: (report) => report.summary.averageMobilisationDistanceKm,
};

const transportCostKpi: KpiSpec = {
  id: "transport-cost",
  label: "Average transport cost",
  definition: "Average mobilisation plus demobilisation charge on awarded quotations.",
  format: "money",
  better: "lower",
  value: (report) => report.summary.averageTransportCost,
};

export function kpiSpecs(view: ReportView): KpiSpec[] {
  switch (view) {
    case "enquiry":
      return [enquiriesKpi, linesKpi, linesPerEnquiryKpi, conversionKpi];
    case "line":
      return [linesKpi, responseRateKpi, firstReplyKpi, lastReplyKpi, conversionKpi];
    case "vendor":
      return [
        participationKpi,
        responseRateKpi,
        responseTimeKpi,
        conversionKpi,
        winningVendorsKpi,
      ];
    case "category":
      return [linesKpi, distanceKpi, transportCostKpi];
  }
}

export interface KpiDelta {
  direction: "up" | "down" | "flat";
  verdict: "better" | "worse" | "neutral";
  amount: string;
}

function deltaAmount(value: number, format: KpiFormat): string {
  switch (format) {
    case "count":
      return formatNumber(value);
    case "percent":
      return `${round1(value)} pts`;
    case "ratio":
      return `${round1(value)}`;
    case "hours":
      return formatDuration(value);
    case "km":
      return `${formatNumber(Math.round(value))} km`;
    case "money":
      return `₹ ${formatNumber(Math.round(value))}`;
  }
}

/**
 * The change since the equal-length previous period. `previous` must already
 * be null when that period holds no data, so a sparse month never reads as a
 * collapse.
 */
export function kpiDelta(
  spec: KpiSpec,
  current: Report,
  previous: Report | null,
): KpiDelta | null {
  if (!previous) return null;
  const before = spec.value(previous);
  const after = spec.value(current);
  if (before === null || after === null) return null;
  const change = after - before;
  const threshold =
    spec.format === "km" || spec.format === "money"
      ? 0.5
      : spec.format === "count"
        ? 0.5
        : 0.05;
  if (Math.abs(change) < threshold) {
    return { direction: "flat", verdict: "neutral", amount: "" };
  }
  const direction = change > 0 ? "up" : "down";
  const verdict =
    spec.better === "neutral"
      ? "neutral"
      : (change > 0) === (spec.better === "higher")
        ? "better"
        : "worse";
  return { direction, verdict, amount: deltaAmount(Math.abs(change), spec.format) };
}

export function hasReportData(report: Report | null | undefined): boolean {
  if (!report) return false;
  return (
    report.summary.enquiriesProcessed > 0 ||
    report.summary.linesProcessed > 0 ||
    report.rows.length > 0
  );
}

// ---------------------------------------------------------------------------
// "What the numbers say"
// ---------------------------------------------------------------------------

function responseSentence(report: Report, previous: Report | null): string | null {
  const rate = report.summary.rfqResponseRate;
  if (rate === null) return null;
  const before = previous?.summary.rfqResponseRate ?? null;
  if (before === null) return `Vendors replied to ${formatPercent(rate)} of RFQs sent.`;
  const change = rate - before;
  if (Math.abs(change) < 0.05) {
    return `Vendors replied to ${formatPercent(rate)} of RFQs, the same as last period.`;
  }
  return `Vendors replied to ${formatPercent(rate)} of RFQs, ${
    change > 0 ? "up" : "down"
  } from ${formatPercent(before)} last period.`;
}

function conversionSentence(report: Report): string | null {
  const rate = report.summary.quotationConversionRate;
  if (rate === null) return null;
  return `${formatPercent(rate)} of quotations sent were awarded.`;
}

function replySentence(report: Report): string | null {
  const hours = report.summary.rfqTurnaroundFirstHours;
  if (hours === null) return null;
  return `The first reply to an RFQ arrived after ${formatDuration(hours)} on average.`;
}

function regionSentence(report: Report): string | null {
  const counts = new Map<string, number>();
  for (const row of report.rows) {
    const place = asText(row.siteState) || asText(row.region);
    if (!place) continue;
    const label = titleCase(place);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0 || report.rows.length < 3) return null;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 2) return null;
  return `${formatNumber(top[1])} of ${formatNumber(report.rows.length)} enquiries came from ${top[0]}.`;
}

function stageSentence(report: Report): string | null {
  const counts = new Map<string, number>();
  for (const row of report.rows) {
    const status = asText(row.trailStatus);
    if (!status) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || report.rows.length < 2 || top[1] < 2) return null;
  return `${formatNumber(top[1])} of ${formatNumber(report.rows.length)} lines are at the ${stageLabel(top[0])} stage.`;
}

function winningVendorSentence(report: Report): string | null {
  const entries = report.rows
    .map((row) => {
      const submitted = asNumber(row.submitted) ?? 0;
      const awarded = asNumber(row.awarded) ?? 0;
      return {
        vendor: asText(row.vendor),
        submitted,
        awarded,
        rate: submitted === 0 ? 0 : awarded / submitted,
      };
    })
    .filter((entry) => entry.vendor !== "" && entry.submitted > 0 && entry.awarded > 0);
  entries.sort((a, b) => b.awarded - a.awarded || b.rate - a.rate);
  const top = entries[0];
  if (!top) return null;
  return `${top.vendor} wins the most: ${formatNumber(top.awarded)} of ${formatNumber(
    top.submitted,
  )} quotations won (${formatPercent(top.rate * 100)}).`;
}

function silentVendorSentence(report: Report): string | null {
  const silent = report.rows.filter((row) => {
    const received = asNumber(row.recipients) ?? 0;
    const answered = (asNumber(row.quoted) ?? 0) + (asNumber(row.declined) ?? 0);
    return received > 0 && answered === 0;
  });
  if (silent.length === 0 || report.rows.length === 0) return null;
  return `${formatNumber(silent.length)} of ${formatNumber(
    report.rows.length,
  )} vendors have not replied to any RFQ.`;
}

function topCategorySentence(report: Report): string | null {
  const entries = report.rows
    .map((row) => ({
      name: asText(row.craneCategory),
      lines: asNumber(row.lines) ?? 0,
    }))
    .filter((entry) => entry.name !== "" && entry.lines > 0);
  entries.sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  const top = entries[0];
  if (!top) return null;
  const total = entries.reduce((sum, entry) => sum + entry.lines, 0);
  return `${top.name} accounts for ${formatNumber(top.lines)} of ${formatNumber(
    total,
  )} lines.`;
}

export function buildInsights(
  report: Report,
  previous: Report | null,
  options: { suppressRegion?: boolean } = {},
): string[] {
  const candidates: Array<string | null> = [];
  switch (report.view) {
    case "enquiry":
      candidates.push(
        responseSentence(report, previous),
        conversionSentence(report),
        options.suppressRegion ? null : regionSentence(report),
      );
      break;
    case "line":
      candidates.push(
        responseSentence(report, previous),
        replySentence(report),
        stageSentence(report),
      );
      break;
    case "vendor":
      candidates.push(
        winningVendorSentence(report),
        responseSentence(report, previous),
        silentVendorSentence(report),
      );
      break;
    case "category":
      candidates.push(
        topCategorySentence(report),
        responseSentence(report, previous),
        conversionSentence(report),
      );
      break;
  }
  return candidates.filter((sentence): sentence is string => Boolean(sentence)).slice(0, 3);
}

// ---------------------------------------------------------------------------
// columns
// ---------------------------------------------------------------------------

export type CellKind =
  | "text"
  | "date"
  | "number"
  | "percent"
  | "km"
  | "money"
  | "stage"
  | "enquiry"
  | "vendor";

export interface ColumnMeta {
  kind: CellKind;
  align: "left" | "right";
  numeric: boolean;
}

const TEXT_COLUMN: ColumnMeta = { kind: "text", align: "left", numeric: false };
const DATE_COLUMN: ColumnMeta = { kind: "date", align: "left", numeric: false };
const NUMBER_COLUMN: ColumnMeta = { kind: "number", align: "right", numeric: true };

const KNOWN_COLUMNS: Record<string, ColumnMeta> = {
  enquiryNo: { kind: "enquiry", align: "left", numeric: false },
  enquiryDate: DATE_COLUMN,
  customerName: TEXT_COLUMN,
  region: TEXT_COLUMN,
  siteState: TEXT_COLUMN,
  lines: NUMBER_COLUMN,
  lineNo: NUMBER_COLUMN,
  craneCategory: TEXT_COLUMN,
  capacityT: NUMBER_COLUMN,
  quantity: NUMBER_COLUMN,
  trailStatus: { kind: "stage", align: "left", numeric: false },
  vendor: { kind: "vendor", align: "left", numeric: false },
  recipients: NUMBER_COLUMN,
  quoted: NUMBER_COLUMN,
  declined: NUMBER_COLUMN,
  pending: NUMBER_COLUMN,
  submitted: NUMBER_COLUMN,
  awarded: NUMBER_COLUMN,
  winRate: { kind: "percent", align: "right", numeric: true },
  avgDistanceKm: { kind: "km", align: "right", numeric: true },
  avgTransportCost: { kind: "money", align: "right", numeric: true },
};

/** A column added by the backend later still gets a sensible treatment. */
export function columnMeta(key: string, rows: Report["rows"]): ColumnMeta {
  const known = KNOWN_COLUMNS[key];
  if (known) return known;
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number") return NUMBER_COLUMN;
    if (typeof value === "string" && ISO_DAY.test(value)) return DATE_COLUMN;
    return TEXT_COLUMN;
  }
  return TEXT_COLUMN;
}

export function asText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function asNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function stageLabel(status: string): string {
  return (TRAIL_LABELS as Record<string, string>)[status] ?? titleCase(status.replaceAll("_", " ").toLowerCase());
}

const STAGE_ORDER: readonly string[] = [
  "NEW",
  "AVAILABILITY_CHECK",
  "VENDOR_SHORTLISTED",
  "RFQ_SENT",
  "AWAITING_QUOTES",
  "QUOTES_RECEIVED",
  "UNDER_EVALUATION",
  "VENDOR_FINALISED",
  "BOOKED",
  "CLOSED",
  "FULFILLED_INTERNALLY",
  "CANCELLED",
];

export function stageDot(status: string): string {
  switch (status) {
    case "BOOKED":
    case "CLOSED":
    case "FULFILLED_INTERNALLY":
      return "bg-emerald-500";
    case "CANCELLED":
      return "bg-red-500";
    case "AWAITING_QUOTES":
      return "bg-amber-500";
    case "NEW":
    case "AVAILABILITY_CHECK":
      return "bg-slate-400";
    default:
      return "bg-accent-500";
  }
}

export function formatCell(key: string, value: string | number | null): string {
  if (value === null || value === "") return "—";
  const known = KNOWN_COLUMNS[key]?.kind;
  const kind: CellKind = known ?? (typeof value === "number" ? "number" : TEXT_COLUMN.kind);
  switch (kind) {
    case "date":
      return formatDay(typeof value === "string" ? value : null);
    case "number":
      return formatNumber(asNumber(value));
    case "percent":
      return formatPercent(asNumber(value));
    case "km":
      return formatKm(asNumber(value));
    case "money":
      return formatMoney(asNumber(value));
    case "stage":
      return stageLabel(asText(value));
    case "enquiry":
    case "vendor":
      return asText(value);
    case "text": {
      const text = asText(value);
      if (text === "") return "—";
      return key === "region" || key === "siteState" ? titleCase(text) : text;
    }
  }
}

// ---------------------------------------------------------------------------
// filtering, sorting and totals
// ---------------------------------------------------------------------------

export function supportsRegion(columns: Report["columns"]): boolean {
  return columns.some((column) => column.key === "region");
}

/** Region is client-side: the endpoint does not accept a region parameter. */
export function filterByRegion(rows: Report["rows"], region: string): Report["rows"] {
  const needle = region.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    if (!("region" in row)) return true;
    const value = row.region;
    return typeof value === "string" && value.trim().toLowerCase() === needle;
  });
}

export function searchReportRows(
  rows: Report["rows"],
  columns: Report["columns"],
  query: string,
): Report["rows"] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  const searchable = columns.filter((column) => {
    const kind = columnMeta(column.key, rows).kind;
    return kind !== "number" && kind !== "percent" && kind !== "km" && kind !== "money";
  });
  return rows.filter((row) =>
    searchable.some((column) =>
      formatCell(column.key, row[column.key] ?? null).toLowerCase().includes(needle),
    ),
  );
}

export type SortDirection = "asc" | "desc";

export interface SortState {
  key: string;
  direction: SortDirection;
}

function stageRank(status: string): number {
  const index = STAGE_ORDER.indexOf(status);
  return index === -1 ? STAGE_ORDER.length : index;
}

function compareValues(
  key: string,
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): number {
  if (key === "trailStatus") return stageRank(asText(left)) - stageRank(asText(right));
  if (typeof left === "number" || typeof right === "number") {
    return (asNumber(left) ?? 0) - (asNumber(right) ?? 0);
  }
  const a = asText(left);
  const b = asText(right);
  if (ISO_DAY.test(a) && ISO_DAY.test(b)) return a.localeCompare(b);
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Empty cells sort last in both directions: a blank is not a small number. */
export function sortReportRows(rows: Report["rows"], sort: SortState | null): Report["rows"] {
  if (!sort) return rows;
  const direction = sort.direction === "asc" ? 1 : -1;
  const present: Report["rows"] = [];
  const missing: Report["rows"] = [];
  for (const row of rows) {
    const value = row[sort.key];
    if (value === null || value === undefined || value === "") missing.push(row);
    else present.push(row);
  }
  present.sort((a, b) => direction * compareValues(sort.key, a[sort.key], b[sort.key]));
  return [...present, ...missing];
}

export interface ReportTotals {
  label: string;
  values: Record<string, number>;
}

export function reportTotals(view: ReportView, rows: Report["rows"]): ReportTotals | null {
  if (rows.length === 0) return null;
  const total = (key: string) =>
    rows.reduce((sum, row) => sum + (asNumber(row[key]) ?? 0), 0);
  switch (view) {
    case "enquiry":
      return { label: "Totals", values: { lines: total("lines") } };
    case "line":
      return { label: "Totals", values: { quantity: total("quantity") } };
    case "vendor": {
      const submitted = total("submitted");
      const awarded = total("awarded");
      const values: Record<string, number> = {
        recipients: total("recipients"),
        quoted: total("quoted"),
        declined: total("declined"),
        pending: total("pending"),
        submitted,
        awarded,
      };
      if (submitted > 0) values.winRate = round1((awarded / submitted) * 100);
      return { label: "Totals", values };
    }
    case "category":
      return { label: "Totals", values: { lines: total("lines") } };
  }
}

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

export type Granularity = "day" | "week" | "month";

export interface ChartPoint {
  key: string;
  label: string;
  value: number;
  /** The second line in the tooltip. */
  meta?: string;
  /** A short value printed beside a horizontal bar. */
  annotation?: string;
}

function startOfBucket(date: Date, granularity: Granularity): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (granularity === "month") return new Date(day.getFullYear(), day.getMonth(), 1);
  if (granularity === "week") {
    const offset = (day.getDay() + 6) % 7;
    day.setDate(day.getDate() - offset);
  }
  return day;
}

function addBucket(date: Date, granularity: Granularity): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (granularity === "month") next.setMonth(next.getMonth() + 1);
  else if (granularity === "week") next.setDate(next.getDate() + 7);
  else next.setDate(next.getDate() + 1);
  return next;
}

function bucketLabel(date: Date, granularity: Granularity): string {
  if (granularity === "month") return `${monthShort(date.getMonth())} ${date.getFullYear()}`;
  return `${date.getDate()} ${monthShort(date.getMonth())}`;
}

export function granularityFor(range: DateRange, spanDays: number): Granularity {
  if (!range.from && !range.to) return "month";
  let granularity: Granularity = spanDays >= 31 ? "week" : "day";
  if (granularity === "day" && spanDays > 62) granularity = "week";
  if (granularity === "week" && Math.ceil(spanDays / 7) > 60) granularity = "month";
  return granularity;
}

export interface VolumeSeries {
  points: ChartPoint[];
  granularity: Granularity;
  total: number;
}

/** Enquiries bucketed per day, week or month, with empty buckets kept. */
export function enquiryVolumeSeries(
  rows: Report["rows"],
  range: DateRange,
): VolumeSeries {
  const dates: Date[] = [];
  for (const row of rows) {
    const value = row.enquiryDate;
    if (typeof value !== "string") continue;
    const date = parseIsoDay(value);
    if (date) dates.push(date);
  }
  if (dates.length === 0) return { points: [], granularity: "day", total: 0 };
  dates.sort((a, b) => a.getTime() - b.getTime());
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return { points: [], granularity: "day", total: 0 };

  const fromDate = parseIsoDay(range.from) ?? first;
  const toDate = parseIsoDay(range.to) ?? last;
  const start = fromDate.getTime() <= toDate.getTime() ? fromDate : toDate;
  const end = fromDate.getTime() <= toDate.getTime() ? toDate : fromDate;
  const span = diffDays(isoDay(start), isoDay(end)) + 1;
  const granularity = granularityFor(range, span);

  const counts = new Map<string, number>();
  for (const date of dates) {
    const key = isoDay(startOfBucket(date, granularity));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const points: ChartPoint[] = [];
  let cursor = startOfBucket(start, granularity);
  let guard = 0;
  while (cursor.getTime() <= end.getTime() && guard < 400) {
    const key = isoDay(cursor);
    points.push({
      key,
      label: bucketLabel(cursor, granularity),
      value: counts.get(key) ?? 0,
    });
    cursor = addBucket(cursor, granularity);
    guard += 1;
  }
  return { points, granularity, total: dates.length };
}

export function lineStageSeries(rows: Report["rows"]): ChartPoint[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const status = asText(row.trailStatus);
    if (status === "") continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const known = STAGE_ORDER.filter((status) => counts.has(status));
  const extra = [...counts.keys()]
    .filter((status) => !STAGE_ORDER.includes(status))
    .sort((a, b) => stageLabel(a).localeCompare(stageLabel(b)));
  return [...known, ...extra].map((status) => ({
    key: status,
    label: stageLabel(status),
    value: counts.get(status) ?? 0,
  }));
}

export function vendorWinSeries(rows: Report["rows"]): ChartPoint[] {
  const entries = rows
    .map((row) => {
      const submitted = asNumber(row.submitted) ?? 0;
      const awarded = asNumber(row.awarded) ?? 0;
      const winRate = asNumber(row.winRate);
      return { label: asText(row.vendor) || "Vendor", submitted, awarded, winRate };
    })
    .filter((entry) => entry.submitted > 0 && entry.winRate !== null);
  entries.sort(
    (a, b) =>
      b.awarded - a.awarded ||
      (b.winRate ?? 0) - (a.winRate ?? 0) ||
      a.label.localeCompare(b.label),
  );
  return entries.slice(0, 10).map((entry, index) => ({
    key: `${entry.label}-${index}`,
    label: entry.label,
    value: entry.winRate ?? 0,
    meta: `${formatNumber(entry.awarded)} of ${formatNumber(entry.submitted)} quotations won`,
  }));
}

export function categorySeries(rows: Report["rows"]): ChartPoint[] {
  return rows
    .map((row) => {
      const distance = asNumber(row.avgDistanceKm);
      const name = asText(row.craneCategory) || "Unspecified";
      return {
        key: name,
        label: name,
        value: asNumber(row.lines) ?? 0,
        meta:
          distance === null
            ? "No awarded distance yet"
            : `${formatKm(distance)} average mobilisation`,
        annotation: distance === null ? undefined : formatKm(distance),
      };
    })
    .filter((point) => point.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// URL contract
// ---------------------------------------------------------------------------

export interface ReportSearchState {
  view: ReportView;
  period: PeriodPreset;
  from: string | null;
  to: string | null;
  category: string;
  region: string;
}

const VIEWS = Object.keys(REPORT_VIEW_LABELS) as ReportView[];
const PRESETS = Object.keys(PERIOD_LABELS) as PeriodPreset[];

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && parseIsoDay(value) ? value : null;
}

/** Invalid parameters fall back to the default report rather than failing. */
export function parseReportSearch(search: Record<string, unknown>): ReportSearchState {
  const view = VIEWS.find((candidate) => candidate === search.view) ?? "enquiry";
  const period = PRESETS.find((candidate) => candidate === search.period) ?? "this-month";
  return {
    view,
    period,
    from: isoOrNull(search.from),
    to: isoOrNull(search.to),
    category: typeof search.category === "string" ? search.category : "",
    region: typeof search.region === "string" ? search.region : "",
  };
}

export function reportSearchParams(
  state: ReportSearchState,
  range: ResolvedPeriod,
): Record<string, string> {
  const params: Record<string, string> = { view: state.view, period: state.period };
  if (range.from) params.from = range.from;
  if (range.to) params.to = range.to;
  if (state.category) params.category = state.category;
  if (state.region) params.region = state.region;
  return params;
}

export const REPORT_VIEWS = VIEWS;
