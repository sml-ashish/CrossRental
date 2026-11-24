import ExcelJS from "exceljs";
import {
  ENQUIRY_SHEET_COLUMNS,
  ENQUIRY_SHEET_NAME,
  MAX_ENQUIRY_ROWS,
} from "./enquirySheet";

/**
 * The downloadable bulk-enquiry template.
 *
 * Same shape as the crane template: a hidden Lists sheet feeds the dropdowns so
 * a typo in a state or crane type cannot fail an otherwise good sheet, an
 * Instructions sheet repeats every column's rule, and the example row is
 * fabricated and labelled so it is never mistaken for a real enquiry.
 *
 * The example row deliberately carries an `Enquiry ref`: that is the one column
 * a sales user is most likely to get wrong, and seeing two rows with the same
 * ref is how the grouping is explained without a manual.
 */

export interface TemplateReference {
  code: string;
  name: string;
}

export interface EnquiryTemplateInput {
  craneTypes: TemplateReference[];
  states: TemplateReference[];
}

const DURATION_UNITS = ["Days", "Months"];

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF0F172A" },
};

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: "middle" };
  row.height = 22;
}

function listRange(column: string, count: number): string {
  return `'Lists'!$${column}$2:$${column}$${Math.max(count + 1, 2)}`;
}

export async function buildEnquiryTemplate(
  input: EnquiryTemplateInput,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "crossrentel";
  workbook.created = new Date();

  // --- Lists (hidden) ------------------------------------------------------
  const lists = workbook.addWorksheet("Lists");
  lists.getColumn(1).values = ["Crane type", ...input.craneTypes.map((t) => t.name)];
  lists.getColumn(2).values = ["State", ...input.states.map((s) => s.name)];
  lists.getColumn(3).values = ["Duration unit", ...DURATION_UNITS];
  lists.state = "hidden";

  // --- Enquiries -----------------------------------------------------------
  const sheet = workbook.addWorksheet(ENQUIRY_SHEET_NAME, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = ENQUIRY_SHEET_COLUMNS.map((column) => ({
    header: column.label,
    key: column.key,
    width: Math.max(18, Math.min(34, column.label.length + 6)),
  }));
  styleHeader(sheet.getRow(1));

  ENQUIRY_SHEET_COLUMNS.forEach((column, index) => {
    const header = sheet.getRow(1).getCell(index + 1);
    header.note = `${column.required ? "Required" : "Optional"}. ${column.help}`;
    if (column.required) {
      header.font = { bold: true, color: { argb: "FFFFE4E6" }, size: 11 };
    }
  });

  const firstType = input.craneTypes[0]?.name ?? "Crawler Crane";
  const firstState = input.states[0]?.name ?? "Gujarat";
  const example = sheet.addRow({
    enquiryRef: "EXAMPLE-1",
    enquiryDate: "2026-10-01",
    shipToCity: "Ambattur",
    siteStateCode: firstState,
    craneTypeCode: firstType,
    craneModel: "Liebherr LR 1250",
    yom: 2020,
    capacityT: 250,
    applicationDescription: "Example application — replace this row",
    liftLoadT: 120,
    liftHeightM: 45,
    craneConfiguration: "MB 60 + FJ 12",
    requiredStartDate: "2026-11-01",
    durationValue: 1,
    durationUnit: "Months",
    workingDaysPerMonth: 26,
    dieselScope: "Client scope",
    otCharges: "Pro-rata",
    workingHoursPerDay: "12 hrs including lunch break",
    shift: "Single",
    supportCraneScope: "Client scope",
    steelMatsGroundPrepScope: "Client scope",
    craneAgeCriteriaYears: "",
    ehsHrCompliance: "",
    breakdownTerms: "Pro-rata",
    insuranceTerms: "",
    additionalManpowerScope: "",
    rowScope: "Client scope",
  });
  example.font = { italic: true, color: { argb: "FF64748B" } };

  // --- dropdowns -----------------------------------------------------------
  const lastRow = MAX_ENQUIRY_ROWS + 1;
  const columnNumber = (key: string): number =>
    ENQUIRY_SHEET_COLUMNS.findIndex((column) => column.key === key) + 1;

  const validations: Array<{
    key: string;
    range: string;
    allowBlank: boolean;
    title: string;
    error: string;
  }> = [
    {
      key: "craneTypeCode",
      range: listRange("A", input.craneTypes.length),
      allowBlank: false,
      title: "Crane type",
      error: "Pick a crane type from the list on the Lists sheet.",
    },
    {
      key: "siteStateCode",
      range: listRange("B", input.states.length),
      allowBlank: false,
      title: "State",
      error: "Pick an Indian state from the list.",
    },
    {
      key: "durationUnit",
      range: listRange("C", DURATION_UNITS.length),
      allowBlank: true,
      title: "Duration unit",
      error: "Days or Months. Required when a Duration is given.",
    },
  ];

  for (let row = 2; row <= lastRow; row += 1) {
    for (const validation of validations) {
      sheet.getCell(row, columnNumber(validation.key)).dataValidation = {
        type: "list",
        allowBlank: validation.allowBlank,
        formulae: [validation.range],
        showErrorMessage: true,
        errorTitle: validation.title,
        error: validation.error,
      };
    }
  }

  // --- Instructions --------------------------------------------------------
  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [
    { header: "Column", key: "column", width: 32 },
    { header: "Required", key: "required", width: 12 },
    { header: "What to enter", key: "help", width: 90 },
  ];
  styleHeader(instructions.getRow(1));
  for (const column of ENQUIRY_SHEET_COLUMNS) {
    const row = instructions.addRow({
      column: column.label,
      required: column.required ? "Yes" : "Optional",
      help: column.help,
    });
    row.alignment = { vertical: "top", wrapText: true };
  }

  instructions.addRow({});
  const notes: Array<[string, string]> = [
    [
      "Row limit",
      `Up to ${MAX_ENQUIRY_ROWS} rows per upload. Split larger lists into more than one file.`,
    ],
    [
      "Several lines, one enquiry",
      "Give the rows the same “Enquiry ref”. They are grouped into one enquiry with one line per row, in sheet order. A blank ref makes each row its own enquiry.",
    ],
    [
      "Same header on every row",
      "The first row of a group supplies the site and enquiry date. If a later row in the same group disagrees, the first row wins and the report warns about it.",
    ],
    [
      "Adding lines to an existing enquiry",
      "Use “Add lines in bulk” on that enquiry's screen. The enquiry is fixed by the screen, so the header columns (site, state, date, ref) are ignored and only the line columns are read.",
    ],
    [
      "Dates",
      "Real Excel dates, 2026-10-01 and 01/10/2026 (day first) all work. A text date is read day-first.",
    ],
    [
      "Not in the sheet",
      "Vendor terms are chosen when the RFQ is raised. Site coordinates are derived from the city and state.",
    ],
  ];
  for (const [label, text] of notes) {
    const row = instructions.addRow({ column: label, required: "", help: text });
    row.getCell(1).font = { bold: true };
    row.alignment = { vertical: "top", wrapText: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
