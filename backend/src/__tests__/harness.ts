import os from "os";
import path from "path";
import fs from "fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import bcrypt from "bcryptjs";
import { CRANE_SERIALS, INTERNAL_USERS, VENDOR_USERS } from "./fixtures";
import { encryptField, last4 } from "../utils/crypto";
import { DEFAULT_EMAIL_TEMPLATES } from "../services/emailTemplates";
import { MOBILISATION_RATES } from "../lib/mobilisationRates";

/**
 * Test harness.
 *
 * The isolation rules in brief 6.6 are the kind of thing that only holds if it
 * is exercised against a real database and a real HTTP request, so these
 * tests run against Postgres (TEST_DATABASE_URL) and drive the Express app in
 * process rather than mocking Prisma.
 *
 * Set up: migrate the test database, then TRUNCATE between tests. Nothing here
 * touches the development database.
 */

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

if (!TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Copy .env.example to .env and point it at a scratch database.",
  );
}

const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });

/** Raw client for TRUNCATE, which the generated client cannot express. */
export const testPrisma = new PrismaClient({ adapter });

/** The client the application under test uses. */
export const appPrisma = new PrismaClient({ adapter });

/**
 * Points the application modules at the test database.
 *
 * config/env reads process.env at import time and lib/database builds its
 * adapter from it, so both must be set before those modules are imported.
 * Vitest hoists imports, hence the dynamic import in the test files after
 * calling this.
 */
export function useTestDatabase(): void {
  process.env["DATABASE_URL"] = TEST_DATABASE_URL!;
  process.env["NODE_ENV"] = "test";
}

const scratchUploadDir =
  process.env["STORAGE_LOCAL_DIR"] ??
  path.join(os.tmpdir(), "crossrental-test-uploads");

/** Removes anything a test run left behind in the scratch storage directory. */
export async function clearTestUploads(): Promise<void> {
  await fs.rm(scratchUploadDir, { recursive: true, force: true });
}

/**
 * Every table in the public schema, read from the database rather than kept as
 * a hand-maintained list — a stale entry here fails the whole suite, and a new
 * migration should not need a test edit to be truncatable.
 */
async function allTables(): Promise<string[]> {
  const rows = await testPrisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname::text = current_schema() AND tablename <> '_prisma_migrations'
      ORDER BY tablename;`,
  );
  return rows.map((row) => `"${row.tablename}"`);
}

export async function resetTestDatabase(): Promise<void> {
  const tables = await allTables();
  await testPrisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE;`,
  );
}

export async function disconnectTestDatabases(): Promise<void> {
  await Promise.allSettled([testPrisma.$disconnect(), appPrisma.$disconnect()]);
}

// ---------------------------------------------------------------------------
// Fixtures — all values fabricated (brief working rule 3)
// ---------------------------------------------------------------------------

export interface SeededVendor {
  vendorId: string;
  userId: string;
  email: string;
  contactEmail: string;
  craneId: string;
  craneSerial: string;
}

export async function seedIsolationFixtures(): Promise<{
  vendorA: SeededVendor;
  vendorB: SeededVendor;
  adminId: string;
  salesId: string;
}> {
  const passwordHash = await bcrypt.hash("Vendor@Portal2026", 12);

  const states = ["GJ", "MH", "AP"].map((code) => ({
    code,
    name: `State ${code}`,
  }));
  for (const state of states) {
    await appPrisma.state.upsert({
      where: { code: state.code },
      create: state,
      update: {},
    });
  }
  await appPrisma.craneType.upsert({
    where: { code: "CRAWLER" },
    create: { code: "CRAWLER", name: "Crawler Crane", sortOrder: 10 },
    update: {},
  });

  // P2: the mobilisation rate table the recommendation engine prices from.
  // Only rates whose crane type exists in the fixtures — the rate table has a
  // foreign key and the harness seeds a smaller crane-type list than production.
  const craneTypeCodes = new Set(
    (await appPrisma.craneType.findMany({ select: { code: true } })).map(
      (type) => type.code,
    ),
  );
  const rateRows = MOBILISATION_RATES.filter((rate) =>
    craneTypeCodes.has(rate.craneTypeCode),
  ).map((rate) => ({
    craneTypeCode: rate.craneTypeCode,
    capacityMinT: rate.capacityMinT,
    capacityMaxT: rate.capacityMaxT,
    ownershipType: rate.ownershipType ?? null,
    ratePerKm: rate.ratePerKm,
  }));
  if (rateRows.length > 0) {
    await appPrisma.mobilisationRate.createMany({ data: rateRows });
  }

  async function makeVendor(key: "a" | "b"): Promise<SeededVendor> {
    const email = VENDOR_USERS[key];
    const suffix = key.toUpperCase();
    const serial = CRANE_SERIALS[key];

    const bankAccountNo = `9000000000${key === "a" ? "1" : "2"}`;

    const vendor = await appPrisma.vendor.create({
      data: {
        name: `Isolation Vendor ${suffix}`,
        natureOfCompany: "PROPRIETORSHIP",
        addressLine1: `${suffix} Test Address`,
        city: `${suffix} City`,
        district: `${suffix} District`,
        stateCode: "GJ",
        pincode: "396000",
        telephone: "+91 90000 00000",
        email,
        pan: `AAAAA0000${suffix}`,
        gstRegistered: true,
        gstn: `27AAAAA0000${suffix}1Z5`,
        gstRegistrationType: "REGULAR",
        msmeRegistered: true,
        msmeCategory: "MICRO",
        msmeRegNo: `MSME${suffix}0001`,
        tdsLowerDeduction: false,
        codeOfConductAccepted: true,
        declarationName: `Owner ${suffix}`,
        declarationDesignation: "Proprietor",
        declarationDate: new Date(),
        onboardingStatus: "APPROVED",
        approvedAt: new Date(),
        bankName: "Isolation Bank",
        bankBranch: `${suffix} Branch`,
        bankAccountType: "CURRENT",
        bankAccountNoEnc: encryptField(bankAccountNo),
        bankAccountNoLast4: last4(bankAccountNo),
        bankIfscEnc: encryptField(`ISO000000${suffix}`),
        operatingRegions: { create: [{ stateCode: "GJ" }] },
        contacts: {
          create: [
            {
              name: `Contact ${suffix}`,
              mobile: "+91 90000 00001",
              email,
              isPrimary: true,
            },
          ],
        },
        users: {
          create: [
            {
              email,
              fullName: `Vendor ${suffix}`,
              role: "vendor_user",
              passwordHash,
              activatedAt: new Date(),
            },
          ],
        },
      },
      select: { id: true, users: { select: { id: true } } },
    });

    const crane = await appPrisma.crane.create({
      data: {
        vendorId: vendor.id,
        serialRegistrationNo: serial,
        typeOfCraneCode: "CRAWLER",
        capacityT: 250,
        currentStatus: "AVAILABLE",
        currentLocation: `${suffix} Yard`,
        stateCode: "GJ",
        make: "Demo",
        model: `Model-${suffix}`,
        yom: 2022,
        mainBoomM: 50,
        latitude: 22.5,
        longitude: 72.5,
        coordinateSource: "manual",
      },
      select: { id: true },
    });

    return {
      vendorId: vendor.id,
      userId: vendor.users[0].id,
      email,
      contactEmail: email,
      craneId: crane.id,
      craneSerial: serial,
    };
  }

  const vendorA = await makeVendor("a");
  const vendorB = await makeVendor("b");

  const admin = await appPrisma.user.create({
    data: {
      email: INTERNAL_USERS.admin,
      fullName: "Admin",
      role: "admin_user",
    },
    select: { id: true },
  });
  const sales = await appPrisma.user.create({
    data: {
      email: INTERNAL_USERS.sales,
      fullName: "Sales",
      role: "sales_user",
    },
    select: { id: true },
  });

  // Every authenticated test needs at least one app setting row.
  await appPrisma.appSetting.createMany({
    data: [
      { key: "FLEET_APPROVAL_REQUIRED", value: "false" },
      { key: "STALE_DUE_DAYS", value: "30" },
      { key: "STALE_FLAG_DAYS", value: "60" },
      { key: "STALE_REMINDER_REPEAT_DAYS", value: "7" },
      { key: "RFQ_REMINDER_LEAD_HOURS", value: "24" },
      { key: "RFQ_REMINDER_MIN_WINDOW_HOURS", value: "4" },
      { key: "ALERT_RFQ_SLA_HOURS", value: "48" },
      { key: "ALERT_QUOTATION_EXPIRY_DAYS", value: "3" },
      { key: "ALERT_BOOKING_LEAD_DAYS", value: "7" },
      { key: "ALERT_EMAILS_ENABLED", value: "false" },
      { key: "REPORT_RETENTION_MONTHS", value: "84" },
    ],
  });

  // resetTestDatabase truncates email_templates along with everything else, and
  // sendTemplate refuses to run without a template row. The M2 onboarding flow
  // sends four of them (invitation, submitted, approved, rejected), so the same
  // defaults the real seed installs are recreated here rather than stubbed.
  await appPrisma.emailTemplate.createMany({
    data: DEFAULT_EMAIL_TEMPLATES.map((t) => ({
      key: t.key,
      subject: t.subject,
      bodyHtml: t.bodyHtml,
    })),
  });

  return { vendorA, vendorB, adminId: admin.id, salesId: sales.id };
}

/** Minimal fetch-like caller over the Express app, returning status + body. */
export async function call(
  app: import("express").Express,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: any }> {
  const http = await import("http");

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        // One request per server, and the server is closed straight after. Node's
        // fetch pools sockets globally, so without this a pooled socket can be
        // reused after its server is gone and fail the request with ECONNRESET.
        Connection: "close",
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } finally {
    // closeAllConnections() before close(): `Connection: close` asks the peer to
    // hang up but does not destroy the socket on our side, so close() could
    // return while a connection was still live and Node's global fetch pool
    // handed that dead socket to the next request — which surfaced as an
    // intermittent ECONNRESET, and occasionally as a response that never came
    // back at all. Destroying first makes the teardown deterministic.
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}
// ---------------------------------------------------------------------------
// Multipart and internal-auth helpers
// ---------------------------------------------------------------------------

/**
 * Posts a single file as multipart/form-data.
 *
 * Document uploads go through multer's magic-byte sniffing, so the bytes sent
 * here have to be a real file, not a JSON string. `kind` picks a minimal valid
 * file of that type.
 */
export type UploadKind = "pdf" | "png" | "jpeg" | "text";

export function sampleUpload(kind: UploadKind = "pdf"): {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
} {
  switch (kind) {
    case "png":
      return {
        buffer: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from("fabricated-png-payload"),
        ]),
        fileName: "sample.png",
        mimeType: "image/png",
      };
    case "jpeg":
      return {
        buffer: Buffer.concat([
          Buffer.from([0xff, 0xd8, 0xff]),
          Buffer.from("fabricated-jpeg-payload"),
        ]),
        fileName: "sample.jpg",
        mimeType: "image/jpeg",
      };
    case "text":
      // Deliberately not an allowed type, for the rejection tests.
      return {
        buffer: Buffer.from("#!/bin/sh\necho not really a pdf\n"),
        fileName: "sample.pdf",
        mimeType: "application/pdf",
      };
    case "pdf":
    default:
      return {
        buffer: Buffer.concat([
          Buffer.from("%PDF-1.7\n"),
          Buffer.from("fabricated pdf payload for tests\n%%EOF\n"),
        ]),
        fileName: "sample.pdf",
        mimeType: "application/pdf",
      };
  }
}

export async function callUpload(
  app: import("express").Express,
  method: "POST" | "PUT",
  path: string,
  file: { buffer: Buffer; fileName: string; mimeType: string },
  options: {
    token?: string;
    field?: string;
    fields?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const http = await import("http");

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const form = new FormData();
    // `fields` carries the JSON body alongside the file. A route that accepts an
    // optional upload still needs its ordinary fields, and a real client sends
    // both in one multipart request, so the tests should too.
    for (const [key, value] of Object.entries(options.fields ?? {})) {
      form.append(key, value);
    }
    form.append(
      options.field ?? "file",
      new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
      file.fileName,
    );

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Connection: "close",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        // Deliberately no Content-Type: fetch must set the multipart boundary.
      },
      body: form,
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body, headers: response.headers };
  } finally {
    // closeAllConnections() before close(): `Connection: close` asks the peer to
    // hang up but does not destroy the socket on our side, so close() could
    // return while a connection was still live and Node's global fetch pool
    // handed that dead socket to the next request — which surfaced as an
    // intermittent ECONNRESET, and occasionally as a response that never came
    // back at all. Destroying first makes the teardown deterministic.
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

/** Fetches a binary endpoint (document download) and returns the raw bytes. */
export async function callRaw(
  app: import("express").Express,
  path: string,
  options: { token?: string } = {},
): Promise<{ status: number; buffer: Buffer; headers: Headers }> {
  const http = await import("http");

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "GET",
      headers: {
        Connection: "close",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, buffer, headers: response.headers };
  } finally {
    // closeAllConnections() before close(): `Connection: close` asks the peer to
    // hang up but does not destroy the socket on our side, so close() could
    // return while a connection was still live and Node's global fetch pool
    // handed that dead socket to the next request — which surfaced as an
    // intermittent ECONNRESET, and occasionally as a response that never came
    // back at all. Destroying first makes the teardown deterministic.
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

/**
 * Mints a session token for an internal user.
 *
 * Internal users normally exchange an OTP for a token, but these tests are not
 * testing OTP delivery — going through the real OTP flow for every admin call
 * would bury the onboarding assertions in unrelated setup. `requireAuth` still
 * re-reads the user row on every request, so an inactive or deleted user is
 * still refused exactly as it would be in production.
 */
export async function internalToken(
  userId: string,
  email: string,
  role: "admin_user" | "sales_user" | "management_viewer",
): Promise<string> {
  const { signAuthToken } = await import("../utils/jwt");
  return signAuthToken({ sub: userId, email, role, vendorId: null });
}

/** Reference data needed to build a valid onboarding payload. */
export const STATES = ["GJ", "MH", "KA"] as const;
export const CITIES_BY_STATE: Record<string, string> = {
  GJ: "Ahmedabad",
  MH: "Pune",
  KA: "Bengaluru",
};
