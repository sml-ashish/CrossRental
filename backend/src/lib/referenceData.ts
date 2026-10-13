/**
 * Reference data seeded into the database.
 *
 * State names come from the SAP state master in the "Std Fields" sheet of
 * docs/vendorregistrationform.xlsx, with the current union territories added
 * so the list is usable today. That sheet's adjacent code column turned out to
 * be the SAP *country* list rather than state codes — the two blocks are
 * interleaved in the sheet — so no state codes could be read from it. The
 * codes below are ISO 3166-2:IN subdivision codes instead, which are stable
 * and unambiguous. If SML's SAP state codes need to match exactly, replace
 * this table; nothing else depends on the specific code values.
 *
 * Crane types start from the two that appear on the paper equipment list
 * ("Equipment list format to be captured from Vendor.xlsx") and are
 * admin-editable, since the paper form only ever shows "Crawler Crane" and
 * "Tyre Mounted Crane" as examples.
 */

export interface StateSeed {
  code: string;
  name: string;
  isUnionTerritory: boolean;
}

export const STATES: StateSeed[] = [
  { code: "AP", name: "Andhra Pradesh", isUnionTerritory: false },
  { code: "AR", name: "Arunachal Pradesh", isUnionTerritory: false },
  { code: "AS", name: "Assam", isUnionTerritory: false },
  { code: "BR", name: "Bihar", isUnionTerritory: false },
  { code: "CG", name: "Chhattisgarh", isUnionTerritory: false },
  { code: "GA", name: "Goa", isUnionTerritory: false },
  { code: "GJ", name: "Gujarat", isUnionTerritory: false },
  { code: "HR", name: "Haryana", isUnionTerritory: false },
  { code: "HP", name: "Himachal Pradesh", isUnionTerritory: false },
  { code: "JH", name: "Jharkhand", isUnionTerritory: false },
  { code: "KA", name: "Karnataka", isUnionTerritory: false },
  { code: "KL", name: "Kerala", isUnionTerritory: false },
  { code: "LA", name: "Ladakh", isUnionTerritory: false },
  { code: "LD", name: "Lakshadweep", isUnionTerritory: false },
  { code: "MP", name: "Madhya Pradesh", isUnionTerritory: false },
  { code: "MH", name: "Maharashtra", isUnionTerritory: false },
  { code: "MN", name: "Manipur", isUnionTerritory: false },
  { code: "ML", name: "Meghalaya", isUnionTerritory: false },
  { code: "MZ", name: "Mizoram", isUnionTerritory: false },
  { code: "NL", name: "Nagaland", isUnionTerritory: false },
  { code: "OD", name: "Odisha", isUnionTerritory: false },
  { code: "PY", name: "Puducherry", isUnionTerritory: true },
  { code: "PB", name: "Punjab", isUnionTerritory: false },
  { code: "RJ", name: "Rajasthan", isUnionTerritory: false },
  { code: "SK", name: "Sikkim", isUnionTerritory: false },
  { code: "TN", name: "Tamil Nadu", isUnionTerritory: false },
  { code: "TG", name: "Telangana", isUnionTerritory: false },
  { code: "TR", name: "Tripura", isUnionTerritory: false },
  { code: "UP", name: "Uttar Pradesh", isUnionTerritory: false },
  { code: "UT", name: "Uttarakhand", isUnionTerritory: false },
  { code: "WB", name: "West Bengal", isUnionTerritory: false },
  { code: "JK", name: "Jammu and Kashmir", isUnionTerritory: true },
  { code: "AN", name: "Andaman and Nicobar Islands", isUnionTerritory: true },
  { code: "CH", name: "Chandigarh", isUnionTerritory: true },
  { code: "DH", name: "Dadra and Nagar Haveli and Daman and Diu", isUnionTerritory: true },
  { code: "DL", name: "Delhi", isUnionTerritory: true },
];

export interface CraneTypeSeed {
  code: string;
  name: string;
  sortOrder: number;
}

export const CRANE_TYPES: CraneTypeSeed[] = [
  { code: "CRAWLER", name: "Crawler Crane", sortOrder: 10 },
  { code: "TYRE_MOUNTED", name: "Tyre Mounted Crane", sortOrder: 20 },
  { code: "ALL_TERRAIN", name: "All Terrain Crane", sortOrder: 30 },
  { code: "ROUGH_TERRAIN", name: "Rough Terrain Crane", sortOrder: 40 },
  { code: "TRUCK_MOUNTED", name: "Truck Mounted Crane", sortOrder: 50 },
  { code: "TRACTOR_MOUNTED", name: "Tractor Mounted Crane", sortOrder: 60 },
  { code: "MINI_CRAWLER", name: "Mini Crawler Crane", sortOrder: 70 },
  { code: "TOWER", name: "Tower Crane", sortOrder: 80 },
];

/**
 * The remaining rows of the 31-row "Cross Rental Enquiry Template" in
 * docs/CR Enquiry from SP.xlsx that are not first-class columns on the RFQ.
 * They are offered as template fields and stored in `commercialTermsExtra`.
 */
export const EXTRA_COMMERCIAL_TERMS: { key: string; label: string; defaultValue: string }[] = [
  { key: "rentalPerMonth", label: "Rental per month", defaultValue: "" },
  { key: "demobilisationPrice", label: "Demobilisation price", defaultValue: "" },
  { key: "applicationOrLoad", label: "Application or load to be handled", defaultValue: "" },
  { key: "tentativeDeploymentDate", label: "Tentative deployment date", defaultValue: "" },
  { key: "workingDaysPerMonth", label: "Working days in a month", defaultValue: "" },
  { key: "supportCraneScope", label: "Support crane scope", defaultValue: "" },
  { key: "steelMatsScope", label: "Steel mats & ground preparation scope", defaultValue: "" },
  { key: "ehsHrComplianceScope", label: "EHS / HR compliance scope", defaultValue: "" },
  { key: "extensionClause", label: "Extension clause", defaultValue: "" },
  { key: "insuranceCoverage", label: "Insurance coverage", defaultValue: "" },
  { key: "additionalManpower", label: "Additional manpower required", defaultValue: "" },
  { key: "intraSiteMovementScope", label: "Intra-site movement of cranes", defaultValue: "" },
  { key: "preReleaseTerms", label: "Pre-release of cranes terms", defaultValue: "" },
  { key: "ppeRequirement", label: "PPE requirement", defaultValue: "" },
  { key: "rowScope", label: "ROW / right of way scope", defaultValue: "" },
  { key: "additionalRemarks", label: "Additional remarks", defaultValue: "" },
];

/**
 * Commercial-term defaults taken from the real enquiry documents
 * (docs/Enquiry Mail to Vendor.docx and the enquiry template sheet), used to
 * pre-fill a new RFQ. Still editable per RFQ.
 */
export const COMMERCIAL_TERM_DEFAULTS = {
  otCharges: "Pro-rata",
  breakdownTerms: "Pro-rata",
  dieselScope: "SML scope",
  workingHoursShift: "12 hours per day, single shift including 1 hour lunch",
  craneAgeCriteriaYears: 10,
  accommodationConveyance: "Vendor scope",
  paymentTerms:
    "One month's rental advance and mobilisation charges payable on successful commissioning; balance payment within 30 days from invoice submission",
  notes: "",
} as const;

/**
 * SML contacts named in docs/Enquiry Mail to Vendor.docx. These are defaults on
 * a new RFQ and can be overridden per RFQ.
 *
 * The source document gives names and mobile numbers only, so `email` is left
 * blank rather than guessed — the sales user fills it in, or it is corrected
 * here once the real addresses are known.
 */
export const DEFAULT_SML_CONTACTS = [
  {
    name: "Prosen Mondal",
    mobile: "+91 7391000242",
    email: "",
  },
  {
    name: "Manish Pandey",
    mobile: "+91 9350742527",
    email: "",
  },
] as const;