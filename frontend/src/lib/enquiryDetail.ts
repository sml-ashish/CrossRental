import type { EnquiryDetail, EnquiryLine } from "@/lib/enquiries";
import type { HistoryEntry } from "@/lib/enquiryHistory";
import type { RfqListRow } from "@/lib/rfqs";
import { cityOf, siteLabel, titleCase } from "@/lib/format";

/**
 * Pure readings of one enquiry line.
 *
 * The page has to answer two questions in five seconds — "where is this job?"
 * and "what would I do next?" — from a payload with twelve trail statuses,
 * four optional RFQs and dates that mean different things. Keeping those folds
 * here, rather than in JSX, is what keeps the banner and the row from ever
 * recommending different things.
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Dates and plain text
// ---------------------------------------------------------------------------

const longDate = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const shortDate = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** The calendar day a stored date names. UTC, like every other date in the app. */
export function dayOf(iso: string | null | undefined): string | null {
  return iso ? iso.slice(0, 10) : null;
}

export function todayDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function daysUntil(day: string, now: Date = new Date()): number {
  return Math.round(
    (Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${todayDay(now)}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

/** "22 Nov 2026" — a required start date, never shifted by the browser's zone. */
export function formatLongDate(iso: string | null | undefined): string {
  const day = dayOf(iso);
  return day ? longDate.format(new Date(`${day}T00:00:00.000Z`)) : "—";
}

/** "12 Nov" — activity and deadline copy. */
export function formatShortDate(iso: string | null | undefined): string {
  const day = dayOf(iso);
  return day ? shortDate.format(new Date(`${day}T00:00:00.000Z`)) : "—";
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

/** "3 months" / "45 days". Null when no duration was entered. */
export function durationText(line: EnquiryLine): string | null {
  if (!line.durationValue || line.durationValue <= 0) return null;
  const unit = line.durationUnit === "MONTHS" ? "month" : "day";
  return `${number(line.durationValue)} ${plural(line.durationValue, unit)}`;
}

/** "Pune, Maharashtra" — built once, with the state never appended twice. */
export function siteLine(enquiry: Pick<
  EnquiryDetail,
  "siteLocation" | "siteStateCode" | "siteStateName"
>): string {
  return siteLabel({
    siteLocation: enquiry.siteLocation,
    siteState: enquiry.siteStateName ? { name: enquiry.siteStateName } : null,
    siteStateCode: enquiry.siteStateCode,
  });
}

export function siteCity(enquiry: Pick<EnquiryDetail, "siteLocation">): string {
  return cityOf(enquiry);
}

// ---------------------------------------------------------------------------
// The line itself
// ---------------------------------------------------------------------------

/** "Line 1 · 250 t+ Crawler Crane × 2". */
export function lineTitle(line: EnquiryLine): string {
  const type =
    line.craneTypeName?.trim() ||
    (line.craneTypeCode ? `${titleCase(line.craneTypeCode)} Crane` : "Crane");
  const capacity =
    line.capacityT !== null
      ? `${number(line.capacityT)} t${line.capacityRule === "AT_LEAST" ? "+" : ""}`
      : null;
  const subject = capacity ? `${capacity} ${type}` : type;
  const quantity = line.quantity > 1 ? ` × ${line.quantity}` : "";
  return `Line ${line.lineNo} · ${subject}${quantity}`;
}

/** The line as the banner and activity list talk about it. */
export function lineShort(line: EnquiryLine): string {
  return `Line ${line.lineNo}`;
}

/**
 * "Needed from 22 Nov 2026 · 3 months · Pune" — the facts line the old page
 * mangled into "2 × · 22 Nov 2026".
 */
export function lineFacts(line: EnquiryLine, city: string): string {
  const start = line.requiredStartDate
    ? `Needed from ${formatLongDate(line.requiredStartDate)}`
    : "Start date TBC";
  const duration = durationText(line);
  return [start, duration, city].filter(Boolean).join(" · ");
}

export interface Urgency {
  text: string;
  /** Red only when the start has passed; amber when it is close without an RFQ. */
  tone: "amber" | "red" | "muted";
}

/** The relative note, when one is worth saying. */
export function lineUrgency(
  line: EnquiryLine,
  hasRfq: boolean,
  now: Date = new Date(),
): Urgency | null {
  if (
    line.trailStatus === "CANCELLED" ||
    line.trailStatus === "CLOSED" ||
    line.trailStatus === "FULFILLED_INTERNALLY" ||
    line.trailStatus === "VENDOR_FINALISED" ||
    line.trailStatus === "BOOKED"
  ) {
    return null;
  }
  const start = dayOf(line.requiredStartDate);
  if (!start) return null;
  const days = daysUntil(start, now);
  if (days < 0) {
    return {
      text: days === -1 ? "started yesterday" : `started ${Math.abs(days)} days ago`,
      tone: "red",
    };
  }
  if (days === 0) return { text: "starts today", tone: hasRfq ? "muted" : "amber" };
  if (days <= 14) {
    return { text: `starts in ${days} days`, tone: hasRfq ? "muted" : "amber" };
  }
  return null;
}

/** "Lift 120 t at 30 m radius · boom 60 m" — only the parts that were entered. */
export function liftSummary(line: EnquiryLine): string | null {
  const parts: string[] = [];
  if (line.liftLoadT !== null) parts.push(`Lift ${number(line.liftLoadT)} t`);
  if (line.workingRadiusM !== null) parts.push(`at ${number(line.workingRadiusM)} m radius`);
  if (line.requiredMainBoomM !== null) parts.push(`boom ${number(line.requiredMainBoomM)} m`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The window a line needs a crane for, when both ends are known. */
export function lineWindow(line: EnquiryLine): { from: string; to: string } | null {
  const from = dayOf(line.requiredStartDate);
  if (!from || !line.durationValue || line.durationValue <= 0) return null;
  if (line.durationUnit === "DAYS") {
    return { from, to: addDays(from, line.durationValue - 1) };
  }
  const date = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + line.durationValue, date.getUTCDate()),
  );
  return { from, to: new Date(end.getTime() - DAY_MS).toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// The five-step shorthand
// ---------------------------------------------------------------------------

export const LINE_STEPS = ["Requirement", "Vendors", "RFQ sent", "Quotes", "Booked"] as const;

export interface LineStage {
  /** 0 to 4; -1 when the line was cancelled. */
  index: number;
  /** True for closed and internally fulfilled lines: every step is done. */
  completed: boolean;
  /** "Closed" or "Fulfilled internally" when all five steps are done. */
  note: string | null;
  cancelled: boolean;
}

/**
 * Twelve trail statuses folded into the five a salesperson actually thinks in.
 *
 * A quote can arrive before the trail catches up, so a line that carries a
 * quote reads as "Quotes" even while its status still says RFQ sent. That is
 * the same precedence the action picker uses, so the stepper and the button
 * never point at different stages.
 */
export function lineStage(line: EnquiryLine): LineStage {
  if (line.trailStatus === "CANCELLED") {
    return { index: -1, completed: false, note: null, cancelled: true };
  }
  if (line.trailStatus === "CLOSED") {
    return { index: 4, completed: true, note: "Closed", cancelled: false };
  }
  if (line.trailStatus === "FULFILLED_INTERNALLY") {
    return { index: 4, completed: true, note: "Fulfilled internally", cancelled: false };
  }
  if (line.trailStatus === "VENDOR_FINALISED" || line.trailStatus === "BOOKED") {
    return { index: 4, completed: false, note: null, cancelled: false };
  }
  // A quote can land before the trail moves. Reading it as "Quotes" is what
  // keeps the stepper and the Compare button on the same stage.
  if ((line.quoteCount ?? 0) > 0) {
    return { index: 3, completed: false, note: null, cancelled: false };
  }
  if (line.trailStatus === "QUOTES_RECEIVED" || line.trailStatus === "UNDER_EVALUATION") {
    return { index: 3, completed: false, note: null, cancelled: false };
  }
  if (line.trailStatus === "RFQ_SENT" || line.trailStatus === "AWAITING_QUOTES") {
    return { index: 2, completed: false, note: null, cancelled: false };
  }
  if (line.trailStatus === "VENDOR_SHORTLISTED") {
    return { index: 1, completed: false, note: null, cancelled: false };
  }
  return { index: 0, completed: false, note: null, cancelled: false };
}

const TRAIL_TEXT: Record<EnquiryLine["trailStatus"], string> = {
  NEW: "New requirement",
  AVAILABILITY_CHECK: "Checking availability",
  VENDOR_SHORTLISTED: "Vendors shortlisted",
  RFQ_SENT: "RFQ sent",
  AWAITING_QUOTES: "Waiting for quotes",
  QUOTES_RECEIVED: "Quotes received",
  UNDER_EVALUATION: "Comparing quotes",
  VENDOR_FINALISED: "Vendor finalised",
  BOOKED: "Booked",
  CLOSED: "Closed",
  FULFILLED_INTERNALLY: "Fulfilled internally",
  CANCELLED: "Cancelled",
};

/** The exact trail, in words a reader does not have to decode. */
export function exactStatusText(line: EnquiryLine): string {
  return TRAIL_TEXT[line.trailStatus];
}

/** The status in one plain sentence for the copy summary and the banner. */
export function lineStatusWord(line: EnquiryLine): string {
  if (line.trailStatus === "CANCELLED") return "Cancelled";
  if (line.trailStatus === "CLOSED") return "Closed";
  if (line.trailStatus === "FULFILLED_INTERNALLY") return "Fulfilled internally";
  if (line.quoteCount && line.quoteCount > 0 && lineStage(line).index === 3) {
    return "Quotes received";
  }
  return exactStatusText(line);
}

// ---------------------------------------------------------------------------
// RFQ facts
// ---------------------------------------------------------------------------

export interface LineRfqSummary {
  /** The line's RFQs, newest first. */
  rows: RfqListRow[];
  /** Newest by creation date, even if it is a draft. */
  latest: RfqListRow | null;
  /**
   * The RFQ worth acting on: the newest sent/closed one, otherwise the newest
   * draft, otherwise the newest cancelled one. A draft raised after a sent RFQ
   * must not hide the live one.
   */
  active: RfqListRow | null;
  /** Quotes across every RFQ on the line, used when the line's own count is stale. */
  quotes: number;
}

export function summariseRfqs(lineId: string, rows: RfqListRow[]): LineRfqSummary {
  const mine = rows
    .filter((row) => row.enquiryLineId === lineId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active =
    mine.find((row) => row.status !== "DRAFT" && row.status !== "CANCELLED") ??
    mine.find((row) => row.status !== "CANCELLED") ??
    mine[0] ??
    null;
  return {
    rows: mine,
    latest: mine[0] ?? null,
    active,
    quotes: mine.reduce((sum, row) => sum + (row.quotedCount ?? 0), 0),
  };
}

export interface LineFacts {
  quotes: number;
  hasRfq: boolean;
  rfqId: string | null;
  rfqNumber: string | null;
  activeRfq: RfqListRow | null;
  rfqCount: number;
  /** A sent RFQ whose deadline has passed with nothing back. */
  expired: boolean;
}

export function lineRfqFacts(
  line: EnquiryLine,
  summary: LineRfqSummary | null | undefined,
  now: Date = new Date(),
): LineFacts {
  const active = summary?.active ?? null;
  const hasSummary = Boolean(summary && summary.rows.length > 0);
  const activeIsLive = Boolean(active && active.status !== "CANCELLED");
  const rfqId = hasSummary
    ? activeIsLive
      ? active!.id
      : null
    : (line.rfqId ?? null);
  const rfqNumber = hasSummary
    ? activeIsLive
      ? active!.rfqNumber
      : null
    : (line.rfqNumber ?? null);
  const quotes = Math.max(line.quoteCount ?? 0, summary?.quotes ?? 0);
  const deadline = active?.submissionDeadline ?? null;
  const expired = Boolean(
    active &&
      active.status === "SENT" &&
      deadline &&
      Date.parse(deadline) < now.getTime() &&
      quotes === 0,
  );
  return {
    quotes,
    hasRfq: Boolean(rfqId),
    rfqId,
    rfqNumber,
    activeRfq: activeIsLive ? active : null,
    rfqCount: summary?.rows.length ?? (line.rfqId ? 1 : 0),
    expired,
  };
}

export function rfqStatusWord(row: RfqListRow): string {
  switch (row.status) {
    case "DRAFT":
      return "draft";
    case "CANCELLED":
      return "cancelled";
    case "CLOSED":
      return "closed";
    default:
      return "sent";
  }
}

/** "deadline in 3 days" / "deadline today" / "deadline passed". */
export function deadlineText(deadline: string | null, now: Date = new Date()): string | null {
  if (!deadline) return null;
  const days = Math.ceil((Date.parse(deadline) - now.getTime()) / DAY_MS);
  if (days < 0) return "deadline passed";
  if (days === 0) return "deadline today";
  if (days === 1) return "deadline tomorrow";
  return `deadline in ${days} days`;
}

export interface RfqSentence {
  rfqId: string | null;
  number: string | null;
  status: string | null;
  detail: string | null;
  /** How many RFQs are on the line; above one, the page says so. */
  count: number;
}

/** The "what is going on" sentence under the stepper. */
export function rfqSentence(
  facts: LineFacts,
  now: Date = new Date(),
): RfqSentence | null {
  if (!facts.rfqId) return null;
  const active = facts.activeRfq;
  if (!active) {
    return {
      rfqId: facts.rfqId,
      number: facts.rfqNumber,
      status: null,
      detail: null,
      count: facts.rfqCount,
    };
  }
  const vendors = active.recipientCount;
  const replied = Math.max(active.quotedCount, facts.quotes);
  const parts: string[] = [];
  if (vendors > 0) parts.push(`${vendors} ${plural(vendors, "vendor")}`);
  if (vendors > 0) parts.push(`${replied} replied`);
  if (active.status === "DRAFT") parts.push("not sent yet");
  else if (active.status === "SENT") {
    const deadline = deadlineText(active.submissionDeadline, now);
    if (deadline) parts.push(deadline);
  } else if (active.status === "CLOSED") {
    parts.push("closed");
  }
  return {
    rfqId: active.id,
    number: active.rfqNumber,
    status: rfqStatusWord(active),
    detail: parts.length > 0 ? parts.join(" · ") : null,
    count: facts.rfqCount,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type LineActionKind = "raise" | "open" | "compare" | "find" | "availability";

export interface LineActionDescriptor {
  kind: LineActionKind;
  label: string;
  /** The RFQ an open action points at. */
  rfqId?: string | null;
}

export interface LineActions {
  primary: LineActionDescriptor | null;
  secondary: LineActionDescriptor[];
}

/**
 * Exactly one primary button, chosen from the state.
 *
 * A new line can never offer "Compare quotes": comparison is only reachable
 * when a quote exists. A sourced line's next action is the paperwork, even if
 * quotes are still listed, so the decision is not re-opened by the layout.
 */
export function lineActions(line: EnquiryLine, facts: LineFacts): LineActions {
  if (
    line.trailStatus === "CANCELLED" ||
    line.trailStatus === "CLOSED" ||
    line.trailStatus === "FULFILLED_INTERNALLY"
  ) {
    return { primary: null, secondary: [] };
  }

  const sourced = line.trailStatus === "VENDOR_FINALISED" || line.trailStatus === "BOOKED";
  if (sourced) {
    return facts.rfqId
      ? { primary: { kind: "open", label: "Open RFQ", rfqId: facts.rfqId }, secondary: [] }
      : { primary: null, secondary: [] };
  }

  if (facts.quotes > 0) {
    return {
      primary: { kind: "compare", label: `Compare quotes (${facts.quotes})` },
      secondary: facts.rfqId
        ? [{ kind: "open", label: "Open RFQ", rfqId: facts.rfqId }]
        : [],
    };
  }

  if (facts.hasRfq && facts.rfqId) {
    return {
      primary: { kind: "open", label: "Open RFQ", rfqId: facts.rfqId },
      secondary: [{ kind: "raise", label: "Raise another RFQ" }],
    };
  }

  return {
    primary: { kind: "raise", label: "Raise RFQ" },
    secondary: [
      { kind: "find", label: "Find cranes" },
      { kind: "availability", label: "Check availability" },
    ],
  };
}

// ---------------------------------------------------------------------------
// "What next?"
// ---------------------------------------------------------------------------

export type NextStepKind = "quotes" | "imminent" | "no-rfq" | "expired" | "all-sourced";

export interface NextStep {
  kind: NextStepKind;
  line: EnquiryLine | null;
  /** Exactly the matching line's primary action. */
  action: LineActionDescriptor | null;
  text: string;
  /** The "all sourced" message is deliberately quiet. */
  muted: boolean;
}

function startValue(line: EnquiryLine): number {
  return line.requiredStartDate ? Date.parse(line.requiredStartDate) : Number.POSITIVE_INFINITY;
}

function byStartThenLine(a: EnquiryLine, b: EnquiryLine): number {
  return startValue(a) - startValue(b) || a.lineNo - b.lineNo;
}

function done(line: EnquiryLine): boolean {
  return ["CLOSED", "FULFILLED_INTERNALLY"].includes(line.trailStatus);
}

function sourced(line: EnquiryLine): boolean {
  return ["VENDOR_FINALISED", "BOOKED"].includes(line.trailStatus);
}

/**
 * The single most urgent suggestion across the lines.
 *
 * Priority is deliberate: a quote waiting to be compared is money on the table;
 * a start date inside two weeks with no RFQ is a delivery risk; a missing RFQ
 * is the ordinary next step; a closed RFQ with nothing back needs a decision.
 */
export function pickNextStep(
  lines: EnquiryLine[],
  summaries: Record<string, LineRfqSummary | undefined>,
  now: Date = new Date(),
): NextStep | null {
  const live = lines.filter((line) => line.trailStatus !== "CANCELLED" && !done(line));
  if (live.length === 0) return null;

  const facts = new Map(
    live.map((line) => [line.id, lineRfqFacts(line, summaries[line.id], now)] as const),
  );

  const quoteLines = live
    .filter((line) => {
      const fact = facts.get(line.id)!;
      return fact.quotes > 0 && !sourced(line);
    })
    .sort(byStartThenLine);
  if (quoteLines.length > 0) {
    const line = quoteLines[0]!;
    const fact = facts.get(line.id)!;
    const actions = lineActions(line, fact);
    return {
      kind: "quotes",
      line,
      action: actions.primary,
      text: `${lineShort(line)} has ${fact.quotes} ${plural(fact.quotes, "quote")} ready to compare.`,
      muted: false,
    };
  }

  const noRfq = live
    .filter((line) => !facts.get(line.id)!.hasRfq && !sourced(line))
    .sort(byStartThenLine);

  const imminent = noRfq.filter((line) => {
    const start = dayOf(line.requiredStartDate);
    return start !== null && daysUntil(start, now) <= 14;
  });
  if (imminent.length > 0) {
    const line = imminent[0]!;
    const start = dayOf(line.requiredStartDate)!;
    const days = daysUntil(start, now);
    const when =
      days < -1
        ? `started ${Math.abs(days)} days ago`
        : days === -1
          ? "started yesterday"
          : days === 0
            ? "starts today"
            : `starts in ${days} days`;
    return {
      kind: "imminent",
      line,
      action: lineActions(line, facts.get(line.id)!).primary,
      text: `${lineShort(line)} ${when} and has no RFQ yet.`,
      muted: false,
    };
  }

  if (noRfq.length > 0) {
    const line = noRfq[0]!;
    return {
      kind: "no-rfq",
      line,
      action: lineActions(line, facts.get(line.id)!).primary,
      text: `${lineShort(line)} needs vendors. Raise an RFQ.`,
      muted: false,
    };
  }

  const expired = live
    .filter((line) => facts.get(line.id)!.expired)
    .sort(byStartThenLine);
  if (expired.length > 0) {
    const line = expired[0]!;
    const fact = facts.get(line.id)!;
    return {
      kind: "expired",
      line,
      action: lineActions(line, fact).primary,
      text: `${fact.rfqNumber ?? "The RFQ"} closed with no quotes.`,
      muted: false,
    };
  }

  const allSourced = live.every((line) => sourced(line));
  if (allSourced) {
    return {
      kind: "all-sourced",
      line: null,
      action: null,
      text: "All lines sourced. Nothing to do here.",
      muted: true,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Full requirements
// ---------------------------------------------------------------------------

export interface RequirementItem {
  label: string;
  value: string;
  internal?: boolean;
}

export interface RequirementGroup {
  title: string;
  items: RequirementItem[];
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function metres(value: number | null, label: string): RequirementItem | null {
  return value === null ? null : { label, value: `${number(value)} m` };
}

function present(items: Array<RequirementItem | null>): RequirementItem[] {
  return items.filter((item): item is RequirementItem => item !== null);
}

/** The rest of the line, grouped and with empty fields left out. */
export function requirementGroups(line: EnquiryLine): RequirementGroup[] {
  const scope = present([
    text(line.applicationDescription)
      ? { label: "Application", value: text(line.applicationDescription)! }
      : null,
    text(line.loadDescription)
      ? { label: "Load", value: text(line.loadDescription)! }
      : null,
    line.liftLoadT !== null
      ? { label: "Lift load", value: `${number(line.liftLoadT)} t` }
      : null,
    metres(line.workingRadiusM, "Working radius"),
    metres(line.requiredMainBoomM, "Main boom"),
    metres(line.requiredFixedJibM, "Fixed jib"),
    metres(line.requiredLuffingJibM, "Luffing jib"),
    metres(line.requiredWindJibM, "Wind jib"),
    text(line.configurationNotes)
      ? { label: "Configuration", value: text(line.configurationNotes)! }
      : null,
    durationText(line) ? { label: "Duration", value: durationText(line)! } : null,
    line.workingDaysPerMonth !== null
      ? { label: "Working days", value: `${line.workingDaysPerMonth} days/month` }
      : null,
  ]);

  const commercial = present([
    text(line.mobilisationTerms)
      ? { label: "Mobilisation", value: text(line.mobilisationTerms)! }
      : null,
    text(line.demobilisationTerms)
      ? { label: "Demobilisation", value: text(line.demobilisationTerms)! }
      : null,
    text(line.otCharges) ? { label: "OT charges", value: text(line.otCharges)! } : null,
    text(line.breakdownTerms)
      ? { label: "Breakdown", value: text(line.breakdownTerms)! }
      : null,
    text(line.dieselScope) ? { label: "Diesel", value: text(line.dieselScope)! } : null,
    text(line.workingHoursShift)
      ? { label: "Working hours / shift", value: text(line.workingHoursShift)! }
      : null,
    text(line.accommodationConveyance)
      ? { label: "Accommodation & conveyance", value: text(line.accommodationConveyance)! }
      : null,
    text(line.paymentTerms) ? { label: "Payment terms", value: text(line.paymentTerms)! } : null,
    text(line.extensionClause)
      ? { label: "Extension clause", value: text(line.extensionClause)! }
      : null,
    text(line.insuranceTerms) ? { label: "Insurance", value: text(line.insuranceTerms)! } : null,
    line.craneAgeCriteriaYears !== null
      ? { label: "Crane age", value: `${line.craneAgeCriteriaYears} years or newer` }
      : null,
    text(line.otherTerms) ? { label: "Other terms", value: text(line.otherTerms)! } : null,
  ]);

  const siteAndCompliance = present([
    text(line.steelMatsGroundPrepScope)
      ? { label: "Steel mats & ground prep", value: text(line.steelMatsGroundPrepScope)! }
      : null,
    text(line.ehsHrCompliance)
      ? { label: "EHS & HR", value: text(line.ehsHrCompliance)! }
      : null,
    text(line.ppeScope) ? { label: "PPE", value: text(line.ppeScope)! } : null,
    text(line.rowScope) ? { label: "Right of way", value: text(line.rowScope)! } : null,
    text(line.intraSiteMovementScope)
      ? { label: "Intra-site movement", value: text(line.intraSiteMovementScope)! }
      : null,
    text(line.supportCraneScope)
      ? { label: "Support crane", value: text(line.supportCraneScope)! }
      : null,
    text(line.additionalManpowerScope)
      ? { label: "Additional manpower", value: text(line.additionalManpowerScope)! }
      : null,
    text(line.prereleaseTerms)
      ? { label: "Pre-release", value: text(line.prereleaseTerms)! }
      : null,
  ]);

  const internal = present([
    text(line.rentalBudget)
      ? { label: "Rental budget", value: text(line.rentalBudget)!, internal: true }
      : null,
  ]);

  return [
    { title: "Scope", items: scope },
    { title: "Commercial terms", items: commercial },
    { title: "Site and compliance", items: siteAndCompliance },
    { title: "Internal", items: internal },
  ].filter((group) => group.items.length > 0);
}

// ---------------------------------------------------------------------------
// Clipboard and activity
// ---------------------------------------------------------------------------

/**
 * The short summary the menu copies. Internal fields — the rental budget — are
 * deliberately absent: this text gets pasted into chats and emails.
 */
export function enquirySummaryText(enquiry: EnquiryDetail): string {
  const header = `${enquiry.enquiryNo} — ${enquiry.customerName}`;
  const context = `${siteLine(enquiry)} · Raised ${formatLongDate(enquiry.enquiryDate)}`;
  const lines = enquiry.lines.map((line) => {
    const start = line.requiredStartDate
      ? `starts ${formatLongDate(line.requiredStartDate)}`
      : "start TBC";
    const duration = durationText(line);
    return [
      lineTitle(line),
      [lineStatusWord(line), start, duration].filter(Boolean).join(" · "),
    ].join("\n");
  });
  return [header, context, "", ...lines].join("\n");
}

export interface ActivityItem {
  id: string;
  at: string;
  text: string;
}

const ACTIVITY_LIMIT = 5;

function changeTo(entry: HistoryEntry, field: string): unknown {
  return entry.changes.find((change) => change.field === field)?.to;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * The last few user-meaningful audit entries.
 *
 * The history endpoint is already the sourcing trail; this only turns it into
 * sentences. Rollups and no-op updates are filtered out, because they describe
 * the machinery rather than an action a salesperson took.
 */
export function mapActivity(
  entries: HistoryEntry[],
  lines: EnquiryLine[],
  rfqs: RfqListRow[],
  limit = ACTIVITY_LIMIT,
): ActivityItem[] {
  const lineNo = new Map(lines.map((line) => [line.id, line.lineNo] as const));
  const rfqNo = new Map(rfqs.map((rfq) => [rfq.id, rfq.rfqNumber] as const));

  const items: ActivityItem[] = [];
  for (const entry of [...entries].sort((a, b) => b.at.localeCompare(a.at))) {
    const value = record(entry.newValue);
    const number =
      rfqNo.get(entry.entityId) ??
      (typeof value.rfqNumber === "string" ? value.rfqNumber : null);
    let text: string | null = null;

    if (entry.entity === "rfq") {
      switch (entry.action) {
        case "create":
          text = `${number ?? "RFQ"} raised`;
          break;
        case "send": {
          const recipients = typeof value.recipients === "number" ? value.recipients : null;
          text = `${number ?? "RFQ"} sent${
            recipients ? ` to ${recipients} ${plural(recipients, "vendor")}` : ""
          }`;
          break;
        }
        case "remind":
          text = `Reminder sent for ${number ?? "the RFQ"}`;
          break;
        case "cancel":
          text = `${number ?? "RFQ"} cancelled`;
          break;
        case "extend_deadline":
          text = `${number ?? "RFQ"} deadline extended`;
          break;
        case "award":
          text = `Quote awarded on ${number ?? "an RFQ"}`;
          break;
        default:
          text = null;
      }
    } else if (entry.entity === "quotation") {
      switch (entry.action) {
        case "submit":
          text = `Quote received${number ? ` for ${number}` : ""}`;
          break;
        case "revise":
          text = `Quote revised${number ? ` for ${number}` : ""}`;
          break;
        case "withdraw":
          text = "Quote withdrawn";
          break;
        default:
          text = null;
      }
    } else if (entry.entity === "enquiry_line") {
      const line = lineNo.get(entry.entityId);
      if (entry.action === "trail") {
        const to = changeTo(entry, "trailStatus") ?? value.trailStatus;
        const label = typeof to === "string" ? TRAIL_TEXT[to as EnquiryLine["trailStatus"]] : null;
        if (label && to !== "NEW") {
          text = `Line ${line ?? "?"} moved to ${label.toLowerCase()}`;
        }
      } else if (entry.action === "update") {
        text = line ? `Line ${line} edited` : null;
      } else if (entry.action === "cancel") {
        text = line ? `Line ${line} cancelled` : null;
      }
    } else if (entry.entity === "enquiry" && entry.action === "create") {
      text = "Enquiry raised";
    }

    if (text) items.push({ id: entry.id, at: entry.at, text });
    if (items.length >= limit) break;
  }
  return items;
}
