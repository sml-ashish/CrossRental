/**
 * Pure display helpers for negotiation threads, shared by the SML and vendor
 * screens so the same status or offer reads identically in both places.
 */

import type { BadgeTone } from "@/components/ui/badge";
import { RATE_BASIS_LABELS } from "@/lib/quotations";
import type {
  NegotiationRound,
  NegotiationStatus,
  OfferWarning,
} from "@/lib/negotiations";

export function inr(value: number): string {
  return value.toLocaleString("en-IN");
}

export const NEGOTIATION_STATUS_LABELS: Record<NegotiationStatus, string> = {
  AWAITING_VENDOR: "Awaiting vendor",
  AWAITING_SML: "Awaiting SML",
  AGREED: "Agreed",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

/** Vendor-facing wording avoids the internal acronym. */
export const NEGOTIATION_STATUS_LABELS_VENDOR: Record<NegotiationStatus, string> = {
  AWAITING_VENDOR: "Your response needed",
  AWAITING_SML: "With SML",
  AGREED: "Agreed",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

export function negotiationTone(status: NegotiationStatus): BadgeTone {
  switch (status) {
    case "AWAITING_VENDOR":
      return "amber";
    case "AWAITING_SML":
      return "blue";
    case "AGREED":
      return "emerald";
    case "DECLINED":
    case "CANCELLED":
    case "EXPIRED":
      return "red";
    default:
      return "neutral";
  }
}

export const RATE_BASIS_OPTIONS = (
  Object.keys(RATE_BASIS_LABELS) as Array<keyof typeof RATE_BASIS_LABELS>
).map((value) => ({ value, label: RATE_BASIS_LABELS[value] }));

export const TAX_BASIS_OPTIONS = [
  { value: "EXCLUSIVE_OF_GST", label: "Exclusive of GST" },
  { value: "INCLUSIVE_OF_GST", label: "Inclusive of GST" },
];

/** The most recent offer in a thread (rounds are ordered ascending). */
export function latestRound(rounds: NegotiationRound[]): NegotiationRound | null {
  return rounds.at(-1) ?? null;
}

/** The last offer made by a given party, or null if none yet. */
export function lastRoundBy(
  rounds: NegotiationRound[],
  party: NegotiationRound["offeredBy"],
): NegotiationRound | null {
  return rounds.filter((round) => round.offeredBy === party).at(-1) ?? null;
}

/**
 * The backend requires `acknowledgeWarnings` whenever its preview returns any
 * warning at all — including the `TAX_BASIS_DIFFERS` advisory note, not just the
 * price-raise warnings. Mirroring that exactly here keeps the checkbox in sync
 * with the server guard instead of producing a WARNINGS_NOT_ACKNOWLEDGED error.
 */
export function needsWarningAcknowledgement(warnings: OfferWarning[]): boolean {
  return warnings.length > 0;
}

/** A short "₹X (+₹Y, +Z%)" delta fragment, or null for no delta. */
export function deltaLabel(delta: { amount: number; percent: number } | undefined): string | null {
  if (!delta || (delta.amount === 0 && delta.percent === 0)) return null;
  const sign = delta.amount > 0 ? "+" : "−";
  return `${sign}₹${inr(Math.abs(delta.amount))} (${sign}${Math.abs(delta.percent)}%)`;
}

export function timeLeft(iso: string): string | null {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "Response window closed";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} left`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} left`;
}
