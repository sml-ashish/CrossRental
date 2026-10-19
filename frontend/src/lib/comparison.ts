import { api } from "@/lib/api";

export type QuoteMarkStatus = "UNDER_REVIEW" | "SHORTLISTED" | "REJECTED";

export interface MarkQuotationInput {
  status: QuoteMarkStatus;
  reasonCode?: string | null;
  reasonText?: string | null;
}

export interface MarkQuotationResult {
  result: {
    mark: {
      quotationId: string;
      version: number;
      status: QuoteMarkStatus;
      reasonCode: string | null;
      reasonText: string | null;
      markedAt: string;
    };
  };
}

export interface ComparisonQuotation {
  quotationId: string;
  version: number;
  rfqId: string;
  rfqNumber: string;
  vendorId: string;
  vendorName: string | null;
  crane: {
    craneId: string;
    label: string;
    craneTypeName: string;
    capacityT: number | null;
    make: string;
    model: string;
    serialRegistrationNo: string;
    ownershipType: string;
  };
  rentalRate: number;
  rateBasis: string;
  taxBasis: string;
  mobilisationCharges: number;
  demobilisationCharges: number;
  totalEstimatedCost: number;
  distanceToSiteKm: number | null;
  distanceMethod: string | null;
  craneAgeYears: number | null;
  availabilityConfirmed: boolean;
  availableFrom: string | null;
  validityDate: string;
  responseTimeHours: number | null;
  remarks: string | null;
  acceptsCommercialTerms: boolean;
  deviationText: string | null;
  warnings: Array<{ code: string; message: string }>;
  recommendationRank: number | null;
  status: string;
  markReasonCode: string | null;
  markReasonText: string | null;
  markedAt: string | null;
  submittedAt: string;
}

export interface ComparisonResult {
  lineId: string;
  enquiryId: string;
  enquiryNo: string;
  siteLocation: string;
  siteStateName: string | null;
  lineNo: number;
  requirement: {
    craneTypeCode: string | null;
    craneTypeName: string | null;
    capacityT: number | null;
    capacityRule: string;
    quantity: number;
    requiredStartDate: string | null;
    startDateTbc: boolean;
    durationValue: number | null;
    durationUnit: string | null;
    craneAgeCriteriaYears: number | null;
  };
  rentalBudget: string | null;
  rentalBudgetValue: number | null;
  poSapReference: string | null;
  rankRule: "TOTAL_ESTIMATED_COST";
  quantity: number;
  awardedCount: number;
  fullyAwarded: boolean;
  quotations: ComparisonQuotation[];
}

export function getLineComparison(lineId: string): Promise<{ comparison: ComparisonResult }> {
  return api(`/enquiries/lines/${lineId}/comparison`);
}

export function markQuotation(
  rfqId: string,
  quotationId: string,
  input: MarkQuotationInput,
): Promise<MarkQuotationResult> {
  return api(`/rfqs/${rfqId}/quotations/${quotationId}/mark`, {
    method: "POST",
    body: input,
  });
}
