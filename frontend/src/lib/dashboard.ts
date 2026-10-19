import { api } from "@/lib/api";

/**
 * Client for the vendor dashboard (brief 7.5, M7).
 *
 * One GET, one read: counters and the rows they lead to, computed and scoped
 * server-side by the token's vendor id. The dashboard decides nothing itself —
 * every number and list is the backend's answer, and the screen only renders
 * it and links into the screens behind the counters (My Fleet, the RFQ inbox).
 */

export type CraneStatusValue =
  | "AVAILABLE"
  | "BOOKED"
  | "HIRED"
  | "MAINTENANCE"
  | "RETIRED"
  | string;

export interface DashboardDueCrane {
  craneId: string;
  label: string;
  currentStatus: string;
  daysSinceUpdate: number;
  locationUnverified: boolean;
  availableFromLapsed: boolean;
  statusUpdatedAt: string;
}

export interface DashboardBookingCrane {
  craneId: string;
  label: string;
  currentStatus: string;
  statusUpdatedAt: string;
  startDate: string | null;
  endDate: string | null;
}

export interface DashboardOnBehalfCrane {
  craneId: string;
  label: string;
  currentStatus: string;
  statusUpdatedAt: string;
}

export interface DashboardAwaitingRfq {
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
}

export interface VendorDashboard {
  fleet: {
    totalCranes: number;
    byStatus: Record<string, number>;
    dueForUpdate: DashboardDueCrane[];
    bookings: {
      count: number;
      cranes: DashboardBookingCrane[];
    };
    updatedOnBehalf: {
      count: number;
      cranes: DashboardOnBehalfCrane[];
    };
  };
  rfqs: {
    openCount: number;
    awaitingResponseCount: number;
    awardedCount: number;
    notAwardedCount: number;
    awaitingResponse: DashboardAwaitingRfq[];
  };
  quotations: {
    submittedCount: number;
    awardedCount: number;
    notAwardedCount: number;
  };
}

export function getVendorDashboard() {
  return api<VendorDashboard>("/vendor/dashboard");
}
