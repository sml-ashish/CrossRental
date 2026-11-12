import { z } from "zod";
import { RateBasis } from "../generated/prisma/client";
import { parseDateInput } from "../lib/dates";

/** P6 validation-queue edits. Every parsed field is optional on the wire. */
const nullableMoney = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : value),
  z.coerce.number().min(0, "Must be zero or more").nullable(),
);

const nullableDate = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : value),
  z
    .union([z.string(), z.date()])
    .transform((value) => parseDateInput(value))
    .nullable(),
);

const nullableBoolean = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : value),
  z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).nullable(),
);

const nullableText = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : value),
  z.string().trim().max(2000).nullable(),
);

const nullableId = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : value),
  z.string().uuid().nullable(),
);

export const inboundReplyPatchSchema = z.object({
  vendorId: nullableId.optional(),
  rfqId: nullableId.optional(),
  enquiryLineId: nullableId.optional(),
  craneId: nullableId.optional(),

  parsedRentalRate: nullableMoney.optional(),
  parsedRateBasis: z.enum([
    RateBasis.PER_DAY,
    RateBasis.PER_MONTH,
    RateBasis.LUMP_SUM,
  ]).nullable().optional(),
  parsedMobilisation: nullableMoney.optional(),
  parsedDemobilisation: nullableMoney.optional(),
  parsedAvailability: nullableBoolean.optional(),
  parsedAvailableFrom: nullableDate.optional(),
  parsedValidityDate: nullableDate.optional(),
  parsedCraneRef: nullableText.optional(),
  parsedRemarks: nullableText.optional(),
  parsedAcceptsTerms: nullableBoolean.optional(),
});

export type InboundReplyPatch = z.infer<typeof inboundReplyPatchSchema>;

export const dismissReplySchema = z.object({
  note: z.string().trim().max(500).nullish(),
});

export const listRepliesQuerySchema = z.object({
  status: z.enum(["PENDING", "CONVERTED", "DISMISSED", "ALL"]).default("PENDING"),
});
