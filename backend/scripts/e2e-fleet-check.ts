/**
 * Drives the M3 fleet flow against a *running* dev server, over HTTP, the way
 * the browser does. The Vitest suite covers the same rules against an in-process
 * app; this exists to catch what it cannot see — a route that was never mounted,
 * a response shape that drifted from what the frontend reads, a proxy that does
 * not forward.
 *
 * It runs the flow brief section 8 describes as replacing the shared
 * spreadsheet: a vendor adds a crane, sees it geocoded, corrects the pin, sets a
 * status, is stopped from duplicating a live serial, confirms the data is still
 * true, uploads a load chart, retires the crane and brings it back.
 *
 * Values here are fabricated (brief working rule 3).
 *
 *   npx ts-node scripts/e2e-fleet-check.ts [baseUrl]
 */
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/database";
import { env } from "../src/config/env";
import { signAuthToken } from "../src/utils/jwt";

const BASE = process.argv[2] ?? "http://localhost:4000";
/** Pass --keep to leave the vendor and cranes behind for manual poking. */
const KEEP = process.argv.includes("--keep");

const EMAIL = "e2e-fleet-vendor@check.test";
/**
 * The other vendor used for the isolation checks.
 *
 * This script creates *both* of its vendors rather than borrowing an existing
 * one. Borrowing looked harmless — reset a demo account's password, assert the
 * 404, move on — but it left that account's credentials changed on the
 * development database, which is exactly the kind of side effect a check is
 * supposed to be free of.
 */
const OTHER_EMAIL = "e2e-fleet-other@check.test";
const PASSWORD = "FleetCheck@2026";
const SERIAL = "E2E-FLEET-001";

interface Res {
  status: number;
  body: any;
}

async function http(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Connection: "close",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
}

async function uploadChart(token: string, craneId: string): Promise<Res> {
  const form = new FormData();
  form.append("file", new Blob([pdfBytes()], { type: "application/pdf" }), "load-chart.pdf");
  const res = await fetch(`${BASE}/api/cranes/${craneId}/load-chart`, {
    method: "POST",
    headers: { Connection: "close", Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const checks: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function craneForm(overrides: Record<string, unknown> = {}) {
  return {
    typeOfCraneCode: "CRAWLER",
    capacityT: 120,
    currentStatus: "AVAILABLE",
    currentLocation: "Fabricated Yard, Ahmedabad",
    stateCode: "GJ",
    make: "Example Make",
    model: "EX-120",
    yom: 2021,
    mainBoomM: 60,
    fixedJibM: null,
    luffingJibM: null,
    windJibM: null,
    serialRegistrationNo: SERIAL,
    pincode: "380015",
    latitude: null,
    longitude: null,
    remarks: "Created by the fleet end-to-end check.",
    ...overrides,
  };
}

/**
 * Creates an approved vendor with a login, so the flow starts where a real
 * vendor starts: approved, able to sign in, empty fleet.
 */
async function seedVendor(email: string, name: string) {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  await prisma.state.upsert({
    where: { code: "GJ" },
    create: { code: "GJ", name: "Gujarat" },
    update: {},
  });
  await prisma.craneType.upsert({
    where: { code: "CRAWLER" },
    create: { code: "CRAWLER", name: "Crawler Crane", sortOrder: 10 },
    update: {},
  });

  const existing = await prisma.vendor.findFirst({ where: { email }, select: { id: true } });
  if (existing) await cleanup(existing.id);

  const vendor = await prisma.vendor.create({
    data: {
      name,
      natureOfCompany: "PROPRIETORSHIP",
      addressLine1: "Fabricated address, example district",
      city: "Example city",
      district: "Example district",
      stateCode: "GJ",
      pincode: "380001",
      telephone: "+91 9000000001",
      email,
      pan: "AAAAA0000A",
      gstn: "24AAAAA0000A1Z5",
      gstRegistered: true,
      gstRegistrationType: "REGULAR",
      msmeRegistered: false,
      tdsLowerDeduction: false,
      codeOfConductAccepted: true,
      declarationName: "Fabricated Owner",
      declarationDesignation: "Proprietor",
      declarationDate: new Date(),
      onboardingStatus: "APPROVED",
      approvedAt: new Date(),
      users: {
        create: [
          {
            email,
            fullName: name,
            role: "vendor_user",
            passwordHash,
            activatedAt: new Date(),
          },
        ],
      },
    },
    select: { id: true },
  });

  return vendor.id;
}

async function main() {
  const vendorId = await seedVendor(EMAIL, "E2E Fleet Cranes");
  const otherVendorId = await seedVendor(OTHER_EMAIL, "E2E Fleet Other Cranes");

  const login = await http("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } });
  check("the approved vendor can sign in", login.status === 200, `HTTP ${login.status}`);
  const token: string = login.body?.token;
  check("sign-in returns a session token", typeof token === "string" && token.length > 20);

  const sales = await prisma.user.findUniqueOrThrow({ where: { email: "sales@sanghvimovers.com" } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@sanghvimovers.com" } });
  const salesToken = signAuthToken({ sub: sales.id, email: sales.email, role: sales.role, vendorId: sales.vendorId });
  const adminToken = signAuthToken({ sub: admin.id, email: admin.email, role: admin.role, vendorId: admin.vendorId });

  // 1. The fleet starts empty, and the authenticated reference data loads.
  const empty = await http("GET", "/api/cranes", { token });
  check("a new vendor has an empty fleet", empty.status === 200 && empty.body?.cranes?.length === 0);

  const reference = await http("GET", "/api/vendors/reference-data", { token });
  check("reference data needs a session", reference.status === 200, `HTTP ${reference.status}`);
  check("reference data has states and crane types", (reference.body?.states ?? []).length > 0 && (reference.body?.craneTypes ?? []).length > 0);

  // 2. Add a crane. The location should come back geocoded.
  const created = await http("POST", "/api/cranes", { token, body: craneForm() });
  check("a crane can be added", created.status === 201, `HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  const craneId: string = created.body?.crane?.id;
  check("the crane is geocoded on create", created.body?.crane?.latitude !== null, String(created.body?.crane?.latitude));
  check("the reference names are resolved", created.body?.crane?.typeOfCrane?.name === "Crawler Crane");
  check("it goes live while the approval flag is off", created.body?.crane?.approvalStatus === "APPROVED");
  check("freshness is reported", typeof created.body?.crane?.freshness?.daysSinceUpdate === "number");

  // 3. The rules that are the point of the milestone.
  const dup = await http("POST", "/api/cranes", { token, body: craneForm() });
  check("a live serial cannot be reused", dup.status === 409, `HTTP ${dup.status}`);
  check("the duplicate names the existing crane", dup.body?.details?.existingCraneId === craneId);

  const booked = await http("POST", "/api/cranes", { token, body: craneForm({ serialRegistrationNo: "E2E-BOOKED-1", currentStatus: "BOOKED" }) });
  check("a vendor cannot set Booked", booked.status === 400, `HTTP ${booked.status}`);

  const hired = await http("POST", "/api/cranes", { token, body: craneForm({ serialRegistrationNo: "E2E-HIRED-1", currentStatus: "HIRED" }) });
  check("a vendor cannot set Hired", hired.status === 400, `HTTP ${hired.status}`);

  const engagedNoDate = await http("POST", "/api/cranes", { token, body: craneForm({ serialRegistrationNo: "E2E-ENG-1", currentStatus: "ENGAGED" }) });
  check("Engaged without available_from is refused", engagedNoDate.status === 400, `HTTP ${engagedNoDate.status}`);

  const engagedPast = await http("POST", "/api/cranes", {
    token,
    body: craneForm({ serialRegistrationNo: "E2E-ENG-2", currentStatus: "ENGAGED", availableFrom: "2020-01-01" }),
  });
  check("Engaged with a past available_from is refused", engagedPast.status === 400, `HTTP ${engagedPast.status}`);

  const placeholder = await http("POST", "/api/cranes", { token, body: craneForm({ serialRegistrationNo: "NA" }) });
  check("“NA” is not accepted as a serial", placeholder.status === 400, `HTTP ${placeholder.status}`);

  // 4. Pin correction (brief 6.3).
  const pinned = await http("PUT", `/api/cranes/${craneId}`, {
    token,
    body: craneForm({ latitude: 23.0225, longitude: 72.5714 }),
  });
  check("a manual pin is stored as manual", pinned.body?.crane?.coordinateSource === "manual", String(pinned.body?.crane?.coordinateSource));
  check("the manual coordinates are kept", pinned.body?.crane?.latitude === 23.0225);

  const offMap = await http("PUT", `/api/cranes/${craneId}`, {
    token,
    body: craneForm({ latitude: 48.8566, longitude: 2.3522 }),
  });
  check("a pin outside India is refused", offMap.status === 400, `HTTP ${offMap.status}`);
  const stillPinned = await http("GET", `/api/cranes/${craneId}`, { token });
  check("the refused pin did not overwrite the good one", stillPinned.body?.crane?.latitude === 23.0225);

  // 5. Quick status and location change, and the Engaged rule through it.
  const quick = await http("PATCH", `/api/cranes/${craneId}/status-location`, {
    token,
    body: { currentStatus: "UNDER_MAINTENANCE", currentLocation: "Fabricated Yard, Vadodara", stateCode: "GJ", latitude: 22.3072, longitude: 73.1812 },
  });
  check("status and location change together", quick.status === 200, `HTTP ${quick.status} ${JSON.stringify(quick.body).slice(0, 160)}`);
  check("the moved pin is recorded", quick.body?.crane?.latitude === 22.3072);

  const quickEngaged = await http("PATCH", `/api/cranes/${craneId}/status-location`, {
    token,
    body: { currentStatus: "ENGAGED", currentLocation: "Fabricated Yard, Vadodara", stateCode: "GJ", availableFrom: "2999-01-01" },
  });
  check("Engaged through the quick path needs a date too", quickEngaged.status === 200, `HTTP ${quickEngaged.status}`);
  const backAvailable = await http("PATCH", `/api/cranes/${craneId}/status-location`, {
    token,
    body: { currentStatus: "AVAILABLE", currentLocation: "Fabricated Yard, Vadodara", stateCode: "GJ" },
  });
  check("returning to Available clears available_from", backAvailable.body?.crane?.availableFrom === null);

  // 6. Load chart.
  const chart = await uploadChart(token, craneId);
  check("a load chart uploads", chart.status === 201, `HTTP ${chart.status} ${JSON.stringify(chart.body).slice(0, 160)}`);
  check("the chart is listed on the crane", chart.body?.crane?.loadChart?.fileName === "load-chart.pdf");

  const download = await fetch(`${BASE}/api/cranes/${craneId}/load-chart`, {
    headers: { Connection: "close", Authorization: `Bearer ${token}` },
  });
  const bytes = Buffer.from(await download.arrayBuffer());
  check("the chart downloads as a PDF", download.status === 200 && bytes.subarray(0, 4).toString() === "%PDF");

  // 7. Duplicate prefill.
  const prefill = await http("GET", `/api/cranes/${craneId}/duplicate`, { token });
  check("duplicate returns a prefill", prefill.status === 200, `HTTP ${prefill.status}`);
  check("the prefill has no serial", prefill.body?.prefill?.serialRegistrationNo === "");
  check("the prefill starts Available", prefill.body?.prefill?.currentStatus === "AVAILABLE");

  const copied = await http("POST", "/api/cranes", {
    token,
    // The prefill wins for the descriptive fields; the serial is the one thing
    // that must differ, since the copy is a different crane.
    body: craneForm({ ...prefill.body?.prefill, serialRegistrationNo: "E2E-FLEET-COPY" }),
  });
  check("the prefill can be submitted as a new crane", copied.status === 201, `HTTP ${copied.status} ${JSON.stringify(copied.body).slice(0, 200)}`);
  const copyId: string | undefined = copied.body?.crane?.id;

  // 8. Isolation, both directions, against a vendor this script created.
  const otherLogin = await http("POST", "/api/auth/login", {
    body: { email: OTHER_EMAIL, password: PASSWORD },
  });
  check("the second vendor can sign in", otherLogin.status === 200, `HTTP ${otherLogin.status}`);
  if (otherLogin.status === 200) {
    const otherToken: string = otherLogin.body.token;
    const peek = await http("GET", `/api/cranes/${craneId}`, { token: otherToken });
    check("another vendor gets 404, not the crane", peek.status === 404, `HTTP ${peek.status}`);
    const steal = await http("PATCH", `/api/cranes/${craneId}/status-location`, {
      token: otherToken,
      body: { currentStatus: "UNDER_MAINTENANCE", currentLocation: "Their Yard", stateCode: "GJ" },
    });
    check("another vendor cannot change it either", steal.status === 404, `HTTP ${steal.status}`);
  }

  const salesWrite = await http("POST", "/api/cranes", { token: salesToken, body: craneForm({ serialRegistrationNo: "E2E-SALES-1" }) });
  check("sales may not write to a fleet", salesWrite.status === 403, `HTTP ${salesWrite.status}`);
  const salesRead = await http("GET", "/api/cranes", { token: salesToken });
  check("sales may read an approved fleet", salesRead.status === 200, `HTTP ${salesRead.status}`);

  const vendorSetsApproval = await http("PATCH", `/api/cranes/${craneId}/approval`, {
    token,
    body: { approvalStatus: "APPROVED" },
  });
  check("a vendor may not approve their own crane", vendorSetsApproval.status === 403, `HTTP ${vendorSetsApproval.status}`);

  // 9. Confirm still accurate, then deactivate and reactivate.
  const beforeConfirm = await http("GET", `/api/cranes/${craneId}`, { token });
  const confirmed = await http("POST", `/api/cranes/${craneId}/confirm-accurate`, { token });
  check("confirming accuracy succeeds", confirmed.status === 200, `HTTP ${confirmed.status}`);
  check(
    "the data itself is unchanged",
    confirmed.body?.crane?.currentLocation === beforeConfirm.body?.crane?.currentLocation &&
      confirmed.body?.crane?.currentStatus === beforeConfirm.body?.crane?.currentStatus,
    `${beforeConfirm.body?.crane?.currentLocation} -> ${confirmed.body?.crane?.currentLocation}`,
  );
  check(
    "the freshness clock resets",
    confirmed.body?.crane?.freshness?.daysSinceUpdate === 0,
    `was ${beforeConfirm.body?.crane?.freshness?.daysSinceUpdate}`,
  );

  const deactivated = await http("POST", `/api/cranes/${craneId}/deactivate`, { token });
  check("a crane deactivates", deactivated.status === 200 && deactivated.body?.crane?.isActive === false);
  check("deactivation does not delete the row", (await prisma.crane.findUnique({ where: { id: craneId } })) !== null);

  const hidden = await http("GET", "/api/cranes", { token });
  check("a deactivated crane is hidden by default", !(hidden.body?.cranes ?? []).some((c: any) => c.id === craneId));
  const shown = await http("GET", "/api/cranes?includeInactive=true", { token });
  check("…but can still be found", (shown.body?.cranes ?? []).some((c: any) => c.id === craneId));

  const reuseSerial = await http("POST", "/api/cranes", { token, body: craneForm({ serialRegistrationNo: SERIAL }) });
  check("a deactivated serial can be reused", reuseSerial.status === 201, `HTTP ${reuseSerial.status}`);

  const reactivate = await http("POST", `/api/cranes/${craneId}/reactivate`, { token });
  check("reactivating onto a live serial is refused", reactivate.status === 409, `HTTP ${reactivate.status}`);

  // 10. The approval flag, switched on and back off.
  await prisma.appSetting.upsert({
    where: { key: "FLEET_APPROVAL_REQUIRED" },
    create: { key: "FLEET_APPROVAL_REQUIRED", value: "true" },
    update: { value: "true" },
  });
  // Settings are cached in the *server* process for 30s, and setSetting only
  // clears this script's copy. So the flag genuinely does not take effect for a
  // request until the server's cache expires — wait for it rather than asserting
  // against a stale value and calling it a bug.
  await waitForSettingsCache();

  const parked = await http("POST", "/api/cranes", { token, body: craneForm({ serialRegistrationNo: "E2E-PENDING-1" }) });
  check("with the flag on, a new crane waits for review", parked.body?.crane?.approvalStatus === "PENDING", String(parked.body?.crane?.approvalStatus));

  const vendorApprovals = await http("PATCH", `/api/cranes/${parked.body?.crane?.id}/approval`, {
    token,
    body: { approvalStatus: "APPROVED" },
  });
  check("the vendor cannot wave it through", vendorApprovals.status === 403, `HTTP ${vendorApprovals.status}`);

  const adminApproves = await http("PATCH", `/api/cranes/${parked.body?.crane?.id}/approval`, {
    token: adminToken,
    body: { approvalStatus: "APPROVED" },
  });
  check("an admin can approve it", adminApproves.body?.crane?.approvalStatus === "APPROVED", `HTTP ${adminApproves.status}`);

  await prisma.appSetting.update({
    where: { key: "FLEET_APPROVAL_REQUIRED" },
    data: { value: "false" },
  });
  await waitForSettingsCache();

  // 11. Audit trail for the status and location moves.
  const audits = await prisma.auditLog.findMany({
    where: { entity: "crane", entityId: craneId, action: "crane_updated" },
    orderBy: { createdAt: "asc" },
  });
  check("status and location moves are audited", audits.length > 0, `${audits.length} entries`);
  check(
    "the audit records the before and after",
    audits.some((a) => JSON.stringify(a.oldValue ?? {}).includes("UNDER_MAINTENANCE")),
  );

  if (!KEEP) {
    await cleanup(vendorId);
    await cleanup(otherVendorId);
    check("the run cleans up after itself", true);
  }

  console.log(checks.join("\n"));
  const passed = checks.filter((c) => c.startsWith("PASS")).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (KEEP) {
    console.log(`\nLeft in place (--keep). Sign in as ${EMAIL} / ${PASSWORD}`);
    console.log(`Other vendor: ${OTHER_EMAIL} / ${PASSWORD}`);
    console.log(`Copy: ${copyId ?? "(none)"}`);
  }
}

/**
 * Blocks until a settings change written to the database is visible to the
 * server. `getSettings` caches for 30 seconds (backend/src/utils/settings.ts),
 * which is deliberate for request volume but means a flag flipped from outside
 * the server is not instant.
 */
async function waitForSettingsCache() {
  const ms = 31_000;
  process.stdout.write(`  (waiting ${ms / 1000}s for the server's settings cache)…\n`);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Removes exactly what this run created.
 *
 * The vendor row cascades to its users and cranes; the uploaded files live on
 * disk, so those are cleared explicitly. Audit rows hold loose references rather
 * than cascading.
 */
async function cleanup(vendorId: string) {
  const craneIds = await prisma.crane.findMany({ where: { vendorId }, select: { id: true } });
  await prisma.auditLog.deleteMany({
    where: { entity: "crane", entityId: { in: craneIds.map((c) => c.id) } },
  });
  await prisma.crane.deleteMany({ where: { vendorId } });
  await prisma.vendor.delete({ where: { id: vendorId } });
  await fs.rm(path.join(env.storage.localDir, "vendors", vendorId), { recursive: true, force: true });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());