import {
  LINE_STEPS,
  lineStatusFromValue,
  lineStatusOf,
  type EnquiryDetail,
  type EnquiryLine,
} from "@/lib/enquiries";
import type { HistoryEntry } from "@/lib/enquiryHistory";
import type { RfqListRow } from "@/lib/rfqs";
import { cityOf, titleCase } from "@/lib/format";

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

/** "Maharashtra, Pune" — state first, with the state never repeated. */
export function siteLine(enquiry: Pick<
  EnquiryDetail,
  "shipToCity" | "siteStateCode" | "siteStateName"
>): string {
  const city = titleCase(enquiry.shipToCity.trim());
  const state = enquiry.siteStateName
    ? titleCase(enquiry.siteStateName)
    : enquiry.siteStateCode
      ? titleCase(enquiry.siteStateCode)
      : "";
  if (!state || city.toLowerCase().includes(state.toLowerCase())) return city;
  return `${state}, ${city}`;
}

export function siteCity(enquiry: Pick<EnquiryDetail, "shipToCity">): string {
  return cityOf({ siteLocation: enquiry.shipToCity });
}

// ---------------------------------------------------------------------------
// The line itself
// ---------------------------------------------------------------------------

/** "Line 1 · 250 t+ Crawler Crane". */
export function lineTitle(line: EnquiryLine): string {
  const type =
    line.craneTypeName?.trim() ||
    (line.craneTypeCode ? `${titleCase(line.craneTypeCode)} Crane` : "Crane");
  const capacity = line.capacityT !== null ? `${number(line.capacityT)} t+` : null;
  const subject = capacity ? `${capacity} ${type}` : type;
  return `Line ${line.lineNo} · ${subject}`;
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
  const status = lineStatusOf(line);
  if (status === "Booked" || status === "Cancelled") return null;
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

/** "Lift 120 t to 30 m height" — only the parts that were entered. */
export function liftSummary(line: EnquiryLine): string | null {
  const parts: string[] = [];
  if (line.liftLoadT !== null) parts.push(`Lift ${number(line.liftLoadT)} t`);
  if (line.liftHeightM !== null) parts.push(`to ${number(line.liftHeightM)} m height`);
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
// The four progress steps, plus Cancelled as a terminal outcome
// ---------------------------------------------------------------------------

export interface LineStage {
  /** 0 to 3 for progress steps; -1 when the line was cancelled. */
  index: number;
  /** True for a booked line: every progress step is done. */
  completed: boolean;
  /** True when the line reads Cancelled. */
  cancelled: boolean;
}

/**
 * The stepper and the status pill come from the same fold, so they can never
 * disagree. Booked is the last step; Cancelled sits outside the progression.
 */
export function lineStage(line: EnquiryLine): LineStage {
  const status = lineStatusOf(line);
  if (status === "Cancelled") return { index: -1, completed: false, cancelled: true };
  if (status === "Booked") {
    return { index: LINE_STEPS.length - 1, completed: true, cancelled: false };
  }
  const index = LINE_STEPS.indexOf(status);
  return { index: index < 0 ? 0 : index, completed: false, cancelled: false };
}

/** The status in one plain word for the copy summary and the stepper caption. */
export function lineStatusWord(line: EnquiryLine): string {
  return lineStatusOf(line);
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

export type LineActionKind = "raise" | "open" | "find" | "availability";

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
 * Once an RFQ exists, the line's only action is to open it. Comparison lives
 * inside the RFQ, where the terms and counter-offers can be read together, so
 * the enquiry never offers a competing "Compare quotes" shortcut.
 */
export function lineActions(line: EnquiryLine, facts: LineFacts): LineActions {
  if (lineStatusOf(line) === "Cancelled") {
    return { primary: null, secondary: [] };
  }

  if (facts.rfqId) {
    return { primary: { kind: "open", label: "Open RFQ", rfqId: facts.rfqId }, secondary: [] };
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
    text(line.craneModel) ? { label: "Crane model", value: text(line.craneModel)! } : null,
    line.yom !== null ? { label: "YOM", value: String(line.yom) } : null,
    text(line.craneConfiguration)
      ? { label: "Crane configuration", value: text(line.craneConfiguration)! }
      : null,
    text(line.applicationDescription)
      ? { label: "Application", value: text(line.applicationDescription)! }
      : null,
    line.liftLoadT !== null
      ? { label: "Weight to be lifted", value: `${number(line.liftLoadT)} t` }
      : null,
    metres(line.liftHeightM, "Height to be lifted"),
    durationText(line) ? { label: "Duration", value: durationText(line)! } : null,
    line.workingDaysPerMonth !== null
      ? { label: "Working days", value: `${line.workingDaysPerMonth} days/month` }
      : null,
  ]);

  const commercial = present([
    text(line.otCharges) ? { label: "OT charges", value: text(line.otCharges)! } : null,
    text(line.breakdownTerms)
      ? { label: "Breakdown Charges", value: text(line.breakdownTerms)! }
      : null,
    text(line.dieselScope) ? { label: "Diesel", value: text(line.dieselScope)! } : null,
    text(line.workingHoursPerDay)
      ? { label: "Working hours (per day)", value: text(line.workingHoursPerDay)! }
      : null,
    text(line.shift) ? { label: "Shift", value: text(line.shift)! } : null,
    !text(line.workingHoursPerDay) && !text(line.shift) && text(line.workingHoursShift)
      ? { label: "Working hours / shift", value: text(line.workingHoursShift)! }
      : null,
    text(line.insuranceTerms)
      ? { label: "Insurance Coverage", value: text(line.insuranceTerms)! }
      : null,
    line.craneAgeCriteriaYears !== null
      ? { label: "Crane age", value: `${line.craneAgeCriteriaYears} years or newer` }
      : null,
  ]);

  const siteAndCompliance = present([
    text(line.steelMatsGroundPrepScope)
      ? { label: "Steel mats & ground prep", value: text(line.steelMatsGroundPrepScope)! }
      : null,
    text(line.ehsHrCompliance)
      ? { label: "EHS & HR", value: text(line.ehsHrCompliance)! }
      : null,
    text(line.rowScope) ? { label: "Right of way", value: text(line.rowScope)! } : null,
    text(line.supportCraneScope)
      ? { label: "Support crane", value: text(line.supportCraneScope)! }
      : null,
    text(line.additionalManpowerScope)
      ? { label: "Additional manpower", value: text(line.additionalManpowerScope)! }
      : null,
  ]);

  return [
    { title: "Scope", items: scope },
    { title: "Commercial terms", items: commercial },
    { title: "Site and compliance", items: siteAndCompliance },
  ].filter((group) => group.items.length > 0);
}

// ---------------------------------------------------------------------------
// Clipboard and activity
// ---------------------------------------------------------------------------

/**
 * The short summary the menu copies. This text gets pasted into chats and
 * emails, so it carries only the enquiry number and the site.
 */
export function enquirySummaryText(enquiry: EnquiryDetail): string {
  const header = `${enquiry.enquiryNo} — ${enquiry.shipToCity}`;
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
        const label = typeof to === "string" ? lineStatusFromValue(to) : null;
        if (label && label !== "Sourcing pending") {
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
