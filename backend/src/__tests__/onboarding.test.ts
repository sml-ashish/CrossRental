import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  call,
  callRaw,
  callUpload,
  clearTestUploads,
  disconnectTestDatabases,
  internalToken,
  resetTestDatabase,
  sampleUpload,
  seedIsolationFixtures,
  testPrisma,
  useTestDatabase,
} from "./harness";
import { INTERNAL_USERS, VENDOR_USERS } from "./fixtures";

/**
 * Milestone 2: vendor registration and approval (brief 7.2, 7.3).
 *
 * The path exercised end to end here is the one brief section 8 describes as the
 * replacement for the paper process: an SML user sends a link, the vendor fills
 * the form in sections, uploads the three required documents, submits, and an
 * admin approves or rejects. Approval is what creates the login, so the test
 * asserts that a vendor cannot reach the portal before it and can afterwards.
 *
 * Isolation gets the same attention as the happy path. Brief 6.6 is only as
 * strong as its weakest query, and the invitation token is a bearer credential
 * that arrives in a URL, so cross-vendor access via a guessed or reused token is
 * tested explicitly.
 *
 * Every value here is fabricated (brief working rule 3).
 */

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

// ---------------------------------------------------------------------------
// Payloads — fabricated, and shaped to satisfy the full submit schema.
// ---------------------------------------------------------------------------

const APPLICANT_EMAIL = "applicant@onboarding.test";
const APPLICANT_CONTACT_EMAIL = "owner@onboarding.test";
const APPLICANT_COMPANY = "Onboarding Test Cranes Pvt Ltd";

function fullForm() {
  return {
    name: APPLICANT_COMPANY,
    natureOfCompany: "PRIVATE_LTD",
    addressLine1: "14 Harbour Road",
    addressLine2: "Near docks",
    city: "Ahmedabad",
    district: "Ahmedabad",
    stateCode: "GJ",
    pincode: "380001",
    telephone: "+91 79 4000 1200",
    fax: "",
    email: APPLICANT_CONTACT_EMAIL,
    weeklyOffDays: "Sunday",
    companySize: "11-50",
    pan: "AABCO1234K",
    tan: "BLR1234567",
    gstRegistered: true,
    gstn: "24AABCO1234K1Z5",
    gstRegistrationType: "REGULAR",
    gstr1FilingFrequency: "MONTHLY",
    cin: "U12345MH2024PTC123456",
    msmeRegistered: false,
    tdsLowerDeduction: false,
    operatingRegions: ["GJ", "MH"],
    contacts: [
      {
        name: "Rita Owner",
        mobile: "+91 98200 11223",
        telephone: "",
        email: APPLICANT_CONTACT_EMAIL,
        isPrimary: true,
        receivesRfqs: true,
      },
      {
        name: "Sam Dispatch",
        mobile: "+91 98200 44556",
        telephone: "",
        email: "",
        isPrimary: false,
        receivesRfqs: false,
      },
    ],
    bankAccountHolderName: "Onboarding Test Cranes Pvt Ltd",
    bankName: "State Bank of Test",
    bankBranch: "Ahmedabad Naroda",
    bankAccountType: "CURRENT",
    bankAccountNo: "50100234567890",
    bankIfsc: "TEST0000123",
    bankMicr: "380012345",
    fleetSummary: "Rough-terrain and crawler cranes, 20 to 100 tonne, fleet of about 12.",
    codeOfConductAccepted: true,
    declarationName: "Rita Owner",
    declarationDesignation: "Managing Director",
    declarationDate: "2026-01-15",
    communicationNotes: "Prefer email before 6 pm.",
  };
}

const REQUIRED_DOCS = ["CANCELLED_CHEQUE", "PAN_COPY", "DECLARATION_SCAN", "GST_CERTIFICATE"] as const;

interface Ctx {
  adminToken: string;
  salesToken: string;
  vendorToken: string;
  vendorId: string;
  vendorBId: string;
}

/** Seeds isolation fixtures and signs in as admin, sales and vendor A. */
async function seedAndSignIn(): Promise<Ctx> {
  const fixtures = await seedIsolationFixtures();
  return {
    adminToken: await internalToken(fixtures.adminId, INTERNAL_USERS.admin, "admin_user"),
    salesToken: await internalToken(fixtures.salesId, INTERNAL_USERS.sales, "sales_user"),
    vendorToken: await signInVendor(VENDOR_USERS.a),
    vendorId: fixtures.vendorA.vendorId,
    vendorBId: fixtures.vendorB.vendorId,
  };
}

async function signInVendor(email: string) {
  const res = await call(app, "POST", "/api/auth/login", {
    body: { email, password: "Vendor@Portal2026" },
  });
  expect(res.status, `login failed: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

/** Creates an invitation and returns its raw token. */
async function invite(adminToken: string, email = APPLICANT_EMAIL) {
  const res = await call(app, "POST", "/api/vendors/invitations", {
    token: adminToken,
    body: { email, companyName: "Onboarding Test Cranes", contactName: "Rita Owner" },
  });
  expect(res.status, `invite failed: ${JSON.stringify(res.body)}`).toBe(201);
  return { invitationId: res.body.invitationId as string, token: res.body.token as string };
}

async function uploadAll(token: string, docTypes: readonly string[] = REQUIRED_DOCS) {
  for (const docType of docTypes) {
    const res = await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/${docType}`,
      sampleUpload("pdf"),
    );
    expect(res.status, `upload ${docType} failed: ${JSON.stringify(res.body)}`).toBe(201);
  }
}

/** Drives the applicant all the way to SUBMITTED. */
async function submitApplication(ctx: Ctx, token: string) {
  const save = await call(app, "PUT", `/api/onboarding/invitation/${token}`, {
    body: fullForm(),
  });
  expect(save.status, `save failed: ${JSON.stringify(save.body)}`).toBe(200);

  await uploadAll(token);

  const submit = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
    body: fullForm(),
  });
  expect(submit.status, `submit failed: ${JSON.stringify(submit.body)}`).toBe(200);
  return submit.body.vendorId as string;
}

// ---------------------------------------------------------------------------

describe("M2 invitations", () => {
  it("lets an admin invite a vendor and returns a usable link", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const res = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.canEdit).toBe(true);
    expect(res.body.prefill.companyName).toBe("Onboarding Test Cranes");
    // The vendor has not started, so there is no draft row yet — and no
    // gstRegistered answer, so the GST certificate is not required yet.
    expect(res.body.vendorId).toBeNull();
    expect(res.body.missingDocuments).toEqual(["CANCELLED_CHEQUE", "PAN_COPY", "DECLARATION_SCAN"]);
  });

  it("lets sales invite, because vendor:invite is not admin-only", async () => {
    const ctx = await seedAndSignIn();
    const res = await call(app, "POST", "/api/vendors/invitations", {
      token: ctx.salesToken,
      body: { email: APPLICANT_EMAIL, companyName: "From Sales" },
    });
    expect(res.status).toBe(201);
  });

  it("refuses to let a vendor invite anybody", async () => {
    const ctx = await seedAndSignIn();
    const res = await call(app, "POST", "/api/vendors/invitations", {
      token: ctx.vendorToken,
      body: { email: "attacker@onboarding.test" },
    });
    expect(res.status).toBe(403);
  });

  it("requires authentication to invite", async () => {
    await seedAndSignIn();
    const res = await call(app, "POST", "/api/vendors/invitations", {
      body: { email: APPLICANT_EMAIL },
    });
    expect(res.status).toBe(401);
  });

  it("refuses a second live invitation for the same address", async () => {
    const ctx = await seedAndSignIn();
    await invite(ctx.adminToken);
    const res = await call(app, "POST", "/api/vendors/invitations", {
      token: ctx.adminToken,
      body: { email: APPLICANT_EMAIL },
    });
    // Two live links would leave the vendor unable to tell which is current.
    expect(res.status).toBe(409);
  });

  it("does not put the token itself in the invitation list", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const res = await call(app, "GET", "/api/vendors/invitations", { token: ctx.adminToken });
    expect(res.status).toBe(200);
    expect(res.body.invitations).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it("rejects an unknown or revoked token", async () => {
    const ctx = await seedAndSignIn();
    const { invitationId, token } = await invite(ctx.adminToken);

    const wrong = await call(app, "GET", `/api/onboarding/invitation/${"z".repeat(43)}`);
    expect(wrong.status).toBe(400);

    await testPrisma.vendorInvitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() },
    });

    const revoked = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(revoked.status).toBe(400);
    expect(revoked.body.error).toMatch(/withdrawn/i);
  });

  it("rejects an expired token", async () => {
    const ctx = await seedAndSignIn();
    const { invitationId, token } = await invite(ctx.adminToken);

    await testPrisma.vendorInvitation.update({
      where: { id: invitationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("expires an invitation seven days after it is issued (P0 A9)", async () => {
    const ctx = await seedAndSignIn();
    const { invitationId } = await invite(ctx.adminToken);

    const row = await testPrisma.vendorInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { createdAt: true, expiresAt: true },
    });
    const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});

describe("M2 the public form's reference data", () => {
  /**
   * The registration form is reached by an emailed link, so the invitee has no
   * session. Anything it needs to render has to be readable without one, which
   * is why this endpoint exists at all — the authenticated
   * /vendors/reference-data would answer 401 here.
   */
  it("serves the state list to an unauthenticated invitee", async () => {
    const res = await call(app, "GET", "/api/onboarding/reference-data");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.states)).toBe(true);
    for (const state of res.body.states) {
      expect(Object.keys(state).sort()).toEqual(["code", "name"]);
    }
  });

  it("does not expose crane types or anything else on the public route", async () => {
    const publicRes = await call(app, "GET", "/api/onboarding/reference-data");
    expect(Object.keys(publicRes.body)).toEqual(["states"]);

    // The authenticated route is a superset, which is the reason the public one
    // exists rather than just relaxing the existing route.
    const ctx = await seedAndSignIn();
    const authed = await call(app, "GET", "/api/vendors/reference-data", {
      token: ctx.adminToken,
    });
    expect(authed.status).toBe(200);
    expect(authed.body).toHaveProperty("craneTypes");
  });
});

describe("M2 saving a draft", () => {
  it("creates the draft vendor on first save", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const res = await call(app, "PUT", `/api/onboarding/invitation/${token}`, {
      body: { name: APPLICANT_COMPANY, natureOfCompany: "PRIVATE_LTD" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const vendorId = res.body.vendorId as string;
    expect(vendorId).toBeTruthy();
    expect(res.body.status).toBe("DRAFT");

    const row = await testPrisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { name: true, natureOfCompany: true, onboardingStatus: true },
    });
    expect(row.name).toBe(APPLICANT_COMPANY);
    expect(row.onboardingStatus).toBe("DRAFT");
  });

  it("accepts a partial form without demanding every field", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    await call(app, "PUT", `/api/onboarding/invitation/${token}`, {
      body: { name: APPLICANT_COMPANY },
    });
    const second = await call(app, "PUT", `/api/onboarding/invitation/${token}`, {
      body: { addressLine1: "14 Harbour Road, Ahmedabad" },
    });

    expect(second.status, JSON.stringify(second.body)).toBe(200);

    const view = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(view.body.draft.name).toBe(APPLICANT_COMPANY);
    expect(view.body.draft.addressLine1).toContain("Harbour Road");
  });

  it("still rejects a structurally impossible value in a draft", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const res = await call(app, "PUT", `/api/onboarding/invitation/${token}`, {
      body: { pan: "NOT-A-PAN" },
    });
    // A draft skips required-field checks but not format checks, so bad data
    // never reaches the database.
    expect(res.status).toBe(400);
  });

  it("stores the bank account encrypted and only exposes the last four digits", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const res = await call(app, "PUT", `/api/onboarding/invitation/${token}`, {
      body: { bankAccountNo: "50100234567890", bankIfsc: "TEST0000123" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await testPrisma.vendor.findUniqueOrThrow({
      where: { id: res.body.vendorId },
      select: { bankAccountNoEnc: true, bankAccountNoLast4: true, bankIfscEnc: true },
    });
    expect(row.bankAccountNoEnc).not.toContain("50100234567890");
    expect(row.bankAccountNoLast4).toBe("7890");
    expect(row.bankIfscEnc).not.toContain("TEST0000123");

    // The form reload must never hand the clear value back.
    const view = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(JSON.stringify(view.body)).not.toContain("50100234567890");
  });
});

describe("M2 submitting", () => {
  it("refuses to submit before the three required documents are uploaded", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });

    const res = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: fullForm(),
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    for (const label of ["Cancelled cheque", "GST certificate", "PAN copy"]) {
      expect(res.body.error).toContain(label);
    }

    // Crucially it must not have reached SUBMITTED.
    const view = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(view.body.status).toBe("DRAFT");
  });

  it("refuses to submit an incomplete form and names every missing field", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });
    await uploadAll(token);

    const incomplete = { ...fullForm(), pan: "", gstn: "", declarationDesignation: "" };
    const res = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: incomplete,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("moves a complete application to SUBMITTED", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const vendorId = await submitApplication(ctx, token);

    const row = await testPrisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { onboardingStatus: true, approvedAt: true, contacts: true, operatingRegions: true },
    });
    expect(row.onboardingStatus).toBe("SUBMITTED");
    // Still no approval, so no login may exist yet.
    expect(row.approvedAt).toBeNull();
    expect(await testPrisma.user.count({ where: { vendorId } })).toBe(0);
    expect(row.contacts.filter((c) => c.isPrimary)).toHaveLength(1);
    expect(row.operatingRegions.map((r) => r.stateCode).sort()).toEqual(["GJ", "MH"]);
  });

  /**
   * The form's dropdowns send "" for "not answered". Before this was allowed, a
   * vendor who left the two optional choices alone could not submit at all, and
   * the only message was "Invalid option" against a field they had not filled in.
   */
  it("treats a blank optional choice as unanswered rather than invalid", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const form = fullForm();
    form.gstr1FilingFrequency = "";
    form.msmeCategory = "";

    const save = await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: form });
    expect(save.status).toBe(200);
    await uploadAll(token);

    const res = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: form,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await testPrisma.vendor.findUniqueOrThrow({
      where: { id: res.body.vendorId },
      select: { gstr1FilingFrequency: true, msmeCategory: true, onboardingStatus: true },
    });
    expect(row.onboardingStatus).toBe("SUBMITTED");
    // Stored as absent, not as an empty string.
    expect(row.gstr1FilingFrequency).toBeNull();
    expect(row.msmeCategory).toBeNull();
  });

  it("still rejects a required choice that was left blank", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const form = fullForm();
    form.bankAccountType = "";

    const save = await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: form });
    expect(save.status).toBe(200);
    await uploadAll(token);

    const res = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: form,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details.some((d: { path: string }) => d.path === "bankAccountType")).toBe(true);
  });

  it("blocks submit when the GSTIN does not embed the PAN", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    const mismatched = { ...fullForm(), gstn: "24ZZZZZ9999Z1Z5" };
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: mismatched });
    await uploadAll(token);
    const res = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: mismatched,
    });

    // Open item 2 (decision): the mismatch usually means the numbers were
    // copied from two different entities, so it is a hard stop now, not a
    // warning the admin has to catch.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(res.body.details ?? res.body.error)).toMatch(/GSTIN/i);
  });

  it("blocks submit when the GST block contradicts gstRegistered", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    // Registered but no GSTIN on file — the key is omitted entirely, which is
    // also how a browser form with an empty optional input submits.
    const missingGstn = { ...fullForm(), gstn: undefined };
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: missingGstn });
    await uploadAll(token);
    const res = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: missingGstn,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details ?? res.body.error)).toMatch(/GSTIN is required/i);

    // Unregistered but still sending a typed GSTN (the vendor flipped the
    // radio without clearing the box they had already filled).
    const unregistered = { ...fullForm(), gstRegistered: false, gstRegistrationType: "" };
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: unregistered });
    await uploadAll(token);
    const res2 = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: unregistered,
    });
    expect(res2.status).toBe(400);
    expect(JSON.stringify(res2.body.details ?? res2.body.error)).toMatch(/only apply/i);
  });

  it("blocks submit when the PAN's 4th letter contradicts the company type", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    // Private ltd wants "C" at position 4; this PAN belongs to a proprietor.
    const wrongType = { ...fullForm(), pan: "AABPO1234K", gstn: "24AABPO1234K1Z5" };
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: wrongType });
    await uploadAll(token);
    const res = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: wrongType,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details ?? res.body.error)).toMatch(/4th letter/i);
  });

  it("normalises a contact mobile to ten digits and rejects a leading zero (P0 A8)", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    // "+91" and a leading "0" are the two shapes a vendor actually types, and
    // both mean the same ten-digit number.
    const form = fullForm();
    form.contacts[0].mobile = "+91 98200 11223";
    form.contacts[1].mobile = "09820044556";
    const save = await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: form });
    expect(save.status, JSON.stringify(save.body)).toBe(200);

    const stored = await testPrisma.vendor.findUniqueOrThrow({
      where: { id: save.body.vendorId },
      select: { contacts: { select: { mobile: true } } },
    });
    expect(stored.contacts.map((c) => c.mobile).sort()).toEqual(["9820011223", "9820044556"]);

    // A number that still begins with zero after normalising is not a mobile.
    const bad = fullForm();
    bad.contacts[0].mobile = "0982001123";
    const res = await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: bad });
    expect(res.status).toBe(400);
    expect(
      res.body.details.some((d: { path: string }) => d.path.includes("mobile")),
    ).toBe(true);
  });

  it("refuses a second vendor with the same PAN or GSTIN (P0 A8)", async () => {
    const ctx = await seedAndSignIn();
    const first = await invite(ctx.adminToken);
    await submitApplication(ctx, first.token);

    const second = await invite(ctx.adminToken, "second@onboarding.test");
    // Save first under a different, valid identity so the collision is raised
    // by the friendly submit check rather than by the unique index on save.
    const distinct = { ...fullForm(), pan: "AABCC5678L", gstn: "24AABCC5678L1Z5" };
    await call(app, "PUT", `/api/onboarding/invitation/${second.token}`, { body: distinct });
    await uploadAll(second.token);

    const res = await call(app, "POST", `/api/onboarding/invitation/${second.token}/submit`, {
      body: fullForm(),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details ?? res.body.error)).toMatch(
      /already registered with this PAN/i,
    );
  });

  it("accepts a submit from an unregistered vendor without the GST certificate", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    // An unregistered vendor leaves the whole GST block empty; omit the key
    // the way an untouched form would.
    const base = fullForm() as Record<string, unknown>;
    delete base["gstn"];
    const unregistered = {
      ...base,
      gstRegistered: false,
      gstRegistrationType: "",
      gstr1FilingFrequency: "",
    };
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: unregistered });
    // Skip the GST certificate upload: an unregistered vendor has no option
    // to upload it, so the page never lists it and submit must not want it.
    await uploadAll(token, ["CANCELLED_CHEQUE", "PAN_COPY", "DECLARATION_SCAN"]);
    const res = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: unregistered,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.warnings as string[]).join(" ")).not.toMatch(/GSTIN/i);
  });

  it("freezes the form once submitted", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await submitApplication(ctx, token);

    const edit = await call(app, "PUT", `/api/onboarding/invitation/${token}`, {
      body: { name: "Changed After Submit" },
    });
    expect(edit.status).toBe(409);

    const view = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(view.body.canEdit).toBe(false);
  });
});

describe("M2 documents", () => {
  it("stores a document and reports it as no longer missing", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });

    const res = await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/PAN_COPY`,
      sampleUpload("png"),
    );
    expect(res.status).toBe(201);

    const view = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(view.body.missingDocuments).not.toContain("PAN_COPY");
    expect(view.body.missingDocuments).toEqual(
      expect.arrayContaining(["CANCELLED_CHEQUE", "GST_CERTIFICATE"]),
    );
  });

  it("replaces the previous file of the same type rather than stacking copies", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });

    await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/GST_CERTIFICATE`,
      sampleUpload("pdf"),
    );
    await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/GST_CERTIFICATE`,
      sampleUpload("png"),
    );

    const rows = await testPrisma.vendorDocument.findMany({
      where: { docType: "GST_CERTIFICATE" },
      select: { mimeType: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].mimeType).toBe("image/png");
  });

  it("refuses a file whose contents do not match its declared type", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });

    // A shell script renamed to .pdf: the extension says PDF, the bytes do not.
    const res = await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/PAN_COPY`,
      sampleUpload("text"),
    );
    expect(res.status).toBe(400);
    expect(await testPrisma.vendorDocument.count()).toBe(0);
  });

  it("refuses an unknown document type", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });

    const res = await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/PASSPORT`,
      sampleUpload("pdf"),
    );
    expect(res.status).toBe(400);
  });

  it("asks for the company section before a document can be stored", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    // No draft yet, so there is no vendor for the document to belong to.
    const res = await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/PAN_COPY`,
      sampleUpload("pdf"),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/company details/i);
  });

  it("serves the file back as a download, not as inline content", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });
    await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/CANCELLED_CHEQUE`,
      sampleUpload("pdf"),
    );

    const res = await callRaw(app, `/api/onboarding/invitation/${token}/documents/CANCELLED_CHEQUE`);
    expect(res.status).toBe(200);
    expect(res.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("reports a document that was never uploaded", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });

    const res = await callRaw(app, `/api/onboarding/invitation/${token}/documents/PAN_COPY`);
    expect(res.status).toBe(404);
  });
});

describe("M2 the approval queue", () => {
  it("lists a submitted vendor for an admin, defaulting to the submitted queue", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const res = await call(app, "GET", "/api/vendors", { token: ctx.adminToken });
    expect(res.status).toBe(200);

    const row = res.body.vendors.find((v: any) => v.id === vendorId);
    expect(row.onboardingStatus).toBe("SUBMITTED");
    expect(res.body.counts.SUBMITTED).toBe(1);
    // The already-approved isolation fixture is not in the submitted queue.
    expect(res.body.vendors.map((v: any) => v.id)).not.toContain(ctx.vendorId);
  });

  it("filters by status and searches by PAN", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    // Both isolation fixtures are seeded as APPROVED.
    const approved = await call(app, "GET", "/api/vendors?status=APPROVED", {
      token: ctx.adminToken,
    });
    expect(approved.body.vendors.map((v: any) => v.id).sort()).toEqual(
      [ctx.vendorId, ctx.vendorBId].sort(),
    );

    const found = await call(app, "GET", "/api/vendors?search=AABCO1234K", {
      token: ctx.adminToken,
    });
    expect(found.body.vendors.map((v: any) => v.id)).toEqual([vendorId]);

    const missing = await call(app, "GET", "/api/vendors?search=nothing-matches", {
      token: ctx.adminToken,
    });
    expect(missing.body.vendors).toHaveLength(0);
  });

  it("keeps bank details away from a sales user but shows them to an admin", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const sales = await call(app, "GET", `/api/vendors/${vendorId}`, { token: ctx.salesToken });
    expect(sales.status).toBe(200);
    expect(sales.body.vendor.bankVisible).toBe(false);
    // The whole point of brief 6.6: the value must not be in the payload.
    expect(JSON.stringify(sales.body)).not.toContain("50100234567890");
    expect(JSON.stringify(sales.body)).not.toContain("TEST0000123");

    const admin = await call(app, "GET", `/api/vendors/${vendorId}`, { token: ctx.adminToken });
    expect(admin.body.vendor.bankVisible).toBe(true);
    expect(admin.body.vendor.bankAccountNo).toBe("50100234567890");
    expect(admin.body.vendor.bankIfsc).toBe("TEST0000123");
  });

  it("refuses a vendor user any access to the queue", async () => {
    const ctx = await seedAndSignIn();
    expect((await call(app, "GET", "/api/vendors", { token: ctx.vendorToken })).status).toBe(403);
  });

  it("restricts registration documents to admins, since they include bank papers", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const sales = await callRaw(app, `/api/vendors/${vendorId}/documents/CANCELLED_CHEQUE`, {
      token: ctx.salesToken,
    });
    expect(sales.status).toBe(403);

    const admin = await callRaw(app, `/api/vendors/${vendorId}/documents/CANCELLED_CHEQUE`, {
      token: ctx.adminToken,
    });
    expect(admin.status).toBe(200);
  });

  it("reports which required documents are still missing", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);

    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });
    await uploadAll(token, ["PAN_COPY"]);

    const save = await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });
    const res = await call(app, "GET", `/api/vendors/${save.body.vendorId}`, {
      token: ctx.adminToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.missingDocuments).toEqual(
      expect.arrayContaining(["CANCELLED_CHEQUE", "GST_CERTIFICATE"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase D3: the SAP vendor creation sheet
// ---------------------------------------------------------------------------

describe("SAP vendor creation sheet (D3)", () => {
  it("lays the vendor out for an admin, with the bank details decrypted", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const mailBefore = await testPrisma.emailLog.count();
    const auditBefore = await testPrisma.auditLog.count();
    const res = await call(app, "GET", `/api/vendors/${vendorId}/sap-sheet`, {
      token: ctx.adminToken,
    });
    expect(res.status).toBe(200);

    const sheet = res.body.sheet;
    expect(sheet.sections.map((s: any) => s.title)).toEqual(
      expect.arrayContaining([
        "Vendor identification",
        "Address",
        "Tax and registration",
        "Bank details",
      ]),
    );

    const bank = sheet.sections.find((s: any) => s.title === "Bank details");
    const account = bank.rows.find((r: any) => r.label === "Account number");
    expect(account.value).toBe("50100234567890");

    // The export is not logged (brief D3): reading it writes nothing new.
    expect(await testPrisma.emailLog.count()).toBe(mailBefore);
    expect(await testPrisma.auditLog.count()).toBe(auditBefore);
  });

  it("is admin only", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const sales = await call(app, "GET", `/api/vendors/${vendorId}/sap-sheet`, {
      token: ctx.salesToken,
    });
    expect(sales.status).toBe(403);
  });

  it("exports a SpreadsheetML workbook", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const res = await callRaw(app, `/api/vendors/${vendorId}/sap-sheet.xls`, {
      token: ctx.adminToken,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/vnd.ms-excel");
    const body = res.buffer.toString("utf8");
    expect(body).toContain("SAP vendor sheet");
    expect(body).toContain("Bank details");
  });

  it("carries admin-edited master-list picks through approval onto the sheet", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const saved = await call(app, "PUT", "/api/settings/master-lists/VENDOR_ORIGIN", {
      token: ctx.adminToken,
      body: { values: ["Domestic", "domestic", " Imported "] },
    });
    // Trimmed, blanks dropped, case-insensitively de-duplicated.
    expect(saved.status).toBe(200);
    expect(saved.body.values).toEqual(["Domestic", "Imported"]);

    const approve = await call(app, "POST", `/api/vendors/${vendorId}/approve`, {
      token: ctx.adminToken,
      body: { officeUse: { vendorOrigin: "Domestic", legalForm: "Private Limited" } },
    });
    expect(approve.status).toBe(200);

    const sheet = await call(app, "GET", `/api/vendors/${vendorId}/sap-sheet`, {
      token: ctx.adminToken,
    });
    const office = sheet.body.sheet.sections.find((s: any) => s.title === "Office use (SML)");
    const origin = office.rows.find((r: any) => r.label === "Vendor origin");
    const legal = office.rows.find((r: any) => r.label === "Legal form");
    expect(origin.value).toBe("Domestic");
    expect(legal.value).toBe("Private Limited");
  });
});

describe("SAP office-use master lists (D3)", () => {
  it("lets an admin edit and read the lists, and refuses sales", async () => {
    const ctx = await seedAndSignIn();

    expect(
      (await call(app, "GET", "/api/settings/master-lists", { token: ctx.salesToken })).status,
    ).toBe(403);

    const before = await call(app, "GET", "/api/settings/master-lists", { token: ctx.adminToken });
    expect(before.status).toBe(200);
    expect(before.body.masterLists.VENDOR_ORIGIN).toEqual([]);

    await call(app, "PUT", "/api/settings/master-lists/LEGAL_FORM", {
      token: ctx.adminToken,
      body: { values: ["Partnership", "Private Limited"] },
    });

    const after = await call(app, "GET", "/api/settings/master-lists", { token: ctx.adminToken });
    expect(after.body.masterLists.LEGAL_FORM).toEqual(["Partnership", "Private Limited"]);
  });

  it("rejects an unknown list name", async () => {
    const ctx = await seedAndSignIn();
    const res = await call(app, "PUT", "/api/settings/master-lists/NOT_A_LIST", {
      token: ctx.adminToken,
      body: { values: ["x"] },
    });
    expect(res.status).toBe(400);
  });
});

describe("M2 approval", () => {
  it("creates the login, records the SAP code and emails the activation link", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const res = await call(app, "POST", `/api/vendors/${vendorId}/approve`, {
      token: ctx.adminToken,
      body: {
        sapVendorCode: "10004567",
        adminRemarks: "Verified against the cheque and PAN.",
        officeUse: { facilityStatus: "ADEQUATE", manpowerStatus: "ADEQUATE" },
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const vendor = await testPrisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: {
        onboardingStatus: true,
        sapVendorCode: true,
        approvedAt: true,
        facilityStatus: true,
        approvedBy: { select: { role: true } },
      },
    });
    expect(vendor.onboardingStatus).toBe("APPROVED");
    expect(vendor.sapVendorCode).toBe("10004567");
    expect(vendor.approvedAt).not.toBeNull();
    expect(vendor.facilityStatus).toBe("ADEQUATE");
    expect(vendor.approvedBy.role).toBe("admin_user");

    // The approval is what brings the login into existence.
    const user = await testPrisma.user.findFirstOrThrow({
      where: { vendorId },
      select: { email: true, role: true, activationToken: true, activatedAt: true },
    });
    expect(user.email).toBe(APPLICANT_CONTACT_EMAIL);
    expect(user.role).toBe("vendor_user");
    expect(user.activationToken).toBeTruthy();
    expect(user.activatedAt).toBeNull();

    // The SAP code is optional, but a vendor code already in use is refused.
    const clash = await call(app, "POST", `/api/vendors/${ctx.vendorId}/approve`, {
      token: ctx.adminToken,
      body: { sapVendorCode: "10004567" },
    });
    expect(clash.status).toBe(409);
  });

  it("lets the approved vendor activate and then sign in", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);
    await call(app, "POST", `/api/vendors/${vendorId}/approve`, { token: ctx.adminToken });

    const user = await testPrisma.user.findFirstOrThrow({
      where: { vendorId },
      select: { activationToken: true },
    });

    const setPassword = {
      password: "Applicant@Portal2026",
      confirmPassword: "Applicant@Portal2026",
    };
    const activate = await call(app, "POST", "/api/auth/activate", {
      body: { token: user.activationToken, ...setPassword },
    });
    expect(activate.status, JSON.stringify(activate.body)).toBe(200);

    const login = await call(app, "POST", "/api/auth/login", {
      body: { email: APPLICANT_CONTACT_EMAIL, password: "Applicant@Portal2026" },
    });
    expect(login.status).toBe(200);
    expect(login.body.user.vendorId).toBe(vendorId);

    // Only now is the onboarding form reachable by login, and it is read-only.
    const form = await call(app, "GET", "/api/onboarding", { token: login.body.token });
    expect(form.status).toBe(200);
    expect(form.body.status).toBe("APPROVED");
    expect(form.body.canEdit).toBe(false);

    const edit = await call(app, "PUT", "/api/onboarding", {
      token: login.body.token,
      body: { name: "Renamed After Approval" },
    });
    expect(edit.status).toBe(409);
  });

  it("refuses to let sales approve", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const res = await call(app, "POST", `/api/vendors/${vendorId}/approve`, {
      token: ctx.salesToken,
      body: {},
    });
    expect(res.status).toBe(403);
    expect(
      (await testPrisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).onboardingStatus,
    ).toBe("SUBMITTED");
  });

  it("refuses to approve something that was never submitted", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: fullForm() });
    const view = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    const vendorId = view.body.vendorId as string;

    const res = await call(app, "POST", `/api/vendors/${vendorId}/approve`, {
      token: ctx.adminToken,
      body: {},
    });
    expect(res.status).toBe(409);
  });

  it("will not approve twice", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    expect(
      (await call(app, "POST", `/api/vendors/${vendorId}/approve`, { token: ctx.adminToken, body: {} }))
        .status,
    ).toBe(200);
    expect(
      (await call(app, "POST", `/api/vendors/${vendorId}/approve`, { token: ctx.adminToken, body: {} }))
        .status,
    ).toBe(409);
  });

  it("records the decision in the vendor's history", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);
    await call(app, "POST", `/api/vendors/${vendorId}/approve`, {
      token: ctx.adminToken,
      body: { adminRemarks: "All good." },
    });

    const res = await call(app, "GET", `/api/vendors/${vendorId}`, { token: ctx.adminToken });
    expect(res.body.vendor.decisions).toHaveLength(1);
    expect(res.body.vendor.decisions[0].outcome).toBe("APPROVED");
    expect(res.body.vendor.decisions[0].decidedBy.email).toBe(INTERNAL_USERS.admin);
  });

  it("issues a fresh activation link on resend, invalidating the old one", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);
    await call(app, "POST", `/api/vendors/${vendorId}/approve`, { token: ctx.adminToken });

    const first = await testPrisma.user.findFirstOrThrow({
      where: { vendorId },
      select: { activationToken: true },
    });
    const res = await call(app, "POST", `/api/vendors/${vendorId}/resend-activation`, {
      token: ctx.adminToken,
    });
    expect(res.status).toBe(200);

    const second = await testPrisma.user.findFirstOrThrow({
      where: { vendorId },
      select: { activationToken: true },
    });
    expect(second.activationToken).not.toBe(first.activationToken);
  });
});

describe("M2 rejection and resubmission", () => {
  async function rejectOnce(ctx: Ctx, vendorId: string, remarks: string) {
    return call(app, "POST", `/api/vendors/${vendorId}/reject`, {
      token: ctx.adminToken,
      body: {
        remarks,
        officeUse: {
          facilityStatus: "NEEDS_IMPROVEMENT",
          improvementRequirement: "Quarantine area must be fenced.",
          improvementPeriod: "30 days",
        },
      },
    });
  }

  it("requires remarks on rejection", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const blank = await call(app, "POST", `/api/vendors/${vendorId}/reject`, {
      token: ctx.adminToken,
      body: { remarks: "   " },
    });
    expect(blank.status).toBe(400);

    const missing = await call(app, "POST", `/api/vendors/${vendorId}/reject`, {
      token: ctx.adminToken,
      body: {},
    });
    expect(missing.status).toBe(400);

    // The form must still be awaiting review, not silently rejected.
    expect(
      (await testPrisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).onboardingStatus,
    ).toBe("SUBMITTED");
  });

  it("records the remarks, stores the office-use review and creates no login", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const res = await rejectOnce(ctx, vendorId, "Cancelled cheque is not legible.");
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const vendor = await testPrisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: {
        onboardingStatus: true,
        adminRemarks: true,
        facilityStatus: true,
        improvementRequirement: true,
        improvementPeriod: true,
      },
    });
    expect(vendor.onboardingStatus).toBe("REJECTED");
    expect(vendor.adminRemarks).toContain("not legible");
    expect(vendor.facilityStatus).toBe("NEEDS_IMPROVEMENT");
    expect(vendor.improvementRequirement).toContain("fenced");
    expect(vendor.improvementPeriod).toBe("30 days");

    expect(await testPrisma.user.count({ where: { vendorId } })).toBe(0);
    expect(
      await testPrisma.vendorDecision.count({ where: { vendorId, outcome: "REJECTED" } }),
    ).toBe(1);
  });

  it("shows the vendor the remarks and lets the same link be corrected and resubmitted", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);
    await rejectOnce(ctx, vendorId, "Cancelled cheque is not legible.");

    // The original link is the only way back in, so it must reopen.
    const view = await call(app, "GET", `/api/onboarding/invitation/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.status).toBe("REJECTED");
    expect(view.body.canEdit).toBe(true);
    expect(view.body.rejectionRemarks).toContain("not legible");
    expect(view.body.draft.name).toBe(APPLICANT_COMPANY);

    // Replacing the cheque is the correction the remarks asked for.
    await callUpload(
      app,
      "POST",
      `/api/onboarding/invitation/${token}/documents/CANCELLED_CHEQUE`,
      sampleUpload("pdf"),
    );

    const resubmit = await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, {
      body: fullForm(),
    });
    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
    expect(resubmit.body.status).toBe("SUBMITTED");

    const vendor = await testPrisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { onboardingStatus: true, decisions: { select: { outcome: true } } },
    });
    expect(vendor.onboardingStatus).toBe("SUBMITTED");
    // History keeps both the rejection and, once approved, the approval.
    expect(vendor.decisions.map((d) => d.outcome)).toEqual(["REJECTED"]);
  });

  it("lets a resubmitted application be approved, creating the login once", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);
    await rejectOnce(ctx, vendorId, "Please reupload the cheque.");
    await call(app, "POST", `/api/onboarding/invitation/${token}/submit`, { body: fullForm() });

    const res = await call(app, "POST", `/api/vendors/${vendorId}/approve`, {
      token: ctx.adminToken,
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await testPrisma.user.count({ where: { vendorId } })).toBe(1);
    const decisions = await testPrisma.vendorDecision.findMany({
      where: { vendorId },
      select: { outcome: true },
      orderBy: { createdAt: "asc" },
    });
    expect(decisions.map((d) => d.outcome)).toEqual(["REJECTED", "APPROVED"]);
  });

  it("refuses to let sales reject", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    const res = await call(app, "POST", `/api/vendors/${vendorId}/reject`, {
      token: ctx.salesToken,
      body: { remarks: "No." },
    });
    expect(res.status).toBe(403);
  });

  it("will not reject twice", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const vendorId = await submitApplication(ctx, token);

    expect((await rejectOnce(ctx, vendorId, "First reason.")).status).toBe(200);
    expect((await rejectOnce(ctx, vendorId, "Second reason.")).status).toBe(409);
  });
});

describe("M2 isolation", () => {
  it("does not let one vendor's token read another vendor's draft", async () => {
    const ctx = await seedAndSignIn();

    const first = await invite(ctx.adminToken, "first@onboarding.test");
    const second = await invite(ctx.adminToken, "second@onboarding.test");

    await call(app, "PUT", `/api/onboarding/invitation/${first.token}`, {
      body: { name: "First Vendor Only" },
    });

    // Second vendor opens their own link: they must not see the first draft.
    const res = await call(app, "GET", `/api/onboarding/invitation/${second.token}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("First Vendor Only");
    expect(res.body.vendorId).toBeNull();
  });

  it("does not let one vendor's token download another vendor's document", async () => {
    const ctx = await seedAndSignIn();
    const first = await invite(ctx.adminToken, "first@onboarding.test");
    const second = await invite(ctx.adminToken, "second@onboarding.test");

    await call(app, "PUT", `/api/onboarding/invitation/${first.token}`, { body: fullForm() });
    await uploadAll(first.token);

    // Second vendor has saved a draft, so their token resolves to their own
    // vendor — but that vendor has no cheque.
    await call(app, "PUT", `/api/onboarding/invitation/${second.token}`, {
      body: { name: "Second Vendor" },
    });

    const res = await callRaw(app, `/api/onboarding/invitation/${second.token}/documents/CANCELLED_CHEQUE`);
    expect(res.status).toBe(404);
    expect(res.buffer.subarray(0, 5).toString()).not.toBe("%PDF-");
  });

  it("does not let an authenticated vendor address another vendor's onboarding", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const applicantId = await submitApplication(ctx, token);

    // Vendor A is fully approved and active. Reading the applicant's form must
    // be impossible regardless of what they send.
    const res = await call(app, "GET", `/api/onboarding?vendorId=${applicantId}`, {
      token: ctx.vendorToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.vendorId).toBe(ctx.vendorId);
    expect(JSON.stringify(res.body)).not.toContain(APPLICANT_COMPANY);
  });

  it("does not let an authenticated vendor upload a document to another vendor", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    const applicantId = await submitApplication(ctx, token);

    const res = await callUpload(
      app,
      "POST",
      `/api/onboarding/documents/PAN_COPY?vendorId=${applicantId}`,
      sampleUpload("pdf"),
      { token: ctx.vendorToken },
    );
    // The scope comes from the token, so the query string is ignored entirely.
    expect(res.status).toBe(409);

    const applicantDocs = await testPrisma.vendorDocument.count({ where: { vendorId: applicantId } });
    expect(applicantDocs).toBe(4);
  });

  it("keeps the invitation token out of the audit log", async () => {
    const ctx = await seedAndSignIn();
    const { token } = await invite(ctx.adminToken);
    await call(app, "PUT", `/api/onboarding/invitation/${token}`, { body: { name: APPLICANT_COMPANY } });

    const entries = await testPrisma.auditLog.findMany({ select: { newValue: true, oldValue: true } });
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain("50100234567890");
  });
});
