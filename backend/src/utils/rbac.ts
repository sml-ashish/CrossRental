import { UserRole } from "../generated/prisma/client";

/**
 * Role capabilities, kept as data rather than scattered `if (role === ...)`
 * checks so the admin UI can render the same truth the server enforces.
 *
 * Vendor users are additionally scoped to a single vendorId, which is checked
 * in middleware/auth.ts (`requireVendorScope`) rather than expressed here —
 * a capability is a role question, ownership is a row question.
 */
export const ROLE_LABELS: Record<UserRole, string> = {
  vendor_user: "Vendor",
  admin_user: "Administrator",
  sales_user: "Sales",
};

export const INTERNAL_ROLES: UserRole[] = ["admin_user", "sales_user"];

export type Capability =
  | "vendor:approve"
  | "vendor:view_bank"
  | "vendor:view_all"
  | "vendor:invite"
  | "rfq:create"
  | "rfq:dispatch"
  | "rfq:track"
  | "rfq:extend_deadline"
  | "rfq:cancel"
  | "rfq:remind"
  | "rfq:view_quotations"
  | "rfq:respond"
  | "quotation:award"
  | "fleet:view_all"
  | "fleet:edit_own";

const CAPABILITIES: Record<UserRole, Capability[]> = {
  // `rfq:respond` is deliberately absent from every internal role: a quotation is
  // a vendor's commercial offer, and nothing in SML should be able to file one in
  // a vendor's name. Internal users read quotations through `rfq:view_quotations`.
  vendor_user: ["fleet:edit_own", "rfq:respond"],
  // Admin sees everything, sees bank details, approves vendors, runs award.
  admin_user: [
    "vendor:approve",
    "vendor:view_bank",
    "vendor:view_all",
    "vendor:invite",
    "rfq:create",
    "rfq:dispatch",
    "rfq:track",
    "rfq:extend_deadline",
    "rfq:cancel",
    "rfq:remind",
    "rfq:view_quotations",
    "quotation:award",
    "fleet:view_all",
  ],
  // Sales creates, sends and tracks RFQs and reads approved fleets, but
  // cannot see bank details and cannot award.
  sales_user: [
    "vendor:view_all",
    "vendor:invite",
    "rfq:create",
    "rfq:dispatch",
    "rfq:track",
    "rfq:extend_deadline",
    "rfq:cancel",
    "rfq:remind",
    "rfq:view_quotations",
    "fleet:view_all",
  ],
};

export function can(role: UserRole, capability: Capability): boolean {
  return CAPABILITIES[role]?.includes(capability) ?? false;
}

export function capabilitiesOf(role: UserRole): Capability[] {
  return CAPABILITIES[role] ?? [];
}

/** Vendors must be Approved before they can be given an RFQ (brief 6.7). */
export function canReceiveRfq(onboardingStatus: string): boolean {
  return onboardingStatus === "APPROVED";
}