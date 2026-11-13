import ExcelJS from "exceljs";
import { AppError } from "../middleware/errorHandler";
import { cellText } from "./craneSheet";

/**
 * Reading the bulk-enquiry upload workbook.
 *
 * The sheet is wide on purpose: it carries all 31 particulars of the Cross
 * Rental Enquiry Template (`docs/CR Enquiry from SP.xlsx`) plus the header and
 * the mandatory line fields, so an enquiry uploaded from a spreadsheet needs no
 * second pass to be sourceable.
 *
 * Two things are specific to this sheet:
 *
 * - **`Enquiry ref` groups lines.** Rows that share a ref become one enquiry
 *   with several lines; a blank ref makes each row its own enquiry. The grouping
 *   is explicit, never inferred from matching customer/site text — a sales user
 *   who wants two enquiries for one customer leaves the ref blank.
 * - **Dates are read day-first.** The CR team writes `01/10/2026` for 1 October.
 *   `new Date("01/10/2026")` would read 10 January, so a `dd/mm/yyyy` cell is
 *   parsed explicitly rather than handed to the default parser.
 *
 * As with the crane sheet, two limits are enforced here rather than downstream:
 * the file must be a readable `.xlsx`, and it may carry at most
 * {@link MAX_ENQUIRY_ROWS} data rows.
 */

export const MAX_ENQUIRY_ROWS = 250;
export const ENQUIRY_SHEET_NAME = "Enquiries";

export interface EnquirySheetColumn {
  key: string;
  label: string;
  /** Normalised header aliases; the label is added automatically. */
  aliases: string[];
  required: boolean;
  help: string;
  /** Internal-only columns never copied into an RFQ — the template says so. */
  internal?: boolean;
}

export const ENQUIRY_SHEET_COLUMNS: EnquirySheetColumn[] = [
  // --- grouping ------------------------------------------------------------
  {
    key: "enquiryRef",
    label: "Enquiry ref",
    aliases: ["enquiryref", "ref", "reference", "group", "enquirygroup"],
    required: false,
    help: "Any label of your own. Rows with the same ref become ONE enquiry with several lines. Leave blank and every row becomes its own enquiry.",
  },
  // --- header --------------------------------------------------------------
  {
    key: "enquiryDate",
    label: "Enquiry date",
    aliases: ["enquirydate", "date", "dateofenquiry", "receivedon"],
    required: false,
    help: "When the enquiry arrived. Defaults to today. Real Excel dates, 2026-10-01 and 01/10/2026 (day first) are all accepted.",
  },
  {
    key: "customerName",
    label: "Customer name",
    aliases: ["customername", "customer", "clientname", "client"],
    required: true,
    help: "Internal only — never shown to a vendor or copied into an RFQ.",
  },
  {
    key: "customerAddress",
    label: "Customer address",
    aliases: ["customeraddress", "clientaddress", "address"],
    required: true,
    help: "Internal only — never shown to a vendor or copied into an RFQ.",
  },
  {
    key: "siteLocation",
    label: "Site location",
    aliases: ["sitelocation", "sitelocationaddress", "jobsite"],
    required: true,
    help: "Where the crane will work. Vendors see this.",
  },
  {
    key: "siteStateCode",
    label: "State",
    aliases: ["state", "sitestate", "sitestatecode", "statename"],
    required: true,
    help: "Pick an Indian state from the Lists sheet. Drives the distance ranking.",
  },
  {
    key: "sitePincode",
    label: "Pincode",
    aliases: ["pincode", "pin", "postalcode", "sitepincode"],
    required: false,
    help: "Six digits. Helps pin the job site when the address is ambiguous.",
  },
  {
    key: "region",
    label: "Region",
    aliases: ["region", "salesregion", "zone"],
    required: false,
    help: "Sales region for reports. Optional; the state mapping is used when blank.",
  },
  // --- line: requirement ---------------------------------------------------
  {
    key: "craneTypeCode",
    label: "Crane type",
    aliases: ["cranetype", "cranetypecode", "typeofcrane", "cranecapacitytypeormodel"],
    required: true,
    help: "Pick a crane type from the Lists sheet.",
  },
  {
    key: "capacityT",
    label: "Capacity (T)",
    aliases: ["capacityt", "capacity", "tonnage", "capacitytonnes", "cranecapacity"],
    required: true,
    help: "Required capacity in tonnes. A number, e.g. 250.",
  },
  {
    key: "capacityRule",
    label: "Capacity rule",
    aliases: ["capacityrule", "matchingrule", "atleastorexact"],
    required: false,
    help: "At least (a bigger crane may be offered) or Exact. Defaults to At least.",
  },
  {
    key: "capacityNote",
    label: "Capacity note",
    aliases: ["capacitynote", "capacityremarks"],
    required: false,
    help: "Free text around the tonnage, e.g. “700 TMC main boom + 36m luffing jib, or higher capacity”.",
  },
  {
    key: "quantity",
    label: "Quantity",
    aliases: ["quantity", "qty", "numberofcranes"],
    required: false,
    help: "How many cranes this line needs. Defaults to 1.",
  },
  // --- line: application and load -----------------------------------------
  {
    key: "applicationDescription",
    label: "Application / load to be handled",
    aliases: [
      "applicationdescription",
      "applicationorloadtobehandled",
      "application",
      "scopeofwork",
    ],
    required: false,
    help: "What the crane has to do, e.g. “Bridge erection, 565 MT at 78 m boom”.",
  },
  {
    key: "loadDescription",
    label: "Load description",
    aliases: ["loaddescription", "load", "loaddetails"],
    required: false,
    help: "What is being lifted and any constraints on it.",
  },
  {
    key: "liftLoadT",
    label: "Lift load (T)",
    aliases: ["liftloadt", "liftload", "loadt", "loadweight"],
    required: false,
    help: "Weight of the load in tonnes, if stated.",
  },
  {
    key: "workingRadiusM",
    label: "Working radius (m)",
    aliases: ["workingradiusm", "workingradius", "radius"],
    required: false,
    help: "Maximum working radius in metres, if stated.",
  },
  // --- line: configuration -------------------------------------------------
  {
    key: "requiredMainBoomM",
    label: "Main boom (m)",
    aliases: ["requiredmainboomm", "mainboom", "mainboomm", "boomm"],
    required: false,
    help: "Required main boom length in metres.",
  },
  {
    key: "requiredFixedJibM",
    label: "Fixed jib (m)",
    aliases: ["requiredfixedjibm", "fixedjib", "fixedjibm"],
    required: false,
    help: "Required fixed jib length in metres.",
  },
  {
    key: "requiredLuffingJibM",
    label: "Luffing jib (m)",
    aliases: ["requiredluffingjibm", "luffingjib", "luffingjibm"],
    required: false,
    help: "Required luffing jib length in metres.",
  },
  {
    key: "requiredWindJibM",
    label: "Wind jib (m)",
    aliases: ["requiredwindjibm", "windjib", "windjibm"],
    required: false,
    help: "Required wind jib length in metres.",
  },
  {
    key: "configurationNotes",
    label: "Configuration notes",
    aliases: [
      "configurationnotes",
      "craneconfigurationwithspecificboomhookblock",
      "configuration",
    ],
    required: false,
    help: "Anything about hook blocks, counterweight, superlift and so on.",
  },
  // --- line: dates ---------------------------------------------------------
  {
    key: "requiredStartDate",
    label: "Tentative deployment date",
    aliases: [
      "requiredstartdate",
      "tentativedeploymentdate",
      "deploymentdate",
      "startdate",
    ],
    required: false,
    help: "Leave blank when the customer has not fixed a date. Day-first dates accepted.",
  },
  {
    key: "durationValue",
    label: "Duration",
    aliases: ["durationvalue", "duration", "hiringduration"],
    required: false,
    help: "How long the crane is needed, e.g. 1 or 26.",
  },
  {
    key: "durationUnit",
    label: "Duration unit",
    aliases: ["durationunit", "durationunits", "daysormonths"],
    required: false,
    help: "Days or Months. Required when a Duration is given.",
  },
  {
    key: "workingDaysPerMonth",
    label: "Working days / month",
    aliases: ["workingdayspermonth", "workingdaysinamonth", "workingdays"],
    required: false,
    help: "Whole number of working days in a month, e.g. 26.",
  },
  // --- line: commercial terms ---------------------------------------------
  {
    key: "rentalBudget",
    label: "Rental per month (internal)",
    aliases: ["rentalpermonth", "rentalbudget", "budget", "rental"],
    required: false,
    help: "Internal only — never shown to a vendor or copied into an RFQ.",
    internal: true,
  },
  {
    key: "mobilisationTerms",
    label: "Mobilisation price",
    aliases: ["mobilisationprice", "mobilizationprice", "mobilisationterms", "mobilizationterms"],
    required: false,
    help: "Budget or expectation for mobilisation, e.g. “10 lakhs or lower”.",
  },
  {
    key: "demobilisationTerms",
    label: "Demobilisation price",
    aliases: [
      "demobilisationprice",
      "demobilizationprice",
      "demobilisationterms",
      "demobilizationterms",
    ],
    required: false,
    help: "Budget or expectation for demobilisation.",
  },
  {
    key: "dieselScope",
    label: "Diesel scope",
    aliases: ["dieselscope", "diesel"],
    required: false,
    help: "Who supplies diesel, e.g. Client scope.",
  },
  {
    key: "otCharges",
    label: "OT charges",
    aliases: ["otcharges", "ot", "overtimecharges"],
    required: false,
    help: "Overtime basis, e.g. Pro-rata or a percentage.",
  },
  {
    key: "workingHoursPerDay",
    label: "Working hours (per day)",
    aliases: ["workinghoursperday", "workinghours", "hoursperday"],
    required: false,
    help: "Shift length, e.g. “12 hrs including lunch break”. Combined with the Shift column.",
  },
  {
    key: "shift",
    label: "Shift",
    aliases: ["shift", "shifts", "singleordouble"],
    required: false,
    help: "Single or Double. Combined with the working hours column.",
  },
  {
    key: "accommodationConveyance",
    label: "Accommodation & local conveyance",
    aliases: [
      "accommodationconveyance",
      "accomodationlocalconveyanceofcrew",
      "accommodation",
      "conveyance",
    ],
    required: false,
    help: "Who provides crew accommodation and local transport, e.g. SML scope.",
  },
  {
    key: "supportCraneScope",
    label: "Support crane scope",
    aliases: ["supportcranescope", "supportcrane"],
    required: false,
    help: "Who provides the support crane, e.g. Client scope.",
  },
  {
    key: "steelMatsGroundPrepScope",
    label: "Steel mats & ground prep scope",
    aliases: [
      "steelmatsgroundprepscope",
      "steelmatsgroundpreparationscope",
      "steelmats",
      "groundpreparation",
    ],
    required: false,
    help: "Who provides steel mats and does the ground preparation.",
  },
  {
    key: "craneAgeCriteriaYears",
    label: "Crane age criteria (years)",
    aliases: ["craneagecriteria", "craneagecriteriayears", "craneage", "maxage"],
    required: false,
    help: "Maximum crane age in years. Leave blank when the customer has no limit.",
  },
  {
    key: "ehsHrCompliance",
    label: "EHS / HR compliance scope",
    aliases: ["ehshrcompliancescope", "ehshrcompliance", "ehs", "hrcompliance"],
    required: false,
    help: "Documents and compliance the vendor must meet.",
  },
  {
    key: "paymentTerms",
    label: "Payment terms",
    aliases: ["paymentterms", "paymenttermsindetailsincludingfhr", "payment"],
    required: false,
    help: "Payment terms in detail, including FHR where relevant.",
  },
  {
    key: "breakdownTerms",
    label: "Breakdown charges",
    aliases: ["breakdowncharges", "breakdownterms"],
    required: false,
    help: "How breakdown days are charged, e.g. Pro-rata.",
  },
  {
    key: "extensionClause",
    label: "Extension clause",
    aliases: ["extensionclause", "extension"],
    required: false,
    help: "Extension terms, or NA.",
  },
  {
    key: "insuranceTerms",
    label: "Insurance coverage",
    aliases: ["insurancecoverage", "insuranceterms", "insurance"],
    required: false,
    help: "Who insures equipment and manpower, e.g. Equipment: SML.",
  },
  {
    key: "additionalManpowerScope",
    label: "Additional manpower",
    aliases: [
      "additionalmanpower",
      "additionalmanpowersupervisorsafetyofficertechnician",
      "additionalmanpowerscope",
    ],
    required: false,
    help: "Extra supervisors, safety officers or technicians and who provides them.",
  },
  {
    key: "intraSiteMovementScope",
    label: "Intra-site movement scope",
    aliases: [
      "intrasitemovementscope",
      "scopeofintrasitemovementofcranes",
      "intrasitemovement",
    ],
    required: false,
    help: "Who covers moving the crane around the site.",
  },
  {
    key: "prereleaseTerms",
    label: "Pre-release terms",
    aliases: ["prereleaseterms", "prereleaseofcranesterms", "prerelease"],
    required: false,
    help: "Pre-release conditions, or NA.",
  },
  {
    key: "ppeScope",
    label: "PPE",
    aliases: ["ppe", "ppescope", "ppe standardorclientspecific"],
    required: false,
    help: "Standard or client-specific PPE requirements.",
  },
  {
    key: "rowScope",
    label: "ROW / right of way scope",
    aliases: ["rowscope", "rowrightofwayscope", "rightofway", "row"],
    required: false,
    help: "Who secures the right of way.",
  },
  {
    key: "otherTerms",
    label: "Additional remarks",
    aliases: ["additionalremarks", "additionalremarksifany", "otherterms", "remarks"],
    required: false,
    help: "Anything else the vendor should know.",
  },
];

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** label → key, and every alias → key. */
const HEADER_INDEX = new Map<string, string>();
for (const column of ENQUIRY_SHEET_COLUMNS) {
  HEADER_INDEX.set(normaliseHeader(column.label), column.key);
  for (const alias of column.aliases) {
    HEADER_INDEX.set(normaliseHeader(alias), column.key);
  }
}

export interface ParsedEnquiryRow {
  /** Excel row number, so a report can point at the actual line. */
  rowNumber: number;
  values: Record<string, string>;
}

/**
 * Parses the workbook into rows of raw text keyed by field name.
 *
 * A missing mandatory header is refused up front — importing half a sheet
 * because a column was renamed is worse than asking for the template again.
 */
export async function parseEnquirySheet(
  buffer: Buffer,
): Promise<ParsedEnquiryRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS's own `Buffer` type is an ArrayBuffer alias, which does not match
    // Node's Buffer under @types/node; the bytes are identical.
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
  } catch {
    throw AppError.badRequest(
      "That file could not be read as an .xlsx workbook. Download the template and try again.",
    );
  }

  const sheet =
    workbook.getWorksheet(ENQUIRY_SHEET_NAME) ?? workbook.worksheets[0] ?? null;
  if (!sheet) {
    throw AppError.badRequest("The workbook has no sheet to import");
  }

  const headerRow = sheet.getRow(1);
  const columns = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const key = HEADER_INDEX.get(normaliseHeader(cellText(cell)));
    if (key && !columns.has(key)) columns.set(key, columnNumber);
  });

  const missing = ENQUIRY_SHEET_COLUMNS.filter(
    (column) => column.required && !columns.has(column.key),
  );
  if (missing.length > 0) {
    throw AppError.badRequest(
      `These columns are missing from row 1: ${missing
        .map((column) => `“${column.label}”`)
        .join(", ")}. Download the template to get the exact headers.`,
    );
  }

  const rows: ParsedEnquiryRow[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values: Record<string, string> = {};
    let hasValue = false;
    for (const [key, columnNumber] of columns) {
      const text = cellText(row.getCell(columnNumber));
      if (text !== "") {
        values[key] = text;
        hasValue = true;
      }
    }
    if (!hasValue) continue;
    rows.push({ rowNumber, values });
    if (rows.length > MAX_ENQUIRY_ROWS) {
      throw AppError.badRequest(
        `This file has more than ${MAX_ENQUIRY_ROWS} enquiry rows. Split it into smaller uploads.`,
      );
    }
  }

  if (rows.length === 0) {
    throw AppError.badRequest(
      "The sheet has no enquiry rows. Add at least one row under the header and try again.",
    );
  }

  return rows;
}

/**
 * Reads a date cell the way the CR team writes one.
 *
 * A real Excel date cell arrives from `cellText` as an ISO timestamp, which the
 * default parser reads correctly. A typed `01/10/2026` is the trap: the default
 * parser treats it as January 10, so a `d/m/y` shape is read day-first here.
 * Anything else falls back to the default parser and is refused by the schema if
 * it is not a date.
 */
export function parseSheetDate(text: string): Date | null {
  const value = text.trim();
  if (!value) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value);
  if (iso) {
    const date = new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const dayFirst = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
  if (dayFirst) {
    const year =
      dayFirst[3].length === 2 ? 2000 + Number(dayFirst[3]) : Number(dayFirst[3]);
    const date = new Date(
      Date.UTC(year, Number(dayFirst[2]) - 1, Number(dayFirst[1])),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
