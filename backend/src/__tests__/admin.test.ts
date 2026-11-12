import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  appPrisma,
  call,
  clearTestUploads,
  disconnectTestDatabases,
  internalToken,
  resetTestDatabase,
  seedIsolationFixtures,
  useTestDatabase,
} from "./harness";
import { INTERNAL_USERS, VENDOR_PASSWORD, VENDOR_USERS } from "./fixtures";

/**
 * P0 B: the admin dashboard (B1) and staff management + vendor suspension (B2).
 *
 * Every route sits behind `vendor:approve`, held by admin and not by sales.
 */

let app: Express;

async function adminToken() {
  const fixtures = await seedIsolationFixtures();
  const token = await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user");
  return { fixtures, token };
}

async function signInVendor(email: string) {
  return call(app, "POST", "/api/auth/login", {
    body: { email, password: VENDOR_PASSWORD },
  });
}

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

describe("admin dashboard (P0 B1)", () => {
  it("reports zero counters on a clean fixture", async () => {
    const { token } = await adminToken();
    const res = await call(app, "GET", "/api/admin/dashboard", { token });
    expect(res.status).toBe(200);
    expect(res.body.dashboard.counts).toEqual({
      awaitingApproval: 0,
      rfqsWithFailures: 0,
      cranesStale: 0,
      cranesUnverified: 0,
      cranesLapsed: 0,
      fleetPendingValidation: 0,
      unmatchedQuotationResponses: 0,
      failedEmails: 0,
    });
  });

  it("counts each of the five conditions", async () => {
    const { fixtures, token } = await adminToken();

    // A registration waiting on a decision.
    await appPrisma.vendor.update({
      where: { id: fixtures.vendorA.vendorId },
      data: { onboardingStatus: "SUBMITTED", approvedAt: null },
    });

    // An RFQ with a failed delivery.
    await appPrisma.rfq.create({
      data: {
        rfqNumber: "SP/TEST/0001",
        enquiryNo: "ENQ-1",
        lineNo: "10",
        craneType: "CRAWLER",
        capacityT: 100,
        siteLocation: "Ahmedabad",
        siteStateCode: "GJ",
        requiredStartDate: new Date(),
        durationValue: 1,
        durationUnit: "MONTHS",
        submissionDeadline: new Date(Date.now() + 86_400_000),
        createdById: fixtures.adminId,
        recipients: {
          create: [
            {
              vendorId: fixtures.vendorB.vendorId,
              emails: ["ops@vendor.test"],
              emailDeliveryStatus: "FAILED",
            },
          ],
        },
      },
    });

    // Vendor A's crane is stale (untouched for 61 days).
    await appPrisma.crane.update({
      where: { id: fixtures.vendorA.craneId },
      data: { statusUpdatedAt: new Date(Date.now() - 61 * 86_400_000) },
    });

    // Vendor B's crane has no location and a lapsed release date.
    await appPrisma.crane.update({
      where: { id: fixtures.vendorB.craneId },
      data: {
        latitude: null,
        longitude: null,
        coordinateSource: null,
        currentStatus: "ENGAGED",
        availableFrom: new Date(Date.now() - 86_400_000),
      },
    });

    const res = await call(app, "GET", "/api/admin/dashboard", { token });
    expect(res.status).toBe(200);
    expect(res.body.dashboard.counts).toEqual({
      awaitingApproval: 1,
      rfqsWithFailures: 1,
      cranesStale: 1,
      cranesUnverified: 1,
      cranesLapsed: 1,
      fleetPendingValidation: 0,
      unmatchedQuotationResponses: 0,
      failedEmails: 0,
    });
    expect(res.body.dashboard.thresholds.staleFlagDays).toBe(60);
  });

  it("refuses sales and unauthenticated callers", async () => {
    const fixtures = await seedIsolationFixtures();
    const sales = await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user");
    expect((await call(app, "GET", "/api/admin/dashboard", { token: sales })).status).toBe(403);
    expect((await call(app, "GET", "/api/admin/dashboard")).status).toBe(401);
  });
});

describe("internal user management (P0 B2)", () => {
  it("lists the internal users and creates a sales user", async () => {
    const { token } = await adminToken();

    const before = await call(app, "GET", "/api/admin/users", { token });
    expect(before.status).toBe(200);
    expect(before.body.users.map((u: { role: string }) => u.role).sort()).toEqual([
      "admin_user",
      "sales_user",
    ]);

    const created = await call(app, "POST", "/api/admin/users", {
      token,
      body: { email: "New.Sales@SML.test", fullName: "New Sales", role: "sales_user" },
    });
    expect(created.status).toBe(201);
    expect(created.body.user.email).toBe("new.sales@sml.test");
    expect(created.body.user.role).toBe("sales_user");
    expect(created.body.user.isActive).toBe(true);

    // Internal users are OTP-only: no password hash is set.
    const row = await appPrisma.user.findUniqueOrThrow({
      where: { id: created.body.user.id },
      select: { passwordHash: true },
    });
    expect(row.passwordHash).toBeNull();

    const after = await call(app, "GET", "/api/admin/users", { token });
    expect(after.body.users.some((u: { id: string }) => u.id === created.body.user.id)).toBe(true);
  });

  it("refuses a duplicate email and a vendor role", async () => {
    const { token } = await adminToken();
    const dup = await call(app, "POST", "/api/admin/users", {
      token,
      body: { email: INTERNAL_USERS.sales, role: "sales_user" },
    });
    expect(dup.status).toBe(409);

    const vendorRole = await call(app, "POST", "/api/admin/users", {
      token,
      body: { email: "x@sml.test", role: "vendor_user" },
    });
    expect(vendorRole.status).toBe(400);
  });

  it("changes a role and disables an account, killing its live token", async () => {
    const { token } = await adminToken();
    const created = await call(app, "POST", "/api/admin/users", {
      token,
      body: { email: "temp@sml.test", role: "sales_user" },
    });
    const id = created.body.user.id as string;
    const theirToken = await internalToken(id, "temp@sml.test", "sales_user");

    // The new user can reach the dashboard gate before being disabled.
    expect((await call(app, "GET", "/api/admin/users", { token: theirToken })).status).toBe(403);

    const promoted = await call(app, "PATCH", `/api/admin/users/${id}`, {
      token,
      body: { role: "admin_user" },
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.user.role).toBe("admin_user");

    // A fresh token now carries admin and is accepted.
    const promotedToken = await internalToken(id, "temp@sml.test", "admin_user");
    expect((await call(app, "GET", "/api/admin/dashboard", { token: promotedToken })).status).toBe(200);

    const disabled = await call(app, "PATCH", `/api/admin/users/${id}`, {
      token,
      body: { isActive: false },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.user.isActive).toBe(false);

    // The deactivated account cannot use a token it already holds.
    const blocked = await call(app, "GET", "/api/admin/dashboard", { token: promotedToken });
    expect(blocked.status).toBe(401);
  });

  it("refuses to let an admin deactivate their own account", async () => {
    const { fixtures, token } = await adminToken();
    const res = await call(app, "PATCH", `/api/admin/users/${fixtures.adminId}`, {
      token,
      body: { isActive: false },
    });
    expect(res.status).toBe(400);
  });

  it("resets an internal user's credential by issuing a fresh code", async () => {
    const { token } = await adminToken();
    const created = await call(app, "POST", "/api/admin/users", {
      token,
      body: { email: "reset@sml.test", role: "sales_user" },
    });
    const id = created.body.user.id as string;

    const res = await call(app, "POST", `/api/admin/users/${id}/reset-credentials`, {
      token,
      body: {},
    });
    expect(res.status).toBe(200);
    const otps = await appPrisma.loginOtp.count({ where: { userId: id, consumedAt: null } });
    expect(otps).toBe(1);
  });

  it("resets a vendor user's credential by sending a reset link", async () => {
    const { fixtures, token } = await adminToken();
    const res = await call(
      app,
      "POST",
      `/api/admin/users/${fixtures.vendorA.userId}/reset-credentials`,
      { token, body: {} },
    );
    expect(res.status).toBe(200);
    const user = await appPrisma.user.findUniqueOrThrow({
      where: { id: fixtures.vendorA.userId },
      select: { resetToken: true },
    });
    expect(user.resetToken).toBeTruthy();
  });

  it("audits user creation and updates", async () => {
    const { token } = await adminToken();
    const created = await call(app, "POST", "/api/admin/users", {
      token,
      body: { email: "audited@sml.test", role: "sales_user" },
    });
    const id = created.body.user.id as string;
    await call(app, "PATCH", `/api/admin/users/${id}`, { token, body: { isActive: false } });

    const actions = await appPrisma.auditLog.findMany({
      where: { entity: "User", entityId: id },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual(["USER_CREATED", "USER_UPDATED"]);
  });
});

describe("vendor suspension (P0 B2)", () => {
  it("suspends a vendor: no login, no RFQ, no candidates", async () => {
    const { fixtures, token } = await adminToken();

    const res = await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/suspend`, {
      token,
      body: { reason: "Documents under review" },
    });
    expect(res.status).toBe(200);
    expect(res.body.vendor.suspendReason).toBe("Documents under review");

    const vendor = await appPrisma.vendor.findUniqueOrThrow({
      where: { id: fixtures.vendorA.vendorId },
      select: { suspendedAt: true, suspendedById: true, users: { select: { isActive: true } } },
    });
    expect(vendor.suspendedAt).toBeTruthy();
    expect(vendor.suspendedById).toBe(fixtures.adminId);
    expect(vendor.users.every((u) => !u.isActive)).toBe(true);

    // Login is refused.
    const login = await signInVendor(VENDOR_USERS.a);
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("VENDOR_SUSPENDED");

    // The vendor disappears from the dispatch picker.
    const picker = await call(app, "GET", "/api/rfqs/approved-vendors", { token });
    expect(
      picker.body.vendors.some((v: { id: string }) => v.id === fixtures.vendorA.vendorId),
    ).toBe(false);
  });

  it("refuses to send an RFQ to a vendor suspended after selection", async () => {
    const { fixtures, token } = await adminToken();
    await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/suspend`, {
      token,
      body: {},
    });

    const rfq = await appPrisma.rfq.create({
      data: {
        rfqNumber: "SP/TEST/0002",
        enquiryNo: "ENQ-2",
        lineNo: "10",
        craneType: "CRAWLER",
        capacityT: 100,
        siteLocation: "Ahmedabad",
        siteStateCode: "GJ",
        requiredStartDate: new Date(),
        durationValue: 1,
        durationUnit: "MONTHS",
        submissionDeadline: new Date(Date.now() + 86_400_000),
        createdById: fixtures.adminId,
      },
      select: { id: true },
    });

    const send = await call(app, "POST", `/api/rfqs/${rfq.id}/send`, {
      token,
      body: { vendorIds: [fixtures.vendorA.vendorId] },
    });
    expect(send.status).toBe(400);
    expect(JSON.stringify(send.body)).toMatch(/suspended/i);
  });

  it("reinstates a suspended vendor and restores login", async () => {
    const { fixtures, token } = await adminToken();
    await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/suspend`, {
      token,
      body: {},
    });

    const res = await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/reinstate`, {
      token,
      body: {},
    });
    expect(res.status).toBe(200);

    const vendor = await appPrisma.vendor.findUniqueOrThrow({
      where: { id: fixtures.vendorA.vendorId },
      select: { suspendedAt: true, users: { select: { isActive: true } } },
    });
    expect(vendor.suspendedAt).toBeNull();
    expect(vendor.users.every((u) => u.isActive)).toBe(true);

    const login = await signInVendor(VENDOR_USERS.a);
    expect(login.status).toBe(200);
  });

  it("rejects a double suspend and a spurious reinstate", async () => {
    const { fixtures, token } = await adminToken();
    await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/suspend`, {
      token,
      body: {},
    });
    const again = await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/suspend`, {
      token,
      body: {},
    });
    expect(again.status).toBe(409);

    const notSuspended = await call(
      app,
      "POST",
      `/api/admin/vendors/${fixtures.vendorB.vendorId}/reinstate`,
      { token, body: {} },
    );
    expect(notSuspended.status).toBe(400);
  });

  it("refuses suspension from a sales user", async () => {
    const fixtures = await seedIsolationFixtures();
    const sales = await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user");
    const res = await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/suspend`, {
      token: sales,
      body: {},
    });
    expect(res.status).toBe(403);
  });

  it("audits suspend and reinstate", async () => {
    const { fixtures, token } = await adminToken();
    await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/suspend`, {
      token,
      body: {},
    });
    await call(app, "POST", `/api/admin/vendors/${fixtures.vendorA.vendorId}/reinstate`, {
      token,
      body: {},
    });
    const actions = await appPrisma.auditLog.findMany({
      where: { entity: "Vendor", entityId: fixtures.vendorA.vendorId },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual([
      "VENDOR_REINSTATED",
      "VENDOR_SUSPENDED",
    ]);
  });
});
