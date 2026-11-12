import { prisma } from "../lib/database";
import { getSettings } from "../utils/settings";
import { Raw, escapeHtml, sendTemplate } from "./email.service";
import { portalUrl } from "../utils/jwt";

/**
 * P5 alerts (BPD 7.3).
 *
 * Alerts are computed from the live rows each time a dashboard is opened, not
 * stored: an item is "an RFQ past its SLA" only while it is still past its SLA,
 * so a stored row would need a second lifecycle to stay honest. The same
 * functions feed the daily email digest, which is the only scheduled part.
 *
 * Every alert carries a link into the record it names. SLA values come from
 * `app_settings` (open item 11), so an admin changes them without a deploy.
 */

export type AlertKind =
  | "RFQ_SLA"
  | "QUOTATION_EXPIRY"
  | "NO_VENDOR_RESPONSE"
  | "BOOKING_UNCONFIRMED"
  | "STALE_FLEET"
  | "ONBOARDING_REQUEST"
  | "EMAIL_FAILURE"
  | "UNMATCHED_QUOTATION";

export interface AlertItem {
  id: string;
  kind: AlertKind;
  tone: "error" | "warning" | "info";
  title: string;
  detail: string;
  /** Portal path for the record, consumed by the dashboard link. */
  to: string;
  count?: number;
}

const MAX_ALERTS_PER_KIND = 25;

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

// --- Sales (CR team) -------------------------------------------------------

export async function salesAlerts(): Promise<AlertItem[]> {
  const settings = await getSettings();
  const now = new Date();
  const slaBefore = hoursAgo(settings.alertRfqSlaHours);
  const expiryBefore = daysFromNow(settings.alertQuotationExpiryDays);

  const [slaRecipients, expiringQuotations, silentLines, unconfirmedBookings] =
    await Promise.all([
    // (a) An RFQ awaiting a response beyond the SLA and still before its
    // deadline: there is still room to chase.
    prisma.rfqVendorRecipient.findMany({
      where: {
        responseStatus: "PENDING",
        rfq: {
          sentAt: { not: null, lt: slaBefore },
          submissionDeadline: { gt: now },
          status: "SENT",
        },
      },
      select: {
        id: true,
        rfqId: true,
        rfq: { select: { rfqNumber: true, submissionDeadline: true } },
        vendor: { select: { name: true } },
      },
      orderBy: { rfq: { submissionDeadline: "asc" } },
      take: MAX_ALERTS_PER_KIND,
    }),

    // (b) A live quotation whose validity is close to running out.
    prisma.quotation.findMany({
      where: {
        isLatest: true,
        status: { in: ["SUBMITTED", "UNDER_REVIEW", "SHORTLISTED"] },
        validityDate: { gte: now, lte: expiryBefore },
      },
      select: {
        id: true,
        rfqId: true,
        validityDate: true,
        rfq: { select: { rfqNumber: true } },
        vendor: { select: { name: true } },
      },
      orderBy: { validityDate: "asc" },
      take: MAX_ALERTS_PER_KIND,
    }),

    // (c) A line whose RFQs have been out past the SLA with no vendor having
    // quoted or declined. A DECLINED response is still a response; only silence
    // is the alert.
    prisma.enquiryLineItem.findMany({
      where: {
        trailStatus: { in: ["RFQ_SENT", "AWAITING_QUOTES"] },
        rfqs: {
          some: {
            sentAt: { not: null, lt: slaBefore },
            recipients: {
              none: { responseStatus: { in: ["QUOTED", "DECLINED"] } },
            },
          },
        },
      },
      select: {
        id: true,
        lineNo: true,
        enquiryId: true,
        craneTypeCode: true,
        enquiry: { select: { enquiryNo: true } },
      },
      orderBy: { updatedAt: "asc" },
      take: MAX_ALERTS_PER_KIND,
    }),

    // (d) A booking starting soon whose quotation did not confirm availability.
    // Admin sees the same condition on its own dashboard.
    prisma.reservation.findMany({
      where: {
        status: "ACTIVE",
        type: "BOOKED",
        startDate: { gte: now, lte: daysFromNow(settings.alertBookingLeadDays) },
        OR: [
          { quotationId: null },
          { quotation: { is: { availabilityConfirmed: false } } },
        ],
      },
      select: {
        id: true,
        startDate: true,
        crane: { select: { serialRegistrationNo: true } },
        quotation: { select: { id: true } },
        enquiryLineId: true,
      },
      orderBy: { startDate: "asc" },
      take: MAX_ALERTS_PER_KIND,
    }),
  ]);

  const alerts: AlertItem[] = [];

  for (const row of slaRecipients) {
    alerts.push({
      id: `rfq-sla:${row.id}`,
      kind: "RFQ_SLA",
      tone: "warning",
      title: `${row.rfq.rfqNumber}: no response from ${row.vendor.name ?? "vendor"}`,
      detail: `Awaiting response beyond ${settings.alertRfqSlaHours}h. Deadline ${row.rfq.submissionDeadline.toLocaleDateString()}.`,
      to: `/app/rfqs/${row.rfqId}`,
    });
  }

  for (const row of expiringQuotations) {
    alerts.push({
      id: `quotation-expiry:${row.id}`,
      kind: "QUOTATION_EXPIRY",
      tone: "warning",
      title: `${row.rfq.rfqNumber}: quotation from ${row.vendor.name ?? "vendor"} expires soon`,
      detail: `Valid until ${row.validityDate.toLocaleDateString()}.`,
      to: `/app/rfqs/${row.rfqId}`,
    });
  }

  for (const row of silentLines) {
    alerts.push({
      id: `no-response:${row.id}`,
      kind: "NO_VENDOR_RESPONSE",
      tone: "error",
      title: `Line ${row.lineNo} on ${row.enquiry.enquiryNo} has no vendor responses`,
      detail: "No vendor has quoted or declined despite the RFQ being sent.",
      to: `/app/enquiries/lines/${row.id}`,
    });
  }

  for (const row of unconfirmedBookings) {
    alerts.push({
      id: `booking-unconfirmed:${row.id}`,
      kind: "BOOKING_UNCONFIRMED",
      tone: "warning",
      title: `Booking for ${row.crane.serialRegistrationNo} starts ${row.startDate.toLocaleDateString()}`,
      detail: row.quotation
        ? "The selected quotation did not confirm availability."
        : "The booking has no linked quotation.",
      to: row.enquiryLineId
        ? `/app/enquiries/lines/${row.enquiryLineId}`
        : "/app/bookings",
    });
  }

  return alerts;
}

// --- Admin -----------------------------------------------------------------

export async function adminAlerts(): Promise<AlertItem[]> {
  const settings = await getSettings();
  const now = new Date();
  const leadBefore = daysFromNow(settings.alertBookingLeadDays);
  const staleBefore = daysAgo(settings.staleFlagDays);
  const failureSince = daysAgo(7);

  const [
    unconfirmedBookings,
    staleCranes,
    onboardingRequests,
    emailFailures,
    unmatchedReplies,
  ] = await Promise.all([
    // (d) A booking starting soon whose quotation did not confirm availability.
    prisma.reservation.findMany({
      where: {
        status: "ACTIVE",
        type: "BOOKED",
        startDate: { gte: now, lte: leadBefore },
        OR: [
          { quotationId: null },
          { quotation: { is: { availabilityConfirmed: false } } },
        ],
      },
      select: {
        id: true,
        startDate: true,
        craneId: true,
        crane: { select: { serialRegistrationNo: true } },
        quotation: { select: { id: true } },
        enquiryLineId: true,
      },
      orderBy: { startDate: "asc" },
      take: MAX_ALERTS_PER_KIND,
    }),

    prisma.crane.count({
      where: { isActive: true, statusUpdatedAt: { lt: staleBefore } },
    }),

    prisma.vendor.count({ where: { onboardingStatus: "SUBMITTED" } }),

    prisma.emailLog.count({
      where: { status: "FAILED", createdAt: { gte: failureSince } },
    }),

    prisma.inboundReply.count({ where: { status: "PENDING" } }),
  ]);

  const alerts: AlertItem[] = [];

  for (const row of unconfirmedBookings) {
    alerts.push({
      id: `booking-unconfirmed:${row.id}`,
      kind: "BOOKING_UNCONFIRMED",
      tone: "warning",
      title: `Booking for ${row.crane.serialRegistrationNo} starts ${row.startDate.toLocaleDateString()}`,
      detail: row.quotation
        ? "The selected quotation did not confirm availability."
        : "The booking has no linked quotation.",
      to: row.enquiryLineId
        ? `/app/enquiries/lines/${row.enquiryLineId}`
        : "/app/bookings",
    });
  }

  if (staleCranes > 0) {
    alerts.push({
      id: "stale-fleet",
      kind: "STALE_FLEET",
      tone: "warning",
      title: `${staleCranes} crane${staleCranes === 1 ? "" : "s"} not updated in ${settings.staleFlagDays}+ days`,
      detail: "Vendors have been reminded; the fleet data may be out of date.",
      to: "/app/discovery",
      count: staleCranes,
    });
  }

  if (onboardingRequests > 0) {
    alerts.push({
      id: "onboarding-requests",
      kind: "ONBOARDING_REQUEST",
      tone: "info",
      title: `${onboardingRequests} vendor registration${onboardingRequests === 1 ? "" : "s"} awaiting approval`,
      detail: "Review the registration and approve or reject it.",
      to: "/app/approvals",
      count: onboardingRequests,
    });
  }

  if (emailFailures > 0) {
    alerts.push({
      id: "email-failures",
      kind: "EMAIL_FAILURE",
      tone: "error",
      title: `${emailFailures} email${emailFailures === 1 ? "" : "s"} failed in the last 7 days`,
      detail: "Check the delivery log for the address that failed.",
      to: "/app/admin",
      count: emailFailures,
    });
  }

  if (unmatchedReplies > 0) {
    alerts.push({
      id: "unmatched-replies",
      kind: "UNMATCHED_QUOTATION",
      tone: "error",
      title: `${unmatchedReplies} vendor repl${unmatchedReplies === 1 ? "y" : "ies"} awaiting validation`,
      detail: "Match the reply to its RFQ and crane, or dismiss it.",
      to: "/app/admin/replies",
      count: unmatchedReplies,
    });
  }

  return alerts;
}

// --- Daily digest ----------------------------------------------------------

/**
 * Emails the current admin/sales alert list to every active internal user with
 * one of those roles. Only sends when there is something to say.
 */
export async function sendAlertDigest(): Promise<{ sent: number; alerts: number }> {
  const settings = await getSettings();
  if (!settings.alertEmailsEnabled) return { sent: 0, alerts: 0 };

  const [sales, admin] = await Promise.all([salesAlerts(), adminAlerts()]);
  const alerts = [...sales, ...admin];
  if (alerts.length === 0) return { sent: 0, alerts: 0 };

  const recipients = await prisma.user.findMany({
    where: {
      role: { in: ["sales_user", "admin_user"] },
      isActive: true,
    },
    select: { email: true },
  });
  if (recipients.length === 0) return { sent: 0, alerts: alerts.length };

  const items = new Raw(
    alerts
      .slice(0, 50)
      .map(
        (alert) =>
          `<li><strong>${escapeHtml(alert.title)}</strong><br/>${escapeHtml(alert.detail)}</li>`,
      )
      .join(""),
  );

  let sent = 0;
  for (const recipient of recipients) {
    const result = await sendTemplate({
      to: recipient.email,
      template: "internal_alert_digest",
      vars: {
        alertCount: alerts.length,
        alertItems: items,
        portalUrl: portalUrl("/app"),
      },
      entity: "AlertDigest",
      entityId: new Date().toISOString().slice(0, 10),
    });
    if (result.sent) sent += 1;
  }

  return { sent, alerts: alerts.length };
}
