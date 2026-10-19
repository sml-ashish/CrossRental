import { api } from "@/lib/api";

/**
 * Admin-only configuration (brief 6.4, phase D3).
 *
 * `rateDayBasis` decides how a quoted month converts to days for every
 * quotation total. The master lists back the SAP office-use block: they start
 * empty and an admin fills them in, so the owner's SAP "Legal Form Logic"
 * values can be entered without a code change.
 */

export type RateDayBasis = "CALENDAR_DAYS" | "WORKING_DAYS_PER_MONTH";

export type QuoteRankRule = "TOTAL_ESTIMATED_COST";

export const MASTER_LIST_KEYS = [
  "VENDOR_ORIGIN",
  "VENDOR_TYPE",
  "PURCHASE_ORG",
  "PAYMENT_TERM",
  "WITHHOLDING_TAX_TYPE",
  "LEGAL_FORM",
  "BUSINESS_VERTICAL",
  "QUOTATION_MARK_REASON_CODES",
  "AWARD_REASON_CODES",
] as const;

export type MasterListKey = (typeof MASTER_LIST_KEYS)[number];

export const MASTER_LIST_LABELS: Record<MasterListKey, string> = {
  VENDOR_ORIGIN: "Vendor origin",
  VENDOR_TYPE: "Vendor type",
  PURCHASE_ORG: "Purchase organisation",
  PAYMENT_TERM: "Payment term",
  WITHHOLDING_TAX_TYPE: "Withholding tax type",
  LEGAL_FORM: "Legal form",
  BUSINESS_VERTICAL: "Business vertical",
  QUOTATION_MARK_REASON_CODES: "Quote mark reason codes",
  AWARD_REASON_CODES: "Award reason codes",
};

/**
 * The SAP office-use lists feed the vendor creation sheet's office-use block.
 * Business vertical and the P3 quote/award reason codes are separate: they are
 * chosen on an enquiry or a comparison, not on a vendor.
 */
export const SAP_MASTER_LIST_KEYS = [
  "VENDOR_ORIGIN",
  "VENDOR_TYPE",
  "PURCHASE_ORG",
  "PAYMENT_TERM",
  "WITHHOLDING_TAX_TYPE",
  "LEGAL_FORM",
] as const satisfies readonly MasterListKey[];

export type SapMasterListKey = (typeof SAP_MASTER_LIST_KEYS)[number];

/** P3: the reason-code lists used by the comparison and award screens. */
export const QUOTE_MASTER_LIST_KEYS: readonly MasterListKey[] = [
  "QUOTATION_MARK_REASON_CODES",
  "AWARD_REASON_CODES",
];

export type MasterLists = Record<MasterListKey, string[]>;

export interface PortalSettings {
  rateDayBasis: RateDayBasis;
  quoteRankRule: QuoteRankRule;
}

export async function loadSettings(): Promise<{ settings: PortalSettings }> {
  return api<{ settings: PortalSettings }>("/settings");
}

export async function updateSettings(rateDayBasis: RateDayBasis): Promise<{ settings: PortalSettings }> {
  return api<{ settings: PortalSettings }>("/settings", {
    method: "PATCH",
    body: { rateDayBasis },
  });
}

export async function loadMasterLists(): Promise<MasterLists> {
  const res = await api<{ masterLists: MasterLists }>("/settings/master-lists");
  return res.masterLists;
}

export async function updateMasterList(
  name: MasterListKey,
  values: string[],
): Promise<{ name: MasterListKey; values: string[] }> {
  return api<{ name: MasterListKey; values: string[] }>(`/settings/master-lists/${name}`, {
    method: "PUT",
    body: { values },
  });
}
