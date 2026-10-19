import { z } from "zod";
import { OwnershipType, ReservationStatus, ReservationType } from "../generated/prisma/client";

/**
 * Reservation field rules (brief 5.3 / 6.1, phase B).
 *
 * A reservation is the dated commitment a crane carries. The checks here are the
 * friendly layer in front of the database: `reservations` has an exclusion
 * constraint refusing overlapping ACTIVE reservations on one crane, and the
 * overrun is reported as a sentence naming the clash rather than the driver's
 * constraint error.
 *
 * Dates are calendar slices. Writers normalise to UTC midnight so the range in
 * the constraint compares whole days, never part of one.
 */

const dateField = z.coerce.date({ message: "Enter a valid date" });

/** Trim a value to UTC midnight so every writer stores the same shape. */
export function toUtcMidnight(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

const dateOnly = dateField.transform(toUtcMidnight);

export const createBlockedReservationSchema = z
  .object({
    craneId: z.string().trim().min(1, "Choose a crane"),
    startDate: dateOnly,
    endDate: dateOnly,
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.endDate.getTime() >= v.startDate.getTime(), {
    message: "The end date cannot be before the start date",
    path: ["endDate"],
  });

export type CreateBlockedReservationInput = z.infer<
  typeof createBlockedReservationSchema
>;

export const releaseReservationSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Give a reason for the release")
    .max(500, "Keep the reason under 500 characters"),
});

export type ReleaseReservationInput = z.infer<typeof releaseReservationSchema>;

export const listReservationsQuerySchema = z.object({
  status: z.nativeEnum(ReservationStatus).optional(),
  type: z.nativeEnum(ReservationType).optional(),
  craneId: z.string().trim().min(1).optional(),
  vendorId: z.string().trim().min(1).optional(),
  activeOnly: z.coerce.boolean().optional(),
});

export type ListReservationsQuery = z.infer<typeof listReservationsQuerySchema>;

/**
 * The booking calendar's range and filters (BPD 5.12 / 6.17, P2 section 3).
 *
 * The range is bounded: a calendar that could ask for five years would return
 * every crane against thousands of days and read as a hang. 92 days covers the
 * longest quarter anyone plans in.
 */
export const MAX_CALENDAR_DAYS = 92;

export const calendarQuerySchema = z
  .object({
    from: dateOnly,
    to: dateOnly,
    ownershipType: z.nativeEnum(OwnershipType).optional(),
    craneType: z.string().trim().min(1).optional(),
    vendorId: z.string().trim().min(1).optional(),
    region: z.string().trim().min(1).optional(),
    location: z.string().trim().min(1).optional(),
    /** P4: narrow the calendar to one crane (its detail screen). */
    craneId: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.to.getTime() >= v.from.getTime(), {
    message: "The end of the range cannot be before its start",
    path: ["to"],
  })
  .refine(
    (v) => (v.to.getTime() - v.from.getTime()) / 86_400_000 < MAX_CALENDAR_DAYS,
    { message: `Choose a range of at most ${MAX_CALENDAR_DAYS} days`, path: ["to"] },
  );

export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
