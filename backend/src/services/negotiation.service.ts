import { prisma } from "../lib/database";
import { Prisma } from "../generated/prisma/client";
import {
  NegotiationParty,
  NegotiationStatus,
  QuoteSource,
  QuotationStatus,
  RoundOutcome,
  RfqStatus,
} from "../generated/prisma/client";
import type { AuthedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { can } from "../utils/rbac";
import { sendTemplate } from "./email.service";
import { recordAudit } from "./audit.service";
import { startOfUtcDay } from "../lib/dates";
import { calculateTotal } from "../validation/quotationFields";
import {
  acceptOfferSchema,
  declineOfferSchema,
  logVendorOfferSchema,
  previewOfferSchema,
  rejectCounterSchema,
  smlCounterSchema,
  vendorCounterSchema,
  type OfferInput,
} from "../validation/negotiationFields";
import {
  assertAvailability,
  assertCraneQuotable,
  assertVendor,
  auditActor,
  craneSnapshot,
  dayBasisFor,
  distanceToSite,
  loadCraneForVendor,
  loadRecipient,
  loadRecipientByVendor,
  requireVendorId,
  type RecipientRow,
} from "./quotation.service";
import type { Actor } from "./quotation.service";

/**
 * Counter-quotes (phase 1 + 2).
 *
 * A negotiation thread sits beside a vendor's quotation series, never inside
 * it. Every round is a complete structured offer priced by the same
 * `calculateTotal` the quotation preview uses; acceptance turns the agreed
 * round into the next quotation version, so the award flow needs no changes.
 *
 * All writes take `expectedVersion` and run the check inside a transaction.
 * The partial unique index on (rfqId, vendorId, craneId) forbids two live
 * threads for one crane, so two simultaneous "start negotiation" clicks cannot
 * both create a thread.
 */

const LIVE_STATUSES: NegotiationStatus[] = [
  NegotiationStatus.AWAITING_VENDOR,
  NegotiationStatus.AWAITING_SML,
  NegotiationStatus.AGREED,
];

const OPEN_STATUSES: NegotiationStatus[] = [
  NegotiationStatus.AWAITING_VENDOR,
  NegotiationStatus.AWAITING_SML,
];

const THREAD_SELECT = {
  id: true,
  rfqId: true,
  vendorId: true,
  craneId: true,
  baseQuotationId: true,
  agreedQuotationId: true,
  status: true,
  currentRound: true,
  maxRounds: true,
  version: true,
  closedReason: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  vendor: { select: { id: true, name: true } },
  crane: { select: { id: true, typeOfCraneCode: true, capacityT: true, currentLocation: true } },
  baseQuotation: {
    select: {
      id: true,
      version: true,
      totalQuotedValue: true,
      rentalRate: true,
      rateBasis: true,
      mobilisationCharges: true,
      demobilisationCharges: true,
      taxBasis: true,
      validityDate: true,
      availableFrom: true,
      deviationText: true,
    },
  },
  agreedQuotation: { select: { id: true, version: true, totalQuotedValue: true } },
  rounds: { orderBy: { roundNumber: "asc" as const } },
} satisfies Prisma.QuotationNegotiationSelect;

type ThreadRow = Prisma.QuotationNegotiationGetPayload<{ select: typeof THREAD_SELECT }>;
type RoundRow = ThreadRow["rounds"][number];

function fail(code: string, message: string, status = 409): never {
  throw new AppError(message, status, code);
}

function assertSml(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    fail("FORBIDDEN", "Only SML staff can negotiate a quotation", 403);
  }
  if (!can(actor.role, "quotation:counter")) {
    fail("FORBIDDEN", "You do not have permission to counter a quotation", 403);
  }
}

function assertVendorActor(actor: Actor): string {
  assertVendor(actor);
  return requireVendorId(actor);
}

function assertLiveThread(thread: ThreadRow): void {
  if (!LIVE_STATUSES.includes(thread.status)) {
    fail(thread.status === NegotiationStatus.DECLINED ? "NEGOTIATION_DECLINED" : "NEGOTIATION_CLOSED",
      `This negotiation is ${thread.status.toLowerCase().replace(/_/g, " ")}.`);
  }
}

function assertVersion(thread: ThreadRow, expectedVersion: number): void {
  if (thread.version !== expectedVersion) {
    fail("VERSION_CONFLICT", "This offer has changed since you opened it. Refresh and try again.");
  }
}

function assertTurn(thread: ThreadRow, party: NegotiationParty): void {
  const expected =
    thread.status === NegotiationStatus.AWAITING_VENDOR
      ? NegotiationParty.VENDOR
      : thread.status === NegotiationStatus.AWAITING_SML
        ? NegotiationParty.SML
        : null;
  if (expected !== party) {
    fail("NOT_YOUR_TURN",
      expected === null
        ? "This negotiation is closed."
        : `It is ${expected === NegotiationParty.SML ? "SML" : "the vendor"}'s turn, not yours.`);
  }
}

function assertNegotiationDeadline(rfq: RecipientRow["rfq"], now = new Date()): void {
  if (rfq.status !== RfqStatus.SENT) {
    fail("DEADLINE_PASSED", "Negotiation is only possible while the RFQ is open.");
  }
  if (now >= rfq.submissionDeadline) {
    fail("DEADLINE_PASSED", "The submission deadline has passed.");
  }
}

function assertOfferTime(round: RoundRow, rfq: RecipientRow["rfq"], now = new Date()): void {
  if (now >= rfq.submissionDeadline) {
    fail("DEADLINE_PASSED", "The submission deadline has passed.");
  }
  if (now >= round.respondBy) {
    fail("OFFER_EXPIRED", "This offer has expired.");
  }
}

function openRoundOf(thread: ThreadRow): RoundRow {
  const round = thread.rounds.find(
    (candidate) => candidate.roundNumber === thread.currentRound && candidate.outcome === RoundOutcome.OPEN,
  );
  if (!round) fail("NOT_YOUR_TURN", "There is no open offer to answer.");
  return round;
}

type PricingContext = {
  baseQuotation: Pick<ThreadRow["baseQuotation"], "totalQuotedValue" | "taxBasis">;
  rounds: RoundRow[];
};

function latestRoundBy(rounds: RoundRow[], party: NegotiationParty): RoundRow | null {
  return rounds.filter((round) => round.offeredBy === party).at(-1) ?? null;
}

/** Warnings compare totals directly; a different tax basis is an info note. */
function offerWarnings(input: {
  total: number;
  previousTotal: number;
  taxBasis: string;
  previousTaxBasis: string;
  direction: NegotiationParty;
}): { warnings: Array<{ code: string; message: string }>; notes: Array<{ code: string; message: string }> } {
  const warnings: Array<{ code: string; message: string }> = [];
  const notes: Array<{ code: string; message: string }> = [];
  const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  if (input.total > input.previousTotal) {
    warnings.push(
      input.direction === NegotiationParty.SML
        ? {
            code: "COUNTER_ABOVE_VENDOR_PRICE",
            message: `This counter is above the vendor's standing offer (${money(input.previousTotal)}).`,
          }
        : {
            code: "VENDOR_RAISED_PRICE",
            message: `This counter is above your previous offer (${money(input.previousTotal)}).`,
          },
    );
  }
  if (input.taxBasis !== input.previousTaxBasis) {
    notes.push({
      code: "TAX_BASIS_DIFFERS",
      message: "The tax basis differs from the offer being answered. Compare like for like before accepting.",
    });
  }
  return { warnings, notes };
}

function assertWarningsAcknowledged(
  warnings: Array<{ code: string; message: string }>,
  acknowledged: boolean,
): void {
  if (warnings.length > 0 && !acknowledged) {
    fail("WARNINGS_NOT_ACKNOWLEDGED", "Acknowledge the warnings before sending this offer.", 422);
  }
}

function capRespondBy(requested: Date, rfq: RecipientRow["rfq"], validityDate: Date): Date {
  return new Date(Math.min(requested.getTime(), rfq.submissionDeadline.getTime(), validityDate.getTime()));
}

function number(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function roundView(round: RoundRow) {
  const warnings = Array.isArray(round.warnings) ? round.warnings : [];
  return {
    roundId: round.id,
    roundNumber: round.roundNumber,
    offeredBy: round.offeredBy,
    offeredByUserId: round.offeredByUserId,
    onBehalfOfVendor: round.onBehalfOfVendor,
    channel: round.channel,
    rentalRate: Number(round.rentalRate),
    rateBasis: round.rateBasis,
    mobilisationCharges: Number(round.mobilisationCharges),
    demobilisationCharges: number(round.demobilisationCharges) ?? 0,
    taxBasis: round.taxBasis,
    validityDate: round.validityDate.toISOString(),
    availableFrom: round.availableFrom?.toISOString() ?? null,
    availabilityConfirmed: round.availabilityConfirmed,
    deviationText: round.deviationText,
    message: round.message,
    totalQuotedValue: Number(round.totalQuotedValue),
    calculationNote: round.calculationNote,
    warnings,
    warningsAcknowledged: round.warningsAcknowledged,
    isFinal: round.isFinal,
    respondBy: round.respondBy.toISOString(),
    outcome: round.outcome,
    respondedAt: round.respondedAt?.toISOString() ?? null,
    createdAt: round.createdAt.toISOString(),
  };
}

export function threadView(thread: ThreadRow, actor: Actor) {
  const deadlinePassed = thread.rounds.length === 0 || new Date() >= thread.rounds.at(-1)!.respondBy;
  return {
    negotiationId: thread.id,
    rfqId: thread.rfqId,
    vendorId: thread.vendorId,
    craneId: thread.craneId,
    craneLabel: `${thread.crane.typeOfCraneCode} · ${Number(thread.crane.capacityT)} t · ${thread.crane.currentLocation}`,
    vendorName: actor.role === "vendor_user" ? null : thread.vendor.name,
    status: thread.status,
    currentRound: thread.currentRound,
    maxRounds: thread.maxRounds,
    version: thread.version,
    closedReason: thread.closedReason,
    closedAt: thread.closedAt?.toISOString() ?? null,
    deadlinePassed,
    baseQuotation: {
      quotationId: thread.baseQuotation.id,
      version: thread.baseQuotation.version,
      totalQuotedValue: Number(thread.baseQuotation.totalQuotedValue),
      rentalRate: Number(thread.baseQuotation.rentalRate),
      rateBasis: thread.baseQuotation.rateBasis,
      mobilisationCharges: Number(thread.baseQuotation.mobilisationCharges),
      demobilisationCharges: Number(thread.baseQuotation.demobilisationCharges),
      taxBasis: thread.baseQuotation.taxBasis,
      validityDate: thread.baseQuotation.validityDate.toISOString(),
      availableFrom: thread.baseQuotation.availableFrom?.toISOString() ?? null,
      deviationText: thread.baseQuotation.deviationText,
    },
    agreedQuotation: thread.agreedQuotation
      ? {
          quotationId: thread.agreedQuotation.id,
          version: thread.agreedQuotation.version,
          totalQuotedValue: Number(thread.agreedQuotation.totalQuotedValue),
        }
      : null,
    rounds: thread.rounds.map(roundView),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

async function loadThread(id: string, actor: Actor): Promise<ThreadRow> {
  const where: Prisma.QuotationNegotiationWhereInput =
    actor.role === "vendor_user"
      ? { id, vendorId: requireVendorId(actor) }
      : { id };
  const thread = await prisma.quotationNegotiation.findFirst({ where, select: THREAD_SELECT });
  if (!thread) fail("NOT_FOUND", "That negotiation was not found.", 404);
  return thread;
}

async function priceOffer(rfq: RecipientRow["rfq"], input: OfferInput) {
  const { rentalCharge, total, note } = calculateTotal({
    rentalRate: input.rentalRate,
    rateBasis: input.rateBasis,
    durationValue: Number(rfq.durationValue),
    durationUnit: rfq.durationUnit,
    mobilisationCharges: input.mobilisationCharges,
    demobilisationCharges: input.demobilisationCharges,
    dayBasis: await dayBasisFor(rfq),
  });
  return { rentalCharge, total, note };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRfqNegotiations(rfqId: string, actor: Actor) {
  assertSml(actor);
  const threads = await prisma.quotationNegotiation.findMany({
    where: { rfqId },
    select: THREAD_SELECT,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return { negotiations: threads.map((thread) => threadView(thread, actor)) };
}

export async function listVendorNegotiations(rfqId: string, actor: Actor) {
  const vendorId = assertVendorActor(actor);
  // A vendor who was never sent this RFQ gets a 404 rather than an empty list:
  // the detail endpoint behaves the same way and neither should confirm the
  // RFQ exists for another vendor.
  const recipient = await prisma.rfqVendorRecipient.findFirst({
    where: { rfqId, vendorId },
    select: { id: true },
  });
  if (!recipient) fail("NOT_FOUND", "That RFQ was not sent to you.", 404);
  const threads = await prisma.quotationNegotiation.findMany({
    where: { rfqId, vendorId },
    select: THREAD_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return { negotiations: threads.map((thread) => threadView(thread, actor)) };
}

export async function getNegotiation(id: string, actor: Actor) {
  const thread = await loadThread(id, actor);
  return { negotiation: threadView(thread, actor) };
}

export async function previewSmlCounter(
  rfqId: string,
  quotationId: string,
  raw: unknown,
  actor: Actor,
) {
  assertSml(actor);
  const input = previewOfferSchema.parse(raw);
  const quotation = await prisma.quotation.findFirst({
    where: { id: quotationId, rfqId },
    select: { id: true, vendorId: true, isLatest: true, status: true, totalQuotedValue: true, taxBasis: true },
  });
  if (!quotation) fail("QUOTATION_NOT_NEGOTIABLE", "That quotation was not found.", 404);
  const recipient = await loadRecipientByVendor(rfqId, quotation.vendorId);
  const { total, note } = await priceOffer(recipient.rfq, input);
  const previousTotal = Number(quotation.totalQuotedValue);
  const { warnings, notes } = offerWarnings({
    total,
    previousTotal,
    taxBasis: input.taxBasis,
    previousTaxBasis: quotation.taxBasis,
    direction: NegotiationParty.SML,
  });
  return {
    preview: {
      totalQuotedValue: total,
      calculationNote: note,
      warnings: [...warnings, ...notes],
      deltaVsVendor: {
        amount: Math.round((total - previousTotal) * 100) / 100,
        percent: previousTotal === 0 ? 0 : Math.round(((total - previousTotal) / previousTotal) * 10000) / 100,
      },
    },
  };
}

export async function previewVendorCounter(id: string, raw: unknown, actor: Actor) {
  const vendorId = assertVendorActor(actor);
  const thread = await loadThread(id, actor);
  const input = previewOfferSchema.parse(raw);
  const recipient = await loadRecipient(thread.rfqId, actor);
  const { total, note } = await priceOffer(recipient.rfq, input);
  const previous = latestRoundBy(thread.rounds, NegotiationParty.VENDOR);
  const previousTotal = previous ? Number(previous.totalQuotedValue) : Number(thread.baseQuotation.totalQuotedValue);
  const previousTaxBasis = previous ? previous.taxBasis : thread.baseQuotation.taxBasis;
  const { warnings, notes } = offerWarnings({
    total,
    previousTotal,
    taxBasis: input.taxBasis,
    previousTaxBasis,
    direction: NegotiationParty.VENDOR,
  });
  return {
    preview: {
      totalQuotedValue: total,
      calculationNote: note,
      warnings: [...warnings, ...notes],
      deltaVsPrevious: {
        amount: Math.round((total - previousTotal) * 100) / 100,
        percent: previousTotal === 0 ? 0 : Math.round(((total - previousTotal) / previousTotal) * 10000) / 100,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Counter rounds
// ---------------------------------------------------------------------------

async function priceAndWarn(
  ctx: PricingContext,
  rfq: RecipientRow["rfq"],
  input: OfferInput,
  direction: NegotiationParty,
) {
  const { rentalCharge, total, note } = await priceOffer(rfq, input);
  const previous = latestRoundBy(ctx.rounds, direction);
  const previousTotal = previous
    ? Number(previous.totalQuotedValue)
    : Number(ctx.baseQuotation.totalQuotedValue);
  const previousTaxBasis = previous ? previous.taxBasis : ctx.baseQuotation.taxBasis;
  const { warnings, notes } = offerWarnings({
    total,
    previousTotal,
    taxBasis: input.taxBasis,
    previousTaxBasis,
    direction,
  });
  return { rentalCharge, total, note, warnings: [...warnings, ...notes], previousTotal };
}

async function persistRound(params: {
  thread: ThreadRow;
  rfq: RecipientRow["rfq"];
  input: OfferInput;
  offeredBy: NegotiationParty;
  offeredByUserId: string | null;
  onBehalfOfVendor: boolean;
  channel: string | null;
  respondBy: Date;
  total: number;
  note: string;
  warnings: Array<{ code: string; message: string }>;
  acknowledged: boolean;
  actor: Actor;
  isFinal: boolean;
  nextStatus: NegotiationStatus;
}) {
  const { thread, offeredBy, total, note, warnings, acknowledged, isFinal, nextStatus } = params;
  const input = params.input;
  const nextRound = thread.currentRound + 1;

  const created = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction so a concurrent click sees the new version.
    const fresh = await tx.quotationNegotiation.findUnique({
      where: { id: thread.id },
      select: { version: true, status: true, currentRound: true },
    });
    if (!fresh || fresh.version !== thread.version) {
      fail("VERSION_CONFLICT", "This offer has changed since you opened it. Refresh and try again.");
    }
    if (fresh.status !== thread.status || fresh.currentRound !== thread.currentRound) {
      fail("NOT_YOUR_TURN", "This negotiation moved on while you were composing your offer.");
    }
    await tx.negotiationRound.updateMany({
      where: { negotiationId: thread.id, outcome: RoundOutcome.OPEN },
      data: { outcome: RoundOutcome.COUNTERED, respondedAt: new Date() },
    });
    const round = await tx.negotiationRound.create({
      data: {
        negotiationId: thread.id,
        roundNumber: nextRound,
        offeredBy,
        offeredByUserId: params.offeredByUserId,
        onBehalfOfVendor: params.onBehalfOfVendor,
        channel: params.channel,
        rentalRate: input.rentalRate,
        rateBasis: input.rateBasis,
        mobilisationCharges: input.mobilisationCharges,
        demobilisationCharges: input.demobilisationCharges,
        taxBasis: input.taxBasis,
        validityDate: startOfUtcDay(input.validityDate),
        availableFrom: input.availableFrom ? startOfUtcDay(input.availableFrom) : null,
        availabilityConfirmed: input.availabilityConfirmed,
        deviationText: input.deviationText,
        message: input.message,
        totalQuotedValue: total,
        calculationNote: note,
        warnings: warnings as unknown as Prisma.InputJsonValue,
        warningsAcknowledged: acknowledged,
        isFinal,
        respondBy: params.respondBy,
        outcome: RoundOutcome.OPEN,
      },
      select: { id: true },
    });
    await tx.quotationNegotiation.update({
      where: { id: thread.id },
      data: { status: nextStatus, currentRound: nextRound, version: { increment: 1 } },
    });
    return round;
  });

  await recordAudit({
    entity: "negotiation",
    entityId: thread.id,
    action: offeredBy === NegotiationParty.SML ? "counter_sml" : "counter_vendor",
    oldValue: { totalQuotedValue: Number(thread.baseQuotation.totalQuotedValue) },
    newValue: {
      rfqId: thread.rfqId,
      vendorId: thread.vendorId,
      quotationId: thread.baseQuotationId,
      roundNumber: nextRound,
      totalQuotedValue: total,
      warnings,
      warningsAcknowledged: acknowledged,
      onBehalfOfVendor: params.onBehalfOfVendor,
    },
    actor: auditActor(params.actor),
    onBehalfOfVendor: params.onBehalfOfVendor,
  });

  if (offeredBy === NegotiationParty.SML) {
    await sendCounterToVendor(thread, created.id, params.rfq, total, note, params.respondBy, warnings);
  } else {
    await sendCounterToSml(thread, created.id, params.rfq, total, note, params.respondBy);
  }

  return {
    negotiationId: thread.id,
    roundId: created.id,
    roundNumber: nextRound,
    version: thread.version + 1,
    totalQuotedValue: total,
    calculationNote: note,
    warnings,
    respondBy: params.respondBy.toISOString(),
    isFinal,
  };
}



export async function counterAsSml(
  rfqId: string,
  quotationId: string,
  raw: unknown,
  actor: Actor,
) {
  assertSml(actor);
  const input = smlCounterSchema.parse(raw);
  const quotation = await prisma.quotation.findFirst({
    where: { id: quotationId, rfqId },
    select: {
      id: true,
      vendorId: true,
      isLatest: true,
      status: true,
      totalQuotedValue: true,
      taxBasis: true,
      validityDate: true,
      craneId: true,
    },
  });
  if (!quotation) fail("QUOTATION_NOT_NEGOTIABLE", "That quotation was not found.", 404);
  if (!quotation.isLatest || quotation.status !== QuotationStatus.SUBMITTED) {
    fail("QUOTATION_NOT_NEGOTIABLE", "Only a vendor's latest submitted quotation can be countered.");
  }

  const recipient = await loadRecipientByVendor(rfqId, quotation.vendorId);
  assertNegotiationDeadline(recipient.rfq);

  const existing = await prisma.quotationNegotiation.findFirst({
    where: { rfqId, vendorId: quotation.vendorId, craneId: quotation.craneId, status: { in: LIVE_STATUSES } },
    select: THREAD_SELECT,
  });
  if (existing && !OPEN_STATUSES.includes(existing.status) && existing.status !== NegotiationStatus.EXPIRED) {
    fail("NEGOTIATION_EXISTS", "This quotation already has an agreed negotiation.");
  }
  if (existing && existing.baseQuotationId !== quotation.id) {
    fail("QUOTATION_NOT_NEGOTIABLE", "Counter the quotation this negotiation started from.");
  }

  if (existing) {
    assertTurn(existing, NegotiationParty.SML);
    assertVersion(existing, input.expectedVersion);
    // A failed first counter (e.g. unacknowledged warnings) can leave an empty
    // thread at round 0 — there is no open round to answer yet.
    if (existing.currentRound > 0) openRoundOf(existing);
  } else {
    const other = await prisma.quotationNegotiation.findFirst({
      where: { rfqId, vendorId: quotation.vendorId, craneId: quotation.craneId, status: { in: OPEN_STATUSES } },
      select: { id: true },
    });
    if (other) fail("NEGOTIATION_EXISTS", "This crane already has an open negotiation.");
  }

  // Price and validate before creating a thread. If warns are not acknowledged
  // we must not leave an empty thread behind that a retry cannot progress.
  const pricingCtx: PricingContext = existing ?? {
    baseQuotation: quotation,
    rounds: [],
  };
  const currentRound = existing?.currentRound ?? 0;
  const maxRounds = existing?.maxRounds ?? 5;
  if (currentRound + 1 > maxRounds) {
    fail("ROUND_LIMIT_REACHED", "The maximum of 5 rounds has been reached.");
  }
  if ((currentRound + 1) % 2 !== 1) {
    fail("NOT_YOUR_TURN", "It is the vendor's turn to respond.");
  }

  const { total, note, warnings } = await priceAndWarn(
    pricingCtx,
    recipient.rfq,
    input,
    NegotiationParty.SML,
  );
  assertWarningsAcknowledged(warnings, input.acknowledgeWarnings);

  let thread: ThreadRow = existing!;
  if (!existing) {
    // Two SML users starting a thread at once: the partial unique index makes
    // one of them lose. Translate that into a clean conflict rather than a 500.
    try {
      thread = await prisma.quotationNegotiation.create({
        data: {
          rfqId,
          vendorId: quotation.vendorId,
          craneId: quotation.craneId,
          baseQuotationId: quotation.id,
          status: NegotiationStatus.AWAITING_SML,
          currentRound: 0,
        },
        select: THREAD_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        fail("NEGOTIATION_EXISTS", "Another counter was just started. Refresh and try again.");
      }
      throw error;
    }
  }

  const respondBy = capRespondBy(input.respondBy, recipient.rfq, input.validityDate);
  return persistRound({
      thread,
      rfq: recipient.rfq,
      input,
      offeredBy: NegotiationParty.SML,
      offeredByUserId: actor.id,
      onBehalfOfVendor: false,
      channel: null,
      respondBy,
      total,
      note,
      warnings,
      acknowledged: input.acknowledgeWarnings,
      actor,
      isFinal: thread.currentRound + 1 === thread.maxRounds,
      nextStatus: NegotiationStatus.AWAITING_VENDOR,
  });
}

export async function counterAsVendor(id: string, raw: unknown, actor: Actor) {
  const vendorId = assertVendorActor(actor);
  const input = vendorCounterSchema.parse(raw);
  const thread = await loadThread(id, actor);
  assertLiveThread(thread);
  assertTurn(thread, NegotiationParty.VENDOR);
  assertVersion(thread, input.expectedVersion);
  openRoundOf(thread);

  const recipient = await loadRecipient(thread.rfqId, actor);
  assertNegotiationDeadline(recipient.rfq);
  if (thread.currentRound + 1 > thread.maxRounds) {
    fail("ROUND_LIMIT_REACHED", "The maximum of 5 rounds has been reached.");
  }
  if ((thread.currentRound + 1) % 2 !== 0) {
    fail("NOT_YOUR_TURN", "It is SML's turn to respond.");
  }

  const { total, note, warnings } = await priceAndWarn(
    thread,
    recipient.rfq,
    input,
    NegotiationParty.VENDOR,
  );
  assertWarningsAcknowledged(warnings, input.acknowledgeWarnings);

  // SML did not pick a response-by for a vendor round; give them two days,
  // capped by the RFQ deadline and the validity of the offer being answered.
  const respondBy = capRespondBy(
    new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    recipient.rfq,
    input.validityDate,
  );
  return persistRound({
    thread,
    rfq: recipient.rfq,
    input,
    offeredBy: NegotiationParty.VENDOR,
    offeredByUserId: actor.id,
    onBehalfOfVendor: false,
    channel: null,
    respondBy,
    total,
    note,
    warnings,
    acknowledged: input.acknowledgeWarnings,
    actor,
    isFinal: false,
    nextStatus: NegotiationStatus.AWAITING_SML,
  });
}

// ---------------------------------------------------------------------------
// Accept / decline / reject
// ---------------------------------------------------------------------------

async function acceptNegotiation(id: string, raw: unknown, actor: Actor, party: NegotiationParty) {
  const input = acceptOfferSchema.parse(raw);
  const thread = await loadThread(id, actor);
  if (party === NegotiationParty.VENDOR) assertVendorActor(actor);
  else assertSml(actor);
  assertLiveThread(thread);
  assertTurn(thread, party);
  assertVersion(thread, input.expectedVersion);
  if (party === NegotiationParty.VENDOR && input.confirm !== true) {
    fail("CONFIRM_REQUIRED", "Confirm the offer before accepting it.", 422);
  }
  const round = openRoundOf(thread);
  const recipient = await loadRecipientByVendor(thread.rfqId, thread.vendorId);
  assertOfferTime(round, recipient.rfq);
  assertAvailability(recipient.rfq, round);

  const crane = await loadCraneForVendor(thread.craneId, thread.vendorId);
  try {
    await assertCraneQuotable(crane, recipient.rfq);
  } catch (error) {
    if (error instanceof AppError) {
      fail("CRANE_UNAVAILABLE", `${error.message} The thread stays open — try again once it is available.`, 409);
    }
    throw error;
  }
  const distance = await distanceToSite(recipient.rfq, crane);

  const agreed = await prisma.$transaction(async (tx) => {
    const fresh = await tx.quotationNegotiation.findUnique({
      where: { id: thread.id },
      select: { version: true, status: true },
    });
    if (!fresh || fresh.version !== thread.version || fresh.status !== thread.status) {
      fail("VERSION_CONFLICT", "This offer has changed since you opened it. Refresh and try again.");
    }
    await tx.negotiationRound.update({
      where: { id: round.id },
      data: { outcome: RoundOutcome.ACCEPTED, respondedAt: new Date() },
    });
    const latest = await tx.quotation.findFirst({
      where: { rfqId: thread.rfqId, vendorId: thread.vendorId, craneId: thread.craneId, isLatest: true },
      select: { id: true, version: true },
    });
    if (!latest) fail("QUOTATION_NOT_NEGOTIABLE", "The base quotation no longer exists.");
    await tx.quotation.update({ where: { id: latest.id }, data: { isLatest: false } });
    const quotation = await tx.quotation.create({
      data: {
        rfqId: thread.rfqId,
        vendorId: thread.vendorId,
        craneId: thread.craneId,
        version: latest.version + 1,
        isLatest: true,
        rentalRate: round.rentalRate,
        rateBasis: round.rateBasis,
        mobilisationCharges: round.mobilisationCharges,
        demobilisationCharges: round.demobilisationCharges ?? 0,
        taxBasis: round.taxBasis,
        totalQuotedValue: round.totalQuotedValue,
        calculationNote: round.calculationNote,
        availabilityConfirmed: round.availabilityConfirmed,
        availableFrom: round.availableFrom,
        validityDate: round.validityDate,
        acceptsCommercialTerms: true,
        deviationText: round.deviationText,
        source: QuoteSource.NEGOTIATED,
        negotiationId: thread.id,
        warnings: (round.warnings ?? []) as unknown as Prisma.InputJsonValue,
        craneLocationSnapshot: craneSnapshot(crane) as unknown as Prisma.InputJsonValue,
        distanceToSiteKm: distance?.km ?? null,
        distanceMethod: (distance?.method as never) ?? null,
        status: QuotationStatus.SUBMITTED,
      },
      select: { id: true, version: true, totalQuotedValue: true },
    });
    await tx.quotationNegotiation.update({
      where: { id: thread.id },
      data: {
        status: NegotiationStatus.AGREED,
        agreedQuotationId: quotation.id,
        version: { increment: 1 },
        closedAt: new Date(),
      },
    });
    return quotation;
  });

  await recordAudit({
    entity: "negotiation",
    entityId: thread.id,
    action: "accept",
    oldValue: { roundNumber: round.roundNumber, totalQuotedValue: Number(round.totalQuotedValue) },
    newValue: {
      rfqId: thread.rfqId,
      vendorId: thread.vendorId,
      quotationId: agreed.id,
      quotationVersion: agreed.version,
      totalQuotedValue: Number(agreed.totalQuotedValue),
      acceptedBy: party,
      onBehalfOfVendor: round.onBehalfOfVendor,
    },
    actor: auditActor(actor),
  });

  await sendAgreementNotice(thread, recipient, agreed.id, Number(agreed.totalQuotedValue), party, actor);
  return {
    negotiationId: thread.id,
    status: NegotiationStatus.AGREED,
    quotationId: agreed.id,
    quotationVersion: agreed.version,
    totalQuotedValue: Number(agreed.totalQuotedValue),
    version: thread.version + 1,
  };
}

export function acceptNegotiationAsSml(id: string, raw: unknown, actor: Actor) {
  return acceptNegotiation(id, raw, actor, NegotiationParty.SML);
}

export function acceptNegotiationAsVendor(id: string, raw: unknown, actor: Actor) {
  return acceptNegotiation(id, raw, actor, NegotiationParty.VENDOR);
}

async function closeThread(params: {
  id: string;
  raw: unknown;
  actor: Actor;
  party: NegotiationParty;
  action: "decline" | "reject";
}) {
  const schema = params.action === "decline" ? declineOfferSchema : rejectCounterSchema;
  const input = schema.parse(params.raw);
  const thread = await loadThread(params.id, params.actor);
  if (params.party === NegotiationParty.VENDOR) assertVendorActor(params.actor);
  else assertSml(params.actor);
  assertLiveThread(thread);
  assertTurn(thread, params.party);
  assertVersion(thread, input.expectedVersion);
  const round = openRoundOf(thread);
  const recipient = await loadRecipientByVendor(thread.rfqId, thread.vendorId);
  assertOfferTime(round, recipient.rfq);

  const reason = "reason" in input ? input.reason : null;
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.quotationNegotiation.findUnique({
      where: { id: thread.id },
      select: { version: true, status: true },
    });
    if (!fresh || fresh.version !== thread.version || fresh.status !== thread.status) {
      fail("VERSION_CONFLICT", "This offer has changed since you opened it. Refresh and try again.");
    }
    await tx.negotiationRound.update({
      where: { id: round.id },
      data: { outcome: RoundOutcome.DECLINED, respondedAt: new Date() },
    });
    await tx.quotationNegotiation.update({
      where: { id: thread.id },
      data: {
        status: NegotiationStatus.DECLINED,
        version: { increment: 1 },
        closedReason: reason ?? null,
        closedAt: new Date(),
      },
    });
  });

  await recordAudit({
    entity: "negotiation",
    entityId: thread.id,
    action: params.action,
    oldValue: { roundNumber: round.roundNumber, totalQuotedValue: Number(round.totalQuotedValue) },
    newValue: {
      rfqId: thread.rfqId,
      vendorId: thread.vendorId,
      quotationId: thread.baseQuotationId,
      reason,
    },
    actor: auditActor(params.actor),
  });
  await sendCloseNotice(thread, recipient, params.action, reason, params.party);
  return { negotiationId: thread.id, status: NegotiationStatus.DECLINED, version: thread.version + 1 };
}

export function declineNegotiation(id: string, raw: unknown, actor: Actor) {
  return closeThread({ id, raw, actor, party: NegotiationParty.VENDOR, action: "decline" });
}

export function rejectNegotiation(id: string, raw: unknown, actor: Actor) {
  return closeThread({ id, raw, actor, party: NegotiationParty.SML, action: "reject" });
}

// ---------------------------------------------------------------------------
// Phase 2: sales logging an offer received offline
// ---------------------------------------------------------------------------

export async function logVendorOffer(id: string, raw: unknown, actor: Actor) {
  assertSml(actor);
  const input = logVendorOfferSchema.parse(raw);
  const thread = await loadThread(id, actor);
  assertLiveThread(thread);
  assertTurn(thread, NegotiationParty.VENDOR);
  assertVersion(thread, input.expectedVersion);
  openRoundOf(thread);
  if (thread.currentRound + 1 > thread.maxRounds || (thread.currentRound + 1) % 2 !== 0) {
    fail("NOT_YOUR_TURN", "A vendor offer is not due in this round.");
  }
  const quotationId = thread.baseQuotationId;
  const recipient = await loadRecipientByVendor(thread.rfqId, thread.vendorId);
  assertNegotiationDeadline(recipient.rfq);
  const { total, note, warnings } = await priceAndWarn(thread, recipient.rfq, input, NegotiationParty.VENDOR);
  assertWarningsAcknowledged(warnings, input.acknowledgeWarnings);
  const respondBy = capRespondBy(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), recipient.rfq, input.validityDate);

  const result = await persistRound({
    thread,
    rfq: recipient.rfq,
    input,
    offeredBy: NegotiationParty.VENDOR,
    offeredByUserId: actor.id,
    onBehalfOfVendor: true,
    channel: input.channel,
    respondBy,
    total,
    note,
    warnings,
    acknowledged: input.acknowledgeWarnings,
    actor,
    isFinal: false,
    nextStatus: NegotiationStatus.AWAITING_SML,
  });
  await prisma.negotiationRound.update({
    where: { id: result.roundId },
    data: { message: `${input.message ? `${input.message}\n\n` : ""}Logged note: ${input.note}` },
  });
  await recordAudit({
    entity: "negotiation",
    entityId: thread.id,
    action: "log_vendor_offer",
    newValue: {
      rfqId: thread.rfqId,
      vendorId: thread.vendorId,
      quotationId,
      roundNumber: result.roundNumber,
      totalQuotedValue: total,
      channel: input.channel,
      note: input.note,
      onBehalfOfVendor: true,
    },
    actor: auditActor(actor),
    onBehalfOfVendor: true,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Cancellation hooks used by award / withdraw / RFQ close
// ---------------------------------------------------------------------------

async function cancelThreads(
  where: Prisma.QuotationNegotiationWhereInput,
  reason: string,
  statuses: NegotiationStatus[] = OPEN_STATUSES,
) {
  const threads = await prisma.quotationNegotiation.findMany({
    where: { ...where, status: { in: statuses } },
    select: THREAD_SELECT,
  });
  for (const thread of threads) {
    const openRounds = thread.rounds.filter((round) => round.outcome === RoundOutcome.OPEN);
    await prisma.$transaction(async (tx) => {
      await tx.negotiationRound.updateMany({
        where: { negotiationId: thread.id, outcome: RoundOutcome.OPEN },
        data: { outcome: RoundOutcome.CANCELLED, respondedAt: new Date() },
      });
      await tx.quotationNegotiation.update({
        where: { id: thread.id },
        data: {
          status: NegotiationStatus.CANCELLED,
          version: { increment: 1 },
          closedReason: reason,
          closedAt: new Date(),
        },
      });
    });
    await recordAudit({
      entity: "negotiation",
      entityId: thread.id,
      action: "cancel",
      newValue: { rfqId: thread.rfqId, vendorId: thread.vendorId, quotationId: thread.baseQuotationId, reason, affectedRounds: openRounds.length },
    });
  }
  return threads.length;
}

// An award ends the thread even after an agreement was reached — the agreed
// quotation is about to become SELECTED, so the negotiation is done.
const AWARDABLE_THREAD_STATUSES: NegotiationStatus[] = [
  ...OPEN_STATUSES,
  NegotiationStatus.AGREED,
];

export function cancelNegotiationsForAward(rfqId: string, quotationId: string | null) {
  const reason = quotationId ? "This quotation was awarded" : "RFQ finalised";
  return cancelThreads(
    quotationId
      ? { rfqId, OR: [{ baseQuotationId: quotationId }, { agreedQuotationId: quotationId }] }
      : { rfqId },
    reason,
    AWARDABLE_THREAD_STATUSES,
  );
}

export function cancelAllNegotiations(rfqId: string, reason: string) {
  return cancelThreads({ rfqId }, reason, AWARDABLE_THREAD_STATUSES);
}

export function cancelNegotiationOnWithdraw(quotationId: string) {
  return cancelThreads({ OR: [{ baseQuotationId: quotationId }, { agreedQuotationId: quotationId }] }, "The vendor withdrew the quotation");
}

// ---------------------------------------------------------------------------
// Scheduled job: expiry and reminders
// ---------------------------------------------------------------------------

export async function expireNegotiations(now = new Date()): Promise<number> {
  const threads = await prisma.quotationNegotiation.findMany({
    where: { status: { in: OPEN_STATUSES }, rounds: { some: { outcome: RoundOutcome.OPEN } } },
    select: THREAD_SELECT,
  });
  let expired = 0;
  for (const thread of threads) {
    const open = thread.rounds.filter((round) => round.outcome === RoundOutcome.OPEN);
    const deadline = open.reduce<Date | null>((soonest, round) => (!soonest || round.respondBy < soonest ? round.respondBy : soonest), null);
    const rfq = await prisma.rfq.findUnique({ where: { id: thread.rfqId }, select: { submissionDeadline: true } });
    if (!deadline || (now < deadline && (!rfq || now < rfq.submissionDeadline))) continue;
    await prisma.$transaction(async (tx) => {
      await tx.negotiationRound.updateMany({
        where: { negotiationId: thread.id, outcome: RoundOutcome.OPEN },
        data: { outcome: RoundOutcome.EXPIRED, respondedAt: now },
      });
      await tx.quotationNegotiation.update({
        where: { id: thread.id, status: { in: OPEN_STATUSES } },
        data: { status: NegotiationStatus.EXPIRED, version: { increment: 1 }, closedReason: "Offer expired", closedAt: now },
      });
    });
    await recordAudit({
      entity: "negotiation",
      entityId: thread.id,
      action: "expire",
      newValue: { rfqId: thread.rfqId, vendorId: thread.vendorId, quotationId: thread.baseQuotationId, roundNumber: thread.currentRound },
    });
    expired += 1;
  }
  return expired;
}

export async function sendNegotiationReminders(now = new Date()): Promise<number> {
  const threads = await prisma.quotationNegotiation.findMany({
    where: { status: { in: OPEN_STATUSES }, rounds: { some: { outcome: RoundOutcome.OPEN } } },
    select: THREAD_SELECT,
  });
  let sent = 0;
  for (const thread of threads) {
    const round = thread.rounds.find((candidate) => candidate.outcome === RoundOutcome.OPEN);
    if (!round) continue;
    const hoursTo = (round.respondBy.getTime() - now.getTime()) / 3_600_000;
    if (hoursTo <= 0 || hoursTo > 24) continue;
    const recipient = await loadRecipientByVendor(thread.rfqId, thread.vendorId);
    if (thread.status === NegotiationStatus.AWAITING_VENDOR) {
      const warnings = (Array.isArray(round.warnings) ? round.warnings : []) as Array<{ code: string; message: string }>;
      await sendCounterToVendor(thread, round.id, recipient.rfq, Number(round.totalQuotedValue), round.calculationNote ?? "", round.respondBy, warnings, true);
    } else {
      await sendCounterToSml(thread, round.id, recipient.rfq, Number(round.totalQuotedValue), round.calculationNote ?? "", round.respondBy, true);
    }
    sent += 1;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Notifications (failures are swallowed: a mail fault must not undo an offer)
// ---------------------------------------------------------------------------

function offerUrl(rfqId: string): string {
  return `${process.env.PORTAL_BASE_URL ?? "http://localhost:5173"}/app/rfqs/${rfqId}`;
}

async function sendCounterToVendor(
  thread: ThreadRow,
  _roundId: string,
  rfq: RecipientRow["rfq"],
  total: number,
  note: string,
  respondBy: Date,
  warnings: Array<{ code: string; message: string }>,
  reminder = false,
): Promise<void> {
  const recipient = await prisma.rfqVendorRecipient.findFirst({
    where: { rfqId: thread.rfqId, vendorId: thread.vendorId },
    select: { emails: true, candidateSnapshot: true },
  });
  const emails = recipient?.emails ?? [];
  if (emails.length === 0) return;
  try {
    await sendTemplate({
      template: reminder ? "negotiation_reminder" : "negotiation_counter_received",
      to: emails[0],
      cc: emails.slice(1),
      vars: {
        rfqNumber: rfq.rfqNumber,
        vendorName: thread.vendor.name ?? "Vendor",
        craneLabel: `${thread.crane.typeOfCraneCode} · ${Number(thread.crane.capacityT)} t`,
        roundNumber: thread.currentRound,
        maxRounds: thread.maxRounds,
        totalQuotedValue: total,
        calculationNote: note,
        respondBy: respondBy.toLocaleString("en-IN"),
        warningsText: warnings.length > 0 ? warnings.map((warning) => `• ${warning.message}`).join("\n") : "",
        rfqUrl: offerUrl(thread.rfqId),
      },
    });
  } catch (error) {
    console.error("[negotiation] counter email failed", error);
  }
}

async function sendCounterToSml(
  thread: ThreadRow,
  _roundId: string,
  rfq: RecipientRow["rfq"],
  total: number,
  note: string,
  respondBy: Date,
  reminder = false,
): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { id: rfq.createdById ?? "" },
        { role: "admin_user" },
      ],
    },
    select: { email: true },
  });
  const emails = [...new Set(users.map((user) => user.email))];
  if (emails.length === 0) return;
  try {
    await sendTemplate({
      template: reminder ? "negotiation_reminder" : "negotiation_vendor_countered",
      to: emails[0],
      cc: emails.slice(1),
      vars: {
        rfqNumber: rfq.rfqNumber,
        vendorName: thread.vendor.name ?? "A vendor",
        craneLabel: `${thread.crane.typeOfCraneCode} · ${Number(thread.crane.capacityT)} t`,
        roundNumber: thread.currentRound,
        maxRounds: thread.maxRounds,
        totalQuotedValue: total,
        calculationNote: note,
        respondBy: respondBy.toLocaleString("en-IN"),
        warningsText: "",
        rfqUrl: offerUrl(thread.rfqId),
      },
    });
  } catch (error) {
    console.error("[negotiation] SML counter notice failed", error);
  }
}

async function sendAgreementNotice(
  thread: ThreadRow,
  recipient: RecipientRow,
  quotationId: string,
  total: number,
  party: NegotiationParty,
  actor: Actor,
): Promise<void> {
  const emails = party === NegotiationParty.VENDOR ? recipient.emails : [actor.email];
  const smlEmails = await prisma.user.findMany({
    where: { OR: [{ id: recipient.rfq.createdById ?? "" }, { role: "admin_user" }] },
    select: { email: true },
  });
  const all = [...new Set([...emails, ...smlEmails.map((user) => user.email)])];
  if (all.length === 0) return;
  try {
    await sendTemplate({
      template: "negotiation_accepted",
      to: all[0],
      cc: all.slice(1),
      vars: {
        rfqNumber: recipient.rfq.rfqNumber,
        vendorName: thread.vendor.name ?? "A vendor",
        totalQuotedValue: total,
        quotationId,
        nextStep: "SML will review and confirm the award. Nothing is reserved until then.",
        rfqUrl: offerUrl(thread.rfqId),
      },
    });
  } catch (error) {
    console.error("[negotiation] acceptance email failed", error);
  }
}

async function sendCloseNotice(
  thread: ThreadRow,
  recipient: RecipientRow,
  action: "decline" | "reject",
  reason: string | null,
  party: NegotiationParty,
): Promise<void> {
  const smlEmails = await prisma.user.findMany({
    where: { OR: [{ id: recipient.rfq.createdById ?? "" }, { role: "admin_user" }] },
    select: { email: true },
  });
  const all = [...new Set([...recipient.emails, ...smlEmails.map((user) => user.email)])];
  if (all.length === 0) return;
  try {
    await sendTemplate({
      template: "negotiation_declined",
      to: all[0],
      cc: all.slice(1),
      vars: {
        rfqNumber: recipient.rfq.rfqNumber,
        vendorName: thread.vendor.name ?? "A vendor",
        actor: party === NegotiationParty.VENDOR ? "The vendor" : "SML",
        reason: reason ?? "No reason given",
        rfqUrl: offerUrl(thread.rfqId),
      },
    });
  } catch (error) {
    console.error("[negotiation] close email failed", error);
  }
}
