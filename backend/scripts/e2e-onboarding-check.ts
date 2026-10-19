/**
 * Drives the M2 flow against a *running* dev server, over HTTP, the way the
 * browser does. The Vitest suite covers the same rules against an in-process
 * app; this exists to catch the things it cannot see — routes that were never
 * mounted, a proxy that does not forward, a response shape that drifted from
 * what the frontend reads.
 *
 * Values here are fabricated (brief working rule 3).
 *
 *   npx ts-node scripts/e2e-onboarding-check.ts [baseUrl]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/database";
import { env } from "../src/config/env";
import { signAuthToken } from "../src/utils/jwt";

const BASE = process.argv[2] ?? "http://localhost:4000";
/** Pass --keep to leave the created registration behind for manual poking. */
const KEEP = process.argv.includes("--keep");

const COMPANY = "E2E Check Cranes Pvt Ltd";
const EMAIL = "e2e-applicant@check.test";

interface Res {
  status: number;
  body: any;
}

async function http(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Connection: "close",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** A minimal valid PDF, so multer's magic-byte sniffing accepts the upload. */
function pdfBytes(): Uint8Array {
  return new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  );
}

async function upload(token: string, docType: string): Promise<Res> {
  const form = new FormData();
  form.append("file", new Blob([pdfBytes()], { type: "application/pdf" }), `${docType}.pdf`);
  const res = await fetch(
    `${BASE}/api/onboarding/invitation/${token}/documents/${docType}`,
    { method: "POST", headers: { Connection: "close" }, body: form },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const checks: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function form(overrides: Record<string, unknown> = {}) {
  return {
    name: COMPANY,
    natureOfCompany: "PRIVATE_LTD",
    addressLine1: "14 fabricated industrial lane",
    addressLine2: "",
    city: "Example city",
    district: "Example district",
    stateCode: "GJ",
    pincode: "380001",
    telephone: "+91 9000000001",
    fax: "",
    email: EMAIL,
    weeklyOffDays: "Sunday",
    companySize: "11-50",
    pan: "AAACE1234F",
    tan: "BLRCE4321K",
    gstRegistered: true,
    gstn: "24AAACE1234F1Z5",
    gstRegistrationType: "REGULAR",
    // Left blank on purpose: an unselected optional dropdown must not block submit.
    gstr1FilingFrequency: "",
    cin: "",
    govtRegistrationType: "",
    govtRegistrationNo: "",
    msmeRegistered: false,
    tdsLowerDeduction: false,
    operatingRegions: ["GJ", "MH"],
    contacts: [
      {
        name: "Fabricated Owner",
        mobile: "+91 9000000002",
        telephone: "",
        email: "e2e-owner@check.test",
        isPrimary: true,
        receivesRfqs: false,
      },
    ],
    bankAccountHolderName: COMPANY,
    bankName: "Example Bank",
    bankBranch: "Example Branch",
    bankAccountType: "CURRENT",
    bankAccountNo: "000123456789",
    bankIfsc: "EXAM0000123",
    fleetSummary: "Approx 12 mobile cranes across two categories.",
    codeOfConductAccepted: true,
    declarationName: "Fabricated Owner",
    declarationDesignation: "Director",
    declarationDate: new Date().toISOString().slice(0, 10),
    ...overrides,
  };
}

async function main() {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: "admin@sanghvimovers.com" },
  });
  const sales = await prisma.user.findUniqueOrThrow({
    where: { email: "sales@sanghvimovers.com" },
  });
  const adminToken = signAuthToken({
    sub: admin.id,
    email: admin.email,
    role: admin.role,
    vendorId: admin.vendorId,
  });
  const salesToken = signAuthToken({
    sub: sales.id,
    email: sales.email,
    role: sales.role,
    vendorId: sales.vendorId,
  });

  // 1. Public reference data, no session — the form cannot load states otherwise.
  const ref = await http("GET", "/api/onboarding/reference-data");
  check("public reference data needs no session", ref.status === 200, `HTTP ${ref.status}`);
  check(
    "public reference data exposes states only",
    Object.keys(ref.body ?? {}).join() === "states",
  );

  // 2. Sales may invite.
  const invited = await http("POST", "/api/vendors/invitations", {
    token: salesToken,
    body: { email: EMAIL, companyName: COMPANY, contactName: "Fabricated Owner" },
  });
  check("sales can send an invitation", invited.status === 201, `HTTP ${invited.status}`);
  const token: string = invited.body?.token;
  check("invitation returns a usable token once", typeof token === "string" && token.length > 20);

  // 3. The token, and only the token, opens the form.
  const form0 = await http("GET", `/api/onboarding/invitation/${token}`);
  check("invitation token opens the form", form0.status === 200, `HTTP ${form0.status}`);
  check("a fresh invitation is a DRAFT with no vendor yet", form0.body?.status === "DRAFT");

  // 4. No account exists before approval, and the form is not submittable yet.
  const early = await http("POST", `/api/onboarding/invitation/${token}/submit`, { body: form() });
  check("submit before documents is refused", early.status === 400, `HTTP ${early.status}`);

  // 5. Save a partial draft, then the whole form.
  const partial = await http("PUT", `/api/onboarding/invitation/${token}`, {
    body: { name: COMPANY, telephone: "+91 9000000001" },
  });
  check("a partial draft saves", partial.status === 200, `HTTP ${partial.status}`);
  check("first save creates the vendor row", typeof partial.body?.vendorId === "string");

  const saved = await http("PUT", `/api/onboarding/invitation/${token}`, { body: form() });
  check("the full form saves", saved.status === 200, `HTTP ${saved.status}`);

  // 6. Documents.
  for (const docType of ["CANCELLED_CHEQUE", "PAN_COPY", "DECLARATION_SCAN", "GST_CERTIFICATE"]) {
    const up = await upload(token, docType);
    check(`${docType} uploads`, up.status === 201, `HTTP ${up.status}`);
  }

  // 7. Submit, with the optional dropdowns left blank.
  const submitted = await http("POST", `/api/onboarding/invitation/${token}/submit`, {
    body: form(),
  });
  check(
    "submit succeeds with optional choices blank",
    submitted.status === 200,
    `HTTP ${submitted.status} ${JSON.stringify(submitted.body).slice(0, 160)}`,
  );
  const vendorId: string = submitted.body?.vendorId;

  // 8. Frozen after submit.
  const afterSubmit = await http("PUT", `/api/onboarding/invitation/${token}`, {
    body: { telephone: "+91 9000000999" },
  });
  // 409, not 400: the request is well formed but conflicts with the current state.
  check("the form is frozen after submit", afterSubmit.status === 409, `HTTP ${afterSubmit.status}`);

  // 9. The queue.
  const queue = await http("GET", "/api/vendors?status=SUBMITTED", { token: adminToken });
  check("the vendor is in the submitted queue", queue.status === 200);
  check(
    "the queue lists it",
    (queue.body?.vendors ?? []).some((v: any) => v.id === vendorId),
  );
  check(
    "the queue omits bank values even for an admin",
    !(queue.body?.vendors ?? []).some((v: any) => "bankAccountNo" in v),
  );

  // 10. Detail: sales must not receive the bank block at all.
  const salesDetail = await http("GET", `/api/vendors/${vendorId}`, { token: salesToken });
  check("sales can view the registration", salesDetail.status === 200);
  check("sales is told the bank block is not for them", salesDetail.body?.vendor?.bankVisible === false);
  check(
    "sales receives no decrypted account number",
    !("bankAccountNo" in (salesDetail.body?.vendor ?? {})),
  );
  check("sales may not approve", salesDetail.body?.canApprove === false);

  // 11. Detail: admin does get it, decrypted.
  const adminDetail = await http("GET", `/api/vendors/${vendorId}`, { token: adminToken });
  check("admin may approve", adminDetail.body?.canApprove === true);
  check(
    "admin receives the decrypted account number",
    adminDetail.body?.vendor?.bankAccountNo === "000123456789",
    String(adminDetail.body?.vendor?.bankAccountNo),
  );
  check(
    "no required document is outstanding",
    (adminDetail.body?.missingDocuments ?? []).length === 0,
  );

  // 12. Approval creates the login and flips the status.
  const approved = await http("POST", `/api/vendors/${vendorId}/approve`, {
    token: adminToken,
    body: {
      sapVendorCode: "E2E-0001",
      adminRemarks: "Checked during the end-to-end run.",
      officeUse: { facilityStatus: "ADEQUATE", manpowerStatus: "ADEQUATE" },
    },
  });
  check("approval succeeds", approved.status === 200, `HTTP ${approved.status} ${JSON.stringify(approved.body).slice(0, 160)}`);
  check("approval creates the user account", typeof approved.body?.userId === "string");

  const row = await prisma.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: { onboardingStatus: true, sapVendorCode: true, bankAccountNoLast4: true, gstr1FilingFrequency: true },
  });
  check("status is APPROVED", row.onboardingStatus === "APPROVED");
  check("the SAP code was recorded", row.sapVendorCode === "E2E-0001");
  check("only the last four digits are stored in clear", row.bankAccountNoLast4 === "6789");
  check("a blank optional choice was stored as absent", row.gstr1FilingFrequency === null);

  // 14. Clean up, so the script can be run repeatedly without littering the
  // development database with approved vendors.
  if (!KEEP) {
    await cleanup(vendorId);
    check("the run cleans up after itself", true);
  }

  console.log(checks.join("\n"));
  const passed = checks.filter((c) => c.startsWith("PASS")).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (KEEP) {
    console.log(`\nLeft in place (--keep). Registration link:`);
    console.log(`${BASE.replace(":4000", ":5173")}/onboarding/start?token=${token}`);
  }
}

/**
 * Removes exactly what this run created.
 *
 * The vendor row cascades to its contacts, regions, documents, decisions and
 * the login approval created. Invitations, audit entries and email logs hold
 * loose references rather than cascading, and the uploaded files live on disk,
 * so those are cleared explicitly.
 */
async function cleanup(vendorId: string) {
  const invitation = await prisma.vendorInvitation.findFirst({
    where: { email: EMAIL },
    select: { id: true },
  });

  await prisma.vendorDocument.deleteMany({ where: { vendorId } });
  await prisma.auditLog.deleteMany({ where: { entity: "vendor", entityId: vendorId } });
  await prisma.emailLog.deleteMany({
    where: {
      OR: [
        { entity: "vendor", entityId: vendorId },
        ...(invitation ? [{ entity: "vendor_invitation", entityId: invitation.id }] : []),
      ],
    },
  });
  await prisma.vendor.delete({ where: { id: vendorId } });
  if (invitation) {
    await prisma.vendorInvitation.delete({ where: { id: invitation.id } });
  }

  // Files, not just rows: an orphaned upload is still a real file on disk.
  const dir = path.join(
    env.storage.localDir,
    "vendors",
    vendorId,
    "onboarding",
  );
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(env.storage.localDir, "vendors", vendorId), {
    recursive: true,
    force: true,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
