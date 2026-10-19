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
 * P3: quote comparison (BPD 6.15) and final selection (BPD 6.16).
 *
 * The comparison screen is SML's own view of a line's quotations: the vendor, the
 * crane, the money, the distance and how each offer was marked. These tests pin
 * the rules the screen leans on:
 *
 * - only the latest, non-withdrawn version of each quotation is comparable;
 * - quotations come back ranked by total estimated cost, with the internal
 *   rental budget beside them and never in front of a vendor;
 * - marking is a working note (Under Review / Shortlisted / Rejected) with a
 *   reason code, it moves the line to Under Evaluation, and it cannot set the
 *   award outcomes;
 * - the award is the one path that finalises, records the award reason code, and
 *   turns every remaining live offer — including an internally rejected one —
 *   into Not Awarded;
 * - vendors reach none of it.
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

/** An enquiry line with a crane requirement; returns the enquiry and its line. */
async function createLine(overrides: Record<string, unknown> = {}) {
  const res = await call(app, "POST", "/api/enquiries", {
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
          rentalBudget: "Budget 9,00,000 per month",
          rentalBudgetValue: 900_000,
          ...overrides,
        },
      ],
    },
  });
  expect(res.status, `enquiry failed: ${JSON.stringify(res.body)}`).toBe(201);
  return {
    enquiry: res.body.enquiry as { id: string; lines: Array<{ id: string }> },
    lineId: res.body.enquiry.lines[0].id as string,
  };
}

async function raiseRfq(lineId: string): Promise<string> {
  const res = await call(app, "POST", `/api/enquiries/lines/${lineId}/rfq`, {
    token: ctx.salesToken,
    body: { submissionDeadline: inDays(7).toISOString() },
  });
  expect(res.status, `rfq failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.rfq.id as string;
}

async function sendRfq(rfqId: string) {
  const res = await call(app, "POST", `/api/rfqs/${rfqId}/send`, {
    token: ctx.salesToken,
    body: { vendorIds: [ctx.a.vendorId, ctx.b.vendorId] },
  });
  expect(res.status, `send failed: ${JSON.stringify(res.body)}`).toBe(200);
}

async function giveLoadCharts() {
  for (const vendor of [ctx.a, ctx.b]) {
    await appPrisma.crane.update({
      where: { id: vendor.craneId },
      data: {
        loadChartFileRef: `vendors/test/cranes/${vendor.craneId}/chart.pdf`,
        loadChartFileName: "chart.pdf",
        loadChartMimeType: "application/pdf",
        loadChartSizeBytes: 1024,
      },
    });
  }
}

async function submitQuote(
  rfqId: string,
  vendor: SeededVendor,
  rate: number,
  token: string,
) {
  const res = await call(app, "POST", `/api/vendor/rfqs/${rfqId}/quotations`, {
    token,
    body: {
      craneId: vendor.craneId,
      rentalRate: rate,
      rateBasis: "PER_MONTH",
      mobilisationCharges: 10_000,
      availabilityConfirmed: true,
      validityDate: inDays(14).toISOString(),
      acceptsCommercialTerms: true,
    },
  });
  expect(res.status, `quote failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.quotation.quotationId as string;
}

/** A line with an RFQ that both vendors have quoted. */
async function quotedLine() {
  const { lineId } = await createLine();
  const rfqId = await raiseRfq(lineId);
  await sendRfq(rfqId);
  await giveLoadCharts();
  const quoteA = await submitQuote(rfqId, ctx.a, 50_000, ctx.vendorTokenA);
  const quoteB = await submitQuote(rfqId, ctx.b, 65_000, ctx.vendorTokenB);
  return { lineId, rfqId, quoteA, quoteB };
}

function comparison(lineId: string, token: string) {
  return call(app, "GET", `/api/enquiries/lines/${lineId}/comparison`, { token });
}

function mark(
  rfqId: string,
  quotationId: string,
  token: string,
  body: Record<string, unknown>,
) {
  return call(
    app,
    "POST",
    `/api/rfqs/${rfqId}/quotations/${quotationId}/mark`,
    { token, body },
  );
}

function award(
  rfqId: string,
  quotationId: string,
  token: string,
  body: Record<string, unknown> = {},
) {
  return call(
    app,
    "POST",
    `/api/rfqs/${rfqId}/quotations/${quotationId}/award`,
    { token, body },
  );
}

async function setMasterList(name: string, values: string[]) {
  const res = await call(app, "PUT", `/api/settings/master-lists/${name}`, {
    token: ctx.adminToken,
    body: { values },
  });
  expect(res.status, `master list failed: ${JSON.stringify(res.body)}`).toBe(200);
}

describe("quote comparison (P3, BPD 6.15)", () => {
  it("lists each vendor's offer ranked by total estimated cost, with the internal budget", async () => {
    const { lineId, quoteA, quoteB } = await quotedLine();

    const res = await comparison(lineId, ctx.salesToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body.comparison;

    expect(body.rankRule).toBe("TOTAL_ESTIMATED_COST");
    expect(body.rentalBudget).toBe("Budget 9,00,000 per month");
    expect(body.rentalBudgetValue).toBe(900_000);
    expect(body.quantity).toBe(1);
    expect(body.fullyAwarded).toBe(false);
    expect(body.quotations).toHaveLength(2);

    // The cheaper total comes first (open item 5: ascending by total cost).
    expect(body.quotations[0].quotationId).toBe(quoteA);
    expect(body.quotations[0].totalEstimatedCost).toBeLessThan(
      body.quotations[1].totalEstimatedCost,
    );
    expect(body.quotations[0].vendorName).toBe(ctx.a.vendorName ?? body.quotations[0].vendorName);
    expect(body.quotations[1].quotationId).toBe(quoteB);
    // Both offers are live, so neither carries a mark yet.
    expect(body.quotations.every((q: { status: string }) => q.status === "SUBMITTED")).toBe(true);
  });

  it("compares only the latest version and drops a withdrawn quotation", async () => {
    const { lineId, rfqId, quoteA, quoteB } = await quotedLine();

    // Revise vendor A's offer; version 1 is superseded.
    const revise = await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quoteA}/revisions`,
      {
        token: ctx.vendorTokenA,
        body: {
          rentalRate: 55_000,
          rateBasis: "PER_MONTH",
          mobilisationCharges: 5_000,
          availabilityConfirmed: true,
          validityDate: inDays(14).toISOString(),
          acceptsCommercialTerms: true,
        },
      },
    );
    expect(revise.status, JSON.stringify(revise.body)).toBe(201);
    const revisedId = revise.body.quotation.quotationId as string;

    // Vendor B withdraws.
    const withdraw = await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quoteB}/withdraw`,
      { token: ctx.vendorTokenB, body: {} },
    );
    expect(withdraw.status, JSON.stringify(withdraw.body)).toBe(200);

    const res = await comparison(lineId, ctx.salesToken);
    expect(res.status).toBe(200);
    const ids = res.body.comparison.quotations.map(
      (q: { quotationId: string }) => q.quotationId,
    );
    expect(ids).toContain(revisedId);
    expect(ids).not.toContain(quoteA);
    expect(ids).not.toContain(quoteB);
  });

  it("is SML-only: a vendor is refused", async () => {
    const { lineId } = await quotedLine();
    expect((await comparison(lineId, ctx.vendorTokenA)).status).toBe(403);
  });
});

describe("marking a quotation (P3, BPD 6.15)", () => {
  it("marks Under Review with a reason code and moves the line to Under Evaluation", async () => {
    const { lineId, rfqId, quoteA } = await quotedLine();
    await setMasterList("QUOTATION_MARK_REASON_CODES", ["Commercial", "Capacity"]);

    const res = await mark(rfqId, quoteA, ctx.salesToken, {
      status: "UNDER_REVIEW",
      reasonCode: "Commercial",
      reasonText: "Waiting on the final rate",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.mark).toMatchObject({
      quotationId: quoteA,
      status: "UNDER_REVIEW",
      reasonCode: "Commercial",
    });

    const line = await appPrisma.enquiryLineItem.findUniqueOrThrow({
      where: { id: lineId },
      select: { trailStatus: true },
    });
    expect(line.trailStatus).toBe("UNDER_EVALUATION");

    const quotation = await appPrisma.quotation.findUniqueOrThrow({
      where: { id: quoteA },
      select: { statusReasonCode: true, statusReasonText: true, statusChangedById: true },
    });
    expect(quotation).toMatchObject({
      statusReasonCode: "Commercial",
      statusReasonText: "Waiting on the final rate",
    });
    expect(quotation.statusChangedById).not.toBeNull();
  });

  it("rejects a reason code that is not on the configured list", async () => {
    const { rfqId, quoteA } = await quotedLine();
    await setMasterList("QUOTATION_MARK_REASON_CODES", ["Commercial", "Capacity"]);

    const res = await mark(rfqId, quoteA, ctx.salesToken, {
      status: "REJECTED",
      reasonCode: "Because",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);

    const quotation = await appPrisma.quotation.findUniqueOrThrow({
      where: { id: quoteA },
      select: { status: true },
    });
    expect(quotation.status).toBe("SUBMITTED");
  });

  it("accepts a free-text reason while the code list is still empty", async () => {
    const { rfqId, quoteA } = await quotedLine();
    const res = await mark(rfqId, quoteA, ctx.salesToken, {
      status: "SHORTLISTED",
      reasonCode: "Cheapest by a margin",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("cannot set the award outcomes", async () => {
    const { rfqId, quoteA } = await quotedLine();
    expect(
      (await mark(rfqId, quoteA, ctx.salesToken, { status: "SELECTED" })).status,
    ).toBe(400);
    expect(
      (await mark(rfqId, quoteA, ctx.salesToken, { status: "NOT_AWARDED" })).status,
    ).toBe(400);
  });

  it("refuses a vendor", async () => {
    const { rfqId, quoteA } = await quotedLine();
    expect(
      (await mark(rfqId, quoteA, ctx.vendorTokenA, { status: "UNDER_REVIEW" })).status,
    ).toBe(403);
  });
});

describe("final selection (P3, BPD 6.16)", () => {
  it("awards a shortlisted quotation, records the code, and Not-Awards the rest including a rejected one", async () => {
    const { lineId, rfqId, quoteA, quoteB } = await quotedLine();
    await setMasterList("QUOTATION_MARK_REASON_CODES", ["Commercial", "Capacity"]);
    await setMasterList("AWARD_REASON_CODES", ["Best commercial fit", "Only capable crane"]);

    // Mark the runner-up rejected, then shortlist the winner.
    const rejected = await mark(rfqId, quoteB, ctx.salesToken, {
      status: "REJECTED",
      reasonCode: "Commercial",
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const shortlisted = await mark(rfqId, quoteA, ctx.salesToken, {
      status: "SHORTLISTED",
      reasonCode: "Capacity",
    });
    expect(shortlisted.status, JSON.stringify(shortlisted.body)).toBe(200);

    const res = await award(rfqId, quoteA, ctx.salesToken, {
      reasonCode: "Best commercial fit",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({
      quotationId: quoteA,
      partial: false,
      rfqClosed: true,
    });

    const winner = await appPrisma.quotation.findUniqueOrThrow({
      where: { id: quoteA },
      select: { status: true, statusReasonCode: true },
    });
    expect(winner).toMatchObject({
      status: "SELECTED",
      statusReasonCode: "Best commercial fit",
    });

    // The rejected runner-up is a live offer to its vendor, so on close it must
    // become Not Awarded rather than linger as an internal mark.
    const runnerUp = await appPrisma.quotation.findUniqueOrThrow({
      where: { id: quoteB },
      select: { status: true },
    });
    expect(runnerUp.status).toBe("NOT_AWARDED");

    const line = await appPrisma.enquiryLineItem.findUniqueOrThrow({
      where: { id: lineId },
      select: { trailStatus: true },
    });
    expect(line.trailStatus).toBe("BOOKED");
  });

  it("refuses an unknown award reason code", async () => {
    const { rfqId, quoteA } = await quotedLine();
    await setMasterList("AWARD_REASON_CODES", ["Best commercial fit"]);

    const res = await award(rfqId, quoteA, ctx.salesToken, {
      reasonCode: "Made up",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });
});
