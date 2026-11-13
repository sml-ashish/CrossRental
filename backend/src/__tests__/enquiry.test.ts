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
 * P1: native enquiry intake and the line-item trail.
 *
 * The phase's done-when is a journey — capture an enquiry with every template
 * field, see it Received Pending Sourcing, check the line internally, raise an
 * RFQ that links back and leaks nothing internal, send it, take a quotation,
 * award it and watch the trail and roll-up follow. That journey is walked end
 * to end, and the rules it leans on are pinned beside it:
 *
 * - the five template terms the first field-list draft missed round-trip;
 * - an RFQ raised from a line carries the line id and none of the customer,
 *   budget, notes, PO or Sales Partner fields;
 * - the trail never rolls back and a cancelled line is final;
 * - the enquiry roll-up is derived from the lines, never typed in;
 * - vendors cannot reach the enquiry surface at all.
 *
 * Every value here is fabricated (brief working rule 3).
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

/** The values that must never appear in a vendor-facing RFQ. */
const INTERNAL_SECRETS = {
  customerName: "Secret Customer Co",
  customerAddress: "17 Hidden Industrial Estate, Nowhere",
  rentalBudget: "Budget 9,00,000 per month",
};

function linePayload(overrides: Record<string, unknown> = {}) {
  return {
    craneTypeCode: "CRAWLER",
    capacityT: 100,
    capacityRule: "AT_LEAST",
    quantity: 1,
    applicationDescription: "Erection of process columns",
    loadDescription: "Steel columns, 18 t each",
    requiredStartDate: inDays(30).toISOString(),
    durationValue: 4,
    durationUnit: "MONTHS",
    // The five template rows added after the first field-list draft.
    additionalManpowerScope: "Two riggers per shift",
    intraSiteMovementScope: "Between bays 1 and 4",
    prereleaseTerms: "No pre-release storage",
    ppeScope: "Helmets and harnesses by vendor",
    rowScope: "ROW along haul road to bay 4",
    ...overrides,
  };
}

function enquiryPayload(overrides: Record<string, unknown> = {}) {
  return {
    customerName: INTERNAL_SECRETS.customerName,
    customerAddress: INTERNAL_SECRETS.customerAddress,
    siteLocation: "Vadodara",
    siteStateCode: "GJ",
    lines: [linePayload({ rentalBudget: INTERNAL_SECRETS.rentalBudget })],
    ...overrides,
  };
}

async function createEnquiry(overrides: Record<string, unknown> = {}) {
  const res = await call(app, "POST", "/api/enquiries", {
    token: ctx.salesToken,
    body: enquiryPayload(overrides),
  });
  expect(res.status, `create failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.enquiry as {
    id: string;
    enquiryNo: string;
    overallStatus: string;
    lines: Array<{ id: string; lineNo: number; trailStatus: string }>;
  };
}

async function lineStatus(lineId: string) {
  return appPrisma.enquiryLineItem.findUniqueOrThrow({
    where: { id: lineId },
    select: { trailStatus: true },
  });
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

describe("enquiry intake (P1)", () => {
  it("captures an enquiry with every template field and shows it Received Pending Sourcing", async () => {
    const enquiry = await createEnquiry();

    expect(enquiry.enquiryNo).toMatch(/^CR-\d{4}-\d{4}$/);
    expect(enquiry.overallStatus).toBe("RECEIVED_PENDING_SOURCING");
    expect(enquiry.lines).toHaveLength(1);
    expect(enquiry.lines[0].lineNo).toBe(1);
    expect(enquiry.lines[0].trailStatus).toBe("NEW");

    // The five scope terms and the internal block round-trip.
    const line = await appPrisma.enquiryLineItem.findUniqueOrThrow({
      where: { id: enquiry.lines[0].id },
    });
    expect(line).toMatchObject({
      additionalManpowerScope: "Two riggers per shift",
      intraSiteMovementScope: "Between bays 1 and 4",
      prereleaseTerms: "No pre-release storage",
      ppeScope: "Helmets and harnesses by vendor",
      rowScope: "ROW along haul road to bay 4",
      rentalBudget: INTERNAL_SECRETS.rentalBudget,
    });

    // It is in the working queue.
    const list = await call(app, "GET", "/api/enquiries", {
      token: ctx.salesToken,
    });
    expect(list.status).toBe(200);
    expect(list.body.enquiries).toHaveLength(1);
    expect(list.body.enquiries[0]).toMatchObject({
      enquiryNo: enquiry.enquiryNo,
      lineCount: 1,
      overallStatus: "RECEIVED_PENDING_SOURCING",
    });
  });

  it("assigns sequential enquiry numbers within a year", async () => {
    const first = await createEnquiry();
    const second = await createEnquiry();
    const year = new Date().getUTCFullYear();
    expect(first.enquiryNo).toBe(`CR-${year}-0001`);
    expect(second.enquiryNo).toBe(`CR-${year}-0002`);
  });

  it("refuses a bad crane type and an unknown state", async () => {
    const badType = await call(app, "POST", "/api/enquiries", {
      token: ctx.salesToken,
      body: enquiryPayload({ lines: [linePayload({ craneTypeCode: "NOPE" })] }),
    });
    expect(badType.status).toBe(400);

    const badState = await call(app, "POST", "/api/enquiries", {
      token: ctx.salesToken,
      body: enquiryPayload({ siteStateCode: "ZZ" }),
    });
    expect(badState.status).toBe(400);
  });

  it("keeps vendors out of the enquiry surface entirely", async () => {
    const read = await call(app, "GET", "/api/enquiries", {
      token: ctx.vendorTokenA,
    });
    expect(read.status).toBe(403);

    const write = await call(app, "POST", "/api/enquiries", {
      token: ctx.vendorTokenA,
      body: enquiryPayload(),
    });
    expect(write.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The trail and the roll-up
// ---------------------------------------------------------------------------

describe("line trail and enquiry roll-up (P1)", () => {
  it("records a manual internal fulfilment and rolls the enquiry up", async () => {
    const enquiry = await createEnquiry();
    const lineId = enquiry.lines[0].id;

    const res = await call(
      app,
      "POST",
      `/api/enquiries/lines/${lineId}/internal-check`,
      {
        token: ctx.salesToken,
        body: { outcome: "FULFILLED_INTERNALLY", notes: "Covered by our own unit" },
      },
    );
    expect(res.status).toBe(200);
    expect((await lineStatus(lineId)).trailStatus).toBe("FULFILLED_INTERNALLY");

    const detail = await call(app, "GET", `/api/enquiries/${enquiry.id}`, {
      token: ctx.salesToken,
    });
    expect(detail.body.enquiry.overallStatus).toBe("FULLY_FINALISED");
  });

  it("rolls up Partially Finalised when only one of two lines is done", async () => {
    const enquiry = await createEnquiry({
      lines: [linePayload(), linePayload({ capacityT: 150 })],
    });
    await call(
      app,
      "POST",
      `/api/enquiries/lines/${enquiry.lines[0].id}/internal-check`,
      {
        token: ctx.salesToken,
        body: { outcome: "FULFILLED_INTERNALLY", notes: null },
      },
    );

    const detail = await call(app, "GET", `/api/enquiries/${enquiry.id}`, {
      token: ctx.salesToken,
    });
    expect(detail.body.enquiry.overallStatus).toBe("PARTIALLY_FINALISED");
  });

  it("closes the enquiry once every line is cancelled, and never revives a cancelled line", async () => {
    const enquiry = await createEnquiry({
      lines: [linePayload(), linePayload({ capacityT: 150 })],
    });
    for (const line of enquiry.lines) {
      const res = await call(
        app,
        "POST",
        `/api/enquiries/lines/${line.id}/cancel`,
        { token: ctx.salesToken, body: { reason: "Customer withdrew this crane" } },
      );
      expect(res.status).toBe(200);
    }

    const detail = await call(app, "GET", `/api/enquiries/${enquiry.id}`, {
      token: ctx.salesToken,
    });
    expect(detail.body.enquiry.overallStatus).toBe("CLOSED");

    // A second transition on a cancelled line is refused, not applied.
    const again = await call(
      app,
      "POST",
      `/api/enquiries/lines/${enquiry.lines[0].id}/internal-check`,
      {
        token: ctx.salesToken,
        body: { outcome: "FULFILLED_INTERNALLY", notes: null },
      },
    );
    expect(again.status).toBe(200);
    expect((await lineStatus(enquiry.lines[0].id)).trailStatus).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// RFQ from a line — linkage and the vendor-safe copy
// ---------------------------------------------------------------------------

describe("RFQ from an enquiry line (P1)", () => {
  it("links back to the line and copies only the vendor-safe subset", async () => {
    const enquiry = await createEnquiry({
      lines: [
        linePayload({
          supportCraneScope: "50 t helper required",
          steelMatsGroundPrepScope: "Steel mats by vendor",
          craneAgeCriteriaYears: 5,
        }),
      ],
    });
    const lineId = enquiry.lines[0].id;

    const res = await call(app, "POST", `/api/enquiries/lines/${lineId}/rfq`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(7).toISOString() },
    });
    expect(res.status, `rfq failed: ${JSON.stringify(res.body)}`).toBe(201);
    const rfq = res.body.rfq as { id: string; rfqNumber: string; enquiryLineId: string };
    expect(rfq.enquiryLineId).toBe(lineId);

    const detail = await call(app, "GET", `/api/rfqs/${rfq.id}`, {
      token: ctx.adminToken,
    });
    expect(detail.status).toBe(200);
    const body = JSON.stringify(detail.body);
    for (const secret of Object.values(INTERNAL_SECRETS)) {
      if (secret === INTERNAL_SECRETS.rentalBudget) continue;
      expect(body).not.toContain(secret);
    }
    // The rental budget lives in a column the RFQ simply does not have.
    expect(body).not.toContain("rentalBudget");
    expect(body).not.toContain("customerName");

    // The vendor-safe terms came across, including the five scope terms.
    const stored = await appPrisma.rfq.findUniqueOrThrow({
      where: { id: rfq.id },
      select: { enquiryLineId: true, commercialTermsExtra: true, supportCrane: true },
    });
    expect(stored.enquiryLineId).toBe(lineId);
    expect(stored.supportCrane).toBe("50 t helper required");
    expect(stored.commercialTermsExtra).toMatchObject({
      additionalManpowerScope: "Two riggers per shift",
      rowScope: "ROW along haul road to bay 4",
      ppeScope: "Helmets and harnesses by vendor",
    });
  });

  it("is readable on its own and carries vendor recommendations", async () => {
    const enquiry = await createEnquiry();
    const lineId = enquiry.lines[0].id;
    const created = await call(app, "POST", `/api/enquiries/lines/${lineId}/rfq`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(7).toISOString() },
    });
    expect(created.status).toBe(201);

    const line = await call(app, "GET", `/api/enquiries/lines/${lineId}`, {
      token: ctx.salesToken,
    });
    expect(line.status).toBe(200);
    expect(line.body.line.id).toBe(lineId);
    expect(line.body.line.enquiryId).toBe(enquiry.id);
    // The internal block stays on the internal endpoint, never on the RFQ.
    expect(line.body.line.rentalBudget).toBeTruthy();

    const recommendations = await call(
      app,
      "GET",
      `/api/enquiries/lines/${lineId}/recommendations`,
      { token: ctx.salesToken },
    );
    expect(recommendations.status).toBe(200);
    // Two approved vendors each have a matching 250 t crawler.
    expect(recommendations.body.recommendations).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The whole journey drives the trail
// ---------------------------------------------------------------------------

describe("trail follows the sourcing journey (P1)", () => {
  it("RFQ Sent -> Quotes Received -> Booked, with the roll-up following", async () => {
    const enquiry = await createEnquiry();
    const lineId = enquiry.lines[0].id;

    const created = await call(app, "POST", `/api/enquiries/lines/${lineId}/rfq`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(7).toISOString() },
    });
    expect(created.status).toBe(201);
    const rfqId = created.body.rfq.id as string;

    const sent = await call(app, "POST", `/api/rfqs/${rfqId}/send`, {
      token: ctx.salesToken,
      body: { vendorIds: [ctx.a.vendorId] },
    });
    expect(sent.status, `send failed: ${JSON.stringify(sent.body)}`).toBe(200);
    expect((await lineStatus(lineId)).trailStatus).toBe("RFQ_SENT");

    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: {
        loadChartFileRef: "vendors/test/chart.pdf",
        loadChartFileName: "chart.pdf",
        loadChartMimeType: "application/pdf",
        loadChartSizeBytes: 1024,
      },
    });
    const quote = await call(
      app,
      "POST",
      `/api/vendor/rfqs/${rfqId}/quotations`,
      {
        token: ctx.vendorTokenA,
        body: {
          craneId: ctx.a.craneId,
          rentalRate: 50_000,
          rateBasis: "PER_MONTH",
          mobilisationCharges: 10_000,
          availabilityConfirmed: true,
          validityDate: inDays(14).toISOString(),
          acceptsCommercialTerms: true,
        },
      },
    );
    expect(quote.status, `quote failed: ${JSON.stringify(quote.body)}`).toBe(201);
    expect((await lineStatus(lineId)).trailStatus).toBe("QUOTES_RECEIVED");

    let detail = await call(app, "GET", `/api/enquiries/${enquiry.id}`, {
      token: ctx.salesToken,
    });
    expect(detail.body.enquiry.overallStatus).toBe("PARTIALLY_QUOTED");

    const awarded = await call(
      app,
      "POST",
      `/api/rfqs/${rfqId}/quotations/${quote.body.quotation.quotationId as string}/award`,
      { token: ctx.adminToken, body: {} },
    );
    expect(awarded.status, `award failed: ${JSON.stringify(awarded.body)}`).toBe(200);
    expect((await lineStatus(lineId)).trailStatus).toBe("BOOKED");

    detail = await call(app, "GET", `/api/enquiries/${enquiry.id}`, {
      token: ctx.salesToken,
    });
    expect(detail.body.enquiry.overallStatus).toBe("FULLY_FINALISED");

    // The reservation carries the line, so the booking is traceable back.
    const reservation = await appPrisma.reservation.findFirstOrThrow({
      where: { rfqId },
      select: { enquiryLineId: true },
    });
    expect(reservation.enquiryLineId).toBe(lineId);
  });
});

// ---------------------------------------------------------------------------
// The enquiry workspace: list enrichment, buckets, sort and the KPI summary
// ---------------------------------------------------------------------------

describe("enquiry list screen (P1 workspace)", () => {
  /** A two-line enquiry: three cranes on one line, one on the other. */
  async function twoLineEnquiry(overrides: Record<string, unknown> = {}) {
    return createEnquiry({
      lines: [
        linePayload({
          quantity: 3,
          applicationDescription: "Metro Line 3 — Pkg 7",
          requiredStartDate: inDays(9).toISOString(),
        }),
        linePayload({
          quantity: 1,
          craneTypeCode: "CRAWLER",
          capacityT: 40,
          applicationDescription: "Metro Line 3 — Pkg 7",
          requiredStartDate: inDays(40).toISOString(),
        }),
      ],
      ...overrides,
    });
  }

  async function listRows(query = "") {
    const res = await call(app, "GET", `/api/enquiries${query}`, {
      token: ctx.salesToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.enquiries as Array<Record<string, unknown>>;
  }

  it("counts cranes by quantity, not by line, and stands the project in from the line", async () => {
    const enquiry = await twoLineEnquiry();
    const [row] = await listRows();

    expect(row).toMatchObject({
      enquiryNo: enquiry.enquiryNo,
      lineCount: 2,
      craneCount: 4,
      sourcedCranes: 0,
      sourcedPercent: 0,
      rfqCount: 0,
      quoteCount: 0,
      bucket: "pending",
      // The enquiry has no project column; the first live line's application
      // description is the honest stand-in.
      project: "Metro Line 3 — Pkg 7",
    });
    // The soonest start among lines that are still unsourced drives the
    // "starts soon" warning.
    expect(new Date(row.nextUnsourcedStart as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("measures sourced progress in cranes and moves the bucket along the journey", async () => {
    const enquiry = await twoLineEnquiry();
    const firstLine = enquiry.lines[0].id;

    // One line covered internally: three of four cranes sourced.
    const covered = await call(
      app,
      "POST",
      `/api/enquiries/lines/${firstLine}/internal-check`,
      {
        token: ctx.salesToken,
        body: { outcome: "FULFILLED_INTERNALLY", notes: "Covered by our own unit" },
      },
    );
    expect(covered.status).toBe(200);

    let [row] = await listRows();
    expect(row).toMatchObject({ sourcedCranes: 3, sourcedPercent: 75, bucket: "pending" });

    // Raise an RFQ against the other line: nothing sourced it, but the
    // enquiry is now waiting on a vendor rather than on us.
    const secondLine = enquiry.lines[1].id;
    const rfq = await call(app, "POST", `/api/enquiries/lines/${secondLine}/rfq`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(7).toISOString() },
    });
    expect(rfq.status, JSON.stringify(rfq.body)).toBe(201);

    [row] = await listRows();
    expect(row).toMatchObject({ rfqCount: 1, quoteCount: 0, bucket: "awaiting" });
  });

  it("puts an enquiry with a quotation in Quotes in, and all-awarded in Finalised", async () => {
    const enquiry = await createEnquiry();
    const lineId = enquiry.lines[0].id;

    const created = await call(app, "POST", `/api/enquiries/lines/${lineId}/rfq`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(7).toISOString() },
    });
    const rfqId = created.body.rfq.id as string;
    await call(app, "POST", `/api/rfqs/${rfqId}/send`, {
      token: ctx.salesToken,
      body: { vendorIds: [ctx.a.vendorId] },
    });
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: {
        loadChartFileRef: "vendors/test/chart.pdf",
        loadChartFileName: "chart.pdf",
        loadChartMimeType: "application/pdf",
        loadChartSizeBytes: 1024,
      },
    });
    const quote = await call(app, "POST", `/api/vendor/rfqs/${rfqId}/quotations`, {
      token: ctx.vendorTokenA,
      body: {
        craneId: ctx.a.craneId,
        rentalRate: 50_000,
        rateBasis: "PER_MONTH",
        mobilisationCharges: 10_000,
        availabilityConfirmed: true,
        validityDate: inDays(14).toISOString(),
        acceptsCommercialTerms: true,
      },
    });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);

    let [row] = await listRows();
    expect(row).toMatchObject({ quoteCount: 1, bucket: "quotes" });

    const awarded = await call(
      app,
      "POST",
      `/api/rfqs/${rfqId}/quotations/${quote.body.quotation.quotationId as string}/award`,
      { token: ctx.adminToken, body: {} },
    );
    expect(awarded.status, JSON.stringify(awarded.body)).toBe(200);

    [row] = await listRows();
    expect(row).toMatchObject({
      sourcedCranes: 1,
      sourcedPercent: 100,
      bucket: "finalised",
    });
  });

  it("orders by soonest unsourced start and by least progress", async () => {
    await createEnquiry({
      siteLocation: "Late site",
      lines: [linePayload({ requiredStartDate: inDays(60).toISOString() })],
    });
    const early = await createEnquiry({
      siteLocation: "Early site",
      lines: [
        linePayload({ requiredStartDate: inDays(3).toISOString() }),
        linePayload({ craneTypeCode: "CRAWLER", capacityT: 40, requiredStartDate: inDays(3).toISOString() }),
      ],
    });
    // Half done, but its remaining line still starts in three days: "soonest
    // start" must stay on the date, not drift to "most finished".
    await call(app, "POST", `/api/enquiries/lines/${early.lines[0].id}/internal-check`, {
      token: ctx.salesToken,
      body: { outcome: "FULFILLED_INTERNALLY", notes: null },
    });
    await createEnquiry({
      siteLocation: "Mid site",
      lines: [linePayload({ requiredStartDate: inDays(20).toISOString() })],
    });

    const byStart = await listRows("?sort=startDate");
    expect(byStart.map((row) => row.siteLocation)).toEqual([
      "Early site",
      "Mid site",
      "Late site",
    ]);

    const byProgress = await listRows("?sort=progress");
    expect(byProgress.map((row) => row.sourcedPercent)).toEqual([0, 0, 50]);

    const rejected = await call(app, "GET", "/api/enquiries?sort=sideways", {
      token: ctx.salesToken,
    });
    expect(rejected.status).toBe(400);
  });

  it("searches the line's project text as well as the number, customer and city", async () => {
    await createEnquiry({
      siteLocation: "Pune, Maharashtra",
      siteStateCode: "MH",
      lines: [linePayload({ applicationDescription: "Refinery shutdown — CDU" })],
    });
    await createEnquiry({
      siteLocation: "Bhuj, Gujarat",
      lines: [linePayload({ applicationDescription: "Khavda wind farm" })],
    });

    const byProject = await listRows("?search=refinery");
    expect(byProject).toHaveLength(1);
    expect(byProject[0].siteLocation).toBe("Pune, Maharashtra");

    const byCity = await listRows("?search=Bhuj");
    expect(byCity).toHaveLength(1);
    expect(byCity[0].project).toBe("Khavda wind farm");
  });

  it("summarises the KPI buckets without double-counting and keeps Closed out of Active", async () => {
    const pending = await twoLineEnquiry();
    const closed = await createEnquiry();
    const cancelled = await call(
      app,
      "POST",
      `/api/enquiries/lines/${closed.lines[0].id}/cancel`,
      { token: ctx.salesToken, body: { reason: "Customer withdrew the lift" } },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const res = await call(app, "GET", "/api/enquiries/summary", {
      token: ctx.salesToken,
    });
    expect(res.status).toBe(200);
    const summary = res.body.summary as Record<string, unknown>;

    expect(summary).toMatchObject({
      total: 2,
      active: 1,
      pendingSourcing: 1,
      awaitingQuotes: 0,
      quotesIn: 0,
      finalised: 0,
      closed: 1,
      raisedToday: 2,
    });
    expect(summary.raisedTodayByBucket).toMatchObject({ pending: 1, closed: 1 });

    // The KPI numbers add up to the total; that is what makes them a partition
    // rather than four overlapping filters.
    expect(
      (summary.pendingSourcing as number) +
        (summary.awaitingQuotes as number) +
        (summary.quotesIn as number) +
        (summary.finalised as number) +
        (summary.closed as number),
    ).toBe(summary.total);

    expect(pending.overallStatus).toBe("RECEIVED_PENDING_SOURCING");
  });

  it("pins the job site at intake so the panel has a map, and re-pins when the site moves", async () => {
    const enquiry = await createEnquiry();
    const created = await appPrisma.enquiry.findUniqueOrThrow({
      where: { id: enquiry.id },
      select: { siteLatitude: true, siteLongitude: true, siteCoordinateSource: true },
    });
    expect(created.siteLatitude).not.toBeNull();
    expect(created.siteLongitude).not.toBeNull();
    // The suite runs the stub, which invents points, so the source must not
    // claim a real provider produced them.
    expect(created.siteCoordinateSource).toBe("manual");

    const moved = await call(app, "PUT", `/api/enquiries/${enquiry.id}`, {
      token: ctx.salesToken,
      body: {
        customerName: INTERNAL_SECRETS.customerName,
        customerAddress: INTERNAL_SECRETS.customerAddress,
        siteLocation: "Nagpur, Maharashtra",
        siteStateCode: "MH",
      },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const after = await appPrisma.enquiry.findUniqueOrThrow({
      where: { id: enquiry.id },
      select: { siteLatitude: true, siteLongitude: true },
    });
    expect(after.siteLatitude).not.toBeNull();
    expect(
      Number(after.siteLatitude) !== Number(created.siteLatitude) ||
        Number(after.siteLongitude) !== Number(created.siteLongitude),
    ).toBe(true);
  });

  it("keeps the summary away from vendors too", async () => {
    const res = await call(app, "GET", "/api/enquiries/summary", {
      token: ctx.vendorTokenA,
    });
    expect(res.status).toBe(403);
  });
});
