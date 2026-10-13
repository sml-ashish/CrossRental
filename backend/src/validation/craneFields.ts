import { z } from "zod";
import { INDIA_BOUNDS } from "../lib/geo";
import { startOfUtcDay, todayUtcMidnight, parseDateInput } from "../lib/dates";
import { CraneStatus } from "../generated/prisma/client";

/**
 * Crane field rules from brief 5.2, plus the status rules of brief 6.1.
 *
 * These are the friendly layer. The database carries CHECK constraints for the
 * same invariants (capacity > 0, YOM not in the future, coordinates inside
 * India) because a validation bug should not become corrupt data, but a vendor
 * typing "0" needs a sentence, not a constraint violation.
 */

export const CRANE_STATUS_VALUES = [
  CraneStatus.AVAILABLE,
  CraneStatus.ENGAGED,
  CraneStatus.UNDER_MAINTENANCE,
  CraneStatus.BOOKED,
  CraneStatus.HIRED,
] as const;

/**
 * The three a vendor may choose (brief 6.1). BOOKED and HIRED exist in the enum
 * because the award flow sets them, but they are never offered here and never
 * accepted from a vendor payload.
 */
export const VENDOR_SELECTABLE_STATUSES = [
  CraneStatus.AVAILABLE,
  CraneStatus.ENGAGED,
  CraneStatus.UNDER_MAINTENANCE,
] as const;

export const SYSTEM_ONLY_STATUSES: CraneStatus[] = [
  CraneStatus.BOOKED,
  CraneStatus.HIRED,
];

const trimmed = (max: number) => z.string().trim().max(max);

/**
 * A serial or registration number (brief 5.2): mandatory, and placeholders such
 * as "NA" or a very short string are rejected. Vendors routinely type "NA" or
 * "N/A" meaning "not yet assigned", which would let every one of those cranes
 * collide on the same value under the duplicate rule.
 */
export const serialRegistrationField = z
  .string()
  .trim()
  .min(4, "Enter the serial or registration number (at least 4 characters)")
  .max(64)
  .refine(
    (v) => !/^(n\/?a|none|not\s*available|tbd|-+|\?+)$/i.test(v),
    "Enter the actual serial or registration number — “NA” is not accepted",
  );

export const capacityField = z.coerce
  .number({ message: "Enter the capacity in tonnes" })
  .positive("Capacity must be greater than 0");

export const yomField = z.coerce
  .number({ message: "Enter the year of manufacture" })
  .int("Enter a four-digit year")
  .min(1950, "That year is too early for a crane")
  .max(
    new Date().getFullYear(),
    "The year of manufacture cannot be in the future",
  );

/**
 * An optional boom or jib length. Brief 5.2 allows "number or NA".
 *
 * Blank and "NA" both mean this crane has no such configuration, which is a
 * different statement from zero — a zero-length jib is not a real jib. Both
 * become null; anything else must be a positive number.
 */
const optionalLengthField = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v): number | null => {
    if (v === undefined || v === null) return null;
    if (typeof v === "number") return v;
    const text = v.trim();
    if (text === "" || /^(n\/?a|not applicable)$/i.test(text)) return null;
    return Number(text);
  })
  .refine((v) => v === null || (Number.isFinite(v) && v > 0), {
    message: "Enter a length greater than 0, or leave it blank",
  });

/** Optional pincode. Blank becomes null so it is stored as "not given". */
export const pincodeField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v): string | null => {
    if (v === undefined || v === null) return null;
    const text = v.trim();
    return text === "" ? null : text;
  })
  .refine((v) => v === null || /^\d{6}$/.test(v), {
    message: "Enter a six-digit pincode",
  });

/**
 * A pin the vendor dropped or confirmed (brief 6.3). Validated against India's
 * bounding box here so the message is actionable; the database CHECK is the
 * backstop.
 */
/**
 * An optional pin correction.
 *
 * Exported as its own shape because it is accepted by two entry points: the full
 * create/edit schema, and the quick status-and-location action — a crane that
 * moves sites is exactly when the old pin becomes wrong.
 */
const optionalManualPoint = {
  latitude: z.coerce
    .number()
    .min(INDIA_BOUNDS.minLat, "Latitude is outside India")
    .max(INDIA_BOUNDS.maxLat, "Latitude is outside India")
    .optional()
    .nullable(),
  longitude: z.coerce
    .number()
    .min(INDIA_BOUNDS.minLng, "Longitude is outside India")
    .max(INDIA_BOUNDS.maxLng, "Longitude is outside India")
    .optional()
    .nullable(),
};

export const manualPointSchema = z.object({
  latitude: z.coerce
    .number()
    .min(INDIA_BOUNDS.minLat, "Latitude is outside India")
    .max(INDIA_BOUNDS.maxLat, "Latitude is outside India"),
  longitude: z.coerce
    .number()
    .min(INDIA_BOUNDS.minLng, "Longitude is outside India")
    .max(INDIA_BOUNDS.maxLng, "Longitude is outside India"),
});

/**
 * Half a pin is not a pin.
 *
 * "Provided" has to mean *not undefined and not null*, not merely "not null".
 * The first version of this check compared against null alone, so a payload
 * carrying only `latitude` compared null-vs-undefined, saw no difference, and
 * sailed through — leaving `manualPoint()` in the service to catch it with a
 * generic 400 and the form to show no field-level message at all.
 *
 * `manualPoint()` remains the backstop; this is the layer that names the field.
 */
function findUnpairedPin(
  value: { latitude?: number | null; longitude?: number | null },
  ctx: z.RefinementCtx,
): void {
  const hasLat = value.latitude !== undefined && value.latitude !== null;
  const hasLng = value.longitude !== undefined && value.longitude !== null;
  if (hasLat === hasLng) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [hasLat ? "longitude" : "latitude"],
    message: "Give both latitude and longitude, or neither",
  });
}

const baseCraneFields = {
  typeOfCraneCode: trimmed(50).min(1, "Choose the crane type"),
  capacityT: capacityField,
  currentLocation: trimmed(300).min(3, "Enter the current location"),
  stateCode: trimmed(10).min(1, "Choose the state"),
  make: trimmed(80).min(2, "Enter the make"),
  model: trimmed(80).min(1, "Enter the model"),
  yom: yomField,
  mainBoomM: z.coerce
    .number({ message: "Enter the main boom length in metres" })
    .positive("Main boom length must be greater than 0"),
  fixedJibM: optionalLengthField,
  luffingJibM: optionalLengthField,
  windJibM: optionalLengthField,
  serialRegistrationNo: serialRegistrationField,
  pincode: pincodeField,
  remarks: trimmed(1000).nullish(),
};

/**
 * Creating a crane.
 *
 * `currentStatus` is optional and defaults to AVAILABLE, because "add a crane"
 * most often means adding one that is ready to work. Engaged is only reachable
 * by asking for it, and `availableFrom` is then required — see the refinement.
 */
export const createCraneSchema = z
  .object({
    ...baseCraneFields,
    currentStatus: z
      .enum(VENDOR_SELECTABLE_STATUSES)
      .default(CraneStatus.AVAILABLE),
    availableFrom: z
      .union([z.string(), z.date()])
      .optional()
      .nullable()
      .transform((v) => {
        if (v === undefined || v === null || v === "") return null;
        // An impossible day such as 31 February is kept as an Invalid Date rather
        // than rolled over into March, so the rule below reports "Enter a valid
        // date" instead of quietly storing a day the vendor never asked for.
        return parseDateInput(v) ?? new Date(NaN);
      }),
    /** Set by the vendor confirming or dragging a pin instead of geocoding. */
    latitude: z.coerce.number().optional().nullable(),
    longitude: z.coerce.number().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    findUnpairedPin(value, ctx);
    if (value.currentStatus === CraneStatus.ENGAGED) {
      if (!value.availableFrom) {
        ctx.addIssue({
          code: "custom",
          path: ["availableFrom"],
          message: "Give the date this crane becomes available",
        });
        return;
      }
      const from = new Date(value.availableFrom);
      if (Number.isNaN(from.getTime())) {
        ctx.addIssue({
          code: "custom",
          path: ["availableFrom"],
          message: "Enter a valid date",
        });
      } else if (startOfUtcDay(from) < todayUtcMidnight()) {
        ctx.addIssue({
          code: "custom",
          path: ["availableFrom"],
          message: "available_from must be today or later",
        });
      }
    }
  });

export type CreateCraneInput = z.infer<typeof createCraneSchema>;

/**
 * Editing a crane. Same fields, but the status is optional so a form that only
 * changes the location does not have to resend it, and `availableFrom` may be
 * explicitly cleared.
 */
export const updateCraneSchema = z
  .object({
    ...baseCraneFields,
    currentStatus: z.enum(VENDOR_SELECTABLE_STATUSES).optional(),
    availableFrom: z
      .union([z.string(), z.date()])
      .optional()
      .nullable()
      .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === "") return null;
        // An impossible day such as 31 February is kept as an Invalid Date rather
        // than rolled over into March, so the rule below reports "Enter a valid
        // date" instead of quietly storing a day the vendor never asked for.
        return parseDateInput(v) ?? new Date(NaN);
      }),
    latitude: z.coerce.number().optional().nullable(),
    longitude: z.coerce.number().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    findUnpairedPin(value, ctx);
    if (
      value.currentStatus === CraneStatus.ENGAGED &&
      value.availableFrom !== undefined
    ) {
      if (value.availableFrom === null) {
        ctx.addIssue({
          code: "custom",
          path: ["availableFrom"],
          message: "Give the date this crane becomes available",
        });
      } else if (Number.isNaN(value.availableFrom.getTime())) {
        // This branch used to skip an unparseable date silently, which let an
        // Invalid Date reach the column write and fail there instead.
        ctx.addIssue({
          code: "custom",
          path: ["availableFrom"],
          message: "Enter a valid date",
        });
      } else if (startOfUtcDay(value.availableFrom) < todayUtcMidnight()) {
        // UTC-anchored on both sides — see lib/dates.ts.
        ctx.addIssue({
          code: "custom",
          path: ["availableFrom"],
          message: "available_from must be today or later",
        });
      }
    }
  });

export type UpdateCraneInput = z.infer<typeof updateCraneSchema>;

/**
 * The one-step quick action (brief 7.4): "Update status and location".
 *
 * Deliberately narrow. A vendor updating a crane mid-morning should not have to
 * re-enter the boom length, and accepting the whole form here would make an
 * accidental field loss easy.
 */
export const quickUpdateSchema = z
  .object({
    currentStatus: z.enum(VENDOR_SELECTABLE_STATUSES),
    currentLocation: trimmed(300).min(3, "Enter the current location"),
    stateCode: trimmed(10).min(1, "Choose the state"),
    pincode: pincodeField,
    ...optionalManualPoint,
    availableFrom: z
      .union([z.string(), z.date()])
      .optional()
      .nullable()
      .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === "") return null;
        // An impossible day such as 31 February is kept as an Invalid Date rather
        // than rolled over into March, so the rule below reports "Enter a valid
        // date" instead of quietly storing a day the vendor never asked for.
        return parseDateInput(v) ?? new Date(NaN);
      }),
  })
  .superRefine((value, ctx) => {
    findUnpairedPin(value, ctx);

    if (value.currentStatus !== CraneStatus.ENGAGED) return;
    if (value.availableFrom === undefined || value.availableFrom === null) {
      ctx.addIssue({
        code: "custom",
        path: ["availableFrom"],
        message: "Give the date this crane becomes available",
      });
      return;
    }
    const from = new Date(value.availableFrom);
    if (Number.isNaN(from.getTime())) {
      ctx.addIssue({
        code: "custom",
        path: ["availableFrom"],
        message: "Enter a valid date",
      });
    } else if (startOfUtcDay(from) < todayUtcMidnight()) {
      ctx.addIssue({
        code: "custom",
        path: ["availableFrom"],
        message: "available_from must be today or later",
      });
    }
  });

export type QuickUpdateInput = z.infer<typeof quickUpdateSchema>;

export const listCranesQuerySchema = z.object({
  status: z.enum(CRANE_STATUS_VALUES).optional(),
  typeOfCraneCode: trimmed(50).optional(),
  stateCode: trimmed(10).optional(),
  search: trimmed(120).optional(),
  /** Inactive cranes are hidden unless asked for (brief 7.4 soft delete). */
  includeInactive: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
});

export type ListCranesQuery = z.infer<typeof listCranesQuerySchema>;
