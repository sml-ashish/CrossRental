import { z } from "zod";
import { CapacityRule, CraneStatus, OwnershipType } from "../generated/prisma/client";

/**
 * Manual vendor discovery filters (BPD 6.8 / 5.9). The search is standalone —
 * it does not need an enquiry — so these are free-form query fields rather than
 * anything carried on an entity.
 *
 * "location" is free text over the crane's current location (and its state
 * name); "region" is the crane's state code. They are separate because the
 * brief lists both: a user may know the city but not the state, or want every
 * crane in a state. "vendorRegion" narrows to a vendor's declared operating
 * regions, which is a different thing from where a crane is parked today.
 */

const trimmed = (max: number) => z.string().trim().max(max);

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v): string | undefined => {
      if (v === undefined || v === null) return undefined;
      const text = String(v).trim();
      return text === "" ? undefined : text;
    });

const optionalNumber = (label: string) =>
  z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v, ctx): number | undefined => {
      if (v === undefined || v === null || String(v).trim() === "") return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: `${label} must be a number` });
        return undefined;
      }
      return n;
    });

const optionalPositive = (label: string) =>
  optionalNumber(label).refine(
    (n) => n === undefined || n > 0,
    `${label} must be greater than 0`,
  );

const optionalInt = (label: string, min: number, max: number) =>
  optionalNumber(label)
    .refine((n) => n === undefined || Number.isInteger(n), `${label} must be a whole number`)
    .refine((n) => n === undefined || (n >= min && n <= max), `${label} must be between ${min} and ${max}`);

/** Filter values the discovery screen understands for a crane's availability. */
export const AVAILABILITY_VALUES = [
  CraneStatus.AVAILABLE,
  CraneStatus.ENGAGED,
  CraneStatus.UNDER_MAINTENANCE,
  "ALL",
] as const;

export const discoveryQuerySchema = z.object({
  craneType: optionalText(50),
  capacityT: optionalPositive("Capacity"),
  capacityRule: z.nativeEnum(CapacityRule).optional(),
  location: trimmed(120).optional(),
  region: trimmed(10).optional(),
  vendorName: trimmed(200).optional(),
  vendorRegion: trimmed(10).optional(),
  companySize: optionalText(60),
  fleetSizeMin: optionalInt("Fleet size", 0, 100_000),
  yomFrom: optionalInt("Year of manufacture", 1950, 2100),
  yomTo: optionalInt("Year of manufacture", 1950, 2100),
  ownershipType: z.nativeEnum(OwnershipType).optional(),
  availability: z.enum(AVAILABILITY_VALUES).optional(),
  includeInactive: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
  /** An optional site pin; when both are present the list is distance-ranked. */
  siteLat: optionalNumber("Site latitude"),
  siteLng: optionalNumber("Site longitude"),
});

export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;
