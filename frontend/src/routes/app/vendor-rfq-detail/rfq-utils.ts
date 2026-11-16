import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { deadlineRelative } from "@/lib/rfq-display";
import type { VendorRfqDetail } from "@/lib/quotations";

/**
 * Small, browser-only helpers for the vendor's RFQ screen.
 *
 * Nothing here prices a quote or reads a server rule: the totals still come from
 * `previewQuotation`, and the deadline still comes from the RFQ. These functions
 * only turn facts the page already has into dates, a calendar file and a plain
 * text summary — so a dispatcher can answer "when is this and what is it?" from
 * a phone without opening the page again.
 */

type Rfq = VendorRfqDetail["rfq"];

const DAY_MS = 86_400_000;
const ICS_HOUR_MS = 3_600_000;

/** "12 Dec 2026" — a calendar day, printed as the UTC day it names. */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function durationLabel(rfq: Rfq): string {
  const unit = rfq.durationUnit === "MONTHS" ? "month" : "day";
  return `${rfq.durationValue} ${unit}${rfq.durationValue === 1 ? "" : "s"}`;
}

/**
 * The last day of the lift, from the start date and the duration.
 *
 * Months are calendar months, not the 30-day rate convention — that convention
 * belongs to the quote arithmetic on the server and must not leak into a date a
 * vendor writes on a calendar. `null` whenever the start itself is still TBC.
 */
export function expectedEndDate(rfq: Rfq): string | null {
  if (rfq.startDateTbc) return null;
  const start = new Date(rfq.requiredStartDate);
  if (Number.isNaN(start.getTime())) return null;

  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  if (rfq.durationUnit === "MONTHS") {
    end.setUTCMonth(end.getUTCMonth() + rfq.durationValue);
  } else {
    end.setUTCDate(end.getUTCDate() + rfq.durationValue);
  }
  // A duration of N days/months ends the day before the next period starts.
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

/** Whole calendar days until the required start; `null` when it is TBC. */
export function daysUntilStart(rfq: Rfq): number | null {
  if (rfq.startDateTbc) return null;
  const start = new Date(rfq.requiredStartDate);
  if (Number.isNaN(start.getTime())) return null;

  const startDay = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((startDay - today) / DAY_MS);
}

export function startHint(rfq: Rfq): string {
  const days = daysUntilStart(rfq);
  if (days === null) return "Start date to be confirmed";
  if (days === 0) return "Starts today";
  if (days === 1) return "Starts tomorrow";
  if (days > 1) return `Starts in ${days} days`;
  if (days === -1) return "Start date has passed";
  return `Start date passed ${Math.abs(days)} days ago`;
}

/**
 * When to move the crane. Mobilisation is not a field on the RFQ, so this is
 * only a hint derived from the start date — never a stored commitment.
 */
export function mobilisationWindow(rfq: Rfq): string | null {
  if (rfq.startDateTbc) return null;
  const start = new Date(rfq.requiredStartDate);
  if (Number.isNaN(start.getTime())) return null;
  const move = new Date(start.getTime() - 2 * DAY_MS);
  return `Plan mobilisation from ${shortDate(move.toISOString().slice(0, 10))}`;
}

/** The countdown label and tone for a live or closed RFQ. */
export function deadlineInfo(rfq: Rfq): { label: string; tone: "neutral" | "soon" | "overdue" } {
  if (rfq.locked) return { label: "finalised", tone: "neutral" };
  return deadlineRelative(rfq.submissionDeadline);
}

/** RFC 5545 wants commas, semicolons and backslashes escaped. */
function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A calendar reminder for the quote deadline, built in the browser. No backend
 * field and no calendar API — the vendor downloads a file they can open in any
 * calendar.
 */
export function buildIcs(rfq: Rfq): string {
  const start = new Date(rfq.submissionDeadline);
  const startMs = Number.isNaN(start.getTime()) ? Date.now() : start.getTime();
  const location = [rfq.siteLocation, rfq.siteStateName, rfq.sitePincode]
    .filter(Boolean)
    .join(", ");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//crossrentel//Vendor RFQ//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${rfq.rfqId}@crossrentel`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(startMs)}`,
    `DTEND:${icsStamp(startMs + ICS_HOUR_MS)}`,
    `SUMMARY:${icsText(`Quote due — ${rfq.rfqNumber}`)}`,
    `DESCRIPTION:${icsText(
      `${rfq.enquiryNo}${rfq.lineNo ? ` · line ${rfq.lineNo}` : ""}\n` +
        `${rfq.craneTypeName} · ${rfq.capacityT} t (${rfq.capacityRule === "EXACT" ? "exact" : "at least"}) · qty ${rfq.quantity}\n` +
        `Required start: ${rfq.startDateTbc ? "to be confirmed" : formatCalendarDate(rfq.requiredStartDate)}\n` +
        `Duration: ${durationLabel(rfq)}`,
    )}`,
    location ? `LOCATION:${icsText(location)}` : null,
    "BEGIN:VALARM",
    "TRIGGER:-PT1440M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(`Quote due tomorrow — ${rfq.rfqNumber}`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter((line): line is string => line !== null)
    .join("\r\n");
}

/** Downloads the reminder as `quote-due-<rfq>.ics`. */
export function downloadIcs(rfq: Rfq): void {
  const blob = new Blob([buildIcs(rfq)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `quote-due-${rfq.rfqNumber.replace(/[^A-Za-z0-9-]/g, "")}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * A plain-text version of the requirement, for a WhatsApp message or a forward.
 * Deliberately limited to vendor-visible facts: no customer, budget or SML notes
 * beyond the ones SML wrote for vendors.
 */
export function buildRfqSummary(rfq: Rfq): string {
  const lines = [
    `RFQ ${rfq.rfqNumber} (${rfq.enquiryNo}${rfq.lineNo ? ` · line ${rfq.lineNo}` : ""})`,
    `${rfq.craneTypeName} · ${rfq.capacityT} t (${rfq.capacityRule === "EXACT" ? "exact" : "at least"}) · qty ${rfq.quantity}`,
    `Start: ${rfq.startDateTbc ? "to be confirmed" : formatCalendarDate(rfq.requiredStartDate)} · Duration: ${durationLabel(rfq)}`,
    `Site: ${rfq.siteLocation}, ${rfq.siteStateName}${rfq.sitePincode ? ` ${rfq.sitePincode}` : ""}`,
    `Quotes due: ${formatDateTime(rfq.submissionDeadline)}`,
  ];
  if (rfq.configuration) lines.push(`Configuration: ${rfq.configuration}`);
  if (rfq.applicationDescription) lines.push(`Application: ${rfq.applicationDescription}`);
  if (rfq.loadDescription) lines.push(`Load: ${rfq.loadDescription}`);
  if (rfq.notes) lines.push(`Notes from SML: ${rfq.notes}`);
  if (rfq.smlContact.name || rfq.smlContact.mobile) {
    lines.push(
      `SML contact: ${[rfq.smlContact.name, rfq.smlContact.mobile, rfq.smlContact.email]
        .filter(Boolean)
        .join(" · ")}`,
    );
  }
  return lines.join("\n");
}

/** Clipboard write with a textarea fallback for browsers that refuse the API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

/**
 * Prints the requirement alone. The print stylesheet keys off the
 * `data-print="rfq"` attribute so the rest of the workspace stays out of the
 * printout without a second print layout.
 */
export function printRequirement(): void {
  const root = document.documentElement;
  const cleanup = () => {
    delete root.dataset.print;
    window.removeEventListener("afterprint", cleanup);
  };
  root.dataset.print = "rfq";
  window.addEventListener("afterprint", cleanup);
  window.print();
}

/** Maps a site location and PIN to a plain Maps search; no API key. */
export function mapsUrl(rfq: Rfq): string {
  const query = [rfq.siteLocation, rfq.siteStateName, rfq.sitePincode]
    .filter(Boolean)
    .join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
