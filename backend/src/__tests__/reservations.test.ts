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
 * Reservations (brief 5.3 / 6.1, phase B).
 *
 * What is under test is the commitment, not the crane flag: that the database
 * refuses overlapping active reservations, that Booked and Hired are derived
 * from dates rather than stored, that releasing records a reason, mails the
 * vendor and frees the crane, and that overdue reservations stop being active.
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

/** UTC midnight, `n` days from today — the shape every writer stores. */
function day(n: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n),
  );
}

const isoDate = (n: number) => day(n).toISOString().slice(0, 10);

async function adminToken() {
  const fixtures = await seedIsolationFixtures();
  const token = await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user");
  return { fixtures, token };
}

async function vendorToken(email: string): Promise<string> {
  const res = await call(app, "POST", "/api/auth/login", {
    body: { email, password: VENDOR_PASSWORD },
  });
  expect(res.status, `login failed: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

/** A reservation written straight to the table, bypassing the award flow. */
async function seedReservation(input: {
  craneId: string;
  type?: "BOOKED" | "BLOCKED";
  status?: "ACTIVE" | "RELEASED" | "COMPLETED";
  start: Date;
  end: Date;
  createdById?: string | null;
}) {
  return appPrisma.reservation.create({
    data: {
      craneId: input.craneId,
      startDate: input.start,
      endDate: input.end,
      type: input.type ?? "BOOKED",
      status: input.status ?? "ACTIVE",
      createdById: input.createdById ?? null,
    },
    select: { id: true },
  });
}

describe("reservations", () => {
  it("keeps vendors out and reserves writing for admins", async () => {
    const { fixtures, token } = await adminToken();
    const vendor = await vendorToken(VENDOR_USERS.a);

    const vendorRead = await call(app, "GET", "/api/reservations", { token: vendor });
    expect(vendorRead.status).toBe(403);

    const sales = await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user");
    const salesRead = await call(app, "GET", "/api/reservations", { token: sales });
    expect(salesRead.status).toBe(200);

    const salesWrite = await call(app, "POST", "/api/reservations", {
      token: sales,
      body: { craneId: fixtures.vendorA.craneId, startDate: isoDate(1), endDate: isoDate(3) },
    });
    expect(salesWrite.status).toBe(403);

    const adminWrite = await call(app, "POST", "/api/reservations", {
      token,
      body: { craneId: fixtures.vendorA.craneId, startDate: isoDate(1), endDate: isoDate(3) },
    });
    expect(adminWrite.status).toBe(201);
    expect(adminWrite.body.reservation.type).toBe("BLOCKED");
    expect(adminWrite.body.reservation.badge).toBeNull();
  });

  it("refuses an overlapping active window and accepts a disjoint one", async () => {
    const { fixtures, token } = await adminToken();

    const first = await call(app, "POST", "/api/reservations", {
      token,
      body: { craneId: fixtures.vendorA.craneId, startDate: isoDate(0), endDate: isoDate(5) },
    });
    expect(first.status).toBe(201);

    // Touching the same days, even partially, is a clash.
    const overlap = await call(app, "POST", "/api/reservations", {
      token,
      body: { craneId: fixtures.vendorA.craneId, startDate: isoDate(5), endDate: isoDate(9) },
    });
    expect(overlap.status).toBe(409);

    const disjoint = await call(app, "POST", "/api/reservations", {
      token,
      body: { craneId: fixtures.vendorA.craneId, startDate: isoDate(6), endDate: isoDate(9) },
    });
    expect(disjoint.status).toBe(201);

    expect(await appPrisma.reservation.count()).toBe(2);
  });

  it("rejects an end date before the start date", async () => {
    const { fixtures, token } = await adminToken();
    const res = await call(app, "POST", "/api/reservations", {
      token,
      body: { craneId: fixtures.vendorA.craneId, startDate: isoDate(5), endDate: isoDate(1) },
    });
    expect(res.status).toBe(400);
  });

  it("derives Hired for a booking covering today and Booked for a future one", async () => {
    const { fixtures, token } = await adminToken();

    await seedReservation({ craneId: fixtures.vendorA.craneId, start: day(0), end: day(4) });
    const covering = await call(app, "GET", "/api/reservations", { token });
    expect(covering.body.reservations).toHaveLength(1);
    expect(covering.body.reservations[0].badge).toBe("HIRED");

    await appPrisma.reservation.deleteMany();
    await seedReservation({ craneId: fixtures.vendorA.craneId, start: day(3), end: day(9) });
    const future = await call(app, "GET", "/api/reservations", { token });
    expect(future.body.reservations[0].badge).toBe("BOOKED");
  });

  it("shows no badge once a reservation is released", async () => {
    const { fixtures, token } = await adminToken();
    await seedReservation({ craneId: fixtures.vendorA.craneId, start: day(0), end: day(4) });

    const res = await call(app, "GET", "/api/reservations", { token });
    expect(res.body.reservations[0].badge).toBe("HIRED");

    const release = await call(
      app,
      "POST",
      `/api/reservations/${res.body.reservations[0].id}/release`,
      { token, body: { reason: "Customer rescheduled" } },
    );
    expect(release.status).toBe(200);

    const after = await call(app, "GET", "/api/reservations", { token });
    expect(after.body.reservations[0].status).toBe("RELEASED");
    expect(after.body.reservations[0].badge).toBeNull();
  });

  it("releases with a reason, records an audit entry and mails the vendor", async () => {
    const { fixtures, token } = await adminToken();
    const created = await seedReservation({
      craneId: fixtures.vendorA.craneId,
      start: day(0),
      end: day(4),
    });

    const missingReason = await call(
      app,
      "POST",
      `/api/reservations/${created.id}/release`,
      { token, body: {} },
    );
    expect(missingReason.status).toBe(400);

    const release = await call(
      app,
      "POST",
      `/api/reservations/${created.id}/release`,
      { token, body: { reason: "Contract withdrawn by customer" } },
    );
    expect(release.status).toBe(200);
    expect(release.body.reservation.releaseReason).toBe("Contract withdrawn by customer");
    expect(release.body.reservation.releasedByName).toBe(INTERNAL_USERS.admin);

    const audit = await appPrisma.auditLog.findFirstOrThrow({
      where: { entity: "reservation", entityId: created.id, action: "release" },
    });
    expect(audit.newValue).toMatchObject({ status: "RELEASED" });

    const mail = await appPrisma.emailLog.findFirstOrThrow({
      where: { template: "reservation_released" },
    });
    expect(mail.toEmail).toBe(VENDOR_USERS.a);

    const again = await call(
      app,
      "POST",
      `/api/reservations/${created.id}/release`,
      { token, body: { reason: "Trying twice" } },
    );
    expect(again.status).toBe(409);
  });

  it("completes overdue reservations and leaves future ones active", async () => {
    const { fixtures, token } = await adminToken();
    const overdue = await seedReservation({
      craneId: fixtures.vendorA.craneId,
      start: day(-10),
      end: day(-2),
    });
    const upcoming = await seedReservation({
      craneId: fixtures.vendorA.craneId,
      start: day(2),
      end: day(6),
    });

    const sweep = await call(app, "POST", "/api/reservations/complete-overdue", { token });
    expect(sweep.status).toBe(200);
    expect(sweep.body.completed).toBe(1);

    const rows = await appPrisma.reservation.findMany({
      select: { id: true, status: true },
    });
    expect(rows.find((r) => r.id === overdue.id)?.status).toBe("COMPLETED");
    expect(rows.find((r) => r.id === upcoming.id)?.status).toBe("ACTIVE");
  });

  it("surfaces the derived booking on the vendor dashboard", async () => {
    const { fixtures } = await adminToken();
    await seedReservation({ craneId: fixtures.vendorA.craneId, start: day(0), end: day(4) });

    const vendor = await vendorToken(VENDOR_USERS.a);
    const dashboard = await call(app, "GET", "/api/vendor/dashboard", { token: vendor });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.fleet.bookings.count).toBe(1);
    const booking = dashboard.body.fleet.bookings.cranes[0];
    expect(booking.craneId).toBe(fixtures.vendorA.craneId);
    expect(booking.currentStatus).toBe("HIRED");
    expect(booking.startDate).toBe(day(0).toISOString());
    expect(booking.endDate).toBe(day(4).toISOString());
  });
});
