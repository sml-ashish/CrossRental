/**
 * The email template preview.
 *
 * `backend/src/services/emailTemplates.ts` documents the substitution rule: a
 * `{{name}}` token is replaced at send time, and a token the sending code does
 * not know is left in the email exactly as typed so a typo stays visible. The
 * preview follows the same rule — known names get a clearly fictional sample
 * value, unknown ones stay visible and are outlined so a template author can see
 * them without sending anything.
 *
 * Only ever rendered inside a `sandbox=""` iframe. A template is markup an admin
 * types; it must never be parsed into the application's own DOM.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Names the portal fills with trusted markup rather than escaped text. */
const RAW_SAMPLES: Record<string, string> = {
  alertItems:
    "<li>2 RFQs are past their response SLA.</li><li>1 quotation expires this week.</li><li>1 booking starts next week without confirmed availability.</li>",
  warningsBlock:
    '<div style="margin:0 0 16px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:12px;color:#78350f"><strong>Advisories (not blocking)</strong><br/>The offered crane is older than the customer asked for.</div>',
  reasonBlock:
    '<div style="margin:0 0 16px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#334155"><strong>Reason</strong><br/>Competitive price and an earlier mobilisation date.</div>',
};

/**
 * Fabricated sample values, one for every placeholder the default templates use.
 * They are deliberately obvious demos, not the values of a real vendor.
 */
const SAMPLES: Record<string, string> = {
  vendorName: "Sharma Cranes (sample)",
  vendorEmail: "quotes@sharmacranes.example",
  pan: "AAACS0000K",
  gstn: "27AAACS0000K1Z5",
  registeredAddress: "Plot 14, MIDC, Pune 411019",
  onboardingUrl: "https://portal.example/onboarding/sample-token",
  reviewUrl: "https://portal.example/app/approvals",
  activationUrl: "https://portal.example/activate/sample-token",
  activationTtlHours: "48",
  sapVendorCode: "10004567",
  adminRemarks: "The PAN and GSTIN did not match the documents uploaded.",
  resetUrl: "https://portal.example/reset/sample-token",
  resetTtlHours: "1",
  loginUrl: "https://portal.example/auth/login",
  fullName: " Priya Nair",
  otpCode: "482913",
  otpTtlMinutes: "10",
  lastUpdatedAt: "2 October 2026",
  craneLabel: "Liebherr LTM 1100 · MH-12-AB-1234",
  craneUrl: "https://portal.example/app/fleet",
  rfqNumber: "RFQ-2026-0042",
  siteLocation: "JNPT, Nhava Sheva",
  siteState: "Maharashtra",
  craneType: "Truck mounted crane",
  capacityRule: "At least",
  capacityNote: "A 150 T lift at a 20 m radius.",
  quantity: "2",
  applicationDescription: "Unloading turbine components at the site.",
  loadDescription: "An 18 T generator skid.",
  mainBoomText: "60 m",
  jibText: "18 m",
  configuration: "Main boom with fixed jib",
  requiredStartDate: "24 November 2026",
  durationText: "2 months",
  otCharges: "As per SML terms",
  breakdownTerms: "Vendor scope",
  dieselScope: "Vendor scope",
  workingHoursShift: "8 hours, single shift",
  craneAgeCriteria: "Up to 10 years",
  accommodationConveyance: "Vendor scope",
  paymentTerms: "30 days from invoice",
  mobilisationTerms: "Lump sum, included in the quote",
  supportCrane: "Not required",
  steelMatsGroundPrep: "Vendor scope",
  ehsHrRequirements: "SML EHS rules apply",
  insuranceTerms: "Vendor scope",
  extensionClause: "By mutual agreement",
  submissionDeadline: "24 November 2026, 5:00 pm",
  smlContactName: "Cross Rental Desk",
  smlContactMobile: "+91 20 0000 0000",
  smlContactEmail: "crossrental@sanghvimovers.example",
  rfqUrl: "https://portal.example/app/rfqs/sample-id",
  action: "submitted",
  version: "v2",
  rentalRate: "8,000.00",
  rateBasis: "day",
  mobilisationCharges: "25,000.00",
  demobilisationCharges: "25,000.00",
  taxBasis: "Exclusive of GST",
  totalQuotedValue: "5,30,000.00",
  validityDate: "30 November 2026",
  calculationNote:
    "₹8,000.00 per day × 60 days = ₹4,80,000.00, plus mobilisation ₹25,000.00 and demobilisation ₹25,000.00 = ₹5,30,000.00.",
  distanceText: "312 km by road",
  periodText: "24 November 2026 – 23 January 2027",
  changeKind: "extended",
  releasedBy: "Cross Rental Sales",
  roleLabel: "Sales",
  alertCount: "4",
  portalUrl: "https://portal.example",
};

/** Unique placeholder names, in the order they first appear. */
export function placeholdersIn(...texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PLACEHOLDER)) {
      const name = match[1];
      if (name) seen.add(name);
    }
  }
  return [...seen];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tokenMarkup(raw: string): string {
  return `<span style="display:inline-block;border:1px dashed #d97706;border-radius:4px;padding:0 3px;font-size:12px;line-height:1.5;color:#92400e;background:#fffbeb;font-family:ui-monospace,monospace">${escapeHtml(raw)}</span>`;
}

/**
 * The body with sample values substituted, ready for `srcDoc`.
 *
 * Unknown placeholders stay visible and outlined: that is the typo staying
 * visible, which is the backend's stated behaviour for a send.
 */
export function buildPreviewHtml(bodyHtml: string): string {
  return bodyHtml.replace(PLACEHOLDER, (token, name: string) => {
    const raw = RAW_SAMPLES[name];
    if (raw !== undefined) return raw;
    const sample = SAMPLES[name];
    if (sample !== undefined) return escapeHtml(sample);
    return tokenMarkup(token);
  });
}

/** The placeholder names the preview has a sample for, for the chip list. */
export function hasSample(name: string): boolean {
  return name in SAMPLES || name in RAW_SAMPLES;
}

/** A small readable label for a template key: "rfq_invitation" → "RFQ sent to vendor". */
const FRIENDLY_NAMES: Record<string, string> = {
  vendor_invitation: "Vendor invitation",
  onboarding_submitted: "Registration submitted (to SML)",
  onboarding_approved: "Registration approved",
  onboarding_rejected: "Registration not approved",
  password_reset: "Password reset",
  login_otp: "Sign-in code",
  fleet_update_reminder: "Fleet update reminder",
  rfq_invitation: "RFQ sent to vendor",
  rfq_reminder: "RFQ reminder",
  quotation_receipt: "Quotation receipt (to vendor)",
  quotation_received: "Quotation received (to SML)",
  quotation_awarded: "Quotation awarded",
  quotation_not_awarded: "Quotation not awarded",
  rfq_deadline_changed: "RFQ deadline changed",
  reservation_released: "Reservation released",
  internal_user_created: "Staff account created",
  internal_alert_digest: "Daily alert digest",
};

export function friendlyTemplateName(key: string): string {
  const known = FRIENDLY_NAMES[key];
  if (known) return known;
  const words = key.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
