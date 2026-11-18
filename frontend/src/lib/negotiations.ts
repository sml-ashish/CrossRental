/**
 * Client for counter-quote / negotiation threads (phase 1 + 2).
 *
 * Two surfaces, mirroring the backend exactly:
 *  - `/api/rfqs/...` is internal (sales + admin) and refuses vendor tokens;
 *  - `/api/vendor/...` is gated on the vendor capability, and the service scopes
 *    every id to the token's vendor id.
 *
 * Nothing here decides who may see what: the API is the source of access truth.
 * The client never sends a total — every offer is a set of structured terms that
 * the server prices with the same `calculateTotal` a quotation uses.
 */

import { api } from "@/lib/api";

export type NegotiationStatus =
  | "AWAITING_VENDOR"
  | "AWAITING_SML"
  | "AGREED"
  | "DECLINED"
  | "EXPIRED"
  | "CANCELLED";

export type NegotiationParty = "SML" | "VENDOR";

export type RoundOutcome =
  | "OPEN"
  | "ACCEPTED"
  | "COUNTERED"
  | "DECLINED"
  | "EXPIRED"
  | "CANCELLED";

export type RateBasis = "PER_DAY" | "PER_MONTH" | "LUMP_SUM";
export type TaxBasis = "EXCLUSIVE_OF_GST" | "INCLUSIVE_OF_GST";

export interface OfferWarning {
  code: string;
  message: string;
}

/** One offer in the thread. Totals are always computed by the server. */
export interface NegotiationRound {
  roundId: string;
  roundNumber: number;
  offeredBy: NegotiationParty;
  offeredByUserId: string | null;
  onBehalfOfVendor: boolean;
  channel: string | null;
  rentalRate: number;
  rateBasis: RateBasis;
  mobilisationCharges: number;
  demobilisationCharges: number;
  taxBasis: TaxBasis;
  validityDate: string;
  availableFrom: string | null;
  availabilityConfirmed: boolean;
  deviationText: string | null;
  message: string | null;
  totalQuotedValue: number;
  calculationNote: string;
  warnings: OfferWarning[];
  warningsAcknowledged: boolean;
  isFinal: boolean;
  respondBy: string;
  outcome: RoundOutcome;
  respondedAt: string | null;
  createdAt: string;
}

export interface NegotiationThread {
  negotiationId: string;
  rfqId: string;
  vendorId: string;
  craneId: string;
  craneLabel: string;
  /** Hidden from vendors by the backend. */
  vendorName: string | null;
  status: NegotiationStatus;
  currentRound: number;
  maxRounds: number;
  /** Optimistic-concurrency token — send this back with every write. */
  version: number;
  closedReason: string | null;
  closedAt: string | null;
  deadlinePassed: boolean;
  baseQuotation: {
    quotationId: string;
    version: number;
    totalQuotedValue: number;
    rentalRate: number;
    rateBasis: RateBasis;
    mobilisationCharges: number;
    demobilisationCharges: number;
    taxBasis: TaxBasis;
    validityDate: string;
    availableFrom: string | null;
    deviationText: string | null;
  };
  agreedQuotation: {
    quotationId: string;
    version: number;
    totalQuotedValue: number;
  } | null;
  rounds: NegotiationRound[];
  createdAt: string;
  updatedAt: string;
}

export interface NegotiationPreview {
  totalQuotedValue: number;
  calculationNote: string;
  warnings: OfferWarning[];
  /** SML previews compare against the vendor's standing offer. */
  deltaVsVendor?: { amount: number; percent: number };
  /** Vendor previews compare against their previous offer. */
  deltaVsPrevious?: { amount: number; percent: number };
}

/** Structured terms for an offer. Never include a total here. */
export interface OfferFields {
  rentalRate: number;
  rateBasis: RateBasis;
  mobilisationCharges: number;
  demobilisationCharges: number;
  taxBasis: TaxBasis;
  validityDate: string;
  availableFrom?: string | null;
  availabilityConfirmed: boolean;
  deviationText?: string | null;
  message?: string | null;
}

export interface CounterMeta {
  expectedVersion: number;
  acknowledgeWarnings: boolean;
}

export type SmlCounterInput = OfferFields &
  CounterMeta & {
    /** SML-only: capped by the server to the RFQ deadline / offer validity. */
    respondBy: string;
  };

export type VendorCounterInput = OfferFields & CounterMeta;

export interface CounterResult {
  negotiationId: string;
  roundId: string;
  roundNumber: number;
  version: number;
  totalQuotedValue: number;
  calculationNote: string;
  warnings: OfferWarning[];
  respondBy: string;
  isFinal: boolean;
}

export interface AcceptInput {
  expectedVersion: number;
  /** Required by the vendor UI before it will accept. */
  confirm?: boolean;
}

export interface AcceptResult {
  negotiationId: string;
  status: "AGREED";
  quotationId: string;
  quotationVersion: number;
  totalQuotedValue: number;
  version: number;
}

export interface CloseResult {
  negotiationId: string;
  status: "DECLINED";
  version: number;
}

// --- internal / SML ---------------------------------------------------------

export function getRfqNegotiations(
  rfqId: string,
): Promise<{ negotiations: NegotiationThread[] }> {
  return api(`/rfqs/${rfqId}/negotiations`);
}

export function previewSmlCounter(
  rfqId: string,
  quotationId: string,
  offer: OfferFields,
): Promise<{ preview: NegotiationPreview }> {
  return api(`/rfqs/${rfqId}/quotations/${quotationId}/counter/preview`, {
    method: "POST",
    body: offer,
  });
}

export function smlCounter(
  rfqId: string,
  quotationId: string,
  input: SmlCounterInput,
): Promise<{ result: CounterResult }> {
  return api(`/rfqs/${rfqId}/quotations/${quotationId}/counter`, {
    method: "POST",
    body: input,
  });
}

export function smlAccept(
  rfqId: string,
  id: string,
  input: AcceptInput,
): Promise<{ result: AcceptResult }> {
  return api(`/rfqs/${rfqId}/negotiations/${id}/accept`, {
    method: "POST",
    body: input,
  });
}

export function smlReject(
  rfqId: string,
  id: string,
  input: { expectedVersion: number; reason: string },
): Promise<{ result: CloseResult }> {
  return api(`/rfqs/${rfqId}/negotiations/${id}/reject`, {
    method: "POST",
    body: input,
  });
}

export function logVendorOffer(
  rfqId: string,
  id: string,
  input: OfferFields &
    CounterMeta & {
      channel: "PORTAL" | "PHONE" | "WHATSAPP" | "EMAIL";
      note: string;
    },
): Promise<{ result: CounterResult }> {
  return api(`/rfqs/${rfqId}/negotiations/${id}/log-vendor-offer`, {
    method: "POST",
    body: input,
  });
}

// --- vendor -----------------------------------------------------------------

export function getVendorRfqNegotiations(
  rfqId: string,
): Promise<{ negotiations: NegotiationThread[] }> {
  return api(`/vendor/rfqs/${rfqId}/negotiations`);
}

export function getVendorNegotiation(
  id: string,
): Promise<{ negotiation: NegotiationThread }> {
  return api(`/vendor/negotiations/${id}`);
}

export function previewVendorCounter(
  id: string,
  offer: OfferFields,
): Promise<{ preview: NegotiationPreview }> {
  return api(`/vendor/negotiations/${id}/preview`, {
    method: "POST",
    body: offer,
  });
}

export function vendorCounter(
  id: string,
  input: VendorCounterInput,
): Promise<{ result: CounterResult }> {
  return api(`/vendor/negotiations/${id}/counter`, {
    method: "POST",
    body: input,
  });
}

export function vendorAccept(
  id: string,
  input: AcceptInput,
): Promise<{ result: AcceptResult }> {
  return api(`/vendor/negotiations/${id}/accept`, {
    method: "POST",
    body: input,
  });
}

export function vendorDecline(
  id: string,
  input: { expectedVersion: number; reason?: string | null },
): Promise<{ result: CloseResult }> {
  return api(`/vendor/negotiations/${id}/decline`, {
    method: "POST",
    body: input,
  });
}

