import { prisma } from "../lib/database";
import type { AuthedRequest } from "../middleware/auth";
import {
  managementDashboard,
  type ManagementDashboard,
  type ManagementFilters,
} from "./dashboard.service";

/**
 * P5 reports (BPD 5.15 / 6.23).
 *
 * One report is built from the same enquiry/line/recipient rows the rest of the
 * portal shows, with the caller's scope applied first:
 * - sales_user sees only enquiries they created (`createdById`),
 * - admin and management viewers see the whole platform.
 *
 * Aggregate metrics come from the management dashboard so the two screens can
 * never disagree about the same period. The detail table changes with `view`,
 * and the CSV export is the same rows the screen renders.
 */

export type ReportView = "enquiry" | "line" | "vendor" | "category";

export const REPORT_VIEWS: ReportView[] = ["enquiry", "line", "vendor", "category"];

export interface ReportResult {
  view: ReportView;
  generatedAt: string;
  filters: ManagementDashboard["filters"] & { ownerScoped: boolean };
  summary: ManagementDashboard["metrics"];
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | null>>;
  options: ManagementDashboard["options"];
}

export interface ReportScope extends ManagementFilters {
  view: ReportView;
  ownerId?: string;
}

function labelCrane(code: string | null, names: Map<string, string>): string {
  if (!code) return "Unspecified";
  return names.get(code) ?? code;
}

export async function buildReport(scope: ReportScope): Promise<ReportResult> {
  const dashboard = await managementDashboard(scope);

  const scopeWhere = {
    ...(scope.from || scope.to
      ? {
          enquiryDate: {
            ...(scope.from ? { gte: scope.from } : {}),
            ...(scope.to ? { lte: scope.to } : {}),
          },
        }
      : {}),
    ...(scope.ownerId ? { createdById: scope.ownerId } : {}),
  };

  const lineWhere = {
    enquiry: { is: scopeWhere },
    ...(scope.craneCategory ? { craneTypeCode: scope.craneCategory } : {}),
  };

  const [enquiries, recipients, selectedQuotations, craneTypes] = await Promise.all([
    prisma.enquiry.findMany({
      where: scopeWhere,
      select: {
        id: true,
        enquiryNo: true,
        enquiryDate: true,
        customerName: true,
        region: true,
        siteState: { select: { name: true, region: true } },
        lines: {
          select: {
            id: true,
            lineNo: true,
            trailStatus: true,
            craneTypeCode: true,
            capacityT: true,
            quantity: true,
          },
        },
      },
      orderBy: [{ enquiryDate: "desc" }, { enquiryNo: "desc" }],
      take: 20_000,
    }),
    prisma.rfqVendorRecipient.findMany({
      where: { rfq: { is: { enquiryLine: { is: lineWhere } } } },
      select: {
        vendorId: true,
        responseStatus: true,
        vendor: { select: { name: true } },
      },
      take: 50_000,
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
        rfq: { select: { enquiryLine: { select: { craneTypeCode: true } } } },
        vendor: { select: { id: true } },
      },
      take: 20_000,
    }),
    prisma.craneType.findMany({ select: { code: true, name: true } }),
  ]);

  const craneNames = new Map(craneTypes.map((type) => [type.code, type.name]));
  const lines = enquiries.flatMap((enquiry) =>
    enquiry.lines.map((line) => ({ enquiry, line })),
  );

  let rows: Array<Record<string, string | number | null>> = [];
  let columns: Array<{ key: string; label: string }> = [];

  switch (scope.view) {
    case "enquiry": {
      columns = [
        { key: "enquiryNo", label: "Enquiry" },
        { key: "enquiryDate", label: "Date" },
        { key: "customerName", label: "Customer" },
        { key: "region", label: "Region" },
        { key: "siteState", label: "State" },
        { key: "lines", label: "Lines" },
      ];
      rows = enquiries.map((enquiry) => ({
        enquiryNo: enquiry.enquiryNo,
        enquiryDate: enquiry.enquiryDate.toISOString().slice(0, 10),
        customerName: enquiry.customerName,
        region: enquiry.region ?? enquiry.siteState.region ?? "",
        siteState: enquiry.siteState.name,
        lines: enquiry.lines.length,
      }));
      break;
    }
    case "line": {
      columns = [
        { key: "enquiryNo", label: "Enquiry" },
        { key: "lineNo", label: "Line" },
        { key: "craneCategory", label: "Crane category" },
        { key: "capacityT", label: "Capacity (T)" },
        { key: "quantity", label: "Quantity" },
        { key: "trailStatus", label: "Stage" },
      ];
      rows = lines.map(({ enquiry, line }) => ({
        enquiryNo: enquiry.enquiryNo,
        lineNo: line.lineNo,
        craneCategory: labelCrane(line.craneTypeCode, craneNames),
        capacityT: line.capacityT === null ? "" : Number(line.capacityT),
        quantity: line.quantity,
        trailStatus: String(line.trailStatus),
      }));
      break;
    }
    case "vendor": {
      columns = [
        { key: "vendor", label: "Vendor" },
        { key: "recipients", label: "RFQs received" },
        { key: "quoted", label: "Quoted" },
        { key: "declined", label: "Declined" },
        { key: "pending", label: "Pending" },
        { key: "submitted", label: "Quotations submitted" },
        { key: "awarded", label: "Awarded" },
        { key: "winRate", label: "Win rate (%)" },
      ];

      const map = new Map<
        string,
        {
          vendor: string;
          recipients: number;
          quoted: number;
          declined: number;
          pending: number;
          submitted: number;
          awarded: number;
        }
      >();
      const ensure = (id: string, name: string | null) => {
        const existing = map.get(id);
        if (existing) return existing;
        const created = {
          vendor: name ?? "Vendor",
          recipients: 0,
          quoted: 0,
          declined: 0,
          pending: 0,
          submitted: 0,
          awarded: 0,
        };
        map.set(id, created);
        return created;
      };

      for (const row of recipients) {
        const entry = ensure(row.vendorId, row.vendor.name);
        entry.recipients += 1;
        if (row.responseStatus === "QUOTED") entry.quoted += 1;
        else if (row.responseStatus === "DECLINED") entry.declined += 1;
        else if (row.responseStatus === "PENDING") entry.pending += 1;
      }

      const latestQuotations = await prisma.quotation.findMany({
        where: { isLatest: true, rfq: { is: { enquiryLine: { is: lineWhere } } } },
        select: { vendorId: true, status: true, vendor: { select: { name: true } } },
        take: 50_000,
      });
      for (const quotation of latestQuotations) {
        const entry = ensure(quotation.vendorId, quotation.vendor.name);
        entry.submitted += 1;
        if (quotation.status === "SELECTED") entry.awarded += 1;
      }

      rows = [...map.values()]
        .map((entry) => ({
          ...entry,
          winRate:
            entry.submitted === 0
              ? null
              : Math.round((entry.awarded / entry.submitted) * 1000) / 10,
        }))
        .sort((a, b) => b.recipients - a.recipients);
      break;
    }
    case "category": {
      columns = [
        { key: "craneCategory", label: "Crane category" },
        { key: "lines", label: "Lines" },
        { key: "avgDistanceKm", label: "Avg mobilisation km" },
        { key: "avgTransportCost", label: "Avg transport cost (₹)" },
      ];

      const map = new Map<
        string,
        {
          craneCategory: string;
          lines: number;
          distances: number[];
          costs: number[];
        }
      >();
      for (const { line } of lines) {
        const key = labelCrane(line.craneTypeCode, craneNames);
        const entry =
          map.get(key) ??
          {
            craneCategory: key,
            lines: 0,
            distances: [],
            costs: [],
          };
        entry.lines += 1;
        map.set(key, entry);
      }
      for (const quotation of selectedQuotations) {
        const key = labelCrane(
          quotation.rfq.enquiryLine?.craneTypeCode ?? null,
          craneNames,
        );
        const entry = map.get(key);
        if (!entry) continue;
        if (quotation.distanceToSiteKm !== null) {
          entry.distances.push(Number(quotation.distanceToSiteKm));
        }
        entry.costs.push(
          Number(quotation.mobilisationCharges) + Number(quotation.demobilisationCharges),
        );
      }

      const average = (values: number[]) =>
        values.length === 0
          ? null
          : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) /
            10;

      rows = [...map.values()]
        .map((entry) => ({
          craneCategory: entry.craneCategory,
          lines: entry.lines,
          avgDistanceKm: average(entry.distances),
          avgTransportCost: average(entry.costs),
        }))
        .sort((a, b) => b.lines - a.lines);
      break;
    }
  }

  return {
    view: scope.view,
    generatedAt: new Date().toISOString(),
    filters: { ...dashboard.filters, ownerScoped: Boolean(scope.ownerId) },
    summary: dashboard.metrics,
    columns,
    rows,
    options: dashboard.options,
  };
}

/** CSV quoting: double quotes are doubled and every cell is wrapped. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function reportToCsv(report: ReportResult): string {
  const header = report.columns.map((column) => csvCell(column.label)).join(",");
  const body = report.rows.map((row) =>
    report.columns.map((column) => csvCell(row[column.key] ?? null)).join(","),
  );
  return [header, ...body].join("\r\n");
}

/** The caller's report scope: sales see what they created; the rest see all. */
export function scopeFor(actor: AuthedRequest["user"]): { ownerId?: string } {
  return actor.role === "sales_user" ? { ownerId: actor.id } : {};
}
