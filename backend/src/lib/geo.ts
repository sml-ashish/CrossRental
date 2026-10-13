import { env } from "../config/env";

/**
 * Geocoding and distance, behind an interface (brief 6.8).
 *
 * The provider decision is explicitly on hold, so what exists here is the seam
 * rather than a chosen vendor: a real provider implements `GeoProvider` and is
 * selected in `getGeoProvider()` without any caller changing.
 *
 * Two things follow from the decision being open, and both matter:
 *
 * 1. **The stub is never used in production.** It invents coordinates, and a
 *    fabricated pin on a real crane is worse than no pin — it would flow into
 *    distance sorting and candidate lists as though it were real. In production
 *    `geocode` therefore always fails, which is brief 6.8's "cranes stay
 *    location unverified", and the vendor is prompted to drop a pin by hand.
 * 2. **A failed geocode is never fatal.** Brief 6.3 requires the crane to be
 *    saved anyway and flagged unverified, so every failure path here is a
 *    value the caller can handle, not an exception it must catch.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type GeocodeResult =
  | { ok: true; point: GeoPoint; provider: string }
  | { ok: false; reason: string };

export type DistanceMethod = "road" | "straight_line";

export type DistanceResult =
  | { ok: true; km: number; method: DistanceMethod; provider: string }
  | { ok: false; reason: string };

export interface GeoProvider {
  /** Recorded on the crane as `geocodedBy` so a coordinate is traceable. */
  readonly name: string;
  /** True when coordinates from this provider are real rather than synthetic. */
  readonly isAuthoritative: boolean;
  geocode(input: { location: string; state: string; pincode?: string | null }): Promise<GeocodeResult>;
  roadDistance(origin: GeoPoint, destination: GeoPoint): Promise<DistanceResult>;
}

/**
 * India's bounding box (brief 5.2). Coordinates outside it are rejected with a
 * message the vendor can act on. The same bounds exist as a CHECK constraint in
 * the database; this is the friendly layer in front of it.
 */
export const INDIA_BOUNDS = { minLat: 6, maxLat: 38, minLng: 68, maxLng: 98 } as const;

export function isInsideIndia(point: GeoPoint): boolean {
  return (
    point.lat >= INDIA_BOUNDS.minLat &&
    point.lat <= INDIA_BOUNDS.maxLat &&
    point.lng >= INDIA_BOUNDS.minLng &&
    point.lng <= INDIA_BOUNDS.maxLng
  );
}

export class OutsideIndiaError extends Error {
  constructor(point: GeoPoint) {
    super(
      `That pin is outside India (latitude ${point.lat.toFixed(4)}, longitude ${point.lng.toFixed(
        4,
      )}). Drag the pin to the crane's location.`,
    );
    this.name = "OutsideIndiaError";
  }
}

/** Great-circle distance in km. Real arithmetic, unlike the stub's road figure. */
export function straightLineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Deterministic pseudo-coordinate for a location string.
 *
 * A hash rather than a constant, so two different crane locations do not
 * collapse onto one pin — which would make the distance-sorted lists of M4 look
 * plausible while being meaningless.
 */
function syntheticPoint(seed: string): GeoPoint {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const lat = INDIA_BOUNDS.minLat + 1 + ((h >>> 8) % 10000) / 10000 * (INDIA_BOUNDS.maxLat - INDIA_BOUNDS.minLat - 2);
  const lng = INDIA_BOUNDS.minLng + 1 + ((h >>> 20) % 10000) / 10000 * (INDIA_BOUNDS.maxLng - INDIA_BOUNDS.minLng - 2);
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

/**
 * Development and test provider (brief 6.8: "a stub that returns fixed test
 * coordinates and distances").
 *
 * Its road distance is synthetic — the straight line scaled by a detour factor
 * — and is labelled `straight_line` so nothing downstream can mistake it for a
 * routed figure. Brief 6.9 requires that distinction to be visible to the user.
 */
class StubGeoProvider implements GeoProvider {
  readonly name = "stub";
  readonly isAuthoritative = false;

  async geocode(input: {
    location: string;
    state: string;
    pincode?: string | null;
  }): Promise<GeocodeResult> {
    const seed = `${input.state}|${input.pincode ?? ""}|${input.location}`.trim().toLowerCase();
    if (seed.replace(/\|/g, "") === "") {
      return { ok: false, reason: "No location text to geocode" };
    }
    return { ok: true, point: syntheticPoint(seed), provider: this.name };
  }

  async roadDistance(origin: GeoPoint, destination: GeoPoint): Promise<DistanceResult> {
    // Not a routed distance. Reported as straight_line on purpose.
    return {
      ok: true,
      km: Number((straightLineKm(origin, destination) * 1.3).toFixed(2)),
      method: "straight_line",
      provider: this.name,
    };
  }
}

/**
 * Used in production until a provider is chosen. Failing is the safe answer:
 * brief 6.3 says a crane with no coordinates is still saved and flagged
 * "location unverified", and brief 6.8 says distance shows as unavailable.
 */
class UnverifiedGeoProvider implements GeoProvider {
  readonly name = "none";
  readonly isAuthoritative = false;

  async geocode(): Promise<GeocodeResult> {
    return {
      ok: false,
      reason:
        "Automatic location lookup is not available yet. Drop a pin to confirm where this crane is.",
    };
  }

  async roadDistance(): Promise<DistanceResult> {
    return { ok: false, reason: "Distance lookup is not available yet." };
  }
}

let provider: GeoProvider | null = null;

export function getGeoProvider(): GeoProvider {
  if (!provider) {
    provider = env.nodeEnv === "production" ? new UnverifiedGeoProvider() : new StubGeoProvider();
  }
  return provider;
}

/** Test seam: lets a suite pin a provider without touching configuration. */
export function setGeoProvider(next: GeoProvider | null): void {
  provider = next;
}

/**
 * Geocodes, converting an out-of-bounds or failed result into a reason string.
 *
 * Never throws: brief 6.3 requires the crane to be saved even when the lookup
 * fails, so the caller gets `{ok: false}` and stores an unverified crane.
 */
export async function tryGeocode(input: {
  location: string;
  state: string;
  pincode?: string | null;
}): Promise<GeocodeResult> {
  try {
    const result = await getGeoProvider().geocode(input);
    if (result.ok && !isInsideIndia(result.point)) {
      return { ok: false, reason: "The lookup returned a point outside India" };
    }
    return result;
  } catch (err) {
    // A provider outage must not lose the vendor's data entry.
    console.error("[geo] geocode failed", err);
    return { ok: false, reason: "Location lookup failed. Drop a pin to confirm it by hand." };
  }
}

export async function tryRoadDistance(
  origin: GeoPoint,
  destination: GeoPoint,
): Promise<DistanceResult> {
  try {
    const result = await getGeoProvider().roadDistance(origin, destination);
    if (result.ok && !isInsideIndia(destination)) {
      return { ok: false, reason: "Destination is outside India" };
    }
    return result;
  } catch (err) {
    console.error("[geo] road distance failed", err);
    return { ok: false, reason: "Distance lookup failed" };
  }
}