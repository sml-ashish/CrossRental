import { prisma } from "../lib/database";

/**
 * Human-readable enquiry numbers: CR-2026-0001 (P1 section 1).
 *
 * Same reasoning as `rfqNumber.service.ts`: allocation is a single atomic
 * upsert with `RETURNING` so two CR users creating an enquiry at the same
 * instant cannot read a stale counter and collide on the unique index. A gap
 * in the sequence is cosmetic; a reused number is an enquiry someone quotes
 * against the wrong job.
 */

function currentYear(): number {
  return new Date().getFullYear();
}

function format(year: number, ordinal: number): string {
  return `CR-${year}-${String(ordinal).padStart(4, "0")}`;
}

export async function nextEnquiryNumber(
  year: number = currentYear(),
): Promise<string> {
  const rows = await prisma.$queryRaw<{ last: number }[]>`
    INSERT INTO "enquiry_sequences" ("year", "last")
    VALUES (${year}, 1)
    ON CONFLICT ("year")
    DO UPDATE SET "last" = "enquiry_sequences"."last" + 1
    RETURNING "last"
  `;

  const ordinal = rows[0]?.last;
  if (typeof ordinal !== "number") {
    throw new Error(
      "Could not allocate an enquiry number: the sequence returned nothing",
    );
  }
  return format(year, ordinal);
}
