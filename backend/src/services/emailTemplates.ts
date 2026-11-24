/**
 * Default transactional email bodies. These are seeded into the
 * `email_templates` table so they can be edited without a code deploy
 * (brief section 8); the database copy wins once it exists.
 *
 * Placeholders use {{name}} and are substituted at send time. Unknown
 * placeholders are left as-is rather than blanked, so a typo in a customised
 * template is visible instead of silently swallowing content.
 *
 * Bodies are plain text. No cards, buttons, coloured headers or footers —
 * the recipient gets the message and the link, nothing else. The stored column
 * is still called `bodyHtml` for compatibility with the existing table; it now
 * holds text only.
 */

export interface EmailTemplateSeed {
  key: string;
  subject: string;
  bodyHtml: string;
}

const plain = (...lines: string[]): string => lines.join("\n").trim();

const link = (label: string, url: string): string[] => ["", `${label}:`, url];

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplateSeed[] = [
  {
    key: "vendor_invitation",
    subject: "SML Crane Portal — vendor registration",
    bodyHtml: plain(
      "Vendor registration",
      "",
      "Dear Sir,",
      "",
      "Greetings from Sanghvi Movers Ltd.",
      "",
      "We are registering vendors for our crane sourcing platform. Please complete the",
      "online registration form and upload the documents listed below. This replaces the",
      "scanned paper form.",
      "",
      "Documents required:",
      "- Cancelled cheque copy",
      "- GST certificate",
      "- PAN card copy",
      "",
      "Your response will be appreciated to proceed further.",
      ...link("Start registration", "{{onboardingUrl}}"),
    ),
  },
  {
    key: "onboarding_submitted",
    subject: "New vendor registration submitted — {{vendorName}}",
    bodyHtml: plain(
      "New vendor registration",
      "",
      "{{vendorName}} has submitted a vendor registration.",
      "",
      "Email: {{vendorEmail}}",
      "PAN: {{pan}}",
      "GSTIN: {{gstn}}",
      "Registered address: {{registeredAddress}}",
      ...link("Review registration", "{{reviewUrl}}"),
    ),
  },
  {
    key: "onboarding_approved",
    subject: "Your SML vendor registration is approved",
    bodyHtml: plain(
      "Registration approved",
      "",
      "Dear {{vendorName}},",
      "",
      "Your vendor registration has been approved. Please set a password to activate your",
      "portal account. The link below can be used once and expires in",
      "{{activationTtlHours}} hours.",
      "",
      "Vendor code: {{sapVendorCode}}",
      ...link("Activate your account", "{{activationUrl}}"),
    ),
  },
  {
    key: "onboarding_rejected",
    subject: "SML vendor registration — not approved",
    bodyHtml: plain(
      "Registration not approved",
      "",
      "Dear {{vendorName}},",
      "",
      "We are unable to approve your registration at this time. The remarks are below.",
      "",
      "{{adminRemarks}}",
      "",
      "Please correct the details and submit again using the registration link in the",
      "original invitation email. That link is still active — no new email is needed.",
      "",
      "If you no longer have that email, reply to the SML user who invited you and they",
      "can send a fresh invitation.",
      // Deliberately no call-to-action. The vendor has no account yet, so a link
      // to the sign-in page would dead-end them. The raw invitation token is
      // only stored as a hash and cannot be rebuilt here.
    ),
  },
  {
    key: "password_reset",
    subject: "Reset your SML Crane Portal password",
    bodyHtml: plain(
      "Reset your password",
      "",
      "Hello,",
      "",
      "Use the link below to choose a new password. It can be used once and expires in",
      "{{resetTtlHours}} hour.",
      "",
      "If you did not request this, you can ignore this email — your password is unchanged.",
      ...link("Set a new password", "{{resetUrl}}"),
    ),
  },
  {
    key: "login_otp",
    subject: "Your SML Crane Portal sign-in code",
    bodyHtml: plain(
      "Your sign-in code",
      "",
      "Hello{{fullName}},",
      "",
      "{{otpCode}}",
      "",
      "This code expires in {{otpTtlMinutes}} minutes and can be used once.",
      "",
      "If you did not try to sign in, tell your administrator.",
    ),
  },
  {
    key: "fleet_update_reminder",
    subject: "Please confirm your crane details are up to date",
    bodyHtml: plain(
      "Confirm your fleet data",
      "",
      "Dear {{vendorName}},",
      "",
      "We have not received a status or location update for the crane below since",
      "{{lastUpdatedAt}}. SML ranks cranes by location and availability, so stale data",
      "affects which enquiries reach you.",
      "",
      "{{craneLabel}}",
      "Last confirmed: {{lastUpdatedAt}}",
      "",
      "If nothing has changed, use Confirm current status — it takes one tap.",
      ...link("Update crane", "{{craneUrl}}"),
    ),
  },
  {
    key: "fleet_updated_on_behalf",
    subject: "Your crane details were updated on your behalf",
    bodyHtml: plain(
      "Fleet updated on your behalf",
      "",
      "Dear {{vendorName}},",
      "",
      "An SML user updated your crane details for you. The change is recorded against",
      "your crane and is shown in the portal.",
      "",
      `{{craneLabel}}\nUpdated by {{actorName}}`,
      "",
      'If anything looks wrong, open the crane in the portal and edit it — that clears the "updated on your behalf" mark.',
      ...link("View crane", "{{craneUrl}}"),
    ),
  },
  {
    key: "rfq_invitation",
    subject: "[{{rfqNumber}}] Crane enquiry — please quote",
    bodyHtml: plain(
      "Crane enquiry",
      "",
      "Dear Sir,",
      "",
      "Greetings from Sanghvi Movers Ltd. We are interested in hiring a crane from your",
      "fleet. Please find the enquiry details below and share your best commercial quote",
      "through the portal.",
      "",
      `RFQ number: {{rfqNumber}}
Site: {{siteLocation}}, {{siteState}}
Crane requirement: {{craneType}}, {{capacityRule}}, quantity {{quantity}}
Application: {{applicationDescription}}
Main boom required: {{mainBoomText}}
Jib length required: {{jibText}}
Configuration: {{configuration}}
Tentative deployment: {{requiredStartDate}}
Hiring duration: {{durationText}}
OT charges: {{otCharges}}
Breakdown charges: {{breakdownTerms}}
Diesel scope: {{dieselScope}}
Working hours / shift: {{workingHoursShift}}
Crane age criteria: {{craneAgeCriteria}}
Support crane: {{supportCrane}}
Steel mats & ground prep: {{steelMatsGroundPrep}}
EHS / HR: {{ehsHrRequirements}}
Insurance: {{insuranceTerms}}
Quote due by: {{submissionDeadline}}`,
      "",
      "Please submit your quotation through the portal along with the load chart for the",
      "crane, as we need to verify its suitability.",
      "",
      "In case of any queries, kindly connect with:",
      "{{smlContactName}} — {{smlContactMobile}}",
      "{{smlContactEmail}}",
      "",
      "If this crane is not available with you, you can still respond by declining and",
      "mention:",
      "",
      "1. Your available fleet details with make, model, capacity, YOM, type and current location.",
      "2. Contacts of other agencies or persons who have this equipment in their fleet.",
      ...link("View enquiry and quote", "{{rfqUrl}}"),
    ),
  },
  {
    key: "rfq_reminder",
    subject: "[{{rfqNumber}}] Reminder — quote due by {{submissionDeadline}}",
    bodyHtml: plain(
      "Reminder: quotation due",
      "",
      "Dear Sir,",
      "",
      "This is a reminder that our quotation for {{rfqNumber}} is still pending. The",
      "deadline is {{submissionDeadline}}.",
      "",
      "Site: {{siteLocation}}, {{siteState}}",
      ...link("Submit quotation", "{{rfqUrl}}"),
    ),
  },
  {
    key: "quotation_receipt",
    subject: "[{{rfqNumber}}] Quotation received — {{action}}",
    bodyHtml: plain(
      "Quotation {{action}}",
      "",
      "Dear {{vendorName}},",
      "",
      "Your quotation for {{rfqNumber}} has been {{action}} and received by SML. This is",
      "your receipt.",
      "",
      `Crane: {{craneLabel}}
Version: {{version}}
Rate: INR {{rentalRate}} per {{rateBasis}}
Mobilisation: INR {{mobilisationCharges}}
Demobilisation: INR {{demobilisationCharges}}
Tax basis: {{taxBasis}}
Total quoted value: INR {{totalQuotedValue}}
Validity: {{validityDate}}`,
      "",
      "{{calculationNote}}",
      "",
      "You may revise or withdraw this quotation until the deadline. All versions are kept.",
      ...link("View quotation", "{{rfqUrl}}"),
    ),
  },
  {
    key: "quotation_received",
    subject: "[{{rfqNumber}}] Quotation received from {{vendorName}}",
    bodyHtml: plain(
      "Quotation received",
      "",
      "{{vendorName}} has submitted a quotation for {{rfqNumber}}.",
      "",
      `Crane: {{craneLabel}}
Total quoted value: INR {{totalQuotedValue}}
Distance to site: {{distanceText}}
Version: {{version}}`,
      "",
      "{{warningsBlock}}",
      ...link("View RFQ", "{{rfqUrl}}"),
    ),
  },
  {
    key: "quotation_awarded",
    subject: "[{{rfqNumber}}] Your quotation has been awarded",
    bodyHtml: plain(
      "Quotation awarded",
      "",
      "Dear {{vendorName}},",
      "",
      "Your quotation for {{rfqNumber}} has been selected. The crane below is now marked",
      "as booked in the portal.",
      "",
      `{{craneLabel}}
Reserved for: {{periodText}}
Total quoted value: INR {{totalQuotedValue}}`,
      "",
      "{{reasonBlock}}",
      "",
      "Our team will contact you regarding mobilisation. Commercial terms remain as quoted.",
      ...link("View quotation", "{{rfqUrl}}"),
    ),
  },
  {
    key: "quotation_not_awarded",
    subject: "[{{rfqNumber}}] Update on your quotation",
    bodyHtml: plain(
      "Quotation not awarded",
      "",
      "Dear {{vendorName}},",
      "",
      "Thank you for quoting for {{rfqNumber}}. We have not been able to proceed with this",
      "quotation on the present occasion.",
      "",
      "{{reasonBlock}}",
      "",
      "We value your continued association and will include your fleet in future enquiries.",
      ...link("View quotation", "{{rfqUrl}}"),
    ),
  },
  {
    key: "rfq_deadline_changed",
    subject: "[{{rfqNumber}}] Deadline {{changeKind}}",
    bodyHtml: plain(
      "Deadline {{changeKind}}",
      "",
      "Dear Sir,",
      "",
      "The submission deadline for {{rfqNumber}} has been {{changeKind}}.",
      "",
      "New deadline: {{submissionDeadline}}",
      "",
      "{{reasonBlock}}",
      ...link("View enquiry", "{{rfqUrl}}"),
    ),
  },
  {
    key: "reservation_released",
    subject: "Your crane {{craneLabel}} has been released",
    bodyHtml: plain(
      "Reservation released",
      "",
      "Dear {{vendorName}},",
      "",
      "The reservation on the crane below has been released, so it is available again.",
      "",
      `Crane: {{craneLabel}}
Period: {{periodText}}
Released by: {{releasedBy}}`,
      "",
      "{{reasonBlock}}",
      "",
      "You can update this crane's status in the portal from your fleet list.",
    ),
  },
  {
    key: "internal_user_created",
    subject: "Your SML Crane Portal account",
    bodyHtml: plain(
      "Your portal account is ready",
      "",
      "Hello{{fullName}},",
      "",
      "An SML Crane Portal account has been created for you with the role {{roleLabel}}.",
      "",
      "Sign in with this email address and the one-time code we send you — there is no",
      "password to remember.",
      ...link("Sign in", "{{loginUrl}}"),
    ),
  },
  {
    key: "internal_alert_digest",
    subject: "SML Crane Portal — {{alertCount}} item{{alertCount}} need attention",
    bodyHtml: plain(
      "Alerts needing attention",
      "",
      "Hello,",
      "",
      "{{alertCount}} item{{alertCount}} on the portal need attention today.",
      "",
      "{{alertItems}}",
      ...link("Open the portal", "{{portalUrl}}"),
    ),
  },
];

// Counter-quote / negotiation (phase 1 + 2)
const NEGOTIATION_EMAIL_TEMPLATES: EmailTemplateSeed[] = [
  {
    key: "negotiation_counter_received",
    subject: "[{{rfqNumber}}] Counter-offer received — round {{roundNumber}}",
    bodyHtml: plain(
      "SML sent a counter-offer",
      "",
      "Dear {{vendorName}},",
      "",
      "SML has sent a counter-offer for {{rfqNumber}} ({{craneLabel}}), round",
      "{{roundNumber}} of {{maxRounds}}.",
      "",
      `Total quoted value: INR {{totalQuotedValue}}
Reply by: {{respondBy}}`,
      "",
      "Sign in to the portal to accept, counter or decline. Please reply before the time above.",
      ...link("View offer", "{{rfqUrl}}"),
    ),
  },
  {
    key: "negotiation_vendor_countered",
    subject: "[{{rfqNumber}}] {{vendorName}} countered — round {{roundNumber}}",
    bodyHtml: plain(
      "Vendor countered your offer",
      "",
      "Hello,",
      "",
      "{{vendorName}} has sent a counter for {{rfqNumber}} ({{craneLabel}}), round",
      "{{roundNumber}} of {{maxRounds}}.",
      "",
      `Total quoted value: INR {{totalQuotedValue}}
Reply by: {{respondBy}}`,
      "",
      "Open the RFQ to accept, counter or reject before the reply time.",
      ...link("View offer", "{{rfqUrl}}"),
    ),
  },
  {
    key: "negotiation_accepted",
    subject: "[{{rfqNumber}}] Offer agreed — awaiting award",
    bodyHtml: plain(
      "Offer agreed",
      "",
      "Hello,",
      "",
      "An offer for {{rfqNumber}} has been agreed with {{vendorName}} at INR",
      "{{totalQuotedValue}}.",
      "",
      "{{nextStep}}",
      "",
      "Open the RFQ to review and confirm the award.",
      ...link("View offer", "{{rfqUrl}}"),
    ),
  },
  {
    key: "negotiation_declined",
    subject: "[{{rfqNumber}}] Negotiation closed",
    bodyHtml: plain(
      "Negotiation closed",
      "",
      "Hello,",
      "",
      "The negotiation for {{rfqNumber}} with {{vendorName}} has been closed.",
      "{{actor}} ended the thread.",
      "",
      "Reason: {{reason}}",
      "",
      "The vendor's standing quotation is still available and can be awarded.",
      ...link("View enquiry", "{{rfqUrl}}"),
    ),
  },
  {
    key: "negotiation_reminder",
    subject: "[{{rfqNumber}}] Offer awaiting your reply",
    bodyHtml: plain(
      "Counter-offer awaiting your reply",
      "",
      "Hello,",
      "",
      "A counter-offer for {{rfqNumber}} is still awaiting your reply.",
      "",
      `Total quoted value: INR {{totalQuotedValue}}
Reply by: {{respondBy}}`,
      "",
      "If it is not answered before the time above, the offer expires.",
      ...link("View offer", "{{rfqUrl}}"),
    ),
  },
];

DEFAULT_EMAIL_TEMPLATES.push(...NEGOTIATION_EMAIL_TEMPLATES);

export const EMAIL_TEMPLATE_KEYS = DEFAULT_EMAIL_TEMPLATES.map((t) => t.key);
