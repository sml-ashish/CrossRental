import { describe, expect, it } from "vitest";
import {
  isCalendarDate,
  parseCalendarDate,
  parseDateInput,
  startOfUtcDay,
  toCalendarDateString,
  todayUtcMidnight,
} from "../lib/dates";

/**
 * Calendar-date anchoring.
 *
 * Every assertion here is written against a literal ISO instant rather than a
 * computed day difference, because the bug these tests exist for only appears
 * when the server is *not* at UTC. A test that compares two locally-derived dates
 * passes at UTC whether or not the code is right — which is exactly why the
 * original defect survived a suite that ran green. Pinning the literal makes
 * these fail on any timezone.
 */
describe("calendar dates", () => {
  it("reads a date-only string as that day, not the day before or after", () => {
    expect(parseCalendarDate("2026-10-05")?.toISOString()).toBe(
      "2026-10-05T00:00:00.000Z",
    );
    // The two ends of the range, where an off-by-one is most visible.
    expect(parseCalendarDate("2026-01-01")?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(parseCalendarDate("2026-12-31")?.toISOString()).toBe(
      "2026-12-31T00:00:00.000Z",
    );
  });

  it("rejects a day that does not exist rather than rolling it over", () => {
    // Date.UTC(2026, 1, 31) is 3 March, which would store a day nobody asked for.
    expect(parseCalendarDate("2026-02-31")).toBeNull();
    expect(parseCalendarDate("2026-13-01")).toBeNull();
    expect(parseCalendarDate("2026-00-10")).toBeNull();
    expect(parseCalendarDate("2026-04-31")).toBeNull();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(parseCalendarDate("2028-02-29")?.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(parseCalendarDate("2026-02-29")).toBeNull();
  });

  it("refuses anything that is not exactly YYYY-MM-DD", () => {
    expect(isCalendarDate("2026-10-05")).toBe(true);
    expect(isCalendarDate("2026-10-05T00:00:00Z")).toBe(false);
    expect(isCalendarDate("05-10-2026")).toBe(false);
    expect(isCalendarDate("2026-10-5")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
    expect(parseCalendarDate("nonsense")).toBeNull();
  });

  it("truncates an instant to the UTC day it belongs to", () => {
    // 23:30 UTC is still the 5th, even though it is already the 6th in IST.
    expect(
      startOfUtcDay(new Date("2026-10-05T23:30:00.000Z")).toISOString(),
    ).toBe("2026-10-05T00:00:00.000Z");
    expect(
      startOfUtcDay(new Date("2026-10-05T00:30:00.000Z")).toISOString(),
    ).toBe("2026-10-05T00:00:00.000Z");
  });

  it("keeps the calendar day of a date-only string through the round trip", () => {
    // The defect: truncating this in a zone behind UTC produced the 4th.
    for (const day of ["2026-10-05", "2026-03-01", "2026-01-31"]) {
      const parsed = parseCalendarDate(day)!;
      expect(toCalendarDateString(parsed)).toBe(day);
      expect(toCalendarDateString(startOfUtcDay(parsed))).toBe(day);
    }
  });

  it("keeps a full timestamp as the instant it names", () => {
    // A deadline is a moment, not a day, so it must not be truncated to midnight.
    const parsed = parseDateInput("2026-10-05T18:30:00.000Z");
    expect(parsed?.toISOString()).toBe("2026-10-05T18:30:00.000Z");
    expect(startOfUtcDay(parsed!).toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("treats a date-only string and the same instant identically", () => {
    expect(parseDateInput("2026-10-05")?.toISOString()).toBe(
      parseCalendarDate("2026-10-05")?.toISOString(),
    );
    expect(parseDateInput(new Date("2026-10-05T00:00:00.000Z"))?.toISOString()).toBe(
      "2026-10-05T00:00:00.000Z",
    );
  });

  it("returns null rather than an Invalid Date for unusable input", () => {
    // `new Date("nonsense")` is an Invalid Date, which reaches Prisma as a column
    // write and fails far from the cause.
    expect(parseDateInput("nonsense")).toBeNull();
    expect(parseDateInput(new Date(NaN))).toBeNull();
    expect(parseDateInput("")).toBeNull();
  });

  it("starts today at UTC midnight", () => {
    const now = new Date("2026-10-05T13:45:00.000Z");
    expect(todayUtcMidnight(now).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    // One minute before and after midnight either side.
    expect(todayUtcMidnight(new Date("2026-10-05T00:00:00.000Z")).toISOString()).toBe(
      "2026-10-05T00:00:00.000Z",
    );
    expect(todayUtcMidnight(new Date("2026-10-04T23:59:59.999Z")).toISOString()).toBe(
      "2026-10-04T00:00:00.000Z",
    );
  });

  it("formats a calendar date as itself", () => {
    expect(toCalendarDateString(parseCalendarDate("2026-10-05"))).toBe("2026-10-05");
    expect(toCalendarDateString(null)).toBe("");
    expect(toCalendarDateString(undefined)).toBe("");
    expect(toCalendarDateString(new Date(NaN))).toBe("");
  });
});