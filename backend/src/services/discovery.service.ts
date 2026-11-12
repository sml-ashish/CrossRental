import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import { tryGeocode, type GeoPoint } from "../lib/geo";
import { distancesTo, type Distance } from "./distance.service";
import { getSettings } from "../utils/settings";
import {
  CraneApprovalStatus,
  CraneStatus,
  ReservationStatus,
  type Prisma,
  type UserRole,
} from "../generated/prisma/client";
import {
  discoveryQuerySchema,
  type DiscoveryQuery,
} from "../validation/discoveryFields";
import {
  calendarQuerySchema,
  type CalendarQuery,
} from "../validation/reservationFields";
import { calendarForCranes, type CalendarView } from "./reservations.service";

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
 * pin or address, which the configured provider (Google, stub or disabled)
 * measures like everywhere else.
 */

export interface DiscoveryActor {
  id: string;
  email: string;
  role: UserRole;
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

/**
 * The crane-level filter shared by the list and the calendar tab.
 *
 * Both views must show the same cranes, so they must be filtered by the same
 * rules. Keeping the rules here — rather than letting the calendar re-apply a
 * second copy — is what stops the two screens from disagreeing about what
 * "matches the filters" means. The hire window is part of it: a crane that
 * cannot serve the window does not belong on either screen.
 */
function discoveryWhere(query: DiscoveryQuery): Prisma.CraneWhereInput {
  const availability =
    query.availability && query.availability !== "ALL" ? query.availability : null;
  const capacityRule = query.capacityRule ?? "AT_LEAST";
  const capacity = query.capacityT;

  // A hire window is stricter than a status browse: the crane has to be free at
  // the start and stay free to the end. The crane's own release date says when
  // a busy crane comes back, and an ACTIVE reservation that touches the window
  // disqualifies it — the same overlap rule the database enforces between two
  // reservations. Under Maintenance is admitted only when its expected-ready
  // date is known and falls before the window opens; a crane with no date is
  // not a commitment anybody can make.
  const window =
    query.availableFrom && query.availableTo
      ? { from: query.availableFrom, to: query.availableTo }
      : null;

  return {
    ...(query.includeInactive ? {} : { isActive: true }),
    approvalStatus: CraneApprovalStatus.APPROVED,
    ...(query.craneType ? { typeOfCraneCode: query.craneType } : {}),
    ...(capacity !== undefined
      ? { capacityT: capacityRule === "EXACT" ? { equals: capacity } : { gte: capacity } }
      : {}),
    ...(query.region ? { stateCode: query.region } : {}),
    ...(availability ? { currentStatus: availability } : {}),
    ...(window
      ? {
          AND: [
            {
              OR: [
                { currentStatus: CraneStatus.AVAILABLE },
                {
                  currentStatus: CraneStatus.ENGAGED,
                  availableFrom: { lte: window.from },
                },
                {
                  currentStatus: CraneStatus.UNDER_MAINTENANCE,
                  expectedReadyDate: { lte: window.from },
                },
              ],
            },
            {
              reservations: {
                none: {
                  status: ReservationStatus.ACTIVE,
                  startDate: { lte: window.to },
                  endDate: { gte: window.from },
                },
              },
            },
          ],
        }
      : {}),
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
  };
}

export async function searchCranes(
  rawQuery: unknown,
  actor: DiscoveryActor,
): Promise<DiscoveryResult> {
  assertInternal(actor);
  const parsed = discoveryQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw parsed.error;
  const query: DiscoveryQuery = parsed.data;

  const settings = await getSettings();

  const rows = (await prisma.crane.findMany({
    where: discoveryWhere(query),
    select: DISCOVERY_SELECT,
  })) as unknown as DiscoveryRow[];

  // A site arrives either as a coordinate pair (what the map sends back) or as
  // free text (what a user with no pin can type). The pair wins; the text goes
  // through the configured geo provider, which is Google when one is set.
  let sitePoint: GeoPoint | null = null;
  const siteLat = query.siteLat;
  const siteLng = query.siteLng;
  if (
    siteLat !== undefined &&
    siteLng !== undefined &&
    Number.isFinite(siteLat) &&
    Number.isFinite(siteLng)
  ) {
    sitePoint = { lat: siteLat, lng: siteLng };
  } else if (query.siteLocation) {
    const geocoded = await tryGeocode({
      location: query.siteLocation,
      state: "",
      pincode: query.sitePincode ?? null,
    });
    if (geocoded.ok) sitePoint = geocoded.point;
  }
  const hasSite = sitePoint !== null;

  const located: DiscoveryRow[] = [];
  const unverifiedRows: DiscoveryRow[] = [];
  for (const row of rows) {
    if (num(row.latitude) === null || num(row.longitude) === null) unverifiedRows.push(row);
    else located.push(row);
  }

  const measured = new Map<string, Distance | null>();
  if (sitePoint) {
    const results = await distancesTo(
      sitePoint,
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
    site: sitePoint ? { latitude: sitePoint.lat, longitude: sitePoint.lng } : null,
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

export interface DiscoveryCalendarResult {
  calendar: CalendarView;
  totalMatched: number;
}

/**
 * The discovery results as a calendar (P4, BPD 6.8).
 *
 * The list answers "which cranes match"; the calendar answers "when are they
 * busy". Both apply the same filter (`discoveryWhere`), so switching tabs
 * cannot change which cranes are in scope — only how they are drawn. Day states
 * come from the booking calendar's own read: a reservation wins over the
 * crane's stored status, and `availableFrom` is not used to paint days. The
 * hire window still narrows the set, it just does not colour the grid.
 */
export async function discoveryCalendar(
  raw: unknown,
  actor: DiscoveryActor,
): Promise<DiscoveryCalendarResult> {
  assertInternal(actor);
  const parsed = discoveryQuerySchema.safeParse(raw ?? {});
  if (!parsed.success) throw parsed.error;
  const query: DiscoveryQuery = parsed.data;

  // The same bounded range the booking calendar accepts, so a month grid here
  // and a month grid there can never be asked for different-sized windows.
  const range: CalendarQuery = calendarQuerySchema.parse(raw ?? {});

  const rows = await prisma.crane.findMany({
    where: discoveryWhere(query),
    select: { id: true },
  });

  const calendar = await calendarForCranes(
    rows.map((row) => row.id),
    range.from,
    range.to,
  );

  return { calendar, totalMatched: calendar.cranes.length };
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
    availability: ["AVAILABLE", "ENGAGED", "UNDER_MAINTENANCE", "ALL"],
  };
}
