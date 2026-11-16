import type { AdminDashboardItemKind } from "@/lib/admin";

/**
 * The dashboard checks that open a Review drawer.
 *
 * A slug is the URL value (`?review=stale-cranes`) and the key of the drawer's
 * cached query. The wording here mirrors the dashboard rows, so a deep link
 * still reads as a sentence before the dashboard payload has arrived.
 */

export type ReviewKind =
  | "stale-cranes"
  | "no-location"
  | "lapsed-engagements"
  | "pending-fleet";

export interface ReviewDefinition {
  /** The server-side counter this drawer lists. */
  kind: AdminDashboardItemKind;
  explanation: string;
}

export const REVIEW_DEFINITIONS: Record<ReviewKind, ReviewDefinition> = {
  "stale-cranes": {
    kind: "stale",
    explanation:
      "Vendors have been reminded. Open a crane to check it, or ask the vendor to confirm it is still accurate.",
  },
  "no-location": {
    kind: "unverified",
    explanation:
      "These cranes have no pin on file, so they cannot appear in Find cranes. Add a location to each one.",
  },
  "lapsed-engagements": {
    kind: "lapsed",
    explanation:
      "The release date has passed but the crane is still engaged. Check the booking, or extend the engagement.",
  },
  "pending-fleet": {
    kind: "pending-fleet",
    explanation:
      "New fleet records wait for approval before they can be quoted. Open a crane to approve or reject it.",
  },
};

export const REVIEW_KINDS = Object.keys(REVIEW_DEFINITIONS) as ReviewKind[];

export function isReviewKind(value: unknown): value is ReviewKind {
  return typeof value === "string" && value in REVIEW_DEFINITIONS;
}

/**
 * The same sentence the row shows, rebuilt from the counts. Used only when the
 * drawer is opened from a URL and the merged alert/counter list is not loaded
 * yet; once it is, the row's own sentence wins.
 */
export function reviewTitle(kind: ReviewKind, count: number, staleFlagDays: number): string {
  if (kind === "stale-cranes") {
    return `${count} crane${count === 1 ? " hasn't" : "s haven't"} been updated in ${staleFlagDays}+ days`;
  }
  if (kind === "no-location") {
    return `${count} crane${count === 1 ? " has" : "s have"} no map location`;
  }
  if (kind === "lapsed-engagements") {
    return `${count} engaged crane${count === 1 ? " is" : "s are"} past ${
      count === 1 ? "its" : "their"
    } release date`;
  }
  return `${count} fleet record${count === 1 ? " is" : "s are"} waiting to be validated`;
}
