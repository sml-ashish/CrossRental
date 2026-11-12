import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import {
  call,
  clearTestUploads,
  disconnectTestDatabases,
  internalToken,
  resetTestDatabase,
  seedIsolationFixtures,
  testPrisma,
  useTestDatabase,
} from "./harness";
import { INTERNAL_USERS } from "./fixtures";

/**
 * The invitation must survive a failed email.
 *
 * UAT showed the failure mode this covers: SMTP was misconfigured, the mail
 * did not go out, and the single-invite request failed with an error telling
 * the sender to "copy the link from the queue". That link cannot exist — the
 * token is stored hashed and never leaves the request that created it — so the
 * invitation became unusable even though the row was written.
 *
 * The fix is that a mail failure is reported, not thrown: the request returns
 * 201 with the raw token and `emailSent: false`, so the UI can show the link
 * for the sender to pass on by another channel.
 *
 * The console transport used by the tests reports every send as successful, so
 * `sendMail` is mocked to force a real delivery failure.
 */

const { mailState } = vi.hoisted(() => ({
  mailState: {
    fail: false,
    error: "connect ECONNREFUSED smtp.example.test:587",
  },
}));

vi.mock("../lib/mailer", () => ({
  sendMail: vi.fn(async () =>
    mailState.fail ? { sent: false, error: mailState.error } : { sent: true },
  ),
}));

let app: Express;
let adminToken: string;

beforeAll(async () => {
  useTestDatabase();
  const { createApp } = await import("../index");
  app = createApp();
});

beforeEach(async () => {
  mailState.fail = false;
  await resetTestDatabase();
  const fixtures = await seedIsolationFixtures();
  adminToken = await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user");
});

afterAll(async () => {
  await disconnectTestDatabases();
  await clearTestUploads();
});

async function invite(body: { name: string; email: string; contactNumber: string }) {
  return call(app, "POST", "/api/vendors/invitations", { token: adminToken, body });
}

describe("invitation email failure", () => {
  it("still returns a usable link when the email cannot be sent", async () => {
    mailState.fail = true;

    const res = await invite({
      name: "UAT Mail Failure Cranes",
      email: "mail.failure@onboarding.test",
      contactNumber: "9820011223",
    });

    // Not a 5xx: the invitation row exists and the sender must be able to
    // reach it, so the failure is data on a success response.
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.invitationId).toEqual(expect.any(String));
    expect(res.body.token).toEqual(expect.any(String));
    expect((res.body.token as string).length).toBeGreaterThan(20);
    expect(new Date(res.body.expiresAt as string).getTime()).toBeGreaterThan(Date.now());

    // The returned token is the real credential, not a placeholder.
    const view = await call(app, "GET", `/api/onboarding/invitation/${res.body.token as string}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.status).toBe("DRAFT");
    expect(view.body.canEdit).toBe(true);
    expect(view.body.prefill.companyName).toBe("UAT Mail Failure Cranes");
    expect(view.body.prefill.contactNumber).toBe("9820011223");

    // Operations can see the failure on the queue: the log row is FAILED.
    const log = await testPrisma.emailLog.findFirst({
      where: { entity: "vendor_invitation", entityId: res.body.invitationId as string },
      select: { status: true, error: true },
    });
    expect(log?.status).toBe("FAILED");
    expect(log?.error).toBe(mailState.error);
  });

  it("reports emailSent true when the mail goes out", async () => {
    const res = await invite({
      name: "Working Mail Cranes",
      email: "mail.ok@onboarding.test",
      contactNumber: "9820011223",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.emailSent).toBe(true);
    expect(res.body.token).toEqual(expect.any(String));

    const log = await testPrisma.emailLog.findFirst({
      where: { entity: "vendor_invitation", entityId: res.body.invitationId as string },
      select: { status: true },
    });
    expect(log?.status).toBe("SENT");
  });

  it("keeps the duplicate guard after a failed email, so one link stays live", async () => {
    mailState.fail = true;

    const first = await invite({
      name: "First Attempt Cranes",
      email: "retry@onboarding.test",
      contactNumber: "9820011223",
    });
    expect(first.status).toBe(201);
    expect(first.body.emailSent).toBe(false);

    // The row was created even though the mail failed, so a second invite would
    // stack a second live link on the same address.
    const second = await invite({
      name: "Second Attempt Cranes",
      email: "retry@onboarding.test",
      contactNumber: "9820011223",
    });
    expect(second.status).toBe(409);
  });
});
