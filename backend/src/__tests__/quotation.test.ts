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
  callUpload,
  clearTestUploads,
  disconnectTestDatabases,
  internalToken,
  resetTestDatabase,
  sampleUpload,
  seedIsolationFixtures,
  useTestDatabase,
  type SeededVendor,
} from "./harness";
import { INTERNAL_USERS, VENDOR_PASSWORD, VENDOR_USERS } from "./fixtures";

/**
 * Milestone 5: the vendor's own RFQ inbox and quotations (brief 6.7, 7.6–7.8).
 *
 * The M5 acceptance line is one vendor's journey — see only your own RFQs, quote
 * with your own crane, see the total and the warnings, revise, withdraw, hit a
 * deadline lock, find every version in history — walked end to end below, with
 * each rule it names pinned by a focused test beside it:
 *
 * - the inbox and detail read a recipient row, so another vendor's RFQ is a 404;
 * - opening the detail records `first_viewed_at` exactly once;
 * - the total is rental charge plus mobilisation, with 30 days to a month, and
 *   the working is stored rather than only displayed;
 * - a crane that is not the vendor's, is inactive, under maintenance, booked or
 *   hired cannot be quoted;
 * - warnings are stored on the quotation and never block it;
 * - a revision is a new version, the latest is the one that counts, and the old
 *   one stays in history;
 * - quantity above one gets an independent version series per crane;
 * - after the deadline every action is refused;
 * - the RFQ creator is emailed on submission, and the customer's contact address
 *   never is.
 *
 * Every value here is fabricated (brief working rule 3).
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
// Fixtures
// ---------------------------------------------------------------------------

interface Ctx {
  a: SeededVendor;
  b: SeededVendor;
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
    salesToken: await internalToken(
      fixtures.salesId,
      INTERNAL_USERS.sales,
      "sales_user",
    ),
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
const todayUtc = () => new Date().toISOString().slice(0, 10);
const yearsAgo = (years: number): number => new Date().getUTCFullYear() - years;

function rfqPayload(overrides: Record<string, unknown> = {}) {
  return {
    enquiryNo: "SP/2026/0777",
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

/** Creates an RFQ owned by the sales user — the "creator" who gets notified. */
async function createRfq(overrides: Record<string, unknown> = {}) {
  const res = await call(app, "POST", "/api/rfqs", {
    token: ctx.salesToken,
    body: rfqPayload(overrides),
  });
  expect(res.status, `create failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.rfq as { id: string; rfqNumber: string };
}

async function sendRfq(rfqId: string, vendorIds: string[]) {
  const res = await call(app, "POST", `/api/rfqs/${rfqId}/send`, {
    token: ctx.salesToken,
    body: { vendorIds },
  });
  expect(res.status, `send failed: ${JSON.stringify(res.body)}`).toBe(200);
  return res;
}

/** An RFQ dispatched to vendor A, which is the starting point for most tests. */
async function dispatchedRfq(overrides: Record<string, unknown> = {}) {
  const rfq = await createRfq(overrides);
  await sendRfq(rfq.id, [ctx.a.vendorId]);
  return rfq;
}

/**
 * The fixture crane has no load chart, and brief 6.7 requires one, so tests that
 * are about something else give it one first.
 */
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

/** A second crane in vendor A's fleet, for the quantity-two series test. */
async function addCrane(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; serialRegistrationNo: string }> {
  return appPrisma.crane.create({
    data: {
      vendorId: ctx.a.vendorId,
      serialRegistrationNo: `A-EXTRA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      typeOfCraneCode: "CRAWLER",
      capacityT: 250,
      currentStatus: "AVAILABLE",
      currentLocation: "A Yard",
      stateCode: "GJ",
      make: "Demo",
      model: "Model-Extra",
      yom: 2022,
      mainBoomM: 50,
      latitude: 22.5,
      longitude: 72.5,
      coordinateSource: "manual",
      ...overrides,
    },
    select: { id: true, serialRegistrationNo: true },
  });
}

function quotePayload(overrides: Record<string, unknown> = {}) {
  return {
    craneId: ctx.a.craneId,
    rentalRate: 50_000,
    rateBasis: "PER_MONTH",
    mobilisationCharges: 10_000,
    availabilityConfirmed: true,
    validityDate: inDays(14).toISOString(),
    acceptsCommercialTerms: true,
    ...overrides,
  };
}

/** A quote payload flattened for a multipart body, where values are strings. */
function multipartFields(
  payload: Record<string, unknown>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    fields[key] = String(value);
  }
  return fields;
}

async function submitQuote(
  rfqId: string,
  overrides: Record<string, unknown> = {},
  token = ctx.vendorTokenA,
) {
  return call(app, "POST", `/api/vendor/rfqs/${rfqId}/quotations`, {
    token,
    body: quotePayload(overrides),
  });
}

async function reviseQuote(
  quotationId: string,
  overrides: Record<string, unknown> = {},
  token = ctx.vendorTokenA,
) {
  const { craneId: _ignored, ...body } = quotePayload(overrides);
  return call(
    app,
    "POST",
    `/api/vendor/rfqs/quotations/${quotationId}/revisions`,
    {
      token,
      body,
    },
  );
}

const emailLogs = async () =>
  appPrisma.emailLog.findMany({
    select: { toEmail: true, template: true, subject: true },
  });

// ---------------------------------------------------------------------------
// Access isolation (brief 6.6)
// ---------------------------------------------------------------------------

describe("vendor quotation access", () => {
  it("refuses every vendor quotation route to an internal user", async () => {
    const rfq = await dispatchedRfq();
    const routes: Array<["GET" | "POST", string]> = [
      ["GET", "/api/vendor/rfqs"],
      ["GET", `/api/vendor/rfqs/${rfq.id}`],
      ["GET", `/api/vendor/rfqs/${rfq.id}/quotations`],
      ["POST", `/api/vendor/rfqs/${rfq.id}/quotations`],
      ["POST", `/api/vendor/rfqs/${rfq.id}/quotations/preview`],
      ["POST", `/api/vendor/rfqs/${rfq.id}/decline`],
    ];

    for (const [method, path] of routes) {
      const res = await call(app, method, path, {
        token: ctx.salesToken,
        body: method === "GET" ? undefined : {},
      });
      // Not 404: the route exists, the capability does not.
      expect(res.status, `${method} ${path} must refuse a sales user`).toBe(
        403,
      );
    }
  });

  it("refuses an unauthenticated caller", async () => {
    expect((await call(app, "GET", "/api/vendor/rfqs")).status).toBe(401);
  });

  it("shows a vendor only the RFQs dispatched to them", async () => {
    const mine = await dispatchedRfq();
    // The same RFQ sent to both, plus one sent only to B.
    const shared = await dispatchedRfq({ enquiryNo: "SP/2026/0778" });
    await sendRfq(shared.id, [ctx.b.vendorId]);
    // Created but sent only to B, so A must never see it at all.
    const onlyB = await createRfq({ enquiryNo: "SP/2026/0779" });
    await sendRfq(onlyB.id, [ctx.b.vendorId]);

    const forA = await call(app, "GET", "/api/vendor/rfqs", {
      token: ctx.vendorTokenA,
    });
    expect(forA.status).toBe(200);
    const idsA = forA.body.rfqs.map((r: { rfqId: string }) => r.rfqId);
    expect(idsA.sort()).toEqual([mine.id, shared.id].sort());

    const forB = await call(app, "GET", "/api/vendor/rfqs", {
      token: ctx.vendorTokenB,
    });
    const idsB = forB.body.rfqs.map((r: { rfqId: string }) => r.rfqId);
    expect(idsB.sort()).toEqual([shared.id, onlyB.id].sort());
    expect(idsB).not.toContain(mine.id);
  });

  it("answers 404 for another vendor's RFQ rather than 403", async () => {
    const rfq = await dispatchedRfq();

    const detail = await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenB,
    });
    const history = await call(
      app,
      "GET",
      `/api/vendor/rfqs/${rfq.id}/quotations`,
      {
        token: ctx.vendorTokenB,
      },
    );

    // 404, not 403: a 403 would confirm the RFQ exists.
    expect(detail.status).toBe(404);
    expect(history.status).toBe(404);
  });

  it("answers 404 for another vendor's quotation id on every action", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    const submitted = await submitQuote(rfq.id);
    expect(submitted.status).toBe(201);
    const quotationId = submitted.body.quotation.quotationId;

    const attempts: Array<["POST" | "GET", string]> = [
      ["POST", `/api/vendor/rfqs/quotations/${quotationId}/revisions`],
      ["POST", `/api/vendor/rfqs/quotations/${quotationId}/withdraw`],
      ["GET", `/api/vendor/rfqs/quotations/${quotationId}/attachments`],
    ];

    for (const [method, path] of attempts) {
      const res = await call(app, method, path, {
        token: ctx.vendorTokenB,
        body: method === "GET" ? undefined : {},
      });
      expect(res.status, `${method} ${path} must be a 404 for B`).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Inbox and first view (brief 6.7, 7.6)
// ---------------------------------------------------------------------------

describe("vendor inbox", () => {
  it("records first_viewed_at once, on opening the detail", async () => {
    const rfq = await dispatchedRfq();
    const list = await call(app, "GET", "/api/vendor/rfqs", {
      token: ctx.vendorTokenA,
    });
    expect(list.body.rfqs[0].firstViewedAt).toBeNull();
    expect(list.body.rfqs[0].unread).toBe(true);

    await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenA,
    });

    const first = await appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(first.firstViewedAt).not.toBeNull();

    const stamped = first.firstViewedAt as Date;
    await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenA,
    });
    const second = await appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    // Second view must not move it, or "first viewed" means nothing.
    expect((second.firstViewedAt as Date).getTime()).toBe(stamped.getTime());
  });

  it("sorts by the nearest deadline and flags overdue without hiding it", async () => {
    const far = await dispatchedRfq({
      enquiryNo: "SP/2026/0801",
      submissionDeadline: inDays(9).toISOString(),
    });
    const near = await dispatchedRfq({
      enquiryNo: "SP/2026/0802",
      submissionDeadline: inDays(2).toISOString(),
    });
    const past = await dispatchedRfq({ enquiryNo: "SP/2026/0803" });
    // Creation insists on a future deadline, so the RFQ is aged out directly.
    await appPrisma.rfq.update({
      where: { id: past.id },
      data: { submissionDeadline: inHours(-1) },
    });

    const res = await call(app, "GET", "/api/vendor/rfqs", {
      token: ctx.vendorTokenA,
    });
    // Straight deadline ascending, so an already-overdue RFQ leads: its date is
    // the earliest. `overdue` and `canRespond` are how the UI knows it is dead —
    // the sort itself is not a judgement about which rows still matter.
    const order = res.body.rfqs.map((r: { rfqId: string }) => r.rfqId);
    expect(order).toEqual([past.id, near.id, far.id]);

    const overdue = res.body.rfqs.find(
      (r: { rfqId: string }) => r.rfqId === past.id,
    );
    expect(overdue.overdue).toBe(true);
    expect(overdue.canRespond).toBe(false);
  });

  it("filters the inbox by response status and search text", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    await submitQuote(rfq.id);

    const quoted = await call(
      app,
      "GET",
      "/api/vendor/rfqs?responseStatus=QUOTED",
      {
        token: ctx.vendorTokenA,
      },
    );
    expect(quoted.body.rfqs).toHaveLength(1);
    expect(quoted.body.rfqs[0].responseStatus).toBe("QUOTED");

    const pending = await call(
      app,
      "GET",
      "/api/vendor/rfqs?responseStatus=PENDING",
      {
        token: ctx.vendorTokenA,
      },
    );
    expect(pending.body.rfqs).toHaveLength(0);

    const byNumber = await call(
      app,
      "GET",
      "/api/vendor/rfqs?search=SP/2026/0777",
      {
        token: ctx.vendorTokenA,
      },
    );
    expect(byNumber.body.rfqs).toHaveLength(1);

    const byNothing = await call(
      app,
      "GET",
      "/api/vendor/rfqs?search=ZZZ-nothing",
      {
        token: ctx.vendorTokenA,
      },
    );
    expect(byNothing.body.rfqs).toHaveLength(0);
  });

  it("reports the most recently sent quote as the inbox total", async () => {
    // Two cranes, each quoted once: both are version 1, so a version-ordered
    // roll-up reports whichever row the database returned first. The vendor has
    // to see the total of the quote they sent last.
    await giveLoadChart(ctx.a.craneId);
    const rfq = await dispatchedRfq();
    const extra = await addCrane({ capacityT: 100 });
    await giveLoadChart(extra.id);

    const first = await submitQuote(rfq.id, { rentalRate: 50_000 });
    expect(first.status).toBe(201);
    const later = await submitQuote(
      rfq.id,
      { craneId: extra.id, rentalRate: 80_000 },
    );
    expect(later.status).toBe(201);

    const inbox = await call(app, "GET", "/api/vendor/rfqs", {
      token: ctx.vendorTokenA,
    });
    const row = inbox.body.rfqs.find(
      (r: { rfqId: string }) => r.rfqId === rfq.id,
    );
    expect(row.quotationCount).toBe(2);
    expect(Number(row.latestQuotationTotal)).toBe(80_000 * 4 + 10_000);
  });
});

// ---------------------------------------------------------------------------
// Total calculation (brief 6.7)
// ---------------------------------------------------------------------------

describe("quotation total", () => {
  beforeEach(async () => {
    await giveLoadChart(ctx.a.craneId);
  });

  it("multiplies a per-month rate by the duration and adds mobilisation", async () => {
    const rfq = await dispatchedRfq({
      durationValue: 4,
      durationUnit: "MONTHS",
    });
    const res = await submitQuote(rfq.id, {
      rentalRate: 50_000,
      rateBasis: "PER_MONTH",
      mobilisationCharges: 10_000,
    });

    expect(res.status).toBe(201);
    expect(res.body.quotation.rentalCharge).toBe(200_000);
    expect(res.body.quotation.totalQuotedValue).toBe(210_000);

    const stored = await appPrisma.quotation.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(Number(stored.totalQuotedValue)).toBe(210_000);
  });

  it("converts a month to 30 days when the rate is per day", async () => {
    const rfq = await dispatchedRfq({
      durationValue: 2,
      durationUnit: "MONTHS",
    });
    const res = await submitQuote(rfq.id, {
      rentalRate: 3_000,
      rateBasis: "PER_DAY",
      mobilisationCharges: 0,
    });

    // 2 months = 60 days by the brief's own conversion, not by any calendar.
    expect(res.body.quotation.rentalCharge).toBe(180_000);
    expect(res.body.quotation.totalQuotedValue).toBe(180_000);
    expect(res.body.quotation.calculationNote).toContain("60 days");
  });

  it("treats a lump sum as the whole job without multiplying the duration", async () => {
    const rfq = await dispatchedRfq({
      durationValue: 6,
      durationUnit: "MONTHS",
    });
    const res = await submitQuote(rfq.id, {
      rentalRate: 900_000,
      rateBasis: "LUMP_SUM",
      mobilisationCharges: 25_000,
    });

    expect(res.body.quotation.rentalCharge).toBe(900_000);
    expect(res.body.quotation.totalQuotedValue).toBe(925_000);
    expect(res.body.quotation.calculationNote).toContain("not multiplied");
  });

  it("stores the working so a reprint reproduces it", async () => {
    const rfq = await dispatchedRfq();
    await submitQuote(rfq.id);
    const stored = await appPrisma.quotation.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(stored.calculationNote).toBeTruthy();
    // Indian digit grouping, because that is how the figure reaches the customer.
    expect(stored.calculationNote).toContain("50,000.00 per month × 4 months");
    expect(stored.calculationNote).toContain("2,00,000.00");
    expect(stored.calculationNote).toContain("mobilisation");
    expect(stored.calculationNote).toContain("2,10,000.00");
  });

  it("previews the same total without storing anything", async () => {
    const rfq = await dispatchedRfq();
    const res = await call(
      app,
      "POST",
      `/api/vendor/rfqs/${rfq.id}/quotations/preview`,
      {
        token: ctx.vendorTokenA,
        body: quotePayload(),
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.preview.totalQuotedValue).toBe(210_000);
    expect(res.body.preview.canSubmit).toBe(true);
    expect(await appPrisma.quotation.count({ where: { rfqId: rfq.id } })).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Blocking rules (brief 6.7)
// ---------------------------------------------------------------------------

describe("quotation blocks", () => {
  it("refuses a crane belonging to another vendor", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.b.craneId);
    const res = await submitQuote(rfq.id, { craneId: ctx.b.craneId });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not in your fleet/i);
  });

  it("refuses a nonexistent crane id", async () => {
    const rfq = await dispatchedRfq();
    const res = await submitQuote(rfq.id, {
      craneId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.status).toBe(404);
  });

  it.each(["UNDER_MAINTENANCE", "BOOKED", "HIRED"] as const)(
    "refuses a crane whose status is %s",
    async (status) => {
      const rfq = await dispatchedRfq();
      await giveLoadChart(ctx.a.craneId);
      await appPrisma.crane.update({
        where: { id: ctx.a.craneId },
        data: { currentStatus: status },
      });

      const res = await submitQuote(rfq.id);
      expect(res.status).toBe(400);
      expect(
        await appPrisma.quotation.count({ where: { rfqId: rfq.id } }),
      ).toBe(0);
    },
  );

  it("refuses a deactivated crane", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { isActive: false },
    });

    expect((await submitQuote(rfq.id)).status).toBe(400);
  });

  it("allows an Engaged crane, because it frees up in time", async () => {
    const rfq = await dispatchedRfq({
      requiredStartDate: inDays(60).toISOString(),
    });
    await giveLoadChart(ctx.a.craneId);
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { currentStatus: "ENGAGED", availableFrom: inDays(10) },
    });

    const res = await submitQuote(rfq.id);
    expect(res.status).toBe(201);
  });

  it("requires a rental rate above zero", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);

    for (const rentalRate of [0, -1]) {
      const res = await submitQuote(rfq.id, { rentalRate });
      expect(res.status).toBe(400);
    }
  });

  it("requires mobilisation of zero or more", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    expect(
      (await submitQuote(rfq.id, { mobilisationCharges: -1 })).status,
    ).toBe(400);
  });

  it("requires an explicit availability confirmation", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);

    const res = await submitQuote(rfq.id, { availabilityConfirmed: false });
    expect(res.status).toBe(400);
    expect(await appPrisma.quotation.count()).toBe(0);
  });

  it("requires a validity date of today or later", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);

    const yesterday = await submitQuote(rfq.id, {
      validityDate: inDays(-1).toISOString(),
    });
    expect(yesterday.status).toBe(400);

    const today = await submitQuote(rfq.id, { validityDate: todayUtc() });
    expect(today.status).toBe(201);
  });

  it("refuses a quotation when neither the crane nor the submission has a load chart", async () => {
    const rfq = await dispatchedRfq();

    const bare = await submitQuote(rfq.id);
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/load chart/i);
    expect(await appPrisma.quotation.count()).toBe(0);
  });

  it("accepts a load chart uploaded with the quotation and stores it", async () => {
    const rfq = await dispatchedRfq();

    const res = await callUpload(
      app,
      "POST",
      `/api/vendor/rfqs/${rfq.id}/quotations`,
      sampleUpload("pdf"),
      {
        token: ctx.vendorTokenA,
        field: "loadChart",
        fields: multipartFields(quotePayload()),
      },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const attachments = await appPrisma.quotationAttachment.findMany({
      where: { quotationId: res.body.quotation.quotationId },
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe("LOAD_CHART");
    expect(attachments[0].fileName).toBe("sample.pdf");
  });

  it("lets a revision rely on the chart already attached to version 1", async () => {
    const rfq = await dispatchedRfq();

    const first = await callUpload(
      app,
      "POST",
      `/api/vendor/rfqs/${rfq.id}/quotations`,
      sampleUpload("pdf"),
      {
        token: ctx.vendorTokenA,
        field: "loadChart",
        fields: multipartFields(quotePayload()),
      },
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // No file this time, and the crane still has none: the series already has one.
    const revised = await reviseQuote(first.body.quotation.quotationId, {
      rentalRate: 45_000,
    });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    expect(revised.body.quotation.version).toBe(2);
  });

  it("rejects a file whose bytes are not the type it claims", async () => {
    const rfq = await dispatchedRfq();

    const res = await callUpload(
      app,
      "POST",
      `/api/vendor/rfqs/${rfq.id}/quotations`,
      sampleUpload("text"),
      {
        token: ctx.vendorTokenA,
        field: "loadChart",
        fields: multipartFields(quotePayload()),
      },
    );
    expect(res.status).toBe(400);
    expect(await appPrisma.quotation.count()).toBe(0);
  });

  it("refuses a second quotation for the same crane and points at revision", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    expect((await submitQuote(rfq.id)).status).toBe(201);

    const again = await submitQuote(rfq.id, { rentalRate: 60_000 });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/revise/i);
    expect(await appPrisma.quotation.count({ where: { rfqId: rfq.id } })).toBe(
      1,
    );
  });

  it("refuses submission after the deadline", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: inHours(-1) },
    });

    const res = await submitQuote(rfq.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deadline/i);
  });
});

// ---------------------------------------------------------------------------
// Warnings (brief 6.7)
// ---------------------------------------------------------------------------

describe("quotation warnings", () => {
  it("stores a warning when the crane type differs, without blocking", async () => {
    const rfq = await dispatchedRfq({ craneType: "CRAWLER" });
    await giveLoadChart(ctx.a.craneId);
    await appPrisma.craneType.create({
      data: { code: "TRUCK", name: "Truck Crane", sortOrder: 20 },
    });
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { typeOfCraneCode: "TRUCK" },
    });

    const res = await submitQuote(rfq.id);
    expect(res.status).toBe(201);
    expect(
      res.body.quotation.warnings.map((w: { code: string }) => w.code),
    ).toContain("crane_type_differs");

    const stored = await appPrisma.quotation.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(Array.isArray(stored.warnings)).toBe(true);
  });

  it("warns when capacity differs in either direction", async () => {
    // Below the requirement.
    const low = await dispatchedRfq({
      capacityT: 300,
      enquiryNo: "SP/2026/0811",
    });
    await giveLoadChart(ctx.a.craneId);
    const lowRes = await submitQuote(low.id);
    expect(lowRes.status).toBe(201);
    expect(
      lowRes.body.quotation.warnings.map((w: { code: string }) => w.code),
    ).toContain("capacity_below_requirement");

    // Above the requirement: still a difference sales should see.
    const high = await dispatchedRfq({
      capacityT: 80,
      enquiryNo: "SP/2026/0812",
    });
    const highRes = await submitQuote(high.id, { craneId: ctx.a.craneId });
    expect(
      highRes.body.quotation.warnings.map((w: { code: string }) => w.code),
    ).toContain("capacity_above_requirement");
  });

  it("warns when the YOM breaks the customer's age criterion", async () => {
    const rfq = await dispatchedRfq({ craneAgeCriteriaYears: 5 });
    await giveLoadChart(ctx.a.craneId);
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { yom: new Date().getUTCFullYear() - 9 },
    });

    const res = await submitQuote(rfq.id);
    expect(res.status).toBe(201);
    expect(
      res.body.quotation.warnings.map((w: { code: string }) => w.code),
    ).toContain("yom_outside_criteria");
  });

  it("warns when an Engaged crane frees up after the required start", async () => {
    const rfq = await dispatchedRfq({
      requiredStartDate: inDays(10).toISOString(),
    });
    await giveLoadChart(ctx.a.craneId);
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { currentStatus: "ENGAGED", availableFrom: inDays(20) },
    });

    const res = await submitQuote(rfq.id);
    expect(res.status).toBe(201);
    expect(
      res.body.quotation.warnings.map((w: { code: string }) => w.code),
    ).toContain("available_after_required_start");
  });

  it("raises no warning for a crane that matches the requirement", async () => {
    const rfq = await dispatchedRfq({
      craneType: "CRAWLER",
      capacityT: 250,
      craneAgeCriteriaYears: 5,
    });
    await giveLoadChart(ctx.a.craneId);
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { yom: yearsAgo(2) },
    });

    const res = await submitQuote(rfq.id);
    expect(res.status).toBe(201);
    expect(res.body.quotation.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Versioning (brief 6.7)
// ---------------------------------------------------------------------------

describe("quotation versions", () => {
  beforeEach(async () => {
    await giveLoadChart(ctx.a.craneId);
  });

  it("keeps every version and counts only the latest", async () => {
    const rfq = await dispatchedRfq();
    const first = await submitQuote(rfq.id, { rentalRate: 50_000 });
    expect(first.status).toBe(201);
    const v1 = first.body.quotation.quotationId;

    const second = await reviseQuote(v1, { rentalRate: 45_000 });
    expect(second.status).toBe(201);
    expect(second.body.quotation.version).toBe(2);

    const rows = await appPrisma.quotation.findMany({
      where: { rfqId: rfq.id },
      orderBy: { version: "asc" },
      select: { version: true, isLatest: true, rentalRate: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 1, isLatest: false });
    expect(rows[1]).toMatchObject({ version: 2, isLatest: true });
    expect(Number(rows[1].rentalRate)).toBe(45_000);
  });

  it("refuses to revise a superseded version", async () => {
    const rfq = await dispatchedRfq();
    const first = await submitQuote(rfq.id);
    const v1 = first.body.quotation.quotationId;
    await reviseQuote(v1, { rentalRate: 45_000 });

    const res = await reviseQuote(v1, { rentalRate: 44_000 });
    expect(res.status).toBe(409);
    expect(await appPrisma.quotation.count({ where: { rfqId: rfq.id } })).toBe(
      2,
    );
  });

  it("reports every version in history, newest first within a crane", async () => {
    const rfq = await dispatchedRfq();
    const v1 = (await submitQuote(rfq.id)).body.quotation.quotationId;
    // Each revision supersedes the last, so the chain has to be followed rather
    // than revising v1 twice — that is a 409 by design.
    const v2 = (await reviseQuote(v1, { rentalRate: 45_000 })).body.quotation
      .quotationId;
    await reviseQuote(v2, { rentalRate: 44_000 });

    const res = await call(
      app,
      "GET",
      `/api/vendor/rfqs/${rfq.id}/quotations`,
      {
        token: ctx.vendorTokenA,
      },
    );
    expect(res.status).toBe(200);
    // One series for the one crane quoted, newest version first.
    expect(res.body.series).toHaveLength(1);
    const versions = res.body.series[0].versions;
    expect(versions.map((q: { version: number }) => q.version)).toEqual([
      3, 2, 1,
    ]);
    expect(
      versions.filter((q: { isLatest: boolean }) => q.isLatest),
    ).toHaveLength(1);
  });

  it("gives each crane its own version series when quantity is above one", async () => {
    const rfq = await dispatchedRfq({ quantity: 2 });
    const second = await addCrane();
    await giveLoadChart(second.id);

    const first = await submitQuote(rfq.id);
    expect(first.status).toBe(201);
    const other = await submitQuote(rfq.id, { craneId: second.id });
    expect(other.status).toBe(201);

    // Both start at version 1: the series is per crane, not per RFQ.
    expect(other.body.quotation.version).toBe(1);

    const revised = await reviseQuote(first.body.quotation.quotationId, {
      rentalRate: 46_000,
    });
    expect(revised.body.quotation.version).toBe(2);

    const rows = await appPrisma.quotation.findMany({
      where: { rfqId: rfq.id },
      select: { craneId: true, version: true, isLatest: true },
      orderBy: [{ craneId: "asc" }, { version: "asc" }],
    });
    expect(rows.filter((r) => r.craneId === ctx.a.craneId)).toHaveLength(2);
    expect(rows.filter((r) => r.craneId === second.id)).toHaveLength(1);
  });

  it("re-checks the crane on revision, so a booked crane cannot collect a new price", async () => {
    const rfq = await dispatchedRfq();
    const v1 = (await submitQuote(rfq.id)).body.quotation.quotationId;

    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { currentStatus: "BOOKED" },
    });

    const res = await reviseQuote(v1, { rentalRate: 40_000 });
    expect(res.status).toBe(400);
    expect(await appPrisma.quotation.count({ where: { rfqId: rfq.id } })).toBe(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Withdrawal (brief 6.7)
// ---------------------------------------------------------------------------

describe("quotation withdrawal", () => {
  beforeEach(async () => {
    await giveLoadChart(ctx.a.craneId);
  });

  it("withdraws the latest version and keeps it in history", async () => {
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;

    const res = await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      {
        token: ctx.vendorTokenA,
        body: { reason: "Crane committed elsewhere" },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.withdrawn).toBe(true);

    const row = await appPrisma.quotation.findUniqueOrThrow({
      where: { id: quotationId },
    });
    expect(row.status).toBe("WITHDRAWN");
    expect(row.isLatest).toBe(false);
  });

  it("keeps the reason in the audit trail", async () => {
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;

    await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      {
        token: ctx.vendorTokenA,
        body: { reason: "Rate withdrawn by head office" },
      },
    );

    const audit = await appPrisma.auditLog.findFirst({
      where: { entity: "quotation", entityId: quotationId, action: "withdraw" },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.newValue)).toContain(
      "Rate withdrawn by head office",
    );
  });

  it("sends the vendor a receipt for the withdrawal", async () => {
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;
    await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      {
        token: ctx.vendorTokenA,
        body: {},
      },
    );

    const receipt = (await emailLogs()).filter(
      (e) => e.template === "quotation_receipt",
    );
    expect(receipt.some((e) => e.subject.includes("withdrawn"))).toBe(true);
  });

  it("refuses to withdraw the same version twice", async () => {
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;

    await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      {
        token: ctx.vendorTokenA,
        body: {},
      },
    );
    const again = await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      { token: ctx.vendorTokenA, body: {} },
    );
    expect(again.status).toBe(409);
  });

  it("refuses to withdraw a superseded version", async () => {
    const rfq = await dispatchedRfq();
    const v1 = (await submitQuote(rfq.id)).body.quotation.quotationId;
    await reviseQuote(v1, { rentalRate: 45_000 });

    const res = await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${v1}/withdraw`,
      {
        token: ctx.vendorTokenA,
        body: {},
      },
    );
    expect(res.status).toBe(409);
  });

  it("lets a withdrawn quote be revived as a new version", async () => {
    // `submit` refuses a second quote for a crane that already has one, so a
    // withdrawal that also refused a revision would lock the crane out of the
    // RFQ permanently. Reviving is the only way back, and the withdrawn version
    // stays on record beside the new one.
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;

    await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      { token: ctx.vendorTokenA, body: { reason: "Crane committed elsewhere" } },
    );

    const revised = await reviseQuote(quotationId, { rentalRate: 60_000 });
    expect(revised.status).toBe(201);
    expect(revised.body.quotation.version).toBe(2);
    // The fixture RFQ is 4 months: 60,000 x 4, plus 10,000 mobilisation.
    expect(revised.body.quotation.totalQuotedValue).toBe(250_000);

    const rows = await appPrisma.quotation.findMany({
      where: { rfqId: rfq.id, craneId: ctx.a.craneId },
      orderBy: { version: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("WITHDRAWN");
    expect(rows[1].version).toBe(2);
    expect(rows[1].isLatest).toBe(true);

    const history = await call(
      app,
      "GET",
      `/api/vendor/rfqs/${rfq.id}/quotations`,
      { token: ctx.vendorTokenA },
    );
    expect(history.body.series[0].versions).toHaveLength(2);
    expect(history.body.series[0].versions[0].version).toBe(2);
    expect(history.body.series[0].versions[1].status).toBe("WITHDRAWN");
  });

  it("still reports a withdrawn quote as revisable on the detail screen", async () => {
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;

    await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      { token: ctx.vendorTokenA, body: {} },
    );

    const detail = await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenA,
    });
    expect(detail.body.quotations[0].status).toBe("WITHDRAWN");
    // The vendor needs the Revise button offered here, or the crane is lost.
    expect(detail.body.quotations[0].editable).toBe(true);
  });

  it("keeps the recipient marked as having responded after a withdrawal", async () => {
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;
    await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      {
        token: ctx.vendorTokenA,
        body: {},
      },
    );

    const recipient = await appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    // "Quoted then withdrew" is a different conversation from "never replied".
    expect(recipient.responseStatus).toBe("QUOTED");
  });
});

// ---------------------------------------------------------------------------
// Deadline lock (brief 6.7)
// ---------------------------------------------------------------------------

describe("deadline lock", () => {
  it("refuses every action once the deadline has passed", async () => {
    await giveLoadChart(ctx.a.craneId);
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;

    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: inHours(-1) },
    });

    const attempts: Array<["GET" | "POST", string, unknown]> = [
      ["POST", `/api/vendor/rfqs/${rfq.id}/quotations`, quotePayload()],
      [
        "POST",
        `/api/vendor/rfqs/quotations/${quotationId}/revisions`,
        quotePayload(),
      ],
      ["POST", `/api/vendor/rfqs/quotations/${quotationId}/withdraw`, {}],
      ["POST", `/api/vendor/rfqs/${rfq.id}/decline`, { reason: "Too far" }],
    ];

    for (const [method, path, body] of attempts) {
      const res = await call(app, method, path, {
        token: ctx.vendorTokenA,
        body,
      });
      expect(
        res.status,
        `${method} ${path} must be refused after the deadline`,
      ).toBe(409);
    }
  });

  it("still serves the detail and history after the deadline", async () => {
    const rfq = await dispatchedRfq();
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: inHours(-1) },
    });

    const detail = await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenA,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.rfq.locked).toBe(true);
    expect(detail.body.response.canRespond).toBe(false);
  });

  it("reopens when an internal user extends the deadline", async () => {
    await giveLoadChart(ctx.a.craneId);
    const rfq = await dispatchedRfq();
    // Creation insists on a future deadline, so the RFQ is aged out directly —
    // the same state an RFQ left alone overnight is in.
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: inHours(-2) },
    });
    expect((await submitQuote(rfq.id)).status).toBe(409);

    const extend = await call(app, "PATCH", `/api/rfqs/${rfq.id}/deadline`, {
      token: ctx.salesToken,
      body: { submissionDeadline: inDays(3).toISOString() },
    });
    expect(extend.status).toBe(200);

    expect((await submitQuote(rfq.id)).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Declining (brief 6.7)
// ---------------------------------------------------------------------------

describe("declining an RFQ", () => {
  it("records the reason and stops the vendor responding", async () => {
    const rfq = await dispatchedRfq();
    const res = await call(app, "POST", `/api/vendor/rfqs/${rfq.id}/decline`, {
      token: ctx.vendorTokenA,
      body: {
        reason: "No crane of this type in range",
        note: "Can help from next month",
      },
    });
    expect(res.status).toBe(200);

    const recipient = await appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(recipient.responseStatus).toBe("DECLINED");
    expect(recipient.declineReason).toBe("No crane of this type in range");
    expect(recipient.respondedAt).not.toBeNull();
  });

  it("refuses a second decline", async () => {
    const rfq = await dispatchedRfq();
    await call(app, "POST", `/api/vendor/rfqs/${rfq.id}/decline`, {
      token: ctx.vendorTokenA,
      body: { reason: "No capacity" },
    });
    const again = await call(
      app,
      "POST",
      `/api/vendor/rfqs/${rfq.id}/decline`,
      {
        token: ctx.vendorTokenA,
        body: { reason: "Changed my mind" },
      },
    );
    expect(again.status).toBe(409);
  });

  it("refuses to decline after the vendor has quoted", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    await submitQuote(rfq.id);

    const res = await call(app, "POST", `/api/vendor/rfqs/${rfq.id}/decline`, {
      token: ctx.vendorTokenA,
      body: { reason: "Changed my mind" },
    });
    expect(res.status).toBe(409);
  });

  it("refuses submission after declining", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    await call(app, "POST", `/api/vendor/rfqs/${rfq.id}/decline`, {
      token: ctx.vendorTokenA,
      body: { reason: "No capacity" },
    });

    const res = await submitQuote(rfq.id);
    expect(res.status).toBe(409);
  });

  it("keeps a cancelled RFQ readable but refuses every action on it", async () => {
    await giveLoadChart(ctx.a.craneId);
    const rfq = await dispatchedRfq();
    const cancel = await call(app, "POST", `/api/rfqs/${rfq.id}/cancel`, {
      token: ctx.salesToken,
      body: { reason: "Customer withdrew the requirement" },
    });
    expect(cancel.status).toBe(200);

    // Readable: the vendor learns why, rather than seeing it vanish.
    const detail = await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenA,
    });
    expect(detail.status).toBe(200);

    const submit = await submitQuote(rfq.id);
    expect(submit.status).toBe(409);
    expect(submit.body.error).toMatch(/cancel/i);
  });
});

// ---------------------------------------------------------------------------
// Notifications (brief 6.7)
// ---------------------------------------------------------------------------

describe("quotation notifications", () => {
  beforeEach(async () => {
    await giveLoadChart(ctx.a.craneId);
  });

  it("emails the RFQ creator on submission", async () => {
    const rfq = await dispatchedRfq();
    await submitQuote(rfq.id);

    const creatorMail = (await emailLogs()).filter(
      (e) => e.template === "quotation_received",
    );
    expect(creatorMail).toHaveLength(1);
    expect(creatorMail[0].toEmail).toBe(INTERNAL_USERS.sales);
    expect(creatorMail[0].subject).toContain(rfq.rfqNumber);
  });

  it("never emails the customer's contact address", async () => {
    const rfq = await createRfq({
      smlContactEmail: "customer.contact@example.test",
    });
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    await submitQuote(rfq.id);

    // A quotation carries this vendor's price; the customer must not receive it.
    const customerMail = (await emailLogs()).filter(
      (e) => e.toEmail === "customer.contact@example.test",
    );
    expect(customerMail.every((e) => e.template !== "quotation_received")).toBe(
      true,
    );
  });

  it("emails the creator again on a revision", async () => {
    const rfq = await dispatchedRfq();
    const v1 = (await submitQuote(rfq.id)).body.quotation.quotationId;
    await reviseQuote(v1, { rentalRate: 45_000 });

    const creatorMail = (await emailLogs()).filter(
      (e) => e.template === "quotation_received",
    );
    expect(creatorMail).toHaveLength(2);
    expect(creatorMail.every((e) => e.toEmail === INTERNAL_USERS.sales)).toBe(
      true,
    );
  });

  it("sends the vendor a receipt on submission", async () => {
    const rfq = await dispatchedRfq();
    await submitQuote(rfq.id);

    const receipt = (await emailLogs()).filter(
      (e) => e.template === "quotation_receipt",
    );
    expect(receipt).toHaveLength(1);
    expect(receipt[0].toEmail).toBe(ctx.a.email);
  });

  it("moves the RFQ roll-up to Quotes Received on the first quotation", async () => {
    const rfq = await dispatchedRfq();
    const before = await appPrisma.rfq.findUniqueOrThrow({
      where: { id: rfq.id },
    });
    expect(before.rollupStatus).toBe("AWAITING_QUOTES");

    await submitQuote(rfq.id);

    const after = await appPrisma.rfq.findUniqueOrThrow({
      where: { id: rfq.id },
    });
    expect(after.rollupStatus).toBe("QUOTES_RECEIVED");
  });

  it("does not move the roll-up backwards when a vendor withdraws", async () => {
    const rfq = await dispatchedRfq();
    const quotationId = (await submitQuote(rfq.id)).body.quotation.quotationId;
    await call(
      app,
      "POST",
      `/api/vendor/rfqs/quotations/${quotationId}/withdraw`,
      {
        token: ctx.vendorTokenA,
        body: {},
      },
    );

    const row = await appPrisma.rfq.findUniqueOrThrow({
      where: { id: rfq.id },
    });
    expect(row.rollupStatus).toBe("QUOTES_RECEIVED");
  });

  it("marks the recipient as responded", async () => {
    const rfq = await dispatchedRfq();
    await submitQuote(rfq.id);

    const recipient = await appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(recipient.responseStatus).toBe("QUOTED");
    expect(recipient.respondedAt).not.toBeNull();
  });

  it("writes an audit row for a submission", async () => {
    const rfq = await dispatchedRfq();
    await submitQuote(rfq.id);

    const audit = await appPrisma.auditLog.findFirst({
      where: { entity: "quotation", action: "submit" },
    });
    expect(audit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stored snapshots (brief 5.4)
// ---------------------------------------------------------------------------

describe("stored quotation snapshots", () => {
  it("freezes the crane location and the distance shown at submission", async () => {
    const rfq = await dispatchedRfq();
    await giveLoadChart(ctx.a.craneId);
    await submitQuote(rfq.id);

    const row = await appPrisma.quotation.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(row.distanceToSiteKm).not.toBeNull();
    expect(row.distanceMethod).not.toBeNull();
    expect(row.craneLocationSnapshot).toMatchObject({
      currentLocation: "A Yard",
      stateCode: "GJ",
    });

    // Moving the crane must not rewrite what the vendor was shown.
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: {
        currentLocation: "Somewhere Else",
        latitude: 19.1,
        longitude: 72.9,
      },
    });
    const after = await appPrisma.quotation.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(Number(after.distanceToSiteKm)).toBe(Number(row.distanceToSiteKm));
    expect(after.craneLocationSnapshot).toEqual(row.craneLocationSnapshot);
  });
});
