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

  const management = await prisma.user.upsert({
    where: { email: "management@sanghvimovers.com" },
    create: {
      email: "management@sanghvimovers.com",
      fullName: "Management Viewer",
      role: "management_viewer",
      isActive: true,
    },
    update: { role: "management_viewer" },
  });

  console.log(
    `  internal users: ${admin.email}, ${sales.email}, ${management.email} (OTP sign-in)`,
  );
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
      companySize: "MEDIUM",
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
      companySize: "LARGE",
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
    // The three below exist for map and discovery testing: a fleet spread
    // across the west, south and east so the heat layer has real clusters and
    // real empty space between them. Fabricated like the rest.
    {
      sapVendorCode: "10000003",
      name: "Sanghvi Heavy Lift (demo)",
      natureOfCompany: "PRIVATE_LTD" as const,
      registeredAddress: "B/h GIDC Estate, Vatva, Ahmedabad, Gujarat 382445",
      telephone: "+91 79 4000 0003",
      email: "vendor3@example.com",
      pan: "CCCCC2222C",
      gstn: "24CCCCC2222C1Z3",
      companySize: "LARGE",
      operatingRegions: ["GJ", "MH", "MP"],
      bank: {
        holder: "Sanghvi Heavy Lift Private Limited",
        name: "Demo Bank",
        branch: "Vatva",
        type: "CURRENT" as const,
        accountNo: "00032345678903",
        ifsc: "DEMO0000789",
      },
      declaration: { name: "A Demo", designation: "Director" },
    },
    {
      sapVendorCode: "10000004",
      name: "Southline Crane Services (demo)",
      natureOfCompany: "PRIVATE_LTD" as const,
      registeredAddress: "Plot 9, Jeedimetla Industrial Area, Hyderabad, Telangana 500055",
      telephone: "+91 40 4000 0004",
      email: "vendor4@example.com",
      pan: "DDDDD3333D",
      gstn: "36DDDDD3333D1Z4",
      companySize: "LARGE",
      operatingRegions: ["TG", "AP", "KA", "TN", "KL"],
      bank: {
        holder: "Southline Crane Services Private Limited",
        name: "Demo Bank",
        branch: "Jeedimetla",
        type: "CURRENT" as const,
        accountNo: "00042345678904",
        ifsc: "DEMO0000321",
      },
      declaration: { name: "S Demo", designation: "Director" },
    },
    {
      sapVendorCode: "10000005",
      name: "Eastern Lifters (demo)",
      natureOfCompany: "PARTNERSHIP" as const,
      registeredAddress: "12 Strand Road, Kolkata, West Bengal 700001",
      telephone: "+91 33 4000 0005",
      email: "vendor5@example.com",
      pan: "EEEEE4444E",
      gstn: "19EEEEE4444E1Z5",
      companySize: "SMALL",
      operatingRegions: ["WB", "OD", "CG", "AS", "DL", "HR", "UP", "PB"],
      bank: {
        holder: "Eastern Lifters",
        name: "Demo Bank",
        branch: "Strand Road",
        type: "CURRENT" as const,
        accountNo: "00052345678905",
        ifsc: "DEMO0000654",
      },
      declaration: { name: "E Demo", designation: "Partner" },
    },
  ];

  for (const vendor of vendors) {
    const existing = await prisma.vendor.findFirst({
      where: { email: vendor.email },
      select: { id: true, companySize: true },
    });
    if (existing) {
      // Older demo rows were seeded before companySize existed. Fill it in so
      // the discovery filter has something to match, but never overwrite a
      // value someone changed by hand.
      if (!existing.companySize) {
        await prisma.vendor.update({
          where: { id: existing.id },
          data: { companySize: vendor.companySize },
        });
      }
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
        companySize: vendor.companySize,
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
  // A deliberately map-shaped dataset: seven city clusters (Ahmedabad,
  // Vadodara, Pune, Mumbai, Mundra, Hyderabad, Kolkata), a long tail of single
  // cranes, three rows with no coordinate at all, and five whose last status
  // update is past the stale-reminder window. That is enough to see a heat layer
  // distinguish density from distance, to test distance ranking from any site,
  // to test the "location unverified" group and to test the stale reminder.
  //
  // Coordinates are real city positions; make, model and serials are
  // fabricated. A seeded pin is recorded as `manual` because no geocoder
  // produced it — the dataset must work without a Google key.
  const V1 = "vendor1@example.com";
  const V2 = "vendor2@example.com";
  const V3 = "vendor3@example.com";
  const V4 = "vendor4@example.com";
  const V5 = "vendor5@example.com";
  const day = 24 * 60 * 60 * 1000;
  const inDays = (days: number) => new Date(Date.now() + days * day);
  const daysAgo = (days: number) => new Date(Date.now() - days * day);

  type DemoCraneRow = {
    vendorEmail: string;
    serial: string;
    type: string;
    capacityT: number;
    status: "AVAILABLE" | "ENGAGED" | "UNDER_MAINTENANCE";
    location: string;
    stateCode: string;
    latitude: number | null;
    longitude: number | null;
    make: string;
    model: string;
    yom: number;
    mainBoomM?: number;
    fixedJibM?: number;
    luffingJibM?: number;
    windJibM?: number;
    availableFrom?: Date;
    expectedReadyDate?: Date;
    /** Marks the row stale for the 60-day fleet-update reminder. */
    staleDays?: number;
  };

  const rows: DemoCraneRow[] = [
    // --- West: Gujarat, Maharashtra, Madhya Pradesh -------------------------
    { vendorEmail: V1, serial: "DEMO-MK-0101", type: "CRAWLER", capacityT: 400, status: "AVAILABLE", location: "Ahmedabad", stateCode: "GJ", latitude: 23.0225, longitude: 72.5714, make: "XCMG", model: "XGC400", yom: 2021, mainBoomM: 60, fixedJibM: 12, luffingJibM: 60 },
    { vendorEmail: V1, serial: "DEMO-MK-0102", type: "CRAWLER", capacityT: 400, status: "AVAILABLE", location: "Ahmedabad", stateCode: "GJ", latitude: 23.041, longitude: 72.5905, make: "XCMG", model: "XGC400", yom: 2022, mainBoomM: 60, fixedJibM: 12, luffingJibM: 60 },
    { vendorEmail: V1, serial: "DEMO-MK-0103", type: "TYRE_MOUNTED", capacityT: 700, status: "ENGAGED", location: "Vadodara", stateCode: "GJ", latitude: 22.3072, longitude: 73.1812, make: "SANY", model: "SCC7000S", yom: 2025, mainBoomM: 72, fixedJibM: 58, luffingJibM: 61, windJibM: 20, availableFrom: inDays(21) },
    { vendorEmail: V1, serial: "DEMO-MK-0104", type: "ALL_TERRAIN", capacityT: 200, status: "AVAILABLE", location: "Surat", stateCode: "GJ", latitude: 21.1702, longitude: 72.8311, make: "Liebherr", model: "LTM 1200", yom: 2020, mainBoomM: 60 },
    { vendorEmail: V1, serial: "DEMO-MK-0105", type: "CRAWLER", capacityT: 250, status: "AVAILABLE", location: "Rajkot", stateCode: "GJ", latitude: 22.3039, longitude: 70.8022, make: "Zoomlion", model: "ZCC250", yom: 2019, mainBoomM: 55 },
    { vendorEmail: V1, serial: "DEMO-MK-0106", type: "TRUCK_MOUNTED", capacityT: 80, status: "AVAILABLE", location: "Mumbai", stateCode: "MH", latitude: 19.076, longitude: 72.8777, make: "ACE", model: "NX 300", yom: 2021, mainBoomM: 40 },
    { vendorEmail: V1, serial: "DEMO-MK-0107", type: "CRAWLER", capacityT: 600, status: "AVAILABLE", location: "Pune", stateCode: "MH", latitude: 18.5204, longitude: 73.8567, make: "Kobelco", model: "CK1600", yom: 2022, mainBoomM: 70 },
    { vendorEmail: V1, serial: "DEMO-MK-0108", type: "ROUGH_TERRAIN", capacityT: 100, status: "UNDER_MAINTENANCE", location: "Pune", stateCode: "MH", latitude: 18.545, longitude: 73.88, make: "Terex", model: "RT 100", yom: 2018, mainBoomM: 45, expectedReadyDate: inDays(10) },
    { vendorEmail: V1, serial: "DEMO-MK-0109", type: "CRAWLER", capacityT: 800, status: "ENGAGED", location: "Nagpur", stateCode: "MH", latitude: 21.1458, longitude: 79.0882, make: "Manitowoc", model: "18000", yom: 2020, mainBoomM: 80, availableFrom: inDays(30) },
    { vendorEmail: V1, serial: "DEMO-MK-0110", type: "ALL_TERRAIN", capacityT: 300, status: "AVAILABLE", location: "Nashik", stateCode: "MH", latitude: 19.9975, longitude: 73.7898, make: "Liebherr", model: "LTM 1300", yom: 2021, mainBoomM: 60 },
    { vendorEmail: V1, serial: "DEMO-MK-0111", type: "MINI_CRAWLER", capacityT: 50, status: "AVAILABLE", location: "Panvel", stateCode: "MH", latitude: 18.9894, longitude: 73.1175, make: "Maeda", model: "MC 405", yom: 2022, mainBoomM: 25 },
    { vendorEmail: V1, serial: "DEMO-MK-0112", type: "CRAWLER", capacityT: 400, status: "AVAILABLE", location: "Indore", stateCode: "MP", latitude: 22.7196, longitude: 75.8577, make: "XCMG", model: "XGC400", yom: 2020, mainBoomM: 60, staleDays: 75 },
    { vendorEmail: V1, serial: "DEMO-MK-0113", type: "TOWER", capacityT: 40, status: "AVAILABLE", location: "Bhopal", stateCode: "MP", latitude: 23.2599, longitude: 77.4126, make: "Potain", model: "MC 85", yom: 2019, mainBoomM: 50 },
    { vendorEmail: V1, serial: "DEMO-MK-0114", type: "CRAWLER", capacityT: 2500, status: "AVAILABLE", location: "Mundra", stateCode: "GJ", latitude: 22.8396, longitude: 69.7219, make: "SANY", model: "SCC2600A", yom: 2023, mainBoomM: 85.5, fixedJibM: 31, luffingJibM: 58 },
    { vendorEmail: V1, serial: "DEMO-MK-0115", type: "TRACTOR_MOUNTED", capacityT: 25, status: "AVAILABLE", location: "Rajula", stateCode: "GJ", latitude: 21.05, longitude: 71.4318, make: "Escorts", model: "25T", yom: 2018, mainBoomM: 20 },

    // --- West: VJ Cranes ----------------------------------------------------
    { vendorEmail: V2, serial: "DEMO-VJ-0101", type: "CRAWLER", capacityT: 2500, status: "AVAILABLE", location: "Mundra", stateCode: "GJ", latitude: 22.8396, longitude: 69.7219, make: "SANY", model: "SCC2600A", yom: 2023, mainBoomM: 85.5, fixedJibM: 31, luffingJibM: 58 },
    { vendorEmail: V2, serial: "DEMO-VJ-0102", type: "CRAWLER", capacityT: 2500, status: "AVAILABLE", location: "Mundra", stateCode: "GJ", latitude: 22.848, longitude: 69.735, make: "SANY", model: "SCC2600A", yom: 2022, mainBoomM: 85.5, luffingJibM: 58 },
    { vendorEmail: V2, serial: "DEMO-VJ-0103", type: "CRAWLER", capacityT: 1200, status: "AVAILABLE", location: "Kandla", stateCode: "GJ", latitude: 23.008, longitude: 70.217, make: "Kobelco", model: "CK2000", yom: 2021, mainBoomM: 75, staleDays: 33 },
    { vendorEmail: V2, serial: "DEMO-VJ-0104", type: "TYRE_MOUNTED", capacityT: 700, status: "AVAILABLE", location: "Jamnagar", stateCode: "GJ", latitude: 22.4707, longitude: 70.0577, make: "SANY", model: "SCC7000S", yom: 2024, mainBoomM: 72 },
    { vendorEmail: V2, serial: "DEMO-VJ-0105", type: "ALL_TERRAIN", capacityT: 400, status: "AVAILABLE", location: "Jaipur", stateCode: "RJ", latitude: 26.9124, longitude: 75.7873, make: "Liebherr", model: "LTM 1400", yom: 2020, mainBoomM: 60 },
    { vendorEmail: V2, serial: "DEMO-VJ-0106", type: "CRAWLER", capacityT: 600, status: "AVAILABLE", location: "Jodhpur", stateCode: "RJ", latitude: 26.2389, longitude: 73.0243, make: "Kobelco", model: "CK1600", yom: 2019, mainBoomM: 70, staleDays: 65 },
    { vendorEmail: V2, serial: "DEMO-VJ-0107", type: "TRUCK_MOUNTED", capacityT: 100, status: "AVAILABLE", location: "Udaipur", stateCode: "RJ", latitude: 24.5854, longitude: 73.7125, make: "ACE", model: "NX 400", yom: 2021, mainBoomM: 40 },
    { vendorEmail: V2, serial: "DEMO-VJ-0108", type: "CRAWLER", capacityT: 800, status: "AVAILABLE", location: "Bhavnagar", stateCode: "GJ", latitude: 21.7645, longitude: 72.1519, make: "Manitowoc", model: "16000", yom: 2020, mainBoomM: 80 },
    { vendorEmail: V2, serial: "DEMO-VJ-0109", type: "ROUGH_TERRAIN", capacityT: 60, status: "UNDER_MAINTENANCE", location: "Rajkot", stateCode: "GJ", latitude: 22.32, longitude: 70.79, make: "Terex", model: "RT 60", yom: 2017, mainBoomM: 35, expectedReadyDate: inDays(5) },
    { vendorEmail: V2, serial: "DEMO-VJ-0110", type: "CRAWLER", capacityT: 300, status: "AVAILABLE", location: "Mumbai", stateCode: "MH", latitude: 19.076, longitude: 72.8777, make: "Zoomlion", model: "ZCC300", yom: 2021, mainBoomM: 55 },
    { vendorEmail: V2, serial: "DEMO-VJ-0111", type: "MINI_CRAWLER", capacityT: 30, status: "AVAILABLE", location: "Surat", stateCode: "GJ", latitude: 21.18, longitude: 72.84, make: "Maeda", model: "MC 305", yom: 2020, mainBoomM: 20 },
    { vendorEmail: V2, serial: "DEMO-VJ-0112", type: "CRAWLER", capacityT: 1600, status: "AVAILABLE", location: "Vadodara", stateCode: "GJ", latitude: 22.31, longitude: 73.19, make: "Kobelco", model: "CK2500", yom: 2022, mainBoomM: 80 },

    // --- West: Sanghvi Heavy Lift ------------------------------------------
    { vendorEmail: V3, serial: "DEMO-SH-0101", type: "CRAWLER", capacityT: 1200, status: "AVAILABLE", location: "Ahmedabad", stateCode: "GJ", latitude: 23.03, longitude: 72.58, make: "Kobelco", model: "CK2000", yom: 2022, mainBoomM: 75 },
    { vendorEmail: V3, serial: "DEMO-SH-0102", type: "CRAWLER", capacityT: 1200, status: "AVAILABLE", location: "Ahmedabad", stateCode: "GJ", latitude: 23.05, longitude: 72.6, make: "Kobelco", model: "CK2000", yom: 2021, mainBoomM: 75 },
    { vendorEmail: V3, serial: "DEMO-SH-0103", type: "CRAWLER", capacityT: 1600, status: "AVAILABLE", location: "Vadodara", stateCode: "GJ", latitude: 22.3, longitude: 73.17, make: "Kobelco", model: "CK2500", yom: 2022, mainBoomM: 80 },
    { vendorEmail: V3, serial: "DEMO-SH-0104", type: "ALL_TERRAIN", capacityT: 500, status: "AVAILABLE", location: "Pune", stateCode: "MH", latitude: 18.53, longitude: 73.87, make: "Liebherr", model: "LTM 1500", yom: 2021, mainBoomM: 60 },
    { vendorEmail: V3, serial: "DEMO-SH-0105", type: "TYRE_MOUNTED", capacityT: 900, status: "AVAILABLE", location: "Pune", stateCode: "MH", latitude: 18.51, longitude: 73.84, make: "SANY", model: "SCC9000", yom: 2023, mainBoomM: 72 },
    { vendorEmail: V3, serial: "DEMO-SH-0106", type: "CRAWLER", capacityT: 300, status: "AVAILABLE", location: "Nagpur", stateCode: "MH", latitude: 21.15, longitude: 79.09, make: "Zoomlion", model: "ZCC300", yom: 2020, mainBoomM: 55, staleDays: 95 },
    { vendorEmail: V3, serial: "DEMO-SH-0107", type: "TRUCK_MOUNTED", capacityT: 75, status: "AVAILABLE", location: "Indore", stateCode: "MP", latitude: 22.73, longitude: 75.87, make: "ACE", model: "NX 250", yom: 2019, mainBoomM: 40 },
    { vendorEmail: V3, serial: "DEMO-SH-0108", type: "CRAWLER", capacityT: 700, status: "AVAILABLE", location: "Surat", stateCode: "GJ", latitude: 21.16, longitude: 72.82, make: "Kobelco", model: "CK1600", yom: 2021, mainBoomM: 70 },
    { vendorEmail: V3, serial: "DEMO-SH-0109", type: "ROUGH_TERRAIN", capacityT: 150, status: "AVAILABLE", location: "Mumbai", stateCode: "MH", latitude: 19.09, longitude: 72.89, make: "Terex", model: "RT 150", yom: 2020, mainBoomM: 45 },
    { vendorEmail: V3, serial: "DEMO-SH-0110", type: "MINI_CRAWLER", capacityT: 60, status: "AVAILABLE", location: "Vadodara", stateCode: "GJ", latitude: 22.32, longitude: 73.19, make: "Maeda", model: "MC 405", yom: 2022, mainBoomM: 25 },

    // --- South: Southline Crane Services -----------------------------------
    { vendorEmail: V4, serial: "DEMO-SL-0101", type: "CRAWLER", capacityT: 800, status: "AVAILABLE", location: "Hyderabad", stateCode: "TG", latitude: 17.385, longitude: 78.4867, make: "Manitowoc", model: "16000", yom: 2021, mainBoomM: 80 },
    { vendorEmail: V4, serial: "DEMO-SL-0102", type: "CRAWLER", capacityT: 800, status: "AVAILABLE", location: "Hyderabad", stateCode: "TG", latitude: 17.4, longitude: 78.5, make: "Manitowoc", model: "16000", yom: 2022, mainBoomM: 80 },
    { vendorEmail: V4, serial: "DEMO-SL-0103", type: "CRAWLER", capacityT: 1200, status: "AVAILABLE", location: "Vijayawada", stateCode: "AP", latitude: 16.5062, longitude: 80.648, make: "Kobelco", model: "CK2000", yom: 2020, mainBoomM: 75 },
    { vendorEmail: V4, serial: "DEMO-SL-0104", type: "TYRE_MOUNTED", capacityT: 400, status: "AVAILABLE", location: "Visakhapatnam", stateCode: "AP", latitude: 17.6868, longitude: 83.2185, make: "SANY", model: "SCC4000", yom: 2021, mainBoomM: 72 },
    { vendorEmail: V4, serial: "DEMO-SL-0105", type: "ALL_TERRAIN", capacityT: 250, status: "AVAILABLE", location: "Bengaluru", stateCode: "KA", latitude: 12.9716, longitude: 77.5946, make: "Liebherr", model: "LTM 1250", yom: 2022, mainBoomM: 60 },
    { vendorEmail: V4, serial: "DEMO-SL-0106", type: "CRAWLER", capacityT: 600, status: "AVAILABLE", location: "Chennai", stateCode: "TN", latitude: 13.0827, longitude: 80.2707, make: "Kobelco", model: "CK1600", yom: 2020, mainBoomM: 70 },
    { vendorEmail: V4, serial: "DEMO-SL-0107", type: "TRUCK_MOUNTED", capacityT: 100, status: "AVAILABLE", location: "Coimbatore", stateCode: "TN", latitude: 11.0168, longitude: 76.9558, make: "ACE", model: "NX 400", yom: 2021, mainBoomM: 40 },
    { vendorEmail: V4, serial: "DEMO-SL-0108", type: "CRAWLER", capacityT: 400, status: "AVAILABLE", location: "Hubballi", stateCode: "KA", latitude: 15.3647, longitude: 75.124, make: "XCMG", model: "XGC400", yom: 2019, mainBoomM: 60, staleDays: 80 },
    { vendorEmail: V4, serial: "DEMO-SL-0109", type: "ROUGH_TERRAIN", capacityT: 80, status: "AVAILABLE", location: "Mangaluru", stateCode: "KA", latitude: 12.9141, longitude: 74.856, make: "Terex", model: "RT 80", yom: 2018, mainBoomM: 35 },
    { vendorEmail: V4, serial: "DEMO-SL-0110", type: "MINI_CRAWLER", capacityT: 50, status: "AVAILABLE", location: "Kochi", stateCode: "KL", latitude: 9.9312, longitude: 76.2673, make: "Maeda", model: "MC 405", yom: 2021, mainBoomM: 25 },
    // Nothing at all is known about this one's position.
    { vendorEmail: V4, serial: "DEMO-SL-0111", type: "CRAWLER", capacityT: 300, status: "AVAILABLE", location: "Kurnool", stateCode: "AP", latitude: null, longitude: null, make: "Zoomlion", model: "ZCC300", yom: 2020, mainBoomM: 55 },
    { vendorEmail: V4, serial: "DEMO-SL-0112", type: "CRAWLER", capacityT: 450, status: "AVAILABLE", location: "Mysuru", stateCode: "KA", latitude: 12.2958, longitude: 76.6394, make: "XCMG", model: "XGC450", yom: 2021, mainBoomM: 60 },

    // --- East and North: Eastern Lifters -----------------------------------
    { vendorEmail: V5, serial: "DEMO-EL-0101", type: "CRAWLER", capacityT: 600, status: "AVAILABLE", location: "Kolkata", stateCode: "WB", latitude: 22.5726, longitude: 88.3639, make: "Kobelco", model: "CK1600", yom: 2021, mainBoomM: 70 },
    { vendorEmail: V5, serial: "DEMO-EL-0102", type: "CRAWLER", capacityT: 600, status: "AVAILABLE", location: "Kolkata", stateCode: "WB", latitude: 22.59, longitude: 88.38, make: "Kobelco", model: "CK1600", yom: 2022, mainBoomM: 70 },
    { vendorEmail: V5, serial: "DEMO-EL-0103", type: "TYRE_MOUNTED", capacityT: 300, status: "AVAILABLE", location: "Haldia", stateCode: "WB", latitude: 22.0667, longitude: 88.0698, make: "SANY", model: "SCC3000", yom: 2020, mainBoomM: 72 },
    { vendorEmail: V5, serial: "DEMO-EL-0104", type: "CRAWLER", capacityT: 400, status: "AVAILABLE", location: "Bhubaneswar", stateCode: "OD", latitude: 20.2961, longitude: 85.8245, make: "XCMG", model: "XGC400", yom: 2020, mainBoomM: 60 },
    { vendorEmail: V5, serial: "DEMO-EL-0105", type: "ALL_TERRAIN", capacityT: 200, status: "AVAILABLE", location: "Paradip", stateCode: "OD", latitude: 20.3164, longitude: 86.6114, make: "Liebherr", model: "LTM 1200", yom: 2019, mainBoomM: 60 },
    { vendorEmail: V5, serial: "DEMO-EL-0106", type: "TRUCK_MOUNTED", capacityT: 90, status: "AVAILABLE", location: "Raipur", stateCode: "CG", latitude: 21.2514, longitude: 81.6296, make: "ACE", model: "NX 300", yom: 2021, mainBoomM: 40 },
    { vendorEmail: V5, serial: "DEMO-EL-0107", type: "CRAWLER", capacityT: 250, status: "AVAILABLE", location: "Guwahati", stateCode: "AS", latitude: 26.1445, longitude: 91.7362, make: "Zoomlion", model: "ZCC250", yom: 2020, mainBoomM: 55 },
    { vendorEmail: V5, serial: "DEMO-EL-0108", type: "MINI_CRAWLER", capacityT: 40, status: "AVAILABLE", location: "Kolkata", stateCode: "WB", latitude: 22.56, longitude: 88.35, make: "Maeda", model: "MC 285", yom: 2019, mainBoomM: 20 },
    { vendorEmail: V5, serial: "DEMO-EL-0109", type: "CRAWLER", capacityT: 1000, status: "AVAILABLE", location: "New Delhi", stateCode: "DL", latitude: 28.6139, longitude: 77.209, make: "Kobelco", model: "CK2000", yom: 2022, mainBoomM: 75 },
    { vendorEmail: V5, serial: "DEMO-EL-0110", type: "ALL_TERRAIN", capacityT: 300, status: "AVAILABLE", location: "Gurugram", stateCode: "HR", latitude: 28.4595, longitude: 77.0266, make: "Liebherr", model: "LTM 1300", yom: 2021, mainBoomM: 60 },
    { vendorEmail: V5, serial: "DEMO-EL-0111", type: "TOWER", capacityT: 50, status: "AVAILABLE", location: "Noida", stateCode: "UP", latitude: 28.5355, longitude: 77.391, make: "Potain", model: "MC 120", yom: 2020, mainBoomM: 55 },
    { vendorEmail: V5, serial: "DEMO-EL-0112", type: "CRAWLER", capacityT: 450, status: "AVAILABLE", location: "Ludhiana", stateCode: "PB", latitude: 30.901, longitude: 75.8573, make: "XCMG", model: "XGC450", yom: 2020, mainBoomM: 60 },
    { vendorEmail: V5, serial: "DEMO-EL-0113", type: "CRAWLER", capacityT: 200, status: "AVAILABLE", location: "Chandigarh", stateCode: "CH", latitude: null, longitude: null, make: "XCMG", model: "XGC200", yom: 2019, mainBoomM: 50 },
    { vendorEmail: V5, serial: "DEMO-EL-0114", type: "CRAWLER", capacityT: 150, status: "AVAILABLE", location: "Jamshedpur", stateCode: "JH", latitude: 22.8046, longitude: 86.2029, make: "XCMG", model: "XGC150", yom: 2019, mainBoomM: 50 },
  ];

  for (const row of rows) {
    const vendor = await prisma.vendor.findFirst({
      where: { email: row.vendorEmail },
      select: { id: true },
    });
    if (!vendor) continue;

    const existing = await prisma.crane.findFirst({
      where: { vendorId: vendor.id, serialRegistrationNo: row.serial },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        coordinateSource: true,
        statusUpdatedAt: true,
      },
    });
    if (existing) {
      // A pin that a geocoder produced (`auto`) is left alone — the vendor's
      // real location beats a demo city. A `manual` pin belongs to this seed, so
      // a corrected coordinate in the list replaces the one already stored; that
      // is what makes the dataset reproducible instead of frozen at whatever an
      // earlier seed run happened to write.
      const needsPin =
        row.latitude !== null &&
        row.longitude !== null &&
        (existing.latitude === null ||
          (existing.coordinateSource === "manual" &&
            (Math.abs(Number(existing.latitude) - row.latitude) > 0.0001 ||
              existing.longitude === null ||
              Math.abs(Number(existing.longitude) - row.longitude) > 0.0001)));
      if (needsPin) {
        await prisma.crane.update({
          where: { id: existing.id },
          data: {
            latitude: row.latitude,
            longitude: row.longitude,
            coordinateSource: "manual",
          },
        });
      }
      // The stale-reminder demo needs a predictable spread of ages, so a row in
      // this list keeps the age the seed declares. Running the seed is an
      // explicit act; it is allowed to reset these five demo rows.
      if (row.staleDays) {
        const intended = daysAgo(row.staleDays);
        if (existing.statusUpdatedAt.getTime() !== intended.getTime()) {
          await prisma.crane.update({
            where: { id: existing.id },
            data: { statusUpdatedAt: intended },
          });
        }
      }
      continue;
    }

    const coordinates =
      row.latitude !== null && row.longitude !== null
        ? {
            latitude: row.latitude,
            longitude: row.longitude,
            coordinateSource: "manual" as const,
          }
        : { latitude: null, longitude: null, coordinateSource: null };

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
        mainBoomM: row.mainBoomM ?? null,
        fixedJibM: row.fixedJibM ?? null,
        luffingJibM: row.luffingJibM ?? null,
        windJibM: row.windJibM ?? null,
        ...coordinates,
        availableFrom: row.availableFrom ?? null,
        expectedReadyDate: row.expectedReadyDate ?? null,
        ...(row.staleDays ? { statusUpdatedAt: daysAgo(row.staleDays) } : {}),
      },
    });
  }

  // Four cranes from the first demo seed are still present in older local
  // databases, and while the Google geocoder was being tested two of them were
  // given a location text and a pin from different cities. A demo map with a
  // marker in the sea is worse than no demo map, so those serials are pinned to
  // one known position here. The comparison means an already-correct row costs
  // nothing and a re-run reports no change; the fourth (DEMO-MK-0002) has a
  // location but no pin, and stays that way as the inactive example.
  const legacyPositions = [
    { serial: "DEMO-MK-0001", location: "Rajula", latitude: 21.05, longitude: 71.4318 },
    { serial: "DEMO-VJ-0001", location: "Mundra", latitude: 22.8396, longitude: 69.7219 },
    { serial: "DEMO-VJ-0002", location: "Rajula", latitude: 21.05, longitude: 71.4318 },
  ];
  for (const fix of legacyPositions) {
    const crane = await prisma.crane.findFirst({
      where: { serialRegistrationNo: fix.serial },
      select: { id: true, currentLocation: true, latitude: true, longitude: true },
    });
    if (!crane) continue;
    const sameLocation = crane.currentLocation?.trim() === fix.location;
    const samePin =
      crane.latitude !== null &&
      crane.longitude !== null &&
      Math.abs(Number(crane.latitude) - fix.latitude) < 0.001 &&
      Math.abs(Number(crane.longitude) - fix.longitude) < 0.001;
    if (sameLocation && samePin) continue;
    await prisma.crane.update({
      where: { id: crane.id },
      data: {
        currentLocation: fix.location,
        latitude: fix.latitude,
        longitude: fix.longitude,
        coordinateSource: "manual",
        geocodedBy: null,
        geocodedAt: null,
      },
    });
    console.log(`  legacy crane reset: ${fix.serial} → ${fix.location}`);
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

/**
 * Demo bookings for the calendar (P2, brief 6.17).
 *
 * The calendar paints crane × day, so a dataset with no reservations shows an
 * empty grid: every cell reads "free" and the one thing the screen exists to
 * show never appears. These rows are relative to the seed date, deliberately
 * straddling today and the month boundaries, so the grid has hired, reserved,
 * blocked and free days whichever month is opened.
 *
 * A booking that started in the past reads HIRED and one that starts later
 * reads RESERVED — that split is derived on read, not stored, so the same row
 * changes meaning as time passes.
 *
 * Idempotence is by overlap, not by identity: the seed never owns these rows,
 * so an ACTIVE reservation already covering the window means someone (or an
 * earlier seed run) has booked that crane, and the row is left alone.
 */
async function seedDemoBookings() {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const at = (offset: number) => new Date(startOfToday.getTime() + offset * day);

  const admin = await prisma.user.findUnique({
    where: { email: "admin@sanghvimovers.com" },
    select: { id: true },
  });
  if (!admin) return;

  // [serial, start offset in days, end offset in days, type]
  const bookings: Array<[string, number, number, "BOOKED" | "BLOCKED"]> = [
    // Running now: the two cranes the fleet data already calls ENGAGED, with
    // their end dates matching the `availableFrom` those rows declare.
    ["DEMO-MK-0103", -9, 21, "BOOKED"],
    ["DEMO-MK-0109", -6, 30, "BOOKED"],
    ["DEMO-VJ-0101", -2, 12, "BOOKED"],
    ["DEMO-SL-0101", -1, 9, "BOOKED"],
    ["DEMO-MK-0107", -12, 3, "BOOKED"],
    // Finished earlier this month, still ACTIVE until released.
    ["DEMO-MK-0101", -18, -4, "BOOKED"],
    ["DEMO-SH-0108", -25, -8, "BOOKED"],
    // Starting later this month, and into the next.
    ["DEMO-SH-0101", 5, 16, "BOOKED"],
    ["DEMO-EL-0101", 2, 11, "BOOKED"],
    ["DEMO-VJ-0112", 18, 25, "BOOKED"],
    ["DEMO-MK-0114", 24, 40, "BOOKED"],
    // Maintenance holds: no customer behind them, so they read BLOCKED.
    ["DEMO-MK-0113", 3, 6, "BLOCKED"],
    ["DEMO-SH-0110", -3, 2, "BLOCKED"],
    ["DEMO-EL-0107", 9, 13, "BLOCKED"],
  ];

  let created = 0;
  let skipped = 0;
  for (const [serial, startOffset, endOffset, type] of bookings) {
    const crane = await prisma.crane.findFirst({
      where: { serialRegistrationNo: serial },
      select: { id: true },
    });
    if (!crane) continue;

    const startDate = at(startOffset);
    const endDate = at(endOffset);
    const overlap = await prisma.reservation.findFirst({
      where: {
        craneId: crane.id,
        status: "ACTIVE",
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      select: { id: true },
    });
    if (overlap) {
      skipped += 1;
      continue;
    }

    await prisma.reservation.create({
      data: {
        craneId: crane.id,
        startDate,
        endDate,
        type,
        status: "ACTIVE",
        createdById: admin.id,
      },
    });
    created += 1;
  }

  console.log(`  demo bookings: ${created} created, ${skipped} already covered`);
}

/**
 * Demo enquiries with lines still in sourcing.
 *
 * The RFQ flow is line-driven, so a fresh database with no open line leaves the
 * "Raise RFQ" picker empty and the whole sourcing journey unreachable. These are
 * deliberately in the early trail states (`NEW` / `Availability Check`) and use
 * fabricated customer names, addresses and budgets like every other fixture.
 *
 * Idempotent on `enquiryNo`: re-seeding never duplicates them, and the 9000
 * series cannot collide with the `CR-YYYY-NNNN` sequence that manual intake uses.
 */
async function seedDemoEnquiries() {
  const day = 24 * 60 * 60 * 1000;
  const at = (offset: number) => new Date(Date.now() + offset * day);

  const admin = await prisma.user.findUnique({
    where: { email: "admin@sanghvimovers.com" },
    select: { id: true },
  });
  if (!admin) return;

  const demos = [
    {
      enquiryNo: "CR-2026-9001",
      customerName: "Sanghvi Movers Ltd (demo)",
      customerAddress: "Plot 12, GIDC Estate, Vadodara, Gujarat 390010",
      siteLocation: "Vadodara, Gujarat",
      siteStateCode: "GJ",
      sitePincode: "390010",
      lines: [
        {
          lineNo: 1,
          craneTypeCode: "CRAWLER",
          capacityT: 250,
          quantity: 1,
          applicationDescription: "Erecting a 60 m lattice tower at the plant's new furnace line",
          loadDescription: "Base section, 40 t at 20 m radius",
          requiredStartDate: at(21),
          durationValue: 3,
          durationUnit: "MONTHS" as const,
          workingDaysPerMonth: 26,
          configurationNotes: "Main boom 60 m, luffing jib 50 m",
          trailStatus: "AVAILABILITY_CHECK" as const,
        },
        {
          lineNo: 2,
          craneTypeCode: "ALL_TERRAIN",
          capacityT: 100,
          quantity: 2,
          applicationDescription: "Shutdown maintenance lifts across two process units",
          loadDescription: "Heat exchangers, 18 t at 12 m radius",
          requiredStartDate: at(35),
          durationValue: 45,
          durationUnit: "DAYS" as const,
          configurationNotes: "Main boom 40 m",
          trailStatus: "NEW" as const,
        },
      ],
    },
    {
      enquiryNo: "CR-2026-9002",
      customerName: "Coastal Refinery Services (demo)",
      customerAddress: "Survey 44, Moti Khavdi, Jamnagar, Gujarat 361140",
      siteLocation: "Jamnagar, Gujarat",
      siteStateCode: "GJ",
      sitePincode: "361140",
      lines: [
        {
          lineNo: 1,
          craneTypeCode: "CRAWLER",
          capacityT: 400,
          quantity: 1,
          applicationDescription: "Reactor replacement at the hydrocracker unit",
          loadDescription: "Reactor shell, 210 t at 18 m radius",
          requiredStartDate: at(60),
          durationValue: 2,
          durationUnit: "MONTHS" as const,
          workingDaysPerMonth: 26,
          configurationNotes: "Main boom 84 m, luffing jib 60 m",
          trailStatus: "VENDOR_SHORTLISTED" as const,
        },
      ],
    },
  ];

  let created = 0;
  for (const demo of demos) {
    const existing = await prisma.enquiry.findUnique({
      where: { enquiryNo: demo.enquiryNo },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.enquiry.create({
      data: {
        enquiryNo: demo.enquiryNo,
        enquiryDate: at(-3),
        customerName: demo.customerName,
        customerAddress: demo.customerAddress,
        siteLocation: demo.siteLocation,
        siteStateCode: demo.siteStateCode,
        sitePincode: demo.sitePincode,
        createdById: admin.id,
        lines: {
          create: demo.lines.map((line) => ({
            ...line,
            otCharges: "As per agreement",
            breakdownTerms: "As per agreement",
            dieselScope: "To SML",
            workingHoursShift: "8 hours per shift",
            paymentTerms: "30 days from invoice",
            mobilisationTerms: "Lump sum, per mobilisation rate card",
            demobilisationTerms: "Lump sum, per mobilisation rate card",
            // Internal only, and never copied into an RFQ.
            rentalBudget: "Commercials held by Sales",
          })),
        },
      },
    });
    created += 1;
  }

  console.log(`  demo enquiries: ${created} created`);
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
    await seedDemoBookings();
    await seedDemoEnquiries();
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