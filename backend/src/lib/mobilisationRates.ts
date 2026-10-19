import type { OwnershipType } from "../generated/prisma/client";

/**
 * Per-km mobilisation rates by crane category and capacity band (BPD 5.5, P2
 * section 2).
 *
 * The rate/pre-km model is the brief's: estimated mobilisation cost is road
 * distance multiplied by the rate for the crane's category and size. The real
 * values are the owner's to supply (open item 4); until Admin Configuration (P5)
 * exists they are seeded into `mobilisation_rates` from the table below. Every
 * figure here is fabricated demo data.
 *
 * Bands are half-open: `[min, max]`, with a null max meaning "no upper bound".
 * A rate row with no ownership column applies to any crane; a row that names an
 * ownership type wins over the generic one for that crane.
 */

export interface MobilisationRateSeed {
  craneTypeCode: string;
  capacityMinT: number;
  capacityMaxT: number | null;
  ownershipType?: OwnershipType | null;
  ratePerKm: number;
}

/** ₹ per km, before the category multiplier. Fabricated values. */
const BANDS: Array<{ min: number; max: number | null; multiplier: number }> = [
  { min: 0, max: 50, multiplier: 0.5 },
  { min: 50, max: 150, multiplier: 0.8 },
  { min: 150, max: 400, multiplier: 1.2 },
  { min: 400, max: 1000, multiplier: 2 },
  { min: 1000, max: null, multiplier: 3.5 },
];

const BASE_BY_TYPE: Record<string, number> = {
  MINI_CRAWLER: 250,
  TRACTOR_MOUNTED: 300,
  TRUCK_MOUNTED: 320,
  ROUGH_TERRAIN: 350,
  ALL_TERRAIN: 400,
  TYRE_MOUNTED: 450,
  CRAWLER: 600,
  TOWER: 700,
};

export const MOBILISATION_RATES: MobilisationRateSeed[] = Object.entries(
  BASE_BY_TYPE,
).flatMap(([craneTypeCode, base]) =>
  BANDS.map((band) => ({
    craneTypeCode,
    capacityMinT: band.min,
    capacityMaxT: band.max,
    ratePerKm: Math.round(base * band.multiplier),
  })),
);
