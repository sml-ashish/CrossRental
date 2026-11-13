import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  appPrisma,
  call,
  callRaw,
  callUpload,
  clearTestUploads,
  disconnectTestDatabases,
  internalToken,
  resetTestDatabase,
  seedIsolationFixtures,
  useTestDatabase,
  type SeededVendor,
} from "./harness";
import { INTERNAL_USERS, VENDOR_USERS } from "./fixtures";
import { ENQUIRY_SHEET_COLUMNS } from "../lib/enquirySheet";
import { XLSX_MIME } from "../middleware/upload";

/**
 * Bulk enquiry upload (sales and admin, `.xlsx`).
 *
 * What matters here, and why:
 *
 * - the import must be the *same* create path as the enquiry form, so numbering,
 *   audit and the status trail cannot drift between them;
 * - `Enquiry ref` groups rows into one enquiry with several lines, and a blank
 *   ref makes each row its own enquiry — the grouping is explicit, never guessed;
 * - a bad row must not cost the good rows — the report names the row and column;
 * - a header that drifts inside a group is reported, not silently applied;
 * - dates typed day-first (`01/10/2026`) are read as 1 October, not 10 January;
 * - the dry run writes nothing;
 * - vendors and management viewers cannot upload.
 *
 * Every value is fabricated.
 */

let app: Express;

beforeAll(async () => {
  useTestDatabase();
  const { createApp } = await import("../index");
  app = createApp();
});

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await disconnectTestDatabases();
  await clearTestUploads();
});

interface Ctx {
  a: SeededVendor;
  b: SeededVendor;
  adminToken: string;
  salesToken: string;
  vendorToken: string;
}

let ctx: Ctx;

beforeEach(async () => {
  const fixtures = await seedIsolationFixtures();
  const login = await call(app, "POST", "/api/auth/login", {
    body: { email: VENDOR_USERS.a, password: "Vendor@Portal2026" },
  });
  ctx = {
    a: fixtures.vendorA,
    b: fixtures.vendorB,
    adminToken: await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user"),
    salesToken: await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user"),
    vendorToken: login.body.token as string,
  };
});

/** A complete, valid row; override only what a test is about. */
function enquiryRow(
  overrides: Record<string, string | number | null> = {},
): Record<string, string | number | null> {
  return {
    customerName: "Example Customer Ltd",
    customerAddress: "1 Example Industrial Estate, Vadodara",
    siteLocation: "Vadodara",
    siteStateCode: "State GJ",
    craneTypeCode: "Crawler Crane",
    capacityT: 100,
    ...overrides,
  };
}

async function workbook(
  rows: Array<Record<string, string | number | null>>,
  options: { headers?: string[]; sheetName?: string } = {},
): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(options.sheetName ?? "Enquiries");
  sheet.addRow(options.headers ?? ENQUIRY_SHEET_COLUMNS.map((column) => column.label));
  for (const row of rows) {
    sheet.addRow(ENQUIRY_SHEET_COLUMNS.map((column) => row[column.key] ?? null));
  }
  const buffer = await book.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function upload(buffer: Buffer, options: { token: string; dryRun: boolean }) {
  return callUpload(
    app,
    "POST",
    `/api/enquiries/bulk?dryRun=${options.dryRun ? "true" : "false"}`,
    { buffer, fileName: "enquiries.xlsx", mimeType: XLSX_MIME },
    { token: options.token },
  );
}

async function enquiryCount(): Promise<number> {
  return appPrisma.enquiry.count();
}

// ---------------------------------------------------------------------------

describe("bulk enquiry upload", () => {
  it("previews a sheet without writing anything", async () => {
    const before = await enquiryCount();
    const file = await workbook([enquiryRow(), enquiryRow({ siteLocation: "Surat" })]);

    const res = await upload(file, { token: ctx.salesToken, dryRun: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary).toMatchObject({
      total: 2,
      valid: 2,
      imported: 0,
      failed: 0,
      enquiries: 2,
    });
    expect(
      res.body.rows.every((row: { status: string }) => row.status === "valid"),
    ).toBe(true);
    expect(await enquiryCount()).toBe(before);
  });

  it("imports one enquiry per row when Enquiry ref is blank", async () => {
    const file = await workbook([
      enquiryRow({ applicationDescription: "First job" }),
      enquiryRow({ applicationDescription: "Second job" }),
    ]);

    const res = await upload(file, { token: ctx.salesToken, dryRun: false });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({
      total: 2,
      imported: 2,
      failed: 0,
      enquiries: 2,
    });

    const saved = await appPrisma.enquiry.findMany({
      select: {
        customerName: true,
        siteStateCode: true,
        lines: { select: { applicationDescription: true } },
      },
    });
    expect(saved).toHaveLength(2);
    expect(saved.every((enquiry) => enquiry.customerName === "Example Customer Ltd")).toBe(
      true,
    );
    expect(saved.every((enquiry) => enquiry.lines.length === 1)).toBe(true);
  });

  it("groups rows that share an Enquiry ref into one enquiry", async () => {
    const file = await workbook([
      enquiryRow({ enquiryRef: "SP-42", applicationDescription: "Line one" }),
      enquiryRow({ enquiryRef: "SP-42", applicationDescription: "Line two" }),
      enquiryRow({ enquiryRef: "SP-42", applicationDescription: "Line three" }),
    ]);

    const res = await upload(file, { token: ctx.salesToken, dryRun: false });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({ enquiries: 1, imported: 3, failed: 0 });

    const enquiries = await appPrisma.enquiry.findMany({
      select: {
        lines: {
          select: { lineNo: true, applicationDescription: true },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    expect(enquiries).toHaveLength(1);
    expect(enquiries[0].lines.map((line) => line.lineNo)).toEqual([1, 2, 3]);
    expect(enquiries[0].lines.map((line) => line.applicationDescription)).toEqual([
      "Line one",
      "Line two",
      "Line three",
    ]);
  });

  it("imports the good rows when one row is bad", async () => {
    const file = await workbook([
      enquiryRow(),
      enquiryRow({ siteStateCode: "Atlantis" }),
      enquiryRow({ siteLocation: "Rajkot" }),
    ]);

    const res = await upload(file, { token: ctx.salesToken, dryRun: false });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({ total: 3, imported: 2, failed: 1 });

    const failed = res.body.rows.find(
      (row: { status: string }) => row.status === "failed",
    );
    expect(failed.row).toBe(3);
    expect(failed.message).toContain("State");
    expect(await enquiryCount()).toBe(2);
  });

  it("names the column when the crane type is not on the list", async () => {
    const file = await workbook([enquiryRow({ craneTypeCode: "Teleporter" })]);

    const res = await upload(file, { token: ctx.salesToken, dryRun: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary.valid).toBe(0);
    expect(res.body.rows[0].message).toContain("Crane type");
    expect(res.body.rows[0].message).toContain("Teleporter");
  });

  it("reports a header that drifts inside a group and keeps the first row's", async () => {
    const file = await workbook([
      enquiryRow({ enquiryRef: "SP-7", customerName: "First Customer" }),
      enquiryRow({ enquiryRef: "SP-7", customerName: "Different Customer" }),
    ]);

    const res = await upload(file, { token: ctx.salesToken, dryRun: false });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary.enquiries).toBe(1);

    const drifted = res.body.rows.find((row: { row: number }) => row.row === 3);
    expect(drifted.warnings.join(" ")).toMatch(/differs from the first row/i);

    const saved = await appPrisma.enquiry.findFirstOrThrow({
      select: { customerName: true },
    });
    expect(saved.customerName).toBe("First Customer");
  });

  it("reads a day-first date as the day the CR team wrote", async () => {
    const file = await workbook([enquiryRow({ requiredStartDate: "01/10/2026" })]);

    const res = await upload(file, { token: ctx.salesToken, dryRun: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const line = await appPrisma.enquiryLineItem.findFirstOrThrow({
      select: { requiredStartDate: true },
    });
    expect(line.requiredStartDate?.toISOString().slice(0, 10)).toBe("2026-10-01");
  });

  it("warns about a likely duplicate but still imports it", async () => {
    const first = await call(app, "POST", "/api/enquiries", {
      token: ctx.salesToken,
      body: {
        customerName: "Example Customer Ltd",
        customerAddress: "1 Example Industrial Estate, Vadodara",
        siteLocation: "Vadodara",
        siteStateCode: "GJ",
        lines: [{ craneTypeCode: "CRAWLER", capacityT: 100 }],
      },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const enquiryNo = first.body.enquiry.enquiryNo as string;

    const res = await upload(await workbook([enquiryRow()]), {
      token: ctx.salesToken,
      dryRun: false,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary.imported).toBe(1);
    expect(res.body.rows[0].warnings.join(" ")).toContain(enquiryNo);
    expect(await enquiryCount()).toBe(2);
  });

  it("refuses more than 250 rows up front", async () => {
    const rows = Array.from({ length: 251 }, (_, index) =>
      enquiryRow({ siteLocation: `Site ${index}` }),
    );

    const res = await upload(await workbook(rows), {
      token: ctx.salesToken,
      dryRun: true,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(String(res.body.error ?? res.body.message)).toContain("250");
    expect(await enquiryCount()).toBe(0);
  });

  it("lets an admin upload", async () => {
    const res = await upload(await workbook([enquiryRow()]), {
      token: ctx.adminToken,
      dryRun: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary.imported).toBe(1);
  });

  it("refuses a vendor and a management viewer", async () => {
    // The token's role claim is not what the server trusts: `requireAuth` loads
    // the user row, so a real management_viewer row is needed here.
    const management = await appPrisma.user.create({
      data: { email: "management@isolation.test", role: "management_viewer" },
      select: { id: true, email: true },
    });
    const managementToken = await internalToken(
      management.id,
      management.email,
      "management_viewer",
    );

    const file = await workbook([enquiryRow()]);

    const vendor = await upload(file, { token: ctx.vendorToken, dryRun: false });
    expect(vendor.status).toBe(403);

    const viewer = await upload(file, {
      token: managementToken,
      dryRun: false,
    });
    expect(viewer.status).toBe(403);

    expect(await enquiryCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * Adding lines to an enquiry that already exists.
 *
 * The target is the enquiry in the URL, so the header columns of the template
 * mean nothing here — a row only carries its line fields. These tests pin that
 * down, plus the two things that would be worst to get wrong: the dry run must
 * not write, and a bad row must not cost the good rows.
 */
describe("bulk add lines to an existing enquiry", () => {
  /** An enquiry with one CRAWLER/100 line, i.e. line 1 already taken. */
  async function seedEnquiry(): Promise<{ id: string; enquiryNo: string }> {
    const res = await call(app, "POST", "/api/enquiries", {
      token: ctx.salesToken,
      body: {
        customerName: "Example Customer Ltd",
        customerAddress: "1 Example Industrial Estate, Vadodara",
        siteLocation: "Vadodara",
        siteStateCode: "GJ",
        lines: [{ craneTypeCode: "CRAWLER", capacityT: 100 }],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return {
      id: res.body.enquiry.id as string,
      enquiryNo: res.body.enquiry.enquiryNo as string,
    };
  }

  function uploadLines(
    enquiryId: string,
    buffer: Buffer,
    options: { token: string; dryRun: boolean },
  ) {
    return callUpload(
      app,
      "POST",
      `/api/enquiries/${enquiryId}/lines/bulk?dryRun=${options.dryRun ? "true" : "false"}`,
      { buffer, fileName: "lines.xlsx", mimeType: XLSX_MIME },
      { token: options.token },
    );
  }

  it("appends one line per row after the last existing line", async () => {
    const { id, enquiryNo } = await seedEnquiry();

    const res = await uploadLines(
      id,
      await workbook([
        enquiryRow({ craneTypeCode: "Crawler Crane", capacityT: 150 }),
        enquiryRow({ craneTypeCode: "Crawler Crane", capacityT: 200 }),
      ]),
      { token: ctx.salesToken, dryRun: false },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.enquiryNo).toBe(enquiryNo);
    expect(res.body.summary).toMatchObject({
      total: 2,
      imported: 2,
      failed: 0,
    });
    expect(res.body.rows.map((row: { lineNo: number }) => row.lineNo)).toEqual([2, 3]);

    const lines = await appPrisma.enquiryLineItem.findMany({
      where: { enquiryId: id },
      select: { lineNo: true, capacityT: true },
      orderBy: { lineNo: "asc" },
    });
    expect(lines.map((line) => line.lineNo)).toEqual([1, 2, 3]);
    expect(lines.map((line) => Number(line.capacityT))).toEqual([100, 150, 200]);
    // Appending must never create a second enquiry.
    expect(await enquiryCount()).toBe(1);
  });

  it("writes nothing on a dry run", async () => {
    const { id } = await seedEnquiry();

    const res = await uploadLines(
      id,
      await workbook([
        enquiryRow({ capacityT: 150 }),
        enquiryRow({ capacityT: 200 }),
      ]),
      { token: ctx.salesToken, dryRun: true },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary).toMatchObject({ total: 2, valid: 2, imported: 0, failed: 0 });
    expect(res.body.rows.map((row: { status: string }) => row.status)).toEqual([
      "valid",
      "valid",
    ]);
    // The numbers a dry run promises are the numbers the import will use.
    expect(res.body.rows.map((row: { lineNo: number }) => row.lineNo)).toEqual([2, 3]);

    const lines = await appPrisma.enquiryLineItem.findMany({
      where: { enquiryId: id },
      select: { lineNo: true },
    });
    expect(lines).toHaveLength(1);
  });

  it("ignores the header columns, because the enquiry already has them", async () => {
    const { id } = await seedEnquiry();

    // Blank customer and a nonsense state would fail on the create path. Here
    // they are not read at all, so the row still appends.
    const res = await uploadLines(
      id,
      await workbook([
        enquiryRow({
          customerName: "",
          customerAddress: "",
          siteLocation: "",
          siteStateCode: "Atlantis",
          capacityT: 150,
        }),
      ]),
      { token: ctx.salesToken, dryRun: false },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({ imported: 1, failed: 0 });

    const enquiry = await appPrisma.enquiry.findUniqueOrThrow({
      where: { id },
      select: { customerName: true, siteStateCode: true, lines: { select: { lineNo: true } } },
    });
    // The enquiry's own header is untouched, and no second enquiry appeared.
    expect(enquiry.customerName).toBe("Example Customer Ltd");
    expect(enquiry.siteStateCode).toBe("GJ");
    expect(enquiry.lines).toHaveLength(2);
    expect(await enquiryCount()).toBe(1);
  });

  it("fails only the bad row and appends the good ones", async () => {
    const { id } = await seedEnquiry();

    const res = await uploadLines(
      id,
      await workbook([
        enquiryRow({ capacityT: 150 }),
        enquiryRow({ craneTypeCode: "Teleporter" }),
        enquiryRow({ capacityT: 250 }),
      ]),
      { token: ctx.salesToken, dryRun: false },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({ total: 3, imported: 2, failed: 1 });

    const failed = res.body.rows.find(
      (row: { status: string }) => row.status === "failed",
    );
    expect(failed.row).toBe(3);
    expect(failed.message).toContain("Crane type");
    expect(failed.message).toContain("Teleporter");

    const lines = await appPrisma.enquiryLineItem.findMany({
      where: { enquiryId: id },
      select: { lineNo: true },
      orderBy: { lineNo: "asc" },
    });
    expect(lines.map((line) => line.lineNo)).toEqual([1, 2, 3]);
  });

  it("warns when the enquiry already has the same crane and capacity", async () => {
    const { id } = await seedEnquiry();

    const res = await uploadLines(
      id,
      await workbook([enquiryRow({ capacityT: 100 })]),
      { token: ctx.salesToken, dryRun: false },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary.imported).toBe(1);
    expect(res.body.rows[0].warnings.join(" ")).toMatch(/already has line 1/i);
  });

  it("adds to the enquiry in the URL, not to a ref written in the sheet", async () => {
    const { id, enquiryNo } = await seedEnquiry();

    const res = await uploadLines(
      id,
      // A ref in the sheet would create/point at another enquiry on the create
      // path. Here it is just another ignored header column.
      await workbook([enquiryRow({ enquiryRef: "SOME-OTHER-ENQUIRY", capacityT: 150 })]),
      { token: ctx.salesToken, dryRun: false },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.enquiryNo).toBe(enquiryNo);
    expect(await enquiryCount()).toBe(1);
  });

  it("returns 404 for an enquiry that does not exist", async () => {
    const res = await uploadLines(
      "00000000-0000-0000-0000-000000000000",
      await workbook([enquiryRow()]),
      { token: ctx.salesToken, dryRun: false },
    );
    expect(res.status).toBe(404);
  });

  it("refuses a vendor and a management viewer", async () => {
    const { id } = await seedEnquiry();

    const management = await appPrisma.user.create({
      data: { email: "management-lines@isolation.test", role: "management_viewer" },
      select: { id: true, email: true },
    });
    const managementToken = await internalToken(
      management.id,
      management.email,
      "management_viewer",
    );

    const file = await workbook([enquiryRow({ capacityT: 150 })]);

    const vendor = await uploadLines(id, file, {
      token: ctx.vendorToken,
      dryRun: false,
    });
    expect(vendor.status).toBe(403);

    const viewer = await uploadLines(id, file, {
      token: managementToken,
      dryRun: false,
    });
    expect(viewer.status).toBe(403);

    const lines = await appPrisma.enquiryLineItem.findMany({
      where: { enquiryId: id },
      select: { lineNo: true },
    });
    expect(lines).toHaveLength(1);
  });
});

describe("bulk enquiry template", () => {
  it("downloads a workbook with the expected headers and dropdown lists", async () => {
    const res = await callRaw(app, "/api/enquiries/bulk/template", {
      token: ctx.salesToken,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(XLSX_MIME);
    expect(res.headers.get("content-disposition")).toMatch(
      /crossrentel-enquiry-upload\.xlsx/,
    );

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheet = book.getWorksheet("Enquiries");
    expect(sheet).toBeDefined();

    const headers = ENQUIRY_SHEET_COLUMNS.map((column) =>
      String(
        sheet?.getRow(1).getCell(ENQUIRY_SHEET_COLUMNS.indexOf(column) + 1).value ?? "",
      ),
    );
    expect(headers).toEqual(ENQUIRY_SHEET_COLUMNS.map((column) => column.label));

    const stateColumn = ENQUIRY_SHEET_COLUMNS.findIndex((c) => c.key === "siteStateCode") + 1;
    expect(sheet?.getRow(2).getCell(stateColumn).dataValidation?.type).toBe("list");
    expect(book.getWorksheet("Lists")).toBeDefined();
    expect(book.getWorksheet("Instructions")).toBeDefined();
  });

  it("is not available to a vendor user", async () => {
    const res = await callRaw(app, "/api/enquiries/bulk/template", {
      token: ctx.vendorToken,
    });
    expect(res.status).toBe(403);
  });
});
