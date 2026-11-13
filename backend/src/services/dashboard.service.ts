import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { getSettings } from "../utils/settings";
import type { AuthedRequest } from "../middleware/auth";
import { adminAlerts, salesAlerts, type AlertItem } from "./alert.service";

/**
 * P5 role dashboards (BPD 6.2).
 *
 * The sales dashboard is operational: counters that link straight into the
 * filtered list. The management dashboard is the read-only aggregate view with
 * filters; it never returns a customer name, address or budget. Both are
 * computed on demand from the same rows the rest of the portal writes.
 */

export interface SalesDashboard {
  counts: {
    newEnquiries: number;
    pendingSourcing: number;
    rfqSent: number;
    quotesReceived: number;
    finalised: number;
    closedEnquiries: number;
    overdueRfqs: number;
    expiringQuotations: number;
    needsAction: number;
  };
  linesAtEachStage: Record<string, number>;
  thresholds: {
    alertRfqSlaHours: number;
    alertQuotationExpiryDays: number;
  };
  alerts: AlertItem[];
}

const PENDING_STAGES = ["NEW", "AVAILABILITY_CHECK", "VENDOR_SHORTLISTED"] as const;
const SENT_STAGES = ["RFQ_SENT", "AWAITING_QUOTES"] as const;
const QUOTE_STAGES = ["QUOTES_RECEIVED", "UNDER_EVALUATION"] as const;
const FINAL_STAGES = ["VENDOR_FINALISED", "BOOKED", "FULFILLED_INTERNALLY"] as const;

export async function salesDashboard(): Promise<SalesDashboard> {
  const settings = await getSettings();
  const now = new Date();
  const expiryBefore = new Date(
    now.getTime() + settings.alertQuotationExpiryDays * 86_400_000,
  );

  const [
    newEnquiries,
    closedEnquiries,
    stageGroups,
    overdueRfqs,
    expiringQuotations,
    alerts,
  ] = await Promise.all([
    prisma.enquiry.count({ where: { overallStatus: "RECEIVED_PENDING_SOURCING" } }),
    prisma.enquiry.count({ where: { overallStatus: "CLOSED" } }),
    prisma.enquiryLineItem.groupBy({ by: ["trailStatus"], _count: { _all: true } }),
    prisma.rfqVendorRecipient.count({
      where: {
        responseStatus: "PENDING",
        rfq: { status: "SENT", submissionDeadline: { lt: now } },
      },
    }),
    prisma.quotation.count({
      where: {
        isLatest: true,
        status: { in: ["SUBMITTED", "UNDER_REVIEW", "SHORTLISTED"] },
        validityDate: { gte: now, lte: expiryBefore },
      },
    }),
    salesAlerts(),
  ]);

  const stage = new Map(
    stageGroups.map((row) => [String(row.trailStatus), row._count._all]),
  );
  const sum = (keys: readonly string[]) =>
    keys.reduce((total, key) => total + (stage.get(key) ?? 0), 0);

  const pendingSourcing = sum(PENDING_STAGES);
  const rfqSent = sum(SENT_STAGES);
  const quotesReceived = sum(QUOTE_STAGES);
  const finalised = sum(FINAL_STAGES);
  const silentLines = alerts.filter((alert) => alert.kind === "NO_VENDOR_RESPONSE").length;

  return {
    counts: {
      newEnquiries,
      pendingSourcing,
      rfqSent,
      quotesReceived,
      finalised,
      closedEnquiries,
      overdueRfqs,
      expiringQuotations,
      needsAction: overdueRfqs + expiringQuotations + silentLines,
    },
    linesAtEachStage: Object.fromEntries(stage),
    thresholds: {
      alertRfqSlaHours: settings.alertRfqSlaHours,
      alertQuotationExpiryDays: settings.alertQuotationExpiryDays,
    },
    alerts,
  };
}

// --- Management ------------------------------------------------------------

export interface ManagementFilters {
  from?: Date;
  to?: Date;
  region?: string;
  craneCategory?: string;
  /** Sales reports are scoped to the user who created the enquiry; admin/management see all. */
  ownerId?: string;
}

export interface ManagementDashboard {
  filters: {
    from: string | null;
    to: string | null;
    region: string | null;
    craneCategory: string | null;
  };
  metrics: {
    enquiriesProcessed: number;
    linesProcessed: number;
    vendorParticipationRate: number | null;
    rfqResponseRate: number | null;
    averageResponseTimeHours: number | null;
    rfqTurnaroundFirstHours: number | null;
    rfqTurnaroundLastHours: number | null;
    quotationConversionRate: number | null;
    averageMobilisationDistanceKm: number | null;
    averageTransportCost: number | null;
  };
  byRegion: Array<{ region: string | null; count: number }>;
  options: {
    regions: string[];
    craneCategories: Array<{ code: string; name: string }>;
  };
}

function percentage(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

export async function managementDashboard(
  filters: ManagementFilters,
): Promise<ManagementDashboard> {
  const where = {
    ...(filters.from || filters.to
      ? {
          enquiryDate: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
    ...(filters.region ? { region: filters.region } : {}),
    ...(filters.ownerId ? { createdById: filters.ownerId } : {}),
  };

  const lineWhere = {
    enquiry: { is: where },
    ...(filters.craneCategory ? { craneTypeCode: filters.craneCategory } : {}),
  };

  const recipientWhere = {
    rfq: {
      is: {
        enquiryLine: { is: lineWhere },
      },
    },
  };

  const [
    enquiriesProcessed,
    linesProcessed,
    totalRecipients,
    respondedRecipients,
    quotedRecipients,
    quotedRows,
    rfqs,
    selectedQuotations,
    quotationStatuses,
    byRegion,
    regions,
    craneCategories,
  ] = await Promise.all([
    prisma.enquiry.count({ where }),
    prisma.enquiryLineItem.count({ where: lineWhere }),
    prisma.rfqVendorRecipient.count({ where: recipientWhere }),
    prisma.rfqVendorRecipient.count({
      where: { ...recipientWhere, responseStatus: { in: ["QUOTED", "DECLINED"] } },
    }),
    prisma.rfqVendorRecipient.count({
      where: { ...recipientWhere, responseStatus: "QUOTED" },
    }),
    prisma.rfqVendorRecipient.findMany({
      where: {
        ...recipientWhere,
        responseStatus: "QUOTED",
        respondedAt: { not: null },
        rfq: {
          is: {
            sentAt: { not: null },
            enquiryLine: { is: lineWhere },
          },
        },
      },
      select: {
        rfqId: true,
        respondedAt: true,
        rfq: { select: { sentAt: true } },
      },
      take: 10_000,
    }),
    prisma.rfq.findMany({
      where: {
        sentAt: { not: null },
        enquiryLine: { is: lineWhere },
      },
      select: { id: true, quotations: { where: { isLatest: true }, select: { id: true } } },
      take: 10_000,
    }),
    prisma.quotation.findMany({
      where: {
        isLatest: true,
        status: "SELECTED",
        rfq: { is: { enquiryLine: { is: lineWhere } } },
      },
      select: {
        distanceToSiteKm: true,
        mobilisationCharges: true,
        demobilisationCharges: true,
      },
      take: 10_000,
    }),
    prisma.quotation.groupBy({
      by: ["status"],
      where: {
        isLatest: true,
        rfq: { is: { enquiryLine: { is: lineWhere } } },
      },
      _count: { _all: true },
    }),
    prisma.enquiry.groupBy({
      by: ["region"],
      where,
      _count: { _all: true },
      orderBy: { _count: { region: "desc" } },
    }),
    prisma.enquiry.findMany({
      where: { region: { not: null } },
      select: { region: true },
      distinct: ["region"],
      orderBy: { region: "asc" },
    }),
    prisma.craneType.findMany({
      select: { code: true, name: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  const responseHours = quotedRows
    .map((row) => {
      const sentAt = row.rfq.sentAt;
      if (!sentAt || !row.respondedAt) return null;
      return (row.respondedAt.getTime() - sentAt.getTime()) / 3_600_000;
    })
    .filter((value): value is number => value !== null && value >= 0);

  const turnaroundByRfq = new Map<string, number[]>();
  for (const row of quotedRows) {
    const sentAt = row.rfq.sentAt;
    if (!sentAt || !row.respondedAt) continue;
    const hours = (row.respondedAt.getTime() - sentAt.getTime()) / 3_600_000;
    if (hours < 0) continue;
    const list = turnaroundByRfq.get(row.rfqId) ?? [];
    list.push(hours);
    turnaroundByRfq.set(row.rfqId, list);
  }
  const firstResponses = [...turnaroundByRfq.values()].map((values) => Math.min(...values));
  const lastResponses = [...turnaroundByRfq.values()].map((values) => Math.max(...values));

  const submittedQuotations = quotationStatuses
    .filter((row) => row.status !== "WITHDRAWN")
    .reduce((total, row) => total + row._count._all, 0);
  const selectedQuotationCount = quotationStatuses
    .filter((row) => row.status === "SELECTED")
    .reduce((total, row) => total + row._count._all, 0);

  const distances = selectedQuotations
    .map((row) => (row.distanceToSiteKm === null ? null : Number(row.distanceToSiteKm)))
    .filter((value): value is number => value !== null);

  const transportCosts = selectedQuotations.map(
    (row) => Number(row.mobilisationCharges) + Number(row.demobilisationCharges),
  );

  const rfqsWithQuotes = rfqs.filter((rfq) => rfq.quotations.length > 0).length;

  return {
    filters: {
      from: filters.from ? filters.from.toISOString() : null,
      to: filters.to ? filters.to.toISOString() : null,
      region: filters.region ?? null,
      craneCategory: filters.craneCategory ?? null,
    },
    metrics: {
      enquiriesProcessed,
      linesProcessed,
      vendorParticipationRate: percentage(respondedRecipients, totalRecipients),
      rfqResponseRate: percentage(rfqsWithQuotes, rfqs.length),
      averageResponseTimeHours: mean(responseHours),
      rfqTurnaroundFirstHours: mean(firstResponses),
      rfqTurnaroundLastHours: mean(lastResponses),
      quotationConversionRate: percentage(selectedQuotationCount, submittedQuotations),
      averageMobilisationDistanceKm: mean(distances),
      averageTransportCost: mean(transportCosts),
    },
    byRegion: byRegion.map((row) => ({
      region: row.region,
      count: row._count._all,
    })),
    options: {
      regions: regions
        .map((row) => row.region)
        .filter((value): value is string => Boolean(value)),
      craneCategories,
    },
  };
}

/** The management view is read-only; a write must never reach it. */
export function assertManagementReadOnly(actor: AuthedRequest["user"]): void {
  if (actor.role === "management_viewer") {
    throw AppError.forbidden("Management Viewer accounts are read-only");
  }
}
