import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { getSettings } from "../utils/settings";
import {
  activeReservationsByCrane,
  deriveBookingBadge,
} from "./reservations.service";
import {
  CraneStatus,
  QuotationStatus,
  ResponseStatus,
  RfqStatus,
} from "../generated/prisma/client";

/**
 * Vendor dashboard (brief 7.5, M7).
 *
 * Counters and the lists they point at, in one read. The brief says each
 * counter links to the filtered list, so the response carries the rows a
 * counter leads to rather than only numbers — the due-for-update list, the
 * awaiting-response RFQs and the bookings — and leaves the multi-step filtered
 * views to the screens behind the links (My Fleet, the RFQ inbox), which
 * already exist and already filter.
 *
 * Vendors only ever see their own data: every query is scoped by the vendor id
 * from the token, same as every other vendor surface. A user whose account is
 * not linked to a vendor gets a 403 rather than a dashboard of nothing, because
 * an empty dashboard reads as a real answer.
 */

export interface DashboardActor {
  id: string;
  email: string;
  role: AuthedRequest["user"]["role"];
  vendorId: string | null;
}

function requireVendorId(actor: DashboardActor): string {
  if (actor.role !== "vendor_user") {
    throw AppError.forbidden("The dashboard belongs to a vendor account");
  }
  if (!actor.vendorId) {
    throw AppError.forbidden("Your account is not linked to a vendor");
  }
  return actor.vendorId;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/** Whole days since the crane's freshness clock was last wound. */
function daysSinceUpdate(statusUpdatedAt: Date, now: Date): number {
  return Math.max(
    0,
    Math.round(
      (startOfUtcDay(now) - startOfUtcDay(statusUpdatedAt)) / DAY_MS,
    ),
  );
}

export interface VendorDashboard {
  fleet: {
    totalCranes: number;
    byStatus: Record<string, number>;
    dueForUpdate: Array<{
      craneId: string;
      label: string;
      currentStatus: string;
      daysSinceUpdate: number;
      locationUnverified: boolean;
      /** Brief B3: Engaged but its availability date has passed — confirm it. */
      availableFromLapsed: boolean;
      statusUpdatedAt: string;
    }>;
    bookings: {
      count: number;
      cranes: Array<{
        craneId: string;
        label: string;
        currentStatus: string;
        statusUpdatedAt: string;
        startDate: string | null;
        endDate: string | null;
      }>;
    };
    /**
     * Brief D1: cranes whose last change was made by an SML user on the vendor's
     * behalf, so the vendor notices and can review them.
     */
    updatedOnBehalf: {
      count: number;
      cranes: Array<{
        craneId: string;
        label: string;
        currentStatus: string;
        statusUpdatedAt: string;
      }>;
    };
  };
  rfqs: {
    openCount: number;
    awaitingResponseCount: number;
    awardedCount: number;
    notAwardedCount: number;
    awaitingResponse: Array<{
      rfqId: string;
      rfqNumber: string;
      siteLocation: string;
      siteStateName: string;
      craneType: string;
      craneTypeName: string;
      capacityT: number;
      deadline: string;
      overdue: boolean;
      responseStatus: string;
      respondedAt: string | null;
      liveQuotationCount: number;
    }>;
  };
  quotations: {
    submittedCount: number;
    awardedCount: number;
    notAwardedCount: number;
  };
}

const CRANES_SELECT = {
  id: true,
  currentStatus: true,
  currentLocation: true,
  serialRegistrationNo: true,
  capacityT: true,
  typeOfCrane: { select: { name: true } },
  latitude: true,
  longitude: true,
  isActive: true,
  statusUpdatedAt: true,
  availableFrom: true,
  updatedOnBehalf: true,
} as const;

export async function vendorDashboard(actor: DashboardActor): Promise<VendorDashboard> {
  const vendorId = requireVendorId(actor);
  const settings = await getSettings();
  const now = new Date();

  const cranes = await prisma.crane.findMany({
    where: { vendorId },
    select: CRANES_SELECT,
    orderBy: [{ statusUpdatedAt: "asc" }, { id: "asc" }],
  });

  const active = cranes.filter((c) => c.isActive);

  const byStatus: Record<string, number> = {};
  for (const crane of active) {
    byStatus[crane.currentStatus] = (byStatus[crane.currentStatus] ?? 0) + 1;
  }

  const label = (crane: {
    typeOfCrane: { name: string } | null;
    capacityT: unknown;
    serialRegistrationNo: string;
  }) =>
    `${crane.typeOfCrane?.name ?? "Crane"} ${Number(crane.capacityT)} t — ${crane.serialRegistrationNo}`;

  // Brief B3: an Engaged crane whose `available_from` has passed is stale by
  // fact, whatever the freshness clock says — the vendor must confirm it is free
  // (or was re-engaged) rather than leave a lapsed date standing.
  const availableFromLapsed = (c: {
    currentStatus: string;
    availableFrom: Date | null;
  }) =>
    c.currentStatus === CraneStatus.ENGAGED &&
    c.availableFrom !== null &&
    c.availableFrom.getTime() < startOfUtcDay(now);

  const dueForUpdate = active
    .filter(
      (c) =>
        daysSinceUpdate(c.statusUpdatedAt, now) >= settings.staleDueDays ||
        availableFromLapsed(c),
    )
    .map((c) => ({
      craneId: c.id,
      label: label(c),
      currentStatus: c.currentStatus,
      daysSinceUpdate: daysSinceUpdate(c.statusUpdatedAt, now),
      locationUnverified: c.latitude === null || c.longitude === null,
      availableFromLapsed: availableFromLapsed(c),
      statusUpdatedAt: c.statusUpdatedAt.toISOString(),
    }));

  // Active and upcoming bookings (brief 7.5): Booked and Hired are derived from
  // the reservations on the crane, never stored (brief 6.1, phase B). A
  // reservation covering today reads Hired, one starting later reads Booked,
  // and the crane's own status stays the vendor's word underneath.
  const reservationMap = await activeReservationsByCrane(active.map((c) => c.id));

  const bookings: VendorDashboard["fleet"]["bookings"]["cranes"] = [];
  for (const crane of active) {
    const badges = (reservationMap.get(crane.id) ?? [])
      .map((reservation) => ({ reservation, badge: deriveBookingBadge(reservation, now) }))
      .filter(
        (row): row is typeof row & { badge: "BOOKED" | "HIRED" } => row.badge !== null,
      );

    if (badges.length > 0) {
      // A crane can carry several future bookings; the one covering today is the
      // headline, otherwise the soonest upcoming one.
      const chosen =
        badges.find((row) => row.badge === "HIRED") ??
        badges.reduce((a, b) => (a.reservation.startDate <= b.reservation.startDate ? a : b));
      bookings.push({
        craneId: crane.id,
        label: label(crane),
        currentStatus: chosen.badge,
        statusUpdatedAt: chosen.reservation.startDate.toISOString(),
        startDate: chosen.reservation.startDate.toISOString(),
        endDate: chosen.reservation.endDate.toISOString(),
      });
      continue;
    }

    // A crane still carrying the legacy stored status is shown even before its
    // synthesized reservation is read, so the transition never blanks a booking.
    if (
      crane.currentStatus === CraneStatus.BOOKED ||
      crane.currentStatus === CraneStatus.HIRED
    ) {
      bookings.push({
        craneId: crane.id,
        label: label(crane),
        currentStatus: crane.currentStatus,
        statusUpdatedAt: crane.statusUpdatedAt.toISOString(),
        startDate: null,
        endDate: null,
      });
    }
  }

  const recipients = await prisma.rfqVendorRecipient.findMany({
    where: { vendorId },
    select: {
      id: true,
      responseStatus: true,
      respondedAt: true,
      rfq: {
        select: {
          id: true,
          rfqNumber: true,
          siteLocation: true,
          craneType: true,
          capacityT: true,
          submissionDeadline: true,
          status: true,
          siteState: { select: { name: true } },
          craneTypeRef: { select: { name: true } },
        },
      },
    },
    orderBy: { rfq: { submissionDeadline: "asc" } },
  });

  const live = recipients
    .filter(
      (r) =>
        r.rfq.status === RfqStatus.SENT || r.rfq.status === RfqStatus.CLOSED,
    )
    .filter(
      (r) =>
        r.responseStatus === ResponseStatus.PENDING ||
        r.responseStatus === ResponseStatus.QUOTED,
    );

  const rfqIds = recipients.map((r) => r.rfq.id);
  const quotations = rfqIds.length
    ? await prisma.quotation.findMany({
        where: { vendorId, rfqId: { in: rfqIds } },
        select: { rfqId: true, version: true, isLatest: true, status: true, submittedAt: true },
      })
    : [];

  // A "quotation submitted" is one offer, so series are counted once whatever
  // their version history: version 1 is the count.
  const submittedCount = quotations.filter((q) => q.version === 1).length;
  const awardedCount = quotations.filter(
    (q) => q.isLatest && q.status === QuotationStatus.SELECTED,
  ).length;
  const notAwardedCount = quotations.filter(
    (q) => q.isLatest && q.status === QuotationStatus.NOT_AWARDED,
  ).length;

  const liveByRfq = new Map<string, number>();
  for (const q of quotations) {
    if (q.isLatest && q.status !== QuotationStatus.WITHDRAWN) {
      liveByRfq.set(q.rfqId, (liveByRfq.get(q.rfqId) ?? 0) + 1);
    }
  }

  // Awaiting my response (brief 7.5): only RFQs the vendor has not yet answered.
  // A row already quoted — let alone awarded — is counted under "quotations
  // submitted", not here, so a booked quote never reads as still awaiting the
  // vendor. Same basis as `awaitingResponseCount` above.
  const awaitingResponse = recipients
    .filter(
      (r) =>
        r.responseStatus === ResponseStatus.PENDING &&
        (r.rfq.status === RfqStatus.SENT || r.rfq.status === RfqStatus.CLOSED),
    )
    .slice(0, 10)
    .map((r) => ({
      rfqId: r.rfq.id,
      rfqNumber: r.rfq.rfqNumber,
      siteLocation: r.rfq.siteLocation,
      siteStateName: r.rfq.siteState?.name ?? "",
      craneType: r.rfq.craneType,
      craneTypeName: r.rfq.craneTypeRef?.name ?? "",
      capacityT: Number(r.rfq.capacityT),
      deadline: r.rfq.submissionDeadline.toISOString(),
      overdue: r.rfq.submissionDeadline.getTime() < now.getTime(),
      responseStatus: r.responseStatus,
      respondedAt: r.respondedAt?.toISOString() ?? null,
      liveQuotationCount: liveByRfq.get(r.rfq.id) ?? 0,
    }));

  // Brief D1: the dashboard notice for changes SML made on the vendor's behalf.
  const onBehalf = active
    .filter((c) => c.updatedOnBehalf)
    .map((c) => ({
      craneId: c.id,
      label: label(c),
      currentStatus: c.currentStatus,
      statusUpdatedAt: c.statusUpdatedAt.toISOString(),
    }));

  return {
    fleet: {
      totalCranes: active.length,
      byStatus,
      dueForUpdate,
      bookings: { count: bookings.length, cranes: bookings },
      updatedOnBehalf: { count: onBehalf.length, cranes: onBehalf },
    },
    rfqs: {
      openCount: live.length,
      awaitingResponseCount: live.filter(
        (r) => r.responseStatus === ResponseStatus.PENDING,
      ).length,
      awardedCount,
      notAwardedCount,
      awaitingResponse,
    },
    quotations: {
      submittedCount,
      awardedCount,
      notAwardedCount,
    },
  };
}
