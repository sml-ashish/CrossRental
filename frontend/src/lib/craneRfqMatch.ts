import type { RaisableLine } from "@/lib/enquiries";
import { formatStartShort } from "@/lib/rfq-display";
import type { CapacityRule } from "@/lib/enquiries";
import type { DurationUnit, RfqListRow } from "@/lib/rfqs";

/**
 * A client-side hint: how well does this crane fit this requirement?
 *
 * The server stays the source of truth. Nothing here decides whether an RFQ can
 * be sent or a line raised — it only sorts and explains, so a mismatch is
 * visible before someone spends a message on it. A failed check is a warning,
 * never a block.
 */

export type MatchLevel = "best" | "possible" | "check";

export interface MatchReason {
  ok: boolean;
  text: string;
}

export interface CraneMatch {
  level: MatchLevel;
  reasons: MatchReason[];
  /** Straight-line distance when both sides carry a pin. */
  distanceKm: number | null;
}

export interface MatchCrane {
  craneId: string;
  vendorId: string;
  vendorName: string;
  typeOfCraneCode: string;
  typeOfCraneName: string;
  capacityT: number;
  mainBoomM: number | null;
  currentLocation: string;
  stateCode: string;
  stateName: string;
  availableFrom: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** The calendar's free run for one crane, not the whole period on screen. */
export interface FreeWindow {
  from: string;
  to: string | null;
}

export interface MatchRequirement {
  craneTypeCode: string | null;
  craneTypeName: string | null;
  capacityT: number | null;
  capacityRule: CapacityRule;
  mainBoomM: number | null;
  startDateTbc: boolean;
  requiredStartDate: string | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  siteStateCode: string | null;
  siteStateName: string | null;
  siteLocation: string | null;
  siteLatitude: number | null;
  siteLongitude: number | null;
}

const DAY_MS = 86_400_000;

function dayValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const date = new Date(parsed);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** A UTC day number as the portal writes dates: "13 Nov". */
function dayLabel(value: number): string {
  return formatStartShort(new Date(value).toISOString());
}

function roundCapacity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function durationDays(requirement: MatchRequirement): number | null {
  if (requirement.durationValue === null || requirement.durationValue <= 0) return null;
  return requirement.durationUnit === "MONTHS"
    ? requirement.durationValue * 30
    : requirement.durationValue;
}

/** Great-circle distance, labelled as straight-line wherever it is shown. */
function distanceKm(
  fromLat: number | null,
  fromLng: number | null,
  toLat: number | null,
  toLng: number | null,
): number | null {
  if (fromLat === null || fromLng === null || toLat === null || toLng === null) return null;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(toLat - fromLat);
  const dLng = radians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function requirementFromRfq(rfq: RfqListRow): MatchRequirement {
  return {
    craneTypeCode: rfq.craneType || null,
    craneTypeName: rfq.craneTypeRef?.name ?? rfq.craneType ?? null,
    capacityT: rfq.capacityT,
    capacityRule: rfq.capacityRule,
    mainBoomM: rfq.mainBoomM,
    startDateTbc: rfq.startDateTbc,
    requiredStartDate: rfq.requiredStartDate,
    durationValue: rfq.durationValue,
    durationUnit: rfq.durationUnit,
    siteStateCode: rfq.siteStateCode || null,
    siteStateName: rfq.siteState?.name ?? null,
    siteLocation: rfq.siteLocation,
    siteLatitude: rfq.siteLatitude,
    siteLongitude: rfq.siteLongitude,
  };
}

export function requirementFromLine(line: RaisableLine): MatchRequirement {
  return {
    craneTypeCode: line.craneTypeCode,
    craneTypeName: line.craneTypeName,
    capacityT: line.capacityT,
    // Enquiries no longer choose a matching rule; RFQs default to at least.
    capacityRule: "AT_LEAST",
    mainBoomM: null,
    startDateTbc: line.startDateTbc,
    requiredStartDate: line.requiredStartDate,
    durationValue: null,
    durationUnit: null,
    siteStateCode: null,
    siteStateName: line.siteStateName,
    siteLocation: line.shipToCity,
    siteLatitude: null,
    siteLongitude: null,
  };
}

export function matchRequirement(
  crane: MatchCrane,
  requirement: MatchRequirement,
  freeWindow?: FreeWindow,
): CraneMatch {
  const reasons: MatchReason[] = [];

  // --- Type ---------------------------------------------------------------
  let typeOk = true;
  if (requirement.craneTypeCode) {
    typeOk = crane.typeOfCraneCode === requirement.craneTypeCode;
    reasons.push({
      ok: typeOk,
      text: typeOk
        ? `${crane.typeOfCraneName} matches the requirement`
        : `${crane.typeOfCraneName} vs ${requirement.craneTypeName ?? requirement.craneTypeCode} required`,
    });
  }

  // --- Capacity -----------------------------------------------------------
  let capacityOk = true;
  if (requirement.capacityT !== null) {
    const required = requirement.capacityT;
    const rule = requirement.capacityRule === "EXACT" ? "exactly" : "at least";
    if (requirement.capacityRule === "EXACT") {
      capacityOk = roundCapacity(crane.capacityT) === roundCapacity(required);
    } else {
      capacityOk = crane.capacityT >= required;
    }
    reasons.push({
      ok: capacityOk,
      text: `${roundCapacity(crane.capacityT)} t vs ${roundCapacity(required)} t required (${rule})`,
    });
  }

  // --- Boom (only when the requirement names one) -------------------------
  let boomOk = true;
  if (requirement.mainBoomM !== null) {
    boomOk = crane.mainBoomM !== null && crane.mainBoomM >= requirement.mainBoomM;
    reasons.push({
      ok: boomOk,
      text:
        crane.mainBoomM === null
          ? `${requirement.mainBoomM} m main boom required; the crane's boom is not recorded`
          : `${crane.mainBoomM} m main boom vs ${requirement.mainBoomM} m required`,
    });
  }

  // --- Dates --------------------------------------------------------------
  let datesOk = true;
  const start = dayValue(requirement.requiredStartDate);
  if (!requirement.startDateTbc && start !== null) {
    const freeFrom = dayValue(crane.availableFrom) ?? dayValue(freeWindow?.from ?? null);
    const freeTo = dayValue(freeWindow?.to ?? null);

    if (freeFrom !== null) {
      datesOk = freeFrom <= start;
      reasons.push({
        ok: datesOk,
        text: datesOk
          ? `Free from ${dayLabel(freeFrom)} · starts ${dayLabel(start)}`
          : `Free from ${dayLabel(freeFrom)}, job starts ${dayLabel(start)}`,
      });
    } else {
      reasons.push({
        ok: true,
        text: `Availability not recorded · job starts ${dayLabel(start)}`,
      });
    }

    const days = durationDays(requirement);
    if (days !== null && freeTo !== null) {
      const end = start + (days - 1) * DAY_MS;
      const covered = end <= freeTo;
      datesOk = datesOk && covered;
      if (!covered) {
        reasons.push({
          ok: false,
          text: `Hire runs to ${dayLabel(end)}, past the free window`,
        });
      }
    }
  }

  // --- Location -----------------------------------------------------------
  let locationOk = true;
  if (requirement.siteStateCode || requirement.siteStateName) {
    const sameState = requirement.siteStateCode
      ? crane.stateCode.toUpperCase() === requirement.siteStateCode.toUpperCase()
      : normalise(crane.stateName) === normalise(requirement.siteStateName);
    locationOk = sameState;
    const km = distanceKm(
      crane.latitude,
      crane.longitude,
      requirement.siteLatitude,
      requirement.siteLongitude,
    );
    reasons.push({
      ok: sameState,
      text: sameState
        ? `Same state${km === null ? "" : ` · ${km} km straight line`}`
        : `Different state: ${crane.stateName} vs ${requirement.siteStateName ?? requirement.siteStateCode}`,
    });
    if (!sameState && km !== null) {
      reasons.push({ ok: false, text: `${km} km straight line to the site` });
    }
  } else if (requirement.siteLocation) {
    reasons.push({ ok: true, text: `Site: ${requirement.siteLocation}` });
  }

  const km = distanceKm(
    crane.latitude,
    crane.longitude,
    requirement.siteLatitude,
    requirement.siteLongitude,
  );
  return finish(typeOk, capacityOk, boomOk, datesOk, locationOk, reasons, km);
}

function finish(
  typeOk: boolean,
  capacityOk: boolean,
  boomOk: boolean,
  datesOk: boolean,
  locationOk: boolean,
  reasons: MatchReason[],
  km: number | null,
): CraneMatch {
  if (!typeOk || !capacityOk) {
    return { level: "check", reasons, distanceKm: km };
  }
  if (boomOk && datesOk && locationOk) {
    return { level: "best", reasons, distanceKm: km };
  }
  return { level: "possible", reasons, distanceKm: km };
}

export function matchRfq(
  crane: MatchCrane,
  rfq: RfqListRow,
  freeWindow?: FreeWindow,
): CraneMatch {
  return matchRequirement(crane, requirementFromRfq(rfq), freeWindow);
}

export function matchLine(
  crane: MatchCrane,
  line: RaisableLine,
  freeWindow?: FreeWindow,
): CraneMatch {
  return matchRequirement(crane, requirementFromLine(line), freeWindow);
}

const LEVEL_RANK: Record<MatchLevel, number> = { best: 0, possible: 1, check: 2 };

/**
 * Best first, then the soonest required start. An unknown or TBC start sorts
 * last rather than pretending to be urgent.
 */
export function sortByFit<T extends { match: CraneMatch; requiredStartDate: string | null }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const byLevel = LEVEL_RANK[a.match.level] - LEVEL_RANK[b.match.level];
    if (byLevel !== 0) return byLevel;
    const aStart = dayValue(a.requiredStartDate);
    const bStart = dayValue(b.requiredStartDate);
    if (aStart === null && bStart === null) return 0;
    if (aStart === null) return 1;
    if (bStart === null) return -1;
    return aStart - bStart;
  });
}
