import { z } from "zod";
import { RateBasis } from "../generated/prisma/enums";
import { parseDateInput } from "../lib/dates";
import { optionalText, validityDateField } from "./quotationFields";

/**
 * Counter-quote bodies.
 *
 * An offer carries exactly the same structured terms as a quotation — never a
 * free-text price — so it can be priced by `calculateTotal` and turned into a
 * normal quotation version when accepted. The client never sends a total.
 *
 * `expectedVersion` is the thread's optimistic-concurrency token. Warnings are
 * data, not errors: the preview returns them and a submit carrying any of them
 * must set `acknowledgeWarnings`.
 */

const offerFields = {
  rentalRate: z.coerce
    .number({ message: "Enter the rental rate" })
    .positive("The rental rate must be greater than 0"),
  rateBasis: z.enum([RateBasis.PER_DAY, RateBasis.PER_MONTH, RateBasis.LUMP_SUM]),
  mobilisationCharges: z.coerce
    .number({ message: "Enter the mobilisation charges" })
    .min(0, "Mobilisation charges cannot be negative")
    .default(0),
  demobilisationCharges: z.coerce
    .number({ message: "Enter the demobilisation charges" })
    .min(0, "Demobilisation charges cannot be negative")
    .default(0),
  taxBasis: z.enum(["EXCLUSIVE_OF_GST", "INCLUSIVE_OF_GST"]).default("EXCLUSIVE_OF_GST"),
  validityDate: validityDateField,
  availableFrom: z
    .union([z.string(), z.date(), z.null()])
    .optional()
    .transform((v): Date | null => (v == null || v === "" ? null : (parseDateInput(v) ?? null))),
  availabilityConfirmed: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true"),
  deviationText: optionalText(2000),
  message: optionalText(2000),
};

const concurrency = {
  expectedVersion: z.coerce.number().int().min(0),
  acknowledgeWarnings: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true")
    .default(false),
};

/** Preview takes the offer without needing a version token. */
export const previewOfferSchema = z.object(offerFields);

export const smlCounterSchema = z.object({
  ...offerFields,
  ...concurrency,
  respondBy: z.coerce.date({ message: "Enter a response-by time" }),
});

export const vendorCounterSchema = z.object({
  ...offerFields,
  ...concurrency,
});

export const acceptOfferSchema = z.object({
  expectedVersion: z.coerce.number().int().min(0),
  /** The vendor's UI must take an explicit confirm click before accepting. */
  confirm: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true")
    .optional(),
});

export const rejectCounterSchema = z.object({
  expectedVersion: z.coerce.number().int().min(0),
  reason: z.string().trim().min(1, "Give a reason for rejecting this counter").max(1000),
});

export const declineOfferSchema = z.object({
  expectedVersion: z.coerce.number().int().min(0),
  reason: optionalText(1000),
});

export const logVendorOfferSchema = z.object({
  ...offerFields,
  ...concurrency,
  channel: z.enum(["PORTAL", "PHONE", "WHATSAPP", "EMAIL"]),
  note: z.string().trim().min(1, "Add a note about this offer").max(2000),
});

export type OfferInput = z.infer<typeof previewOfferSchema>;
export type SmlCounterInput = z.infer<typeof smlCounterSchema>;
export type VendorCounterInput = z.infer<typeof vendorCounterSchema>;
export type LogVendorOfferInput = z.infer<typeof logVendorOfferSchema>;
