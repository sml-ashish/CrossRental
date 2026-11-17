import { OnboardingStatus, UserRole } from "../generated/prisma/client";
import { BUSY_STATUSES } from "../validation/craneFields";
import type { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { getSettings } from "../utils/settings";
import { portalUrl } from "../utils/jwt";
import { ROLE_LABELS } from "../utils/rbac";
import { recordAudit } from "./audit.service";
import { requestLoginOtp, requestPasswordReset } from "./auth.service";
import { sendTemplate } from "./email.service";
import type { Actor } from "./rfq.service";
import { adminAlerts, type AlertItem } from "./alert.service";

/**
 * P0 B: the internal-only administration surface.
 *
 * Two small jobs live here rather than in the vendor-facing services:
 *
 * - the dashboard counters an admin opens the day with (B1), and
 * - managing the SML staff who operate the portal, plus suspending a vendor
 *   whose registration has gone wrong (B2).
 *
 * `recordAudit` is called for every write, because "who disabled that sales
 * user" and "who suspended that vendor" are the questions this screen exists to
 * answer. Suspension is enforced on the server at login, in the RFQ recipient
 * resolution and in the candidate picker — see `auth.service.loginWithPassword`,
 * `rfq.service.resolveRecipients` / `listApprovedVendors` and
 * `candidate.service.candidatesForRfq`.
 */

export type InternalRole = Extract<
  UserRole,
  "admin_user" | "sales_user" | "management_viewer"
>;

const INTERNAL_ROLES: readonly InternalRole[] = [
  "admin_user",
  "sales_user",
  "management_viewer",
];

// --- B1: dashboard --------------------------------------------------------

export interface AdminDashboard {
  counts: {
    awaitingApproval: number;
    rfqsWithFailures: number;
    cranesStale: number;
    cranesUnverified: number;
    cranesLapsed: number;
    // P5 additions.
    fleetPendingValidation: number;
    unmatchedQuotationResponses: number;
    failedEmails: number;
  };
  thresholds: {
    staleFlagDays: number;
    fleetApprovalRequired: boolean;
    alertRfqSlaHours: number;
    alertQuotationExpiryDays: number;
    alertBookingLeadDays: number;
  };
  alerts: AlertItem[];
}

/**
 * The five counters from brief B1. Each is a single `count` rather than a list,
 * so the dashboard stays cheap however large the fleet grows; the screen links
 * each counter to the list that already filters the same way.
 */
export async function adminDashboard(): Promise<AdminDashboard> {
  const settings = await getSettings();
  const staleBefore = new Date(Date.now() - settings.staleFlagDays * 86_400_000);
  const now = new Date();

  const failedSince = new Date(Date.now() - 7 * 86_400_000);

  const [
    awaitingApproval,
    rfqsWithFailures,
    cranesStale,
    cranesUnverified,
    cranesLapsed,
    fleetPendingValidation,
    failedEmails,
    unmatchedQuotationResponses,
    alerts,
  ] = await Promise.all([
    prisma.vendor.count({ where: { onboardingStatus: OnboardingStatus.SUBMITTED } }),
    // A distinct RFQ, not a recipient: one failed address is one row to fix.
    prisma.rfq.count({
      where: { recipients: { some: { emailDeliveryStatus: "FAILED" } } },
    }),
    prisma.crane.count({
      where: { isActive: true, statusUpdatedAt: { lt: staleBefore } },
    }),
    prisma.crane.count({
      where: { isActive: true, OR: [{ latitude: null }, { longitude: null }] },
    }),
    prisma.crane.count({
      where: {
        isActive: true,
        currentStatus: { in: [...BUSY_STATUSES] },
        availableFrom: { lt: now },
      },
    }),
    settings.fleetApprovalRequired
      ? prisma.crane.count({ where: { isActive: true, approvalStatus: "PENDING" } })
      : Promise.resolve(0),
    prisma.emailLog.count({
      where: { status: "FAILED", createdAt: { gte: failedSince } },
    }),
    prisma.inboundReply.count({ where: { status: "PENDING" } }),
    adminAlerts(),
  ]);

  return {
    counts: {
      awaitingApproval,
      rfqsWithFailures,
      cranesStale,
      cranesUnverified,
      cranesLapsed,
      fleetPendingValidation,
      unmatchedQuotationResponses,
      failedEmails,
    },
    thresholds: {
      staleFlagDays: settings.staleFlagDays,
      fleetApprovalRequired: settings.fleetApprovalRequired,
      alertRfqSlaHours: settings.alertRfqSlaHours,
      alertQuotationExpiryDays: settings.alertQuotationExpiryDays,
      alertBookingLeadDays: settings.alertBookingLeadDays,
    },
    alerts,
  };
}

// --- B1: the rows behind one counter --------------------------------------

export type AdminDashboardItemKind = "stale" | "unverified" | "lapsed" | "pending-fleet";

export interface AdminDashboardItem {
  craneId: string;
  /** The vendor's own identifier for the crane, usually the registration no. */
  label: string;
  make: string;
  model: string;
  capacityT: number;
  vendorId: string;
  vendorName: string | null;
  currentStatus: string;
  approvalStatus: string;
  statusUpdatedAt: string;
  availableFrom: string | null;
  daysSinceUpdate: number;
  daysOverdue: number | null;
}

/** A drawer shows the worst first and pages on the client; 200 is plenty. */
const DASHBOARD_ITEM_LIMIT = 200;

/**
 * The exact rows behind one dashboard counter (P0 B1).
 *
 * The where clauses are deliberately identical to `adminDashboard()`: the
 * drawer's list and the row's number are two views of the same query, so they
 * cannot drift apart. Unlike `/api/cranes`, this includes cranes whose vendor is
 * not approved yet — the counter does, and the note under the row says so.
 *
 * Sorted by severity: oldest update first for stale/unverified, longest overdue
 * first for lapsed, oldest record first for the approval queue.
 */
export async function adminDashboardItems(
  kind: AdminDashboardItemKind,
): Promise<{ items: AdminDashboardItem[]; total: number }> {
  const settings = await getSettings();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - settings.staleFlagDays * 86_400_000);

  if (kind === "pending-fleet" && !settings.fleetApprovalRequired) {
    return { items: [], total: 0 };
  }

  const where: Prisma.CraneWhereInput =
    kind === "stale"
      ? { isActive: true, statusUpdatedAt: { lt: staleBefore } }
      : kind === "unverified"
        ? { isActive: true, OR: [{ latitude: null }, { longitude: null }] }
        : kind === "lapsed"
          ? { isActive: true, currentStatus: { in: [...BUSY_STATUSES] }, availableFrom: { lt: now } }
          : { isActive: true, approvalStatus: "PENDING" };

  const orderBy: Prisma.CraneOrderByWithRelationInput =
    kind === "lapsed"
      ? { availableFrom: "asc" }
      : kind === "pending-fleet"
        ? { createdAt: "asc" }
        : { statusUpdatedAt: "asc" };

  const [rows, total] = await Promise.all([
    prisma.crane.findMany({
      where,
      select: {
        id: true,
        serialRegistrationNo: true,
        make: true,
        model: true,
        capacityT: true,
        currentStatus: true,
        approvalStatus: true,
        statusUpdatedAt: true,
        availableFrom: true,
        vendor: { select: { id: true, name: true } },
      },
      orderBy,
      take: DASHBOARD_ITEM_LIMIT,
    }),
    prisma.crane.count({ where }),
  ]);

  const items = rows.map((row) => ({
    craneId: row.id,
    label: row.serialRegistrationNo,
    make: row.make,
    model: row.model,
    capacityT: Number(row.capacityT),
    vendorId: row.vendor.id,
    vendorName: row.vendor.name,
    currentStatus: row.currentStatus,
    approvalStatus: row.approvalStatus,
    statusUpdatedAt: row.statusUpdatedAt.toISOString(),
    availableFrom: row.availableFrom?.toISOString() ?? null,
    daysSinceUpdate: Math.max(
      0,
      Math.floor((now.getTime() - row.statusUpdatedAt.getTime()) / 86_400_000),
    ),
    daysOverdue: row.availableFrom
      ? Math.max(
          0,
          Math.floor((now.getTime() - row.availableFrom.getTime()) / 86_400_000),
        )
      : null,
  }));

  return { items, total };
}

// --- B2: internal users ---------------------------------------------------

export interface AdminUserRow {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** Every SML staff account, admin and sales, newest first. */
export async function listInternalUsers(): Promise<AdminUserRow[]> {
  return prisma.user.findMany({
    where: { role: { in: [...INTERNAL_ROLES] } },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function createInternalUser(
  input: { email: string; fullName?: string | null; role: InternalRole },
  actor: Actor,
): Promise<AdminUserRow> {
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw AppError.conflict("A user with that email already exists");

  const created = await prisma.user.create({
    data: {
      email,
      fullName: input.fullName?.trim() || null,
      role: input.role,
      isActive: true,
      // Internal accounts are OTP-only and never hold a password hash.
      passwordHash: null,
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  await recordAudit({
    entity: "User",
    entityId: created.id,
    action: "USER_CREATED",
    newValue: { email: created.email, role: created.role, fullName: created.fullName },
    actor: { id: actor.id, email: actor.email, role: actor.role, vendorId: actor.vendorId },
  });

  await sendTemplate({
    to: created.email,
    template: "internal_user_created",
    vars: {
      fullName: created.fullName ? ` ${created.fullName}` : "",
      roleLabel: ROLE_LABELS[created.role] ?? created.role,
      loginUrl: portalUrl("/auth/otp"),
    },
    entity: "User",
    entityId: created.id,
  });

  return created;
}

export async function updateInternalUser(
  id: string,
  input: { role?: InternalRole; isActive?: boolean },
  actor: Actor,
): Promise<AdminUserRow> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, isActive: true },
  });
  if (!user || !INTERNAL_ROLES.includes(user.role as InternalRole)) {
    throw AppError.notFound("Internal user not found");
  }

  if (input.isActive === false && user.id === actor.id) {
    // Otherwise the last admin can lock the door behind themselves.
    throw AppError.badRequest("You cannot deactivate your own account");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(input.role ? { role: input.role } : {}),
      ...(typeof input.isActive === "boolean" ? { isActive: input.isActive } : {}),
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  await recordAudit({
    entity: "User",
    entityId: updated.id,
    action: "USER_UPDATED",
    oldValue: { role: user.role, isActive: user.isActive },
    newValue: { role: updated.role, isActive: updated.isActive },
    actor: { id: actor.id, email: actor.email, role: actor.role, vendorId: actor.vendorId },
  });

  return updated;
}

/**
 * Force a fresh sign-in credential.
 *
 * The mechanism depends on the audience: an internal user signs in with a
 * one-time code, so a reset means issuing a new code and voiding the old ones;
 * a vendor signs in with a password, so a reset means the emailed reset link.
 */
export async function resetUserCredentials(id: string, actor: Actor): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, isActive: true },
  });
  if (!user) throw AppError.notFound("User not found");

  if (user.role === "vendor_user") {
    if (!user.isActive) throw AppError.badRequest("That vendor account is not active");
    await requestPasswordReset(user.email);
  } else if (INTERNAL_ROLES.includes(user.role as InternalRole)) {
    if (!user.isActive) throw AppError.badRequest("That user account is not active");
    await requestLoginOtp(user.email);
  } else {
    throw AppError.badRequest("This account cannot be reset from here");
  }

  await recordAudit({
    entity: "User",
    entityId: user.id,
    action: "USER_CREDENTIALS_RESET",
    actor: { id: actor.id, email: actor.email, role: actor.role, vendorId: actor.vendorId },
  });
}

// --- B2: vendor suspension ------------------------------------------------

export interface SuspendedVendor {
  id: string;
  name: string | null;
  suspendedAt: Date | null;
  suspendReason: string | null;
}

export async function suspendVendor(
  vendorId: string,
  reason: string | null,
  actor: Actor,
): Promise<SuspendedVendor> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, name: true, suspendedAt: true },
  });
  if (!vendor) throw AppError.notFound("Vendor not found");
  if (vendor.suspendedAt) {
    throw AppError.conflict("That vendor is already suspended");
  }

  const suspendedAt = new Date();
  await prisma.$transaction([
    prisma.vendor.update({
      where: { id: vendorId },
      data: { suspendedAt, suspendedById: actor.id, suspendReason: reason },
    }),
    // Suspension bars login: deactivating the users kills their existing tokens
    // at the next request, not just the next sign-in.
    prisma.user.updateMany({
      where: { vendorId, role: "vendor_user" },
      data: { isActive: false },
    }),
  ]);

  await recordAudit({
    entity: "Vendor",
    entityId: vendorId,
    action: "VENDOR_SUSPENDED",
    newValue: { suspendedAt: suspendedAt.toISOString(), reason },
    actor: { id: actor.id, email: actor.email, role: actor.role, vendorId: actor.vendorId },
  });

  return { id: vendorId, name: vendor.name, suspendedAt, suspendReason: reason };
}

export async function reinstateVendor(
  vendorId: string,
  actor: Actor,
): Promise<SuspendedVendor> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, name: true, suspendedAt: true, onboardingStatus: true },
  });
  if (!vendor) throw AppError.notFound("Vendor not found");
  if (!vendor.suspendedAt) throw AppError.badRequest("That vendor is not suspended");

  await prisma.$transaction([
    prisma.vendor.update({
      where: { id: vendorId },
      data: { suspendedAt: null, suspendedById: null, suspendReason: null },
    }),
    // Only an approved vendor's users come back: a suspension is not a way to
    // re-approve a registration that was never approved.
    ...(vendor.onboardingStatus === OnboardingStatus.APPROVED
      ? [
          prisma.user.updateMany({
            where: { vendorId, role: "vendor_user" },
            data: { isActive: true },
          }),
        ]
      : []),
  ]);

  await recordAudit({
    entity: "Vendor",
    entityId: vendorId,
    action: "VENDOR_REINSTATED",
    oldValue: { suspendedAt: vendor.suspendedAt.toISOString() },
    actor: { id: actor.id, email: actor.email, role: actor.role, vendorId: actor.vendorId },
  });

  return { id: vendorId, name: vendor.name, suspendedAt: null, suspendReason: null };
}
