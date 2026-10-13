import { prisma } from "../lib/database";
import {
  straightLineKm,
  tryRoadDistance,
  type DistanceMethod,
  type GeoPoint,
} from "../lib/geo";

/**
 * Distance from a crane to an RFQ job site (brief 6.9).
 *
 * Three decisions in here are the brief's, not mine, and each one is load-bearing.
 *
 * **A failed route falls back to straight-line, and says so.** Brief 6.9 asks for
 * road distance, then says that when routing fails the UI shows straight-line
 * labelled "straight-line (approx.)" and stores which method produced the
 * number. So the method is part of the result, not a detail: a sales user
 * comparing a 40 km straight-line against a 90 km road figure must be able to
 * see that they are not looking at the same thing.
 *
 * **Coordinates are rounded to three decimals before anything else.** That is
 * ~110 m at the equator, finer than the geocoding we are caching in the first
 * place, and it collapses the near-identical points that would otherwise each
 * pay for a provider call. It is also the cache key, so this rounding *is* the
 * reuse rule.
 *
 * **A straight-line fallback is never cached as if it were a road distance.**
 * The cache stores the road figure. If routing failed we compute the fallback
 * and return it uncached, so a later successful route is not shadowed by a
 * cached approximation — the alternative is a permanently degraded number that
 * nobody can tell apart from a real one.
 */

const CACHE_DAYS = 30;

export interface Distance {
  km: number;
  method: DistanceMethod;
  /** True when `km` is an approximation the UI must label. */
  approximate: boolean;
  provider: string;
  /** True when this came out of the cache rather than the provider. */
  cached: boolean;
}

/** Cache granularity in decimal degrees; ~110 m, well below geocode precision. */
const PRECISION = 3;

function roundCoord(value: number): number {
  return Number(value.toFixed(PRECISION));
}

function cacheKey(origin: GeoPoint, destination: GeoPoint) {
  return {
    originLat: roundCoord(origin.lat),
    originLng: roundCoord(origin.lng),
    destLat: roundCoord(destination.lat),
    destLng: roundCoord(destination.lng),
  };
}

function toPoint(lat: unknown, lng: unknown): GeoPoint | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined)
    return null;
  const point = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(point.lat) && Number.isFinite(point.lng)
    ? point
    : null;
}

function isFresh(calculatedAt: Date): boolean {
  return Date.now() - calculatedAt.getTime() < CACHE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Distance between two points, preferring a cached or live road route.
 *
 * Returns `null` only when there is genuinely nothing to measure — a missing
 * coordinate. A missing coordinate is not an error and not a zero: it means the
 * candidate belongs in the "location unverified" group instead.
 */
export async function distanceBetween(
  origin: GeoPoint,
  destination: GeoPoint,
): Promise<Distance | null> {
  const key = cacheKey(origin, destination);

  const cached = await prisma.distanceCache.findFirst({
    where: key,
    select: { roadDistanceKm: true, provider: true, calculatedAt: true },
  });

  if (cached && isFresh(cached.calculatedAt)) {
    return {
      km: Number(cached.roadDistanceKm),
      method: "road",
      approximate: false,
      provider: cached.provider,
      cached: true,
    };
  }

  const result = await tryRoadDistance(origin, destination);

  if (result.ok) {
    // Honour the provider's own method rather than assuming "road".
    //
    // A provider may answer successfully and still be reporting an
    // approximation — the stub does exactly this, scaling the straight line by a
    // detour factor and labelling it `straight_line` precisely so it cannot be
    // mistaken for a routed figure. Hardcoding "road" here would put an
    // unlabelled approximation into every candidate list, which is the exact
    // failure brief 6.9 asks to prevent.
    const method = result.method;

    // Only a road figure is cacheable. Brief 6.9's fallback must not be stored
    // under a road distance, or it would shadow the real number for 30 days once
    // routing starts working and nobody could tell the two apart.
    if (method === "road") {
      // Best-effort: a cache write failure must not fail the distance.
      try {
        await prisma.distanceCache.create({
          data: { ...key, roadDistanceKm: result.km, provider: result.provider },
        });
      } catch (err) {
        console.error("[distance] could not cache", err);
      }
    }

    return {
      km: result.km,
      method,
      approximate: method !== "road",
      provider: result.provider,
      cached: false,
    };
  }

  // Routing is unavailable. Brief 6.9: fall back and label it.
  return {
    km: Number(straightLineKm(origin, destination).toFixed(2)),
    method: "straight_line",
    approximate: true,
    provider: "haversine",
    cached: false,
  };
}

/**
 * Distances from many origins to one destination.
 *
 * Sequential rather than parallel on purpose: a real provider will rate-limit,
 * and firing an unbounded `Promise.all` at one is how a quota disappears. The
 * cache absorbs the repeat calls, which is the case that actually matters.
 */
export async function distancesTo(
  destination: GeoPoint,
  origins: GeoPoint[],
): Promise<Array<Distance | null>> {
  const out: Array<Distance | null> = [];
  for (const origin of origins) {
    out.push(await distanceBetween(origin, destination));
  }
  return out;
}

/**
 * Drop cached distances from a point whose coordinates just changed (brief 6.9:
 * "invalidate when a crane's coordinates change").
 *
 * Strictly this is belt-and-braces — a moved crane hashes to a different key, so
 * it would miss the cache anyway. It is here because the *job site* moving is
 * different: `Vadodara yard` and `Vadodara plant` can round to the same three
 * decimals while meaning different places, and a stale row would keep answering
 * for the old one for 30 days.
 */
export async function invalidateDistancesFrom(point: GeoPoint): Promise<void> {
  try {
    await prisma.distanceCache.deleteMany({
      where: {
        originLat: roundCoord(point.lat),
        originLng: roundCoord(point.lng),
      },
    });
  } catch (err) {
    console.error("[distance] could not invalidate", err);
  }
}

/** Exposed for the crane service, which stores Decimals rather than numbers. */
export { toPoint as pointFromStored };
