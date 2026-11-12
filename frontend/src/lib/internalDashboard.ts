import { api } from "@/lib/api";

/**
 * P5 internal dashboards: the CR team's working list and the read-only
 * management aggregate. Both are computed server-side; nothing here filters by
 * role, because the API already scopes the data.
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
  to: string;
  count?: number;
}

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
  thresholds: { alertRfqSlaHours: number; alertQuotationExpiryDays: number };
  alerts: AlertItem[];
}

export async function loadSalesDashboard(): Promise<SalesDashboard> {
  const res = await api<{ dashboard: SalesDashboard }>("/dashboard/sales");
  return res.dashboard;
}

export interface ManagementFilters {
  from?: string;
  to?: string;
  region?: string;
  craneCategory?: string;
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
    fulfilledInternally: number;
    fulfilledByVendors: number;
    internalSourcingRatio: number | null;
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

function queryString(filters: ManagementFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function loadManagementDashboard(
  filters: ManagementFilters,
): Promise<ManagementDashboard> {
  const res = await api<{ dashboard: ManagementDashboard }>(
    `/management/dashboard${queryString(filters)}`,
  );
  return res.dashboard;
}
