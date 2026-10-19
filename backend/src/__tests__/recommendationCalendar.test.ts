import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  type SeededVendor,
} from "./harness";
import { INTERNAL_USERS, VENDOR_PASSWORD, VENDOR_USERS } from "./fixtures";

/**
 * P2: recommendation engine, mobilisation cost and the booking calendar.
 *
 * The done-when is a set of guarantees rather than one screen:
 *
 * - the SML and vendor sets are separate, with the vendor set ranked by
 *   distance and priced;
 * - a crane with an overlapping reservation does not appear;
 * - a crane whose boom or jib is too short carries a warning;
 * - a snapshot is viewable later even after the cranes move;
 * - the calendar shows reservations and releasing one frees the crane.
 *
 * Distances run on the geocoding stub (open item 13), so they are synthetic and
 * labelled straight-line. Every value here is fabricated (working rule 3).
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<{ to: string }>,
}));

vi.mock("../lib/mailer", () => ({
  sendMail: vi.fn(async (mail: { to: string }) => {
    sentMail.push({ to: mail.to });
    return { sent: true };
  }),
}));

let app: Express;

beforeAll(async () => {
  useTestDatabase();
  const { createApp } = await import("../index");
  app = createApp();
});

beforeEach(async () => {
  await resetTestDatabase();
  sentMail.length = 0;
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
  vendorTokenA: string;
}

let ctx: Ctx;

beforeEach(async () => {
  const fixtures = await seedIsolationFixtures();
  ctx = {
    a: fixtures.vendorA,
    b: fixtures.vendorB,
    adminToken: await internalToken(
      fixtures.adminId,
      INTERNAL_USERS.admin,
      "admin_user",
    ),
    salesToken: await internalToken(
      fixtures.salesId,
      INTERNAL_USERS.sales,
      "sales_user",
    ),
    vendorTokenA: await signInVendor(VENDOR_USERS.a),
  };
});

async function signInVendor(email: string): Promise<string> {
  const res = await call(app, "POST", "/api/auth/login", {
    body: { email, password: VENDOR_PASSWORD },
  });
  expect(res.status, `login failed: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const isoDate = (days: number) => inDays(days).toISOString().slice(0, 10);

/** Nudges a point but never outside the India bounds the database enforces. */
function shiftWithinIndia(lat: number, lng: number, dLat: number) {
  return {
    latitude: Math.min(Math.max(lat + dLat, 6.5), 37.5),
    longitude: Math.min(Math.max(lng, 68.5), 97.5),
  };
}

function linePayload(overrides: Record<string, unknown> = {}) {
  return {
    craneTypeCode: "CRAWLER",
    capacityT: 100,
    capacityRule: "AT_LEAST",
    quantity: 1,
    requiredStartDate: inDays(10).toISOString(),
    durationValue: 1,
    durationUnit: "DAYS",
    ...overrides,
  };
}

async function createEnquiryWithLine(overrides: Record<string, unknown> = {}) {
  const res = await call(app, "POST", "/api/enquiries", {
    token: ctx.salesToken,
    body: {
      customerName: "Private Customer",
      customerAddress: "Somewhere confidential",
      siteLocation: "Vadodara",
      siteStateCode: "GJ",
      sitePincode: "390001",
      lines: [linePayload(overrides)],
    },
  });
  expect(res.status, `create failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.enquiry.lines[0].id as string;
}

async function loadRecommendations(lineId: string, token: string) {
  return call(app, "GET", `/api/enquiries/lines/${lineId}/recommendations`, {
    token,
  });
}

async function refreshRecommendations(lineId: string, token: string) {
  return call(
    app,
    "POST",
    `/api/enquiries/lines/${lineId}/recommendations/refresh`,
    { token },
  );
}

describe("recommendation engine (P2)", () => {
  it("keeps the SML and vendor sets separate, prices the vendor set and snapshots it", async () => {
    const lineId = await createEnquiryWithLine({ requiredMainBoomM: 80 });

    const res = await loadRecommendations(lineId, ctx.salesToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { recommendations, snapshots } = res.body;

    // SML has no crane fleet: the section exists but holds no cranes, and it
    // carries the manual internal check instead.
    expect(recommendations.sml.ownership).toBe("SML");
    expect(recommendations.sml.cranes).toHaveLength(0);
    expect(recommendations.sml.internalCheck.trailStatus).toBe("NEW");

    // Vendor set: both approved vendors have a matching crawler.
    expect(recommendations.vendor.ownership).toBe("VENDOR");
    expect(recommendations.vendor.groups).toHaveLength(2);

    const cranes = recommendations.vendor.groups.flatMap(
      (group: any) => group.cranes,
    );
    expect(cranes.length).toBe(2);
    for (const crane of cranes) {
      // ₹720/km for a 150-400 t crawler (600 base x 1.2 band), and every row
      // is priced off its distance.
      expect(crane.ratePerKm).toBe(720);
      expect(crane.estimatedMobilisationCost).toBe(
        Math.round(crane.distanceKm * 720),
      );
      // Boom 50 m against the 80 m required: warned.
      expect(crane.boomWarnings.length).toBeGreaterThan(0);
    }

    // One snapshot was written at evaluation time.
    expect(snapshots).toHaveLength(1);
    expect(recommendations.snapshotId).toBe(snapshots[0].id);
    expect(recommendations.provider).toBe("stub");
  });

  it("ranks the vendor set by distance and re-ranks on refresh", async () => {
    const lineId = await createEnquiryWithLine();
    const first = await loadRecommendations(lineId, ctx.salesToken);
    const site = first.body.recommendations.site;
    expect(site.latitude).not.toBeNull();

    // Put A on the site and B a proper distance away, then re-run.
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { latitude: site.latitude, longitude: site.longitude },
    });
    const far = shiftWithinIndia(site.latitude, site.longitude, 8);
    await appPrisma.crane.update({
      where: { id: ctx.b.craneId },
      data: far,
    });

    const refreshed = await refreshRecommendations(lineId, ctx.salesToken);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const groups = refreshed.body.recommendations.vendor.groups;
    expect(groups[0].vendorId).toBe(ctx.a.vendorId);
    expect(groups[0].nearestKm).toBeLessThan(groups[1].nearestKm);
    expect(refreshed.body.snapshots).toHaveLength(2);
  });

  it("shows the snapshot unchanged after the cranes move, until refresh", async () => {
    const lineId = await createEnquiryWithLine();
    const first = await loadRecommendations(lineId, ctx.salesToken);
    const snapshotId = first.body.recommendations.snapshotId;
    const vendorIdAtEvaluation = first.body.recommendations.vendor.groups[0].vendorId;

    // Move both cranes to the same far point — a recompute would reorder or
    // change the distances.
    await appPrisma.crane.updateMany({
      data: { latitude: 10.5, longitude: 77.5 },
    });

    const again = await loadRecommendations(lineId, ctx.salesToken);
    expect(again.body.recommendations.snapshotId).toBe(snapshotId);
    expect(again.body.recommendations.vendor.groups[0].vendorId).toBe(
      vendorIdAtEvaluation,
    );
    expect(again.body.snapshots).toHaveLength(1);
  });

  it("excludes a crane with an overlapping active reservation", async () => {
    const lineId = await createEnquiryWithLine();

    await appPrisma.reservation.create({
      data: {
        craneId: ctx.a.craneId,
        startDate: inDays(9),
        endDate: inDays(11),
        type: "BOOKED",
        status: "ACTIVE",
      },
    });

    const res = await loadRecommendations(lineId, ctx.salesToken);
    expect(res.status).toBe(200);
    const vendorIds = res.body.recommendations.vendor.groups.map(
      (group: any) => group.vendorId,
    );
    expect(vendorIds).not.toContain(ctx.a.vendorId);
    expect(vendorIds).toContain(ctx.b.vendorId);
  });

  it("keeps vendors out of recommendations", async () => {
    const lineId = await createEnquiryWithLine();
    const res = await loadRecommendations(lineId, ctx.vendorTokenA);
    expect(res.status).toBe(403);
  });
});

describe("booking calendar (P2)", () => {
  it("shows a reservation and releasing it frees the crane", async () => {
    const created = await call(app, "POST", "/api/reservations", {
      token: ctx.adminToken,
      body: {
        craneId: ctx.a.craneId,
        startDate: isoDate(0),
        endDate: isoDate(3),
        reason: "Scheduled maintenance window",
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const reservationId = created.body.reservation.id as string;

    const url = `/api/reservations/calendar?from=${isoDate(0)}&to=${isoDate(6)}`;
    const calendar = await call(app, "GET", url, { token: ctx.adminToken });
    expect(calendar.status, JSON.stringify(calendar.body)).toBe(200);

    const row = calendar.body.calendar.cranes.find(
      (crane: any) => crane.craneId === ctx.a.craneId,
    );
    expect(row).toBeTruthy();
    expect(row.ownershipType).toBe("VENDOR");
    expect(row.days[0].state).toBe("BLOCKED");

    const released = await call(
      app,
      "POST",
      `/api/reservations/${reservationId}/release`,
      { token: ctx.adminToken, body: { reason: "Maintenance postponed" } },
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);

    const after = await call(app, "GET", url, { token: ctx.adminToken });
    const freed = after.body.calendar.cranes.find(
      (crane: any) => crane.craneId === ctx.a.craneId,
    );
    expect(freed.days[0].state).toBe("FREE");
  });

  it("filters by ownership type", async () => {
    const url = `/api/reservations/calendar?from=${isoDate(0)}&to=${isoDate(6)}`;
    const vendorOnly = await call(
      app,
      "GET",
      `${url}&ownershipType=VENDOR`,
      { token: ctx.salesToken },
    );
    expect(vendorOnly.status).toBe(200);
    expect(vendorOnly.body.calendar.cranes.length).toBeGreaterThan(0);

    // There is no SML crane fleet, so the SML filter is empty by construction.
    const smlOnly = await call(
      app,
      "GET",
      `${url}&ownershipType=SML`,
      { token: ctx.salesToken },
    );
    expect(smlOnly.body.calendar.cranes).toHaveLength(0);
  });

  it("keeps vendors out of the calendar", async () => {
    const url = `/api/reservations/calendar?from=${isoDate(0)}&to=${isoDate(6)}`;
    const res = await call(app, "GET", url, { token: ctx.vendorTokenA });
    expect(res.status).toBe(403);
  });
});
