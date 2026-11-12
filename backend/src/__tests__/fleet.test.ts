import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  call,
  callRaw,
  callUpload,
  clearTestUploads,
  disconnectTestDatabases,
  internalToken,
  resetTestDatabase,
  sampleUpload,
  seedIsolationFixtures,
  testPrisma,
  useTestDatabase,
  type SeededVendor,
} from "./harness";
import { INTERNAL_USERS, VENDOR_USERS } from "./fixtures";

/**
 * Milestone 3: fleet management (brief 6.1-6.8, 7.4).
 *
 * The rules here are the ones that would otherwise only be enforced in the UI,
 * which is the wrong place for them:
 *
 * - the four vendor-selectable statuses, with Engaged's available_from rule and
 *   Booked/Hired locked to SML (6.1, 6.2);
 * - duplicate detection across a vendor's active cranes only, so a deactivated
 *   serial can be reused but an active one cannot (6.3);
 * - geocoding on create and on location edits, a manual pin winning over an
 *   automatic one, and a failed lookup saving as unverified rather than
 *   rejecting the crane (6.6);
 * - freshness flags and "confirm still accurate" (6.5);
 * - load charts and deactivation, neither of which may delete anything a
 *   quotation or audit row points at (7.4);
 * - the switchable fleet approval flag (6.4).
 *
 * Cross-vendor access is asserted alongside each rule, since scoping is the one
 * property that has to hold for every endpoint at once.
 *
 * Every value here is fabricated (brief working rule 3).
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Ctx {
  a: SeededVendor;
  b: SeededVendor;
  adminToken: string;
  salesToken: string;
}

let ctx: Ctx;

async function signInVendor(email: string): Promise<string> {
  const res = await call(app, "POST", "/api/auth/login", {
    body: { email, password: "Vendor@Portal2026" },
  });
  expect(res.status, `login failed: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

beforeEach(async () => {
  const fixtures = await seedIsolationFixtures();
  ctx = {
    a: fixtures.vendorA,
    b: fixtures.vendorB,
    adminToken: await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user"),
    salesToken: await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user"),
  };
});

let tokenA: string;
let tokenB: string;

beforeEach(async () => {
  tokenA = await signInVendor(VENDOR_USERS.a);
  tokenB = await signInVendor(VENDOR_USERS.b);
});

/** A minimal valid crane, overridable per test. */
function cranePayload(overrides: Record<string, unknown> = {}) {
  return {
    typeOfCraneCode: "CRAWLER",
    capacityT: 120,
    currentStatus: "AVAILABLE",
    currentLocation: "Ahmedabad Yard",
    stateCode: "GJ",
    make: "Liebherr",
    model: "LTM 1100",
    yom: 2021,
    mainBoomM: 60,
    serialRegistrationNo: "NEW-SERIAL-001",
    pincode: "380015",
    ...overrides,
  };
}

async function createCrane(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return call(app, "POST", "/api/cranes", { token, body: cranePayload(overrides) });
}

/** Sets a setting and drops the 30s settings cache so the next read sees it. */
async function setFlag(key: string, value: string): Promise<void> {
  const { setSetting } = await import("../utils/settings");
  await setSetting(key as never, value);
}

// ---------------------------------------------------------------------------
// Create and validation (brief 5.2, 6.1)
// ---------------------------------------------------------------------------

describe("fleet: creating a crane", () => {
  it("stores the crane, geocodes the location and returns the reference names", async () => {
    const res = await createCrane(tokenA);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.crane).toMatchObject({
      vendorId: ctx.a.vendorId,
      serialRegistrationNo: "NEW-SERIAL-001",
      currentStatus: "AVAILABLE",
      currentLocation: "Ahmedabad Yard",
      stateCode: "GJ",
      isActive: true,
      approvalStatus: "APPROVED",
    });
    // Relations come back resolved rather than as bare codes.
    expect(res.body.crane.typeOfCrane).toEqual({ code: "CRAWLER", name: "Crawler Crane" });
    expect(res.body.crane.state).toEqual({ code: "GJ", name: "State GJ" });

    // The dev/test geo provider always returns an in-India point.
    expect(res.body.crane.latitude).not.toBeNull();
    expect(res.body.crane.longitude).not.toBeNull();
    expect(res.body.crane.coordinateSource).toBe("auto");
    expect(res.body.crane.locationUnverified).toBe(false);
  });

  it("ignores a vendorId in the body and always writes under the caller's own vendor", async () => {
    const res = await createCrane(tokenA, { vendorId: ctx.b.vendorId });
    expect(res.status).toBe(201);
    expect(res.body.crane.vendorId).toBe(ctx.a.vendorId);
  });

  it("requires every field the brief lists as mandatory", async () => {
    const res = await call(app, "POST", "/api/cranes", { token: tokenA, body: {} });
    expect(res.status).toBe(400);

    const fields = new Set((res.body.details as { path: string }[]).map((d) => d.path));
    for (const required of [
      "typeOfCraneCode",
      "capacityT",
      "currentLocation",
      "stateCode",
      "make",
      "model",
      "yom",
      "mainBoomM",
      "serialRegistrationNo",
    ]) {
      expect(fields.has(required), `expected ${required} to be required`).toBe(true);
    }

    // currentStatus is deliberately not in that list: adding a crane usually
    // means adding one that is ready to work, so it defaults to AVAILABLE.
    const defaulted = await call(app, "POST", "/api/cranes", {
      token: tokenA,
      body: cranePayload({ serialRegistrationNo: "DEFAULT-STATUS" }),
    });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.crane.currentStatus).toBe("AVAILABLE");
  });

  it("rejects a serial that is only whitespace or a placeholder", async () => {
    for (const bad of ["", "   ", "-", "--", "TBD", "NA"]) {
      const res = await createCrane(tokenA, { serialRegistrationNo: bad });
      expect(res.status, `serial ${JSON.stringify(bad)} should be rejected`).toBe(400);
    }
  });

  it("rejects a crane type or state that is not in the reference tables", async () => {
    expect((await createCrane(tokenA, { typeOfCraneCode: "NOPE" })).status).toBe(400);
    expect((await createCrane(tokenA, { stateCode: "ZZ" })).status).toBe(400);
  });

  it("rejects impossible numbers", async () => {
    expect((await createCrane(tokenA, { capacityT: 0 })).status).toBe(400);
    expect((await createCrane(tokenA, { capacityT: -5 })).status).toBe(400);
    expect((await createCrane(tokenA, { mainBoomM: 0 })).status).toBe(400);
    expect((await createCrane(tokenA, { yom: 3000 })).status).toBe(400);
    expect((await createCrane(tokenA, { yom: 1940 })).status).toBe(400);
  });

  it("accepts a blank or NA jib length but rejects a negative one", async () => {
    expect((await createCrane(tokenA, { fixedJibM: null })).status).toBe(201);
    expect((await createCrane(tokenA, { serialRegistrationNo: "NA-OK-1", fixedJibM: "NA" })).status).toBe(201);
    expect((await createCrane(tokenA, { serialRegistrationNo: "NEG-1", fixedJibM: -1 })).status).toBe(400);
  });

  it("rejects a pincode that is not six digits", async () => {
    expect((await createCrane(tokenA, { pincode: "38001" })).status).toBe(400);
    expect((await createCrane(tokenA, { pincode: "3800156" })).status).toBe(400);
    expect((await createCrane(tokenA, { pincode: "ABCDEF" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Status rules (brief 6.1, 6.2)
// ---------------------------------------------------------------------------

describe("fleet: status rules", () => {
  it("accepts the three vendor-selectable statuses", async () => {
    for (const status of ["AVAILABLE", "ENGAGED", "UNDER_MAINTENANCE"]) {
      const res = await createCrane(tokenA, {
        serialRegistrationNo: `S-${status}`,
        currentStatus: status,
        availableFrom: status === "ENGAGED" ? "2999-01-01" : undefined,
      });
      expect(res.status, `${status}: ${JSON.stringify(res.body)}`).toBe(201);
    }
  });

  it("refuses to let a vendor set Booked or Hired", async () => {
    for (const status of ["BOOKED", "HIRED"]) {
      const res = await createCrane(tokenA, { currentStatus: status });
      expect(res.status, `${status} must be system-only`).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/status/i);
    }
  });

  it("requires available_from on Engaged and refuses a date in the past", async () => {
    const missing = await createCrane(tokenA, { currentStatus: "ENGAGED" });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toMatch(/available/i);

    const past = await createCrane(tokenA, {
      serialRegistrationNo: "ENGAGED-PAST",
      currentStatus: "ENGAGED",
      availableFrom: "2020-01-01",
    });
    expect(past.status).toBe(400);
  });

  it("clears available_from when a crane returns to Available", async () => {
    const created = await createCrane(tokenA, {
      currentStatus: "ENGAGED",
      availableFrom: "2999-06-01",
    });
    expect(created.status).toBe(201);
    expect(created.body.crane.availableFrom).not.toBeNull();

    const back = await call(app, "PATCH", `/api/cranes/${created.body.crane.id}/status-location`, {
      token: tokenA,
      body: { currentStatus: "AVAILABLE", currentLocation: "Ahmedabad Yard", stateCode: "GJ" },
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.crane.availableFrom).toBeNull();
  });

  it("stores available_from on the day the vendor picked, whatever the server timezone", async () => {
    // A `date` input sends a calendar day. The server was truncating that instant
    // in its own timezone, so at UTC-4 a vendor who picked 5 October had the 4th
    // stored — and the suite never saw it, because tests ran at UTC where both
    // readings agree. Asserting the literal is what makes this timezone-proof.
    const created = await createCrane(tokenA, {
      serialRegistrationNo: "ENGAGED-TZ",
      currentStatus: "ENGAGED",
      availableFrom: "2999-10-05",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.crane.availableFrom).toBe("2999-10-05T00:00:00.000Z");

    const stored = await testPrisma.crane.findUnique({
      where: { id: created.body.crane.id },
      select: { availableFrom: true },
    });
    expect(stored?.availableFrom?.toISOString()).toBe("2999-10-05T00:00:00.000Z");
  });

  it("accepts available_from as today, not yesterday", async () => {
    // The same defect seen from the other side: at UTC-4, "today" read as the
    // server's yesterday for part of the day and rejected a legitimate date.
    const today = new Date().toISOString().slice(0, 10);
    const res = await createCrane(tokenA, {
      serialRegistrationNo: "ENGAGED-TODAY",
      currentStatus: "ENGAGED",
      availableFrom: today,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.crane.availableFrom).toBe(`${today}T00:00:00.000Z`);
  });

  it("rejects a date that does not exist instead of rolling it into the next month", async () => {
    const res = await createCrane(tokenA, {
      serialRegistrationNo: "ENGAGED-FAKEDAY",
      currentStatus: "ENGAGED",
      availableFrom: "2999-02-31",
    });
    expect(res.status).toBe(400);
  });

  it("keeps a Booked or Hired crane immutable to the vendor", async () => {
    // SML books the crane on a contract; that is the only thing that may move it.
    await testPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { currentStatus: "BOOKED" },
    });

    const res = await call(app, "PATCH", `/api/cranes/${ctx.a.craneId}/status-location`, {
      token: tokenA,
      body: { currentStatus: "AVAILABLE", currentLocation: "Surat Yard", stateCode: "GJ" },
    });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/booked|contract/i);
  });
});

// ---------------------------------------------------------------------------
// Duplicates (brief 6.3)
// ---------------------------------------------------------------------------

describe("fleet: duplicate serials", () => {
  it("refuses a serial already used by an active crane and names the blocker", async () => {
    const first = await createCrane(tokenA, { serialRegistrationNo: "DUP-1" });
    expect(first.status).toBe(201);

    const second = await createCrane(tokenA, { serialRegistrationNo: "DUP-1" });
    expect(second.status).toBe(409);
    expect(second.body.details.existingCraneId).toBe(first.body.crane.id);
    expect(second.body.details.existingStatus).toBe("AVAILABLE");
  });

  it("compares serials case-insensitively", async () => {
    expect((await createCrane(tokenA, { serialRegistrationNo: "Case-01" })).status).toBe(201);
    expect((await createCrane(tokenA, { serialRegistrationNo: "CASE-01" })).status).toBe(409);
  });

  it("lets a deactivated serial be reused, and blocks it again once reactivated", async () => {
    const first = await createCrane(tokenA, { serialRegistrationNo: "REUSE-1" });
    const craneId = first.body.crane.id;

    expect((await call(app, "POST", `/api/cranes/${craneId}/deactivate`, { token: tokenA })).status).toBe(200);

    // The deactivated row no longer blocks the serial.
    const second = await createCrane(tokenA, { serialRegistrationNo: "REUSE-1" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.crane.id).not.toBe(craneId);

    // Reactivating the old crane would collide with the live one.
    const reactivate = await call(app, "POST", `/api/cranes/${craneId}/reactivate`, { token: tokenA });
    expect(reactivate.status).toBe(409);
  });

  it("scopes the duplicate rule per vendor, so two vendors may share a serial", async () => {
    expect((await createCrane(tokenA, { serialRegistrationNo: "SHARED-9" })).status).toBe(201);
    expect((await createCrane(tokenB, { serialRegistrationNo: "SHARED-9" })).status).toBe(201);
  });

  it("does not report another vendor's serial when checking a duplicate", async () => {
    await createCrane(tokenA, { serialRegistrationNo: "PRIVATE-A" });

    // Vendor B may reuse the string, and must not be handed vendor A's crane id.
    const res = await createCrane(tokenB, { serialRegistrationNo: "PRIVATE-A" });
    expect(res.status).toBe(201);
    expect(res.body.crane.vendorId).toBe(ctx.b.vendorId);
  });

  it("enforces the same rule on update", async () => {
    const first = await createCrane(tokenA, { serialRegistrationNo: "UPD-1" });
    const second = await createCrane(tokenA, { serialRegistrationNo: "UPD-2" });
    expect(second.status).toBe(201);

    const res = await call(app, "PUT", `/api/cranes/${second.body.crane.id}`, {
      token: tokenA,
      body: cranePayload({ serialRegistrationNo: "UPD-1" }),
    });
    expect(res.status).toBe(409);
    expect(res.body.details.existingCraneId).toBe(first.body.crane.id);
  });
});

// ---------------------------------------------------------------------------
// Geocoding and pin correction (brief 6.6)
// ---------------------------------------------------------------------------

describe("fleet: coordinates", () => {
  it("keeps a manual pin as manual and reports it as verified", async () => {
    const res = await createCrane(tokenA, { latitude: 23.0225, longitude: 72.5714 });
    expect(res.status).toBe(201);
    expect(res.body.crane).toMatchObject({
      latitude: 23.0225,
      longitude: 72.5714,
      coordinateSource: "manual",
      locationUnverified: false,
    });
  });

  it("rejects a pin outside India and does not store the row", async () => {
    const res = await createCrane(tokenA, { latitude: 48.8566, longitude: 2.3522 });
    expect(res.status).toBe(400);

    const remaining = await testPrisma.crane.count({ where: { serialRegistrationNo: "NEW-SERIAL-001" } });
    expect(remaining).toBe(0);
  });

  it("rejects a half-supplied pin", async () => {
    expect((await createCrane(tokenA, { latitude: 23.0225 })).status).toBe(400);
    expect((await createCrane(tokenA, { longitude: 72.5714 })).status).toBe(400);
  });

  it("preserves a manual pin when only the serial changes", async () => {
    const created = await createCrane(tokenA, { latitude: 23.0225, longitude: 72.5714 });

    const res = await call(app, "PUT", `/api/cranes/${created.body.crane.id}`, {
      token: tokenA,
      body: cranePayload({ serialRegistrationNo: "NEW-SERIAL-002", latitude: 23.0225, longitude: 72.5714 }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.crane.coordinateSource).toBe("manual");
    expect(res.body.crane.latitude).toBe(23.0225);
  });

  it("re-geocodes and replaces the pin when the location text changes", async () => {
    const created = await createCrane(tokenA, { latitude: 23.0225, longitude: 72.5714 });
    expect(created.body.crane.coordinateSource).toBe("manual");

    // Brief 6.3: a manual pin survives later automatic geocodes "unless
    // location text changes". The crane moved, so the old pin is now wrong and
    // the new text is the better answer.
    const res = await call(app, "PUT", `/api/cranes/${created.body.crane.id}`, {
      token: tokenA,
      body: cranePayload({
        serialRegistrationNo: "NEW-SERIAL-001",
        currentLocation: "Surat Yard",
        stateCode: "GJ",
      }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.crane.coordinateSource).toBe("auto");
    expect(res.body.crane.latitude).not.toBe(23.0225);
    expect(res.body.crane.geocodedBy).toBeTruthy();
    expect(res.body.crane.geocodedAt).toBeTruthy();
  });

  it("lets a pin submitted with a moved location win, since it is deliberate", async () => {
    const created = await createCrane(tokenA, { latitude: 23.0225, longitude: 72.5714 });

    const res = await call(app, "PUT", `/api/cranes/${created.body.crane.id}`, {
      token: tokenA,
      body: cranePayload({
        serialRegistrationNo: "NEW-SERIAL-001",
        currentLocation: "Surat Yard",
        stateCode: "GJ",
        latitude: 21.1702,
        longitude: 72.8311,
      }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.crane).toMatchObject({
      latitude: 21.1702,
      longitude: 72.8311,
      coordinateSource: "manual",
    });
  });

  it("keeps the existing pin untouched when only the pincode is filled in", async () => {
    const created = await createCrane(tokenA, {
      currentLocation: "Ahmedabad Yard",
      pincode: null,
      latitude: 23.0225,
      longitude: 72.5714,
    });
    expect(created.status).toBe(201);

    // Pincode is an input to the automatic lookup, but the brief protects a
    // manual pin, so this is not treated as a move.
    const res = await call(app, "PUT", `/api/cranes/${created.body.crane.id}`, {
      token: tokenA,
      body: cranePayload({ serialRegistrationNo: "NEW-SERIAL-001", pincode: "380015", latitude: 23.0225, longitude: 72.5714 }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.crane.coordinateSource).toBe("manual");
    expect(res.body.crane.latitude).toBe(23.0225);
  });

  it("keeps the crane with null coordinates when geocoding fails", async () => {
    const { setGeoProvider } = await import("../lib/geo");
    setGeoProvider({
      name: "failing",
      geocode: async () => ({ ok: false, reason: "provider unavailable" }),
      roadDistance: async () => ({ ok: false, reason: "unavailable" }),
    });

    try {
      const res = await createCrane(tokenA);
      expect(res.status, "a geocoder outage must not block saving").toBe(201);
      expect(res.body.crane.latitude).toBeNull();
      expect(res.body.crane.longitude).toBeNull();
      expect(res.body.crane.coordinateSource).toBeNull();
      expect(res.body.crane.locationUnverified).toBe(true);
    } finally {
      setGeoProvider(null);
    }
  });
});

// ---------------------------------------------------------------------------
// Quick actions, confirm accurate, freshness (brief 6.5, 7.4)
// ---------------------------------------------------------------------------

describe("fleet: quick actions", () => {
  it("changes status and location together", async () => {
    const res = await call(app, "PATCH", `/api/cranes/${ctx.a.craneId}/status-location`, {
      token: tokenA,
      body: { currentStatus: "UNDER_MAINTENANCE", currentLocation: "Vadodara Yard", stateCode: "GJ" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.crane).toMatchObject({
      currentStatus: "UNDER_MAINTENANCE",
      currentLocation: "Vadodara Yard",
    });
  });

  it("moves the pin along with the crane, since that is when a pin goes stale", async () => {
    const res = await call(app, "PATCH", `/api/cranes/${ctx.a.craneId}/status-location`, {
      token: tokenA,
      body: {
        currentStatus: "AVAILABLE",
        currentLocation: "Vadodara Yard",
        stateCode: "GJ",
        latitude: 22.3072,
        longitude: 73.1812,
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.crane).toMatchObject({
      latitude: 22.3072,
      longitude: 73.1812,
      coordinateSource: "manual",
    });
  });

  it("refuses half a pin through the quick path", async () => {
    const res = await call(app, "PATCH", `/api/cranes/${ctx.a.craneId}/status-location`, {
      token: tokenA,
      body: {
        currentStatus: "AVAILABLE",
        currentLocation: "Vadodara Yard",
        stateCode: "GJ",
        latitude: 22.3072,
      },
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/longitude/i);

    // And the existing pin is untouched.
    const unchanged = await testPrisma.crane.findUniqueOrThrow({ where: { id: ctx.a.craneId } });
    // Stored as a Decimal, so compare numerically rather than by identity.
    expect(Number(unchanged.latitude)).toBe(22.5);
  });

  it("keeps the existing pin when the quick path sends none", async () => {
    const res = await call(app, "PATCH", `/api/cranes/${ctx.a.craneId}/status-location`, {
      token: tokenA,
      body: { currentStatus: "AVAILABLE", currentLocation: "A Yard", stateCode: "GJ" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The location text is unchanged, so the manual pin stands.
    expect(res.body.crane).toMatchObject({ latitude: 22.5, coordinateSource: "manual" });
  });

  it("applies the Engaged date rule through the quick path too", async () => {
    const res = await call(app, "PATCH", `/api/cranes/${ctx.a.craneId}/status-location`, {
      token: tokenA,
      body: { currentStatus: "ENGAGED", currentLocation: "A Yard", stateCode: "GJ" },
    });
    expect(res.status).toBe(400);
  });

  it("returns a duplicate prefill that starts Available with no serial", async () => {
    const res = await call(app, "GET", `/api/cranes/${ctx.a.craneId}/duplicate`, { token: tokenA });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.prefill).toMatchObject({
      make: "Demo",
      model: "Model-A",
      capacityT: 250,
      currentStatus: "AVAILABLE",
      serialRegistrationNo: "",
    });
    expect(res.body.prefill.serialRegistrationNo).toBe("");
  });

  it("never prefills a system-only status", async () => {
    await testPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { currentStatus: "HIRED" },
    });

    const res = await call(app, "GET", `/api/cranes/${ctx.a.craneId}/duplicate`, { token: tokenA });
    expect(res.body.prefill.currentStatus).toBe("AVAILABLE");
  });

  it("refreshes the freshness clock without touching the data", async () => {
    const before = await testPrisma.crane.findUniqueOrThrow({
      where: { id: ctx.a.craneId },
      select: { statusUpdatedAt: true, currentLocation: true, currentStatus: true },
    });
    await testPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { statusUpdatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    const res = await call(app, "POST", `/api/cranes/${ctx.a.craneId}/confirm-accurate`, {
      token: tokenA,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.crane.currentLocation).toBe(before.currentLocation);
    expect(res.body.crane.currentStatus).toBe(before.currentStatus);

    const after = await testPrisma.crane.findUniqueOrThrow({
      where: { id: ctx.a.craneId },
      select: { statusUpdatedAt: true },
    });
    expect(after.statusUpdatedAt.getTime()).toBeGreaterThan(
      new Date(Date.now() - 24 * 60 * 60 * 1000).getTime(),
    );
  });

  it("reports freshness against the configured 30 and 60 day windows", async () => {
    const day = 24 * 60 * 60 * 1000;

    await testPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { statusUpdatedAt: new Date(Date.now() - 10 * day) },
    });
    const fresh = await call(app, "GET", `/api/cranes/${ctx.a.craneId}`, { token: tokenA });
    expect(fresh.body.crane.freshness).toMatchObject({
      daysSinceUpdate: 10,
      dueForUpdate: false,
      stale: false,
    });

    await testPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { statusUpdatedAt: new Date(Date.now() - 45 * day) },
    });
    const due = await call(app, "GET", `/api/cranes/${ctx.a.craneId}`, { token: tokenA });
    expect(due.body.crane.freshness).toMatchObject({ dueForUpdate: true, stale: false });

    await testPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { statusUpdatedAt: new Date(Date.now() - 75 * day) },
    });
    const stale = await call(app, "GET", `/api/cranes/${ctx.a.craneId}`, { token: tokenA });
    expect(stale.body.crane.freshness).toMatchObject({ dueForUpdate: true, stale: true });
    expect(stale.body.crane.freshness.staleSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// List, filters and deactivation (brief 7.4)
// ---------------------------------------------------------------------------

describe("fleet: listing and deactivation", () => {
  it("lists only the caller's own cranes", async () => {
    await createCrane(tokenA, { serialRegistrationNo: "LIST-A" });

    const res = await call(app, "GET", "/api/cranes", { token: tokenA });
    expect(res.status).toBe(200);
    expect(res.body.cranes.length).toBeGreaterThan(0);
    expect(res.body.cranes.every((c: any) => c.vendorId === ctx.a.vendorId)).toBe(true);
  });

  it("filters by status, type and state, and searches serial and location", async () => {
    await createCrane(tokenA, {
      serialRegistrationNo: "FIND-ME",
      currentStatus: "UNDER_MAINTENANCE",
      currentLocation: "Rajkot Yard",
    });

    const byStatus = await call(app, "GET", "/api/cranes?status=UNDER_MAINTENANCE", { token: tokenA });
    expect(byStatus.body.cranes.every((c: any) => c.currentStatus === "UNDER_MAINTENANCE")).toBe(true);

    const bySearch = await call(app, "GET", "/api/cranes?search=find-me", { token: tokenA });
    expect(bySearch.body.cranes.some((c: any) => c.serialRegistrationNo === "FIND-ME")).toBe(true);

    const byState = await call(app, "GET", "/api/cranes?stateCode=MH", { token: tokenA });
    expect(byState.body.cranes).toHaveLength(0);
  });

  it("hides deactivated cranes unless asked for them", async () => {
    await call(app, "POST", `/api/cranes/${ctx.a.craneId}/deactivate`, { token: tokenA });

    const active = await call(app, "GET", "/api/cranes", { token: tokenA });
    expect(active.body.cranes.some((c: any) => c.id === ctx.a.craneId)).toBe(false);

    const all = await call(app, "GET", "/api/cranes?includeInactive=true", { token: tokenA });
    const found = all.body.cranes.find((c: any) => c.id === ctx.a.craneId);
    expect(found).toBeDefined();
    expect(found.isActive).toBe(false);
  });

  it("deactivates without deleting the row", async () => {
    const res = await call(app, "POST", `/api/cranes/${ctx.a.craneId}/deactivate`, { token: tokenA });
    expect(res.status).toBe(200);
    expect(res.body.crane.isActive).toBe(false);

    expect(await testPrisma.crane.findUnique({ where: { id: ctx.a.craneId } })).not.toBeNull();
  });

  it("records a deactivate audit entry", async () => {
    await call(app, "POST", `/api/cranes/${ctx.a.craneId}/deactivate`, { token: tokenA });

    const audit = await testPrisma.auditLog.findMany({
      where: { entity: "crane", entityId: ctx.a.craneId, action: "crane_deactivated" },
    });
    expect(audit.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Load charts (brief 5.2)
// ---------------------------------------------------------------------------

describe("fleet: load charts", () => {
  it("uploads, lists and downloads a chart for the owner's own crane", async () => {
    const up = await callUpload(app, "POST", `/api/cranes/${ctx.a.craneId}/load-chart`, sampleUpload("pdf"), {
      token: tokenA,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.crane.loadChart).toMatchObject({ fileName: "sample.pdf", mimeType: "application/pdf" });

    const download = await callRaw(app, `/api/cranes/${ctx.a.craneId}/load-chart`, { token: tokenA });
    expect(download.status).toBe(200);
    expect(download.buffer.toString()).toContain("%PDF");
  });

  it("rejects a file that is not a PDF or image", async () => {
    const res = await callUpload(
      app,
      "POST",
      `/api/cranes/${ctx.a.craneId}/load-chart`,
      sampleUpload("text"),
      { token: tokenA },
    );
    expect(res.status).toBe(400);
  });

  it("replaces an existing chart and leaves the latest one downloadable", async () => {
    await callUpload(app, "POST", `/api/cranes/${ctx.a.craneId}/load-chart`, sampleUpload("pdf"), {
      token: tokenA,
    });
    const second = await callUpload(
      app,
      "POST",
      `/api/cranes/${ctx.a.craneId}/load-chart`,
      sampleUpload("png"),
      { token: tokenA },
    );
    expect(second.status).toBe(201);

    const download = await callRaw(app, `/api/cranes/${ctx.a.craneId}/load-chart`, { token: tokenA });
    expect(download.headers.get("content-type")).toBe("image/png");
  });

  it("returns 404 rather than another vendor's chart", async () => {
    await callUpload(app, "POST", `/api/cranes/${ctx.a.craneId}/load-chart`, sampleUpload("pdf"), {
      token: tokenA,
    });

    const res = await callRaw(app, `/api/cranes/${ctx.a.craneId}/load-chart`, { token: tokenB });
    expect(res.status).toBe(404);
  });

  it("404s a chart request for a crane with no chart", async () => {
    const res = await callRaw(app, `/api/cranes/${ctx.a.craneId}/load-chart`, { token: tokenA });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Fleet approval toggle (brief 6.4)
// ---------------------------------------------------------------------------

describe("fleet: approval toggle", () => {
  it("goes live immediately while the flag is off", async () => {
    await setFlag("FLEET_APPROVAL_REQUIRED", "false");
    const res = await createCrane(tokenA);
    expect(res.status).toBe(201);
    expect(res.body.crane.approvalStatus).toBe("APPROVED");
  });

  it("parks new and edited cranes in PENDING while the flag is on", async () => {
    await setFlag("FLEET_APPROVAL_REQUIRED", "true");

    const created = await createCrane(tokenA);
    expect(created.status).toBe(201);
    expect(created.body.crane.approvalStatus).toBe("PENDING");

    const edited = await call(app, "PUT", `/api/cranes/${created.body.crane.id}`, {
      token: tokenA,
      body: cranePayload({ serialRegistrationNo: "NEW-SERIAL-001", remarks: "moved" }),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.crane.approvalStatus).toBe("PENDING");
  });

  it("lets an admin approve a pending crane and refuses everyone else", async () => {
    await setFlag("FLEET_APPROVAL_REQUIRED", "true");
    const created = await createCrane(tokenA);
    expect(created.body.crane.approvalStatus).toBe("PENDING");

    const forbidden = await call(app, "PATCH", `/api/cranes/${created.body.crane.id}/approval`, {
      token: tokenA,
      body: { approvalStatus: "APPROVED" },
    });
    expect(forbidden.status).toBe(403);

    const approved = await call(app, "PATCH", `/api/cranes/${created.body.crane.id}/approval`, {
      token: ctx.adminToken,
      body: { approvalStatus: "APPROVED" },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.crane.approvalStatus).toBe("APPROVED");
  });

  it("does not leave a crane stuck pending after the flag is turned back off", async () => {
    await setFlag("FLEET_APPROVAL_REQUIRED", "true");
    const created = await createCrane(tokenA);
    expect(created.body.crane.approvalStatus).toBe("PENDING");

    await setFlag("FLEET_APPROVAL_REQUIRED", "false");
    const edited = await call(app, "PUT", `/api/cranes/${created.body.crane.id}`, {
      token: tokenA,
      body: cranePayload({ serialRegistrationNo: "NEW-SERIAL-001", remarks: "flag turned off" }),
    });
    expect(edited.body.crane.approvalStatus).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------
// Isolation and roles (brief 6.6, 6.8)
// ---------------------------------------------------------------------------

describe("fleet: isolation", () => {
  it("404s another vendor's crane on read, edit and chart download", async () => {
    for (const call_ of [
      () => call(app, "GET", `/api/cranes/${ctx.a.craneId}`, { token: tokenB }),
      () => call(app, "PUT", `/api/cranes/${ctx.a.craneId}`, { token: tokenB, body: cranePayload() }),
      () =>
        call(app, "PATCH", `/api/cranes/${ctx.a.craneId}/status-location`, {
          token: tokenB,
          body: { currentStatus: "AVAILABLE", currentLocation: "B Yard", stateCode: "GJ" },
        }),
      () => call(app, "POST", `/api/cranes/${ctx.a.craneId}/deactivate`, { token: tokenB }),
      () => callRaw(app, `/api/cranes/${ctx.a.craneId}/load-chart`, { token: tokenB }),
    ]) {
      const res = await call_();
      expect(res.status).toBe(404);
    }

    // Nothing changed on the way through.
    const unchanged = await testPrisma.crane.findUniqueOrThrow({ where: { id: ctx.a.craneId } });
    expect(unchanged.currentLocation).toBe("A Yard");
    expect(unchanged.isActive).toBe(true);
  });

  it("requires authentication", async () => {
    expect((await call(app, "GET", "/api/cranes")).status).toBe(401);
    expect((await call(app, "POST", "/api/cranes", { body: cranePayload() })).status).toBe(401);
  });

  it("lets sales read an approved fleet and write on the vendor's behalf (D1)", async () => {
    const read = await call(app, "GET", "/api/cranes", { token: ctx.salesToken });
    expect(read.status).toBe(200);
    expect(read.body.cranes.some((c: any) => c.vendorId === ctx.a.vendorId)).toBe(true);
    expect(read.body.cranes[0].vendorName).toBeTruthy();

    // A create must name the vendor whose fleet is being updated.
    const noVendor = await call(app, "POST", "/api/cranes", {
      token: ctx.salesToken,
      body: cranePayload({ serialRegistrationNo: "SALES-WRITE" }),
    });
    expect(noVendor.status).toBe(400);

    const write = await call(app, "POST", "/api/cranes", {
      token: ctx.salesToken,
      body: { ...cranePayload({ serialRegistrationNo: "SALES-WRITE" }), vendorId: ctx.a.vendorId },
    });
    expect(write.status).toBe(201);
    expect(write.body.crane.updatedOnBehalf).toBe(true);

    await call(app, "PUT", `/api/cranes/${ctx.a.craneId}`, {
      token: ctx.salesToken,
      body: { ...cranePayload(), vendorId: ctx.a.vendorId },
    });
    const edited = await testPrisma.crane.findUniqueOrThrow({ where: { id: ctx.a.craneId } });
    expect(edited.updatedOnBehalf).toBe(true);

    // The change carries the on-behalf audit mark.
    const audit = await testPrisma.auditLog.findFirst({
      where: { entity: "crane", entityId: ctx.a.craneId, action: "crane_updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.onBehalfOfVendor).toBe(true);
  });

  it("keeps a non-approved vendor's fleet out of internal reads", async () => {
    await testPrisma.vendor.update({
      where: { id: ctx.b.vendorId },
      data: { onboardingStatus: "DRAFT" },
    });

    const res = await call(app, "GET", "/api/cranes", { token: ctx.salesToken });
    expect(res.status).toBe(200);
    expect(res.body.cranes.some((c: any) => c.vendorId === ctx.b.vendorId)).toBe(false);

    // The vendor can still see their own crane while their own approval is pending.
    const own = await call(app, "GET", "/api/cranes", { token: tokenB });
    expect(own.body.cranes.some((c: any) => c.vendorId === ctx.b.vendorId)).toBe(true);
  });

  it("audits a status move with the before and after values", async () => {
    await call(app, "PATCH", `/api/cranes/${ctx.a.craneId}/status-location`, {
      token: tokenA,
      body: { currentStatus: "UNDER_MAINTENANCE", currentLocation: "Vadodara Yard", stateCode: "GJ" },
    });

    const audit = await testPrisma.auditLog.findFirst({
      where: { entity: "crane", entityId: ctx.a.craneId, action: "crane_updated" },
      orderBy: { createdAt: "desc" },
    });

    expect(audit).not.toBeNull();
    expect(audit!.oldValue).toMatchObject({ currentStatus: "AVAILABLE" });
    expect(audit!.newValue).toMatchObject({
      currentStatus: "UNDER_MAINTENANCE",
      currentLocation: "Vadodara Yard",
    });
  });
});

// ---------------------------------------------------------------------------
// Phase D: expected_ready_date (D4) and on-behalf updates (D1)
// ---------------------------------------------------------------------------

describe("fleet: expected ready date (D4)", () => {
  it("stores expected_ready_date on create, edit and the quick update", async () => {
    const created = await call(app, "POST", "/api/cranes", {
      token: tokenA,
      body: cranePayload({
        serialRegistrationNo: "D4-READY-1",
        currentStatus: "UNDER_MAINTENANCE",
        expectedReadyDate: "2026-11-01",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.crane.expectedReadyDate).toContain("2026-11-01");

    // An edit can move it, and moving it winds the status clock.
    const before = await testPrisma.crane.findUniqueOrThrow({ where: { id: created.body.crane.id } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const edited = await call(app, "PUT", `/api/cranes/${created.body.crane.id}`, {
      token: tokenA,
      body: cranePayload({
        serialRegistrationNo: "D4-READY-1",
        currentStatus: "UNDER_MAINTENANCE",
        expectedReadyDate: "2026-12-15",
      }),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.crane.expectedReadyDate).toContain("2026-12-15");
    const after = await testPrisma.crane.findUniqueOrThrow({ where: { id: created.body.crane.id } });
    expect(after.statusUpdatedAt.getTime()).toBeGreaterThan(before.statusUpdatedAt.getTime());

    // The quick status-and-location action carries it too.
    const quick = await call(app, "PATCH", `/api/cranes/${created.body.crane.id}/status-location`, {
      token: tokenA,
      body: {
        currentStatus: "UNDER_MAINTENANCE",
        currentLocation: "Surat Yard",
        stateCode: "GJ",
        expectedReadyDate: "2027-01-05",
      },
    });
    expect(quick.status).toBe(200);
    expect(quick.body.crane.expectedReadyDate).toContain("2027-01-05");

    // The audit trail records the change to the ready date.
    const audit = await testPrisma.auditLog.findFirst({
      where: { entity: "crane", entityId: created.body.crane.id, action: "crane_updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects an impossible expected_ready_date", async () => {
    const res = await call(app, "POST", "/api/cranes", {
      token: tokenA,
      body: cranePayload({
        serialRegistrationNo: "D4-BAD-DATE",
        currentStatus: "UNDER_MAINTENANCE",
        expectedReadyDate: "2026-02-31",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("fleet: updates on behalf of a vendor (D1)", () => {
  it("marks the audit when a sales user edits, without emailing the vendor", async () => {
    await call(app, "PUT", `/api/cranes/${ctx.a.craneId}`, {
      token: ctx.salesToken,
      body: cranePayload({
        currentLocation: "SML Updated Yard",
        vendorId: ctx.a.vendorId,
      }),
    });

    const crane = await testPrisma.crane.findUniqueOrThrow({ where: { id: ctx.a.craneId } });
    expect(crane.updatedOnBehalf).toBe(true);

    const mail = await testPrisma.emailLog.findFirst({
      where: { template: "fleet_updated_on_behalf" },
      orderBy: { createdAt: "desc" },
    });
    expect(mail).toBeNull();

    const audit = await testPrisma.auditLog.findFirst({
      where: { entity: "crane", entityId: ctx.a.craneId, action: "crane_updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.onBehalfOfVendor).toBe(true);
  });

  it("clears the on-behalf mark when the vendor next edits their crane", async () => {
    await call(app, "PUT", `/api/cranes/${ctx.a.craneId}`, {
      token: ctx.salesToken,
      body: { ...cranePayload({ currentLocation: "SML Updated Yard" }), vendorId: ctx.a.vendorId },
    });
    expect(
      (await testPrisma.crane.findUniqueOrThrow({ where: { id: ctx.a.craneId } })).updatedOnBehalf,
    ).toBe(true);

    await call(app, "PUT", `/api/cranes/${ctx.a.craneId}`, {
      token: tokenA,
      body: cranePayload({ currentLocation: "Vendor Yard Again" }),
    });
    expect(
      (await testPrisma.crane.findUniqueOrThrow({ where: { id: ctx.a.craneId } })).updatedOnBehalf,
    ).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// "Fill from link" on the crane form (brief 6.3)
// ---------------------------------------------------------------------------

/**
 * The preview is read-only: it turns a pasted Google Maps link into the fields
 * the form would fill. These tests pin the two halves of that promise — a link
 * with a place and a pin fills both, and a link that knows less leaves the rest
 * empty rather than inventing it. The suite forces GEO_PROVIDER=stub, so the
 * reverse lookup is deliberately unavailable here; that is the point of the
 * "coordinates only" case below.
 */
describe("fleet: location preview from a Google Maps link", () => {
  const preview = (token: string | undefined, link: string) =>
    call(app, "POST", "/api/cranes/location-preview", {
      ...(token ? { token } : {}),
      body: { link },
    });

  it("fills the location, state, pincode and pin from a full link", async () => {
    const res = await preview(
      tokenA,
      "https://www.google.com/maps/place/Ahmedabad+Yard,+GJ+380015/@23.0225,72.5714,17z",
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const location = res.body.location;
    expect(location.latitude).toBeCloseTo(23.0225, 5);
    expect(location.longitude).toBeCloseTo(72.5714, 5);
    expect(location.currentLocation).toBe("Ahmedabad Yard");
    expect(location.stateCode).toBe("GJ");
    expect(location.stateName).toBe("State GJ");
    expect(location.pincode).toBe("380015");
    expect(location.source).toBe("maps_link");
    expect(location.note).toMatch(/Filled/);
  });

  it("geocodes a link that names a place but carries no pin", async () => {
    const res = await preview(
      tokenA,
      "https://www.google.com/maps?q=Surat+Yard,+GJ+395003",
    );

    expect(res.status).toBe(200);
    const location = res.body.location;
    expect(location.latitude).not.toBeNull();
    expect(location.longitude).not.toBeNull();
    expect(location.currentLocation).toBe("Surat Yard");
    expect(location.stateCode).toBe("GJ");
    expect(location.pincode).toBe("395003");
    // The pin came from the provider, not from the URL.
    expect(location.source).toBe("place_text");
  });

  it("returns the pin from a coordinates-only link and says what is missing", async () => {
    const res = await preview(
      tokenA,
      "https://www.google.com/maps?q=23.0225,72.5714",
    );

    expect(res.status).toBe(200);
    const location = res.body.location;
    expect(location.latitude).toBeCloseTo(23.0225, 5);
    expect(location.longitude).toBeCloseTo(72.5714, 5);
    expect(location.currentLocation).toBeNull();
    expect(location.stateCode).toBeNull();
    expect(location.pincode).toBeNull();
    expect(location.note).toMatch(/Could not tell/i);
  });

  it("returns a note, not an error, for a link that is not Google Maps", async () => {
    const res = await preview(tokenA, "https://example.com/where-is-this");

    expect(res.status).toBe(200);
    expect(res.body.location.latitude).toBeNull();
    expect(res.body.location.source).toBe("none");
    expect(res.body.location.note).toMatch(/not a Google Maps link/i);
  });

  it("is open to a sales user writing on a vendor's behalf", async () => {
    const res = await preview(
      ctx.salesToken,
      "https://www.google.com/maps/place/Ahmedabad+Yard/@23.0225,72.5714,17z",
    );
    expect(res.status).toBe(200);
    expect(res.body.location.latitude).toBeCloseTo(23.0225, 5);
  });

  it("refuses an anonymous caller", async () => {
    const res = await preview(undefined, "https://www.google.com/maps?q=23.0225,72.5714");
    expect(res.status).toBe(401);
  });
});
