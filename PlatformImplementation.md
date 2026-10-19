# Crane Discovery Platform: Remaining Implementation Brief

Brief for the agent building everything in the *Crane Discovery & Vendor Repository Platform* that is **not** covered by `Vendor_Portal_Implementation.md` and  `ImporvedVendorPortalImplementation.md`.
Source: the Business Process Document (BPD), the Cross Rental Enquiry Template, and decisions made while scoping.

**Read `Vendor_Portal_Implementation.md` and  `ImporvedVendorPortalImplementation.md` first.** This brief builds on it and must not duplicate or contradict it.

**Revision note:** SAP integration is parked. Enquiries are entered natively by the CR team using the Cross Rental Enquiry Template as the form. "Sales user" means the CR team. Sales Partners have no access.

---

## 1. Context

The platform's goal (BPD section 1): when an enquiry is created, check SML's own fleet and registered vendors' fleets, rank matching cranes by distance to the job site, estimate mobilisation cost, and let the CR team run RFQs, compare quotes and finalise a vendor, all in one system.

Enquiries currently arrive through a Sales Partner and are handled by the CR team. For now the CR team types each enquiry into the platform. A feed from SAP can be added later through the adapter point in 8.1.

The vendor portal brief delivers the vendor-facing side plus a **minimal** sales side (manual RFQ creation, a distance-sorted candidate picker, an admin-only award action, dated reservations for vendor cranes). This brief covers the rest.

## 2. What already exists (do not rebuild)

From the vendor portal brief:

- Vendor, VendorContact (with `receives_rfqs`), VendorDocument, VendorInvitation, Crane (coordinates, status, `available_from`), User (`vendor_user`, `admin_user`, `sales_user`), AuditLog, EmailLog, DistanceCache
- **Reservation** (dated, with overlap protection) for vendor cranes
- RFQ (one per line item per RFQ event, with a rich editable requirement snapshot), RFQVendorRecipient, Quotation (versioned, with tax basis and demobilisation)
- Vendor invitation, onboarding and approval (with the SAP vendor creation sheet), fleet management including updates on a vendor's behalf, RFQ inbox, quotation submission and history, vendor dashboard
- Minimal sales screen for RFQ creation, tracking and received quotations
- Candidate picker sorted by distance (vendor fleet only)
- `award_quotation(quotation_id, reason_code)` with quantity-aware logic, and an admin-only action
- Provider interface for geocoding and road distance, with a stub (provider decision on hold)
- Email through Microsoft 365, internal OTP login, vendor email + password login

## 3. Scope and order

| Phase | Name | BPD references | Depends on |
|---|---|---|---|
| P0 | Close gaps in the vendor portal | 6.2, 6.22 (partial) | Portal M1 to M8 |
| P1 | Native enquiry intake, enquiry screens, SML fleet | 4.1 to 4.3, 5.1, 5.2, 6.3 to 6.6 | P0 |
| P2 | Recommendation engine, mobilisation cost, booking calendar (SML and vendor) | 4.3 to 4.5, 5.4, 5.5, 5.12, 6.6, 6.7, 6.17, 7.1 | P1, **geocoding provider decision** |
| P3 | Quote comparison and final selection | 4.9, 4.10, 5.8, 6.15, 6.16 | P1, P2 |
| P4 | Discovery search, vendor and crane detail, communication and audit viewers, heat map | 5.9, 5.10, 6.8, 6.9, 6.10, 6.11, 6.21, 5.14 | P2 |
| P5 | Role dashboards, alerts, admin configuration, reports, SSO | 5.13, 5.15, 6.2, 6.22, 6.23, 7.3 | P1 to P3 |
| P6 | WhatsApp dispatch, reply parsing, validation queue | 4.8, 5.6, 5.7, 6.14 | P3 |
| P7 | Rollout and operations | n/a | All |

**Out of scope everywhere:** vendor performance analysis such as deployment date, performance and client feedback (explicit in the BPD). Win ratio and responsiveness metrics based on RFQ participation are allowed (BPD 6.10).

**Parked:** SAP integration (enquiry feed, SML fleet feed, write-back), and anything that depends on it.

## 4. Decisions already made

| Topic | Decision |
|---|---|
| SAP integration | **Parked.** No feed, no write-back. Keep one adapter point (8.1). |
| Who is the "sales user" | The CR team. Sales Partners get no access. |
| Enquiry intake | Native, using the Cross Rental Enquiry Template fields (8.2). |
| Communication channel | Email only, through Microsoft 365. WhatsApp deferred to P6. |
| Geocoding, distance and map provider | **On hold.** Interface and stub only. |
| Tech stack and hosting | Provided by the owner. The agent must not choose them. |
| Microsoft 365 setup | Handled by the owner. |
| Fleet update approval | Off, behind a config flag. |
| Bulk Excel upload of fleets | Deferred. Reconsider in P7. |
| Internal login | OTP by email for admin and sales. |
| Vendor code | Platform `vendor_id` always. SAP vendor code optional, typed by an admin. Never blocks selection. |
| PO reference | A manual text field "PO / SAP reference", filled in after SCM raises the PO. |
| Booking record | The platform's Reservation table is the only booking record for SML and vendor cranes. |
| Stale data | 30 days due for update + reminder. 60 days stale for admins. Not hidden from candidate lists. |
| Customer name and rental budget | Internal only. Never shown to vendors and never copied into the RFQ. |
| Inspection or GO / NO-GO | Not part of the BPD. **Not built.** |

## 5. Open items (ask the owner before assuming)

| # | Open item | Working assumption until answered |
|---|---|---|
| 1 | **Enquiry template fields.** The field list in 8.2 is derived from the Cross Rental Enquiry Template | At the start of P1, compare 8.2 against the template file and add or rename fields. Template wins. |
| 2 | **SML fleet source** now that SAP is parked | Admin-maintained SML crane list in the platform (add and edit form). Until it exists, the internal check is manual: the CR user marks a line "Checked internally, not available" or "Fulfilled internally". |
| 3 | **Vendor-facing customer details.** The vendor-facing sheet of the template includes the customer name and address | Do not show them. Vendors see site location only. Confirm. |
| 4 | **Per-km mobilisation cost values** and dimensions | One table keyed by crane category and capacity band, optional ownership column. Owner supplies values. |
| 5 | **Quote ranking rule** | Rank by total estimated cost ascending (rental + mobilisation + demobilisation), configurable. Confirm. |
| 6 | **Business vertical** (report filter, BPD 6.2 and 6.23) | Admin-maintained master list, chosen on the enquiry. |
| 7 | **Logins per vendor** | One primary login per vendor. Contacts are records, not users. Confirm. |
| 8 | **SSO provider** | Likely Microsoft Entra ID. Confirm, and whether OTP stays as a fallback. |
| 9 | **WhatsApp provider** | None chosen. Decide at P6. |
| 10 | **Data protection and retention** for PAN, bank and contact data | Needs legal review. Build retention periods as configuration. |
| 11 | **Alert SLA values** | Configurable. Owner supplies defaults. |
| 12 | **Heat map** (BPD 5.10, 6.9) | Built in P4 only after the provider decision. Confirm it is wanted. |
| 13 | **Geocoding fallback** | See the portal brief, open item 1 (pincode option). Owner decides. |
| 14 | **Capacity matching.** Enquiries sometimes say "700 TMC or higher" | Match on tonnes with the line item's `capacity_rule` (At least by default). Confirm whether TMC must be captured. |
| 15 | **Status spelling** ("Finalised" or "Finalized") | Use the BPD's spelling. This brief uses "Finalised". |

## 6. Roles and permissions (target state)

| Capability | Sales (CR team) | Vendor | Admin | Management Viewer |
|---|---|---|---|---|
| Enquiry inbox, detail, sourcing workspace | Own enquiries (all with a setting) | No | View all | View all, read-only |
| Create enquiry | Yes | No | Yes | No |
| Customer name, address, rental budget | Yes | **Never** | Yes | Yes (read-only) |
| Create RFQ, shortlist, compare, finalise | Yes | No | View and award override | No |
| Own fleet, RFQ inbox, quotes | No | Own only | View all | No |
| Edit a vendor's fleet on their behalf | Yes (audited) | n/a | Yes (audited) | No |
| Vendor and crane detail, discovery search | Yes | Own profile only | Yes | Read-only |
| Bank details | No | Own (masked) | Yes | No |
| Admin configuration, user management | No | No | Yes | No |
| Reports | Own scope | No | All | All, read-only |

Sales Partners have no account. Enforce on the server on every query. The Management Viewer role is new in P5.

## 7. Phase P0: Close gaps in the vendor portal

Small items the vendor portal brief leaves open. (Invitation, GST basis, reservations and updates on behalf of vendors are now inside the portal brief.)

1. **Admin dashboard (minimal):** onboarding requests awaiting approval, RFQs with email delivery failures, cranes flagged stale (60 days), cranes marked "location unverified", cranes with a lapsed `available_from`. Each counter links to a filtered list.
2. **User management:** admins create and disable internal users (sales, admin), assign roles, trigger a credential reset, and **suspend or reinstate a vendor** (a suspended vendor cannot log in or receive RFQs). All actions audited.
3. **Status model check:** confirm RFQ.status is lifecycle only (Draft, Sent, Closed, Cancelled) and `response_state` is derived, so the line-item trail in 8.3 can read it.

**Done when:** an admin sees failures, stale and lapsed cranes on one dashboard, can create and disable a sales user, and can suspend a vendor.

## 8. Phase P1: Native enquiry intake, enquiry screens, SML fleet

### 8.1 Enquiry intake and the adapter point

- The CR team creates an enquiry in the platform with the form in 8.2. Edits are audited.
- All creation goes through one service, `create_enquiry(payload, source)`. For now `source = manual`. A future SAP or other feed would call the same service. Do not build any integration, protocol or mock.
- `enquiry_no` is the unique key. The platform generates it (e.g. CR-2026-0001) and also stores the customer's or Sales Partner's own reference as free text. Duplicates of that reference raise a warning, not a block.
- Cancelling or changing a line item is a manual, audited action. Changes after an RFQ was sent show a warning, and the RFQ snapshot is not changed automatically.

### 8.2 Data model

**Enquiry (header), internal:**

| Field | Rule |
|---|---|
| enquiry_no | System, unique |
| external_reference | Optional free text (the Sales Partner's or customer's reference) |
| enquiry_date | Mandatory, default today |
| source | `manual` (adapter point) |
| sales_partner_name | Optional text only. No account |
| cr_owner | CR team user |
| customer_name, customer_address | Mandatory. **Internal only** |
| site_location, state, pincode, region | Job site. Coordinates geocoded, pin-confirmable |
| business_vertical | From master list (open item 6) |
| cross_rental_flag | Default true, since all manual enquiries are cross-rental |
| overall_status | Rolled up (8.4) |
| notes | Internal notes |

**EnquiryLineItem** (fields from the Cross Rental Enquiry Template; confirm against the file, open item 1):

| Group | Fields |
|---|---|
| Requirement | line_no, crane_type, capacity_t, **capacity_rule** (At least default, Exact), capacity_note, quantity |
| Application and load | application_description, load_description (e.g. "565 MT @ 78 m boom, 12 m radius"), lift_load_t, working_radius_m |
| Configuration | required_main_boom_m, required_fixed_jib_m, required_luffing_jib_m, required_wind_jib_m (numbers), configuration_notes |
| Dates | required_start_date, **start_date_tbc**, duration_value, duration_unit (days or months), working_days_per_month |
| Mobilisation | mobilisation_terms, demobilisation_terms (who arranges and bears them, expected timing) |
| Terms and scopes | ot_charges, breakdown_terms, diesel_scope, working_hours_shift, accommodation_conveyance, payment_terms, support_crane_scope, steel_mats_ground_prep_scope, ehs_hr_compliance, insurance_terms, extension_clause, crane_age_criteria_years, other_terms |
| **Internal only** | **rental_budget** (free text allowed, e.g. "35 lakhs or best lowest", plus optional numeric amount), internal_notes |
| Status | sourcing_status, rfq_status, quote_status, selected_source (SML or vendor), closure_status, trail status (8.3) |

**RFQ link:** creating an RFQ from a line item prefills the RFQ from that line item and copies **only the vendor-safe subset**: everything above except customer_name, customer_address, rental_budget, internal_notes and sales_partner_name. The copy is a snapshot; later enquiry edits do not change sent RFQs. Enforce the exclusion in code and in a test.

**SmlCrane:** equipment_id, crane_type, capacity_t, make, model, yom, main_boom_m and jibs (numbers), current_location, state, coordinates, operational_status, maintenance blocks (start, end, reason), expected_ready_date, load_chart.

**Reservation:** extend the portal's Reservation to reference either a vendor crane or an SML crane. Add types `Hired` (if wanted) and `Maintenance`, and the source enquiry line item.

**RFQ change:** link `RFQ` to `enquiry_line_id`. Keep the snapshot fields.

### 8.3 Line-item status trail (BPD 6.5)

`New` → `Availability Check` → `Vendor Shortlisted` → `RFQ Sent` → `Awaiting Quotes` → `Quotes Received` → `Under Evaluation` → `Vendor Finalised` → `Booked` → `Closed`

Plus: `Fulfilled internally` and `Cancelled`. Status is driven by events, never typed in freely. Every change is audited. Event definitions:

| Status | Trigger |
|---|---|
| New | Line item created |
| Availability Check | CR user opens the internal check, or records an SML result (available, not available) |
| Vendor Shortlisted | At least one vendor is ticked in the candidate picker for this line |
| RFQ Sent | An RFQ for this line is dispatched |
| Awaiting Quotes | RFQ sent and no quotation yet (derived from RFQ `response_state`) |
| Quotes Received | First quotation arrives |
| Under Evaluation | CR user opens comparison and marks the first quotation |
| Vendor Finalised | Selection confirmed in 6.16 |
| Booked | Reservation created and active in the future or today |
| Closed | Reservation completed, or CR user closes the line with a reason |
| Fulfilled internally | CR user confirms an SML crane |
| Cancelled | CR user cancels the line with a reason |

### 8.4 Enquiry status roll-up (assumed mapping, confirm)

| Condition across line items | Enquiry status |
|---|---|
| Just entered, nothing started | Received, Pending Sourcing |
| Some line items have quotes, others pending | Partially Quoted |
| All line items finalised or fulfilled | Fully Finalised |
| Some finalised, some not | Partially Finalised |
| All line items closed or cancelled | Closed |

Show RFQ, quote and finalisation summaries as counts per stage (BPD 6.4).

### 8.5 Screens

- **Enquiry Create and Edit:** the form in 8.2, with the line-item table, the template's terms pre-filled with defaults, a pin-confirm map for the site, and a clear "internal only" marking on customer and budget fields.
- **Enquiry Inbox (6.3):** one row per enquiry: number, date, customer, site, region, line-item count, owner, overall status, RFQ summary, quote summary, finalisation status. Filters: date range, region, crane category, customer, status, stage.
- **Enquiry Detail (6.4):** header, line-item table with the BPD 6.4 fields, rolled-up counts, drill into a line item. Internal-only fields visible to internal users only.
- **Line-Item Sourcing Workspace (6.5):** SML fleet recommendations, vendor fleet recommendations, RFQ history, quotations received, comparison, final selection and booking. Sections for P2 and P3 appear as the phases ship.
- **SML Fleet section (6.6):** shown **before** vendors. P1 shows matching SML cranes by type and capacity (honouring `capacity_rule`) and basic availability from the admin-maintained list. Distance, cost and calendar come in P2.
- **SML crane list (admin):** add, edit and deactivate SML cranes (open item 2).
- **Internal fulfilment:** the CR user marks the line "Fulfilled internally" or "Checked internally, not available". No RFQ needed for the first.
- Admin dashboard adds nothing SAP-related.

**Done when:** a CR user can enter an enquiry with several line items using every template field, including internal-only customer and budget fields; the enquiry appears in the inbox as Received, Pending Sourcing; matching SML cranes appear first in the workspace; an RFQ created from a line item links to it and carries **no** customer name, address or budget (tested); the trail and roll-up update correctly as events happen, using the definitions in 8.3.

## 9. Phase P2: Recommendation engine, cost, booking calendar

**Requires the geocoding provider decision.** Until then everything runs on the stub.

### 9.1 Recommendation engine (BPD 7.1)

Run separately for SML and vendor fleets. **Never merge the two result sets.**

| Step | Action | Data source |
|---|---|---|
| 1 | Match crane type and capacity (per `capacity_rule`) | SmlCrane, Crane |
| 2 | Check availability for the contract dates | Reservations and availability |
| 3 | Retrieve current coordinates | SmlCrane, vendor fleet |
| 4 | Road distance to the job site | Provider interface with DistanceCache |
| 5 | Estimate mobilisation cost | Cost assumption table |
| 6 | Rank ascending by distance | Engine |
| 7 | Display in separate SML and vendor sections | Workspace |

- Only deployable cranes surface (Available, or Engaged with `available_from` on or before the start date, no overlapping reservation or maintenance block). If the start date is TBC, skip the date check and show a notice.
- Show warnings when a crane's boom or jibs are shorter than the line item's required lengths.
- **Recommendation snapshot** stored on the line item at evaluation time. A "refresh" action re-runs it and keeps earlier snapshots.
- Vendor section shows vendor, crane, capacity, location, distance, estimated mobilisation cost, YOM, availability, region and participation metrics (BPD 6.7). Sortable by distance or cost.
- This **replaces the simple candidate picker**. Reuse its snapshot structure.

### 9.2 Mobilisation cost estimate (BPD 5.5)

Estimated cost = road distance (km) × per-km rate from the cost table (open item 4). Show it on every row. Seed from a config file until Admin Configuration (P5) exists.

### 9.3 Booking calendar and reservations (BPD 5.12, 6.17)

- The portal already created Reservation for vendor cranes. P2 adds **SML cranes** to the same table (open item 2) and the **Booking Calendar** screen. The platform's reservations are the single booking record.
- Reservations are created on final selection (P3) and for the full contract duration, and prevent overlaps. Vendor-managed status stays separate from reservations; effective availability combines both.
- Cancel or release a reservation with a reason (the portal's release action stays and is shown here too).
- **Booking Calendar (6.17):** free, reserved, hired, blocked or unavailable over a date range. Filters: ownership type, crane type, vendor, region, location.
- No migration of undated bookings is needed, because the portal never creates them.

**Done when:** for a line item, SML and vendor sections show separate lists ranked by distance with cost estimates; a crane with an overlapping reservation does not appear; short boom or jib warnings show; the snapshot is stored and viewable later; the calendar shows reservations for both SML and vendor cranes, and releasing one makes the crane available again.

## 10. Phase P3: Quote comparison and final selection

### 10.1 Quote Comparison screen (BPD 6.15)

Opens from the line-item workspace. Columns: vendor, crane reference, rental rate and basis, tax basis, mobilisation, demobilisation, total estimated cost, distance, crane age, availability confirmation, validity, response time, remarks, recommendation rank, warnings from the portal brief.

- Mark each quotation Under Review, Shortlisted, Rejected or Selected, with a **reason code** (master list).
- Default rank by total estimated cost ascending (open item 5).
- Line-item status moves to Under Evaluation when the first quotation is marked.
- Only the latest, non-withdrawn version of each quotation is comparable. Older versions are viewable in history.
- Rental budget (internal only) may be shown beside the totals to internal users.

### 10.2 Final Selection and Booking Confirmation (BPD 6.16)

Shows chosen crane, vendor, final rate, mobilisation, demobilisation, booking start and end dates, duration, remarks. On confirm:

- Line-item status becomes Vendor Finalised, then Booked once the reservation exists. Enquiry roll-up recalculated.
- A Reservation is created for the full duration.
- Non-selected quotations become Not Awarded **only when the RFQ quantity is fully awarded** (see the portal's `award_quotation`).
- Notifications to users and vendors.
- **Implementation:** this screen calls the existing `award_quotation` service. Extend it, do not write a second path. If the line item's quantity is above 1, the screen lets the user award several quotations in turn. The admin-only award action stays as an override.
- If the start date is TBC, the screen requires dates before confirming.

### 10.3 PO reference (manual)

After SCM raises the PO outside the platform, the CR user records a **"PO / SAP reference"** text field on the line item. No sync status and no integration. The reference is internal only.

**Done when:** a CR user can compare quotes, mark them with reason codes, select one (or several for quantity above 1), and confirm. Remaining quotes become Not Awarded once the quantity is met, the crane is reserved for the contract dates, vendors are emailed, a PO reference can be recorded, and the whole trail is auditable.

## 11. Phase P4: Discovery, detail screens, history viewers, heat map

- **Manual Vendor Discovery (6.8, 5.9):** standalone search independent of any enquiry. Filters: crane type, capacity, location, vendor name, region, company size, fleet size, YOM, ownership type, availability. Views: list, grouped by vendor, map (depends on provider decision). Open Vendor Detail, Crane Detail or start sourcing.
- **Vendor Detail (6.10):** profile, contacts (with `receives_rfqs`), regions, company size, fleet size, categories, onboarding status, communication preferences; fleet and availability; historical RFQs received, quotations submitted, win ratio and responsiveness. Actions: contact, shortlist for a line item, generate RFQ, **edit fleet on the vendor's behalf**. Bank details to admins only.
- **Crane Detail (6.11):** SML or vendor crane. Ownership, ID, type, capacity, make, model, YOM, boom and jibs, location, status, booking calendar, maintenance flags, transport cost assumptions, next available date. Back-links to the originating list.
- **Communication History (6.21):** chronological log of inbound and outbound messages linked to enquiry, line item, RFQ and quotation: type, channel, date and time, sender, recipient, delivery status, and whether it triggered a business event. Built on `EmailLog`.
- **Audit trail viewer (5.14):** reconstruct the sourcing history of any enquiry.
- **Heat map (5.10, 6.9), optional:** crane density by region or state for internal users, built only after the provider decision and if the owner wants it (open item 12). Reuse the fleet-location data from the portal's 7.10.

**Done when:** a CR user can find vendors without an enquiry, open a vendor and see its fleet and participation history, and view the full communication and audit history of any enquiry. If the heat map is approved, it renders from stored coordinates.

## 12. Phase P5: Dashboards, alerts, configuration, reports, SSO

### 12.1 Role dashboards (BPD 6.2)

- **Sales (CR team):** new enquiries, pending sourcing, line items at each stage, closed enquiries. Highlights overdue RFQs, expiring quotations, items needing action. Counters link to filtered lists.
- **Admin:** extends the P0 dashboard with fleet records pending validation (only if fleet approval is on), unmatched quotation messages (P6) and system exceptions.
- **Management (new role):** enquiries processed, internal vs vendor sourcing ratio, vendor participation rate, RFQ response rate, average response time, average mobilisation distance, average transport cost. Filters: date range, region, crane category, business vertical.

### 12.2 Alerts (BPD 7.3)

| Trigger | Recipient |
|---|---|
| RFQ awaiting vendor response beyond SLA | Sales |
| Quotation nearing expiry | Sales |
| Line item with no vendor responses | Sales |
| Crane approaching booking start without confirmation | Sales, Admin |
| Vendor fleet data not updated for an extended period | Admin, Vendor |
| Unmatched quotation response in validation queue (P6) | Admin |
| New vendor onboarding request | Admin |
| Email delivery failures | Admin |

SLA values are configuration (open item 11). Alerts show on dashboards with a link to the record and also go by email where useful.

### 12.3 Admin Configuration (BPD 6.22)

Manage: per-km cost assumptions, recommendation parameters, RFQ templates and term defaults, communication templates, region mapping, business verticals, the vendor office-use master lists, status masters, reason codes, user roles, exception rules, alert SLAs, stale-data thresholds, retention periods.

### 12.4 Reports and analytics (BPD 5.15, 6.23)

| Metric | Definition (assumed) |
|---|---|
| Enquiries and line items processed | Count in period |
| Internal vs vendor fulfilment ratio | Fulfilled internally ÷ fulfilled by vendors |
| RFQ turnaround time | RFQ sent to quotations received (first and last) |
| Vendor response rate | Recipients who quoted or declined ÷ recipients |
| Quotation conversion rate | Awarded ÷ submitted |
| Average mobilisation distance and transport cost | Of selected cranes |
| Top vendors by participation | Quotes submitted per vendor |
| Vendor win rate | Awarded ÷ submitted per vendor |

Views at enquiry, line-item, vendor, region and crane-category level. Filters: date range, region, crane category, business vertical. Export to Excel or CSV. Customer names and budgets appear only in internal reports.

### 12.5 SSO and the Management Viewer role

Add single sign-on for internal users (open item 8). Management Viewer is read-only on dashboards and reports.

**Done when:** each role lands on a dashboard with the right counters, alerts fire and link to records, an admin can change configuration without a deploy, reports match hand-checked numbers, and SSO works.

## 13. Phase P6: WhatsApp, reply parsing, validation queue

Start only when the owner decides to add WhatsApp (open item 9).

- **Dispatch:** the RFQ channel choice (WhatsApp, email, or both) becomes active. Simultaneous dispatch to all shortlisted vendors. WhatsApp business messages need pre-approved templates and a provider.
- **Response capture:** vendors can reply via portal, email or WhatsApp. Parse replies where possible and map them to the line item and RFQ using the RFQ reference. The quotation records its **source of response** (portal, email, WhatsApp, manual).
- **Assisted validation queue:** replies that cannot be matched with confidence go to an admin queue before becoming quotation records. Fields captured: rental rate, mobilisation, demobilisation, availability, crane reference, validity date, remarks, attachments.
- **Alerts:** unmatched responses alert admins.
- Every message lands in Communication History.

**Done when:** an RFQ can go out by WhatsApp and email together, a reply by either channel becomes a quotation or lands in the validation queue, and the quotation shows how it was captured.

## 14. Phase P7: Rollout and operations

- **Environments:** separate test and production, with UAT by the CR team.
- **Data migration:** the CR team's vendor lists sit in personal sheets (BPD 3.2). Provide an admin-assisted way to load them. Reconsider the deferred **bulk Excel upload** here. Past enquiries in the Sales Partner template format can be loaded the same way if wanted.
- **Pilot:** a small group of trusted vendors, then widen.
- **Training and support:** vendor user guide, CR team guide, support contact, launch email.
- **Operations:** backups, monitoring, error logging, uptime alerts, security review, dependency updates.
- **Data protection:** PAN, bank and contact data. Retention and notices need legal review (open item 10). Bank details encrypted, masked and admin-only. Sign-off on the declaration checkbox (portal open item 4).
- **Domain and email:** production domain, certificate, SPF, DKIM and DMARC.
- **File storage:** a decided location for uploads (load charts, vendor documents, RFQ attachments) with access control and virus scanning.
- **Future SAP feed:** if wanted later, scope it as a separate project through the `create_enquiry` adapter point.

## 15. Working rules for the agent

1. Read `Vendor_Portal_Implementation.md` first. Extend its entities and services rather than creating parallel ones, especially `award_quotation`, Reservation, and the RFQ and Quotation models.
2. Resolve section 5 open items with the owner, or follow the working assumption and say so.
3. Build phase by phase. Report against each "Done when" line.
4. **The geocoding provider is on hold.** Use the interface and stub. Flag that P2 cannot ship real values without a decision.
5. Do not build SAP integration, and do not choose the tech stack or hosting. Build against interfaces.
6. Keep SML and vendor recommendation sets separate everywhere, and always snapshot recommendations.
7. **Never expose other vendors' data, the end customer's name or address, the rental budget, or the Sales Partner's name to vendors.** Enforce on the server and test it.
8. Use dummy data in tests. Keep secrets in configuration. Never log bank details or PAN.
9. Do not build vendor performance analysis, and do not build inspection or GO / NO-GO.
10. Write tests for the status trail and roll-up, enquiry-to-RFQ field copying (excluded internal fields), reservation overlap across SML and vendor cranes, award with quantity above 1, recommendation ranking and segregation, capacity rule and boom warnings, and access control.