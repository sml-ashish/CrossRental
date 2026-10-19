import { api } from "@/lib/api";
import type { Crane } from "@/lib/fleet";
import type { VendorParticipation } from "@/lib/recommendations";

/**
 * Client for the vendor detail discovery view (P4, BPD 6.10).
 *
 * Additive to the approval detail (which carries the registration form and the
 * admin-only bank block): this is the fleet, the categories the vendor covers,
 * and the participation numbers. Bank details are not in this payload at all.
 */

export interface VendorInsightContact {
  id: string;
  name: string;
  mobile: string;
  telephone: string | null;
  email: string | null;
  isPrimary: boolean;
  receivesRfqs: boolean;
}

export interface VendorInsights {
  vendor: {
    id: string;
    name: string | null;
    sapVendorCode: string | null;
    natureOfCompany: string | null;
    city: string | null;
    district: string | null;
    stateCode: string | null;
    stateName: string | null;
    companySize: string | null;
    totalFleetSize: number;
    onboardingStatus: string;
    approvedAt: string | null;
    suspendedAt: string | null;
    communicationNotes: string | null;
    operatingRegions: string[];
  };
  contacts: VendorInsightContact[];
  categories: Array<{ code: string; name: string }>;
  fleet: Crane[];
  participation: VendorParticipation;
  rfqsReceived: number;
  quotationsSubmitted: number;
}

export function getVendorInsights(vendorId: string): Promise<{ profile: VendorInsights }> {
  return api(`/vendors/${vendorId}/profile`);
}
