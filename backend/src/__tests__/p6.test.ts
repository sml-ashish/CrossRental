import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { INTERNAL_USERS } from "./fixtures";

/**
 * P6: WhatsApp/email reply capture, the validation queue and communication
 * history. External providers are never called: the outbound mailer is mocked,
 * WhatsApp dispatch is asserted at the configuration gate, and inbound
 * messages enter through the same service the webhook/IMAP poller calls.
 */

vi.mock("../lib/mailer", () => ({
  sendMail: vi.fn(async () => ({ sent: true })),
}));

let app: Express;
let ingestInboundMessage: typeof import("../services/inbound.service").ingestInboundMessage;
let parseReply: typeof import("../services/replyParser.service").parseReply;
let MessageChannel: typeof import("../generated/prisma/client").MessageChannel;

beforeAll(async () => {
  useTestDatabase();
  const { createApp } = await import("../index");
  app = createApp();
  const inbound = await import("../services/inbound.service");
  ingestInboundMessage = inbound.ingestInboundMessage;
  const parser = await import("../services/replyParser.service");
  parseReply = parser.parseReply;
  const enums = await import("../generated/prisma/client");
  MessageChannel = enums.MessageChannel;
});

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await disconnectTestDatabases();
  await clearTestUploads();
});

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

interface Ctx {
  adminToken: string;
  salesToken: string;
  vendorId: string;
  vendorEmail: string;
  craneId: string;
  craneSerial: string;
}

async function makeContext(): Promise<Ctx> {
  const fixtures = await seedIsolationFixtures();
  return {
    adminToken: await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user"),
    salesToken: await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user"),
    vendorId: fixtures.vendorA.vendorId,
    vendorEmail: fixtures.vendorA.email,
    craneId: fixtures.vendorA.craneId,
    craneSerial: fixtures.vendorA.craneSerial,
  };
}

async function createDispatchedRfq(ctx: Ctx): Promise<{ id: string; rfqNumber: string }> {
  const created = await call(app, "POST", "/api/rfqs", {
    token: ctx.salesToken,
    body: {
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
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const rfq = created.body.rfq as { id: string; rfqNumber: string };

  const sent = await call(app, "POST", `/api/rfqs/${rfq.id}/send`, {
    token: ctx.salesToken,
    body: { vendorIds: [ctx.vendorId] },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return rfq;
}

function completeReply(): string {
  return [
    "Rate: 5000 per day",
    "Availability: yes",
    "Validity: 15/11/2026",
    "We accept the commercial terms.",
    "Remarks: crane can mobilise within two days.",
  ].join("\n");
}

describe("reply parser", () => {
  it("reads rates, availability, dates and acceptance from ordinary prose", () => {
    const parsed = parseReply(completeReply());
    expect(parsed.rentalRate).toBe(5000);
    expect(parsed.rateBasis).toBe("PER_DAY");
    expect(parsed.availabilityConfirmed).toBe(true);
    expect(parsed.validityDate?.toISOString().slice(0, 10)).toBe("2026-11-15");
    expect(parsed.acceptsCommercialTerms).toBe(true);
  });

  it("does not invent a rate that was never stated", () => {
    const parsed = parseReply("We can offer this crane. Please confirm.");
    expect(parsed.rentalRate).toBeNull();
    expect(parsed.validityDate).toBeNull();
  });
});

describe("P6 inbound capture", () => {
  it("auto-converts a complete email reply and records the source", async () => {
    const ctx = await makeContext();
    const rfq = await createDispatchedRfq(ctx);

    const result = await ingestInboundMessage({
      channel: MessageChannel.EMAIL,
      fromAddress: ctx.vendorEmail,
      subject: `Re: ${rfq.rfqNumber}`,
      bodyText: completeReply(),
      receivedAt: new Date(),
      providerMessageId: "<p6-auto@isolation.test>",
    });
    expect(result.status).toBe("CONVERTED");
    expect(result.quotationId).toBeTruthy();

    const quotation = await appPrisma.quotation.findUnique({
      where: { id: result.quotationId! },
      select: { source: true, rentalRate: true, rfqId: true, vendorId: true },
    });
    expect(quotation?.source).toBe("EMAIL");
    expect(Number(quotation?.rentalRate)).toBe(5000);
    expect(quotation?.rfqId).toBe(rfq.id);
    expect(quotation?.vendorId).toBe(ctx.vendorId);

    const history = await call(app, "GET", `/api/communications?rfqId=${rfq.id}`, {
      token: ctx.adminToken,
    });
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(
      history.body.history.messages.some(
        (message: { direction: string; channel: string }) =>
          message.direction === "INBOUND" && message.channel === "EMAIL",
      ),
    ).toBe(true);
  });

  it("does not create a second queue row when the same provider message is replayed", async () => {
    const ctx = await makeContext();
    const rfq = await createDispatchedRfq(ctx);

    const input = {
      channel: MessageChannel.EMAIL,
      fromAddress: ctx.vendorEmail,
      subject: `Re: ${rfq.rfqNumber}`,
      bodyText: "Need to discuss the rate.",
      receivedAt: new Date(),
      providerMessageId: "<p6-duplicate@isolation.test>",
    };
    const first = await ingestInboundMessage(input);
    const second = await ingestInboundMessage(input);
    expect(first.status).toBe("PENDING");
    expect(second.duplicate).toBe(true);
    expect(await appPrisma.inboundReply.count()).toBe(1);
  });

  it("captures a WhatsApp reply against the recipient's stored number", async () => {
    const ctx = await makeContext();
    const rfq = await createDispatchedRfq(ctx);

    const recipient = await appPrisma.rfqVendorRecipient.findFirstOrThrow({
      where: { rfqId: rfq.id, vendorId: ctx.vendorId },
      select: { whatsappPhones: true },
    });
    expect(recipient.whatsappPhones.length).toBeGreaterThan(0);

    const result = await ingestInboundMessage({
      channel: MessageChannel.WHATSAPP,
      fromAddress: recipient.whatsappPhones[0]!,
      subject: null,
      bodyText: completeReply(),
      receivedAt: new Date(),
      providerMessageId: "wamid.p6-auto-1",
    });
    expect(result.status).toBe("CONVERTED");

    const quotation = await appPrisma.quotation.findUnique({
      where: { id: result.quotationId! },
      select: { source: true },
    });
    expect(quotation?.source).toBe("WHATSAPP");
  });

  it("queues an incomplete reply, alerts admins, and converts after an admin fills the gaps", async () => {
    const ctx = await makeContext();
    const rfq = await createDispatchedRfq(ctx);

    const result = await ingestInboundMessage({
      channel: MessageChannel.EMAIL,
      fromAddress: ctx.vendorEmail,
      subject: `Re: ${rfq.rfqNumber}`,
      bodyText: "Rate 4500. Please call me.",
      receivedAt: new Date(),
      providerMessageId: "<p6-queue@isolation.test>",
    });
    expect(result.status).toBe("PENDING");

    const dashboard = await call(app, "GET", "/api/admin/dashboard", {
      token: ctx.adminToken,
    });
    expect(dashboard.status, JSON.stringify(dashboard.body)).toBe(200);
    expect(dashboard.body.dashboard.counts.unmatchedQuotationResponses).toBe(1);
    expect(
      dashboard.body.dashboard.alerts.some(
        (alert: { kind: string }) => alert.kind === "UNMATCHED_QUOTATION",
      ),
    ).toBe(true);

    const queue = await call(app, "GET", "/api/admin/replies?status=PENDING", {
      token: ctx.adminToken,
    });
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect(queue.body.pendingCount).toBe(1);

    const converted = await call(
      app,
      "POST",
      `/api/admin/replies/${result.replyId}/convert`,
      {
        token: ctx.adminToken,
        body: {
          craneId: ctx.craneId,
          parsedRentalRate: 4500,
          parsedRateBasis: "PER_DAY",
          parsedAvailability: true,
          parsedValidityDate: inDays(20).toISOString(),
          parsedAcceptsTerms: true,
        },
      },
    );
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect(converted.body.quotationId).toBeTruthy();

    const reply = await appPrisma.inboundReply.findUnique({
      where: { id: result.replyId! },
      select: { status: true, convertedQuotationId: true, reviewedById: true },
    });
    expect(reply?.status).toBe("CONVERTED");
    expect(reply?.convertedQuotationId).toBe(converted.body.quotationId);
    expect(reply?.reviewedById).toBeTruthy();
  });

  it("shows matched replies on the RFQ but keeps conversion in the admin queue", async () => {
    const ctx = await makeContext();
    const rfq = await createDispatchedRfq(ctx);

    const result = await ingestInboundMessage({
      channel: MessageChannel.EMAIL,
      fromAddress: ctx.vendorEmail,
      subject: `Re: ${rfq.rfqNumber}`,
      bodyText: "Rate 4500. Please call me.",
      receivedAt: new Date(),
      providerMessageId: "<p6-rfq-scope@isolation.test>",
    });
    expect(result.status).toBe("PENDING");

    const scoped = await call(app, "GET", `/api/rfqs/${rfq.id}/replies?status=PENDING`, {
      token: ctx.salesToken,
    });
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(scoped.body.pendingCount).toBe(1);
    expect(scoped.body.replies[0].id).toBe(result.replyId);
    expect(scoped.body.replies[0].bodyText).toContain("Rate 4500");

    const adminQueue = await call(app, "GET", "/api/admin/replies?status=PENDING", {
      token: ctx.adminToken,
    });
    expect(adminQueue.status, JSON.stringify(adminQueue.body)).toBe(200);
    expect(
      adminQueue.body.replies.some((reply: { id: string }) => reply.id === result.replyId),
    ).toBe(true);

    const refusedQueue = await call(app, "GET", "/api/admin/replies", {
      token: ctx.salesToken,
    });
    expect(refusedQueue.status).toBe(403);

    const refusedConvert = await call(
      app,
      "POST",
      `/api/rfqs/${rfq.id}/replies/${result.replyId}/convert`,
      {
        token: ctx.salesToken,
        body: {
          craneId: ctx.craneId,
          parsedRentalRate: 4500,
          parsedRateBasis: "PER_DAY",
          parsedAvailability: true,
          parsedValidityDate: inDays(20).toISOString(),
          parsedAcceptsTerms: true,
        },
      },
    );
    expect(refusedConvert.status).toBe(404);

    const converted = await call(
      app,
      "POST",
      `/api/admin/replies/${result.replyId}/convert`,
      {
        token: ctx.adminToken,
        body: {
          craneId: ctx.craneId,
          parsedRentalRate: 4500,
          parsedRateBasis: "PER_DAY",
          parsedAvailability: true,
          parsedValidityDate: inDays(20).toISOString(),
          parsedAcceptsTerms: true,
        },
      },
    );
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect(converted.body.quotationId).toBeTruthy();

    const reply = await appPrisma.inboundReply.findUnique({
      where: { id: result.replyId! },
      select: { status: true, convertedQuotationId: true, reviewedById: true },
    });
    expect(reply?.status).toBe("CONVERTED");
    expect(reply?.convertedQuotationId).toBe(converted.body.quotationId);
    expect(reply?.reviewedById).toBeTruthy();
  });

  it("keeps the queue admin-only and dismisses a reply with a note", async () => {
    const ctx = await makeContext();
    const rfq = await createDispatchedRfq(ctx);
    const result = await ingestInboundMessage({
      channel: MessageChannel.EMAIL,
      fromAddress: "stranger@example.test",
      subject: "Who is this?",
      bodyText: "Who is this?",
      receivedAt: new Date(),
      providerMessageId: "<p6-stranger@isolation.test>",
    });
    expect(result.status).toBe("PENDING");

    const refused = await call(app, "GET", "/api/admin/replies", {
      token: ctx.salesToken,
    });
    expect(refused.status).toBe(403);

    const dismissed = await call(
      app,
      "POST",
      `/api/admin/replies/${result.replyId}/dismiss`,
      { token: ctx.adminToken, body: { note: "Not a quotation" } },
    );
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    expect(dismissed.body.reply.status).toBe("DISMISSED");
    expect(dismissed.body.reply.reviewNote).toBe("Not a quotation");
  });

  it("refuses WhatsApp dispatch when the provider is not configured", async () => {
    const ctx = await makeContext();
    const created = await call(app, "POST", "/api/rfqs", {
      token: ctx.salesToken,
      body: {
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
      },
    });
    const rfq = created.body.rfq as { id: string };
    const sent = await call(app, "POST", `/api/rfqs/${rfq.id}/send`, {
      token: ctx.salesToken,
      body: { vendorIds: [ctx.vendorId], channels: ["WHATSAPP"] },
    });
    expect(sent.status).toBe(409);
    expect(await appPrisma.rfqVendorRecipient.count()).toBe(0);
  });
});
