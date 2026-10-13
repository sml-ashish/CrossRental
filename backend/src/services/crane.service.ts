import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { can } from "../utils/rbac";
import { storage } from "../lib/storage";
import { recordAudit, diff } from "./audit.service";
import { getSettings, type PortalSettings } from "../utils/settings";
import { isInsideIndia, tryGeocode, type GeoPoint } from "../lib/geo";
import { startOfUtcDay, todayUtcMidnight } from "../lib/dates";
import { invalidateDistancesFrom } from "./distance.service";
import {
  createCraneSchema,
  updateCraneSchema,
  quickUpdateSchema,
  listCranesQuerySchema,
  SYSTEM_ONLY_STATUSES,
  VENDOR_SELECTABLE_STATUSES,
  type CreateCraneInput,
  type UpdateCraneInput,
  type QuickUpdateInput,
  type ListCranesQuery,
} from "../validation/craneFields";
import { CraneApprovalStatus, CraneStatus } from "../generated/prisma/client";
import type { ValidatedUpload } from "../middleware/upload";

/**
 * Fleet management (brief 7.4, with the rules of section 6).
 *
 * Three rules shape the whole file.
 *
 * **Ownership is a row question, never a parameter.** A vendor user reads and
 * writes through `vendorId` taken from their verified token; the `craneId` in
 * the path only ever selects *which* of their own rows. Every read goes through
 * `loadScoped`, so there is no query in this file that can return another
 * vendor's crane.
 *
 * **Booked and Hired are not the vendor's to set.** They are created by the
 * award flow (brief 6.7) and mean the crane is committed to an SML contract.
 * The vendor dropdown never offers them and any attempt to write one is
 * refused, rather than quietly accepted and ignored.
 *
 * **Geocoding never blocks a save.** Brief 6.3 requires the crane to be stored
 * even when the lookup fails, flagged "location unverified" so future distance
 * sorting never treats it as real. A provider outage must not cost a vendor
 * their data entry.
 */

export interface Actor {
  id: string;
  email: string;
  role: AuthedRequest["user"]["role"];
  vendorId: string | null;
}

function actorOf(user: AuthedRequest["user"]): Actor {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    vendorId: user.vendorId,
  };
}

/** Audit wants the whole token user; the service carries only what it uses. */
function auditActor(actor: Actor): AuthedRequest["user"] {
  return {
    id: actor.id,
    email: actor.email,
    role: actor.role,
    vendorId: actor.vendorId,
  } as AuthedRequest["user"];
}

/**
 * A vendor must have a vendor record before a crane can belong to them. Approved
 * vendors reach the portal through activation, so this is mostly a guard
 * against a half-provisioned account.
 */
function requireVendorId(actor: Actor): string {
  if (!actor.vendorId) {
    throw AppError.forbidden(
      "Your account is not linked to a vendor record yet",
    );
  }
  return actor.vendorId;
}

const CRANE_SELECT = {
  id: true,
  vendorId: true,
  typeOfCraneCode: true,
  capacityT: true,
  currentStatus: true,
  currentLocation: true,
  stateCode: true,
  make: true,
  model: true,
  yom: true,
  mainBoomM: true,
  fixedJibM: true,
  luffingJibM: true,
  windJibM: true,
  serialRegistrationNo: true,
  pincode: true,
  latitude: true,
  longitude: true,
  coordinateSource: true,
  geocodedBy: true,
  geocodedAt: true,
  availableFrom: true,
  loadChartFileRef: true,
  loadChartFileName: true,
  loadChartMimeType: true,
  loadChartSizeBytes: true,
  ownershipType: true,
  isActive: true,
  approvalStatus: true,
  remarks: true,
  statusUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: true,
  typeOfCrane: { select: { code: true, name: true } },
  state: { select: { code: true, name: true } },
} as const;

/**
 * The moves brief 5.2 requires an audit entry for, and the same set that
 * restarts the stale-data clock.
 */
const AUDITED_MOVE_FIELDS: string[] = [
  "currentStatus",
  "currentLocation",
  "stateCode",
  "availableFrom",
];

export interface CraneFreshness {
  /** Whole days since the status or location data was last confirmed. */
  daysSinceUpdate: number;
  /** Past the "please update" window; reminders start here (brief 6.5). */
  dueForUpdate: boolean;
  /** Past the stale window; this is the flag the fleet list sorts by. */
  stale: boolean;
  /** ISO date the stale flag was crossed, for display. */
  staleSince: string | null;
}

export interface CraneView {
  id: string;
  vendorId: string;
  typeOfCraneCode: string;
  typeOfCrane: { code: string; name: string } | null;
  capacityT: number;
  currentStatus: CraneStatus;
  currentLocation: string;
  stateCode: string;
  state: { code: string; name: string } | null;
  make: string;
  model: string;
  yom: number;
  mainBoomM: number | null;
  fixedJibM: number | null;
  luffingJibM: number | null;
  windJibM: number | null;
  serialRegistrationNo: string;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinateSource: "auto" | "manual" | null;
  geocodedBy: string | null;
  geocodedAt: string | null;
  /** True when the crane has no coordinates, so it cannot be distance-sorted. */
  locationUnverified: boolean;
  /**
   * Freshness of the status and location data (brief 6.5). `statusUpdatedAt` is
   * the clock: it is bumped by a status or location change and by
   * "confirm still accurate", but not by a spec-sheet edit.
   */
  freshness: CraneFreshness;
  availableFrom: string | null;
  loadChart: {
    fileName: string;
    mimeType: string;
    sizeBytes: number | null;
  } | null;
  ownershipType: string;
  isActive: boolean;
  approvalStatus: CraneApprovalStatus;
  remarks: string | null;
  statusUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  /** Set for internal readers, so a queue can show whose crane it is. */
  vendorName?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Starts of days, so day counts do not drift with the time of day. */
function startOfDay(d: Date): number {
  // UTC, matching `staleSince` below, which formats the result with
  // `toISOString().slice(0, 10)` — a local midnight west of UTC would format as
  // the previous day.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function freshnessOf(
  row: { statusUpdatedAt: Date; isActive: boolean },
  settings: PortalSettings,
): CraneFreshness {
  const daysSinceUpdate = Math.max(
    0,
    Math.round(
      (startOfDay(new Date()) - startOfDay(row.statusUpdatedAt)) / DAY_MS,
    ),
  );

  // An inactive crane is out of the fleet, so there is nothing to remind about.
  if (!row.isActive) {
    return {
      daysSinceUpdate,
      dueForUpdate: false,
      stale: false,
      staleSince: null,
    };
  }

  const stale = daysSinceUpdate >= settings.staleFlagDays;
  return {
    daysSinceUpdate,
    dueForUpdate: daysSinceUpdate >= settings.staleDueDays,
    stale,
    staleSince: stale
      ? new Date(
          startOfDay(row.statusUpdatedAt) + settings.staleFlagDays * DAY_MS,
        )
          .toISOString()
          .slice(0, 10)
      : null,
  };
}

async function toView(row: any): Promise<CraneView> {
  const settings = await getSettings();
  return {
    id: row.id,
    vendorId: row.vendorId,
    typeOfCraneCode: row.typeOfCraneCode,
    typeOfCrane: row.typeOfCrane ?? null,
    capacityT: Number(row.capacityT),
    currentStatus: row.currentStatus,
    currentLocation: row.currentLocation,
    stateCode: row.stateCode,
    state: row.state ?? null,
    make: row.make,
    model: row.model,
    yom: row.yom,
    mainBoomM: row.mainBoomM === null ? null : Number(row.mainBoomM),
    fixedJibM: row.fixedJibM === null ? null : Number(row.fixedJibM),
    luffingJibM: row.luffingJibM === null ? null : Number(row.luffingJibM),
    windJibM: row.windJibM === null ? null : Number(row.windJibM),
    serialRegistrationNo: row.serialRegistrationNo,
    pincode: row.pincode,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    coordinateSource: row.coordinateSource,
    geocodedBy: row.geocodedBy,
    geocodedAt: row.geocodedAt ? row.geocodedAt.toISOString() : null,
    locationUnverified: row.latitude === null || row.longitude === null,
    freshness: freshnessOf(row, settings),
    availableFrom: row.availableFrom ? row.availableFrom.toISOString() : null,
    loadChart: row.loadChartFileName
      ? {
          fileName: row.loadChartFileName,
          mimeType: row.loadChartMimeType ?? "application/octet-stream",
          sizeBytes: row.loadChartSizeBytes ?? null,
        }
      : null,
    ownershipType: row.ownershipType,
    isActive: row.isActive,
    approvalStatus: row.approvalStatus,
    remarks: row.remarks,
    statusUpdatedAt: row.statusUpdatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    ...(row.vendor ? { vendorName: row.vendor.name } : {}),
  };
}

/**
 * Loads one crane, scoped to what the actor is allowed to see.
 *
 * A vendor asking for someone else's crane gets the same 404 as a crane that
 * does not exist, rather than a 403 — a 403 would confirm the row is real and
 * turn the id into an enumeration oracle.
 */
async function loadScoped(actor: Actor, craneId: string) {
  const vendorId = actor.role === "vendor_user" ? requireVendorId(actor) : null;

  const row = await prisma.crane.findFirst({
    where: {
      id: craneId,
      ...(vendorId ? { vendorId } : {}),
      ...(actor.role === "vendor_user"
        ? {}
        : { vendor: { onboardingStatus: "APPROVED" } }),
    },
    select: { ...CRANE_SELECT, vendor: { select: { name: true } } },
  });

  if (!row) throw AppError.notFound("Crane not found");
  return row;
}

// ---------------------------------------------------------------------------
// Reference lookups and shared rules
// ---------------------------------------------------------------------------

/** Rejects a crane type or state that is not in the reference tables. */
async function assertReferences(input: {
  typeOfCraneCode: string;
  stateCode: string;
}) {
  const [type, state] = await Promise.all([
    prisma.craneType.findUnique({
      where: { code: input.typeOfCraneCode },
      select: { code: true },
    }),
    prisma.state.findUnique({
      where: { code: input.stateCode },
      select: { code: true },
    }),
  ]);
  if (!type) throw AppError.badRequest("Choose a crane type from the list");
  if (!state) throw AppError.badRequest("Choose a state from the list");
}

/**
 * Duplicate detection (brief 6.2).
 *
 * Only *active* cranes count, because the unique index is partial: a vendor who
 * deactivates a crane must be able to enter the same serial again later. The
 * existing crane's id comes back in the error details so the UI can offer a link
 * to it instead of only saying "no".
 */
async function assertNoDuplicate(
  vendorId: string,
  serialRegistrationNo: string,
  excludeCraneId?: string,
) {
  const existing = await prisma.crane.findFirst({
    where: {
      vendorId,
      // Case-insensitive: the DB's unique index is case-sensitive, so without
      // this the pre-check would pass and the insert would still collide.
      serialRegistrationNo: {
        equals: serialRegistrationNo,
        mode: "insensitive",
      },
      isActive: true,
      ...(excludeCraneId ? { id: { not: excludeCraneId } } : {}),
    },
    select: { id: true, currentStatus: true },
  });

  if (existing) {
    throw AppError.conflict(
      `You already have an active crane with serial / registration number ${serialRegistrationNo}`,
      { existingCraneId: existing.id, existingStatus: existing.currentStatus },
    );
  }
}

/**
 * Refuses a vendor write to a crane the award flow has committed.
 *
 * Brief 6.1: the status is shown read-only with a message. 409 rather than 403
 * because the caller is allowed to edit cranes generally — this one is simply
 * not theirs to change right now.
 */
function assertNotSystemLocked(row: {
  currentStatus: CraneStatus;
  id: string;
}) {
  if (SYSTEM_ONLY_STATUSES.includes(row.currentStatus)) {
    throw AppError.conflict(
      `This crane is ${row.currentStatus === CraneStatus.BOOKED ? "booked" : "hired"} on an SML contract, so its status cannot be changed.`,
      { craneId: row.id, status: row.currentStatus },
    );
  }
}

/** A vendor may only ever write one of the three statuses they can choose. */
function assertVendorStatus(status: CraneStatus) {
  if (!VENDOR_SELECTABLE_STATUSES.includes(status as never)) {
    throw AppError.badRequest("Choose Available, Engaged or Under Maintenance");
  }
}

/**
 * Works out `availableFrom` from a requested status and date (brief 6.1).
 *
 * Engaged requires a date of today or later. Going back to Available clears it,
 * because a crane that is free now has no future availability date to hold.
 */
function resolveAvailableFrom(
  status: CraneStatus,
  requested: Date | null | undefined,
  existing: Date | null,
): Date | null {
  if (status === CraneStatus.ENGAGED) {
    const value = requested ?? existing;
    if (!value)
      throw AppError.badRequest("Give the date this crane becomes available");
    // UTC-anchored: the vendor picked a calendar day, and truncating that in the
    // server's local zone stored a different day west of UTC. See lib/dates.ts.
    const day = startOfUtcDay(value);
    if (day < todayUtcMidnight()) {
      throw AppError.badRequest("available_from must be today or later");
    }
    return day;
  }
  if (status === CraneStatus.AVAILABLE) return null;
  // Under Maintenance keeps whatever was there: it is not asserting availability,
  // and clearing it would lose a date the vendor may still need.
  return requested === undefined ? existing : requested;
}

/**
 * Turns a manual pin into stored coordinates.
 *
 * Brief 6.3: a pin the vendor confirmed or dragged is `manual`, and an automatic
 * geocode must not overwrite it. Bounds are checked here for a clear message;
 * the database CHECK is the backstop.
 */
function manualPoint(input: {
  latitude?: number | null;
  longitude?: number | null;
}): GeoPoint | null {
  const hasLat = input.latitude !== undefined && input.latitude !== null;
  const hasLng = input.longitude !== undefined && input.longitude !== null;
  if (!hasLat && !hasLng) return null;
  if (!hasLat || !hasLng) {
    throw AppError.badRequest(
      "Give both a latitude and a longitude, or neither",
    );
  }
  const point = { lat: Number(input.latitude), lng: Number(input.longitude) };
  if (!isInsideIndia(point)) {
    throw AppError.badRequest(
      "That pin is outside India. Drag the pin to the crane's location.",
    );
  }
  return point;
}

type CoordinateFields = {
  latitude: number | null;
  longitude: number | null;
  coordinateSource: "auto" | "manual" | null;
  geocodedBy: string | null;
  geocodedAt: Date | null;
};

/**
 * Decides what to do about coordinates after a create or an edit.
 *
 * The precedence, from brief 6.3:
 *  - a pin the vendor just dropped or confirmed wins outright;
 *  - otherwise, if the location text (location, state or pincode) changed, geocode
 *    again — including over a previous manual pin, because the vendor moved the
 *    crane and the old pin is now wrong;
 *  - otherwise leave whatever was there, so a manual pin survives an edit that
 *    only changed, say, the boom length.
 */
async function resolveCoordinates(
  existing: {
    latitude: unknown;
    longitude: unknown;
    coordinateSource: unknown;
  } | null,
  next: {
    currentLocation: string;
    stateCode: string;
    pincode: string | null;
    latitude?: number | null;
    longitude?: number | null;
  },
): Promise<CoordinateFields> {
  const manual = manualPoint(next);
  if (manual) {
    return {
      latitude: manual.lat,
      longitude: manual.lng,
      coordinateSource: "manual",
      geocodedBy: null,
      geocodedAt: null,
    };
  }

  const changed =
    !existing ||
    existing.coordinateSource === null ||
    next.currentLocation !== (existing as any).currentLocation ||
    next.stateCode !== (existing as any).stateCode ||
    (next.pincode ?? null) !== ((existing as any).pincode ?? null);

  if (!changed && existing) {
    return {
      latitude: existing.latitude === null ? null : Number(existing.latitude),
      longitude:
        existing.longitude === null ? null : Number(existing.longitude),
      coordinateSource: (existing.coordinateSource ?? null) as
        "auto" | "manual" | null,
      geocodedBy: (existing as any).geocodedBy ?? null,
      geocodedAt: (existing as any).geocodedAt ?? null,
    };
  }

  const result = await tryGeocode({
    location: next.currentLocation,
    state: next.stateCode,
    pincode: next.pincode,
  });

  if (result.ok) {
    return {
      latitude: result.point.lat,
      longitude: result.point.lng,
      coordinateSource: "auto",
      geocodedBy: result.provider,
      geocodedAt: new Date(),
    };
  }

  // Save anyway (brief 6.3). locationUnverified is derived from the null
  // coordinates, so no extra flag is stored.
  return {
    latitude: null,
    longitude: null,
    coordinateSource: null,
    geocodedBy: null,
    geocodedAt: null,
  };
}

/**
 * Drop cached road distances that were measured from a point a crane has just
 * moved away from.
 *
 * The candidate picker (brief 6.9) caches road distances between a job site and
 * each crane. When a crane is re-geocoded its cached distance is stale, and a
 * stale distance is worse than none: sales sorts by it and picks the nearest
 * crane. Both the old and the new point are invalidated — the old one because
 * rows cached *from* it are now wrong, and the new one because a distance cached
 * earlier from the same rounded point may predate this crane's move.
 *
 * Called from create and update only; those are the two places coordinates are
 * written, since the quick-update action delegates to update.
 */
async function invalidateCachedDistances(
  points: Array<GeoPoint | null>,
): Promise<void> {
  for (const point of points) {
    if (!point) continue;
    await invalidateDistancesFrom(point);
  }
}

/**
 * Invalidate cached distances when a crane's point actually moved.
 *
 * Skipped when the coordinates came back unchanged, which is the common case:
 * editing a spec sheet does not move the crane, and deleting cache rows on every
 * keystroke-save would mean the picker re-routes the whole fleet for nothing.
 */
async function invalidateCachedDistancesIfMoved(
  existing: { latitude: unknown; longitude: unknown },
  next: CoordinateFields,
): Promise<void> {
  const before =
    existing.latitude === null || existing.latitude === undefined
      ? null
      : Number(existing.latitude);
  const beforeLng =
    existing.longitude === null || existing.longitude === undefined
      ? null
      : Number(existing.longitude);

  const points: Array<GeoPoint | null> = [
    before !== null && beforeLng !== null
      ? { lat: before, lng: beforeLng }
      : null,
  ];

  if (next.latitude !== null && next.longitude !== null) {
    points.push({ lat: next.latitude, lng: next.longitude });
  }

  await invalidateCachedDistances(points);
}

/** Brief 6.4: with the flag on, new and edited cranes wait for an admin. */
async function approvalStatusForNewWork(): Promise<CraneApprovalStatus> {
  const settings = await getSettings();
  return settings.fleetApprovalRequired
    ? CraneApprovalStatus.PENDING
    : CraneApprovalStatus.APPROVED;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createCrane(rawInput: unknown, actor: Actor) {
  const parsed = createCraneSchema.safeParse(rawInput);
  if (!parsed.success) throw parsed.error;
  const input = parsed.data as CreateCraneInput;

  const vendorId = requireVendorId(actor);
  assertVendorStatus(input.currentStatus);
  await assertReferences(input);
  await assertNoDuplicate(vendorId, input.serialRegistrationNo);

  const coordinates = await resolveCoordinates(null, input);
  const availableFrom = resolveAvailableFrom(
    input.currentStatus,
    input.availableFrom,
    null,
  );
  const now = new Date();

  if (coordinates.latitude !== null && coordinates.longitude !== null) {
    await invalidateCachedDistances([
      { lat: coordinates.latitude, lng: coordinates.longitude },
    ]);
  }

  const row = await prisma.crane.create({
    data: {
      vendorId,
      typeOfCraneCode: input.typeOfCraneCode,
      capacityT: input.capacityT,
      currentStatus: input.currentStatus,
      currentLocation: input.currentLocation,
      stateCode: input.stateCode,
      make: input.make,
      model: input.model,
      yom: input.yom,
      mainBoomM: input.mainBoomM,
      fixedJibM: input.fixedJibM,
      luffingJibM: input.luffingJibM,
      windJibM: input.windJibM,
      serialRegistrationNo: input.serialRegistrationNo,
      pincode: input.pincode,
      ...coordinates,
      availableFrom,
      ownershipType: "VENDOR",
      isActive: true,
      approvalStatus: await approvalStatusForNewWork(),
      remarks: input.remarks ?? null,
      // A new crane's clock starts now.
      statusUpdatedAt: now,
      updatedBy: actor.id,
    },
    select: { ...CRANE_SELECT, vendor: { select: { name: true } } },
  });

  await recordAudit({
    entity: "crane",
    entityId: row.id,
    action: "crane_created",
    newValue: {
      serialRegistrationNo: row.serialRegistrationNo,
      currentStatus: row.currentStatus,
      currentLocation: row.currentLocation,
      stateCode: row.stateCode,
      capacityT: Number(row.capacityT),
    },
    craneId: row.id,
    actor: auditActor(actor),
  });

  return await toView(row);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Lists cranes.
 *
 * `scopeVendorId` is the caller's resolved scope, computed by the controller
 * with the shared `vendorScopeOf` helper. It is passed in rather than read from
 * the query here so there is exactly one place that decides what a caller may
 * narrow to.
 */
export async function listCranes(
  rawQuery: unknown,
  actor: Actor,
  scopeVendorId: string | null,
) {
  const parsed = listCranesQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw parsed.error;
  const query = parsed.data as ListCranesQuery;

  const isVendor = actor.role === "vendor_user";
  // A vendor is pinned to their own rows. An internal caller may narrow to one
  // vendor, or pass null to mean every approved vendor.
  const vendorId = isVendor ? requireVendorId(actor) : scopeVendorId;

  if (!isVendor && !can(actor.role, "fleet:view_all")) {
    throw AppError.forbidden(
      "You do not have permission to view vendor fleets",
    );
  }

  const rows = await prisma.crane.findMany({
    where: {
      ...(vendorId ? { vendorId } : {}),
      ...(isVendor ? {} : { vendor: { onboardingStatus: "APPROVED" } }),
      ...(query.status ? { currentStatus: query.status } : {}),
      ...(query.typeOfCraneCode
        ? { typeOfCraneCode: query.typeOfCraneCode }
        : {}),
      ...(query.stateCode ? { stateCode: query.stateCode } : {}),
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              {
                serialRegistrationNo: {
                  contains: query.search,
                  mode: "insensitive",
                },
              },
              {
                currentLocation: {
                  contains: query.search,
                  mode: "insensitive",
                },
              },
              { make: { contains: query.search, mode: "insensitive" } },
              { model: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ currentStatus: "asc" }, { updatedAt: "desc" }],
    select: { ...CRANE_SELECT, vendor: { select: { name: true } } },
  });

  return Promise.all(rows.map(toView));
}

export async function getCraneDetail(actor: Actor, craneId: string) {
  const row = await prisma.crane.findFirst({
    where: {
      id: craneId,
      ...(actor.role === "vendor_user"
        ? { vendorId: requireVendorId(actor) }
        : {}),
      ...(actor.role === "vendor_user"
        ? {}
        : { vendor: { onboardingStatus: "APPROVED" } }),
    },
    select: {
      ...CRANE_SELECT,
      vendor: { select: { id: true, name: true, onboardingStatus: true } },
    },
  });
  if (!row) throw AppError.notFound("Crane not found");
  return await toView(row);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateCrane(
  craneId: string,
  rawInput: unknown,
  actor: Actor,
) {
  const parsed = updateCraneSchema.safeParse(rawInput);
  if (!parsed.success) throw parsed.error;
  const input = parsed.data as UpdateCraneInput;

  const existing = await loadScoped(actor, craneId);
  assertNotSystemLocked(existing);

  if (input.currentStatus) assertVendorStatus(input.currentStatus);

  await assertReferences(input);
  await assertNoDuplicate(
    existing.vendorId,
    input.serialRegistrationNo,
    craneId,
  );

  const nextStatus = input.currentStatus ?? existing.currentStatus;
  const availableFrom = resolveAvailableFrom(
    nextStatus,
    input.availableFrom,
    existing.availableFrom,
  );

  // The comparison needs the pre-change location text, so it is read alongside
  // the coordinates rather than from the narrow select above.
  const before = await prisma.crane.findUniqueOrThrow({
    where: { id: craneId },
    select: {
      currentLocation: true,
      stateCode: true,
      pincode: true,
      latitude: true,
      longitude: true,
      coordinateSource: true,
      geocodedBy: true,
      geocodedAt: true,
    },
  });

  const coordinates = await resolveCoordinates(before, input);

  const statusOrLocationChanged =
    input.currentStatus !== undefined ||
    input.currentLocation !== before.currentLocation ||
    input.stateCode !== before.stateCode ||
    (input.pincode ?? null) !== (before.pincode ?? null) ||
    (input.availableFrom !== undefined &&
      (input.availableFrom?.getTime() ?? null) !==
        (existing.availableFrom?.getTime() ?? null));

  const now = new Date();

  await invalidateCachedDistancesIfMoved(existing, coordinates);

  const row = await prisma.crane.update({
    where: { id: craneId },
    data: {
      typeOfCraneCode: input.typeOfCraneCode,
      capacityT: input.capacityT,
      currentStatus: nextStatus,
      currentLocation: input.currentLocation,
      stateCode: input.stateCode,
      make: input.make,
      model: input.model,
      yom: input.yom,
      mainBoomM: input.mainBoomM,
      fixedJibM: input.fixedJibM,
      luffingJibM: input.luffingJibM,
      windJibM: input.windJibM,
      serialRegistrationNo: input.serialRegistrationNo,
      pincode: input.pincode,
      ...coordinates,
      availableFrom,
      remarks: input.remarks ?? null,
      // Brief 6.4: with the flag on, an edit parks the crane in PENDING; with
      // it off, changes are live immediately — including clearing a PENDING left
      // behind by an earlier flag-on period, so nothing can sit unreviewed with
      // no reviewer left to clear it.
      approvalStatus: await approvalStatusForNewWork(),
      // Only bumped when something the clock measures actually moved, so a
      // "confirm still accurate" tap and a spec-sheet edit do not reset it.
      ...(statusOrLocationChanged ? { statusUpdatedAt: now } : {}),
      updatedBy: actor.id,
    },
    select: {
      ...CRANE_SELECT,
      vendor: { select: { name: true } },
      typeOfCrane: { select: { code: true, name: true } },
      state: { select: { code: true, name: true } },
    },
  });

  // Audit on the fields brief 5.2 names: status and location moves.
  const change = diff(
    {
      currentStatus: existing.currentStatus,
      currentLocation: existing.currentLocation,
      stateCode: existing.stateCode,
      availableFrom: existing.availableFrom,
    },
    {
      currentStatus: row.currentStatus,
      currentLocation: row.currentLocation,
      stateCode: row.stateCode,
      availableFrom: row.availableFrom,
    },
    AUDITED_MOVE_FIELDS,
  );

  if (change) {
    await recordAudit({
      entity: "crane",
      entityId: craneId,
      action: "crane_updated",
      oldValue: change.oldValue,
      newValue: change.newValue,
      craneId,
      actor: auditActor(actor),
    });
  }

  return await toView(row);
}

/**
 * The one-step quick action from brief 7.4: status and location together.
 *
 * Reads the existing crane and routes through `updateCrane` so there is one
 * implementation of the status rules, one geocode decision and one audit shape.
 * That matters more than the saving: two implementations of "set Engaged" is how
 * the available_from rule ends up enforced in one and forgotten in the other.
 */
export async function quickUpdateCrane(
  craneId: string,
  rawInput: unknown,
  actor: Actor,
) {
  const parsed = quickUpdateSchema.safeParse(rawInput);
  if (!parsed.success) throw parsed.error;
  const quick = parsed.data as QuickUpdateInput;

  const existing = await loadScoped(actor, craneId);
  assertNotSystemLocked(existing);

  return updateCrane(
    craneId,
    {
      typeOfCraneCode: existing.typeOfCraneCode,
      capacityT: Number(existing.capacityT),
      currentLocation: quick.currentLocation,
      stateCode: quick.stateCode,
      make: existing.make,
      model: existing.model,
      yom: existing.yom,
      mainBoomM:
        existing.mainBoomM === null ? undefined : Number(existing.mainBoomM),
      fixedJibM:
        existing.fixedJibM === null ? undefined : Number(existing.fixedJibM),
      luffingJibM:
        existing.luffingJibM === null
          ? undefined
          : Number(existing.luffingJibM),
      windJibM:
        existing.windJibM === null ? undefined : Number(existing.windJibM),
      serialRegistrationNo: existing.serialRegistrationNo,
      pincode: quick.pincode,
      // Undefined rather than null: null would read as "clear the pin" and wipe
      // a good one whenever the vendor only changed the status.
      latitude: quick.latitude ?? undefined,
      longitude: quick.longitude ?? undefined,
      remarks: existing.remarks ?? undefined,
      currentStatus: quick.currentStatus,
      availableFrom: quick.availableFrom,
    },
    actor,
  );
}

/**
 * "Duplicate this crane" (brief 7.4): a prefill for a new entry, not a copy.
 *
 * The serial is deliberately left blank. It is the one field that cannot be
 * reused — it is unique among the vendor's active cranes — so copying it would
 * produce a form that fails on submit for a reason the vendor did not cause.
 */
export async function duplicateCranePrefill(actor: Actor, craneId: string) {
  const row = await loadScoped(actor, craneId);
  return {
    typeOfCraneCode: row.typeOfCraneCode,
    capacityT: Number(row.capacityT),
    make: row.make,
    model: row.model,
    yom: row.yom,
    mainBoomM: row.mainBoomM === null ? null : Number(row.mainBoomM),
    fixedJibM: row.fixedJibM === null ? null : Number(row.fixedJibM),
    luffingJibM: row.luffingJibM === null ? null : Number(row.luffingJibM),
    windJibM: row.windJibM === null ? null : Number(row.windJibM),
    // The new crane starts AVAILABLE. Copying a Booked/Hired status would
    // prefill something the create schema rejects and no vendor can choose.
    currentStatus:
      row.currentStatus === "AVAILABLE" ? "AVAILABLE" : "AVAILABLE",
    serialRegistrationNo: "",
    currentLocation: row.currentLocation,
    stateCode: row.stateCode,
    pincode: row.pincode,
    remarks: row.remarks,
  };
}

/**
 * "Confirm still accurate" (brief 6.5): refreshes the update timestamp and
 * changes nothing else. No audit row for the data, because no data moved — but
 * the confirmation itself is worth recording.
 */
export async function confirmCraneAccurate(craneId: string, actor: Actor) {
  await loadScoped(actor, craneId);
  const now = new Date();

  const row = await prisma.crane.update({
    where: { id: craneId },
    data: { statusUpdatedAt: now, updatedBy: actor.id },
    select: { ...CRANE_SELECT, vendor: { select: { name: true } } },
  });

  await recordAudit({
    entity: "crane",
    entityId: craneId,
    action: "crane_confirmed_accurate",
    newValue: { statusUpdatedAt: now.toISOString() },
    craneId,
    actor: auditActor(actor),
  });

  return await toView(row);
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

/**
 * Soft delete (brief 7.4). Cranes are never hard-deleted: quotations and audit
 * rows point at them, and the history of a hired crane has to stay readable.
 */
export async function deactivateCrane(craneId: string, actor: Actor) {
  const existing = await loadScoped(actor, craneId);
  if (!existing.isActive) return await toView(existing);

  const row = await prisma.crane.update({
    where: { id: craneId },
    data: { isActive: false, updatedBy: actor.id },
    select: { ...CRANE_SELECT, vendor: { select: { name: true } } },
  });

  await recordAudit({
    entity: "crane",
    entityId: craneId,
    action: "crane_deactivated",
    oldValue: { isActive: true },
    newValue: { isActive: false },
    craneId,
    actor: auditActor(actor),
  });

  return await toView(row);
}

/** The way back from a mistaken deactivation. */
export async function reactivateCrane(craneId: string, actor: Actor) {
  const existing = await loadScoped(actor, craneId);
  if (existing.isActive) return await toView(existing);

  // Reactivating puts the crane back under the duplicate rule, which is the
  // point at which the partial unique index can bite.
  await assertNoDuplicate(
    existing.vendorId,
    existing.serialRegistrationNo,
    craneId,
  );

  const row = await prisma.crane.update({
    where: { id: craneId },
    data: { isActive: true, updatedBy: actor.id },
    select: { ...CRANE_SELECT, vendor: { select: { name: true } } },
  });

  await recordAudit({
    entity: "crane",
    entityId: craneId,
    action: "crane_reactivated",
    oldValue: { isActive: false },
    newValue: { isActive: true },
    craneId,
    actor: auditActor(actor),
  });

  return await toView(row);
}

// ---------------------------------------------------------------------------
// Load chart
// ---------------------------------------------------------------------------

/**
 * Attaches or replaces a crane's load chart (brief 5.2). Optional on the crane,
 * but required later when a quote is submitted against it (brief 6.7).
 *
 * The previous file is removed after the row is repointed, so a failed write
 * never leaves the crane without a chart it used to have.
 */
export async function uploadLoadChart(
  craneId: string,
  file: ValidatedUpload,
  actor: Actor,
) {
  const existing = await loadScoped(actor, craneId);

  const stored = await storage().save(file.buffer, {
    fileName: file.fileName,
    mimeType: file.mimeType,
    scope: `vendors/${existing.vendorId}/cranes/${craneId}`,
  });

  const previousRef = existing.loadChartFileRef;

  const row = await prisma.crane.update({
    where: { id: craneId },
    data: {
      loadChartFileRef: stored.fileRef,
      loadChartFileName: stored.fileName,
      loadChartMimeType: stored.mimeType,
      loadChartSizeBytes: stored.sizeBytes,
      updatedBy: actor.id,
    },
    select: { ...CRANE_SELECT, vendor: { select: { name: true } } },
  });

  if (previousRef && previousRef !== stored.fileRef) {
    try {
      await storage().remove(previousRef);
    } catch (err) {
      // A leftover file is untidy, not harmful; failing the request here would
      // tell the vendor their upload did not work when it did.
      console.error("[crane] could not remove the replaced load chart", err);
    }
  }

  await recordAudit({
    entity: "crane",
    entityId: craneId,
    action: "crane_load_chart_uploaded",
    newValue: { fileName: stored.fileName, sizeBytes: stored.sizeBytes },
    craneId,
    actor: auditActor(actor),
  });

  return await toView(row);
}

/** Downloads a load chart. Scoped exactly like the crane itself. */
export async function readLoadChart(actor: Actor, craneId: string) {
  const row = await loadScoped(actor, craneId);
  if (!row.loadChartFileRef)
    throw AppError.notFound("This crane has no load chart");
  const buffer = await storage().read(row.loadChartFileRef);
  return {
    buffer,
    fileName: row.loadChartFileName ?? "load-chart",
    mimeType: row.loadChartMimeType ?? "application/octet-stream",
  };
}

// ---------------------------------------------------------------------------
// Fleet approval (brief 6.4)
// ---------------------------------------------------------------------------

/**
 * Releases or holds a crane pending review. Admin only.
 *
 * The review UI is deferred, but the endpoint exists so the code path is real:
 * with FLEET_APPROVAL_REQUIRED on, cranes arrive PENDING and this is what
 * clears them.
 */
export async function setCraneApproval(
  craneId: string,
  rawInput: unknown,
  actor: Actor,
): Promise<CraneView> {
  if (!can(actor.role, "vendor:approve")) {
    throw AppError.forbidden("Only an administrator can review fleet changes");
  }
  const status =
    rawInput &&
    typeof rawInput === "object" &&
    (rawInput as any).approvalStatus === "APPROVED"
      ? CraneApprovalStatus.APPROVED
      : rawInput &&
          typeof rawInput === "object" &&
          (rawInput as any).approvalStatus === "PENDING"
        ? CraneApprovalStatus.PENDING
        : (() => {
            throw AppError.badRequest(
              "approvalStatus must be APPROVED or PENDING",
            );
          })();

  const existing = await prisma.crane.findUnique({
    where: { id: craneId },
    select: { id: true, approvalStatus: true },
  });
  if (!existing) throw AppError.notFound("Crane not found");

  const row = await prisma.crane.update({
    where: { id: craneId },
    data: { approvalStatus: status, updatedBy: actor.id },
    select: {
      ...CRANE_SELECT,
      vendor: { select: { name: true } },
      typeOfCrane: { select: { code: true, name: true } },
      state: { select: { code: true, name: true } },
    },
  });

  await recordAudit({
    entity: "crane",
    entityId: craneId,
    action: "crane_approval_changed",
    oldValue: { approvalStatus: existing.approvalStatus },
    newValue: { approvalStatus: status },
    craneId,
    actor: auditActor(actor),
  });

  return await toView(row);
}
