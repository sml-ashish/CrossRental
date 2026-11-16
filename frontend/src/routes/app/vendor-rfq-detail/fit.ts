import type { Crane } from "@/lib/fleet";
import type { VendorRfqDetail } from "@/lib/quotations";

/**
 * "Can I do this job?" — a paper check of the vendor's own fleet against the
 * RFQ's requirement.
 *
 * This is a hint for the picker, never a decision: the server's preview warns
 * and still lets a vendor quote (brief 6.7), and the capacity rule and boom
 * comparison are re-checked there. Keeping the comparison pure means the count
 * above the picker and the label on each option can never disagree.
 */

type Rfq = VendorRfqDetail["rfq"];

export type FitVerdict = "match" | "capacity" | "type";

export interface FleetFit {
  matches: number;
  total: number;
  verdicts: Map<string, FitVerdict>;
}

export function craneFit(crane: Crane, rfq: Rfq): FitVerdict {
  if (crane.typeOfCraneCode !== rfq.craneType) return "type";

  const capacityMatches =
    rfq.capacityRule === "EXACT"
      ? Math.abs(crane.capacityT - rfq.capacityT) < 0.001
      : crane.capacityT >= rfq.capacityT;
  if (!capacityMatches) return "capacity";

  // A boom requirement the crane cannot demonstrate is a check, not a match —
  // the vendor may still know the machine's real configuration.
  if (rfq.mainBoomM !== null) {
    if (crane.mainBoomM === null || crane.mainBoomM < rfq.mainBoomM) return "capacity";
  }

  return "match";
}

export function fleetFit(cranes: Crane[], rfq: Rfq): FleetFit {
  const verdicts = new Map<string, FitVerdict>();
  for (const crane of cranes) verdicts.set(crane.id, craneFit(crane, rfq));

  return {
    matches: [...verdicts.values()].filter((verdict) => verdict === "match").length,
    total: cranes.length,
    verdicts,
  };
}

export function fitLabel(verdict: FitVerdict): string {
  switch (verdict) {
    case "match":
      return "Matches";
    case "capacity":
      return "Check capacity";
    case "type":
      return "Different type";
  }
}
