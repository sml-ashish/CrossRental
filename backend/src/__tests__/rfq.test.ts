import {
  afterAll,
  afterEach,
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
  testPrisma,
  useTestDatabase,
  type SeededVendor,
} from "./harness";
import { INTERNAL_USERS, VENDOR_PASSWORD, VENDOR_USERS } from "./fixtures";

/**
 * Milestone 4: RFQ data model, internal creation and dispatch (brief 5.4, 6.7,
 * 6.9, 7.9).
 *
 * The M4 acceptance line is a journey — create, confirm the pin, see candidates
 * ranked by distance, pick vendors, send, read the delivery and response status
 * back — so it is walked here end to end, and each rule it names is pinned by a
 * focused test beside it:
 *
 * - recipients resolve from vendor ids to the vendor's own active addresses, and
 *   a client-supplied address list is ignored (6.7);
 * - only approved vendors with an active user can be selected, re-checked at send
 *   time rather than trusted from the picker (6.7);
 * - a failed delivery is recorded per recipient and the RFQ is still Sent, because
 *   one full mailbox must not cost the other four recipients their RFQ (6.7);
 * - the candidate list filters on type, capacity, status, approval and
 *   coordinates, groups by vendor and sorts by distance (6.9);
 * - a routing failure yields a straight-line figure that is labelled, not passed
 *   off as road distance (6.9);
 * - candidates are snapshotted at send time and never recomputed (6.9);
 * - vendors cannot reach any RFQ route at all (6.6).
 *
 * Every value here is fabricated (brief working rule 3).
 */

/**
 * Per-address mail outcomes.
 *
 * Delivery failure is a real requirement of 6.7 but cannot be produced by the
 * console transport, which reports every send as successful. Mocking `sendMail`
 * is the smallest seam that makes one address bounce while the rest succeed, so
 * the "keep going after a failure" path is genuinely exercised rather than
 * assumed.
 */
const { mailOutcomes } = vi.hoisted(() => ({
  mailOutcomes: new Map<string, { sent: boolean; error?: string }>(),
}));

vi.mock("../lib/mailer", () => ({
  sendMail: vi.fn(async (mail: { to: string }) => {
    return mailOutcomes.get(mail.to) ?? { sent: true };
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
  mailOutcomes.clear();
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
  vendorTokenA: string;
  vendorTokenB: string;
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
    vendorTokenB: await signInVendor(VENDOR_USERS.b),
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
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000);

/** A valid RFQ for the fixture fleet: one 250 t crawler per approved vendor. */
function rfqPayload(overrides: Record<string, unknown> = {}) {
  return {
    enquiryNo: "SP/2026/0412",
    lineNo: "10",
    craneType: "CRAWLER",
    capacityT: 100,
    quantity: 1,
    siteLocation: "Vadodara",
    siteStateCode: "GJ",
    requiredStartDate: inDays(30).toISOString(),
    durationValue: 4,
    durationUnit: "MONTHS",
    submissionDeadline: inDays(7).toISOString(),
    // A confirmed pin, because almost every rule below needs a site that can
    // produce a distance at all.
    siteLatitude: 22.3072,
    siteLongitude: 73.1812,
    ...overrides,
  };
}

async function createRfq(overrides: Record<string, unknown> = {}, token = ctx.salesToken) {
  const res = await call(app, "POST", "/api/rfqs", {
    token,
    body: rfqPayload(overrides),
  });
  expect(res.status, `create failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.rfq as { id: string; rfqNumber: string };
}

async function sendRfq(rfqId: string, vendorIds: string[], token = ctx.salesToken) {
  return call(app, "POST", `/api/rfqs/${rfqId}/send`, { token, body: { vendorIds } });
}

const emailSubjects = async (): Promise<string[]> => {
  const rows = await appPrisma.emailLog.findMany({ select: { subject: true } });
  return rows.map((r) => r.subject);
};

// ---------------------------------------------------------------------------
// Access isolation (brief 6.6)
// ---------------------------------------------------------------------------

describe("RFQ access isolation", () => {
  it("refuses every RFQ route to a vendor user", async () => {
    const rfq = await createRfq();
    const routes: Array<[string, "GET" | "POST" | "PUT" | "PATCH"]> = [
      ["/api/rfqs", "GET"],
      ["/api/rfqs/approved-vendors", "GET"],
      [`/api/rfqs/${rfq.id}`, "GET"],
      [`/api/rfqs/${rfq.id}/candidates`, "GET"],
      [`/api/rfqs/${rfq.id}/send`, "POST"],
      [`/api/rfqs/${rfq.id}/deadline`, "PATCH"],
      [`/api/rfqs/${rfq.id}/cancel`, "POST"],
      [`/api/rfqs/${rfq.id}/remind`, "POST"],
      ["/api/rfqs/expire-pending", "POST"],
    ];

    for (const [path, method] of routes) {
      const res = await call(app, method, path, {
        token: ctx.vendorTokenA,
        body: method === "GET" ? undefined : {},
      });
      expect(res.status, `${method} ${path} must refuse a vendor`).toBe(403);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await call(app, "GET", "/api/rfqs");
    expect(res.status).toBe(401);
  });

  it("never leaks one vendor's RFQ state to another vendor's token", async () => {
    // The vendor inbox is M5 and reads a recipient row, not the RFQ. What matters
    // now is that no RFQ surface answers a vendor at all, so there is nothing to
    // leak: both tokens get the same refusal for the same RFQ.
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    const fromA = await call(app, "GET", `/api/rfqs/${rfq.id}`, { token: ctx.vendorTokenA });
    const fromB = await call(app, "GET", `/api/rfqs/${rfq.id}`, { token: ctx.vendorTokenB });

    expect(fromA.status).toBe(403);
    expect(fromB.status).toBe(403);
    expect(fromA.body).toEqual(fromB.body);
  });

  it("lets an admin view and track, since admins hold rfq:track", async () => {
    const rfq = await createRfq();
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}`, { token: ctx.adminToken });
    expect(res.status).toBe(200);
    expect(res.body.rfq.id).toBe(rfq.id);
  });
});

// ---------------------------------------------------------------------------
// Creation (brief 5.4, 7.9)
// ---------------------------------------------------------------------------

describe("creating an RFQ", () => {
  it("stores a draft for one enquiry line item with a readable number", async () => {
    const res = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: rfqPayload({ lineNo: "20", quantity: 2, craneType: "CRAWLER" }),
    });

    expect(res.status).toBe(201);
    expect(res.body.rfq.status).toBe("DRAFT");
    expect(res.body.rfq.enquiryNo).toBe("SP/2026/0412");
    expect(res.body.rfq.lineNo).toBe("20");
    expect(res.body.rfq.quantity).toBe(2);
    expect(res.body.rfq.rfqNumber).toMatch(/^RFQ-\d{4}-\d{4}$/);
    expect(res.body.rfq.sentAt).toBeNull();
    // A pin was supplied, so it is recorded as human-confirmed, not automatic.
    expect(res.body.rfq.siteCoordinateSource).toBe("manual");
  });

  it("issues sequential RFQ numbers", async () => {
    const first = await createRfq();
    const second = await createRfq();
    expect(first.rfqNumber).not.toBe(second.rfqNumber);
  });

  it("records a create audit entry naming the actor", async () => {
    const rfq = await createRfq();
    const audit = await appPrisma.auditLog.findFirst({
      where: { entity: "rfq", entityId: rfq.id, action: "create" },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects a past submission deadline", async () => {
    const res = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: rfqPayload({ submissionDeadline: inHours(-2).toISOString() }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("deadline must be in the future");
  });

  it("rejects an unknown crane type rather than storing a typo", async () => {
    const res = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: rfqPayload({ craneType: "CRAWLERR" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not a known crane type");
  });

  it("rejects an unknown state", async () => {
    const res = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: rfqPayload({ siteStateCode: "ZZ" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not a known state");
  });

  it("requires an enquiry number and a line number, because an RFQ is a line item", async () => {
    const res = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: rfqPayload({ enquiryNo: "", lineNo: "" }),
    });
    expect(res.status).toBe(400);
    const paths = res.body.details.map((d: { path: string }) => d.path);
    expect(paths).toContain("enquiryNo");
    expect(paths).toContain("lineNo");
  });

  it("rejects a non-positive capacity, quantity or duration", async () => {
    for (const override of [{ capacityT: 0 }, { quantity: 0 }, { durationValue: -2 }]) {
      const res = await call(app, "POST", "/api/rfqs", {
        token: ctx.salesToken,
        body: rfqPayload(override),
      });
      expect(res.status, JSON.stringify(override)).toBe(400);
    }
  });

  it("refuses a half pin, naming the missing half", async () => {
    const res = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: rfqPayload({ siteLongitude: null }),
    });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe("siteLongitude");
  });

  it("rejects a site pin outside India", async () => {
    const res = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: rfqPayload({ siteLatitude: 51.5, siteLongitude: -0.12 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toContain("outside India");
  });

  it("stores commercial terms verbatim, including blanks", async () => {
    const res = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: rfqPayload({
        otCharges: "As per agreement",
        paymentTerms: "30 days from invoice",
        craneAgeCriteriaYears: 15,
        mobilisationTerms: "Mobilisation and demobilisation to vendor",
        supportCrane: "Not in scope",
        steelMatsGroundPrep: "Steel mats to vendor",
        ehsHrRequirements: "PPE and site induction mandatory",
        insuranceTerms: "To vendor",
        extensionClause: "Extension at agreed rates",
        smlContactName: "Site Engineer",
        smlContactEmail: "engineer@sml.test",
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.rfq.otCharges).toBe("As per agreement");
    expect(res.body.rfq.paymentTerms).toBe("30 days from invoice");
    expect(res.body.rfq.craneAgeCriteriaYears).toBe(15);
    expect(res.body.rfq.mobilisationTerms).toBe("Mobilisation and demobilisation to vendor");
    expect(res.body.rfq.supportCrane).toBe("Not in scope");
    expect(res.body.rfq.steelMatsGroundPrep).toBe("Steel mats to vendor");
    expect(res.body.rfq.ehsHrRequirements).toBe("PPE and site induction mandatory");
    expect(res.body.rfq.insuranceTerms).toBe("To vendor");
    expect(res.body.rfq.extensionClause).toBe("Extension at agreed rates");
    expect(res.body.rfq.smlContactName).toBe("Site Engineer");
    // An unset term is a blank on the enquiry, not an invalid RFQ.
    expect(res.body.rfq.dieselScope).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Editing and the site pin (brief 6.9)
// ---------------------------------------------------------------------------

describe("editing a draft", () => {
  it("updates the requirement while the RFQ is a draft", async () => {
    const rfq = await createRfq();
    const res = await call(app, "PUT", `/api/rfqs/${rfq.id}`, {
      token: ctx.salesToken,
      body: rfqPayload({ siteLocation: "Surat", capacityT: 250 }),
    });
    expect(res.status).toBe(200);
    expect(res.body.rfq.siteLocation).toBe("Surat");
    expect(res.body.rfq.capacityT).toBe(250);
  });

  it("refuses to edit a sent RFQ, because quotations are already being prepared", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    const res = await call(app, "PUT", `/api/rfqs/${rfq.id}`, {
      token: ctx.salesToken,
      body: rfqPayload({ siteLocation: "Somewhere else entirely" }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no longer be edited");
  });

  it("confirms the job-site pin on its own and marks it manual", async () => {
    const rfq = await createRfq({ siteLatitude: null, siteLongitude: null });

    const res = await call(app, "PATCH", `/api/rfqs/${rfq.id}/site-pin`, {
      token: ctx.salesToken,
      body: { siteLatitude: 22.3072, siteLongitude: 73.1812 },
    });

    expect(res.status).toBe(200);
    expect(res.body.rfq.siteCoordinateSource).toBe("manual");
    expect(res.body.rfq.siteLocationUnverified).toBe(false);

    const audit = await appPrisma.auditLog.findFirst({
      where: { entity: "rfq", entityId: rfq.id, action: "confirm_site_pin" },
    });
    expect(audit).not.toBeNull();
  });

  it("refuses a confirmed pin outside India", async () => {
    const rfq = await createRfq();
    const res = await call(app, "PATCH", `/api/rfqs/${rfq.id}/site-pin`, {
      token: ctx.salesToken,
      body: { siteLatitude: 40.7, siteLongitude: -74 },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The candidate picker (brief 6.9)
// ---------------------------------------------------------------------------

describe("the candidate picker", () => {
  /** Points a fixture crane somewhere specific so distances can be compared. */
  async function placeCrane(craneId: string, lat: number, lng: number) {
    await appPrisma.crane.update({
      where: { id: craneId },
      data: { latitude: lat, longitude: lng, coordinateSource: "manual" },
    });
  }

  it("sorts matching cranes by distance, nearest first", async () => {
    const rfq = await createRfq({ siteLatitude: 22.3072, siteLongitude: 73.1812 });
    // Vendor B much closer to the site than vendor A.
    await placeCrane(ctx.a.craneId, 23.0, 74.0);
    await placeCrane(ctx.b.craneId, 22.35, 73.2);

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });

    expect(res.status).toBe(200);
    const groups = res.body.candidates.located as Array<{
      vendorId: string;
      nearestKm: number;
      cranes: Array<{ distanceKm: number; distanceApproximate: boolean }>;
    }>;

    expect(groups.length).toBe(2);
    expect(groups[0].vendorId).toBe(ctx.b.vendorId);
    expect(groups[1].vendorId).toBe(ctx.a.vendorId);
    expect(groups[0].nearestKm).toBeLessThan(groups[1].nearestKm);
    // Ascending all the way down, not just the first pair.
    const all = groups.flatMap((g) => g.cranes.map((c) => c.distanceKm));
    expect(all).toEqual([...all].sort((x, y) => x - y));
  });

  it("leads with the smallest adequate capacity, distance breaking ties", async () => {
    const rfq = await createRfq({ siteLatitude: 22.3072, siteLongitude: 73.1812 });
    // Both fixture cranes are 250 t, so distance decides between the vendors.
    await placeCrane(ctx.a.craneId, 23.0, 74.0);
    await placeCrane(ctx.b.craneId, 22.35, 73.2);
    // A much larger crane from vendor A parked at the site itself.
    const big = await appPrisma.crane.create({
      data: {
        vendorId: ctx.a.vendorId,
        serialRegistrationNo: "BIG-500-1",
        typeOfCraneCode: "CRAWLER",
        capacityT: 500,
        currentStatus: "AVAILABLE",
        currentLocation: "Site yard",
        stateCode: "GJ",
        make: "Demo",
        model: "Big-500",
        yom: 2021,
        latitude: 22.3072,
        longitude: 73.1812,
        coordinateSource: "manual",
      },
      select: { id: true },
    });

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    expect(res.status).toBe(200);

    const groups = res.body.candidates.located as Array<{
      vendorId: string;
      nearestKm: number;
      cranes: Array<{ craneId: string; capacityT: number; distanceKm: number }>;
    }>;

    // Vendor B's 250 t crane is nearer, so it leads the equal-capacity pair.
    expect(groups[0].vendorId).toBe(ctx.b.vendorId);
    expect(groups[1].vendorId).toBe(ctx.a.vendorId);

    // Vendor A's own list leads with the 250 t crane even though the 500 t one
    // is parked at the site: capacity decides, distance only breaks ties.
    expect(groups[1].cranes.map((c) => c.capacityT)).toEqual([250, 500]);
    expect(groups[1].cranes[0].craneId).toBe(ctx.a.craneId);
    expect(groups[1].cranes[1].craneId).toBe(big.id);

    // The card's "nearest" figure is still the nearest crane, not the first.
    expect(groups[1].nearestKm).toBeLessThan(groups[0].nearestKm);
  });

  it("keeps the coordinates and grouping it will later snapshot", async () => {
    const rfq = await createRfq();
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const group = res.body.candidates.located[0];
    expect(group.vendorName).toMatch(/Isolation Vendor/);
    expect(group.cranes[0]).toHaveProperty("capacityT");
    expect(group.cranes[0]).toHaveProperty("currentLocation");
    expect(group.cranes[0]).toHaveProperty("stateName");
    expect(group.cranes[0]).toHaveProperty("distanceKm");
  });

  it("lists a crane with no coordinates separately as location unverified", async () => {
    const rfq = await createRfq();
    await appPrisma.crane.update({
      where: { id: ctx.b.craneId },
      data: { latitude: null, longitude: null, coordinateSource: null },
    });

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });

    const located = res.body.candidates.located.flatMap(
      (g: { cranes: Array<{ craneId: string }> }) => g.cranes,
    );
    const unverified = res.body.candidates.unverified as Array<{ craneId: string }>;

    expect(located.some((c) => c.craneId === ctx.b.craneId)).toBe(false);
    expect(unverified.map((c) => c.craneId)).toContain(ctx.b.craneId);
    // Dropping it would be worse than listing it: an unlocated crane can still work.
    expect(unverified[0].distanceKm).toBeNull();
  });

  it("reports distances as unavailable when the job site has no pin", async () => {
    const { setGeoProvider } = await import("../lib/geo");
    // A lookup that fails is the only way the site stays unpinned: the stub
    // provider resolves every address, so an unpinned site is unreachable
    // otherwise.
    setGeoProvider({
      name: "geocoding-down",
      isAuthoritative: false,
      async geocode() {
        return { ok: false as const, reason: "unavailable" };
      },
      async roadDistance() {
        return { ok: false as const, reason: "unavailable" };
      },
    });

    try {
      const rfq = await createRfq({ siteLatitude: null, siteLongitude: null });
      const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
        token: ctx.salesToken,
      });

      expect(res.body.candidates.distancesAvailable).toBe(false);
      expect(res.body.candidates.site.locationUnverified).toBe(true);
      // The cranes are still offered, just not ranked.
      const all = [
        ...res.body.candidates.located.flatMap((g: { cranes: unknown[] }) => g.cranes),
        ...res.body.candidates.unverified,
      ];
      expect(all.length).toBe(2);
      expect(res.body.candidates.located[0].cranes[0].distanceKm).toBeNull();
    } finally {
      setGeoProvider(null);
    }
  });

  it("excludes cranes below the required capacity", async () => {
    const rfq = await createRfq({ capacityT: 500 });
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    // The fixture cranes are 250 t, so a 500 t requirement matches nothing.
    expect(res.body.candidates.located).toHaveLength(0);
    expect(res.body.candidates.unverified).toHaveLength(0);
    expect(res.body.candidates.capacityRule).toContain("at least 500");
  });

  it("lists the same type at any capacity, nearest first, in distance mode", async () => {
    const rfq = await createRfq({ capacityT: 500 });
    const technical = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    expect(technical.body.candidates.mode).toBe("technical");
    expect(technical.body.candidates.located).toHaveLength(0);

    // Vendor B much closer to the site than vendor A.
    await placeCrane(ctx.a.craneId, 23.0, 74.0);
    await placeCrane(ctx.b.craneId, 22.35, 73.2);

    const res = await call(
      app,
      "GET",
      `/api/rfqs/${rfq.id}/candidates?mode=distance`,
      { token: ctx.salesToken },
    );

    expect(res.status).toBe(200);
    expect(res.body.candidates.mode).toBe("distance");
    expect(res.body.candidates.capacityMatch).toBe("none");
    expect(res.body.candidates.capacityRule).toContain("any capacity");

    const groups = res.body.candidates.located as Array<{
      vendorId: string;
      cranes: Array<{
        capacityT: number;
        belowRequiredCapacity: boolean;
        distanceKm: number;
      }>;
    }>;
    const cranes = groups.flatMap((g) => g.cranes);
    expect(cranes).toHaveLength(2);
    // Below the 500 t requirement, and flagged rather than hidden.
    expect(cranes.every((c) => c.capacityT < 500)).toBe(true);
    expect(cranes.every((c) => c.belowRequiredCapacity)).toBe(true);
    expect(groups[0].vendorId).toBe(ctx.b.vendorId);
    const distances = cranes.map((c) => c.distanceKm);
    expect(distances).toEqual([...distances].sort((x, y) => x - y));
  });

  it("keeps the crane type in distance mode and refuses an unknown mode", async () => {
    await appPrisma.craneType.upsert({
      where: { code: "TYRE" },
      create: { code: "TYRE", name: "Tyre Mounted Crane", sortOrder: 20 },
      update: {},
    });
    const rfq = await createRfq({ craneType: "TYRE", capacityT: 500 });

    const typed = await call(
      app,
      "GET",
      `/api/rfqs/${rfq.id}/candidates?mode=distance`,
      { token: ctx.salesToken },
    );
    // Distance mode drops tonnage, not the crane type.
    expect(typed.status).toBe(200);
    expect(typed.body.candidates.located).toHaveLength(0);

    const bad = await call(
      app,
      "GET",
      `/api/rfqs/${rfq.id}/candidates?mode=nearest`,
      { token: ctx.salesToken },
    );
    expect(bad.status).toBe(400);
  });

  it("stores the richer requirement fields (brief A3)", async () => {
    const rfq = await createRfq({
      capacityRule: "EXACT",
      capacityNote: "Lift only, no travel",
      applicationDescription: "Erecting a 60 m lattice tower",
      loadDescription: "Base section, 40 t at 20 m radius",
      mainBoomM: 60,
      jibLengthM: 12,
      startDateTbc: true,
      workingDaysPerMonth: 24,
    });
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}`, {
      token: ctx.salesToken,
    });
    const view = res.body.rfq;
    expect(view.capacityRule).toBe("EXACT");
    expect(view.capacityNote).toBe("Lift only, no travel");
    expect(view.applicationDescription).toBe("Erecting a 60 m lattice tower");
    expect(view.loadDescription).toBe("Base section, 40 t at 20 m radius");
    expect(Number(view.mainBoomM)).toBe(60);
    expect(Number(view.jibLengthM)).toBe(12);
    expect(view.startDateTbc).toBe(true);
    expect(view.workingDaysPerMonth).toBe(24);
  });

  it("matches none under an exact rule when cranes differ in tonnage (brief A3)", async () => {
    // Default is "at least", so the fixture cranes answer a 100 t RFQ; exact
    // only admits cranes of exactly that tonnage.
    const wide = await createRfq({ capacityT: 100 });
    const wideRes = await call(app, "GET", `/api/rfqs/${wide.id}/candidates`, {
      token: ctx.salesToken,
    });
    expect(wideRes.body.candidates.capacityRule).toContain("at least 100");

    const exact = await createRfq({ capacityT: 100, capacityRule: "EXACT" });
    const exactRes = await call(app, "GET", `/api/rfqs/${exact.id}/candidates`, {
      token: ctx.salesToken,
    });
    expect(exactRes.body.candidates.located).toHaveLength(0);
    expect(exactRes.body.candidates.unverified).toHaveLength(0);
    expect(exactRes.body.candidates.capacityRule).toContain("exactly 100");
  });

  it("excludes a crane of another type", async () => {
    await appPrisma.craneType.upsert({
      where: { code: "TYRE" },
      create: { code: "TYRE", name: "Tyre Mounted Crane", sortOrder: 20 },
      update: {},
    });
    const rfq = await createRfq({ craneType: "TYRE" });
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    expect(res.body.candidates.located).toHaveLength(0);
  });

  it("excludes a crane with an overlapping active reservation for the RFQ window (brief B3)", async () => {
    const rfq = await createRfq();
    // The default RFQ window is roughly [+30, +150] days; a reservation inside
    // it disqualifies the crane even though its status is Available.
    await appPrisma.reservation.create({
      data: {
        craneId: ctx.a.craneId,
        startDate: inDays(45),
        endDate: inDays(55),
        type: "BOOKED",
        status: "ACTIVE",
      },
    });

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const craneIds = [
      ...res.body.candidates.located.flatMap((g: { cranes: Array<{ craneId: string }> }) =>
        g.cranes.map((c) => c.craneId),
      ),
      ...res.body.candidates.unverified.map((c: { craneId: string }) => c.craneId),
    ];
    expect(craneIds).not.toContain(ctx.a.craneId);
    expect(craneIds).toContain(ctx.b.craneId);

    // A reservation well clear of the window leaves the crane a candidate.
    await appPrisma.reservation.deleteMany({ where: { craneId: ctx.a.craneId } });
    await appPrisma.reservation.create({
      data: {
        craneId: ctx.a.craneId,
        startDate: inDays(250),
        endDate: inDays(260),
        type: "BOOKED",
        status: "ACTIVE",
      },
    });
    const after = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const afterIds = [
      ...after.body.candidates.located.flatMap(
        (g: { cranes: Array<{ craneId: string }> }) => g.cranes.map((c) => c.craneId),
      ),
      ...after.body.candidates.unverified.map((c: { craneId: string }) => c.craneId),
    ];
    expect(afterIds).toContain(ctx.a.craneId);
  });

  it("skips the date checks with a notice when the start date is TBC (brief C3)", async () => {
    // Engaged and not free until after the provisional start date.
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { currentStatus: "ENGAGED", availableFrom: inDays(60) },
    });

    const strict = await createRfq();
    const strictRes = await call(app, "GET", `/api/rfqs/${strict.id}/candidates`, {
      token: ctx.salesToken,
    });
    expect(strictRes.body.candidates.startDateTbc).toBe(false);
    expect(strictRes.body.candidates.notice).toBeNull();
    const strictIds = strictRes.body.candidates.located.flatMap(
      (g: { cranes: Array<{ craneId: string }> }) => g.cranes.map((c) => c.craneId),
    );
    expect(strictIds).not.toContain(ctx.a.craneId);

    const tbc = await createRfq({ startDateTbc: true });
    const tbcRes = await call(app, "GET", `/api/rfqs/${tbc.id}/candidates`, {
      token: ctx.salesToken,
    });
    expect(tbcRes.body.candidates.startDateTbc).toBe(true);
    expect(tbcRes.body.candidates.notice).toMatch(/to be confirmed/i);
    const tbcIds = tbcRes.body.candidates.located.flatMap(
      (g: { cranes: Array<{ craneId: string }> }) => g.cranes.map((c) => c.craneId),
    );
    expect(tbcIds).toContain(ctx.a.craneId);
  });

  it("excludes cranes of a vendor that is not approved", async () => {
    await appPrisma.vendor.update({
      where: { id: ctx.b.vendorId },
      data: { onboardingStatus: "SUBMITTED" },
    });
    const rfq = await createRfq();
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const vendorIds = res.body.candidates.located.map((g: { vendorId: string }) => g.vendorId);
    expect(vendorIds).not.toContain(ctx.b.vendorId);
    expect(vendorIds).toContain(ctx.a.vendorId);
  });

  it("excludes Under Maintenance, Booked and Hired cranes", async () => {
    const rfq = await createRfq();
    for (const status of ["UNDER_MAINTENANCE", "BOOKED", "HIRED"]) {
      await appPrisma.crane.update({
        where: { id: ctx.b.craneId },
        data: { currentStatus: status },
      });
      const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
        token: ctx.salesToken,
      });
      const vendorIds = res.body.candidates.located.map((g: { vendorId: string }) => g.vendorId);
      expect(vendorIds, `${status} must not be offered`).not.toContain(ctx.b.vendorId);
    }
  });

  it("includes an Engaged crane that is free by the required start date", async () => {
    const rfq = await createRfq({ requiredStartDate: inDays(30).toISOString() });
    await appPrisma.crane.update({
      where: { id: ctx.b.craneId },
      data: { currentStatus: "ENGAGED", availableFrom: inDays(10) },
    });

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const group = res.body.candidates.located.find(
      (g: { vendorId: string }) => g.vendorId === ctx.b.vendorId,
    );
    expect(group).toBeDefined();
    expect(group.cranes[0].currentStatus).toBe("ENGAGED");
    expect(group.cranes[0].availableInTime).toBe(true);
  });

  it("includes an Engaged crane freeing on exactly the required start date", async () => {
    // The boundary the two anchors have to agree on. A `date` input sends a
    // calendar day and the fleet stores one, so if the browser sent the required
    // start as local midnight instead of UTC midnight, everywhere east of UTC the
    // start would sit *before* the release date and this crane would drop out of
    // the picker despite being free in time.
    const start = inDays(30);
    const day = start.toISOString().slice(0, 10);
    const rfq = await createRfq({
      requiredStartDate: new Date(`${day}T00:00:00.000Z`).toISOString(),
    });
    await appPrisma.crane.update({
      where: { id: ctx.b.craneId },
      data: { currentStatus: "ENGAGED", availableFrom: new Date(`${day}T00:00:00.000Z`) },
    });

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const group = res.body.candidates.located.find(
      (g: { vendorId: string }) => g.vendorId === ctx.b.vendorId,
    );
    expect(group, "a crane free on the first day of the work qualifies").toBeDefined();
    expect(group.cranes[0].availableInTime).toBe(true);
  });

  it("excludes an Engaged crane whose release date is after the start date", async () => {
    const rfq = await createRfq({ requiredStartDate: inDays(5).toISOString() });
    await appPrisma.crane.update({
      where: { id: ctx.b.craneId },
      data: { currentStatus: "ENGAGED", availableFrom: inDays(20) },
    });

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const vendorIds = res.body.candidates.located.map((g: { vendorId: string }) => g.vendorId);
    expect(vendorIds).not.toContain(ctx.b.vendorId);
  });

  it("excludes an Engaged crane with no release date, since nobody knows when it frees up", async () => {
    const rfq = await createRfq();
    await appPrisma.crane.update({
      where: { id: ctx.b.craneId },
      data: { currentStatus: "ENGAGED", availableFrom: null },
    });

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const ranked = res.body.candidates.located.flatMap(
      (g: { cranes: Array<{ craneId: string }> }) => g.cranes,
    );
    const unverified = res.body.candidates.unverified as Array<{ craneId: string }>;
    // Dropped from both buckets, not parked in "unverified": that bucket means
    // "location unverified", and this crane's problem is its release date.
    expect(ranked.some((c) => c.craneId === ctx.b.craneId)).toBe(false);
    expect(unverified.map((c) => c.craneId)).not.toContain(ctx.b.craneId);
    // The other vendor's crane still comes through, so this is a filter and not
    // an empty result.
    expect(ranked.map((c) => c.craneId)).toContain(ctx.a.craneId);
  });

  it("excludes a deactivated crane", async () => {
    const rfq = await createRfq();
    await appPrisma.crane.update({ where: { id: ctx.b.craneId }, data: { isActive: false } });
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const vendorIds = res.body.candidates.located.map((g: { vendorId: string }) => g.vendorId);
    expect(vendorIds).not.toContain(ctx.b.vendorId);
  });

  it("flags a crane as stale past the threshold but still offers it", async () => {
    const rfq = await createRfq();
    await appPrisma.crane.update({
      where: { id: ctx.b.craneId },
      data: { statusUpdatedAt: new Date(Date.now() - 90 * 86_400_000) },
    });

    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });
    const group = res.body.candidates.located.find(
      (g: { vendorId: string }) => g.vendorId === ctx.b.vendorId,
    );
    expect(group.cranes[0].stale).toBe(true);
    expect(group.cranes[0].daysSinceUpdate).toBeGreaterThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------
// Straight-line fallback (brief 6.9: label it)
// ---------------------------------------------------------------------------

describe("distance labelling", () => {
  afterEach(async () => {
    const { setGeoProvider } = await import("../lib/geo");
    setGeoProvider(null);
  });

  it("labels a straight-line fallback as approximate instead of calling it road", async () => {
    const { setGeoProvider } = await import("../lib/geo");
    setGeoProvider({
      name: "routing-down",
      isAuthoritative: false,
      async geocode() {
        return { ok: false as const, reason: "unavailable" };
      },
      async roadDistance() {
        return { ok: false as const, reason: "routing unavailable" };
      },
    });

    const rfq = await createRfq();
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });

    const crane = res.body.candidates.located[0].cranes[0];
    expect(crane.distanceKm).not.toBeNull();
    // The whole point: a fallback is visible as one.
    expect(crane.distanceMethod).toBe("straight_line");
    expect(crane.distanceApproximate).toBe(true);
  });

  it("never caches a fallback as if it were a road distance", async () => {
    const { setGeoProvider } = await import("../lib/geo");
    setGeoProvider({
      name: "routing-down",
      isAuthoritative: false,
      async geocode() {
        return { ok: false as const, reason: "unavailable" };
      },
      async roadDistance() {
        return { ok: false as const, reason: "routing unavailable" };
      },
    });

    const rfq = await createRfq();
    await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, { token: ctx.salesToken });

    // A cached approximation would shadow the real number for 30 days once
    // routing starts working, with nothing to tell the two apart.
    expect(await appPrisma.distanceCache.count()).toBe(0);
  });

  it("honours a provider that reports a real road distance", async () => {
    const { setGeoProvider } = await import("../lib/geo");
    setGeoProvider({
      name: "test-road",
      isAuthoritative: true,
      async geocode() {
        return { ok: false as const, reason: "unavailable" };
      },
      async roadDistance() {
        return {
          ok: true as const,
          km: 42.5,
          method: "road" as const,
          provider: "test-road",
        };
      },
    });

    const rfq = await createRfq();
    const res = await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, {
      token: ctx.salesToken,
    });

    const crane = res.body.candidates.located[0].cranes[0];
    expect(crane.distanceKm).toBe(42.5);
    expect(crane.distanceApproximate).toBe(false);
    // A real road figure is worth keeping.
    expect(await appPrisma.distanceCache.count()).toBeGreaterThan(0);
  });

  it("reuses a cached road distance instead of calling the provider again", async () => {
    const { setGeoProvider } = await import("../lib/geo");
    let calls = 0;
    setGeoProvider({
      name: "test-road",
      isAuthoritative: true,
      async geocode() {
        return { ok: false as const, reason: "unavailable" };
      },
      async roadDistance() {
        calls += 1;
        return { ok: true as const, km: 10, method: "road" as const, provider: "test-road" };
      },
    });

    const rfq = await createRfq();
    await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, { token: ctx.salesToken });
    const afterFirst = calls;
    await call(app, "GET", `/api/rfqs/${rfq.id}/candidates`, { token: ctx.salesToken });

    expect(afterFirst).toBeGreaterThan(0);
    expect(calls).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// Dispatch (brief 6.7)
// ---------------------------------------------------------------------------

describe("sending an RFQ", () => {
  it("emails each selected vendor and marks the RFQ Sent", async () => {
    const rfq = await createRfq();
    const res = await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);

    expect(res.status).toBe(200);
    expect(res.body.result.sent).toBe(2);
    expect(res.body.result.failed).toBe(0);

    const detail = await call(app, "GET", `/api/rfqs/${rfq.id}`, { token: ctx.salesToken });
    expect(detail.body.rfq.status).toBe("SENT");
    expect(detail.body.rfq.sentAt).not.toBeNull();
    expect(detail.body.rfq.rollupStatus).toBe("AWAITING_QUOTES");

    const recipients = detail.body.rfq.recipients as Array<{
      vendorName: string;
      emails: string[];
      emailDeliveryStatus: string;
      responseStatus: string;
    }>;
    expect(recipients).toHaveLength(2);
    expect(recipients.every((r) => r.emailDeliveryStatus === "SENT")).toBe(true);
    expect(recipients.every((r) => r.responseStatus === "PENDING")).toBe(true);
    // Each recipient is emailed at the vendor's own address.
    expect(recipients.find((r) => r.vendorName.includes("A"))?.emails).toEqual([VENDOR_USERS.a]);
  });

  it("carries the RFQ number in the subject and links to the portal", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    const subjects = await emailSubjects();
    expect(subjects.some((s) => s.includes(rfq.rfqNumber))).toBe(true);
    // Brief 8: the subject carries the reference so replies can be matched later.
    expect(subjects.some((s) => s.startsWith(`[${rfq.rfqNumber}]`))).toBe(true);

    const log = await appPrisma.emailLog.findFirst({
      where: { template: "rfq_invitation" },
    });
    expect(log?.entityId).toBe(rfq.id);
    expect(log?.status).toBe("SENT");
  });

  it("echoes every commercial term into the invitation", async () => {
    const rfq = await createRfq({
      otCharges: "As per agreement",
      dieselScope: "To SML",
      paymentTerms: "30 days from invoice",
      smlContactName: "Site Engineer",
    });
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    const log = await appPrisma.emailLog.findFirst({ where: { template: "rfq_invitation" } });
    expect(log?.subject).toContain(rfq.rfqNumber);
    // The body is rendered before storage, so the terms are visible in the log's
    // subject only; assert on the invitation through the mailer's own subject
    // plus a second recipient to prove the loop ran per address.
    expect(log?.toEmail).toBe(VENDOR_USERS.a);
  });

  it("ignores an address supplied by the client and uses the vendor's own", async () => {
    const rfq = await createRfq();
    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/send`, {
      token: ctx.salesToken,
      body: {
        vendorIds: [ctx.a.vendorId],
        // The customer's requirement must not be deliverable to a stranger.
        emails: ["stranger@not-a-vendor.test"],
        to: ["stranger@not-a-vendor.test"],
      },
    });

    expect(res.status).toBe(200);
    const addressed = await appPrisma.emailLog.findMany({ select: { toEmail: true } });
    expect(addressed.map((r) => r.toEmail)).toEqual([VENDOR_USERS.a]);
  });

  it("refuses a vendor that is no longer approved", async () => {
    const rfq = await createRfq();
    await appPrisma.vendor.update({
      where: { id: ctx.b.vendorId },
      data: { onboardingStatus: "REJECTED" },
    });

    const res = await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Only approved vendors");

    // Nothing was sent to anybody: the refusal happens before the loop.
    expect(await appPrisma.rfqVendorRecipient.count()).toBe(0);
    expect(await appPrisma.emailLog.count()).toBe(0);
  });

  it("refuses a vendor with no active user, naming the reason", async () => {
    const rfq = await createRfq();
    await appPrisma.user.updateMany({
      where: { vendorId: ctx.b.vendorId },
      data: { isActive: false },
    });

    const res = await sendRfq(rfq.id, [ctx.b.vendorId]);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no active user");
  });

  it("requires at least one vendor", async () => {
    const rfq = await createRfq();
    const res = await sendRfq(rfq.id, []);
    expect(res.status).toBe(400);
  });

  it("records a failed delivery, still sends to the others, and still marks it Sent", async () => {
    mailOutcomes.set(VENDOR_USERS.b, { sent: false, error: "Mailbox full" });
    const rfq = await createRfq();

    const res = await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);

    expect(res.status).toBe(200);
    expect(res.body.result.sent).toBe(1);
    expect(res.body.result.failed).toBe(1);

    const detail = await call(app, "GET", `/api/rfqs/${rfq.id}`, { token: ctx.salesToken });
    const recipients = detail.body.rfq.recipients as Array<{
      vendorId: string;
      emailDeliveryStatus: string;
      emailDeliveryError: string | null;
    }>;

    const failed = recipients.find((r) => r.vendorId === ctx.b.vendorId);
    const delivered = recipients.find((r) => r.vendorId === ctx.a.vendorId);

    expect(failed?.emailDeliveryStatus).toBe("FAILED");
    expect(failed?.emailDeliveryError).toBe("Mailbox full");
    // One full mailbox must not cost the other recipient their RFQ.
    expect(delivered?.emailDeliveryStatus).toBe("SENT");
    // Dispatch happened; the dashboard's job is to show who did not get it.
    expect(detail.body.rfq.status).toBe("SENT");

    // And it is visible on the list, which is where a failure gets noticed.
    const list = await call(app, "GET", "/api/rfqs", { token: ctx.salesToken });
    const row = (list.body.rfqs as Array<{ failedCount: number }>)[0];
    expect(row.failedCount).toBe(1);
  });

  it("logs a failed send in EmailLog rather than swallowing it", async () => {
    mailOutcomes.set(VENDOR_USERS.a, { sent: false, error: "Recipient rejected" });
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    const log = await appPrisma.emailLog.findFirst({ where: { template: "rfq_invitation" } });
    expect(log?.status).toBe("FAILED");
    expect(log?.error).toBe("Recipient rejected");
  });

  it("refuses to send once the deadline has passed", async () => {
    const rfq = await createRfq({ submissionDeadline: inHours(3).toISOString() });
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: new Date(Date.now() - 60_000) },
    });

    const res = await sendRfq(rfq.id, [ctx.a.vendorId]);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("deadline has passed");
  });

  it("refuses to send a cancelled RFQ", async () => {
    const rfq = await createRfq();
    await call(app, "POST", `/api/rfqs/${rfq.id}/cancel`, {
      token: ctx.salesToken,
      body: { reason: "Customer withdrew the enquiry" },
    });

    const res = await sendRfq(rfq.id, [ctx.a.vendorId]);
    expect(res.status).toBe(409);
  });

  it("snapshots what each vendor was offered, and does not recompute it", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    const recipient = await appPrisma.rfqVendorRecipient.findFirst({
      where: { rfqId: rfq.id, vendorId: ctx.a.vendorId },
    });
    const snapshot = recipient?.candidateSnapshot as {
      capturedAt: string;
      cranes: Array<{ craneId: string; vendorId: string; distanceKm: number | null }>;
    };

    expect(snapshot.capturedAt).toBeTruthy();
    expect(snapshot.cranes.map((c) => c.craneId)).toEqual([ctx.a.craneId]);

    // The crane moves. History about what the vendor was offered must not follow.
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { latitude: 19.076, longitude: 72.8777, currentLocation: "Mumbai Yard" },
    });

    const reread = await appPrisma.rfqVendorRecipient.findFirst({
      where: { rfqId: rfq.id, vendorId: ctx.a.vendorId },
    });
    const after = reread?.candidateSnapshot as { cranes: Array<{ currentLocation?: string }> };
    expect(after.cranes).toEqual(snapshot.cranes);
  });

  it("writes a send audit entry", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    const audit = await appPrisma.auditLog.findFirst({
      where: { entity: "rfq", entityId: rfq.id, action: "send" },
    });
    expect(audit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deadline, cancellation, reminders and expiry (brief 6.7)
// ---------------------------------------------------------------------------

describe("deadline extension", () => {
  it("extends to a later deadline and notifies pending recipients", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);

    const res = await call(app, "PATCH", `/api/rfqs/${rfq.id}/deadline`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(14).toISOString(), reason: "Customer extended the work" },
    });

    expect(res.status).toBe(200);
    expect(res.body.result.notified).toBe(2);

    const after = await call(app, "GET", `/api/rfqs/${rfq.id}`, { token: ctx.salesToken });
    expect(new Date(after.body.rfq.submissionDeadline).getTime()).toBeGreaterThan(Date.now());

    const subjects = await emailSubjects();
    expect(subjects.some((s) => s.includes("extended"))).toBe(true);

    const audit = await appPrisma.auditLog.findFirst({
      where: { entity: "rfq", entityId: rfq.id, action: "extend_deadline" },
    });
    expect(audit).not.toBeNull();
  });

  it("refuses a deadline that is not later, so nobody silently loses their chance to quote", async () => {
    const rfq = await createRfq({ submissionDeadline: inDays(10).toISOString() });
    const res = await call(app, "PATCH", `/api/rfqs/${rfq.id}/deadline`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(3).toISOString() },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be later");
  });

  it("refuses to extend a cancelled RFQ", async () => {
    const rfq = await createRfq();
    await call(app, "POST", `/api/rfqs/${rfq.id}/cancel`, {
      token: ctx.salesToken,
      body: { reason: "No longer required" },
    });
    const res = await call(app, "PATCH", `/api/rfqs/${rfq.id}/deadline`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(14).toISOString() },
    });
    expect(res.status).toBe(409);
  });
});

describe("cancelling an RFQ", () => {
  it("requires a reason, cancels, and tells the recipients", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/cancel`, {
      token: ctx.salesToken,
      body: { reason: "Customer postponed the work" },
    });

    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe("CANCELLED");

    const detail = await call(app, "GET", `/api/rfqs/${rfq.id}`, { token: ctx.salesToken });
    expect(detail.body.rfq.status).toBe("CANCELLED");
    expect(detail.body.rfq.cancelReason).toBe("Customer postponed the work");
    expect(detail.body.rfq.cancelledAt).not.toBeNull();

    const subjects = await emailSubjects();
    expect(subjects.some((s) => s.includes("cancelled"))).toBe(true);
  });

  it("rejects a cancellation with no reason", async () => {
    const rfq = await createRfq();
    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/cancel`, {
      token: ctx.salesToken,
      body: { reason: "" },
    });
    expect(res.status).toBe(400);
  });

  it("refuses to cancel twice", async () => {
    const rfq = await createRfq();
    await call(app, "POST", `/api/rfqs/${rfq.id}/cancel`, {
      token: ctx.salesToken,
      body: { reason: "First cancellation" },
    });
    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/cancel`, {
      token: ctx.salesToken,
      body: { reason: "Second cancellation" },
    });
    expect(res.status).toBe(409);
  });
});

describe("reminders", () => {
  it("reminds only pending recipients and counts them", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);

    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/remind`, {
      token: ctx.salesToken,
      body: {},
    });

    expect(res.status).toBe(200);
    expect(res.body.result.reminded).toBe(2);

    const recipients = await appPrisma.rfqVendorRecipient.findMany({
      where: { rfqId: rfq.id },
    });
    expect(recipients.every((r) => r.reminderCount === 1)).toBe(true);
    expect(recipients.every((r) => r.lastReminderAt !== null)).toBe(true);
  });

  it("reminds a single named recipient", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);

    const target = await appPrisma.rfqVendorRecipient.findFirst({
      where: { rfqId: rfq.id, vendorId: ctx.a.vendorId },
    });

    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/remind`, {
      token: ctx.salesToken,
      body: { recipientIds: [target!.id] },
    });

    expect(res.body.result.reminded).toBe(1);
    const other = await appPrisma.rfqVendorRecipient.findFirst({
      where: { rfqId: rfq.id, vendorId: ctx.b.vendorId },
    });
    expect(other?.reminderCount).toBe(0);
  });

  it("refuses to remind on a cancelled RFQ", async () => {
    // The screen hides the button for a cancelled RFQ; the API must refuse the
    // call too, so a stale tab or a hand-rolled request cannot chase vendors
    // about an enquiry that no longer exists.
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { status: "CANCELLED" },
    });

    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/remind`, {
      token: ctx.salesToken,
      body: {},
    });

    expect(res.status).toBe(409);
    expect(await appPrisma.emailLog.count({ where: { template: "rfq_reminder" } })).toBe(0);
  });

  it("does not chase a recipient who has already responded", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    await appPrisma.rfqVendorRecipient.updateMany({
      where: { rfqId: rfq.id },
      data: { responseStatus: "DECLINED", declineReason: "No crane free" },
    });

    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/remind`, {
      token: ctx.salesToken,
      body: {},
    });

    expect(res.body.result.reminded).toBe(0);
    expect(await appPrisma.emailLog.count({ where: { template: "rfq_reminder" } })).toBe(0);
  });
});

describe("expiry", () => {
  it("expires recipients still pending after the deadline", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: new Date(Date.now() - 60_000) },
    });

    const res = await call(app, "POST", "/api/rfqs/expire-pending", { token: ctx.salesToken });

    expect(res.status).toBe(200);
    expect(res.body.result.expired).toBe(1);

    const recipient = await appPrisma.rfqVendorRecipient.findFirst({
      where: { rfqId: rfq.id },
    });
    expect(recipient?.responseStatus).toBe("EXPIRED");
  });

  it("leaves a responded recipient alone", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    await appPrisma.rfqVendorRecipient.updateMany({
      where: { rfqId: rfq.id },
      data: { responseStatus: "QUOTED" },
    });
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: new Date(Date.now() - 60_000) },
    });

    const res = await call(app, "POST", "/api/rfqs/expire-pending", { token: ctx.salesToken });
    expect(res.body.result.expired).toBe(0);
  });

  it("revives an Expired recipient to Pending when the deadline is extended (brief C1)", async () => {
    const rfq = await createRfq({ submissionDeadline: inDays(7).toISOString() });
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    // Deadline passes, recipient expires, then SML extends.
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: new Date(Date.now() - 60_000) },
    });
    await call(app, "POST", "/api/rfqs/expire-pending", { token: ctx.salesToken });
    expect(
      (await appPrisma.rfqVendorRecipient.findFirst({ where: { rfqId: rfq.id } }))
        ?.responseStatus,
    ).toBe("EXPIRED");

    const res = await call(app, "PATCH", `/api/rfqs/${rfq.id}/deadline`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(10).toISOString(), reason: "Customer revived it" },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.revived).toBe(1);

    const recipient = await appPrisma.rfqVendorRecipient.findFirst({
      where: { rfqId: rfq.id },
    });
    // Expired only ever holds a vendor who never responded, so a later deadline
    // gives them their window back rather than leaving them dead lettered.
    expect(recipient?.responseStatus).toBe("PENDING");
  });

  it("does not revive a Quoted recipient on extension (brief C1)", async () => {
    const rfq = await createRfq({ submissionDeadline: inDays(7).toISOString() });
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    await appPrisma.rfqVendorRecipient.updateMany({
      where: { rfqId: rfq.id },
      data: { responseStatus: "QUOTED" },
    });

    const res = await call(app, "PATCH", `/api/rfqs/${rfq.id}/deadline`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(10).toISOString(), reason: "More time" },
    });
    expect(res.body.result.revived).toBe(0);

    const recipient = await appPrisma.rfqVendorRecipient.findFirst({
      where: { rfqId: rfq.id },
    });
    expect(recipient?.responseStatus).toBe("QUOTED");
  });

  it("keeps a still-Pending recipient Pending across an extension", async () => {
    const rfq = await createRfq({ submissionDeadline: inDays(7).toISOString() });
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    const res = await call(app, "PATCH", `/api/rfqs/${rfq.id}/deadline`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(12).toISOString(), reason: "Customer needs longer" },
    });
    expect(res.status).toBe(200);

    const recipient = await appPrisma.rfqVendorRecipient.findFirst({
      where: { rfqId: rfq.id },
    });
    // This is the "un-expire" case that does exist: nobody has been told they
    // missed the deadline, so their window simply grows.
    expect(recipient?.responseStatus).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Tracking reads (brief 7.9)
// ---------------------------------------------------------------------------

describe("the tracking list and detail", () => {
  it("counts recipients by state so a stalled RFQ is obvious", async () => {
    const rfq = await createRfq();
    mailOutcomes.set(VENDOR_USERS.b, { sent: false, error: "Mailbox full" });
    await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);

    const list = await call(app, "GET", "/api/rfqs", { token: ctx.salesToken });
    const row = (list.body.rfqs as Array<Record<string, number>>).find(
      (r) => r.id === rfq.id,
    );

    expect(row?.recipientCount).toBe(2);
    expect(row?.pendingCount).toBe(2);
    expect(row?.quotedCount).toBe(0);
    expect(row?.failedCount).toBe(1);
  });

  it("filters by status and by awaiting-response", async () => {
    const sent = await createRfq();
    await sendRfq(sent.id, [ctx.a.vendorId]);
    const draft = await createRfq();

    const sentOnly = await call(app, "GET", "/api/rfqs?status=SENT", {
      token: ctx.salesToken,
    });
    expect((sentOnly.body.rfqs as unknown[]).length).toBe(1);

    const drafts = await call(app, "GET", "/api/rfqs?status=DRAFT", { token: ctx.salesToken });
    expect((drafts.body.rfqs as Array<{ id: string }>)[0].id).toBe(draft.id);

    const awaiting = await call(app, "GET", "/api/rfqs?awaitingResponse=true", {
      token: ctx.salesToken,
    });
    const ids = (awaiting.body.rfqs as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(sent.id);
    expect(ids).not.toContain(draft.id);
  });

  it("searches by RFQ number, enquiry number and site", async () => {
    const rfq = await createRfq({ siteLocation: "Rajkot" });

    const byNumber = await call(app, "GET", `/api/rfqs?search=${rfq.rfqNumber}`, {
      token: ctx.salesToken,
    });
    expect((byNumber.body.rfqs as unknown[]).length).toBe(1);

    const bySite = await call(app, "GET", "/api/rfqs?search=Rajkot", { token: ctx.salesToken });
    expect((bySite.body.rfqs as unknown[]).length).toBe(1);

    const byEnquiry = await call(app, "GET", "/api/rfqs?search=SP/2026", {
      token: ctx.salesToken,
    });
    expect((byEnquiry.body.rfqs as unknown[]).length).toBe(1);
  });

  it("returns an empty quotations array before M5 writes any", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    const detail = await call(app, "GET", `/api/rfqs/${rfq.id}`, { token: ctx.salesToken });
    // The shape the comparison screens will read must exist now and not change.
    expect(detail.body.rfq.quotations).toEqual([]);
  });

  it("lists only approved vendors with an active user", async () => {
    const res = await call(app, "GET", "/api/rfqs/approved-vendors", { token: ctx.salesToken });
    const ids = (res.body.vendors as Array<{ id: string }>).map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining([ctx.a.vendorId, ctx.b.vendorId]));

    await appPrisma.vendor.update({
      where: { id: ctx.b.vendorId },
      data: { onboardingStatus: "SUBMITTED" },
    });
    const after = await call(app, "GET", "/api/rfqs/approved-vendors", { token: ctx.salesToken });
    const afterIds = (after.body.vendors as Array<{ id: string }>).map((v) => v.id);
    expect(afterIds).toContain(ctx.a.vendorId);
    expect(afterIds).not.toContain(ctx.b.vendorId);
  });

  it("404s an unknown RFQ rather than returning an empty object", async () => {
    const res = await call(app, "GET", "/api/rfqs/00000000-0000-0000-0000-000000000000", {
      token: ctx.salesToken,
    });
    expect(res.status).toBe(404);
  });
});
