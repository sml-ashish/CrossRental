import ExcelJS from "exceljs";
import {
  CRANE_SHEET_NAME,
  MAX_BULK_ROWS,
  SHEET_COLUMNS,
} from "./craneSheet";

/**
 * The downloadable crane upload template.
 *
 * The dropdowns matter more than the styling: a sheet that offers the eight
 * crane types and the seeded states stops most imports failing on a typo, and
 * the state list is too long for Excel's inline 255-character limit, so it lives
 * on a hidden Lists sheet and the cells reference it by range.
 *
 * The example row is fabricated and marked as an example — nobody should be able
 * to mistake it for real fleet data.
 */

export interface TemplateReference {
  code: string;
  name: string;
}

export interface TemplateInput {
  craneTypes: TemplateReference[];
  states: TemplateReference[];
}

const STATUS_LABELS = ["Available", "Engaged", "Under Maintenance"];

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

export async function buildCraneTemplate(
  input: TemplateInput,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "crossrentel";
  workbook.created = new Date();

  // --- Lists (hidden) ------------------------------------------------------
  const lists = workbook.addWorksheet("Lists");
  lists.getColumn(1).values = ["Crane type", ...input.craneTypes.map((t) => t.name)];
  lists.getColumn(2).values = ["State", ...input.states.map((s) => s.name)];
  lists.getColumn(3).values = ["Status", ...STATUS_LABELS];
  lists.state = "hidden";

  // --- Cranes --------------------------------------------------------------
  const sheet = workbook.addWorksheet(CRANE_SHEET_NAME, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = SHEET_COLUMNS.map((column) => ({
    header: column.label,
    key: column.key,
    width: Math.max(16, Math.min(30, column.label.length + 6)),
  }));
  styleHeader(sheet.getRow(1));

  SHEET_COLUMNS.forEach((column, index) => {
    const header = sheet.getRow(1).getCell(index + 1);
    header.note = `${column.required ? "Required" : "Optional"}. ${column.help}`;
    if (column.required) {
      header.font = { bold: true, color: { argb: "FFFFE4E6" }, size: 11 };
    }
  });

  const firstType = input.craneTypes[0]?.name ?? "Crawler Crane";
  const firstState = input.states[0]?.name ?? "Gujarat";
  const example = sheet.addRow({
    serialRegistrationNo: "DEMO-CRANE-0001",
    typeOfCraneCode: firstType,
    capacityT: 250,
    currentLocation: "Vadodara, Gujarat",
    stateCode: firstState,
    pincode: "390010",
    make: "Demag",
    model: "CC 2500",
    yom: 2018,
    mainBoomM: 60,
    fixedJibM: "",
    luffingJibM: "",
    windJibM: "",
    currentStatus: "Available",
    availableFrom: "",
    expectedReadyDate: "",
    googleMapsLocation: "https://maps.google.com/?q=22.3072,73.1812",
    remarks: "Example row — replace it with your crane, or delete it.",
  });
  example.font = { italic: true, color: { argb: "FF64748B" } };

  const lastRow = MAX_BULK_ROWS + 1;
  const typeColumn = SHEET_COLUMNS.findIndex((c) => c.key === "typeOfCraneCode") + 1;
  const stateColumn = SHEET_COLUMNS.findIndex((c) => c.key === "stateCode") + 1;
  const statusColumn = SHEET_COLUMNS.findIndex((c) => c.key === "currentStatus") + 1;

  for (let row = 2; row <= lastRow; row += 1) {
    sheet.getCell(row, typeColumn).dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: [listRange("A", input.craneTypes.length)],
      showErrorMessage: true,
      errorTitle: "Crane type",
      error: "Pick a crane type from the list (see the Instructions sheet).",
    };
    sheet.getCell(row, stateColumn).dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: [listRange("B", input.states.length)],
      showErrorMessage: true,
      errorTitle: "State",
      error: "Pick an Indian state from the list.",
    };
    sheet.getCell(row, statusColumn).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [listRange("C", STATUS_LABELS.length)],
      showErrorMessage: true,
      errorTitle: "Status",
      error: "Available, Engaged or Under Maintenance. Booked and Hired are set by the portal.",
    };
  }

  // --- Instructions --------------------------------------------------------
  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [
    { header: "Column", key: "column", width: 26 },
    { header: "Required", key: "required", width: 12 },
    { header: "What to enter", key: "help", width: 90 },
  ];
  styleHeader(instructions.getRow(1));
  for (const column of SHEET_COLUMNS) {
    const row = instructions.addRow({
      column: column.label,
      required: column.required ? "Yes" : "Optional",
      help: column.help,
    });
    row.alignment = { vertical: "top", wrapText: true };
  }

  instructions.addRow({});
  const notes: Array<[string, string]> = [
    ["Row limit", `Up to ${MAX_BULK_ROWS} cranes per upload. Split larger fleets into more than one file.`],
    ["One vendor", "Every crane in the file is added to the vendor you chose in the portal — there is no vendor column."],
    [
      "Location",
      "A Google Maps cell with coordinates wins. Otherwise its place name is looked up. With no usable Maps cell, the pincode (plus current location and state) is used.",
    ],
    ["Duplicates", "A serial number already on this vendor's active fleet is skipped and listed in the result."],
    ["Not in the sheet", "Load charts are attached to the crane after the import."],
  ];
  for (const [label, text] of notes) {
    const row = instructions.addRow({ column: label, required: "", help: text });
    row.getCell(1).font = { bold: true };
    row.alignment = { vertical: "top", wrapText: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
