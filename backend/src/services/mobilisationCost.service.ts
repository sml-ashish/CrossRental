import { prisma } from "../lib/database";
import type { OwnershipType } from "../generated/prisma/client";
import type { MobilisationRateSeed } from "../lib/mobilisationRates";

/**
 * Estimated mobilisation cost (BPD 5.5, P2 section 2).
 *
 * Cost is road distance times a per-km rate for the crane's category and size.
 * The table is small and read whole once per evaluation rather than queried per
 * crane: the distance loop already pays the provider, and a round trip per
 * crane would be the slowest part of a five-vendor list.
 *
 * Nothing here throws. A crane the rate table does not cover yields a null cost,
 * and a null cost is shown as "—" rather than guessed at — a fabricated rupee
 * figure next to a real distance is worse than an obvious gap.
 */

export interface RateRow {
  craneTypeCode: string;
  capacityMinT: number;
  capacityMaxT: number | null;
  ownershipType: OwnershipType | null;
  ratePerKm: number;
}

export interface RateLookup {
  craneTypeCode: string;
  capacityT: number;
  /** Null when the crane's ownership is unknown; the generic rate then applies. */
  ownershipType: OwnershipType | null;
}

export async function loadRateTable(): Promise<RateRow[]> {
  const rows = await prisma.mobilisationRate.findMany({
    where: { isActive: true },
    select: {
      craneTypeCode: true,
      capacityMinT: true,
      capacityMaxT: true,
      ownershipType: true,
      ratePerKm: true,
    },
  });
  return rows.map((row) => ({
    craneTypeCode: row.craneTypeCode,
    capacityMinT: Number(row.capacityMinT),
    capacityMaxT: row.capacityMaxT === null ? null : Number(row.capacityMaxT),
    ownershipType: row.ownershipType,
    ratePerKm: Number(row.ratePerKm),
  }));
}

/**
 * The best rate for a crane: the narrowest capacity band that contains it,
 * preferring a row that names the crane's ownership over a generic row.
 */
export function pickRate(table: RateRow[], input: RateLookup): number | null {
  const inBand = table.filter(
    (row) =>
      row.craneTypeCode === input.craneTypeCode &&
      row.capacityMinT <= input.capacityT &&
      (row.capacityMaxT === null || row.capacityMaxT >= input.capacityT),
  );
  if (inBand.length === 0) return null;

  const specific = inBand.filter(
    (row) => input.ownershipType !== null && row.ownershipType === input.ownershipType,
  );
  const generic = inBand.filter((row) => row.ownershipType === null);
  const pool = specific.length > 0 ? specific : generic;
  if (pool.length === 0) return null;

  // Highest lower bound wins: the bands are non-overlapping, so this is the
  // containing band rather than an arbitrary pick among ties.
  const best = pool.reduce((a, b) => (b.capacityMinT > a.capacityMinT ? b : a));
  return best.ratePerKm;
}

/** Rupees, rounded to whole rupees — the input is an estimate, not a quote. */
export function estimateMobilisationCost(km: number, ratePerKm: number): number {
  return Math.round(km * ratePerKm);
}

/** Upserts the seed table. Idempotent; used by the seed and the test harness. */
export async function seedMobilisationRates(
  client: typeof prisma,
  rates: MobilisationRateSeed[],
): Promise<void> {
  for (const rate of rates) {
    const ownershipType = rate.ownershipType ?? null;
    const existing = await client.mobilisationRate.findFirst({
      where: {
        craneTypeCode: rate.craneTypeCode,
        capacityMinT: rate.capacityMinT,
        capacityMaxT: rate.capacityMaxT,
        ownershipType,
      },
      select: { id: true },
    });
    if (existing) continue;
    await client.mobilisationRate.create({
      data: {
        craneTypeCode: rate.craneTypeCode,
        capacityMinT: rate.capacityMinT,
        capacityMaxT: rate.capacityMaxT,
        ownershipType,
        ratePerKm: rate.ratePerKm,
      },
    });
  }
}
