import ExcelJS from "exceljs";
import {
  INVITE_SHEET_COLUMNS,
  INVITE_SHEET_NAME,
  MAX_INVITE_ROWS,
} from "./vendorInviteSheet";

/**
 * The downloadable vendor-invitation upload template.
 *
 * Three columns, no reference lists — the only thing to get right is the email
 * and the mobile format, and both are explained on the Instructions sheet. The
 * example row is fabricated and marked as an example, so nobody mistakes it for
 * a real invitation.
 */

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

export async function buildInviteTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "crossrentel";
  workbook.created = new Date();

  // --- Invitations ---------------------------------------------------------
  const sheet = workbook.addWorksheet(INVITE_SHEET_NAME, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = INVITE_SHEET_COLUMNS.map((column) => ({
    header: column.label,
    key: column.key,
    width: Math.max(18, Math.min(34, column.label.length + 12)),
  }));
  styleHeader(sheet.getRow(1));

  INVITE_SHEET_COLUMNS.forEach((column, index) => {
    const header = sheet.getRow(1).getCell(index + 1);
    header.note = `${column.required ? "Required" : "Optional"}. ${column.help}`;
    if (column.required) {
      header.font = { bold: true, color: { argb: "FFFFE4E6" }, size: 11 };
    }
  });

  const example = sheet.addRow({
    name: "Example Cranes Pvt Ltd",
    email: "example.vendor@example.com",
    contactNumber: "9876543210",
  });
  example.font = { italic: true, color: { argb: "FF64748B" } };

  // --- Instructions --------------------------------------------------------
  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [
    { header: "Column", key: "column", width: 22 },
    { header: "Required", key: "required", width: 12 },
    { header: "What to enter", key: "help", width: 90 },
  ];
  styleHeader(instructions.getRow(1));
  for (const column of INVITE_SHEET_COLUMNS) {
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
      `Up to ${MAX_INVITE_ROWS} invitations per upload. Split larger lists into more than one file.`,
    ],
    [
      "What happens",
      "Checking the file changes nothing. Importing it creates one invitation per valid row and emails the link to that address.",
    ],
    [
      "Duplicates",
      "A row is skipped when its email already has an account, already has a live invitation, or appears twice in the file. The report names the row.",
    ],
    [
      "Bad rows",
      "An invalid email or contact number fails only that row; the other rows still import.",
    ],
    [
      "Example row",
      "Delete the italic example row before uploading — it is not a real vendor.",
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
