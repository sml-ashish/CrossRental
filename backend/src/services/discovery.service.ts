import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { distancesTo, type Distance } from "./distance.service";
import { getSettings } from "../utils/settings";
import {
  CraneApprovalStatus,
  CraneStatus,
  OwnershipType,
} from "../generated/prisma/client";
import {
  discoveryQuerySchema,
  type DiscoveryQuery,
} from "../validation/discoveryFields";

/**
 * Manual vendor discovery (BPD 6.8 / 5.9): find cranes without an enquiry.
 *
 * This is a read, not a recommendation: nothing is snapshotted, no line is
 * touched, and the two-set rule (SML vs vendor) does not apply because the
 * search returns vendor cranes only — SML has no fleet (open item 2).
 *
 * Eligibility mirrors the candidate picker where it matters — an approved,
 * unsuspended vendor and an approved crane — but it is deliberately looser
 * about availability, because discovery is a browse tool: the user chooses
 * whether to include engaged or under-maintenance cranes, and the status is
 * shown on every row. Distance is produced only when the user supplies a site
 * pin, which the stub provider measures like everywhere else.
 */

export interface DiscoveryActor {
  id: string;
  email: string;
  role: "admin_user" | "sales_user" | "vendor_user";
  vendorId: string | null;
}

function assertInternal(actor: DiscoveryActor): void {
  if (actor.role !== "admin_user" && actor.role !== "sales_user") {
    throw AppError.forbidden("Vendor discovery is available to SML staff only");
  }
}

export interface DiscoveryCrane {
  craneId: string;
  vendorId: string;
  vendorName: string;
  vendorCompanySize: string | null;
  vendorFleetSize: number;
  typeOfCraneCode: string;
  typeOfCraneName: string;
  capacityT: number;
  make: string;
  model: string;
  yom: number;
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  stateName: string;
  availableFrom: string | null;
  expectedReadyDate: string | null;
  ownershipType: string;
  serialRegistrationNo: string;
  mainBoomM: number | null;
  fixedJibM: number | null;
  luffingJibM: number | null;
  windJibM: number | null;
  latitude: number | null;
  longitude: number | null;
  locationUnverified: boolean;
  stale: boolean;
  daysSinceUpdate: number;
  distanceKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
}

export interface DiscoveryGroup {
  vendorId: string;
  vendorName: string;
  companySize: string | null;
  fleetSize: number;
  nearestKm: number | null;
  distanceMethod: string | null;
  distanceApproximate: boolean;
  cranes: DiscoveryCrane[];
}

export interface DiscoveryResult {
  distancesAvailable: boolean;
  site: { latitude: number; longitude: number } | null;
  groups: DiscoveryGroup[];
  unverified: DiscoveryCrane[];
  totalMatched: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function daysSince(date: Date): number {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / DAY_MS));
}

const DISCOVERY_SELECT = {
  id: true,
  vendorId: true,
  typeOfCraneCode: true,
  capacityT: true,
  make: true,
  model: true,
  yom: true,
  currentStatus: true,
  currentLocation: true,
  stateCode: true,
  availableFrom: true,
  expectedReadyDate: true,
  ownershipType: true,
  serialRegistrationNo: true,
  mainBoomM: true,
  fixedJibM: true,
  luffingJibM: true,
  windJibM: true,
  latitude: true,
  longitude: true,
  statusUpdatedAt: true,
  typeOfCrane: { select: { name: true } },
  state: { select: { name: true } },
  vendor: {
    select: {
      id: true,
      name: true,
      companySize: true,
      totalFleetSize: true,
    },
  },
} as const;

type DiscoveryRow = {
  id: string;
  vendorId: string;
  typeOfCraneCode: string;
  capacityT: unknown;
  make: string;
  model: string;
  yom: number;
  currentStatus: string;
  currentLocation: string;
  stateCode: string;
  availableFrom: Date | null;
  expectedReadyDate: Date | null;
  ownershipType: string;
  serialRegistrationNo: string;
  mainBoomM: unknown;
  fixedJibM: unknown;
  luffingJibM: unknown;
  windJibM: unknown;
  latitude: unknown;
  longitude: unknown;
  statusUpdatedAt: Date;
  typeOfCrane: { name: string };
  state: { name: string };
  vendor: {
    id: string;
    name: string | null;
    companySize: string | null;
    totalFleetSize: number;
  };
};

export async function searchCranes(
  rawQuery: unknown,
  actor: DiscoveryActor,
): Promise<DiscoveryResult> {
  assertInternal(actor);
  const parsed = discoveryQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw parsed.error;
  const query: DiscoveryQuery = parsed.data;

  const settings = await getSettings();
  const availability =
    query.availability && query.availability !== "ALL" ? query.availability : null;
  const capacityRule = query.capacityRule ?? "AT_LEAST";
  const capacity = query.capacityT;

  const rows = (await prisma.crane.findMany({
    where: {
      ...(query.includeInactive ? {} : { isActive: true }),
      approvalStatus: CraneApprovalStatus.APPROVED,
      ...(query.craneType ? { typeOfCraneCode: query.craneType } : {}),
      ...(capacity !== undefined
        ? { capacityT: capacityRule === "EXACT" ? { equals: capacity } : { gte: capacity } }
        : {}),
      ...(query.region ? { stateCode: query.region } : {}),
      ...(query.ownershipType ? { ownershipType: query.ownershipType } : {}),
      ...(availability ? { currentStatus: availability } : {}),
      ...(query.yomFrom !== undefined || query.yomTo !== undefined
        ? {
            yom: {
              ...(query.yomFrom !== undefined ? { gte: query.yomFrom } : {}),
              ...(query.yomTo !== undefined ? { lte: query.yomTo } : {}),
            },
          }
        : {}),
      ...(query.location
        ? {
            OR: [
              { currentLocation: { contains: query.location, mode: "insensitive" } },
              { state: { name: { contains: query.location, mode: "insensitive" } } },
              { make: { contains: query.location, mode: "insensitive" } },
              { model: { contains: query.location, mode: "insensitive" } },
            ],
          }
        : {}),
      vendor: {
        onboardingStatus: "APPROVED",
        suspendedAt: null,
        ...(query.vendorName
          ? { name: { contains: query.vendorName, mode: "insensitive" } }
          : {}),
        ...(query.vendorRegion
          ? { operatingRegions: { some: { stateCode: query.vendorRegion } } }
          : {}),
        ...(query.companySize ? { companySize: query.companySize } : {}),
        ...(query.fleetSizeMin !== undefined
          ? { totalFleetSize: { gte: query.fleetSizeMin } }
          : {}),
      },
    },
    select: DISCOVERY_SELECT,
  })) as unknown as DiscoveryRow[];

  const siteLat = query.siteLat;
  const siteLng = query.siteLng;
  const hasSite =
    siteLat !== undefined &&
    siteLng !== undefined &&
    Number.isFinite(siteLat) &&
    Number.isFinite(siteLng);

  const located: DiscoveryRow[] = [];
  const unverifiedRows: DiscoveryRow[] = [];
  for (const row of rows) {
    if (num(row.latitude) === null || num(row.longitude) === null) unverifiedRows.push(row);
    else located.push(row);
  }

  const measured = new Map<string, Distance | null>();
  if (hasSite) {
    const results = await distancesTo(
      { lat: siteLat as number, lng: siteLng as number },
      located.map((r) => ({
        lat: num(r.latitude) as number,
        lng: num(r.longitude) as number,
      })),
    );
    located.forEach((row, i) => measured.set(row.id, results[i] ?? null));
  }

  const shape = (row: DiscoveryRow, distance: Distance | null): DiscoveryCrane => {
    const days = daysSince(row.statusUpdatedAt);
    return {
      craneId: row.id,
      vendorId: row.vendorId,
      vendorName: row.vendor.name ?? "The vendor",
      vendorCompanySize: row.vendor.companySize,
      vendorFleetSize: row.vendor.totalFleetSize,
      typeOfCraneCode: row.typeOfCraneCode,
      typeOfCraneName: row.typeOfCrane.name,
      capacityT: num(row.capacityT) ?? 0,
      make: row.make,
      model: row.model,
      yom: row.yom,
      currentStatus: row.currentStatus,
      currentLocation: row.currentLocation,
      stateCode: row.stateCode,
      stateName: row.state.name,
      availableFrom: row.availableFrom ? row.availableFrom.toISOString() : null,
      expectedReadyDate: row.expectedReadyDate
        ? row.expectedReadyDate.toISOString()
        : null,
      ownershipType: row.ownershipType,
      serialRegistrationNo: row.serialRegistrationNo,
      mainBoomM: num(row.mainBoomM),
      fixedJibM: num(row.fixedJibM),
      luffingJibM: num(row.luffingJibM),
      windJibM: num(row.windJibM),
      latitude: num(row.latitude),
      longitude: num(row.longitude),
      locationUnverified: false,
      stale: days >= settings.staleFlagDays,
      daysSinceUpdate: days,
      distanceKm: distance?.km ?? null,
      distanceMethod: distance?.method ?? null,
      distanceApproximate: distance?.approximate ?? false,
    };
  };

  const locatedCranes = located.map((row) => shape(row, measured.get(row.id) ?? null));
  locatedCranes.sort((a, b) => {
    if (a.distanceKm === null && b.distanceKm === null) return a.capacityT - b.capacityT;
    if (a.distanceKm === null) return 1;
    if (b.distanceKm === null) return -1;
    return a.distanceKm - b.distanceKm;
  });

  const groups = new Map<string, DiscoveryGroup>();
  for (const crane of locatedCranes) {
    let group = groups.get(crane.vendorId);
    if (!group) {
      group = {
        vendorId: crane.vendorId,
        vendorName: crane.vendorName,
        companySize: crane.vendorCompanySize,
        fleetSize: crane.vendorFleetSize,
        nearestKm: null,
        distanceMethod: null,
        distanceApproximate: false,
        cranes: [],
      };
      groups.set(crane.vendorId, group);
    }
    group.cranes.push(crane);
  }
  for (const group of groups.values()) {
    const first = group.cranes[0];
    group.nearestKm = first?.distanceKm ?? null;
    group.distanceMethod = first?.distanceMethod ?? null;
    group.distanceApproximate = first?.distanceApproximate ?? false;
  }

  const unverified = unverifiedRows.map((row) => ({
    ...shape(row, null),
    locationUnverified: true,
  }));

  return {
    distancesAvailable: hasSite,
    site: hasSite ? { latitude: siteLat as number, longitude: siteLng as number } : null,
    groups: [...groups.values()].sort((a, b) => {
      if (a.nearestKm === null && b.nearestKm === null)
        return a.vendorName.localeCompare(b.vendorName);
      if (a.nearestKm === null) return 1;
      if (b.nearestKm === null) return -1;
      return a.nearestKm - b.nearestKm;
    }),
    unverified,
    totalMatched: locatedCranes.length + unverified.length,
  };
}

/** Filter options for the discovery form, read from the live data. */
export async function discoveryFacets() {
  const [craneTypes, states, sizes] = await Promise.all([
    prisma.craneType.findMany({
      orderBy: { sortOrder: "asc" },
      select: { code: true, name: true },
    }),
    prisma.state.findMany({ orderBy: { name: "asc" }, select: { code: true, name: true } }),
    prisma.vendor.findMany({
      where: { companySize: { not: null }, onboardingStatus: "APPROVED", suspendedAt: null },
      distinct: ["companySize"],
      select: { companySize: true },
      orderBy: { companySize: "asc" },
    }),
  ]);

  return {
    craneTypes,
    states,
    companySizes: sizes
      .map((row) => row.companySize)
      .filter((size): size is string => Boolean(size)),
    ownershipTypes: [OwnershipType.VENDOR, OwnershipType.SML],
    availability: ["AVAILABLE", "ENGAGED", "UNDER_MAINTENANCE", "ALL"],
  };
}
