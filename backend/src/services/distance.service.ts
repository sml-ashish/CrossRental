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

/**
 * The stored key, as a fixed three-decimal string.
 *
 * The columns are `numeric`, and a JavaScript number is sent as a float: for a
 * value like `23.023` the two are not bit-identical, so Postgres compares
 * `numeric = double precision` by casting the exact decimal to a binary float
 * and the lookup misses. A string is parsed as an exact decimal by the driver,
 * so the cache actually hits. This was invisible until real coordinates with
 * three decimals arrived — `18.5` is exactly representable and `23.023` is not.
 */
function cacheKey(origin: GeoPoint, destination: GeoPoint) {
  const coord = (value: number) => value.toFixed(PRECISION);
  return {
    originLat: coord(origin.lat),
    originLng: coord(origin.lng),
    destLat: coord(destination.lat),
    destLng: coord(destination.lng),
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

  // Best-effort, like the write below: a cache read failure must degrade to a
  // provider call, not fail the page.
  let cached: {
    roadDistanceKm: unknown;
    provider: string;
    calculatedAt: Date;
  } | null = null;
  try {
    cached = await prisma.distanceCache.findFirst({
      where: key,
      select: { roadDistanceKm: true, provider: true, calculatedAt: true },
    });
  } catch (err) {
    console.error("[distance] could not read cache", err);
  }

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
 * Bounded concurrency rather than one at a time or all at once. One at a time
 * made a 64-crane discovery take 17 seconds of pure waiting per new job site,
 * which is a bad screen and a timeout risk at real fleet sizes; an unbounded
 * `Promise.all` is how a provider quota disappears. Four in flight keeps a real
 * fleet inside a few seconds while staying well below per-second limits, and the
 * cache still absorbs every repeat search.
 */
export async function distancesTo(
  destination: GeoPoint,
  origins: GeoPoint[],
  concurrency = 4,
): Promise<Array<Distance | null>> {
  const out: Array<Distance | null> = new Array(origins.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < origins.length) {
      const index = next++;
      out[index] = await distanceBetween(origins[index] as GeoPoint, destination);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, origins.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
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
        originLat: point.lat.toFixed(PRECISION),
        originLng: point.lng.toFixed(PRECISION),
      },
    });
  } catch (err) {
    console.error("[distance] could not invalidate", err);
  }
}

/** Exposed for the crane service, which stores Decimals rather than numbers. */
export { toPoint as pointFromStored };
