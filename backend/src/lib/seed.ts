import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { CRANE_TYPES, STATES } from "./referenceData";
import { MOBILISATION_RATES } from "./mobilisationRates";
import { seedMobilisationRates } from "../services/mobilisationCost.service";
import { DEFAULT_EMAIL_TEMPLATES } from "../services/emailTemplates";
import { seedSettings } from "../utils/settings";
import { encryptField, last4 } from "../utils/crypto";

/**
 * Idempotent seed. Running it repeatedly tops up reference data and demo
 * accounts without duplicating anything.
 *
 * All PAN, GSTIN, bank and IFSC values here are fabricated. The sample forms
 * in docs/ carry real ones and must never be copied into code, fixtures or
 * logs (brief working rule 3).
 */

const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });
const prisma = new PrismaClient({ adapter });

async function seedReferenceData() {
  for (const state of STATES) {
    await prisma.state.upsert({
      where: { code: state.code },
      create: state,
      update: { name: state.name, isUnionTerritory: state.isUnionTerritory },
    });
  }
  console.log(`  states: ${STATES.length}`);

  for (const type of CRANE_TYPES) {
    await prisma.craneType.upsert({
      where: { code: type.code },
      create: type,
      update: { name: type.name, sortOrder: type.sortOrder },
    });
  }
  console.log(`  crane types: ${CRANE_TYPES.length}`);

  await seedMobilisationRates(prisma, MOBILISATION_RATES);
  console.log(`  mobilisation rates: ${MOBILISATION_RATES.length}`);
}

async function seedEmailTemplates() {
  for (const template of DEFAULT_EMAIL_TEMPLATES) {
    await prisma.emailTemplate.upsert({
      where: { key: template.key },
      create: template,
      // Intentionally does not overwrite: once someone has customised a
      // template in the UI, re-seeding must not revert their wording.
      update: {},
    });
  }
  console.log(`  email templates: ${DEFAULT_EMAIL_TEMPLATES.length}`);
}

async function seedInternalUsers() {
  const password = await bcrypt.hash("Sml@Portal2026", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@sanghvimovers.com" },
    create: {
      email: "admin@sanghvimovers.com",
      fullName: "Portal Administrator",
      role: "admin_user",
      isActive: true,
    },
    update: { role: "admin_user" },
  });

  const sales = await prisma.user.upsert({
    where: { email: "sales@sanghvimovers.com" },
    create: {
      email: "sales@sanghvimovers.com",
      fullName: "Cross Rental Sales",
      role: "sales_user",
      isActive: true,
    },
    update: { role: "sales_user" },
  });

  console.log(`  internal users: ${admin.email}, ${sales.email} (OTP sign-in)`);
  // The hash is deliberately unused for these accounts: internal users never
  // authenticate with a password. It exists only so a future "switch to
  // password" migration has something to fall back to.
  void password;
}

async function seedDemoVendors() {
  const passwordHash = await bcrypt.hash("Vendor@Portal2026", 12);

  const vendors = [
    {
      sapVendorCode: "10000001",
      name: "M K Hiring (demo)",
      natureOfCompany: "PROPRIETORSHIP" as const,
      registeredAddress: "Plot 14, MIDC Industrial Area, Panvel, Maharashtra 410206",
      telephone: "+91 22 4000 0001",
      email: "vendor1@example.com",
      pan: "AAAAA0000A",
      gstn: "27AAAAA0000A1Z5",
      operatingRegions: ["MH", "GJ"],
      bank: {
        holder: "M K Hiring",
        name: "Demo Bank",
        branch: "Panvel",
        type: "CURRENT" as const,
        accountNo: "00012345678901",
        ifsc: "DEMO0000123",
      },
      declaration: { name: "M K Hiring", designation: "Proprietor" },
    },
    {
      sapVendorCode: "10000002",
      name: "VJ Cranes (demo)",
      natureOfCompany: "PRIVATE_LTD" as const,
      registeredAddress: "Survey 88, Mundra Port Road, Mundra, Gujarat 370410",
      telephone: "+91 2832 000002",
      email: "vendor2@example.com",
      pan: "BBBBB1111B",
      gstn: "24BBBBB1111B1Z2",
      operatingRegions: ["GJ", "RJ", "MH"],
      bank: {
        holder: "VJ Cranes Private Limited",
        name: "Demo Bank",
        branch: "Mundra",
        type: "CURRENT" as const,
        accountNo: "00022345678902",
        ifsc: "DEMO0000456",
      },
      declaration: { name: "R Demo", designation: "Director" },
    },
  ];

  for (const vendor of vendors) {
    const existing = await prisma.vendor.findFirst({
      where: { email: vendor.email },
      select: { id: true },
    });
    if (existing) {
      console.log(`  vendor: ${vendor.name} (already present)`);
      continue;
    }

    const created = await prisma.vendor.create({
      data: {
        sapVendorCode: vendor.sapVendorCode,
        name: vendor.name,
        natureOfCompany: vendor.natureOfCompany,
        addressLine1: vendor.registeredAddress,
        telephone: vendor.telephone,
        email: vendor.email,
        weeklyOffDays: "Sunday",
        pan: vendor.pan,
        gstn: vendor.gstn,
        gstRegistered: true,
        gstRegistrationType: "REGULAR",
        gstr1FilingFrequency: "MONTHLY",
        codeOfConductAccepted: true,
        declarationName: vendor.declaration.name,
        declarationDesignation: vendor.declaration.designation,
        declarationDate: new Date(),
        fleetSummary: "Crawler and tyre mounted cranes, 80T to 2500T",
        onboardingStatus: "APPROVED",
        approvedAt: new Date(),
        bankAccountHolderName: vendor.bank.holder,
        bankName: vendor.bank.name,
        bankBranch: vendor.bank.branch,
        bankAccountType: vendor.bank.type,
        bankAccountNoEnc: encryptField(vendor.bank.accountNo),
        bankAccountNoLast4: last4(vendor.bank.accountNo),
        bankIfscEnc: encryptField(vendor.bank.ifsc),
        operatingRegions: {
          create: vendor.operatingRegions.map((stateCode) => ({ stateCode })),
        },
        contacts: {
          create: [
            {
              name: vendor.declaration.name,
              mobile: "+91 90000 00000",
              email: vendor.email,
              isPrimary: true,
            },
          ],
        },
        users: {
          create: [
            {
              email: vendor.email,
              fullName: vendor.declaration.name,
              role: "vendor_user",
              passwordHash,
              activatedAt: new Date(),
            },
          ],
        },
      },
      select: { id: true, name: true },
    });

    console.log(`  vendor: ${created.name} (${vendor.email})`);
  }
}

async function seedDemoCranes() {
  // Cranes mirroring the shapes in docs/Equipment list format...xlsx, with
  // fabricated serial numbers.
  const rows = [
    {
      vendorEmail: "vendor1@example.com",
      serial: "DEMO-MK-0001",
      type: "CRAWLER",
      capacityT: 400,
      status: "AVAILABLE" as const,
      location: "Amreli",
      stateCode: "GJ",
      make: "XCMG",
      model: "XGC400",
      yom: 2021,
      mainBoomM: 60,
      fixedJibM: 12,
      luffingJibM: 60,
    },
    {
      vendorEmail: "vendor1@example.com",
      serial: "DEMO-MK-0002",
      type: "TYRE_MOUNTED",
      capacityT: 700,
      status: "ENGAGED" as const,
      location: "Kurnool",
      stateCode: "AP",
      make: "SANY",
      model: "SCC7000S",
      yom: 2025,
      mainBoomM: 72,
      fixedJibM: 58,
      luffingJibM: 61,
      windJibM: 20,
      availableFrom: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000),
    },
    {
      vendorEmail: "vendor2@example.com",
      serial: "DEMO-VJ-0001",
      type: "CRAWLER",
      capacityT: 2500,
      status: "AVAILABLE" as const,
      location: "Mundra",
      stateCode: "GJ",
      make: "SANY",
      model: "SCC2600A",
      yom: 2023,
      mainBoomM: 85.5,
      fixedJibM: 31,
      luffingJibM: 58,
    },
    {
      vendorEmail: "vendor2@example.com",
      serial: "DEMO-VJ-0002",
      type: "CRAWLER",
      capacityT: 2500,
      status: "UNDER_MAINTENANCE" as const,
      location: "Rajula",
      stateCode: "GJ",
      make: "SANY",
      model: "SCC2500C",
      yom: 2020,
      mainBoomM: 76,
      luffingJibM: 60,
    },
  ];

  for (const row of rows) {
    const vendor = await prisma.vendor.findFirst({
      where: { email: row.vendorEmail },
      select: { id: true },
    });
    if (!vendor) continue;

    const existing = await prisma.crane.findFirst({
      where: { vendorId: vendor.id, serialRegistrationNo: row.serial },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.crane.create({
      data: {
        vendorId: vendor.id,
        serialRegistrationNo: row.serial,
        typeOfCraneCode: row.type,
        capacityT: row.capacityT,
        currentStatus: row.status,
        currentLocation: row.location,
        stateCode: row.stateCode,
        make: row.make,
        model: row.model,
        yom: row.yom,
        mainBoomM: row.mainBoomM,
        fixedJibM: row.fixedJibM ?? null,
        luffingJibM: row.luffingJibM ?? null,
        windJibM: row.windJibM ?? null,
        availableFrom: row.availableFrom ?? null,
      },
    });
  }

  const counts = await prisma.crane.groupBy({ by: ["vendorId"], _count: { _all: true } });
  for (const group of counts) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: group.vendorId },
      select: { name: true },
    });
    await prisma.vendor.update({
      where: { id: group.vendorId },
      data: { totalFleetSize: group._count._all },
    });
    console.log(`  cranes for ${vendor?.name}: ${group._count._all}`);
  }
}

async function main() {
  console.log("[seed] starting");
  await seedReferenceData();
  await seedEmailTemplates();
  await seedSettings();
  await seedInternalUsers();
  // Demo vendors and cranes exist for local testing. A production deployment
  // sets SEED_DEMO_DATA=false so known demo credentials never reach a server.
  if (process.env["SEED_DEMO_DATA"] === "false") {
    console.log("[seed] skipping demo vendors and cranes");
  } else {
    await seedDemoVendors();
    await seedDemoCranes();
  }
  console.log("[seed] done");
}

main()
  .catch((err) => {
    console.error("[seed] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });