import { prisma } from "../lib/database";
import type { Prisma } from "../generated/prisma/client";
import { AppError } from "../middleware/errorHandler";
import { recordAudit } from "./audit.service";
import { sendTemplate, optionalBlock } from "./email.service";
import type { AuthedRequest } from "../middleware/auth";
import {
  createBlockedReservationSchema,
  releaseReservationSchema,
  listReservationsQuerySchema,
  calendarQuerySchema,
  toUtcMidnight,
  type CreateBlockedReservationInput,
  type ReleaseReservationInput,
  type ListReservationsQuery,
  type CalendarQuery,
} from "../validation/reservationFields";
import {
  durationInDays,
  type DayBasisContext,
} from "../validation/quotationFields";
import {
  CraneStatus,
  DurationUnit,
  OwnershipType,
  ReservationStatus,
  ReservationType,
} from "../generated/prisma/client";

/**
 * Reservations (brief 5.3 / 6.1, phase B).
 *
 * A reservation is the dated commitment a crane carries. The whole point of the
 * entity is that the commitment is a fact about a period, not a flag on the
 * crane: the same crane can be booked for March and free in April, and the
 * database refuses two ACTIVE reservations that overlap in time (the
 * `reservations_active_no_overlap` exclusion constraint), transaction or not.
 *
 * The brief forbids storing Booked/Hired. Those two words are *derived* from the
 * reservations in view: an active reservation covering today reads Hired, one
 * starting in the future reads Booked, and the crane's own status keeps meaning
 * what the vendor last said. `deriveBookingBadge` is the single place that
 * reading lives, so the dashboard, the crane list and the admin screen cannot
 * disagree.
 *
 * Vendors never write here. There is no vendor route, no vendor capability and
 * no branch in this file a vendor can reach: an award creates a reservation,
 * an admin blocks or releases one, and a vendor only sees the badge they imply.
 */

export interface ReservationActor {
  id: string;
  email: string;
  role: AuthedRequest["user"]["role"];
  vendorId: string | null;
}

function auditActor(actor: ReservationActor): AuthedRequest["user"] {
  return {
    id: actor.id,
    email: actor.email,
    role: actor.role,
    vendorId: actor.vendorId,
  } as AuthedRequest["user"];
}

/** Reading reservations is SML-side work; a vendor reads their own crane list. */
function assertInternal(actor: ReservationActor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Only SML staff can work with reservations");
  }
}

/** Writing one — blocking or releasing — is an admin decision. */
function assertAdmin(actor: ReservationActor): void {
  if (actor.role !== "admin_user") {
    throw AppError.forbidden("Only an SML administrator can change a reservation");
  }
}

/** Booked/Hired as the vendor sees it, derived from a reservation's dates. */
export type BookingBadge = "BOOKED" | "HIRED" | null;

export function deriveBookingBadge(
  reservation: { type: ReservationType; status: ReservationStatus; startDate: Date; endDate: Date },
  now: Date,
): BookingBadge {
  if (reservation.type !== ReservationType.BOOKED) return null;
  if (reservation.status !== ReservationStatus.ACTIVE) return null;
  const today = toUtcMidnight(now).getTime();
  if (reservation.startDate.getTime() > today) return "BOOKED";
  if (reservation.endDate.getTime() >= today) return "HIRED";
  // An active booking whose window has passed should already be Completed; if it
  // is not, it no longer describes a live commitment and reads as nothing.
  return null;
}

/**
 * The crane's displayed state: derived booking first, the vendor's word second.
 *
 * This is the shared reading of brief 6.1's "effective availability" — a crane
 * is Booked/Hired because a reservation says so, and otherwise it is whatever
 * status the vendor last set.
 */
export function effectiveCraneState(
  storedStatus: CraneStatus,
  reservations: Array<{
    type: ReservationType;
    status: ReservationStatus;
    startDate: Date;
    endDate: Date;
  }>,
  now: Date,
): CraneStatus {
  const badges = reservations
    .map((r) => deriveBookingBadge(r, now))
    .filter((b): b is "BOOKED" | "HIRED" => b !== null);
  if (badges.includes("HIRED")) return "HIRED";
  if (badges.includes("BOOKED")) return "BOOKED";
  return storedStatus;
}

const RESERVATION_SELECT = {
  id: true,
  craneId: true,
  startDate: true,
  endDate: true,
  type: true,
  status: true,
  rfqId: true,
  quotationId: true,
  createdById: true,
  releasedById: true,
  releasedAt: true,
  releaseReason: true,
  createdAt: true,
  updatedAt: true,
  crane: {
    select: {
      id: true,
      vendorId: true,
      serialRegistrationNo: true,
      capacityT: true,
      typeOfCrane: { select: { name: true } },
      vendor: { select: { id: true, name: true, email: true } },
    },
  },
  rfq: { select: { rfqNumber: true } },
  createdBy: { select: { email: true } },
  releasedBy: { select: { email: true } },
} as const;

type ReservationRow = Prisma.ReservationGetPayload<{
  select: typeof RESERVATION_SELECT;
}>;

export interface ReservationView {
  id: string;
  craneId: string;
  craneLabel: string;
  vendorId: string;
  vendorName: string;
  startDate: string;
  endDate: string;
  type: ReservationType;
  status: ReservationStatus;
  badge: BookingBadge;
  rfqId: string | null;
  rfqNumber: string | null;
  quotationId: string | null;
  createdById: string | null;
  createdByName: string | null;
  releasedById: string | null;
  releasedByName: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function craneLabelOf(crane: {
  typeOfCrane: { name: string } | null;
  capacityT: unknown;
  serialRegistrationNo: string;
}): string {
  return `${crane.typeOfCrane?.name ?? "Crane"} ${Number(crane.capacityT)} t — ${crane.serialRegistrationNo}`;
}

function toView(row: ReservationRow, now: Date): ReservationView {
  return {
    id: row.id,
    craneId: row.craneId,
    craneLabel: craneLabelOf(row.crane),
    vendorId: row.crane.vendorId,
    vendorName: row.crane.vendor.name ?? "The vendor",
    startDate: row.startDate.toISOString(),
    endDate: row.endDate.toISOString(),
    type: row.type,
    status: row.status,
    badge: deriveBookingBadge(row, now),
    rfqId: row.rfqId,
    rfqNumber: row.rfq?.rfqNumber ?? null,
    quotationId: row.quotationId,
    createdById: row.createdById,
    createdByName: row.createdBy?.email ?? null,
    releasedById: row.releasedById,
    releasedByName: row.releasedBy?.email ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    releaseReason: row.releaseReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The RFQ fields a reservation window is derived from (brief 5.4/6.7). */
export interface RfqWindowInput {
  requiredStartDate: Date;
  durationValue: unknown;
  durationUnit: DurationUnit;
  startDateTbc?: boolean;
  workingDaysPerMonth?: number | null;
}

/**
 * The reservation window an RFQ's dates describe — the [start, end] inclusive
 * range the award books and the phase B3 eligibility checks compare against.
 *
 * Returns `null` when the RFQ's start date is TBC: there is no date to derive a
 * window from, so callers treat such an RFQ as having no fixed window to clash
 * against rather than guessing one (brief C3 threads the notice through the
 * picker).
 */
export function reservationWindowForRfq(
  rfq: RfqWindowInput,
  dayBasis: DayBasisContext,
): { start: Date; end: Date } | null {
  if (rfq.startDateTbc) return null;
  const start = toUtcMidnight(rfq.requiredStartDate);
  const days = Math.max(
    1,
    Math.ceil(durationInDays(Number(rfq.durationValue), rfq.durationUnit, dayBasis)),
  );
  const end = new Date(start.getTime() + (days - 1) * 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * The ACTIVE reservation a range would overlap, if any — the friendly check in
 * front of the database constraint. `[start, end]` is inclusive on both ends,
 * matching the constraint's `daterange(start, end+1, '[)')`. The award flow
 * (brief 6.7, phase B2) calls this before booking a crane.
 */
export async function findOverlappingReservation(
  craneId: string,
  start: Date,
  end: Date,
  excludeId?: string,
) {
  return prisma.reservation.findFirst({
    where: {
      craneId,
      status: ReservationStatus.ACTIVE,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startDate: { lte: end },
      endDate: { gte: start },
    },
    select: { id: true, startDate: true, endDate: true, type: true },
  });
}

export async function listReservations(
  raw: unknown,
  actor: ReservationActor,
): Promise<ReservationView[]> {
  assertInternal(actor);
  const query: ListReservationsQuery = listReservationsQuerySchema.parse(raw ?? {});
  const now = new Date();

  const rows = await prisma.reservation.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.craneId ? { craneId: query.craneId } : {}),
      ...(query.vendorId ? { crane: { vendorId: query.vendorId } } : {}),
    },
    select: RESERVATION_SELECT,
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });

  return rows.map((row) => toView(row, now));
}

// --- booking calendar (BPD 5.12 / 6.17, P2 section 3) ---------------------

export type CalendarDayState =
  | "FREE"
  | "RESERVED"
  | "HIRED"
  | "BLOCKED"
  | "UNAVAILABLE";

export interface CalendarDay {
  date: string;
  state: CalendarDayState;
  /** The reservation that produced a reserved/hired/blocked day, if any. */
  reservationId: string | null;
}

export interface CalendarCrane {
  craneId: string;
  craneLabel: string;
  vendorId: string;
  vendorName: string;
  ownershipType: OwnershipType;
  craneTypeCode: string;
  craneTypeName: string;
  capacityT: number;
  stateCode: string;
  stateName: string;
  currentLocation: string;
  currentStatus: CraneStatus;
  days: CalendarDay[];
}

export interface CalendarView {
  from: string;
  to: string;
  /** The column headers: one entry per day in the range. */
  days: string[];
  cranes: CalendarCrane[];
}

/**
 * A day's state on the calendar.
 *
 * Reservations win: a booking is a commitment, so a crane with an ACTIVE
 * reservation for a day reads HIRED (a booking that has started) or RESERVED (a
 * booking still in the future), and a BLOCKED row reads BLOCKED. Only a day no
 * reservation covers can read UNAVAILABLE, and only when the vendor's own status
 * says the crane is under maintenance. Every other day is FREE.
 */
function dayState(
  dateKey: string,
  reservation: { id: string; type: ReservationType; startDate: Date } | undefined,
  status: CraneStatus,
  todayKey: string,
): CalendarDay {
  if (reservation) {
    if (reservation.type === ReservationType.BLOCKED) {
      return { date: dateKey, state: "BLOCKED", reservationId: reservation.id };
    }
    const startKey = reservation.startDate.toISOString().slice(0, 10);
    const state = startKey > todayKey ? "RESERVED" : "HIRED";
    return { date: dateKey, state, reservationId: reservation.id };
  }
  if (status === CraneStatus.UNDER_MAINTENANCE) {
    return { date: dateKey, state: "UNAVAILABLE", reservationId: null };
  }
  return { date: dateKey, state: "FREE", reservationId: null };
}

/**
 * The booking calendar (BPD 6.17): free, reserved, hired, blocked or
 * unavailable over a date range, filtered by ownership, crane type, vendor,
 * region and location.
 *
 * The Reservation table is the only booking record, so the calendar is a read
 * over cranes plus their ACTIVE reservations — no separate booking store and no
 * migration of undated bookings, because none exist.
 */
export async function bookingCalendar(
  raw: unknown,
  actor: ReservationActor,
): Promise<CalendarView> {
  assertInternal(actor);
  const query: CalendarQuery = calendarQuerySchema.parse(raw ?? {});
  const today = toUtcMidnight(new Date());
  const todayKey = today.toISOString().slice(0, 10);

  const dayKeys: string[] = [];
  for (
    let cursor = query.from.getTime();
    cursor <= query.to.getTime();
    cursor += 24 * 60 * 60 * 1000
  ) {
    dayKeys.push(new Date(cursor).toISOString().slice(0, 10));
  }

  const cranes = await prisma.crane.findMany({
    where: {
      isActive: true,
      ...(query.ownershipType ? { ownershipType: query.ownershipType } : {}),
      ...(query.craneType ? { typeOfCraneCode: query.craneType } : {}),
      ...(query.craneId ? { id: query.craneId } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.region ? { stateCode: query.region } : {}),
      ...(query.location
        ? { currentLocation: { contains: query.location, mode: "insensitive" } }
        : {}),
    },
    select: {
      id: true,
      vendorId: true,
      serialRegistrationNo: true,
      capacityT: true,
      currentStatus: true,
      currentLocation: true,
      stateCode: true,
      ownershipType: true,
      typeOfCraneCode: true,
      typeOfCrane: { select: { name: true } },
      state: { select: { name: true } },
      vendor: { select: { name: true } },
    },
    orderBy: [{ typeOfCraneCode: "asc" }, { capacityT: "asc" }],
  });

  const craneIds = cranes.map((crane) => crane.id);
  const reservations = craneIds.length
    ? await prisma.reservation.findMany({
        where: {
          craneId: { in: craneIds },
          status: ReservationStatus.ACTIVE,
          startDate: { lte: query.to },
          endDate: { gte: query.from },
        },
        select: { id: true, craneId: true, type: true, startDate: true, endDate: true },
      })
    : [];

  const byCrane = new Map<string, typeof reservations>();
  for (const reservation of reservations) {
    const list = byCrane.get(reservation.craneId) ?? [];
    list.push(reservation);
    byCrane.set(reservation.craneId, list);
  }

  const result: CalendarCrane[] = cranes.map((crane) => {
    const craneReservations = byCrane.get(crane.id) ?? [];
    const days: CalendarDay[] = dayKeys.map((key) => {
      const day = new Date(`${key}T00:00:00.000Z`);
      const covering = craneReservations.find(
        (reservation) =>
          reservation.startDate.getTime() <= day.getTime() &&
          reservation.endDate.getTime() >= day.getTime(),
      );
      return dayState(key, covering, crane.currentStatus, todayKey);
    });
    return {
      craneId: crane.id,
      craneLabel: craneLabelOf(crane),
      vendorId: crane.vendorId,
      vendorName: crane.vendor.name ?? "The vendor",
      ownershipType: crane.ownershipType,
      craneTypeCode: crane.typeOfCraneCode,
      craneTypeName: crane.typeOfCrane.name,
      capacityT: Number(crane.capacityT),
      stateCode: crane.stateCode,
      stateName: crane.state.name,
      currentLocation: crane.currentLocation,
      currentStatus: crane.currentStatus,
      days,
    };
  });

  return {
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    days: dayKeys,
    cranes: result,
  };
}

export async function createBlockedReservation(
  raw: unknown,
  actor: ReservationActor,
): Promise<ReservationView> {
  assertAdmin(actor);
  const input: CreateBlockedReservationInput = createBlockedReservationSchema.parse(raw);

  const crane = await prisma.crane.findUnique({
    where: { id: input.craneId },
    select: { id: true, isActive: true, vendorId: true },
  });
  if (!crane) throw AppError.notFound("That crane was not found");
  if (!crane.isActive) {
    throw AppError.conflict("That crane is deactivated and cannot be reserved");
  }

  const clash = await findOverlappingReservation(crane.id, input.startDate, input.endDate);
  if (clash) {
    throw AppError.conflict(
      `That crane already has an active reservation overlapping ${clash.startDate
        .toISOString()
        .slice(0, 10)} to ${clash.endDate.toISOString().slice(0, 10)}`,
    );
  }

  let created;
  try {
    created = await prisma.reservation.create({
      data: {
        craneId: crane.id,
        startDate: input.startDate,
        endDate: input.endDate,
        type: ReservationType.BLOCKED,
        status: ReservationStatus.ACTIVE,
        createdById: actor.id,
      },
      select: RESERVATION_SELECT,
    });
  } catch (error) {
    // The constraint is the backstop: two admins can pass the check above at the
    // same instant, and the exclusion constraint lets exactly one of them win.
    if (error instanceof Error && error.message.includes("reservations_active_no_overlap")) {
      throw AppError.conflict("That crane was just reserved for an overlapping period");
    }
    throw error;
  }

  await recordAudit({
    entity: "reservation",
    entityId: created.id,
    action: "block",
    newValue: {
      craneId: created.craneId,
      startDate: created.startDate,
      endDate: created.endDate,
      type: created.type,
      status: created.status,
      reason: input.reason ?? null,
    },
    craneId: created.craneId,
    actor: auditActor(actor),
  });

  return toView(created, new Date());
}

export interface ReleaseResult {
  reservation: ReservationView;
  notified: number;
}

export async function releaseReservation(
  reservationId: string,
  raw: unknown,
  actor: ReservationActor,
): Promise<ReleaseResult> {
  assertAdmin(actor);
  const input: ReleaseReservationInput = releaseReservationSchema.parse(raw);

  const existing = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: RESERVATION_SELECT,
  });
  if (!existing) throw AppError.notFound("That reservation was not found");
  if (existing.status !== ReservationStatus.ACTIVE) {
    throw AppError.conflict(
      `This reservation is ${existing.status.toLowerCase()} and cannot be released`,
    );
  }

  const releasedAt = new Date();
  const updated = await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      status: ReservationStatus.RELEASED,
      releasedById: actor.id,
      releasedAt,
      releaseReason: input.reason,
    },
    select: RESERVATION_SELECT,
  });

  await recordAudit({
    entity: "reservation",
    entityId: updated.id,
    action: "release",
    oldValue: { status: ReservationStatus.ACTIVE },
    newValue: {
      status: ReservationStatus.RELEASED,
      reason: input.reason,
      releasedAt: releasedAt.toISOString(),
    },
    craneId: updated.craneId,
    actor: auditActor(actor),
  });

  const notified = await notifyVendor(updated, actor, input.reason);

  return { reservation: toView(updated, new Date()), notified };
}

/**
 * After a release the vendor must know their crane is free again — that is the
 * whole consequence of releasing it. Addresses come from the RFQ's recipients
 * when the reservation came from an award, and fall back to the vendor's own
 * recorded address, the same fail-per-address tolerance dispatch uses.
 */
async function notifyVendor(
  reservation: ReservationRow,
  actor: ReservationActor,
  reason: string,
): Promise<number> {
  const addresses = new Set<string>();
  if (reservation.rfqId) {
    const recipients = await prisma.rfqVendorRecipient.findMany({
      where: { rfqId: reservation.rfqId, vendorId: reservation.crane.vendorId },
      select: { emails: true },
    });
    for (const r of recipients) for (const address of r.emails) addresses.add(address);
  }
  if (reservation.crane.vendor.email) addresses.add(reservation.crane.vendor.email);
  if (addresses.size === 0) return 0;

  const start = reservation.startDate.toISOString().slice(0, 10);
  const end = reservation.endDate.toISOString().slice(0, 10);

  let notified = 0;
  for (const address of addresses) {
    await sendTemplate({
      to: address,
      template: "reservation_released",
      entity: "reservation",
      entityId: reservation.id,
      vars: {
        vendorName: reservation.crane.vendor.name ?? "The vendor",
        craneLabel: craneLabelOf(reservation.crane),
        periodText: reservation.startDate.getTime() === reservation.endDate.getTime()
          ? start
          : `${start} to ${end}`,
        releasedBy: actor.email,
        reasonBlock: optionalBlock(reason),
      },
    })
      .then((r) => {
        if (r.sent) notified += 1;
      })
      .catch((err) => console.error("[reservations] release email failed", err));
  }
  return notified;
}

/**
 * Reservations whose end date has passed stop being Active (brief 6.1). The
 * sweep runs on the scheduler and is idempotent: an already-Completed row is not
 * touched because the update filters on ACTIVE.
 */
export async function completeOverdueReservations(now = new Date()): Promise<number> {
  const today = toUtcMidnight(now);
  const result = await prisma.reservation.updateMany({
    where: { status: ReservationStatus.ACTIVE, endDate: { lt: today } },
    data: { status: ReservationStatus.COMPLETED },
  });
  return result.count;
}

/**
 * The active reservations for a set of cranes, for badge derivation in list
 * reads. Returns a map so callers do not repeat the query per crane.
 */
export type CraneReservations = Array<{
  type: ReservationType;
  status: ReservationStatus;
  startDate: Date;
  endDate: Date;
}>;

export async function activeReservationsByCrane(
  craneIds: string[],
): Promise<Map<string, CraneReservations>> {
  const map = new Map<string, CraneReservations>();
  if (craneIds.length === 0) return map;
  const rows = await prisma.reservation.findMany({
    where: { craneId: { in: craneIds }, status: ReservationStatus.ACTIVE },
    select: { craneId: true, type: true, status: true, startDate: true, endDate: true },
    orderBy: { startDate: "asc" },
  });
  for (const row of rows) {
    const list = map.get(row.craneId) ?? [];
    list.push(row);
    map.set(row.craneId, list);
  }
  return map;
}
