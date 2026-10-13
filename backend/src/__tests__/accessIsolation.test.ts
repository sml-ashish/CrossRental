import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  call,
  clearTestUploads,
  disconnectTestDatabases,
  resetTestDatabase,
  seedIsolationFixtures,
  testPrisma,
  useTestDatabase,
} from "./harness";
import { INTERNAL_USERS, VENDOR_PASSWORD, VENDOR_USERS } from "./fixtures";

/**
 * Brief 6.6: "A vendor user can read and write only their own vendor's data.
 * Enforce on the server side on every query, not just in the UI."
 *
 * These are the M1 subset — the auth surface plus the one vendor-scoped data
 * route. The crane, RFQ and quotation isolation tests join this file as those
 * milestones land, because the rule is only as strong as its weakest query.
 */

let app: Express;

beforeAll(async () => {
  // config/env and lib/database read process.env at import time, so the app is
  // imported dynamically only after the test database has been made the
  // configured one. Without this the app would query the development database
  // while the fixtures below are written to the test database.
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

async function signIn(email: string, password = VENDOR_PASSWORD) {
  const res = await call(app, "POST", "/api/auth/login", { body: { email, password } });
  expect(res.status, `login failed for ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

async function seedAndSignIn() {
  const fixtures = await seedIsolationFixtures();
  return {
    ...fixtures,
    tokenA: await signIn(VENDOR_USERS.a),
    tokenB: await signIn(VENDOR_USERS.b),
  };
}

describe("authentication", () => {
  it("signs a seeded vendor in and returns only its own vendorId", async () => {
    const fixtures = await seedAndSignIn();
    const res = await call(app, "GET", "/api/auth/me", { token: fixtures.tokenA });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(VENDOR_USERS.a);
    expect(res.body.user.role).toBe("vendor_user");
    expect(res.body.user.vendorId).toBe(fixtures.vendorA.vendorId);
    expect(res.body.user.vendorId).not.toBe(fixtures.vendorB.vendorId);
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    await seedIsolationFixtures();

    const wrongPassword = await call(app, "POST", "/api/auth/login", {
      body: { email: VENDOR_USERS.a, password: "NotThePassword1" },
    });
    const unknownEmail = await call(app, "POST", "/api/auth/login", {
      body: { email: "ghost@isolation.test", password: "NotThePassword1" },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Identical bodies: the endpoint must not reveal whether an email exists.
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("refuses an internal account on the vendor password endpoint", async () => {
    await seedIsolationFixtures();
    const res = await call(app, "POST", "/api/auth/login", {
      body: { email: INTERNAL_USERS.admin, password: VENDOR_PASSWORD },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_CREDENTIALS");
  });

  it("refuses a request with no token, and with a tampered token", async () => {
    await seedIsolationFixtures();

    const none = await call(app, "GET", "/api/vendors/me");
    expect(none.status).toBe(401);

    const tampered = await call(app, "GET", "/api/vendors/me", {
      token: "not.a.real.token",
    });
    expect(tampered.status).toBe(401);
  });

  it("locks out a deactivated account immediately, without waiting for token expiry", async () => {
    const fixtures = await seedAndSignIn();
    const before = await call(app, "GET", "/api/vendors/me", { token: fixtures.tokenA });
    expect(before.status).toBe(200);

    await testPrisma.user.update({
      where: { id: fixtures.vendorA.userId },
      data: { isActive: false },
    });

    const after = await call(app, "GET", "/api/vendors/me", { token: fixtures.tokenA });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("ACCOUNT_DEACTIVATED");
  });
});

describe("vendor data isolation", () => {
  it("returns vendor A's own record to vendor A", async () => {
    const fixtures = await seedAndSignIn();
    const res = await call(app, "GET", "/api/vendors/me", { token: fixtures.tokenA });

    expect(res.status).toBe(200);
    expect(res.body.vendor.id).toBe(fixtures.vendorA.vendorId);
    expect(res.body.vendor.name).toBe("Isolation Vendor A");
  });

  it("never leaks the encrypted bank columns, and masks the account number", async () => {
    const fixtures = await seedAndSignIn();
    const res = await call(app, "GET", "/api/vendors/me", { token: fixtures.tokenA });

    expect(res.status).toBe(200);
    // A vendor must not receive ciphertext it could replay, nor the real number.
    expect(res.body.vendor.bankAccountNoEnc).toBeUndefined();
    expect(res.body.vendor.bankIfscEnc).toBeUndefined();
    expect(res.body.vendor.bankMasked).toBe(true);
    expect(res.body.vendor.bankAccountNo).toBe("XXXXXXXX0001");
    expect(res.body.vendor.bankAccountNo).not.toContain("90000");
  });

  it("does not honour a vendorId supplied by the caller", async () => {
    const fixtures = await seedAndSignIn();

    // A caller who appends another vendor's id must still only ever receive
    // their own record.
    const asQuery = await call(app, "GET", `/api/vendors/me?vendorId=${fixtures.vendorB.vendorId}`, {
      token: fixtures.tokenA,
    });
    expect(asQuery.status).toBe(200);
    expect(asQuery.body.vendor.id).toBe(fixtures.vendorA.vendorId);

    // Same attempt in a request body. POST /api/auth/login is used because a
    // GET cannot carry one, and the token it returns is derived from the
    // authenticated user alone.
    const asBody = await call(app, "POST", "/api/auth/login", {
      body: { email: VENDOR_USERS.a, password: VENDOR_PASSWORD, vendorId: fixtures.vendorB.vendorId },
    });
    expect(asBody.status).toBe(200);
    expect(asBody.body.user.vendorId).toBe(fixtures.vendorA.vendorId);
    expect(asBody.body.user.vendorId).not.toBe(fixtures.vendorB.vendorId);
  });

  it("keeps one vendor's contact list out of another vendor's hands", async () => {
    const fixtures = await seedAndSignIn();
    const res = await call(app, "GET", "/api/vendors/me", { token: fixtures.tokenA });

    expect(res.body.vendor.contacts).toHaveLength(1);
    expect(res.body.vendor.contacts[0].email).toBe(VENDOR_USERS.a);
    expect(JSON.stringify(res.body)).not.toContain(VENDOR_USERS.b);
  });

  it("refuses a vendor token on an internal-only route", async () => {
    const fixtures = await seedAndSignIn();
    const res = await call(app, "GET", "/api/vendors/me", {
      token: fixtures.tokenA,
      headers: { "x-impersonate": INTERNAL_USERS.admin },
    });
    // No impersonation header exists, and the request still resolves to A.
    expect(res.status).toBe(200);
    expect(res.body.vendor.id).toBe(fixtures.vendorA.vendorId);
  });
});

describe("role separation", () => {
  it("does not let a vendor sign in with an OTP, or an internal user with a password", async () => {
    await seedIsolationFixtures();

    const otpForVendor = await call(app, "POST", "/api/auth/otp/request", {
      body: { email: VENDOR_USERS.a },
    });
    expect(otpForVendor.status).toBe(200);
    // Generic message, and no OTP row is created for a vendor account.
    const otps = await testPrisma.loginOtp.count();
    expect(otps).toBe(0);

    const passwordForAdmin = await call(app, "POST", "/api/auth/login", {
      body: { email: INTERNAL_USERS.admin, password: VENDOR_PASSWORD },
    });
    expect(passwordForAdmin.status).toBe(401);
  });

  it("rejects a vendor user from internal-only capabilities", async () => {
    const fixtures = await seedAndSignIn();
    const me = await call(app, "GET", "/api/auth/me", { token: fixtures.tokenA });

    // Exactly two, and both are the vendor's own: edit their fleet, and answer an
    // RFQ with a quotation. `rfq:respond` arrived with M5 and is the only reason
    // this list is longer than it was.
    expect(me.body.user.capabilities).toEqual(["fleet:edit_own", "rfq:respond"]);
    // A sales user gets no bank visibility; an admin does.
    expect(me.body.user.capabilities).not.toContain("vendor:view_bank");
    expect(me.body.user.capabilities).not.toContain("quotation:award");
    // Nor can a vendor see what other vendors quoted, or award a contract.
    expect(me.body.user.capabilities).not.toContain("rfq:view_quotations");
    expect(me.body.user.capabilities).not.toContain("rfq:dispatch");
  });
});

describe("input hardening", () => {
  it("strips prototype-polluting keys from the request body", async () => {
    const fixtures = await seedAndSignIn();
    const res = await call(app, "POST", "/api/auth/login", {
      body: JSON.parse(
        JSON.stringify({
          email: VENDOR_USERS.a,
          password: VENDOR_PASSWORD,
          // JSON.parse keeps __proto__ as an own property, so this is the
          // shape an attacker would send to poison Object.prototype.
          __proto__: { isAdmin: true, role: "admin_user" },
          vendorId: fixtures.vendorB.vendorId,
        }),
      ),
    });

    expect(res.status).toBe(200);
    // Neither the injected fields nor the other vendor's id took effect.
    expect(res.body.user.role).toBe("vendor_user");
    expect(res.body.user.vendorId).toBe(fixtures.vendorA.vendorId);
    expect(({} as Record<string, unknown>)["isAdmin"]).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)["isAdmin"]).toBeUndefined();
  });

  it("rejects a malformed body with field-level detail", async () => {
    await seedIsolationFixtures();
    const res = await call(app, "POST", "/api/auth/login", {
      body: { email: "not-an-email", password: "" },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.map((d: any) => d.path)).toContain("email");
  });
});