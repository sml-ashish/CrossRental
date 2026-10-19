import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { listCranes, type Actor, type CraneView } from "./crane.service";
import { participationByVendor, type VendorParticipation } from "./recommendation.service";

/**
 * The vendor detail screen (BPD 6.10).
 *
 * The approval detail (`GET /api/vendors/:vendorId`) already carries the
 * registration form and — for admins — the bank block. This adds the discovery
 * view the brief asks for: the fleet and its availability, the categories the
 * vendor covers, and the participation numbers (invitations / quoted /
 * awarded with responsiveness and win ratio). Participation is BPD 6.7's
 * "from RFQ participation" figure, deliberately not a performance score.
 *
 * Bank details are not selected here at all, so a sales user cannot reach them
 * through this endpoint even by accident.
 */

export interface VendorInsights {
  vendor: {
    id: string;
    name: string | null;
    sapVendorCode: string | null;
    natureOfCompany: string | null;
    city: string | null;
    district: string | null;
    stateCode: string | null;
    stateName: string | null;
    companySize: string | null;
    totalFleetSize: number;
    onboardingStatus: string;
    approvedAt: string | null;
    suspendedAt: string | null;
    communicationNotes: string | null;
    operatingRegions: string[];
  };
  contacts: Array<{
    id: string;
    name: string;
    mobile: string;
    telephone: string | null;
    email: string | null;
    isPrimary: boolean;
    receivesRfqs: boolean;
  }>;
  categories: Array<{ code: string; name: string }>;
  /** The vendor's live cranes, reusing the fleet read (approved vendor only). */
  fleet: CraneView[];
  participation: VendorParticipation;
  rfqsReceived: number;
  quotationsSubmitted: number;
}

function assertInternal(actor: Actor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Vendor detail is available to SML staff only");
  }
}

export async function vendorInsights(actor: Actor, vendorId: string): Promise<VendorInsights> {
  assertInternal(actor);

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      id: true,
      name: true,
      sapVendorCode: true,
      natureOfCompany: true,
      city: true,
      district: true,
      stateCode: true,
      addressState: { select: { name: true } },
      companySize: true,
      totalFleetSize: true,
      onboardingStatus: true,
      approvedAt: true,
      suspendedAt: true,
      communicationNotes: true,
      operatingRegions: { select: { stateCode: true } },
      contacts: {
        select: {
          id: true,
          name: true,
          mobile: true,
          telephone: true,
          email: true,
          isPrimary: true,
          receivesRfqs: true,
        },
        orderBy: { isPrimary: "desc" },
      },
      cranes: {
        where: { isActive: true },
        select: { typeOfCraneCode: true, typeOfCrane: { select: { name: true } } },
      },
    },
  });

  if (!vendor) throw AppError.notFound("Vendor not found");

  const [fleet, participationMap, rfqsReceived, quotationsSubmitted] = await Promise.all([
    listCranes({ includeInactive: false }, actor, vendorId),
    participationByVendor([vendorId]),
    prisma.rfqVendorRecipient.count({ where: { vendorId } }),
    prisma.quotation.count({
      where: { vendorId, isLatest: true, status: { not: "WITHDRAWN" } },
    }),
  ]);

  const categoryMap = new Map<string, string>();
  for (const crane of vendor.cranes) {
    categoryMap.set(crane.typeOfCraneCode, crane.typeOfCrane.name);
  }

  return {
    vendor: {
      id: vendor.id,
      name: vendor.name,
      sapVendorCode: vendor.sapVendorCode,
      natureOfCompany: vendor.natureOfCompany,
      city: vendor.city,
      district: vendor.district,
      stateCode: vendor.stateCode,
      stateName: vendor.addressState?.name ?? null,
      companySize: vendor.companySize,
      totalFleetSize: vendor.totalFleetSize,
      onboardingStatus: vendor.onboardingStatus,
      approvedAt: vendor.approvedAt ? vendor.approvedAt.toISOString() : null,
      suspendedAt: vendor.suspendedAt ? vendor.suspendedAt.toISOString() : null,
      communicationNotes: vendor.communicationNotes,
      operatingRegions: vendor.operatingRegions.map((region) => region.stateCode),
    },
    contacts: vendor.contacts,
    categories: [...categoryMap.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    fleet,
    participation: participationMap.get(vendorId) ?? {
      invitations: 0,
      quoted: 0,
      awarded: 0,
      responsivenessPct: null,
      winPct: null,
    },
    rfqsReceived,
    quotationsSubmitted,
  };
}
