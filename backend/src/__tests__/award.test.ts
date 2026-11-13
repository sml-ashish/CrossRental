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
 * Milestone 7: the award outcome, the vendor dashboard and the background
 * reminders (brief 6.7 award, 7.5 dashboard, 6.5 stale data).
 *
 * The milestone's done-when is one sentence — "awarding one quotation marks the
 * others Not Awarded, books the crane, emails the vendors, and shows the
 * booking on the winning vendor's dashboard" — so the first test walks exactly
 * that journey and the rest pin each rule it depends on:
 *
 * - only the latest, live quotation of a still-open RFQ can be awarded;
 * - the crane is booked by the system, and a vendor can no longer edit it;
 * - the vendor sees Awarded / Not Awarded, never the internal SELECTED;
 * - after an award the RFQ is closed and every vendor action is refused;
 * - sales may award (P3: the CR path); a vendor cannot reach the endpoint at all;
 * - the dashboard counters and the stale-crane list are vendor-scoped;
 * - the reminder sweeps fire once inside their windows, not twice.
 *
 * All values are fabricated (brief working rule 3).
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<{ to: string; cc?: string[]; subject?: string }>,
}));

vi.mock("../lib/mailer", () => ({
  sendMail: vi.fn(async (mail: { to: string; cc?: string[]; subject?: string }) => {
    sentMail.push({ to: mail.to, cc: mail.cc, subject: mail.subject });
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
}

/** Both cranes need load charts, because quoting requires one (brief 6.7). */
async function giveLoadCharts(): Promise<void> {
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
  return res.body.quotation as { quotationId: string; totalQuotedValue: number };
}

/** Both vendors quoted one RFQ: the award journey's starting point. */
async function quotedRfq(overrides: Record<string, unknown> = {}) {
  const rfq = await createRfq(overrides);
  await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);
  await giveLoadCharts();
  const quoteA = await submitQuote(rfq.id, ctx.a, 50_000, ctx.vendorTokenA);
  const quoteB = await submitQuote(rfq.id, ctx.b, 65_000, ctx.vendorTokenB);
  return { rfq, quoteA, quoteB };
}

async function reviseQuote(quotationId: string, token: string, rate: number) {
  return call(
    app,
    "POST",
    `/api/vendor/rfqs/quotations/${quotationId}/revisions`,
    {
      token,
      body: {
        rentalRate: rate,
        rateBasis: "PER_MONTH",
        mobilisationCharges: 0,
        validityDate: inDays(14).toISOString(),
        availabilityConfirmed: true,
        acceptsCommercialTerms: true,
      },
    },
  );
}

async function withdrawQuote(quotationId: string, token: string) {
  return call(app, "POST", `/api/vendor/rfqs/quotations/${quotationId}/withdraw`, {
    token,
    body: {},
  });
}

async function award(
  rfqId: string,
  quotationId: string,
  token: string,
  body: Record<string, unknown> = {},
) {
  return call(app, "POST", `/api/rfqs/${rfqId}/quotations/${quotationId}/award`, {
    token,
    body,
  });
}

// ---------------------------------------------------------------------------
// The award journey
// ---------------------------------------------------------------------------

describe("award (brief 6.7, M7)", () => {
  it("walks the done-when sentence: Selected, others Not Awarded, crane booked, RFQ closed, vendors emailed", async () => {
    const { rfq, quoteA } = await quotedRfq();

    const res = await award(rfq.id, quoteA.quotationId, ctx.adminToken);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      awarded: true,
      quotationId: quoteA.quotationId,
      notAwardedCount: 1,
      partial: false,
      quantity: 1,
      awardedCount: 1,
      rfqClosed: true,
    });
    expect(res.body.result.reservationId).toBeTruthy();

    const detail = await call(app, "GET", `/api/rfqs/${rfq.id}`, {
      token: ctx.adminToken,
    });
    expect(detail.body.rfq.status).toBe("CLOSED");

    // The commitment is a reservation, and the award marks the winning crane
    // Engaged with its availability date moved to the end of the booking.
    const reservation = await appPrisma.reservation.findFirstOrThrow({
      where: { craneId: ctx.a.craneId, quotationId: quoteA.quotationId },
      select: { type: true, status: true, startDate: true, endDate: true, rfqId: true },
    });
    expect(reservation).toMatchObject({ type: "BOOKED", status: "ACTIVE", rfqId: rfq.id });

    const craneA = await appPrisma.crane.findUnique({
      where: { id: ctx.a.craneId },
      select: { currentStatus: true, availableFrom: true, updatedOnBehalf: true },
    });
    expect(craneA?.currentStatus).toBe("ENGAGED");
    expect(craneA?.availableFrom?.toISOString()).toBe(
      reservation.endDate.toISOString(),
    );
    expect(craneA?.updatedOnBehalf).toBe(true);

    const logs = await appPrisma.emailLog.findMany({
      where: { template: { in: ["quotation_awarded", "quotation_not_awarded"] } },
      select: { toEmail: true, template: true },
    });
    expect(
      logs.map((log) => [log.toEmail, log.template] as const).sort(),
    ).toEqual(
      (
        [
          [VENDOR_USERS.a, "quotation_awarded"],
          [VENDOR_USERS.b, "quotation_not_awarded"],
        ] as Array<[string, string]>
      ).sort(),
    );
    // The award added two sends after the six the dispatch and submissions
    // produced: one winning, one losing.
    const awardMails = sentMail.filter(
      (mail) =>
        mail.subject?.includes("awarded") ||
        mail.subject?.includes("Update on your quotation"),
    );
    expect(awardMails.map((mail) => mail.to).sort()).toEqual(
      [VENDOR_USERS.a, VENDOR_USERS.b].sort(),
    );
    expect(awardMails).toHaveLength(2);
  });

  it("shows the vendor Awarded, not the internal SELECTED, and locks the RFQ", async () => {
    const { rfq, quoteA } = await quotedRfq();
    await award(rfq.id, quoteA.quotationId, ctx.adminToken);

    const detail = await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenA,
    });
    expect(detail.status).toBe(200);
    const awarded = detail.body.quotations.find(
      (q: { quotationId: string }) => q.quotationId === quoteA.quotationId,
    );
    expect(awarded.status).toBe("AWARDED");
    expect(awarded.editable).toBe(false);
    expect(detail.body.rfq.locked).toBe(true);
  });

  it("refuses revising and withdrawing after the award", async () => {
    const { rfq, quoteA, quoteB } = await quotedRfq();
    await award(rfq.id, quoteA.quotationId, ctx.adminToken);

    const revise = await reviseQuote(quoteB.quotationId, ctx.vendorTokenB, 70_000);
    expect(revise.status).toBe(409);

    const withdraw = await withdrawQuote(quoteB.quotationId, ctx.vendorTokenB);
    expect(withdraw.status).toBe(409);
  });

  it("refuses a second award on a closed RFQ", async () => {
    const { rfq, quoteA, quoteB } = await quotedRfq();
    expect((await award(rfq.id, quoteA.quotationId, ctx.adminToken)).status).toBe(
      200,
    );
    expect((await award(rfq.id, quoteB.quotationId, ctx.adminToken)).status).toBe(
      409,
    );
  });

  it("refuses awarding a superseded or withdrawn quotation, and keeps withdrawn as withdrawn", async () => {
    const { rfq, quoteA, quoteB } = await quotedRfq();

    // Vendor B revises, so their v1 becomes superseded. Only the latest wins.
    const revise = await reviseQuote(quoteB.quotationId, ctx.vendorTokenB, 70_000);
    expect(revise.status).toBe(201);
    expect((await award(rfq.id, quoteB.quotationId, ctx.adminToken)).status).toBe(
      409,
    );

    // Vendor A withdraws; a pulled quotation is not a rival offer, so awarding
    // anyone else must not rewrite it into "not awarded" — vendor A knows they
    // withdrew, and the audit trail already has the reason.
    expect((await withdrawQuote(quoteA.quotationId, ctx.vendorTokenA)).status).toBe(
      200,
    );
    expect((await award(rfq.id, quoteA.quotationId, ctx.adminToken)).status).toBe(
      409,
    );

    const statuses = await appPrisma.quotation.findMany({
      where: { rfqId: rfq.id },
      select: { id: true, status: true },
    });
    const byId = Object.fromEntries(
      statuses.map((s) => [s.id, s.status] as const),
    );
    expect(byId[quoteA.quotationId]).toBe("WITHDRAWN");
  });

  it("refuses awarding when the crane has been deactivated", async () => {
    const { rfq, quoteA } = await quotedRfq();
    const deactivate = await call(
      app,
      "POST",
      `/api/cranes/${ctx.a.craneId}/deactivate`,
      { token: ctx.vendorTokenA, body: {} },
    );
    expect(deactivate.status).toBe(200);
    expect((await award(rfq.id, quoteA.quotationId, ctx.adminToken)).status).toBe(
      409,
    );
  });

  it("lets sales award (the CR path) but refuses a vendor", async () => {
    const { rfq, quoteA } = await quotedRfq();

    // A vendor holds no internal capability, so the route never reaches the
    // handler and nothing is written.
    expect(
      (await award(rfq.id, quoteA.quotationId, ctx.vendorTokenA)).status,
    ).toBe(403);
    const quotation = await appPrisma.quotation.findUnique({
      where: { id: quoteA.quotationId },
      select: { status: true },
    });
    expect(quotation?.status).toBe("SUBMITTED");
    const craneA = await appPrisma.crane.findUnique({
      where: { id: ctx.a.craneId },
      select: { currentStatus: true },
    });
    expect(craneA?.currentStatus).toBe("AVAILABLE");

    // P3: the comparison screen's award is a sales action; admin is the override.
    const bySales = await award(rfq.id, quoteA.quotationId, ctx.salesToken);
    expect(bySales.status, JSON.stringify(bySales.body)).toBe(200);
  });

  it("logs an audit entry for the award", async () => {
    const { rfq, quoteA } = await quotedRfq();
    await award(rfq.id, quoteA.quotationId, ctx.adminToken);

    const audit = await appPrisma.auditLog.findFirstOrThrow({
      where: {
        entity: "quotation",
        entityId: quoteA.quotationId,
        action: "award",
      },
    });
    expect(audit.actorName).toBe(INTERNAL_USERS.admin);
  });

  it("dates the reservation from the RFQ's start and duration", async () => {
    const { rfq, quoteA } = await quotedRfq();
    await award(rfq.id, quoteA.quotationId, ctx.adminToken);

    const rfqRow = await appPrisma.rfq.findUniqueOrThrow({
      where: { id: rfq.id },
      select: { requiredStartDate: true },
    });
    const start = new Date(
      Date.UTC(
        rfqRow.requiredStartDate.getUTCFullYear(),
        rfqRow.requiredStartDate.getUTCMonth(),
        rfqRow.requiredStartDate.getUTCDate(),
      ),
    );
    // Four months at the calendar basis is 120 days, the end date included.
    const end = new Date(start.getTime() + 119 * 86_400_000);

    const reservation = await appPrisma.reservation.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(reservation.startDate.toISOString()).toBe(start.toISOString());
    expect(reservation.endDate.toISOString()).toBe(end.toISOString());
  });

  it("keeps other quotations open until a quantity-2 RFQ is fully awarded", async () => {
    const { rfq, quoteA, quoteB } = await quotedRfq({ quantity: 2 });

    const first = await award(rfq.id, quoteA.quotationId, ctx.adminToken);
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({
      partial: true,
      quantity: 2,
      awardedCount: 1,
      rfqClosed: false,
      notifiedNotAwarded: 0,
    });

    // The RFQ stays open and the other quotation is untouched, so the second
    // crane can still be selected.
    const detail = await call(app, "GET", `/api/rfqs/${rfq.id}`, {
      token: ctx.adminToken,
    });
    expect(detail.body.rfq.status).toBe("SENT");
    const rival = await appPrisma.quotation.findUniqueOrThrow({
      where: { id: quoteB.quotationId },
      select: { status: true },
    });
    expect(rival.status).toBe("SUBMITTED");

    const second = await award(rfq.id, quoteB.quotationId, ctx.adminToken);
    expect(second.status).toBe(200);
    expect(second.body.result).toMatchObject({
      partial: false,
      awardedCount: 2,
      rfqClosed: true,
    });

    const closed = await call(app, "GET", `/api/rfqs/${rfq.id}`, {
      token: ctx.adminToken,
    });
    expect(closed.body.rfq.status).toBe("CLOSED");
    expect(await appPrisma.reservation.count()).toBe(2);
  });

  it("refuses a crane already reserved for an overlapping period", async () => {
    const { rfq, quoteA } = await quotedRfq();
    const rfqRow = await appPrisma.rfq.findUniqueOrThrow({
      where: { id: rfq.id },
      select: { requiredStartDate: true },
    });
    await appPrisma.reservation.create({
      data: {
        craneId: ctx.a.craneId,
        startDate: new Date(rfqRow.requiredStartDate.getTime() - 5 * 86_400_000),
        endDate: new Date(rfqRow.requiredStartDate.getTime() + 5 * 86_400_000),
        type: "BLOCKED",
        status: "ACTIVE",
      },
    });

    const res = await award(rfq.id, quoteA.quotationId, ctx.adminToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/reserved/i);
  });

  it("refuses awarding a crane that is under maintenance", async () => {
    const { rfq, quoteA } = await quotedRfq();
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { currentStatus: "UNDER_MAINTENANCE" },
    });

    const res = await award(rfq.id, quoteA.quotationId, ctx.adminToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/maintenance/i);
  });

  it("requires explicit dates when the RFQ's start date is TBC", async () => {
    const { rfq, quoteA } = await quotedRfq({ startDateTbc: true });

    const missing = await award(rfq.id, quoteA.quotationId, ctx.adminToken);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/to be confirmed/i);

    const dated = await award(rfq.id, quoteA.quotationId, ctx.adminToken, {
      startDate: "2026-03-01",
      endDate: "2026-03-05",
    });
    expect(dated.status).toBe(200);

    const reservation = await appPrisma.reservation.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(reservation.startDate.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(reservation.endDate.toISOString()).toBe("2026-03-05T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Vendor dashboard (brief 7.5)
// ---------------------------------------------------------------------------

describe("vendor dashboard (brief 7.5, M7)", () => {
  it("counts the fleet, the bookings and the quotations for the winner only", async () => {
    const { rfq, quoteA } = await quotedRfq();
    await award(rfq.id, quoteA.quotationId, ctx.adminToken);

    const dashboardA = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.vendorTokenA,
    });
    expect(dashboardA.status).toBe(200);
    expect(dashboardA.body.fleet.totalCranes).toBe(1);
    // The award marked the winning crane Engaged; the overlapping reservation
    // still derives the Booked badge on top of that stored status.
    expect(dashboardA.body.fleet.byStatus).toEqual({ ENGAGED: 1 });
    expect(dashboardA.body.fleet.bookings.count).toBe(1);
    expect(dashboardA.body.fleet.bookings.cranes[0].craneId).toBe(ctx.a.craneId);
    expect(dashboardA.body.fleet.bookings.cranes[0].currentStatus).toBe("BOOKED");
    expect(dashboardA.body.quotations).toMatchObject({
      submittedCount: 1,
      awardedCount: 1,
      notAwardedCount: 0,
    });

    // The other vendor sees the outcome on their side, and no bookings.
    const dashboardB = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.vendorTokenB,
    });
    expect(dashboardB.body.quotations).toMatchObject({
      awardedCount: 0,
      notAwardedCount: 1,
    });
    expect(dashboardB.body.fleet.bookings.count).toBe(0);
    expect(dashboardB.body.fleet.byStatus).toEqual({ AVAILABLE: 1 });
  });

  it("lists cranes past the due-for-update window, scoped to the vendor", async () => {
    await quotedRfq();
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { statusUpdatedAt: new Date(Date.now() - 40 * 86_400_000) },
    });

    const dashboard = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.vendorTokenA,
    });
    expect(dashboard.body.fleet.dueForUpdate).toHaveLength(1);
    expect(dashboard.body.fleet.dueForUpdate[0].craneId).toBe(ctx.a.craneId);
    expect(dashboard.body.fleet.dueForUpdate[0].daysSinceUpdate).toBe(40);

    const dashboardB = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.vendorTokenB,
    });
    expect(dashboardB.body.fleet.dueForUpdate).toHaveLength(0);
  });

  it("flags an Engaged crane whose availability date has lapsed (brief B3)", async () => {
    // Fresh status, but the release date said "free from yesterday".
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: {
        currentStatus: "ENGAGED",
        availableFrom: new Date(Date.now() - 86_400_000),
        statusUpdatedAt: new Date(),
      },
    });

    const dashboard = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.vendorTokenA,
    });
    const row = dashboard.body.fleet.dueForUpdate.find(
      (c: { craneId: string }) => c.craneId === ctx.a.craneId,
    );
    expect(row).toBeTruthy();
    expect(row.availableFromLapsed).toBe(true);

    // A future date is not lapsed, and a fresh crane is not due.
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { availableFrom: inDays(5) },
    });
    const after = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.vendorTokenA,
    });
    expect(after.body.fleet.dueForUpdate).toHaveLength(0);
  });

  it("lists only RFQs still awaiting my response, soonest deadline first", async () => {
    // Already quoted by vendor A: it is tracked under "quotations submitted",
    // so it must not appear here even though the RFQ is still open.
    await quotedRfq();

    const later = await createRfq({
      submissionDeadline: inDays(9).toISOString(),
      enquiryNo: "SP/2026/0002",
    });
    const earlierRfq = await createRfq({
      submissionDeadline: inDays(2).toISOString(),
      enquiryNo: "SP/2026/0001",
    });
    await sendRfq(later.id, [ctx.a.vendorId]);
    await sendRfq(earlierRfq.id, [ctx.a.vendorId]);
    await appPrisma.rfqVendorRecipient.updateMany({
      where: { rfqId: { in: [later.id, earlierRfq.id] } },
      data: { responseStatus: "PENDING" },
    });

    const dashboard = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.vendorTokenA,
    });
    const awaiting = dashboard.body.rfqs.awaitingResponse as Array<{
      rfqId: string;
      deadline: string;
      responseStatus: string;
    }>;
    expect(awaiting).toHaveLength(2);
    expect(awaiting[0].rfqId).toBe(earlierRfq.id);
    expect(awaiting[1].rfqId).toBe(later.id);
    expect(awaiting.every((row) => row.responseStatus === "PENDING")).toBe(true);
    expect(dashboard.body.rfqs.awaitingResponseCount).toBe(2);
  });

  it("is vendor-only", async () => {
    const admin = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.adminToken,
    });
    expect(admin.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Finalising the RFQ for the vendors who did not quote
// ---------------------------------------------------------------------------

/**
 * "Awaiting your quote" is a to-do, not a fact that survives an award.
 *
 * When a closing award finalises the RFQ, a vendor who never quoted has no
 * quotation row to carry the outcome — so the recipient row is the only place
 * the truth can live. Left Pending, the row would keep asking for a quote the
 * server would refuse, and stay in the vendor's to-do list for ever.
 */
describe("finalising an RFQ (recipient outcome)", () => {
  async function recipientOf(rfqId: string, vendorId: string) {
    return appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId, vendorId },
      select: { responseStatus: true, respondedAt: true },
    });
  }

  it("moves a vendor who never quoted to Finalised when another vendor wins", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);
    await giveLoadCharts();
    const quoteA = await submitQuote(rfq.id, ctx.a, 50_000, ctx.vendorTokenA);

    const res = await award(rfq.id, quoteA.quotationId, ctx.adminToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.rfqClosed).toBe(true);

    // The winner keeps Quoted — they answered. Only the silent vendor moves.
    expect((await recipientOf(rfq.id, ctx.a.vendorId)).responseStatus).toBe("QUOTED");
    expect((await recipientOf(rfq.id, ctx.b.vendorId)).responseStatus).toBe("FINALISED");

    // It leaves the "Awaiting your quote" tab and appears under Finalised.
    const pending = await call(app, "GET", "/api/vendor/rfqs?responseStatus=PENDING", {
      token: ctx.vendorTokenB,
    });
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    expect(pending.body.rfqs).toHaveLength(0);

    const finalised = await call(
      app,
      "GET",
      "/api/vendor/rfqs?responseStatus=FINALISED",
      { token: ctx.vendorTokenB },
    );
    expect(finalised.status, JSON.stringify(finalised.body)).toBe(200);
    expect(finalised.body.rfqs).toHaveLength(1);
    expect(finalised.body.rfqs[0]).toMatchObject({
      rfqId: rfq.id,
      responseStatus: "FINALISED",
      canRespond: false,
    });

    // The detail screen agrees, and says nothing about who won.
    const detail = await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenB,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.rfq.locked).toBe(true);
    expect(detail.body.response).toMatchObject({
      responseStatus: "FINALISED",
      canRespond: false,
    });
    // Never another vendor's data — not even the name of who won.
    const winner = await appPrisma.vendor.findUniqueOrThrow({
      where: { id: ctx.a.vendorId },
      select: { name: true },
    });
    expect(JSON.stringify(detail.body)).not.toContain(winner.name);

    // And the vendor dashboard stops counting it as awaiting a response.
    const dashboard = await call(app, "GET", "/api/vendor/dashboard", {
      token: ctx.vendorTokenB,
    });
    expect(dashboard.status, JSON.stringify(dashboard.body)).toBe(200);
    expect(dashboard.body.rfqs.awaitingResponseCount).toBe(0);
    expect(dashboard.body.rfqs.awaitingResponse).toHaveLength(0);
  });

  it("leaves the other vendors waiting while a quantity-2 award is still partial", async () => {
    // Only A quotes; B has not answered. A partial award must not tell B the
    // RFQ is over — the second crane is still wanted, so B can still quote.
    const rfq = await createRfq({ quantity: 2 });
    await sendRfq(rfq.id, [ctx.a.vendorId, ctx.b.vendorId]);
    await giveLoadCharts();
    const quoteA = await submitQuote(rfq.id, ctx.a, 50_000, ctx.vendorTokenA);

    const first = await award(rfq.id, quoteA.quotationId, ctx.adminToken);
    expect(first.status).toBe(200);
    expect(first.body.result.rfqClosed).toBe(false);

    expect((await recipientOf(rfq.id, ctx.b.vendorId)).responseStatus).toBe("PENDING");

    const detail = await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenB,
    });
    expect(detail.body.response).toMatchObject({
      responseStatus: "PENDING",
      canRespond: true,
    });
  });

  it("keeps a vendor who quoted on Quoted, with the quotation Not Awarded", async () => {
    const { rfq, quoteA, quoteB } = await quotedRfq();
    await award(rfq.id, quoteA.quotationId, ctx.adminToken);

    expect((await recipientOf(rfq.id, ctx.b.vendorId)).responseStatus).toBe("QUOTED");

    const quotation = await appPrisma.quotation.findUniqueOrThrow({
      where: { id: quoteB.quotationId },
      select: { status: true },
    });
    expect(quotation.status).toBe("NOT_AWARDED");

    // The losing vendor reads "Not selected" on the quote, not on the RFQ row.
    const detail = await call(app, "GET", `/api/vendor/rfqs/${rfq.id}`, {
      token: ctx.vendorTokenB,
    });
    const losing = detail.body.quotations.find(
      (q: { quotationId: string }) => q.quotationId === quoteB.quotationId,
    );
    expect(losing.status).toBe("NOT_AWARDED");
  });
});

// ---------------------------------------------------------------------------
// Stale-fleet reminders (brief 6.5)
// ---------------------------------------------------------------------------

describe("stale fleet reminders (brief 6.5, M7)", () => {
  let sendStaleReminders: Awaited<
    ReturnType<typeof importStaleService>
  >["sendStaleReminders"];

  function importStaleService() {
    return import("../services/staleFleet.service");
  }

  beforeAll(async () => {
    sendStaleReminders = (await importStaleService()).sendStaleReminders;
  });

  it("reminds once per crane inside the repeat window, then again after it passes", async () => {
    await giveLoadCharts();
    await appPrisma.crane.update({
      where: { id: ctx.a.craneId },
      data: { statusUpdatedAt: new Date(Date.now() - 40 * 86_400_000) },
    });

    const first = await sendStaleReminders();
    expect(first).toMatchObject({
      due: 1,
      sent: 1,
      skippedRecentlyReminded: 0,
    });
    expect(sentMail.map((mail) => mail.to)).toEqual([VENDOR_USERS.a]);

    const second = await sendStaleReminders();
    expect(second).toMatchObject({ due: 1, sent: 0, skippedRecentlyReminded: 1 });

    // Backdate the log row past the 7-day repeat window: the vendor has gone
    // another cycle without confirming, so they are chased again.
    const log = await appPrisma.emailLog.findFirstOrThrow({
      where: { template: "fleet_update_reminder" },
    });
    await appPrisma.emailLog.update({
      where: { id: log.id },
      data: { createdAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    const third = await sendStaleReminders();
    expect(third.sent).toBe(1);
  });

  it("does not chase a crane inside the due window", async () => {
    const run = await sendStaleReminders();
    expect(run).toEqual({ due: 0, sent: 0, skippedRecentlyReminded: 0 });
    expect(sentMail).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RFQ pre-deadline reminders and expiry (brief 6.7)
// ---------------------------------------------------------------------------

describe("rfq automatic reminders and expiry (brief 6.7, M7)", () => {
  let runAutomaticRfqReminders: (typeof import(
    "../services/rfq.service"
  ))["runAutomaticRfqReminders"];
  let expireOverdueRecipients: (typeof import(
    "../services/rfq.service"
  ))["expireOverdueRecipients"];

  beforeAll(async () => {
    const service = await import("../services/rfq.service");
    runAutomaticRfqReminders = service.runAutomaticRfqReminders;
    expireOverdueRecipients = service.expireOverdueRecipients;
  });

  it("reminds a pending recipient inside the lead window once", async () => {
    const rfq = await createRfq({ submissionDeadline: inHours(2).toISOString() });
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    // A realistic window: the RFQ went out days ago, so the reminder lead is
    // the configured 24h rather than half of a two-hour window.
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { sentAt: new Date(Date.now() - 5 * 86_400_000) },
    });
    sentMail.length = 0; // the invitation is not under test here

    const first = await runAutomaticRfqReminders();
    expect(first).toMatchObject({ reminded: 1, sent: 1 });
    expect(sentMail.map((mail) => mail.to)).toEqual([VENDOR_USERS.a]);

    const recipient = await appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(recipient.reminderCount).toBe(1);

    // A second run minutes later is quiet: the chase is fresh.
    const second = await runAutomaticRfqReminders();
    expect(second.reminded).toBe(0);
    expect(sentMail).toHaveLength(1);
  });

  it("fires at half the response window when that is shorter than the lead (brief C2)", async () => {
    const rfq = await createRfq({ submissionDeadline: inHours(6).toISOString() });
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    // Sent four hours ago, deadline in six: a ten-hour window, so the reminder
    // waits until five hours before the deadline (half), not the full 24h lead.
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { sentAt: new Date(Date.now() - 4 * 3_600_000) },
    });
    sentMail.length = 0;

    // An hour before the half-window point: too early to chase.
    const early = await runAutomaticRfqReminders(new Date(Date.now()));
    expect(early.reminded).toBe(0);

    // Two hours later, the last half of the window has begun.
    const later = await runAutomaticRfqReminders(new Date(Date.now() + 2 * 3_600_000));
    expect(later).toMatchObject({ reminded: 1, sent: 1 });
  });

  it("never chases a window shorter than the configured minimum (brief C2)", async () => {
    const rfq = await createRfq({ submissionDeadline: inHours(1).toISOString() });
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    // Sent an hour ago with an hour left: a two-hour window, under the default
    // four-hour minimum, so there is no room to act on a nudge.
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { sentAt: new Date(Date.now() - 3_600_000) },
    });
    sentMail.length = 0;

    const run = await runAutomaticRfqReminders();
    expect(run.reminded).toBe(0);
    expect(sentMail).toHaveLength(0);
  });

  it("ignores deadlines outside the lead window", async () => {
    const rfq = await createRfq({ submissionDeadline: inDays(6).toISOString() });
    await sendRfq(rfq.id, [ctx.a.vendorId]);
    sentMail.length = 0;

    const run = await runAutomaticRfqReminders();
    expect(run.reminded).toBe(0);
    expect(sentMail).toHaveLength(0);
  });

  it("ignores recipients who have already quoted", async () => {
    const { rfq } = await quotedRfq();
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: inHours(2).toISOString() },
    });
    sentMail.length = 0;

    const run = await runAutomaticRfqReminders();
    expect(run.reminded).toBe(0);
    expect(sentMail).toHaveLength(0);
  });

  it("expires pending recipients past the deadline", async () => {
    const rfq = await createRfq();
    await sendRfq(rfq.id, [ctx.a.vendorId]);

    // Drafts and sends require a future deadline, so the sweep's input has to be
    // produced by moving a sent RFQ's deadline into the past directly.
    await appPrisma.rfq.update({
      where: { id: rfq.id },
      data: { submissionDeadline: new Date(Date.now() - 3_600_000) },
    });

    const expired = await expireOverdueRecipients();
    expect(expired).toBe(1);

    const recipient = await appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId: rfq.id },
    });
    expect(recipient.responseStatus).toBe("EXPIRED");
  });
});
