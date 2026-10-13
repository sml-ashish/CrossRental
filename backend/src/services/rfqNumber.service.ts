import { prisma } from "../lib/database";

/**
 * Human-readable RFQ numbers: RFQ-2026-0001 (brief 5.4).
 *
 * The number appears in the email subject (`[RFQ-2026-0001]`, brief section 8)
 * and is what a vendor quotes against on the phone, so it has to be unique and
 * has to look like a reference rather than a UUID.
 *
 * Allocation is a single atomic upsert rather than a read-then-write. Two sales
 * users creating an RFQ at the same moment is not an edge case — it is Tuesday —
 * and a plain "find the row, increment, save" would hand both of them the same
 * number, and the unique constraint on `rfqNumber` would then fail one of them
 * with a 500 instead of producing the next number.
 *
 * `RETURNING` inside `ON CONFLICT DO UPDATE` is what makes this safe: Postgres
 * evaluates the increment and hands back the winning value under the row lock,
 * so no caller can read a stale `last`.
 */

/** Year is part of the number, so the counter restarts each calendar year. */
function currentYear(): number {
  return new Date().getFullYear();
}

/** `2026` -> `RFQ-2026-`. */
function prefix(year: number): string {
  return `RFQ-${year}-`;
}

function format(year: number, ordinal: number): string {
  return `${prefix(year)}${String(ordinal).padStart(4, "0")}`;
}

/**
 * Reserve the next number for `year`, creating the counter row on first use.
 *
 * Returns the reserved number even if the RFQ row itself is never written. That
 * is deliberate: a gap in the sequence is a cosmetic annoyance, whereas reusing
 * a number is a quotation that arrives against the wrong enquiry.
 */
export async function nextRfqNumber(
  year: number = currentYear(),
): Promise<string> {
  const rows = await prisma.$queryRaw<{ last: number }[]>`
    INSERT INTO "rfq_sequences" ("year", "last")
    VALUES (${year}, 1)
    ON CONFLICT ("year")
    DO UPDATE SET "last" = "rfq_sequences"."last" + 1
    RETURNING "last"
  `;

  const ordinal = rows[0]?.last;
  if (typeof ordinal !== "number") {
    throw new Error(
      "Could not allocate an RFQ number: the sequence returned nothing",
    );
  }
  return format(year, ordinal);
}

/**
 * Peek at the next number without consuming it.
 *
 * Only used to show the sales user what the RFQ will be called before they save
 * a draft. Because it does not reserve, two people previewing at once see the
 * same number and the second one to save gets a different one — which is why no
 * caller treats this value as final.
 */
export async function previewRfqNumber(
  year: number = currentYear(),
): Promise<string> {
  const row = await prisma.rfqSequence.findUnique({
    where: { year },
    select: { last: true },
  });
  return format(year, (row?.last ?? 0) + 1);
}
