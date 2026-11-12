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
  management_viewer: "Management Viewer",
};

/** Every non-vendor role. Management is internal but read-only. */
export const INTERNAL_ROLES: UserRole[] = [
  "admin_user",
  "sales_user",
  "management_viewer",
];

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
  // P3: marking a quotation Under Review / Shortlisted / Rejected in the
  // comparison screen. Held by both internal roles; the award is separate.
  | "quotation:review"
  | "fleet:view_all"
  | "fleet:edit_own"
  | "fleet:edit_all"
  // P1: the enquiry intake and sourcing workspace. The CR team is `sales_user`
  // (overview decision), so both internal roles hold these.
  | "enquiry:view"
  | "enquiry:create"
  | "enquiry:manage"
  // P5: reports on the caller's own scope (sales) and across the platform
  // (admin / management viewer). Writes never use these.
  | "reports:view"
  | "reports:view_all";

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
    "quotation:review",
    "fleet:view_all",
    // Brief D1: admin maintains any vendor's fleet on their behalf.
    "fleet:edit_all",
    // P1: admin can enter and work enquiries alongside the CR team.
    "enquiry:view",
    "enquiry:create",
    "enquiry:manage",
    // P5: admin reports cover the whole platform, including management's view.
    "reports:view",
    "reports:view_all",
  ],
  // Sales creates, sends and tracks RFQs, reads approved fleets, works
  // enquiries, and — since P3 — runs quote comparison and the award (the CR path
  // in BPD 6.15/6.16). Admin holds the same capabilities as an override; sales
  // still cannot see bank details.
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
    "quotation:award",
    "quotation:review",
    "fleet:view_all",
    // Brief D1/6.6: sales may add or edit a vendor's cranes on their behalf.
    "fleet:edit_all",
    // P1: sales *is* the CR team, so it enters and works every enquiry.
    "enquiry:view",
    "enquiry:create",
    "enquiry:manage",
    // P5: sales reports are limited to their own enquiries in the service.
    "reports:view",
  ],
  // P5: a management viewer is read-only by construction — it holds no
  // operational capability at all, only the aggregate reports.
  management_viewer: ["reports:view_all"],
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