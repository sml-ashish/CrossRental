# Vendor Portal: Implementation Brief

Brief for the agent building the **vendor portal** of SML's *Crane Discovery & Vendor Repository Platform*.
Source: the Business Process Document (BPD), sections 5.11, 6.1, 6.18, 6.19, 6.20 and 7.3, plus the vendor registration form, equipment list format, vendor registration mail, enquiry mail and the Cross Rental Enquiry Template.

**Revision note:** this version reflects these owner decisions: SAP integration is parked, "sales user" means the Cross Rental (CR) team, Sales Partners get no access, and dated reservations replace the undated "Booked" crane status.

---

## 1. Context

SML (Sanghvi Movers Ltd) sources cranes from external vendors when its own fleet is unavailable (cross-rental sourcing). Today this is manual: phone, WhatsApp, personal contact lists, spreadsheets.

The wider platform lets the CR team enter an enquiry, rank SML and vendor cranes by distance to the job site, send RFQs, and capture quotes. **The vendor portal is the vendor-facing part.** It is how vendors register, keep their fleet data accurate, respond to RFQs, and submit quotations.

**Why data quality matters:** the recommendation engine ranks cranes by location and availability. Stale or wrong vendor data gives wrong recommendations, so the fleet update flow must be fast and hard to get wrong.

## 2. Scope of this brief

**In scope (build now):**

1. Data model (vendor, contacts, documents, crane, reservation, audit)
2. Login: email + password for vendors, OTP for internal users (admin and sales), account activation, password reset
3. Vendor invitation, onboarding form with document uploads, and admin approval, including a "SAP vendor creation sheet" for the admin
4. Fleet management (single-crane add, edit, status and location update), including updates made by SML users on a vendor's behalf
5. Geocoding of crane locations and RFQ job sites (coordinates)
6. Vendor dashboard
7. **RFQ inbox, quotation submission and quotation history** (vendor side)
8. **Minimal RFQ creation, dispatch and tracking by sales users**, so the vendor-side RFQ flow has real data (the full sales workflow is not in scope)
9. **Distance to destination:** road distance from each crane's location to an RFQ's job site
10. **Fleet location views:** crane locations by state, per vendor, as a state-wise table and a map (internal users), plus a map of their own fleet for vendors
11. **Dated reservations** for vendor cranes, created when a quotation is awarded
12. Transactional emails through Microsoft 365

**Out of scope (do not build, but do not block):**

- Sales-side quotation comparison and final selection screens (the portal only shows the outcome; see 6.7 for the minimal award action)
- SAP integration of any kind (parked; the platform brief keeps an adapter point)
- SML internal fleet, the full recommendation engine and mobilisation cost estimate (distances are stored so it can be added later), heat maps, analytics
- Automatic parsing of vendor email replies into quotations
- WhatsApp in any form
- Bulk Excel upload of fleets (deferred)
- Approval workflow for fleet updates (OFF; build as a switchable setting, see 6.4)
- Vendor performance analysis (explicitly out of scope in the BPD)
- MFA for vendors, SSO

## 3. Decisions already made

| Topic | Decision |
|---|---|
| Who is a "sales user" | The CR team. Sales Partners have no access. A Sales Partner's name may be stored as plain text on the enquiry (platform brief). |
| SAP | **Parked.** No integration. SAP vendor code is an optional text field. Admins create the SAP vendor by hand, using the SAP vendor creation sheet from the approval screen. |
| Fleet update approval | **Off.** Config flag `fleet_approval_required` (default `false`). |
| Vendor login | **Email + password.** Activation by email link, reset by email link. No MFA for now. |
| Communication channel | **Email only**, through **Microsoft 365** (Microsoft Graph or SMTP relay from a shared mailbox). |
| Bulk Excel upload | Not in the first release. |
| Vendor performance analysis | Out of scope. |
| Mandatory crane fields | From the equipment list format (5.2). |
| RFQ creation | **Sales users** create, send and track RFQs using a minimal screen (7.9). Admin users can view and track all RFQs. |
| Quote revisions | A vendor can revise or withdraw until the RFQ deadline. Each revision is a new version, the latest counts, all are kept. |
| Rate basis and total | Per Day, Per Month or Lump Sum. The system shows a calculated total (see 6.7) that includes mobilisation and demobilisation. 30 days = 1 month when units differ. |
| Vendor replies by email | Not parsed. Vendors respond through the portal link. |
| After the deadline | Submission is blocked. A sales user or admin can extend the deadline (see 6.7 for reopening rules). |
| Internal login | **OTP** for admin and sales: 6 digits, 10-minute expiry, single use, rate-limited, by email. |
| Tech stack and hosting | Provided by the owner. The agent must not choose them. |
| Microsoft 365 setup | The owner handles the Entra app registration and shared mailbox. Code against configuration values. |
| Vendor code | Internal `vendor_id` always. `sap_vendor_code` is typed in by an admin, unique when present, may stay blank. It never blocks any action. |
| Serial / registration number | Mandatory. Unique per vendor. Placeholders such as NA are rejected. |
| Crane booking | **Dated Reservation records**, not an indefinite "Booked" status. See 5.3 and 6.1. |
| Customer name and budget | **Never stored on the RFQ and never shown to vendors.** They live only on the internal Enquiry (platform brief). |
| Stale-data thresholds | **30 days:** "due for update" plus reminder email. **60 days:** flagged stale for admins. Hiding stale cranes from candidate lists is not built. |
| Updates on behalf of vendors | Admin and sales users may add or edit a vendor's cranes. Each such change carries an "updated by SML on behalf of vendor" audit mark. |

## 4. Open items (ask the owner before assuming)

**Owner decisions received (recorded, now settled):**

| # | Open item | Decision |
|---|---|---|
| 1 | Geocoding, distance and map provider | **Still on hold.** Interface + stub only, as built. |
| 2 | Which vendor registration form is current | **The SAP-aligned form.** Capture its fields (5.1); keep weekly off days and DGTD/SSI optional; drop HSN product range. |
| 4 | Legal sign-off on the declaration | **Checkbox + uploaded signed scan.** The vendor ticks the declaration and also uploads the signed-and-stamped declaration page; submission requires it. |
| 5 | Who may extend an RFQ deadline | **Any sales user or admin**, audited. |
| 6 | Per Day rates: calendar days or working days | **Admin-configurable setting**, default calendar (30 days = 1 month). Form must capture `working_days_per_month` so either basis can be applied. |
| 7 | Capacity capture | **Tonnes plus a free-text capacity note. Matching uses tonnes.** |
| 8 | Status spelling | **Use the BPD's spelling everywhere** ("Finalised"). |

**Still open (follow the stated working assumption until the owner answers):**

| # | Open item | Working assumption until answered |
|---|---|---|
| 1 | Geocoding, distance and map provider (**ON HOLD**) | Build the interface and a stub only. Shortlist: Ola Maps, Mappls, Google Maps Platform, Mapbox. Decide after an accuracy test on real locations. **Option for the owner:** make pincode mandatory for cranes and job sites and add a static pincode-to-coordinates table, which gives a labelled straight-line fallback without a paid provider. Not built unless the owner says so. |
| 3 | Master values for the office-use fields (vendor origin, vendor type, purchase org, payment term, withholding tax type, legal form) | **Admin-maintained master lists — mechanism is settled.** Build small admin-editable lists (seeded empty, no guessed values); the owner's lists from the SAP "Legal Form Logic" sheet get loaded into them without a code change when supplied. |

## 5. Data model

### 5.1 Vendor

| Field | Type | Rule |
|---|---|---|
| vendor_id | system | Primary key |
| sap_vendor_code | text | Optional, entered by admin, unique when present |
| name | text | Mandatory |
| nature_of_company | enum | Public Ltd, Private Ltd, Partnership, Proprietorship. Mandatory |
| address_line1, address_line2, city, district, state, pincode | text | Replace the single address. Line 1, city, district, state and 6-digit pincode mandatory |
| telephone, fax | text | Telephone mandatory, fax optional |
| email | text | Mandatory, one valid email only, primary login email |
| weekly_off_days | text | Optional |
| operating_regions | multi-select (states) | Mandatory |
| company_size | enum | Optional |
| pan | text | Mandatory. Format 5 letters, 4 digits, 1 letter. 4th letter must match company type (Public or Private Ltd = C, Partnership = F, Proprietorship = P). Unique across vendors |
| tan | text | Optional |
| gst_registered | boolean | Mandatory choice (Registered or Unregistered). Drives the three fields below |
| gst_registration_type | enum | Regular, Composite, SEZ, EOU. Required if registered |
| gstn | text | Required only if registered. 15 characters. Characters 3 to 12 must equal the PAN. Unique across vendors. Stored as null if unregistered |
| gstr1_filing_frequency | enum | Optional, only if registered |
| cin | text | Only for companies |
| govt_registration and reg_no | text | Optional |
| msme_registered | boolean | Mandatory choice |
| msme_category, msme_reg_no, msme_exemption_date | enum/text/date | Shown if MSME registered. Category and registration number required then; exemption date optional |
| bank_name, branch, account_holder_name, account_type, account_no, ifsc | text | Mandatory. IFSC: 4 letters, `0`, 6 alphanumerics |
| micr | text | Optional, 9 digits |
| iban, swift | text | Optional, for foreign banks only |
| tds_lower_deduction | boolean | Mandatory choice. If yes: certificate number, section, rate %, valid from and to, and a certificate upload are required |
| code_of_conduct_accepted | boolean | Mandatory (true) |
| declaration_name, declaration_designation, declaration_date | text/date | Mandatory |
| declaration_scan | document upload | The signed-and-stamped declaration page (open item 4, decided). Required to submit. |
| fleet_summary | text | Crane categories and approximate fleet size |
| onboarding_status | enum | Draft, Submitted, Approved, Rejected |
| approved_by, approved_at, admin_remarks | | Approval fields |
| **Office-use fields (admin only)** | | vendor_origin, vendor_type, purchase_org, payment_term, withholding_tax_type, legal_form (from master lists, open item 3). Plus: facilities adequate (Adequate / Not Adequate / Needs Improvement), manpower adequate (Adequate / Not Adequate), improvement requirement and period |
| communication_preferences | text/enum | Preferred channel (email only for now) and notes |
| total_fleet_size | calculated | Count of active cranes |
| audit | system | created_at, updated_at, updated_by |

### 5.2 Crane

**Entered by the vendor (from the equipment list format):**

| Field | Rule |
|---|---|
| type_of_crane | Mandatory dropdown |
| capacity_t | Mandatory, number > 0 |
| current_status | Mandatory dropdown: Available, Engaged, Under Maintenance |
| current_location | Mandatory |
| state | Mandatory dropdown |
| make, model | Mandatory |
| yom | Mandatory, 4-digit year, not in the future |
| main_boom_m | Mandatory, number > 0 |
| fixed_jib_m, luffing_jib_m, wind_jib_m | Optional, number or `NA`. Stored as numbers (null for NA) so they can be compared to RFQ requirements |

**Added fields:**

| Field | Filled by | Rule |
|---|---|---|
| crane_id | System | Auto-generated, unique |
| vendor_id | System | From the logged-in vendor, or chosen by an SML user acting on behalf |
| serial_registration_no | Vendor | Mandatory. Unique per vendor. Reject placeholders and very short strings |
| pincode | Vendor | Optional (see open item 1) |
| latitude, longitude | System, vendor can correct | Must fall inside India's bounding box (about lat 6 to 38, lng 68 to 98) |
| coordinate_source | System | `auto` or `manual` |
| geocoded_by, geocoded_at | System | Provider and timestamp of the last automatic geocode |
| available_from | Vendor | **Required when Engaged.** Today or later when set. Cleared when status becomes Available |
| expected_ready_date | Vendor | Optional, when status is Under Maintenance |
| load_chart | Vendor | PDF or image. Optional on the crane, required when submitting a quote |
| ownership_type | System | Always `Vendor` here |
| is_active | Vendor | Soft delete. Never hard-delete |
| remarks | Vendor | Optional |
| status_updated_at | System | Updated when status, location, available_from or expected_ready_date changes, or on "Confirm still accurate" |
| updated_on_behalf | System | True when the last change was made by an SML user for the vendor |
| audit | System | created_at, updated_at, updated_by |

### 5.3 Other entities

- **VendorContact:** vendor_id, name, mobile (10 digits, no leading zero), telephone, email (one valid email), is_primary, **receives_rfqs** (boolean, default true for the primary contact). RFQ emails go to all contacts with `receives_rfqs = true`, and fall back to the primary contact.
- **VendorDocument:** vendor_id, doc_type (`cancelled_cheque`, `gst_certificate`, `pan_copy`, `tds_certificate`, `msme_certificate`, `other`), file reference, uploaded_at
- **VendorInvitation:** email, token (stored hashed), created_by, expires_at (7 days), used_at, resend_count
- **User:** email (unique), password hash, role (`vendor_user`, `admin_user`, `sales_user`), vendor_id (null for internal), is_active, activation and reset token fields
- **Reservation:** reservation_id, crane_id, start_date, end_date, type (`Booked`, `Blocked`), source rfq_id and quotation_id (nullable), status (`Active`, `Released`, `Completed`), created_by, released_by, release_reason, timestamps. See 6.1.
- **AuditLog:** entity, entity_id, action, old/new values, actor, `on_behalf_of_vendor` flag, timestamp
- **EmailLog:** to, template, subject, status, error, linked entity, timestamp
- **DistanceCache:** origin_lat, origin_lng, dest_lat, dest_lng (rounded to 3 decimals), road_distance_km, provider, calculated_at

### 5.4 RFQ and quotation entities

**RFQ (header): one per enquiry line item per RFQ event** (BPD 7.2). Enquiries come from the internal Enquiry module in the platform brief (P1). Until then, store an editable snapshot on the RFQ. **The RFQ never holds the customer name, customer address or rental budget.**

| Field | Rule |
|---|---|
| rfq_id, rfq_number | System, unique, human-readable (e.g. RFQ-2026-0001) |
| enquiry_no, line_no | Text entered by the creator for now; later linked to the Enquiry line item |
| crane_type, capacity_t, quantity | Requirement |
| capacity_rule | `At least` (default) or `Exact`. Drives candidate matching and quote warnings |
| capacity_note | Optional free text, e.g. "700 TMC or higher" |
| application_description | What the crane will do (e.g. heavy lift, erection) |
| load_description | e.g. "565 MT @ 78 m boom, 12 m radius" |
| required_main_boom_m, required_fixed_jib_m, required_luffing_jib_m, required_wind_jib_m | Optional numbers. Used for a "boom too short" warning |
| configuration_notes | Free text for anything not structured |
| site_location, state, pincode | Job site (no customer name or address) |
| site_latitude, site_longitude, site_coordinate_source | Geocoded, sales user can correct the pin |
| required_start_date, start_date_tbc | Start date may be "to be confirmed". If TBC, candidate availability checks are skipped with a notice |
| duration_value, duration_unit | Days or months |
| working_days_per_month | Number, shown to vendors |
| mobilisation_terms, demobilisation_terms | Who bears them and what is expected |
| commercial terms | ot_charges, breakdown_terms, diesel_scope, working_hours_shift, crane_age_criteria_years, accommodation_conveyance, payment_terms, support_crane_scope, steel_mats_ground_prep_scope, ehs_hr_compliance, insurance_terms, extension_clause, notes. Template defaults, editable per RFQ |
| sml_contact | Name, mobile, email shown to vendors |
| attachments | Optional files |
| submission_deadline | Mandatory, future date-time |
| status | **Lifecycle only:** Draft, Sent, Closed, Cancelled |
| response_state | **Derived, read-only:** `No Quotes Yet`, `Quotes Received`. Used by the line-item status trail |
| created_by, created_at, sent_at | System |

**RFQVendorRecipient** (many per RFQ): rfq_id, vendor_id, email addresses used, email_delivery_status (Queued, Sent, Failed), first_viewed_at, response_status (Pending, Quoted, Declined, Expired), responded_at, decline_reason, reminder_count, last_reminder_at, candidate_snapshot.

**Quotation:** quotation_id, rfq_id, vendor_id, version, is_latest, crane_id, rental_rate, rate_basis (Per Day, Per Month, Lump Sum), **tax_basis (Exclusive or Inclusive of GST, default Exclusive)**, mobilisation_charges, **demobilisation_charges**, total_quoted_value (calculated), availability_confirmed, available_from, validity_date, accepts_commercial_terms and deviation_text, remarks, attachments (including load chart), warnings, submitted_at, source (`portal`), crane_location_snapshot (state, location, latitude, longitude, main boom, jibs at submission), distance_to_site_km, distance_method (`road` or `straight_line`), status.

Quotation status values: Submitted, Withdrawn, Under Review, Shortlisted, Rejected, Selected, Not Awarded. **Vendors only see:** Submitted, Withdrawn, Awarded (= Selected) and Not Awarded. The others and any reason codes are internal.

## 6. Business rules

### 6.1 Crane status and reservations

| Vendor-managed status | Meaning | Set by |
|---|---|---|
| Available | Free to deploy now | Vendor (or SML on behalf) |
| Engaged | Working elsewhere. `available_from` required | Vendor |
| Under Maintenance | Not deployable | Vendor |

- **There is no stored "Booked" or "Hired" status.** A crane is committed through **Reservation** records with start and end dates.
- Display badges are derived: **Booked** = an active reservation starting in the future, **Hired** = an active reservation covering today. Vendors see these as read-only badges and still keep their own status separately.
- **Effective availability for a date range** = vendor status allows it AND no active reservation overlaps the range. An Engaged crane is deployable if `available_from` is on or before the required start date. If `available_from` has lapsed (in the past), the crane is flagged "date lapsed, confirm" on the vendor dashboard and counts as due for update, and candidate lists show a badge.
- A reservation is created when a quotation is awarded (6.7) for the RFQ start and end dates. The database must prevent overlapping active reservations on one crane (enforce in a transaction, not only in the UI).
- Admins can release a reservation with a reason (audit entry, email to vendor). Reservation end date passing marks it Completed.
- Vendors cannot edit or delete a reservation.

### 6.2 Duplicate detection

Reject a new crane if the same vendor already has an active crane with the same `serial_registration_no`. Show a clear error that links to the existing crane. Also reject a vendor registration with a PAN or GSTN already on another vendor, with a message the admin can act on (no details about the other vendor are shown to the applicant).

### 6.3 Geocoding

- Trigger on create, and whenever location, state or pincode changes.
- On success store latitude, longitude, `coordinate_source = auto`, `geocoded_by`, `geocoded_at`.
- The vendor can confirm or drag the pin; then `coordinate_source = manual`, not overwritten unless the location text changes.
- On failure still save the crane, flag "location unverified" and prompt for a pin. Cranes without coordinates are not deployable for candidate lists.

### 6.4 Fleet approval toggle

`fleet_approval_required = false` means changes are live immediately. If `true` later, new and edited cranes go to a pending state until an admin approves. Build the flag and code path now. The review UI can wait.

### 6.5 Stale data

- **30 days** without an update: "due for update" on the vendor dashboard, plus a reminder email (repeat interval default 7 days, until updated).
- **60 days:** flagged stale for admins, with a warning in internal views.
- Not now: hiding stale cranes from candidate lists. Keep `status_updated_at` and thresholds in configuration.

Give vendors a one-tap **Confirm still accurate** action that refreshes `status_updated_at` without changing other data.

### 6.6 Access control

- A vendor user reads and writes **only their own vendor's data**. Enforce on the server on every query.
- Admin users see all vendors, approve onboarding, view bank details, and run the award action.
- Sales users (CR team) create, send and track RFQs, extend deadlines (open item 5), view approved vendors and cranes, and **add or edit cranes on behalf of a vendor**. They cannot see bank details.
- Changes made on behalf of a vendor are marked in the audit log and on the crane ("Updated by SML on behalf of vendor"), and the vendor is notified in the dashboard. They reset the stale-data clock.
- **Bank details** are encrypted at rest, masked in the UI (last 4 digits), shown in full to admins only, never written to logs.
- Rate-limit login and password reset. Validate file type and size on uploads (PDF, JPG, PNG; sensible max size).

### 6.7 RFQ and quotation rules

- **Anchoring:** an RFQ belongs to one enquiry line item. One RFQ header per line item per RFQ event, one recipient record per vendor (BPD 7.2).
- **Who can receive an RFQ:** only vendors with onboarding_status `Approved`, an active user, and not suspended.
- **Dispatch:** email every recipient contact with `receives_rfqs = true`, create the inbox entry, set RFQ status to Sent. Delivery failures set the recipient to Failed and appear on the admin dashboard.
- **Isolation:** a vendor sees only RFQs addressed to them. Never expose other vendors' identities, rates or quotations, the end customer's name or address, or the rental budget.
- **First view:** opening an RFQ sets `first_viewed_at`.
- **Decline:** optional reason and note (for example other cranes or contacts the vendor can offer). Recipient becomes Declined.
- **Quotation validations (blocks):**
  - Deadline has not passed (unless extended).
  - `crane_id` belongs to the vendor, is active, is not Under Maintenance, and **has no active reservation overlapping the RFQ dates** (skipped if the start date is TBC, with a notice).
  - Rate greater than 0, mobilisation and demobilisation 0 or more, validity date today or later.
  - Availability explicitly confirmed.
  - A load chart exists on the crane or is attached.
- **Warnings (not blocks), stored in `warnings`:** crane type differs; capacity fails the RFQ's `capacity_rule`; crane YOM breaks the age criteria; crane is Engaged with `available_from` after the start date; crane main boom or jib is shorter than the required length; crane has an unverified location.
- **No registered crane:** if the vendor has no eligible crane, the quote form lets them add one inline (the mandatory fields from 5.2 only), then continues.
- **Total:** rental charge for the RFQ duration + mobilisation + demobilisation. For Per Day or Per Month, multiply the rate by the duration (30 days = 1 month if units differ; show the working, open item 6). For Lump Sum, the rate is the rental charge. The vendor sees the total and the tax basis before submitting.
- **Quantity above 1:** a vendor may submit separate quotations for different cranes on the same RFQ. Each is versioned independently.
- **Versions:** revise or withdraw until the deadline. Each revision is a new version, the latest counts, all stay in history. After the deadline quotations are locked.
- **Expiry and reopening:** after the deadline, recipients still Pending become Expired. If the deadline is later extended, Expired recipients who never responded return to Pending, get an "RFQ deadline extended" email, and may quote. Recipients who declined stay Declined.
- **Reminders:** automatic reminder to Pending recipients at the **smaller of the configured lead time (default 24 hours) and half the response window**. If the whole window is shorter than a configured minimum (default 4 hours), send none. Plus a manual "send reminder". Increment `reminder_count`.
- **Status:** RFQ.status is lifecycle only (Draft, Sent, Closed, Cancelled). `response_state` is derived and read-only. RFQ becomes Closed when awarded cranes equal the RFQ quantity, or when an internal user closes it with a reason.
- **Award (minimal):** build `award_quotation(quotation_id, reason_code)` and an admin-only action that calls it. In one transaction it:
  1. Locks the quotation and crane, and rejects the call if the quotation is not the latest Submitted version of a non-withdrawn quote, or if the RFQ is already fully awarded.
  2. Rechecks that the crane has no overlapping active reservation and is not Under Maintenance. If it fails, nothing changes and the user sees why.
  3. Sets the quotation to Selected (Awarded to the vendor).
  4. Creates a **Reservation** (Booked) for the RFQ start and end dates. If the start date is TBC the action requires dates to be entered.
  5. Counts awarded quotations against RFQ quantity. **Only when the count reaches the quantity** are all remaining latest Submitted quotations set to Not Awarded and the RFQ set to Closed. Withdrawn quotations and older versions are skipped and unchanged. If the quantity is not yet met, other quotes stay open.
  6. For the same crane quoted on other RFQs with overlapping dates, adds an internal warning "crane now reserved" on those quotations and blocks awarding them.
  7. Writes audit entries and sends the Award email, and Not Awarded emails when step 5 applies.

  The full comparison and selection screens later call this same function.

### 6.8 Mapping provider and coordinate storage

- All geocoding, distance and map calls go through an interface: `geocode(location, state, pincode) -> lat, lng` and `road_distance(origin, destination) -> km`.
- Record `geocoded_by` and `geocoded_at` with every coordinate.
- If the chosen provider's terms limit caching, add a scheduled job that re-geocodes before the limit.
- API keys and quotas live in configuration. Rate-limit outbound calls and cache results.
- **On hold:** build the interface and a stub returning fixed test coordinates and distances. Until a real provider is chosen, cranes stay "location unverified" in production, distance shows as unavailable, and map screens use a placeholder component. See open item 1 for the pincode fallback option.

### 6.9 Distance to destination

- **Destination** is the RFQ job site. Geocode `site_location` + `state` (+ pincode) when the RFQ is created; the sales user confirms or drags the pin.
- **Distance** is road distance in km from the crane to the site. If routing fails, fall back to straight-line, label it "straight-line (approx.)" and store the method.
- **Shown in:** the candidate picker (7.9), the crane dropdown in the quotation form (7.7), and the received quotations table (7.9).
- **Candidate list** (simple BPD 7.1, vendor fleet only): cranes that match crane type, meet the RFQ `capacity_rule`, belong to approved vendors, are active, are effectively available for the RFQ dates (6.1), and have coordinates. If the start date is TBC, skip the date check and show a notice. Sort ascending by distance, group by vendor, nearest first, expandable. Cranes without coordinates are listed separately as "location unverified". Stale cranes appear with a badge.
- **Snapshots:** store the candidate list and distances on each recipient at send time, and the crane location and distance on each quotation. History is never recalculated.
- **Caching:** key on coordinates rounded to 3 decimals, reuse 30 days, invalidate when a crane's coordinates change, batch through a matrix API if available.
- **Isolation:** vendors only see distances for their own cranes.
- Do not compute mobilisation cost here. Keep `distance_to_site_km`.

## 7. Screens

### 7.1 Login (BPD 6.1)
Vendors: email + password, activation by emailed link, forgot-password by emailed link. Internal users: email, then a one-time code (6 digits, 10-minute expiry, single use, rate-limited). Generic error messages. Route by role after login. Activation and reset links expire and can be resent.

### 7.2 Vendor invitation and onboarding (BPD 6.20)
- **Invitation (admin or sales):** enter a vendor's email, the system sends the invitation email with a single-use onboarding link. Link expires after 7 days, with a "resend" action. Invite-only.
- **Onboarding form:** fields in 5.1, in sections: Company, Address, Contact persons (with the "receives RFQs" flag), Registration (GST registered or not, MSME, TDS), Bank, Fleet summary, Declaration. GSTN and the GST certificate upload appear only when "GST registered" is chosen.
- Required uploads: **cancelled cheque, PAN copy, declaration scan, and GST certificate if registered**. TDS and MSME certificates when those options apply.
- Inline validation for the standard checks: PAN format and 4th letter, GSTN characters 3 to 12 equal PAN, IFSC, 10-digit mobile without leading zero, one valid email per field, unique PAN and GSTN.
- Save as draft, then submit. The declaration checkbox stands and a signed, stamped declaration scan is uploaded beside it (open item 4, decided). On submit, status is `Submitted` and the admin is emailed.

### 7.3 Admin approval queue
- List of submitted vendors with filters by status.
- Detail view with all data, documents, and the office-use block (the master-list fields and the facilities review).
- Approve or reject, remarks required on rejection.
- **SAP vendor creation sheet:** a print-friendly page and Excel export on the approval screen, laid out in the order of the SAP-aligned form, so an admin can create the vendor in SAP by hand. Admin only. The export is not logged.
- **On approval:** create the vendor master, contacts and credentials, record the SAP vendor code if the admin has it (optional), send the activation email.
- On rejection: email the vendor with the remarks.

### 7.4 Vendor fleet management (BPD 6.19)
- List with filters (status, type) and search.
- Add and edit crane forms with inline validation (5.2).
- **Quick actions:** "Update status and location" in one step, "Duplicate this crane", "Confirm still accurate".
- Map pin confirmation. Own-fleet state filter and map toggle.
- Show last updated by and time on each crane, and the "updated by SML on behalf of vendor" mark where it applies.
- Derived Booked or Hired badge with the reservation dates, read-only.
- Deactivate (soft delete) instead of delete.
- **SML users (sales and admin)** open any vendor's fleet and use the same forms on the vendor's behalf (6.6).

### 7.5 Vendor dashboard (BPD 6.18)
- Fleet: total cranes, by status, **cranes due for update** (including lapsed `available_from`).
- RFQs: open RFQs, RFQs awaiting my response (nearest deadline first, overdue highlighted), quotations submitted, awarded and not awarded.
- Active and upcoming bookings: from Reservation records (Booked or Hired).

Each counter links to the filtered list.

### 7.6 RFQ inbox (vendor)
RFQ number, crane type, capacity, site location and state, required start date (or "to be confirmed"), duration, deadline with countdown, my response status, sent date. Unread indicator, filters, default sort by deadline.

### 7.7 RFQ detail and quotation form (vendor)
- Read-only requirement, application and load, configuration, commercial terms, attachments, SML contact. No customer name or address and no budget.
- Actions: **Submit quotation** or **Decline**.
- Form: crane dropdown (type, capacity, YOM, location, boom, **distance to job site**, nearest first, with an "add a crane" option), rental rate and basis, tax basis, mobilisation and demobilisation charges, calculated total with working, availability confirmation, available-from date, validity date, acceptance of terms (with deviation text), remarks, attachments, load chart.
- Show warnings from 6.7 before submission and require confirmation.
- On submit, show a receipt and email one. Before the deadline: Revise and Withdraw. After: read-only.

### 7.8 Quotation history (vendor)
All the vendor's quotations: RFQ number, crane, rate and basis, tax basis, mobilisation, demobilisation, total, validity, submitted at, version, vendor-visible status. Filters by status and date. A row opens the quotation with version history, read-only.

### 7.9 Internal RFQ creation and tracking (sales users; admin can view and track)
- **Create RFQ** from the fields in 5.4 with template defaults (taken from the enquiry mail and Cross Rental Enquiry Template). Enter the job site and confirm the pin. The **candidate picker** (6.9) lists matching cranes by distance, grouped by vendor. Select vendors, set the deadline, send by email.
- **Tracking list:** per RFQ, each recipient with delivery status, response status, first viewed, reminders sent. Actions: send reminder, extend deadline, cancel RFQ, close RFQ with reason.
- **Received quotations:** read-only table per RFQ (vendor, crane, rate, tax basis, mobilisation, demobilisation, total, validity, distance, warnings). No comparison UI. Selection uses the admin award action (6.7).

### 7.10 Fleet locations (internal)
For sales and admin users.
- **Overview:** state-wise table across approved vendors: state, vendors, cranes, cranes by type. Expanding a state lists its cranes.
- **By vendor:** state-wise table and a map. **By state:** vendors and counts.
- **Map:** one marker per crane (cluster when dense), coloured by status. A marker opens a summary card with vendor name, contact and crane details.
- **Filters:** vendor, state, crane type, capacity range, status.
- Only active cranes of approved vendors appear. Cranes without coordinates appear in the table flagged "location unverified", not on the map. Stale cranes are included with a badge.
- Heat maps are out of scope here (planned in the platform brief).

## 8. Emails (Microsoft 365)

Send from a shared mailbox through Microsoft Graph (preferred) or SMTP relay. Credentials from configuration.

| Template | Trigger |
|---|---|
| Vendor invitation | Admin or sales sends the onboarding link (replaces the current registration mail) |
| Onboarding submitted (to admin) | Vendor submits |
| Onboarding approved + activation link | Admin approves |
| Onboarding rejected + remarks | Admin rejects |
| Password reset | Vendor requests |
| Login OTP | Internal user signs in |
| Fleet update reminder | Crane crosses the stale threshold |
| Fleet updated on your behalf | SML user changes a vendor's crane |
| RFQ invitation | RFQ dispatched. Requirement summary, deadline, portal link, based on your enquiry mail |
| RFQ reminder | Vendor still Pending (automatic or manual) |
| Quotation receipt (to vendor) | Vendor submits, revises or withdraws |
| Quotation received (to RFQ creator) | A vendor submits |
| Award / Not Awarded | Per 6.7 |
| RFQ deadline extended or cancelled | Internal user changes the RFQ |
| Reservation released | Admin releases a reservation |

Log every email in `EmailLog`. Templates editable without a deploy if practical. RFQ emails carry the RFQ number in the subject (e.g. `[RFQ-2026-0001]`) and a deep link (login required). The RFQ email also asks vendors who decline to list other cranes and contacts they can offer.

## 9. Build order and acceptance criteria

### M1: Foundation
- Data model, migrations, roles, audit and email logging.
- Login, activation and password reset end to end.
- **Done when:** a seeded admin and a seeded vendor user can log in, reset a password, and each sees only what their role allows. A vendor cannot read another vendor's data (tested).

### M2: Invitation, onboarding and approval
- Invitation screen and single-use link with 7-day expiry and resend.
- Onboarding form with validations (including conditional GST, MSME and TDS) and the document uploads.
- Admin queue, approve and reject, automatic creation of vendor master, contacts and credentials, emails, **SAP vendor creation sheet**.
- **Done when:** an admin invites a new vendor, the vendor registers through the link (GST-registered or not), an admin approves, and the vendor gets an activation email and can log in. A rejected vendor gets the remarks. Duplicate PAN or GSTN is blocked. The creation sheet shows all SAP-aligned fields.

### M3: Fleet management
- Geocoding through the provider interface.
- Add, edit, status and location update, duplicate, deactivate.
- Validations and status rules from section 6. Pin correction. Load chart upload.
- **Updates on behalf of vendors** by admin and sales, with the audit mark and vendor notice.
- **Done when:** a vendor can add a crane with all mandatory fields, gets coordinates automatically, cannot add a duplicate, must give `available_from` for Engaged, and changes appear in the audit log. A sales user can edit a vendor's crane and the change is marked as made on the vendor's behalf.

### M4: RFQ data model, internal creation and dispatch
- RFQ, recipient and quotation entities (with `tax_basis` and demobilisation), the richer RFQ fields from 5.4, `sales_user` role, create and tracking screen (7.9), dispatch with delivery status, deadline extension (with reopening), cancel and close, reminders with the revised timing.
- Job-site geocoding with pin confirmation, the candidate picker (6.9) with the capacity rule, and candidate snapshots on send.
- **Done when:** a sales user can create an RFQ with application, load, structured boom and jib lengths and terms, confirm the pin, see matching cranes sorted by distance, pick vendors, send by email, and see delivery and response status. Failed deliveries are visible. Only approved vendors can be chosen. If routing fails, straight-line distance is labelled. An RFQ cannot hold a customer name or budget.

### M5: Vendor RFQ inbox, quotation submission and history
- Inbox (7.6), detail and quotation form (7.7) including tax basis, demobilisation and inline crane add, decline, history (7.8).
- All validations, warnings (including boom length and capacity rule), total calculation, versioning, withdrawal and deadline locking.
- **Done when:** a vendor sees only their own RFQs, can submit a quotation with a crane and load chart, sees the calculated total (rental + mobilisation + demobilisation) with tax basis and warnings, can revise or withdraw before the deadline, cannot act after it, and finds every version in history. The RFQ creator is emailed. Another vendor can never see these quotations (tested).

### M6: Fleet location views
- State-wise and per-vendor views with map (7.10), vendor own-fleet map and state filter (7.4).
- **Done when:** a sales user sees crane counts by state, picks a vendor and sees its cranes by state and on a map, filters by type, capacity and status, and opens a vendor contact. Cranes without coordinates are flagged and left off the map. A vendor sees only their own cranes.

### M7: Reservations, award outcome, dashboard and reminders
- Reservation entity with overlap protection, release action, derived Booked or Hired badges.
- `award_quotation` as specified in 6.7, admin-only action, Awarded and Not Awarded emails.
- Vendor dashboard counters and cranes-due-for-update with reminder emails.
- **Done when:** awarding a quotation creates a dated reservation and marks the winner; with RFQ quantity 2, the first award leaves other quotes open and the second award closes the RFQ and marks the rest Not Awarded; Withdrawn and older versions are untouched; a second award on a crane with an overlapping reservation is refused; releasing a reservation makes the crane available again; the booking shows on the winning vendor's dashboard; a stale crane appears on the dashboard and triggers one reminder.

### M8: Hardening
- Access-isolation tests (including RFQs, quotations, and the absence of customer name and budget in any vendor response), upload validation, rate limiting, bank-detail masking, error handling for geocoding and email failures.
- **Done when:** the checks pass and a pilot with a few vendors can be run.

## 9.1 Further implementation roadmap

**Added after the owner decisions in section 4 (decisions on open items 1, 2, 5, 6, 7 and 8).**
This reconciles the revised brief with what the current build produced against the
earlier version of it. Milestones M7 above describe the *target*, not what is
built; the phases below rework the built code toward brief 6.7 as revised, and
add the richer fields the revision introduces. Each phase lands with its tests.

> **Progress (16 Oct 2026):** A1, A2, A3, A4 and A5 are built and tested
> (308/308 backend, frontend lint + build clean; migrations
> `20261016090000_sap_aligned_vendor_fields`,
> `20261016103000_quotation_tax_basis_demobilisation`,
> `20261016120000_rfq_capacity_rule_tbc_boom`, and the new
> `RATE_DAY_BASIS` admin setting on `GET/PATCH /api/settings`).
>
> **B1 (Reservation entity) is built and tested** (316/316 backend, frontend
> lint + build clean). Migration `20261016201206_b1_reservations` adds the
> `reservations` table, a `btree_gist` `EXCLUDE` constraint refusing overlapping
> ACTIVE reservations, and synthesizes one ACTIVE reservation per crane still
> carrying the legacy stored `BOOKED`/`HIRED` status before resetting it. New
> `GET/POST /api/reservations`, `POST /api/reservations/:id/release` (reason +
> audit + `reservation_released` mail) and `POST /api/reservations/complete-overdue`
> (also a daily job). Booked/Hired are now derived from reservations for the
> vendor dashboard bookings.
>
> **B2 (Award rework) is built and tested** (321/321 backend, frontend lint +
> build clean). The award now creates a dated `BOOKED` reservation (window from
> the RFQ, or explicit dates when `startDateTbc`), refuses a crane that is Under
> Maintenance or already has an overlapping ACTIVE reservation ("crane now
> reserved"), and awards **partially** until the RFQ's `quantity` is reached —
> only then are the remaining latest Submitted quotations set Not Awarded and the
> RFQ closed. The crane status is no longer written. Decision 8 applied: the
> user-facing terminal status reads "Finalised". The award tests were rewritten
> for the quantity-2 scenario, with new tests for the window, overlap,
> maintenance and TBC dates.
>
> **B3 (Effective availability) is built and tested** (325/325 backend, frontend
> lint + build clean). Candidate matching and the quotation guard now ask "is
> there an overlapping ACTIVE reservation for this RFQ's window?" instead of
> reading the crane's stored Booked/Hired status. `reservationWindowForRfq` (in
> `reservations.service.ts`) is the single place that derives the window, used by
> both the award and the quotation/candidate paths. A vendor is refused at submit
> with "That crane is reserved on an SML contract for X to Y and cannot be
> quoted", and a reserved crane is dropped from the candidate picker. An Engaged
> crane whose `available_from` has lapsed is surfaced on the vendor dashboard as
> "availability date lapsed, confirm" and counted as due for update.
>
> **Phase C is built and tested.** C1: extending a deadline returns recipients the
> sweep expired (never-responded) to `PENDING` with their reminder stamp cleared,
> along with the "deadline extended" mail; a `DECLINED`/`QUOTED` recipient is
> untouched, and the response now carries `revived`. C2: an automatic reminder
> fires inside the smaller of `RFQ_REMINDER_LEAD_HOURS` and half the RFQ's
> send-to-deadline window, and is suppressed when that window is under the new
> `RFQ_REMINDER_MIN_WINDOW_HOURS` (default 4). C3: a TBC start date skips the
> date checks in the candidate picker (Engaged cranes admitted, no overlap
> query) and carries a `startDateTbc` flag plus a notice; the quotation side
> already declined to require an availability confirmation and stores the
> `start_date_tbc` warning. C4: the enquiry mail and the decline form ask the
> vendor to list other cranes or contacts, and `declineNote` is returned to the
> RFQ's creator on the tracking detail.
>
> **Phase D is built and tested** (341/341 backend before E, frontend lint +
> build clean). D1: an internal user with the new `fleet:edit_all` capability
> (admin + sales) maintains any APPROVED vendor's fleet through the same routes
> and forms; an on-behalf write stamps `updatedOnBehalf` on the crane and
> `onBehalfOfVendor` on the audit row, shows a "Updated by SML on your behalf"
> badge and an on-behalf notice on the vendor dashboard, and emails
> `fleet_updated_on_behalf`; the vendor's own next edit clears the mark. D2: an
> inline "crane not in your fleet? Add it here" block inside the quotation form
> (mandatory 5.2 fields only). D3: a print-friendly SAP vendor creation sheet at
> `/app/vendors/$vendorId/sap-sheet` plus a SpreadsheetML `.xls` export, admin
> only (`vendor:view_bank`), never logged; its office-use block is backed by six
> admin-editable master lists (`GET/PUT /api/settings/master-lists[/:name]`,
> seeded empty) edited on the new `/app/settings` screen. D4:
> `expected_ready_date` (shown while Under Maintenance) and the
> `reservation_released` template. Migration
> `20261017052736_d1_d4_on_behalf_expected_ready` then
> `20261017171610_d3_office_use_master_lists`.
>
> **Phase E (M8 hardening) is built and tested.** The access-isolation suite now
> covers the new surfaces: the vendor RFQ detail is pinned to a key whitelist and
> asserted to carry no `customer*`/`budget*` key, reservations are internal-only
> (a vendor read is refused), and the earlier crane/quotation/RFQ isolation tests
> stand. A new `validation.test.ts` pins PAN, GSTIN (and the GSTIN-embeds-PAN
> rule), IFSC, mobile/telephone, account number, MICR, pincode and CIN. Upload
> allow-list (MIME + magic bytes + extension), credential rate limiting,
> bank-detail masking, and geocoding/email failure fallbacks were already covered
> and remain green.
>
> **P0 (portal gap check and admin basics) is built and tested** — see
> `plan/p0-portal-gap-check.md`. Section A ended Present/Missing/Different; the
> Missing items are fixed: the six remaining RFQ terms (mobilisation/demobilisation,
> support crane, steel mats and ground prep, EHS/HR, insurance, extension clause)
> are on `Rfq` and flow through the form, invitation mail and vendor screen; the
> jib-shortfall warning joins the capacity and boom warnings; the contact mobile
> is normalised to ten digits with no leading zero; a duplicate PAN/GSTIN is named
> on submit instead of surfacing as a generic 409; and the invitation expiry is
> seven days. Section B added `/api/admin` — the five dashboard counters, internal
> user management and vendor suspend/reinstate — plus the `/app/admin` screen and
> the **Vendor access** panel on the vendor detail screen. Suspension is enforced
> at login, in RFQ recipient resolution, in the approved-vendor picker and in the
> candidate set. Migration `20261017180936_p0_rfq_terms_vendor_suspension`.
> `admin.test.ts` covers the counters, user lifecycle, suspension effects and the
> audit trail (378/378 backend, frontend lint + build clean).

### Phase A — Schema alignment (additive, low risk)

- **A1. SAP-aligned vendor form** (open item 2, decided): structured address
  (line1/2, city, district, state, pincode); `gst_registered` conditional block —
  `gst_registration_type` (Regular / Composite / SEZ / EOU), GSTN characters 3 to
  12 must equal the PAN, stored null when unregistered; PAN 4th-letter rule
  (C for Public/Private Ltd, F for Partnership, P for Proprietorship);
  `account_holder_name`, `micr`, `iban`/`swift` (foreign banks only); TDS
  lower-deduction block; `msme_registered` conditional fields;
  `communication_preferences`. Weekly-off and DGTD/SSI stay optional; HSN
  product range dropped. Touches the migration, the onboarding form and its
  validations, the admin detail view and the test fixtures.
- **A2. Quotation additions**: `tax_basis` (default Exclusive of GST) and
  `demobilisation_charges`; total becomes rental + mobilisation + demobilisation.
  Touches the quote form and preview, the receipt, the vendor history, the
  internal received-quotations table, and the M5 tests.
- **A3. Richer RFQ** (open items 6 and 7, decided): `capacity_rule`
  (At least / Exact) and `capacity_note` (free text; matching stays on tonnes);
  `application_description`, `load_description` and required boom/jib lengths as
  structurable numbers (new "boom too short" warning); `start_date_tbc` (skips
  availability checks with a notice); `working_days_per_month`; extended
  commercial terms (support crane scope, steel mats / ground prep, EHS/HR,
  insurance, extension clause). New `app_settings` key `RATE_DAY_BASIS`
  (calendar days default / working days per month) read by the total
  calculation, per decision 6.
- **A4. Contacts**: `VendorContact.receives_rfqs` flag; RFQ emails go to
  contacts with the flag, falling back to the primary contact.
- **A5. Declaration scan** (open item 4, decided): a `declaration_scan`
  document type uploaded beside the declaration checkbox, required at submit,
  visible to the admin on the approval detail. Reuses the existing upload-by-
  document-type path.

### Phase B — Booking rework (structural)

- **B1. Reservation entity** (brief 5.3, 6.1): start/end dates, type
  (Booked / Blocked), source RFQ and quotation, status (Active / Released /
  Completed), release with reason + email. Overlap prevention enforced in the
  award transaction, plus a database constraint. Booked / Hired become **derived
  badges** computed from active reservations — no stored `BOOKED`/`HIRED`
  status. Migration synthesises a Reservation for every crane the current built
  award left in `BOOKED`, then resets the status.
- **B2. Award rework** (brief 6.7 as revised): award creates the Reservation
  (requires explicit dates when the start date is TBC); refused when the crane
  has an overlapping active reservation or is Under Maintenance. Partial awards:
  other quotes stay open until the awarded count reaches the RFQ quantity; only
  then are the remaining latest Submitted quotations set to Not Awarded and the
  RFQ Closed. Same-crane quotations on other RFQs with overlapping dates get the
  internal "crane now reserved" warning and cannot be awarded. The award tests
  are rewritten for the quantity-2 scenario.
- **B3. Effective availability**: quotation blocks and candidate matching move
  from "not Booked / Hired" to "no overlapping active reservation for the RFQ
  dates"; an Engaged crane with `available_from` in the past is flagged "date
  lapsed, confirm" on the dashboard and counts as due for update.

### Phase C — RFQ lifecycle fixes

- **C1. Extension revival**: extending a deadline returns Expired recipients who
  never responded to Pending, with the "RFQ deadline extended" email. This
  deliberately replaces the earlier "never revive an Expired recipient" rule
  and its documentation.
- **C2. Reminder timing** (brief 6.7 as revised): the automatic reminder fires
  at the smaller of the configured lead time and half the response window, and
  is suppressed when the whole window is shorter than
  `RFQ_REMINDER_MIN_WINDOW_HOURS` (new setting, default 4).
- **C3. TBC start date**: threading through the candidate picker and the
  quotation validations with the notice.
- **C4. Decline**: the RFQ email and the decline flow ask vendors to list other
  cranes or contacts they can offer; `decline_note` is surfaced to the RFQ
  creator.

### Phase D — On-behalf updates, screens and emails

- **D1.** `updated_on_behalf` on the crane and the audit entry, a dashboard
  notice for the vendor, and the "Fleet updated on your behalf" email.
- **D2.** Inline crane add inside the quotation form (mandatory fields from 5.2
  only, then continue to the quote).
- **D3.** SAP vendor creation sheet: a print-friendly page plus an Excel export,
  laid out in the order of the SAP-aligned form, on the approval detail screen,
  admin only. The office-use block is built as small admin-editable master
  lists (seeded empty — no guessed values, per open item 3), so the owner's
  SAP "Legal Form Logic" values load later without a code change.
- **D4.** `expected_ready_date` shown when status is Under Maintenance; the
  "Reservation released" email template.

### Phase E — M8 hardening (unchanged, runs last)

Access isolation across the new surfaces (quotations, reservations, and the
absence of customer name, address and budget in any vendor response), upload
validation, rate limiting, bank-detail masking, geocoding and email failure
handling, and the validation tests for PAN, GSTN, IFSC and mobile.

**Build order: A → B → C → D → E.** Phase B breaks the current award behaviour,
so its tests land together with the reworked ones; phases C and D ship after B
rather than interleaved.

## 10. Working rules for the agent

1. Resolve section 4 open items with the owner, or follow the working assumption and say so.
2. Do not build anything out of scope, but leave clean extension points: the RFQ's link to an Enquiry line item (platform brief), the sales-side comparison and finalisation screens (they call `award_quotation`), the reservation table (the platform extends it to SML cranes), and the fleet approval toggle.
3. Use **dummy data** for tests and seeds. The sample registration forms contain real PAN and bank numbers; do not copy them into code, fixtures or logs.
4. Keep secrets in configuration or a secrets store.
5. Write tests for access isolation, status and reservation rules, award with quantity above 1, duplicate detection, and the validations (PAN, GSTN, IFSC, mobile, email).
6. Work milestone by milestone and report against each "Done when" line.