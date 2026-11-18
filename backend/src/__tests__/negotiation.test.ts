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
  useTestDatabase,
  type SeededVendor,
} from "./harness";
import { INTERNAL_USERS, VENDOR_PASSWORD, VENDOR_USERS } from "./fixtures";

/**
 * Counter-quote / negotiation (phase 1 + 2).
 *
 * Driven through the real Express app and Postgres, like the quotation and award
 * suites: turn order, the five-round limit, deadlines, warnings, acceptance
 * creating a negotiated quotation version, award/withdraw locks, concurrency,
 * confidentiality, permissions, the expiry job and the audit trail.
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<{ to: string; cc?: string[] }>,
}));

vi.mock("../lib/mailer", () => ({
  sendMail: vi.fn(async (mail: { to: string; cc?: string[] }) => {
    sentMail.push({ to: mail.to, cc: mail.cc });
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

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

interface Ctx {
  a: SeededVendor;
  b: SeededVendor;
  salesToken: string;
  adminToken: string;
  vendorTokenA: string;
  vendorTokenB: string;
}

let ctx: Ctx;

beforeEach(async () => {
  const fixtures = await seedIsolationFixtures();
  ctx = {
    a: fixtures.vendorA,
    b: fixtures.vendorB,
    salesToken: await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user"),
    adminToken: await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user"),
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

function rfqPayload(overrides: Record<string, unknown> = {}) {
  return {
    enquiryNo: "SP/2026/0999",
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
    siteLatitude: 22.3072,
    siteLongitude: 73.1812,
    ...overrides,
  };
}

async function createRfq(overrides: Record<string, unknown> = {}) {
  const res = await call(app, "POST", "/api/rfqs", {
    token: ctx.salesToken,
    body: rfqPayload(overrides),
  });
  expect(res.status, `create failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.rfq as { id: string; rfqNumber: string };
}

async function dispatchedRfq(overrides: Record<string, unknown> = {}) {
  const rfq = await createRfq(overrides);
  const res = await call(app, "POST", `/api/rfqs/${rfq.id}/send`, {
    token: ctx.salesToken,
    body: { vendorIds: [ctx.a.vendorId] },
  });
  expect(res.status, `send failed: ${JSON.stringify(res.body)}`).toBe(200);
  return rfq;
}

async function giveLoadChart(craneId: string): Promise<void> {
  await appPrisma.crane.update({
    where: { id: craneId },
    data: {
      loadChartFileRef: `vendors/test/cranes/${craneId}/chart.pdf`,
      loadChartFileName: "chart.pdf",
      loadChartMimeType: "application/pdf",
      loadChartSizeBytes: 1024,
    },
  });
}

async function submitBaseQuote(rfqId: string, rentalRate = 50_000) {
  await giveLoadChart(ctx.a.craneId);
  const res = await call(app, "POST", `/api/vendor/rfqs/${rfqId}/quotations`, {
    token: ctx.vendorTokenA,
    body: {
      craneId: ctx.a.craneId,
      rentalRate,
      rateBasis: "PER_MONTH",
      mobilisationCharges: 10_000,
      availabilityConfirmed: true,
      validityDate: inDays(14).toISOString(),
      acceptsCommercialTerms: true,
    },
  });
  expect(res.status, `quote failed: ${JSON.stringify(res.body)}`).toBe(201);
  const quotation = res.body.quotation as {
    quotationId: string;
    version: number;
    totalQuotedValue: number;
  };
  return {
    id: quotation.quotationId,
    version: quotation.version,
    totalQuotedValue: quotation.totalQuotedValue,
  };
}

function offerPayload(overrides: Record<string, unknown> = {}) {
  return {
    rentalRate: 50_000,
    rateBasis: "PER_MONTH",
    mobilisationCharges: 10_000,
    taxBasis: "EXCLUSIVE_OF_GST",
    validityDate: inDays(14).toISOString(),
    availabilityConfirmed: true,
    respondBy: inDays(3).toISOString(),
    expectedVersion: 0,
    ...overrides,
  };
}

async function smlCounter(
  rfqId: string,
  quotationId: string,
  overrides: Record<string, unknown> = {},
  token = ctx.salesToken,
) {
  return call(app, "POST", `/api/rfqs/${rfqId}/quotations/${quotationId}/counter`, {
    token,
    body: offerPayload(overrides),
  });
}

async function smlPreview(
  rfqId: string,
  quotationId: string,
  overrides: Record<string, unknown> = {},
) {
  return call(app, "POST", `/api/rfqs/${rfqId}/quotations/${quotationId}/counter/preview`, {
    token: ctx.salesToken,
    body: offerPayload(overrides),
  });
}

async function vendorCounter(
  negotiationId: string,
  overrides: Record<string, unknown> = {},
) {
  return call(app, "POST", `/api/vendor/negotiations/${negotiationId}/counter`, {
    token: ctx.vendorTokenA,
    body: offerPayload(overrides),
  });
}

async function vendorAccept(negotiationId: string, expectedVersion: number, confirm = true) {
  return call(app, "POST", `/api/vendor/negotiations/${negotiationId}/accept`, {
    token: ctx.vendorTokenA,
    body: { expectedVersion, confirm },
  });
}

async function listThreads(rfqId: string, token = ctx.salesToken) {
  return call(app, "GET", `/api/rfqs/${rfqId}/negotiations`, { token });
}

async function vendorListThreads(rfqId: string, token = ctx.vendorTokenA) {
  return call(app, "GET", `/api/vendor/rfqs/${rfqId}/negotiations`, { token });
}

// ---------------------------------------------------------------------------
// Permissions & basic flow
// ---------------------------------------------------------------------------

describe("negotiation permissions", () => {
  it("refuses vendor tokens on SML negotiation routes and internal tokens on vendor routes", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;

    expect((await listThreads(rfq.id, ctx.vendorTokenA)).status).toBe(403);
    expect(
      (await call(app, "POST", `/api/rfqs/${rfq.id}/quotations/${quote.id}/counter`, {
        token: ctx.vendorTokenA,
        body: offerPayload(),
      })).status,
    ).toBe(403);
    expect((await vendorListThreads(rfq.id, ctx.salesToken)).status).toBe(403);
    expect(
      (await call(app, "POST", `/api/vendor/negotiations/${negotiationId}/accept`, {
        token: ctx.salesToken,
        body: { expectedVersion: 1, confirm: true },
      })).status,
    ).toBe(403);
  });

  it("lets sales and admin both counter", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const bySales = await smlCounter(rfq.id, quote.id);
    expect(bySales.status).toBe(201);

    const rfq2 = await dispatchedRfq({ enquiryNo: "SP/2026/1000" });
    const quote2 = await submitBaseQuote(rfq2.id);
    const byAdmin = await smlCounter(rfq2.id, quote2.id, {}, ctx.adminToken);
    expect(byAdmin.status).toBe(201);
  });
});

describe("counter creation, preview & totals", () => {
  it("computes the total on the server and matches the preview endpoint", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    expect(quote.totalQuotedValue).toBe(210_000);

    const preview = await smlPreview(rfq.id, quote.id, { rentalRate: 60_000 });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.totalQuotedValue).toBe(250_000);

    const counter = await smlCounter(rfq.id, quote.id, {
      rentalRate: 60_000,
      acknowledgeWarnings: true,
    });
    expect(counter.status).toBe(201);
    expect(counter.body.result.totalQuotedValue).toBe(preview.body.preview.totalQuotedValue);
  });

  it("requires acknowledgement for COUNTER_ABOVE_VENDOR_PRICE", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);

    const unacknowledged = await smlCounter(rfq.id, quote.id, { rentalRate: 60_000 });
    expect(unacknowledged.status).toBe(422);
    expect(unacknowledged.body.code).toBe("WARNINGS_NOT_ACKNOWLEDGED");

    const acknowledged = await smlCounter(rfq.id, quote.id, {
      rentalRate: 60_000,
      acknowledgeWarnings: true,
    });
    expect(acknowledged.status).toBe(201);
    expect(
      acknowledged.body.result.warnings.some(
        (w: { code: string }) => w.code === "COUNTER_ABOVE_VENDOR_PRICE",
      ),
    ).toBe(true);
  });

  it("caps respondBy at the RFQ deadline", async () => {
    const rfq = await dispatchedRfq({ submissionDeadline: inDays(2).toISOString() });
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id, { respondBy: inDays(6).toISOString() });
    expect(counter.status).toBe(201);
    expect(new Date(counter.body.result.respondBy).getTime()).toBeLessThanOrEqual(
      new Date(rfq.submissionDeadline ?? inDays(2).toISOString()).getTime() + 1000,
    );
  });
});

describe("turn order, rounds & limit", () => {
  it("runs five alternating rounds, marks round 5 final, and rejects a sixth", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);

    // Round 1 (SML)
    let res = await smlCounter(rfq.id, quote.id, { rentalRate: 52_000, acknowledgeWarnings: true });
    expect(res.status).toBe(201);
    expect(res.body.result.roundNumber).toBe(1);
    expect(res.body.result.isFinal).toBe(false);
    let negotiationId = res.body.result.negotiationId as string;
    let version = res.body.result.version as number;

    // Round 2 (vendor) — raised vs the base quote, so acknowledgement is required.
    res = await vendorCounter(negotiationId, {
      rentalRate: 51_000,
      expectedVersion: version,
      acknowledgeWarnings: true,
    });
    expect(res.status, `round 2: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.result.roundNumber).toBe(2);
    version = res.body.result.version;

    // Round 3 (SML)
    res = await smlCounter(rfq.id, quote.id, {
      rentalRate: 52_000,
      acknowledgeWarnings: true,
      expectedVersion: version,
    });
    expect(res.status, `round 3: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.result.roundNumber).toBe(3);
    version = res.body.result.version;

    // Round 4 (vendor)
    res = await vendorCounter(negotiationId, {
      rentalRate: 51_500,
      expectedVersion: version,
      acknowledgeWarnings: true,
    });
    expect(res.status, `round 4: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.result.roundNumber).toBe(4);
    version = res.body.result.version;

    // Round 5 (SML) — final
    res = await smlCounter(rfq.id, quote.id, {
      rentalRate: 52_000,
      acknowledgeWarnings: true,
      expectedVersion: version,
    });
    expect(res.status, `round 5: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.result.roundNumber).toBe(5);
    expect(res.body.result.isFinal).toBe(true);
    version = res.body.result.version;

    // Round 6 (vendor counter) must be refused
    const sixth = await vendorCounter(negotiationId, { rentalRate: 52_000, expectedVersion: version });
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe("ROUND_LIMIT_REACHED");

    const threads = await listThreads(rfq.id);
    expect(threads.body.negotiations[0].status).toBe("AWAITING_VENDOR");
    expect(threads.body.negotiations[0].currentRound).toBe(5);
  });

  it("refuses the wrong side with NOT_YOUR_TURN", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;

    // Vendor's turn, so another SML counter is refused.
    const early = await smlCounter(rfq.id, quote.id, {
      expectedVersion: counter.body.result.version,
    });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("NOT_YOUR_TURN");

    // SML accepting while it's the vendor's turn is refused too.
    const wrongAccept = await call(app, "POST", `/api/rfqs/${rfq.id}/negotiations/${negotiationId}/accept`, {
      token: ctx.salesToken,
      body: { expectedVersion: counter.body.result.version },
    });
    expect(wrongAccept.status).toBe(409);
    expect(wrongAccept.body.code).toBe("NOT_YOUR_TURN");
  });

  it("returns VERSION_CONFLICT for a stale expectedVersion", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;

    await vendorCounter(negotiationId, { expectedVersion: counter.body.result.version });
    // Stale version 1 after round 2 bumped it to 2.
    const stale = await call(app, "POST", `/api/rfqs/${rfq.id}/negotiations/${negotiationId}/accept`, {
      token: ctx.salesToken,
      body: { expectedVersion: 1 },
    });
    // SML's turn now; stale version must still be caught first.
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
  });
});

describe("acceptance", () => {
  it("vendor accept needs confirm and creates a negotiated quotation without awarding", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;
    const version = counter.body.result.version as number;

    const noConfirm = await vendorAccept(negotiationId, version, false);
    expect(noConfirm.status).toBe(422);
    expect(noConfirm.body.code).toBe("CONFIRM_REQUIRED");

    const accepted = await vendorAccept(negotiationId, version, true);
    expect(accepted.status, `accept: ${JSON.stringify(accepted.body)}`).toBe(200);
    expect(accepted.body.result.status).toBe("AGREED");
    const agreedQuotationId = accepted.body.result.quotationId as string;

    const agreed = await appPrisma.quotation.findUnique({
      where: { id: agreedQuotationId },
      select: { version: true, source: true, isLatest: true, status: true, negotiationId: true },
    });
    expect(agreed?.version).toBe(2);
    expect(agreed?.source).toBe("NEGOTIATED");
    expect(agreed?.isLatest).toBe(true);
    expect(agreed?.status).toBe("SUBMITTED"); // not awarded
    expect(agreed?.negotiationId).toBe(negotiationId);

    const old = await appPrisma.quotation.findUnique({
      where: { id: quote.id },
      select: { isLatest: true },
    });
    expect(old?.isLatest).toBe(false); // superseded

    const rfqAfter = await appPrisma.rfq.findUnique({
      where: { id: rfq.id },
      select: { status: true },
    });
    expect(rfqAfter?.status).toBe("SENT"); // award did not happen
  });

  it("SML can accept a vendor counter", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;
    const vc = await vendorCounter(negotiationId, {
      rentalRate: 49_000,
      expectedVersion: counter.body.result.version,
    });
    expect(vc.status).toBe(201);

    const res = await call(app, "POST", `/api/rfqs/${rfq.id}/negotiations/${negotiationId}/accept`, {
      token: ctx.salesToken,
      body: { expectedVersion: vc.body.result.version },
    });
    expect(res.status, `sml accept: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.result.status).toBe("AGREED");
  });
});

describe("deadline rules", () => {
  it("refuses counter, accept and decline once the deadline has passed", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;

    // Move the deadline into the past after the offer was opened.
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: inDays(-1).toISOString() },
    });

    const lateCounter = await smlCounter(rfq.id, quote.id);
    expect(lateCounter.status).toBe(409);
    expect(lateCounter.body.code).toBe("DEADLINE_PASSED");

    const lateAccept = await vendorAccept(negotiationId, counter.body.result.version);
    expect(lateAccept.status).toBe(409);
    expect(lateAccept.body.code).toBe("DEADLINE_PASSED");

    const lateDecline = await call(app, "POST", `/api/vendor/negotiations/${negotiationId}/decline`, {
      token: ctx.vendorTokenA,
      body: { expectedVersion: counter.body.result.version },
    });
    expect(lateDecline.status).toBe(409);
    expect(lateDecline.body.code).toBe("DEADLINE_PASSED");
  });
});

describe("locks & award integration", () => {
  it("blocks vendor revise while a thread is open and cancels the thread on withdraw", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;

    const revise = await call(app, "POST", `/api/vendor/rfqs/quotations/${quote.id}/revisions`, {
      token: ctx.vendorTokenA,
      body: {
        rentalRate: 48_000,
        rateBasis: "PER_MONTH",
        mobilisationCharges: 10_000,
        availabilityConfirmed: true,
        validityDate: inDays(14).toISOString(),
        acceptsCommercialTerms: true,
      },
    });
    expect(revise.status).toBe(409);
    expect(revise.body.error).toContain("Respond to the open offer");

    const withdraw = await call(app, "POST", `/api/vendor/rfqs/quotations/${quote.id}/withdraw`, {
      token: ctx.vendorTokenA,
      body: {},
    });
    expect(withdraw.status).toBe(200);
    const thread = await appPrisma.quotationNegotiation.findUnique({
      where: { id: negotiationId },
      select: { status: true },
    });
    expect(thread?.status).toBe("CANCELLED");
  });

  it("awarding the agreed quotation works and closes the thread", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;
    const accepted = await vendorAccept(negotiationId, counter.body.result.version);
    const agreedId = accepted.body.result.quotationId as string;

    const award = await call(app, "POST", `/api/rfqs/${rfq.id}/quotations/${agreedId}/award`, {
      token: ctx.salesToken,
      body: {},
    });
    expect(award.status, `award: ${JSON.stringify(award.body)}`).toBe(200);

    const thread = await appPrisma.quotationNegotiation.findUnique({
      where: { id: negotiationId },
      select: { status: true },
    });
    expect(thread?.status).toBe("CANCELLED");
  });
});

describe("confidentiality, audit & jobs", () => {
  it("never returns another vendor's thread", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    const negotiationId = counter.body.result.negotiationId as string;

    // Vendor B was never sent this RFQ: the vendor-scoped read is a 404.
    const bList = await vendorListThreads(rfq.id, ctx.vendorTokenB);
    expect(bList.status).toBe(404);
    const bGet = await call(app, "GET", `/api/vendor/negotiations/${negotiationId}`, {
      token: ctx.vendorTokenB,
    });
    expect(bGet.status).toBe(404);
  });

  it("writes audit entries that appear on the RFQ audit feed", async () => {
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    const counter = await smlCounter(rfq.id, quote.id);
    expect(counter.status).toBe(201);
    const negotiationId = counter.body.result.negotiationId as string;
    await vendorAccept(negotiationId, counter.body.result.version);

    const audit = await call(app, "GET", `/api/rfqs/${rfq.id}/audit`, { token: ctx.salesToken });
    expect(audit.status).toBe(200);
    const actions = audit.body.events.map((event: { action: string }) => event.action);
    expect(actions).toContain("counter_sml");
    expect(actions).toContain("accept");
  });

  it("expires open threads idempotently", async () => {
    const { expireNegotiations } = await import("../services/negotiation.service");
    const rfq = await dispatchedRfq();
    const quote = await submitBaseQuote(rfq.id);
    // Make the open offer already expired by setting respondBy in the past.
    const counter = await smlCounter(rfq.id, quote.id, { respondBy: inDays(-1).toISOString() });
    expect(counter.status).toBe(201);

    const first = await expireNegotiations();
    const second = await expireNegotiations();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);

    const threads = await listThreads(rfq.id);
    expect(threads.body.negotiations[0].status).toBe("EXPIRED");
  });
});
