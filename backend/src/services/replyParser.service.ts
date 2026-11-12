import { RateBasis } from "../generated/prisma/client";
import { parseDateInput, startOfUtcDay } from "../lib/dates";

/**
 * P6 free-text reply parser.
 *
 * Vendors answer by email or WhatsApp in prose, not in a form. This module turns
 * the common shapes into fields the validation queue can pre-fill. It is
 * deliberately conservative: anything it cannot read stays null and the reply
 * waits for an admin, rather than guessing a price.
 */
export interface ParsedReplyFields {
  rentalRate: number | null;
  rateBasis: RateBasis | null;
  mobilisationCharges: number | null;
  demobilisationCharges: number | null;
  availabilityConfirmed: boolean | null;
  availableFrom: Date | null;
  validityDate: Date | null;
  craneRef: string | null;
  remarks: string | null;
  acceptsCommercialTerms: boolean | null;
}

const EMPTY: ParsedReplyFields = {
  rentalRate: null,
  rateBasis: null,
  mobilisationCharges: null,
  demobilisationCharges: null,
  availabilityConfirmed: null,
  availableFrom: null,
  validityDate: null,
  craneRef: null,
  remarks: null,
  acceptsCommercialTerms: null,
};

function amount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function labelled(text: string, labels: string[]): string | null {
  const pattern = new RegExp(
    `(?:${labels.join("|")})\\s*(?:is|are|:|=|-|of)?\\s*(?:rs\\.?|inr|₹)?\\s*([\\d,]+(?:\\.\\d+)?)`,
    "i",
  );
  const match = text.match(pattern);
  return match?.[1] ?? null;
}

function labelledText(text: string, labels: string[]): string | null {
  const pattern = new RegExp(
    `(?:${labels.join("|")})\\s*(?:is|are|:|=|-)?\\s*([^\\n;]+)`,
    "i",
  );
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  return value ? value.replace(/[.,;]+$/, "").trim() : null;
}

/** Accepts 2026-11-15, 15/11/2026, 15-11-2026 and 15 Nov 2026. */
export function parseLooseDate(raw: string): Date | null {
  const value = raw.trim();
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return parseDateInput(`${iso[1]}-${iso[2]}-${iso[3]}`);

  const dmy = value.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    ) {
      return parsed;
    }
  }

  const named = value.match(
    /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{2,4})\b/i,
  );
  if (named) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(named[2]!.toLowerCase().slice(0, 3));
    const year = Number(named[3]!.length === 2 ? `20${named[3]}` : named[3]);
    const parsed = new Date(Date.UTC(year, month, Number(named[1])));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const any = parseDateInput(value);
  return any === null ? null : startOfUtcDay(any);
}

function basisFrom(text: string): RateBasis | null {
  if (/\b(lump\s*sum|one\s*time|whole\s*job)\b/i.test(text)) return RateBasis.LUMP_SUM;
  if (/\b(per\s*month|monthly|\/\s*month|p\.?m\.?)\b/i.test(text)) return RateBasis.PER_MONTH;
  if (/\b(per\s*day|daily|\/\s*day|p\.?d\.?)\b/i.test(text)) return RateBasis.PER_DAY;
  return null;
}

export function parseReply(text: string): ParsedReplyFields {
  const body = text.replace(/\r/g, "");
  if (!body.trim()) return { ...EMPTY };

  const labelledRate = labelled(body, ["rental\\s*rate", "day\\s*rate", "monthly\\s*rate", "rate", "quoted\\s*price", "price"]);
  // A bare amount followed by a period word ("4500 per day") is the usual
  // WhatsApp answer, and is only consulted when no label was present.
  const bareRate = body.match(/(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*|per\s*)(day|month)\b/i);
  const rentalRate = amount(labelledRate ?? bareRate?.[1] ?? "");

  const basis =
    basisFrom(body) ??
    (labelledRate === null && bareRate?.[2]?.toLowerCase() === "month"
      ? RateBasis.PER_MONTH
      : labelledRate === null && bareRate?.[2]?.toLowerCase() === "day"
        ? RateBasis.PER_DAY
        : null);

  const mobilisation =
    amount(labelled(body, ["mobilisation", "mobilization", "mob"]) ?? "") ?? null;
  const demobilisation =
    amount(labelled(body, ["demobilisation", "demobilization", "demob"]) ?? "") ?? null;

  const availabilityConfirmed = /\b(not\s+available|unavailable|can(?:no|')t\s+offer|no\s+availability)\b/i.test(body)
    ? false
    : /\b(available|availability\s*(?:is|:)?\s*yes|can\s+offer)\b/i.test(body)
      ? true
      : null;

  const availableFromRaw = labelledText(body, ["available\\s*from", "free\\s*from", "available\\s*on"]);
  const validityRaw = labelledText(body, ["valid(?:ity)?\\s*(?:until|upto|up\\s*to|date)?", "quote\\s*valid"]);
  const craneRaw = labelledText(body, ["crane\\s*(?:ref(?:erence)?|no\\.?|number|registration)?", "registration"]);
  const remarks = labelledText(body, ["remarks?", "comments?", "note"]);
  const availableFrom = availableFromRaw ? parseLooseDate(availableFromRaw) : null;
  const parsedValidity = validityRaw ? parseLooseDate(validityRaw) : null;

  const acceptsCommercialTerms = /\b(do\s+not|don't|not)\s+accept\b/i.test(body)
    ? false
    : /\b(accept|agree|accepted|agreed)\b/i.test(body)
      ? true
      : null;

  return {
    rentalRate,
    rateBasis: basis,
    mobilisationCharges: mobilisation,
    demobilisationCharges: demobilisation,
    availabilityConfirmed,
    availableFrom,
    validityDate: parsedValidity ? startOfUtcDay(parsedValidity) : null,
    craneRef: craneRaw && !/^(?:is|are|available|not)$/i.test(craneRaw) ? craneRaw : null,
    remarks,
    acceptsCommercialTerms,
  };
}
