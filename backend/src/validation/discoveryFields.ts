import { z } from "zod";
import { CapacityRule, CraneStatus } from "../generated/prisma/client";
import { isCalendarDate, parseCalendarDate } from "../lib/dates";

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

/**
 * A calendar day (`YYYY-MM-DD`) as UTC midnight, the same anchor the fleet form
 * and the booking calendar use. A bare month, a locale format or 31 February is
 * rejected rather than rolled into a day the user never asked for.
 */
const optionalCalendarDate = (label: string) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v, ctx): Date | undefined => {
      if (v === undefined || v === null || String(v).trim() === "") return undefined;
      const text = String(v).trim();
      if (!isCalendarDate(text)) {
        ctx.addIssue({ code: "custom", message: `${label} must be a YYYY-MM-DD date` });
        return undefined;
      }
      const parsed = parseCalendarDate(text);
      if (!parsed) {
        ctx.addIssue({ code: "custom", message: `${label} is not a real date` });
        return undefined;
      }
      return parsed;
    });

/** Filter values the discovery screen understands for a crane's availability. */
export const AVAILABILITY_VALUES = [
  CraneStatus.AVAILABLE,
  CraneStatus.ENGAGED,
  CraneStatus.UNDER_MAINTENANCE,
  "ALL",
] as const;

export const discoveryQuerySchema = z
  .object({
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
    availability: z.enum(AVAILABILITY_VALUES).optional(),
    /**
     * The hire window the user needs a crane for, as two calendar days.
     *
     * This is not a range over a crane's `availableFrom` date: "available from
     * the 5th to the 12th" means the crane has to be free for that whole period.
     * The service therefore combines the crane's own release date with its
     * active reservations. Both ends are required together — one date alone has
     * no window to test against — and the pair is ordered.
     */
    availableFrom: optionalCalendarDate("Available from"),
    availableTo: optionalCalendarDate("Available to"),
    includeInactive: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .optional()
      .transform((v) => v === true || v === "true"),
    /**
     * An optional site pin; when both are present the list is distance-ranked.
     * A site address is for when the user knows the place but not the
     * coordinate: the service geocodes it through the configured provider.
     */
    siteLat: optionalNumber("Site latitude"),
    siteLng: optionalNumber("Site longitude"),
    siteLocation: optionalText(200),
    sitePincode: optionalText(10),
  })
  .refine((query) => Boolean(query.availableFrom) === Boolean(query.availableTo), {
    message: "Give both an available-from and an available-to date",
    path: ["availableTo"],
  })
  .refine(
    (query) =>
      !query.availableFrom ||
      !query.availableTo ||
      query.availableTo.getTime() >= query.availableFrom.getTime(),
    {
      message: "Available to must be on or after available from",
      path: ["availableTo"],
    },
  );


export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;
