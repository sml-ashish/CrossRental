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
 * P4: discovery, detail screens and history viewers.
 *
 * These pin the rules the P4 screens lean on:
 *
 * - manual vendor discovery (BPD 6.8) finds approved vendors' cranes with no
 *   enquiry, filters them, and ranks them by distance only when a site pin is
 *   given — the stub provider, not a real one (item 13);
 * - the vendor detail (6.10) carries fleet, categories and participation, and a
 *   sales user never receives bank details through it;
 * - the crane detail (6.11) carries the calendar, maintenance flags and the
 *   transport-cost assumption, and reports the next free date from reservations;
 * - the communication history (6.21) reads the email log for an enquiry/RFQ and
 *   marks which messages carried a business event;
 * - the audit viewer (5.14) reconstructs the sourcing history of an enquiry;
 * - vendors reach none of it.
 *
 * Every value here is fabricated (brief working rule 3).
 */

vi.mock("../lib/mailer", () => ({
  sendMail: vi.fn(async () => ({ sent: true })),
}));

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
  vendorTokenA: string;
}

let ctx: Ctx;

beforeEach(async () => {
  const fixtures = await seedIsolationFixtures();
  ctx = {
    a: fixtures.vendorA,
    b: fixtures.vendorB,
    adminToken: await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user"),
    salesToken: await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user"),
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

function search(query: string, token: string) {
  return call(app, "GET", `/api/discovery/cranes${query ? `?${query}` : ""}`, { token });
}

describe("manual vendor discovery (P4, BPD 6.8)", () => {
  it("lists approved vendors' cranes grouped by vendor, with no enquiry", async () => {
    const res = await search("craneType=CRAWLER", ctx.salesToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totalMatched).toBe(2);
    expect(res.body.distancesAvailable).toBe(false);
    const names = res.body.groups.map((g: { vendorName: string }) => g.vendorName).sort();
    expect(names).toEqual(["Isolation Vendor A", "Isolation Vendor B"]);
    expect(res.body.groups[0].cranes[0].typeOfCraneName).toBe("Crawler Crane");
  });

  it("ranks by distance only when a site pin is supplied", async () => {
    // Park vendor A far from the site and vendor B on it.
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { latitude: 28.6, longitude: 77.2 },
    });

    const res = await search("craneType=CRAWLER&siteLat=22.5&siteLng=72.5", ctx.salesToken);
    expect(res.status).toBe(200);
    expect(res.body.distancesAvailable).toBe(true);
    expect(res.body.groups.map((g: { vendorName: string }) => g.vendorName)).toEqual([
      "Isolation Vendor B",
      "Isolation Vendor A",
    ]);
    expect(res.body.groups[0].nearestKm).toBeLessThan(res.body.groups[1].nearestKm);
  });

  it("reuses a road distance across searches at a three-decimal coordinate", async () => {
    // The cache key is a `numeric` column and the search pins are floats. A
    // value like 23.023 has no exact binary form, so a number-keyed lookup
    // silently missed every time and each search re-billed the provider. This
    // pins the cache to a coordinate that exposes that.
    const { setGeoProvider } = await import("../lib/geo");
    let calls = 0;
    setGeoProvider({
      name: "counting-road",
      isAuthoritative: true,
      async geocode() {
        return { ok: false as const, reason: "unavailable" };
      },
      async roadDistance() {
        calls += 1;
        return { ok: true as const, km: 88.8, method: "road" as const, provider: "counting-road" };
      },
    });

    try {
      await appPrisma.crane.update({
        where: { id: ctx.a.craneId },
        data: { latitude: 23.023, longitude: 72.571 },
      });
      await appPrisma.crane.update({
        where: { id: ctx.b.craneId },
        data: { latitude: 23.041, longitude: 72.591 },
      });

      const query = "craneType=CRAWLER&siteLat=22.2976944&siteLng=73.203784";
      const first = await search(query, ctx.salesToken);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const afterFirst = calls;
      expect(afterFirst).toBeGreaterThan(0);

      const second = await search(query, ctx.salesToken);
      expect(second.body.groups[0].nearestKm).toBe(88.8);
      expect(calls).toBe(afterFirst);
    } finally {
      setGeoProvider(null);
    }
  });

  it("geocodes a typed job-site address into a ranking pin", async () => {
    // The configured provider is replaced with a fixed answer so the ranking is
    // deterministic; this tests the address path, not the geocoder itself.
    const { setGeoProvider } = await import("../lib/geo");
    setGeoProvider({
      name: "test-geocoder",
      isAuthoritative: true,
      async geocode() {
        return { ok: true, point: { lat: 22.5, lng: 72.5 }, provider: "test-geocoder" };
      },
      async roadDistance() {
        return { ok: true, km: 10, method: "road", provider: "test-geocoder" };
      },
    });

    try {
      await appPrisma.crane.update({
        where: { id: ctx.a.craneId },
        data: { latitude: 28.6, longitude: 77.2 },
      });

      const res = await search(
        "craneType=CRAWLER&siteLocation=Vadodara&sitePincode=390001",
        ctx.salesToken,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.distancesAvailable).toBe(true);
      expect(res.body.site).toEqual({ latitude: 22.5, longitude: 72.5 });
      expect(res.body.groups.map((g: { vendorName: string }) => g.vendorName)).toEqual([
        "Isolation Vendor B",
        "Isolation Vendor A",
      ]);
    } finally {
      setGeoProvider(null);
    }
  });

  it("filters by capacity, availability, company size, fleet size and year", async () => {
    await appPrisma.vendor.update({
      where: { id: ctx.a.vendorId },
      data: { companySize: "LARGE", totalFleetSize: 5 },
    });
    await appPrisma.vendor.update({
      where: { id: ctx.b.vendorId },
      data: { companySize: "SMALL", totalFleetSize: 1 },
    });

    // Capacity at least 100 matches both; exactly 300 matches none.
    expect((await search("capacityT=100", ctx.salesToken)).body.totalMatched).toBe(2);
    expect((await search("capacityT=300", ctx.salesToken)).body.totalMatched).toBe(0);
    expect(
      (await search("capacityT=250&capacityRule=EXACT", ctx.salesToken)).body.totalMatched,
    ).toBe(2);

    // Availability: nothing is Engaged.
    expect((await search("availability=ENGAGED", ctx.salesToken)).body.totalMatched).toBe(0);
    expect((await search("availability=AVAILABLE", ctx.salesToken)).body.totalMatched).toBe(2);

    // Company size and fleet size narrow to vendor A.
    const large = await search("companySize=LARGE", ctx.salesToken);
    expect(large.body.groups.map((g: { vendorName: string }) => g.vendorName)).toEqual([
      "Isolation Vendor A",
    ]);
    const fleets = await search("fleetSizeMin=3", ctx.salesToken);
    expect(fleets.body.groups.map((g: { vendorName: string }) => g.vendorName)).toEqual([
      "Isolation Vendor A",
    ]);

    // Year and ownership.
    expect((await search("yomFrom=2023", ctx.salesToken)).body.totalMatched).toBe(0);
    expect((await search("ownershipType=SML", ctx.salesToken)).body.totalMatched).toBe(0);
    expect((await search("ownershipType=VENDOR", ctx.salesToken)).body.totalMatched).toBe(2);
  });

  it("filters by vendor name and free-text location", async () => {
    const byName = await search("vendorName=Vendor+A", ctx.salesToken);
    expect(byName.body.groups.map((g: { vendorName: string }) => g.vendorName)).toEqual([
      "Isolation Vendor A",
    ]);
    // Both yards are named "<X> Yard".
    expect((await search("location=Yard", ctx.salesToken)).body.totalMatched).toBe(2);
  });

  it("returns filter facets", async () => {
    const res = await call(app, "GET", "/api/discovery/facets", { token: ctx.salesToken });
    expect(res.status).toBe(200);
    expect(res.body.craneTypes.some((t: { code: string }) => t.code === "CRAWLER")).toBe(true);
    expect(res.body.states.some((s: { code: string }) => s.code === "GJ")).toBe(true);
  });

  it("refuses a vendor", async () => {
    expect((await search("craneType=CRAWLER", ctx.vendorTokenA)).status).toBe(403);
  });
});

describe("vendor detail (P4, BPD 6.10)", () => {
  function profile(vendorId: string, token: string) {
    return call(app, "GET", `/api/vendors/${vendorId}/profile`, { token });
  }

  it("returns fleet, categories and participation, and no bank details to sales", async () => {
    const res = await profile(ctx.a.vendorId, ctx.salesToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.profile;
    expect(p.vendor.name).toBe("Isolation Vendor A");
    expect(p.vendor.onboardingStatus).toBe("APPROVED");
    expect(p.fleet).toHaveLength(1);
    expect(p.categories.map((c: { code: string }) => c.code)).toContain("CRAWLER");
    expect(p.contacts).toHaveLength(1);
    expect(p.participation).toMatchObject({ invitations: 0, quoted: 0, awarded: 0 });
    // Bank detail is not selected anywhere in this payload.
    expect(JSON.stringify(res.body)).not.toContain("bank");
  });

  it("lets an admin read it too", async () => {
    expect((await profile(ctx.a.vendorId, ctx.adminToken)).status).toBe(200);
  });

  it("refuses a vendor", async () => {
    expect((await profile(ctx.a.vendorId, ctx.vendorTokenA)).status).toBe(403);
  });
});

describe("crane detail (P4, BPD 6.11)", () => {
  function profile(craneId: string, token: string) {
    return call(app, "GET", `/api/cranes/${craneId}/profile`, { token });
  }

  it("returns the crane, its calendar, maintenance flags and transport assumption", async () => {
    const res = await profile(ctx.a.craneId, ctx.salesToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.profile;
    expect(p.crane.id).toBe(ctx.a.craneId);
    expect(p.calendar.cranes).toHaveLength(1);
    expect(p.calendar.cranes[0].craneId).toBe(ctx.a.craneId);
    expect(Array.isArray(p.maintenanceFlags)).toBe(true);
    expect(p.transportAssumptions.note).toBeTypeOf("string");
    // An available crane is free today.
    expect(p.nextAvailableDate).not.toBeNull();
  });

  it("pushes the next free date past an active booking", async () => {
    const end = inDays(10);
    await appPrisma.reservation.create({
      data: {
        craneId: ctx.a.craneId,
        type: "BOOKED",
        status: "ACTIVE",
        startDate: inDays(2),
        endDate: end,
      },
    });

    const res = await profile(ctx.a.craneId, ctx.salesToken);
    expect(res.status).toBe(200);
    expect(res.body.profile.reservations).toHaveLength(1);
    const next = new Date(res.body.profile.nextAvailableDate).getTime();
    expect(next).toBeGreaterThan(end.getTime());
  });

  it("refuses a vendor", async () => {
    expect((await profile(ctx.a.craneId, ctx.vendorTokenA)).status).toBe(403);
  });
});

describe("communication history (P4, BPD 6.21)", () => {
  async function quotedEnquiry() {
    const created = await call(app, "POST", "/api/enquiries", {
      token: ctx.salesToken,
      body: {
        customerName: "Secret Customer Co",
        customerAddress: "17 Hidden Industrial Estate",
        siteLocation: "Vadodara",
        siteStateCode: "GJ",
        lines: [
          {
            craneTypeCode: "CRAWLER",
            capacityT: 100,
            capacityRule: "AT_LEAST",
            quantity: 1,
            requiredStartDate: inDays(30).toISOString(),
            durationValue: 4,
            durationUnit: "MONTHS",
          },
        ],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const enquiryId = created.body.enquiry.id as string;
    const lineId = created.body.enquiry.lines[0].id as string;

    const rfq = await call(app, "POST", `/api/enquiries/lines/${lineId}/rfq`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(7).toISOString() },
    });
    expect(rfq.status, JSON.stringify(rfq.body)).toBe(201);
    const rfqId = rfq.body.rfq.id as string;

    const sent = await call(app, "POST", `/api/rfqs/${rfqId}/send`, {
      token: ctx.salesToken,
      body: { vendorIds: [ctx.a.vendorId, ctx.b.vendorId] },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    return { enquiryId, lineId, rfqId };
  }

  it("lists the messages behind an enquiry, flagging business events", async () => {
    const { enquiryId } = await quotedEnquiry();
    const res = await call(app, "GET", `/api/communications?enquiryId=${enquiryId}`, {
      token: ctx.salesToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const messages = res.body.history.messages;
    expect(messages.length).toBeGreaterThan(0);
    const invitation = messages.find(
      (m: { template: string }) => m.template === "rfq_invitation",
    );
    expect(invitation).toBeTruthy();
    expect(invitation.businessEvent).toBe("RFQ dispatched");
    expect(invitation.channel).toBe("EMAIL");
    expect(res.body.history.inboundCaptured).toBe(true);
  });

  it("scopes to a single RFQ", async () => {
    const { rfqId } = await quotedEnquiry();
    const res = await call(app, "GET", `/api/communications?rfqId=${rfqId}`, {
      token: ctx.salesToken,
    });
    expect(res.status).toBe(200);
    expect(
      res.body.history.messages.every((m: { entity: string }) => m.entity === "rfq"),
    ).toBe(true);
  });

  it("refuses a vendor", async () => {
    const { enquiryId } = await quotedEnquiry();
    const res = await call(app, "GET", `/api/communications?enquiryId=${enquiryId}`, {
      token: ctx.vendorTokenA,
    });
    expect(res.status).toBe(403);
  });
});

describe("audit trail viewer (P4, BPD 5.14)", () => {
  it("reconstructs the sourcing history of an enquiry", async () => {
    const created = await call(app, "POST", "/api/enquiries", {
      token: ctx.salesToken,
      body: {
        customerName: "Secret Customer Co",
        customerAddress: "17 Hidden Industrial Estate",
        siteLocation: "Vadodara",
        siteStateCode: "GJ",
        lines: [
          {
            craneTypeCode: "CRAWLER",
            capacityT: 100,
            capacityRule: "AT_LEAST",
            quantity: 1,
            requiredStartDate: inDays(30).toISOString(),
            durationValue: 4,
            durationUnit: "MONTHS",
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    const enquiryId = created.body.enquiry.id as string;
    const lineId = created.body.enquiry.lines[0].id as string;
    await call(app, "POST", `/api/enquiries/lines/${lineId}/rfq`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(7).toISOString() },
    });

    const res = await call(app, "GET", `/api/enquiries/${enquiryId}/history`, {
      token: ctx.salesToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const entries = res.body.history.entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e: { entity: string }) => e.entity === "enquiry_line")).toBe(true);
    expect(entries.some((e: { entity: string }) => e.entity === "rfq")).toBe(true);
    expect(entries.every((e: { at: string }) => typeof e.at === "string")).toBe(true);
  });

  it("refuses a vendor", async () => {
    const res = await call(app, "GET", "/api/enquiries/missing/history", {
      token: ctx.vendorTokenA,
    });
    expect(res.status).toBe(403);
  });
});
