import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { getCraneDetail, type Actor, type CraneView } from "./crane.service";
import { bookingCalendar, deriveBookingBadge, type CalendarView } from "./reservations.service";
import { loadRateTable, pickRate } from "./mobilisationCost.service";
import { CraneStatus, ReservationStatus, ReservationType } from "../generated/prisma/client";

/**
 * The crane detail screen (BPD 6.11).
 *
 * This composes the fleet read (`getCraneDetail`, which already enforces the
 * approved-vendor rule) with what the brief asks a detail screen to add: the
 * booking calendar, maintenance flags, the transport-cost assumption behind the
 * mobilisation estimate, and the next date the crane is actually free.
 *
 * It is SML-side work — a vendor already has their own fleet screens — and
 * nothing here is written, so there is no reservation or crane change hiding in
 * a screen that looks like a read.
 */

export interface MaintenanceFlag {
  code: string;
  label: string;
  detail: string | null;
}

export interface CraneReservation {
  id: string;
  type: ReservationType;
  status: ReservationStatus;
  startDate: string;
  endDate: string;
  /** Booked/Hired as derived for the vendor, from the reservation's dates. */
  badge: "BOOKED" | "HIRED" | null;
}

export interface CraneProfile {
  crane: CraneView;
  calendar: CalendarView;
  maintenanceFlags: MaintenanceFlag[];
  transportAssumptions: {
    ratePerKm: number | null;
    note: string;
  };
  nextAvailableDate: string | null;
  reservations: CraneReservation[];
}

const CALENDAR_DAYS = 90;

function assertInternal(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Crane detail is available to SML staff only");
  }
}

function nextAvailable(
  crane: CraneView,
  reservations: Array<{ type: ReservationType; startDate: Date; endDate: Date }>,
  todayMs: number,
): string | null {
  const dayMs = 24 * 60 * 60 * 1000;
  const candidates: number[] = [];

  if (crane.currentStatus === CraneStatus.AVAILABLE) candidates.push(todayMs);
  if (crane.currentStatus === CraneStatus.ENGAGED && crane.availableFrom) {
    candidates.push(Date.parse(crane.availableFrom));
  }
  if (crane.currentStatus === CraneStatus.UNDER_MAINTENANCE && crane.expectedReadyDate) {
    candidates.push(Date.parse(crane.expectedReadyDate));
  }

  for (const reservation of reservations) {
    if (reservation.type !== ReservationType.BOOKED) continue;
    if (reservation.endDate.getTime() < todayMs) continue;
    // The crane is free the day after the booking window closes.
    candidates.push(reservation.endDate.getTime() + dayMs);
  }

  const usable = candidates.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;
  return new Date(Math.max(...usable)).toISOString();
}

export async function craneProfile(actor: Actor, craneId: string): Promise<CraneProfile> {
  assertInternal(actor);
  const crane = await getCraneDetail(actor, craneId);

  const today = new Date();
  const todayMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const from = new Date(todayMidnight).toISOString();
  const to = new Date(todayMidnight + CALENDAR_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [calendar, reservations, rates] = await Promise.all([
    bookingCalendar({ from, to, craneId }, actor),
    prisma.reservation.findMany({
      where: { craneId, status: ReservationStatus.ACTIVE },
      orderBy: { startDate: "asc" },
      select: { id: true, type: true, status: true, startDate: true, endDate: true },
    }),
    loadRateTable(),
  ]);

  const maintenanceFlags: MaintenanceFlag[] = [];
  if (crane.currentStatus === CraneStatus.UNDER_MAINTENANCE) {
    maintenanceFlags.push({
      code: "UNDER_MAINTENANCE",
      label: "Under maintenance",
      detail: crane.expectedReadyDate
        ? `Expected ready ${crane.expectedReadyDate.slice(0, 10)}`
        : "No ready date recorded",
    });
  }
  if (crane.freshness.stale) {
    maintenanceFlags.push({
      code: "STALE",
      label: "Stale location or status",
      detail: `Not confirmed for ${crane.freshness.daysSinceUpdate} days`,
    });
  }
  if (crane.locationUnverified) {
    maintenanceFlags.push({
      code: "LOCATION_UNVERIFIED",
      label: "Location unverified",
      detail: "No coordinates, so it cannot be distance-sorted",
    });
  }
  if (crane.approvalStatus === "PENDING") {
    maintenanceFlags.push({
      code: "AWAITING_APPROVAL",
      label: "Awaiting fleet approval",
      detail: null,
    });
  }
  if (!crane.isActive) {
    maintenanceFlags.push({ code: "INACTIVE", label: "Inactive", detail: null });
  }

  const ratePerKm = pickRate(rates, {
    craneTypeCode: crane.typeOfCraneCode,
    capacityT: crane.capacityT,
    ownershipType: crane.ownershipType as "SML" | "VENDOR",
  });

  return {
    crane,
    calendar,
    maintenanceFlags,
    transportAssumptions: {
      ratePerKm,
      note:
        ratePerKm === null
          ? "No mobilisation rate is configured for this crane type and capacity band."
          : "Estimated from the mobilisation rate table; distance uses the geocoding provider in use.",
    },
    nextAvailableDate: nextAvailable(crane, reservations, todayMidnight),
    reservations: reservations.map((reservation) => ({
      id: reservation.id,
      type: reservation.type,
      status: reservation.status,
      startDate: reservation.startDate.toISOString(),
      endDate: reservation.endDate.toISOString(),
      badge: deriveBookingBadge(reservation, today),
    })),
  };
}
