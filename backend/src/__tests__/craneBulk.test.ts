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
import { CRANE_SERIALS, INTERNAL_USERS, VENDOR_USERS } from "./fixtures";
import { SHEET_COLUMNS } from "../lib/craneSheet";
import { XLSX_MIME } from "../middleware/upload";

/**
 * Bulk crane upload (sales and admin, `.xlsx`, one vendor per file).
 *
 * What matters here, and why:
 *
 * - the import must be the *same* create path as the single-crane form, so a
 *   capacity or serial rule cannot drift between them;
 * - a bad row must not cost the good rows — the report names the row;
 * - a duplicate serial is skipped, never used to update an existing crane;
 * - the vendor is fixed before the file is read, so a sheet cannot be pointed at
 *   another vendor's fleet;
 * - a Google Maps cell wins over the pincode, and the pincode is the fallback;
 * - 251 rows are refused up front rather than half-imported.
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

let serialCounter = 0;

/** A complete, valid row; override only what a test is about. */
function craneRow(
  overrides: Record<string, string | number | null> = {},
): Record<string, string | number | null> {
  serialCounter += 1;
  return {
    serialRegistrationNo: `BULK-${String(serialCounter).padStart(4, "0")}`,
    typeOfCraneCode: "Crawler Crane",
    capacityT: 100,
    currentLocation: "Ahmedabad, Gujarat",
    stateCode: "State GJ",
    pincode: "380001",
    make: "Demag",
    model: "CC 1000",
    yom: 2015,
    mainBoomM: 30,
    ...overrides,
  };
}

async function workbook(
  rows: Array<Record<string, string | number | null>>,
  options: { headers?: string[]; sheetName?: string } = {},
): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(options.sheetName ?? "Cranes");
  sheet.addRow(options.headers ?? SHEET_COLUMNS.map((column) => column.label));
  for (const row of rows) {
    sheet.addRow(SHEET_COLUMNS.map((column) => row[column.key] ?? null));
  }
  const buffer = await book.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function upload(
  buffer: Buffer,
  options: { token: string; vendorId: string; dryRun: boolean },
) {
  return callUpload(
    app,
    "POST",
    `/api/cranes/bulk?dryRun=${options.dryRun ? "true" : "false"}`,
    { buffer, fileName: "fleet.xlsx", mimeType: XLSX_MIME },
    { token: options.token, fields: { vendorId: options.vendorId } },
  );
}

async function craneCount(vendorId: string): Promise<number> {
  return appPrisma.crane.count({ where: { vendorId, isActive: true } });
}

// ---------------------------------------------------------------------------

describe("bulk crane upload", () => {
  it("previews a sheet without writing anything", async () => {
    const before = await craneCount(ctx.a.vendorId);
    const file = await workbook([craneRow(), craneRow()]);

    const res = await upload(file, {
      token: ctx.salesToken,
      vendorId: ctx.a.vendorId,
      dryRun: true,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary).toMatchObject({
      total: 2,
      imported: 0,
      valid: 2,
      skipped: 0,
      failed: 0,
    });
    expect(res.body.rows.every((row: { status: string }) => row.status === "valid")).toBe(true);
    expect(await craneCount(ctx.a.vendorId)).toBe(before);
  });

  it("imports every valid row into the chosen vendor", async () => {
    const rows = [
      craneRow({ make: "Liebherr", model: "LR 1300" }),
      craneRow({ make: "Demag", model: "CC 2500" }),
    ];
    const res = await upload(await workbook(rows), {
      token: ctx.salesToken,
      vendorId: ctx.a.vendorId,
      dryRun: false,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({ total: 2, imported: 2, failed: 0 });

    const saved = await appPrisma.crane.findMany({
      where: { serialRegistrationNo: { in: rows.map((row) => String(row.serialRegistrationNo)) } },
      select: { vendorId: true, make: true, capacityT: true },
    });
    expect(saved).toHaveLength(2);
    expect(saved.every((crane) => crane.vendorId === ctx.a.vendorId)).toBe(true);
  });

  it("lets an admin import for a vendor", async () => {
    const res = await upload(await workbook([craneRow()]), {
      token: ctx.adminToken,
      vendorId: ctx.a.vendorId,
      dryRun: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary.imported).toBe(1);
  });

  it("skips a serial already on the fleet and a repeat inside the same file", async () => {
    const fresh = String(craneRow().serialRegistrationNo);
    const file = await workbook([
      craneRow({ serialRegistrationNo: CRANE_SERIALS.a }),
      craneRow({ serialRegistrationNo: fresh }),
      craneRow({ serialRegistrationNo: fresh }),
    ]);

    const res = await upload(file, {
      token: ctx.salesToken,
      vendorId: ctx.a.vendorId,
      dryRun: false,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({ total: 3, imported: 1, skipped: 2, failed: 0 });

    const skipped = res.body.rows.filter(
      (row: { status: string }) => row.status === "skipped",
    );
    expect(skipped).toHaveLength(2);
    // The seeded crane was not overwritten, and only one new crane with the serial.
    expect(
      await appPrisma.crane.count({
        where: { vendorId: ctx.a.vendorId, serialRegistrationNo: fresh },
      }),
    ).toBe(1);
    expect(
      await appPrisma.crane.count({
        where: { vendorId: ctx.a.vendorId, serialRegistrationNo: CRANE_SERIALS.a },
      }),
    ).toBe(1);
  });

  it("imports valid rows and reports the failed ones, naming the row and column", async () => {
    const file = await workbook([
      craneRow({ pincode: "" }),
      craneRow({ capacityT: 0 }),
      craneRow({ typeOfCraneCode: "Space Elevator" }),
      craneRow(),
    ]);

    const res = await upload(file, {
      token: ctx.salesToken,
      vendorId: ctx.a.vendorId,
      dryRun: false,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({ total: 4, imported: 1, failed: 3 });

    const failed = res.body.rows.filter(
      (row: { status: string }) => row.status === "failed",
    );
    const messages = failed.map((row: { message: string }) => row.message).join(" | ");
    expect(messages).toMatch(/Pincode/i);
    expect(messages).toMatch(/Capacity/i);
    expect(messages).toMatch(/Crane type/i);
    // Excel row 2 is the first data row.
    expect(failed.map((row: { row: number }) => row.row)).toEqual([2, 3, 4]);
  });

  it("uses coordinates from a Google Maps cell before the pincode", async () => {
    const res = await upload(
      await workbook([
        craneRow({ googleMapsLocation: "https://www.google.com/maps/@22.3072,73.1812,17z" }),
      ]),
      { token: ctx.salesToken, vendorId: ctx.a.vendorId, dryRun: false },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toMatchObject({ imported: 1, unlocated: 0 });

    const crane = await appPrisma.crane.findFirst({
      where: { vendorId: ctx.a.vendorId, serialRegistrationNo: res.body.rows[0].serial },
      select: { latitude: true, longitude: true, coordinateSource: true },
    });
    expect(Number(crane?.latitude)).toBeCloseTo(22.3072, 4);
    expect(Number(crane?.longitude)).toBeCloseTo(73.1812, 4);
    expect(crane?.coordinateSource).toBe("manual");
  });

  it("falls back to the pincode when the Maps cell is not usable", async () => {
    const res = await upload(
      await workbook([craneRow({ googleMapsLocation: "https://example.com/not-a-map" })]),
      { token: ctx.salesToken, vendorId: ctx.a.vendorId, dryRun: false },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary.imported).toBe(1);
    expect(res.body.rows[0].warnings.join(" ")).toMatch(/not a Google Maps link/i);

    const crane = await appPrisma.crane.findFirst({
      where: { vendorId: ctx.a.vendorId, serialRegistrationNo: res.body.rows[0].serial },
      select: { latitude: true, longitude: true, coordinateSource: true },
    });
    // The stub provider gives the pincode path a point rather than nothing.
    expect(crane?.latitude).not.toBeNull();
    expect(crane?.coordinateSource).toBe("auto");
  });

  it("refuses more than 250 rows instead of importing part of the file", async () => {
    const rows = Array.from({ length: 251 }, () => craneRow());
    const res = await upload(await workbook(rows), {
      token: ctx.salesToken,
      vendorId: ctx.a.vendorId,
      dryRun: false,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/more than 250/i);
    expect(await craneCount(ctx.a.vendorId)).toBe(1);
  });

  it("refuses a sheet that is missing a mandatory column", async () => {
    const headers = SHEET_COLUMNS.filter((column) => column.key !== "pincode").map(
      (column) => column.label,
    );
    const res = await upload(await workbook([craneRow()], { headers }), {
      token: ctx.salesToken,
      vendorId: ctx.a.vendorId,
      dryRun: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pincode/i);
  });

  it("refuses non-spreadsheet bytes even when the name ends in .xlsx", async () => {
    const res = await callUpload(
      app,
      "POST",
      `/api/cranes/bulk?dryRun=true`,
      { buffer: Buffer.from("not a workbook"), fileName: "fleet.xlsx", mimeType: XLSX_MIME },
      { token: ctx.salesToken, fields: { vendorId: ctx.a.vendorId } },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid \.xlsx/i);
  });

  it("keeps a vendor out of the bulk path entirely", async () => {
    const res = await upload(await workbook([craneRow()]), {
      token: ctx.vendorToken,
      vendorId: ctx.a.vendorId,
      dryRun: true,
    });
    expect(res.status).toBe(403);
  });

  it("requires a vendor to be chosen", async () => {
    const res = await upload(await workbook([craneRow()]), {
      token: ctx.salesToken,
      vendorId: "",
      dryRun: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Choose the vendor/i);
  });

  it("does not email the vendor about the import", async () => {
    const res = await upload(await workbook([craneRow(), craneRow(), craneRow()]), {
      token: ctx.salesToken,
      vendorId: ctx.a.vendorId,
      dryRun: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary.imported).toBe(3);

    const mails = await appPrisma.emailLog.findMany({
      where: { template: "fleet_updated_on_behalf" },
      select: { entityId: true, toEmail: true },
    });
    expect(mails).toHaveLength(0);
  });

  it("records one summary audit entry", async () => {
    const res = await upload(await workbook([craneRow(), craneRow()]), {
      token: ctx.salesToken,
      vendorId: ctx.a.vendorId,
      dryRun: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const audits = await appPrisma.auditLog.findMany({
      where: { action: "crane_bulk_import", entityId: ctx.a.vendorId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.newValue).toMatchObject({ imported: 2, rows: 2, source: "xlsx" });
  });
});

describe("bulk upload template", () => {
  it("downloads a workbook with the expected headers and dropdown lists", async () => {
    const res = await callRaw(app, "/api/cranes/bulk/template", {
      token: ctx.salesToken,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(XLSX_MIME);
    expect(res.headers.get("content-disposition")).toMatch(/crossrentel-crane-upload\.xlsx/);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheet = book.getWorksheet("Cranes");
    expect(sheet).toBeDefined();

    const headers = SHEET_COLUMNS.map((column) =>
      String(sheet?.getRow(1).getCell(SHEET_COLUMNS.indexOf(column) + 1).value ?? ""),
    );
    expect(headers).toEqual(SHEET_COLUMNS.map((column) => column.label));

    // Every crane-type cell carries a list validation pointing at the Lists sheet.
    const typeColumn = SHEET_COLUMNS.findIndex((column) => column.key === "typeOfCraneCode") + 1;
    expect(sheet?.getRow(2).getCell(typeColumn).dataValidation?.type).toBe("list");
    expect(book.getWorksheet("Lists")).toBeDefined();
    expect(book.getWorksheet("Instructions")).toBeDefined();
  });

  it("is not available to a vendor user", async () => {
    const res = await callRaw(app, "/api/cranes/bulk/template", {
      token: ctx.vendorToken,
    });
    expect(res.status).toBe(403);
  });
});
