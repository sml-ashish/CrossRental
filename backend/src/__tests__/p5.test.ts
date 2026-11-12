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
 * P5: role dashboards, reports, alerts, configuration and SSO status.
 *
 * The management viewer is read-only by construction: the role holds
 * `reports:view_all` and nothing else, so the management dashboard and reports
 * are the only surfaces it can reach. Sales reports are narrowed to enquiries
 * the sales user owns. The management responses never carry the customer name,
 * address or budget.
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
  adminToken: string;
  salesToken: string;
  managementToken: string;
  vendorToken: string;
  adminId: string;
  salesId: string;
  managementId: string;
}

async function signInVendor(email: string): Promise<string> {
  const res = await call(app, "POST", "/api/auth/login", {
    body: { email, password: "Vendor@Portal2026" },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token as string;
}

async function makeContext(): Promise<Ctx> {
  const fixtures = await seedIsolationFixtures();
  const management = await appPrisma.user.create({
    data: {
      email: "management@isolation.test",
      fullName: "Management Viewer",
      role: "management_viewer",
    },
    select: { id: true },
  });

  return {
    adminId: fixtures.adminId,
    salesId: fixtures.salesId,
    managementId: management.id,
    adminToken: await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user"),
    salesToken: await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user"),
    managementToken: await internalToken(
      management.id,
      "management@isolation.test",
      "management_viewer",
    ),
    vendorToken: await signInVendor("vendor-a@isolation.test"),
  };
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

function enquiryPayload() {
  return {
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
        applicationDescription: "Erection",
        loadDescription: "Steel columns",
        requiredStartDate: inDays(30).toISOString(),
        durationValue: 4,
        durationUnit: "MONTHS",
        rentalBudget: "Budget 9,00,000",
      },
    ],
  };
}

async function createEnquiry(token: string) {
  const res = await call(app, "POST", "/api/enquiries", {
    token,
    body: enquiryPayload(),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.enquiry as { id: string; enquiryNo: string };
}

describe("P5 management dashboard and reports", () => {
  it("gives management and admin the aggregate view, without customer data", async () => {
    const ctx = await makeContext();
    await createEnquiry(ctx.salesToken);

    for (const token of [ctx.managementToken, ctx.adminToken]) {
      const res = await call(app, "GET", "/api/management/dashboard", { token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.dashboard.metrics.enquiriesProcessed).toBe(1);
      expect(res.body.dashboard.metrics.linesProcessed).toBe(1);
      expect(res.body.dashboard.byRegion).toBeInstanceOf(Array);
      expect(res.body.dashboard.options.regions).toBeInstanceOf(Array);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain("Secret Customer Co");
      expect(body).not.toContain("17 Hidden Industrial Estate");
      expect(body).not.toContain("Budget 9,00,000");
      expect(body).not.toContain("Secret Sales Partner");
    }
  });

  it("refuses sales and vendors on the management dashboard", async () => {
    const ctx = await makeContext();

    const sales = await call(app, "GET", "/api/management/dashboard", {
      token: ctx.salesToken,
    });
    expect(sales.status).toBe(403);

    const vendor = await call(app, "GET", "/api/management/dashboard", {
      token: ctx.vendorToken,
    });
    expect(vendor.status).toBe(403);
  });

  it("gives the sales dashboard to sales and admin only", async () => {
    const ctx = await makeContext();
    await createEnquiry(ctx.salesToken);

    const sales = await call(app, "GET", "/api/dashboard/sales", { token: ctx.salesToken });
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
    expect(sales.body.dashboard.counts.newEnquiries).toBe(1);
    expect(sales.body.dashboard.alerts).toBeInstanceOf(Array);
    expect(sales.body.dashboard.thresholds.alertRfqSlaHours).toBe(48);

    const admin = await call(app, "GET", "/api/dashboard/sales", { token: ctx.adminToken });
    expect(admin.status).toBe(200);

    const management = await call(app, "GET", "/api/dashboard/sales", {
      token: ctx.managementToken,
    });
    expect(management.status).toBe(403);
  });

  it("scopes sales reports to their own enquiries", async () => {
    const ctx = await makeContext();
    await createEnquiry(ctx.salesToken);

    const otherSales = await appPrisma.user.create({
      data: { email: "other-sales@isolation.test", fullName: "Other", role: "sales_user" },
      select: { id: true },
    });
    const otherToken = await internalToken(
      otherSales.id,
      "other-sales@isolation.test",
      "sales_user",
    );

    const own = await call(app, "GET", "/api/reports?view=enquiry", { token: ctx.salesToken });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.report.rows).toHaveLength(1);
    expect(own.body.report.filters.ownerScoped).toBe(true);
    expect(own.body.report.rows[0].customerName).toBe("Secret Customer Co");

    const other = await call(app, "GET", "/api/reports?view=enquiry", { token: otherToken });
    expect(other.status).toBe(200);
    expect(other.body.report.rows).toHaveLength(0);

    const management = await call(app, "GET", "/api/reports?view=enquiry", {
      token: ctx.managementToken,
    });
    expect(management.status, JSON.stringify(management.body)).toBe(200);
    expect(management.body.report.rows).toHaveLength(1);
    expect(management.body.report.filters.ownerScoped).toBe(false);
  });

  it("exports the same rows as CSV", async () => {
    const ctx = await makeContext();
    const enquiry = await createEnquiry(ctx.salesToken);

    const res = await call(app, "GET", "/api/reports?view=line&format=csv", {
      token: ctx.adminToken,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("string");
    expect(res.body).toContain(enquiry.enquiryNo);
  });

  it("refuses vendors on reports", async () => {
    const ctx = await makeContext();
    const res = await call(app, "GET", "/api/reports", { token: ctx.vendorToken });
    expect(res.status).toBe(403);
  });
});

describe("P5 alerts and configuration", () => {
  it("returns alert items with a stable shape", async () => {
    const ctx = await makeContext();
    const res = await call(app, "GET", "/api/admin/dashboard", { token: ctx.adminToken });
    expect(res.status).toBe(200);
    expect(res.body.dashboard.alerts).toBeInstanceOf(Array);
    expect(res.body.dashboard.thresholds.alertRfqSlaHours).toBe(48);
    expect(res.body.dashboard.thresholds.alertQuotationExpiryDays).toBe(3);
    expect(res.body.dashboard.thresholds.alertBookingLeadDays).toBe(7);
    for (const alert of res.body.dashboard.alerts) {
      expect(alert).toHaveProperty("kind");
      expect(alert).toHaveProperty("severity");
      expect(alert).toHaveProperty("title");
    }
  });

  it("shows and updates alert settings and configuration, admin only", async () => {
    const ctx = await makeContext();

    const before = await call(app, "GET", "/api/settings", { token: ctx.adminToken });
    expect(before.status).toBe(200);
    expect(before.body.settings.alertRfqSlaHours).toBe(48);
    expect(before.body.settings.reportRetentionMonths).toBe(84);
    expect(before.body.settings.alertEmailsEnabled).toBe(false);

    const updated = await call(app, "PATCH", "/api/settings", {
      token: ctx.adminToken,
      body: { alertRfqSlaHours: 24, alertEmailsEnabled: true },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.settings.alertRfqSlaHours).toBe(24);
    expect(updated.body.settings.alertEmailsEnabled).toBe(true);

    for (const path of [
      "/api/settings/mobilisation-rates",
      "/api/settings/email-templates",
      "/api/settings/states",
    ]) {
      const admin = await call(app, "GET", path, { token: ctx.adminToken });
      expect(admin.status, path).toBe(200);
      const sales = await call(app, "GET", path, { token: ctx.salesToken });
      expect(sales.status, path).toBe(403);
      const management = await call(app, "GET", path, { token: ctx.managementToken });
      expect(management.status, path).toBe(403);
    }

    const state = await call(app, "PATCH", "/api/settings/states/GJ", {
      token: ctx.adminToken,
      body: { region: "West" },
    });
    expect(state.status, JSON.stringify(state.body)).toBe(200);
    expect(state.body.state.region).toBe("West");

    const templates = await call(app, "GET", "/api/settings/email-templates", {
      token: ctx.adminToken,
    });
    const template = templates.body.templates[0];
    const saved = await call(app, "PUT", `/api/settings/email-templates/${template.key}`, {
      token: ctx.adminToken,
      body: { subject: "Updated subject", bodyHtml: "<p>Updated</p>" },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.template.subject).toBe("Updated subject");
  });

  it("lets the admin create a management viewer who can sign in by OTP", async () => {
    const ctx = await makeContext();

    const created = await call(app, "POST", "/api/admin/users", {
      token: ctx.adminToken,
      body: {
        email: "viewer@isolation.test",
        fullName: "Viewer",
        role: "management_viewer",
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.user.role).toBe("management_viewer");

    const otp = await call(app, "POST", "/api/auth/otp/request", {
      body: { email: "viewer@isolation.test" },
    });
    expect(otp.status, JSON.stringify(otp.body)).toBe(200);
  });

  it("reports SSO as disabled until a provider is configured", async () => {
    await makeContext();
    const res = await call(app, "GET", "/api/auth/sso/status");
    expect(res.status).toBe(200);
    expect(res.body.sso.enabled).toBe(false);
  });
});
