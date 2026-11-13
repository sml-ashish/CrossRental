import { api, getStoredToken } from "@/lib/api";

/**
 * P5 reports and CSV export. The server applies the caller's scope, so the
 * screen never has to decide whether a sales user may see a row.
 */

export type ReportView = "enquiry" | "line" | "vendor" | "category";

export const REPORT_VIEW_LABELS: Record<ReportView, string> = {
  enquiry: "Enquiries",
  line: "Lines",
  vendor: "Vendors",
  category: "Crane categories",
};

export interface Report {
  view: ReportView;
  generatedAt: string;
  filters: {
    from: string | null;
    to: string | null;
    region: string | null;
    craneCategory: string | null;
    ownerScoped: boolean;
  };
  summary: {
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
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | null>>;
  options: {
    regions: string[];
    craneCategories: Array<{ code: string; name: string }>;
  };
}

export interface ReportFilters {
  view: ReportView;
  from?: string;
  to?: string;
  craneCategory?: string;
}

function queryString(filters: ReportFilters): string {
  const params = new URLSearchParams({ view: filters.view });
  for (const key of ["from", "to", "craneCategory"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params.toString();
}

export async function loadReport(filters: ReportFilters): Promise<Report> {
  const res = await api<{ report: Report }>(`/reports?${queryString(filters)}`);
  return res.report;
}

/** Triggers the browser download without putting the bearer token in a URL. */
export async function downloadReportCsv(filters: ReportFilters): Promise<void> {
  const token = getStoredToken();
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
  const response = await fetch(`${baseUrl}/reports?${queryString(filters)}&format=csv`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error("The report could not be downloaded.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `crossrental-${filters.view}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
