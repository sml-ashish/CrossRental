/**
 * Default transactional email bodies. These are seeded into the
 * `email_templates` table so they can be edited without a code deploy
 * (brief section 8); the database copy wins once it exists.
 *
 * Placeholders use {{name}} and are substituted at send time. Unknown
 * placeholders are left as-is rather than blanked, so a typo in a customised
 * template is visible instead of silently swallowing content.
 */

export interface EmailTemplateSeed {
  key: string;
  subject: string;
  bodyHtml: string;
}

const layout = (title: string, body: string, cta?: { label: string; url: string }) => `
<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(to bottom,#FA5A54,#F1221C,#D91B16);padding:20px 28px">
      <div style="color:#ffffff;font-size:15px;font-weight:700;letter-spacing:-0.02em">Sanghvi Movers Limited</div>
      <div style="color:#ffe1e0;font-size:12px;margin-top:2px">Crane Discovery &amp; Vendor Portal</div>
    </div>
    <div style="padding:28px">
      <h1 style="margin:0 0 16px;font-size:18px;color:#0f172a;letter-spacing:-0.02em">${title}</h1>
      ${body}
      ${
        cta
          ? `<div style="margin:24px 0">
               <a href="${cta.url}" style="display:inline-block;background:linear-gradient(to bottom,#FA5A54,#F1221C,#D91B16);color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 20px;border-radius:8px">${cta.label}</a>
             </div>
             <p style="margin:0;font-size:11px;color:#64748b;word-break:break-all">If the button does not work, copy this link into your browser:<br/>${cta.url}</p>`
          : ""
      }
    </div>
    <div style="border-top:1px solid #e2e8f0;padding:16px 28px;background:#f8fafc">
      <p style="margin:0;font-size:11px;color:#64748b">
        This message was sent by the SML Crane Portal. Please do not reply to this email —
        responses are not read; use the portal links above.
      </p>
    </div>
  </div>
</div>`.trim();

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplateSeed[] = [
  {
    key: "vendor_invitation",
    subject: "SML Crane Portal — vendor registration",
    bodyHtml: layout(
      "Vendor registration",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear Sir,</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">Greetings from Sanghvi Movers Ltd.</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         We are registering vendors for our crane sourcing platform. Please complete the
         online registration form and upload the documents listed below. This replaces the
         scanned paper form.
       </p>
       <ul style="margin:0 0 16px;padding-left:20px;font-size:13px;color:#334155;line-height:1.9">
         <li>Cancelled cheque copy</li>
         <li>GST certificate</li>
         <li>PAN card copy</li>
       </ul>
       <p style="margin:0;font-size:14px;color:#334155">Your response will be appreciated to proceed further.</p>`,
      { label: "Start registration", url: "{{onboardingUrl}}" },
    ),
  },
  {
    key: "onboarding_submitted",
    subject: "New vendor registration submitted — {{vendorName}}",
    bodyHtml: layout(
      "New vendor registration",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">{{vendorName}} has submitted a vendor registration.</p>
       <p style="margin:0 0 6px;font-size:13px;color:#475569">Email: {{vendorEmail}}</p>
       <p style="margin:0 0 6px;font-size:13px;color:#475569">PAN: {{pan}}</p>
       <p style="margin:0 0 6px;font-size:13px;color:#475569">GSTIN: {{gstn}}</p>
       <p style="margin:0;font-size:13px;color:#475569">Registered address: {{registeredAddress}}</p>`,
      { label: "Review registration", url: "{{reviewUrl}}" },
    ),
  },
  {
    key: "onboarding_approved",
    subject: "Your SML vendor registration is approved",
    bodyHtml: layout(
      "Registration approved",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear {{vendorName}},</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         Your vendor registration has been approved. Please set a password to activate your
         portal account. The link below can be used once and expires in
         {{activationTtlHours}} hours.
       </p>
       <p style="margin:0;font-size:13px;color:#64748b">
         Vendor code: {{sapVendorCode}}
       </p>`,
      { label: "Activate your account", url: "{{activationUrl}}" },
    ),
  },
  {
    key: "onboarding_rejected",
    subject: "SML vendor registration — not approved",
    bodyHtml: layout(
      "Registration not approved",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear {{vendorName}},</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         We are unable to approve your registration at this time. The remarks are below.
       </p>
       <div style="margin:0 0 16px;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#991b1b;white-space:pre-wrap">{{adminRemarks}}</div>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         Please correct the details and submit again using the registration link in the
         original invitation email. That link is still active — no new email is needed.
       </p>
       <p style="margin:0;font-size:13px;color:#64748b">
         If you no longer have that email, reply to the SML user who invited you and they
         can send a fresh invitation.
       </p>`,
      // Deliberately no call-to-action button. The vendor has no account yet, so a
      // link to the sign-in page would dead-end them. The raw invitation token is
      // only stored as a hash and cannot be rebuilt here, which is why the copy
      // points them at the original email instead of a deep link.
    ),
  },
  {
    key: "password_reset",
    subject: "Reset your SML Crane Portal password",
    bodyHtml: layout(
      "Reset your password",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Hello,</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         Use the link below to choose a new password. It can be used once and expires in
         {{resetTtlHours}} hour.
       </p>
       <p style="margin:0;font-size:13px;color:#64748b">
         If you did not request this, you can ignore this email — your password is unchanged.
       </p>`,
      { label: "Set a new password", url: "{{resetUrl}}" },
    ),
  },
  {
    key: "login_otp",
    subject: "Your SML Crane Portal sign-in code",
    bodyHtml: layout(
      "Your sign-in code",
      `<p style="margin:0 0 16px;font-size:14px;color:#334155">Hello{{fullName}},</p>
       <div style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:0.18em;color:#0f172a;font-family:'Consolas',monospace">${"{{otpCode}}"}</div>
       <p style="margin:0 0 6px;font-size:13px;color:#475569">This code expires in {{otpTtlMinutes}} minutes and can be used once.</p>
       <p style="margin:0;font-size:13px;color:#64748b">If you did not try to sign in, tell your administrator.</p>`,
    ),
  },
  {
    key: "fleet_update_reminder",
    subject: "Please confirm your crane details are up to date",
    bodyHtml: layout(
      "Confirm your fleet data",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear {{vendorName}},</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         We have not received a status or location update for the crane below since
         {{lastUpdatedAt}}. SML ranks cranes by location and availability, so stale data
         affects which enquiries reach you.
       </p>
       <div style="margin:0 0 16px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#334155">
         {{craneLabel}}<br/>
         <span style="color:#64748b">Last confirmed: {{lastUpdatedAt}}</span>
       </div>
       <p style="margin:0;font-size:13px;color:#64748b">
         If nothing has changed, use <strong>Confirm still accurate</strong> — it takes one tap.
       </p>`,
      { label: "Update crane", url: "{{craneUrl}}" },
    ),
  },
  {
    key: "rfq_invitation",
    subject: "[{{rfqNumber}}] Crane enquiry — please quote",
    bodyHtml: layout(
      "Crane enquiry",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear Sir,</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         Greetings from Sanghvi Movers Ltd. We are interested in hiring a crane from your
         fleet. Please find the enquiry details below and share your best commercial quote
         through the portal.
       </p>
       <table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155;margin:0 0 16px">
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b;width:45%">RFQ number</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;font-weight:600">{{rfqNumber}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Site location</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{siteLocation}}, {{siteState}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Crane requirement</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{craneType}}, {{capacityT}} T, quantity {{quantity}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Configuration</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{configuration}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Tentative deployment</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{requiredStartDate}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Hiring duration</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{durationText}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">OT charges</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{otCharges}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Breakdown charges</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{breakdownTerms}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Diesel scope</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{dieselScope}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Working hours / shift</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{workingHoursShift}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Crane age criteria</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{craneAgeCriteria}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Accommodation &amp; conveyance</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{accommodationConveyance}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Payment terms</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{paymentTerms}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Quote due by</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;font-weight:600;color:#b8130f">{{submissionDeadline}}</td></tr>
       </table>
       <p style="margin:0 0 12px;font-size:13px;color:#334155">
         Please submit your quotation through the portal along with the
         <strong>load chart</strong> for the crane, as we need to verify its suitability.
       </p>
       <p style="margin:0 0 4px;font-size:13px;color:#334155">
         In case of any queries, kindly connect with:<br/>
         {{smlContactName}} — {{smlContactMobile}}<br/>
         {{smlContactEmail}}
       </p>
       <p style="margin:16px 0 0;font-size:13px;color:#334155">
         If this crane is not available with you, you can still respond by declining and
         mention:
       </p>
       <ol style="margin:6px 0 0;padding-left:20px;font-size:13px;color:#334155;line-height:1.8">
         <li>Your available fleet details with make, model, capacity, YOM, type and current location.</li>
         <li>Contacts of other agencies or persons who have this equipment in their fleet.</li>
       </ol>`,
      { label: "View enquiry and quote", url: "{{rfqUrl}}" },
    ),
  },
  {
    key: "rfq_reminder",
    subject: "[{{rfqNumber}}] Reminder — quote due by {{submissionDeadline}}",
    bodyHtml: layout(
      "Reminder: quotation due",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear Sir,</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         This is a reminder that our quotation for <strong>{{rfqNumber}}</strong> is still
         pending. The deadline is <strong>{{submissionDeadline}}</strong>.
       </p>
       <p style="margin:0;font-size:13px;color:#64748b">Site: {{siteLocation}}, {{siteState}}</p>`,
      { label: "Submit quotation", url: "{{rfqUrl}}" },
    ),
  },
  {
    key: "quotation_receipt",
    subject: "[{{rfqNumber}}] Quotation received — {{action}}",
    bodyHtml: layout(
      "Quotation {{action}}",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear {{vendorName}},</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         Your quotation for <strong>{{rfqNumber}}</strong> has been {{action}} and received by
         SML. This is your receipt.
       </p>
       <table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155;margin:0 0 16px">
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Crane</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{craneLabel}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Version</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{version}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Rate</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">INR {{rentalRate}} per {{rateBasis}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Mobilisation</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">INR {{mobilisationCharges}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Total quoted value</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;font-weight:700">INR {{totalQuotedValue}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Validity</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{validityDate}}</td></tr>
       </table>
       <p style="margin:0;font-size:13px;color:#64748b">{{calculationNote}}</p>
       <p style="margin:12px 0 0;font-size:12px;color:#64748b">
         You may revise or withdraw this quotation until the deadline. All versions are kept.
       </p>`,
      { label: "View quotation", url: "{{rfqUrl}}" },
    ),
  },
  {
    key: "quotation_received",
    subject: "[{{rfqNumber}}] Quotation received from {{vendorName}}",
    bodyHtml: layout(
      "Quotation received",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">{{vendorName}} has submitted a quotation for <strong>{{rfqNumber}}</strong>.</p>
       <table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155;margin:0 0 16px">
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Crane</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{craneLabel}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Total quoted value</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;font-weight:700">INR {{totalQuotedValue}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Distance to site</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{distanceText}}</td></tr>
         <tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Version</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0">{{version}}</td></tr>
       </table>
       {{warningsBlock}}`,
      { label: "View RFQ", url: "{{rfqUrl}}" },
    ),
  },
  {
    key: "quotation_awarded",
    subject: "[{{rfqNumber}}] Your quotation has been awarded",
    bodyHtml: layout(
      "Quotation awarded",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear {{vendorName}},</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         Your quotation for <strong>{{rfqNumber}}</strong> has been selected. The crane below
         is now marked as booked in the portal.
       </p>
       <div style="margin:0 0 16px;padding:12px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:13px;color:#166534">
         {{craneLabel}}<br/>
         <span style="color:#475569">Total quoted value: INR {{totalQuotedValue}}</span>
       </div>
       {{reasonBlock}}
       <p style="margin:0;font-size:13px;color:#64748b">
         Our team will contact you regarding mobilisation. Commercial terms remain as quoted.
       </p>`,
      { label: "View quotation", url: "{{rfqUrl}}" },
    ),
  },
  {
    key: "quotation_not_awarded",
    subject: "[{{rfqNumber}}] Update on your quotation",
    bodyHtml: layout(
      "Quotation not awarded",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear {{vendorName}},</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         Thank you for quoting for <strong>{{rfqNumber}}</strong>. We have not been able to
         proceed with this quotation on the present occasion.
       </p>
       {{reasonBlock}}
       <p style="margin:0;font-size:13px;color:#64748b">
         We value your continued association and will include your fleet in future enquiries.
       </p>`,
      { label: "View quotation", url: "{{rfqUrl}}" },
    ),
  },
  {
    key: "rfq_deadline_changed",
    subject: "[{{rfqNumber}}] Deadline {{changeKind}}",
    bodyHtml: layout(
      "Deadline {{changeKind}}",
      `<p style="margin:0 0 12px;font-size:14px;color:#334155">Dear Sir,</p>
       <p style="margin:0 0 12px;font-size:14px;color:#334155">
         The submission deadline for <strong>{{rfqNumber}}</strong> has been
         {{changeKind}}.
       </p>
       <p style="margin:0 0 6px;font-size:14px;color:#334155">
         <strong>New deadline:</strong> {{submissionDeadline}}
       </p>
       {{reasonBlock}}`,
      { label: "View enquiry", url: "{{rfqUrl}}" },
    ),
  },
];

export const EMAIL_TEMPLATE_KEYS = DEFAULT_EMAIL_TEMPLATES.map((t) => t.key);