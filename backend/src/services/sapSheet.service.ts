import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { decryptField } from "../utils/crypto";

/**
 * SAP vendor creation sheet (brief 5.1, 7.3, phase D3).
 *
 * SAP is parked (brief §2), so an admin creates the vendor by hand. This turns a
 * vendor's approved-and-submitted record into the same field order as the
 * SAP-aligned form, ready to be printed or dropped into a spreadsheet.
 *
 * It is admin-only, and unlike every other read of a vendor it decrypts the bank
 * columns — which is why the route that calls it is behind `vendor:view_bank`
 * and why the export is deliberately not logged (brief D3: "the export is not
 * logged").
 */

export interface SapSheetRow {
  label: string;
  value: string;
}

export interface SapSheetSection {
  title: string;
  rows: SapSheetRow[];
}

export interface SapSheet {
  vendorId: string;
  vendorName: string;
  sapVendorCode: string | null;
  generatedAt: string;
  sections: SapSheetSection[];
}

type RawVendor = NonNullable<Awaited<ReturnType<typeof loadVendor>>>;

async function loadVendor(vendorId: string) {
  return prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      id: true,
      name: true,
      sapVendorCode: true,
      natureOfCompany: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      district: true,
      stateCode: true,
      addressState: { select: { name: true } },
      pincode: true,
      telephone: true,
      fax: true,
      email: true,
      weeklyOffDays: true,
      companySize: true,
      pan: true,
      tan: true,
      gstRegistered: true,
      gstRegistrationType: true,
      gstn: true,
      gstr1FilingFrequency: true,
      cin: true,
      govtRegistrationType: true,
      govtRegistrationNo: true,
      msmeRegistered: true,
      msmeCategory: true,
      msmeRegNo: true,
      msmeExemptionDate: true,
      tdsLowerDeduction: true,
      tdsCertificateNo: true,
      tdsSection: true,
      tdsRatePercent: true,
      tdsValidFrom: true,
      tdsValidTo: true,
      bankAccountHolderName: true,
      bankName: true,
      bankBranch: true,
      bankAccountType: true,
      bankAccountNoEnc: true,
      bankIfscEnc: true,
      bankMicr: true,
      bankIban: true,
      bankSwift: true,
      codeOfConductAccepted: true,
      declarationName: true,
      declarationDesignation: true,
      declarationDate: true,
      fleetSummary: true,
      communicationNotes: true,
      onboardingStatus: true,
      adminRemarks: true,
      approvedAt: true,
      facilityStatus: true,
      manpowerStatus: true,
      improvementRequirement: true,
      improvementPeriod: true,
      vendorOrigin: true,
      vendorType: true,
      purchaseOrg: true,
      paymentTerm: true,
      withholdingTaxType: true,
      legalForm: true,
      totalFleetSize: true,
      createdAt: true,
      updatedAt: true,
      operatingRegions: { select: { stateCode: true } },
      approvedBy: { select: { fullName: true, email: true } },
      contacts: {
        select: {
          name: true,
          mobile: true,
          telephone: true,
          email: true,
          isPrimary: true,
          receivesRfqs: true,
        },
        orderBy: { isPrimary: "desc" },
      },
      documents: { select: { docType: true } },
    },
  });
}

/** A blank cell rather than the word "null" — a printed form has empty fields. */
function text(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function yesNo(value: boolean | null | undefined): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "";
}

function day(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

/** ENUM_VALUE → "Enum value", so a printed sheet reads like the form did. */
function label(value: string | null | undefined): string {
  return value ? value.replace(/_/g, " ").toLowerCase() : "";
}

function buildSections(v: RawVendor): SapSheetSection[] {
  return [
    {
      title: "Vendor identification",
      rows: [
        { label: "SAP vendor code", value: text(v.sapVendorCode) },
        { label: "Vendor name", value: text(v.name) },
        { label: "Nature of company", value: label(v.natureOfCompany) },
      ],
    },
    {
      title: "Address",
      rows: [
        { label: "Address line 1", value: text(v.addressLine1) },
        { label: "Address line 2", value: text(v.addressLine2) },
        { label: "City", value: text(v.city) },
        { label: "District", value: text(v.district) },
        { label: "State", value: text(v.addressState?.name ?? v.stateCode) },
        { label: "PIN code", value: text(v.pincode) },
      ],
    },
    {
      title: "Contact and operations",
      rows: [
        { label: "Telephone", value: text(v.telephone) },
        { label: "Fax", value: text(v.fax) },
        { label: "Email", value: text(v.email) },
        { label: "Weekly off days", value: text(v.weeklyOffDays) },
        {
          label: "Operating regions",
          value: v.operatingRegions.map((r) => r.stateCode).join(", "),
        },
        { label: "Company size", value: label(v.companySize) },
      ],
    },
    {
      title: "Tax and registration",
      rows: [
        { label: "PAN", value: text(v.pan) },
        { label: "TAN", value: text(v.tan) },
        { label: "GST registered", value: yesNo(v.gstRegistered) },
        { label: "GST registration type", value: label(v.gstRegistrationType) },
        { label: "GSTIN", value: text(v.gstn) },
        { label: "GSTR-1 filing frequency", value: label(v.gstr1FilingFrequency) },
        { label: "CIN", value: text(v.cin) },
        {
          label: "Government registration",
          value: [v.govtRegistrationType, v.govtRegistrationNo]
            .filter((x) => x)
            .join(" "),
        },
        { label: "MSME registered", value: yesNo(v.msmeRegistered) },
        { label: "MSME category", value: label(v.msmeCategory) },
        { label: "MSME registration no.", value: text(v.msmeRegNo) },
        { label: "MSME exemption date", value: day(v.msmeExemptionDate) },
        { label: "Lower TDS deduction", value: yesNo(v.tdsLowerDeduction) },
        { label: "TDS certificate no.", value: text(v.tdsCertificateNo) },
        { label: "TDS section", value: text(v.tdsSection) },
        {
          label: "TDS rate",
          value: v.tdsRatePercent === null || v.tdsRatePercent === undefined ? "" : `${v.tdsRatePercent}%`,
        },
        { label: "TDS valid from", value: day(v.tdsValidFrom) },
        { label: "TDS valid to", value: day(v.tdsValidTo) },
      ],
    },
    {
      title: "Bank details",
      rows: [
        { label: "Account holder name", value: text(v.bankAccountHolderName) },
        { label: "Bank name", value: text(v.bankName) },
        { label: "Branch", value: text(v.bankBranch) },
        { label: "Account type", value: label(v.bankAccountType) },
        {
          label: "Account number",
          value: v.bankAccountNoEnc ? decryptField(v.bankAccountNoEnc) : "",
        },
        { label: "IFSC", value: v.bankIfscEnc ? decryptField(v.bankIfscEnc) : "" },
        { label: "MICR", value: text(v.bankMicr) },
        { label: "IBAN", value: text(v.bankIban) },
        { label: "SWIFT", value: text(v.bankSwift) },
      ],
    },
    {
      title: "Office use (SML)",
      rows: [
        { label: "Facilities", value: label(v.facilityStatus) },
        { label: "Manpower", value: label(v.manpowerStatus) },
        { label: "Improvement requirement", value: text(v.improvementRequirement) },
        { label: "Improvement period", value: text(v.improvementPeriod) },
        // SAP master-list values (phase D3); blank until the owner's lists and
        // picks exist.
        { label: "Vendor origin", value: text(v.vendorOrigin) },
        { label: "Vendor type", value: text(v.vendorType) },
        { label: "Purchase organisation", value: text(v.purchaseOrg) },
        { label: "Payment term", value: text(v.paymentTerm) },
        { label: "Withholding tax type", value: text(v.withholdingTaxType) },
        { label: "Legal form", value: text(v.legalForm) },
        { label: "Admin remarks", value: text(v.adminRemarks) },
      ],
    },
    {
      title: "Declaration",
      rows: [
        { label: "Code of conduct accepted", value: yesNo(v.codeOfConductAccepted) },
        { label: "Declared by", value: text(v.declarationName) },
        { label: "Designation", value: text(v.declarationDesignation) },
        { label: "Declaration date", value: day(v.declarationDate) },
      ],
    },
    {
      title: "Fleet",
      rows: [
        { label: "Fleet summary", value: text(v.fleetSummary) },
        {
          label: "Total fleet size",
          value: v.totalFleetSize === null || v.totalFleetSize === undefined ? "" : String(v.totalFleetSize),
        },
      ],
    },
    {
      title: "Contacts",
      rows: v.contacts.flatMap((c, index) => [
        {
          label: `Contact ${index + 1} name`,
          value: `${text(c.name)}${c.isPrimary ? " (primary)" : ""}`,
        },
        { label: `Contact ${index + 1} mobile`, value: text(c.mobile) },
        { label: `Contact ${index + 1} telephone`, value: text(c.telephone) },
        { label: `Contact ${index + 1} email`, value: text(c.email) },
        {
          label: `Contact ${index + 1} receives RFQs`,
          value: yesNo(c.receivesRfqs),
        },
      ]),
    },
    {
      title: "Record",
      rows: [
        { label: "Onboarding status", value: label(v.onboardingStatus) },
        { label: "Documents uploaded", value: String(v.documents.length) },
        { label: "Approved by", value: text(v.approvedBy?.fullName ?? v.approvedBy?.email) },
        { label: "Approved at", value: day(v.approvedAt) },
        { label: "Created at", value: day(v.createdAt) },
        { label: "Updated at", value: day(v.updatedAt) },
      ],
    },
  ];
}

export async function buildSapSheet(vendorId: string): Promise<SapSheet> {
  const vendor = await loadVendor(vendorId);
  if (!vendor) throw AppError.notFound("Vendor not found");

  return {
    vendorId: vendor.id,
    vendorName: vendor.name ?? "",
    sapVendorCode: vendor.sapVendorCode ?? null,
    generatedAt: new Date().toISOString(),
    sections: buildSections(vendor),
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * SpreadsheetML 2003 (`.xls`) rather than a `.xlsx` zip.
 *
 * Excel opens it natively and it needs no dependency for what is a
 * label/value sheet — pulling in a full spreadsheet library to write two
 * columns would be more code to keep current than this.
 */
export async function renderSapSheetXls(vendorId: string): Promise<{
  fileName: string;
  body: string;
}> {
  const sheet = await buildSapSheet(vendorId);

  const rows: string[] = [];
  const cell = (value: string, style?: string) =>
    `<Cell${style ? ` ss:StyleID="${style}"` : ""}><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;

  for (const section of sheet.sections) {
    rows.push(`<Row>${cell(section.title, "section")}</Row>`);
    for (const row of section.rows) {
      rows.push(`<Row>${cell(row.label, "label")}${cell(row.value)}</Row>`);
    }
    rows.push("<Row></Row>");
  }

  const body = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="section"><Font ss:Bold="1"/><Interior ss:Color="#D9E1F2" ss:Pattern="Solid"/></Style>
  <Style ss:ID="label"><Font ss:Bold="1"/></Style>
 </Styles>
 <Worksheet ss:Name="SAP vendor sheet">
  <Table>
   <Column ss:Width="240"/>
   <Column ss:Width="360"/>
   ${rows.join("\n   ")}
  </Table>
 </Worksheet>
</Workbook>`;

  const safeName = (sheet.vendorName || "vendor").replace(/[^A-Za-z0-9._-]+/g, "_");
  return { fileName: `SAP-vendor-${safeName}.xls`, body };
}
