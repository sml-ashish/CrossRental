# P1: Native enquiry intake, enquiry screens, SML fleet

Read `00-overview.md` and `open-items.md` (items 1, 2, 3, 6, 14) first.

## 1. Intake and the adapter point
- The CR team creates enquiries with the form below. Edits are audited.
- All creation goes through `create_enquiry(payload, source)`; `source = manual` now. Build no integration, protocol or mock.
- `enquiry_no` is system generated and unique (e.g. CR-2026-0001). Store the Sales Partner's or customer's own reference as free text `external_reference`; a duplicate reference warns, never blocks.
- Cancelling or changing a line is a manual, audited action. Changes after an RFQ was sent show a warning; sent RFQ snapshots do not change.

## 2. Data model

**Enquiry (header), internal**
| Field | Rule |
|---|---|
| enquiry_no | System, unique |
| external_reference | Optional text |
| enquiry_date | Mandatory, default today |
| source | `manual` |
| sales_partner_name | Optional text only. No account |
| cr_owner | CR team user |
| customer_name, customer_address | Mandatory. **Internal only** |
| site_location, state, pincode, region | Job site. Geocoded, pin-confirmable |
| business_vertical | From master list |
| cross_rental_flag | Default true |
| overall_status | Rolled up (section 4) |
| notes | Internal |

**EnquiryLineItem** (derived from the Cross Rental Enquiry Template; template wins)
| Group | Fields |
|---|---|
| Requirement | line_no, crane_type, capacity_t, capacity_rule (At least default / Exact), capacity_note, quantity |
| Application and load | application_description, load_description (e.g. "565 MT @ 78 m boom, 12 m radius"), lift_load_t, working_radius_m |
| Configuration | required_main_boom_m, required_fixed_jib_m, required_luffing_jib_m, required_wind_jib_m (numbers), configuration_notes |
| Dates | required_start_date, start_date_tbc, duration_value, duration_unit (days or months), working_days_per_month |
| Mobilisation | mobilisation_terms, demobilisation_terms |
| Terms and scopes | ot_charges, breakdown_terms, diesel_scope, working_hours_shift, accommodation_conveyance, payment_terms, support_crane_scope, steel_mats_ground_prep_scope, ehs_hr_compliance, insurance_terms, extension_clause, crane_age_criteria_years, other_terms |
| **Internal only** | rental_budget (free text such as "35 lakhs or best lowest" plus optional numeric), internal_notes, po_sap_reference (manual, P3) |
| Status | sourcing_status, rfq_status, quote_status, selected_source (SML or vendor), closure_status, trail status |

**RFQ link:** creating an RFQ from a line prefills it and copies **only the vendor-safe subset**: everything except customer_name, customer_address, rental_budget, internal_notes, po_sap_reference and sales_partner_name. It is a snapshot. Enforce the exclusion in code and test it. Add `enquiry_line_id` to RFQ.

**SmlCrane:** equipment_id, crane_type, capacity_t, make, model, yom, main_boom_m and jibs (numbers), current_location, state, coordinates, operational_status, maintenance blocks (start, end, reason), expected_ready_date, load_chart.

**Reservation:** extend the existing table to reference a vendor crane or an SML crane. Add the type `Maintenance` and the source enquiry line.

## 3. Line-item status trail (BPD 6.5)
`New` → `Availability Check` → `Vendor Shortlisted` → `RFQ Sent` → `Awaiting Quotes` → `Quotes Received` → `Under Evaluation` → `Vendor Finalised` → `Booked` → `Closed`, plus `Fulfilled internally` and `Cancelled`.

Status is event driven, never typed in. Every change is audited.
| Status | Trigger |
|---|---|
| New | Line created |
| Availability Check | CR user opens the internal check or records an SML result |
| Vendor Shortlisted | At least one vendor ticked in the picker for this line |
| RFQ Sent | An RFQ for the line is dispatched |
| Awaiting Quotes | RFQ sent, no quotation yet (RFQ `response_state`) |
| Quotes Received | First quotation arrives |
| Under Evaluation | CR user marks the first quotation in comparison |
| Vendor Finalised | Selection confirmed (P3) |
| Booked | Reservation created |
| Closed | Reservation completed, or CR user closes with a reason |
| Fulfilled internally | CR user confirms an SML crane |
| Cancelled | CR user cancels the line with a reason |

## 4. Enquiry roll-up (assumed, confirm)
| Condition across lines | Enquiry status |
|---|---|
| Just entered | Received, Pending Sourcing |
| Some lines have quotes, others pending | Partially Quoted |
| All lines finalised or fulfilled | Fully Finalised |
| Some finalised, some not | Partially Finalised |
| All lines closed or cancelled | Closed |

Show RFQ, quote and finalisation summaries as counts per stage (BPD 6.4).

## 5. Screens
- **Enquiry create and edit:** the form above, line-item table, pre-filled term defaults, pin-confirm map, clear "internal only" marking on customer and budget fields.
- **Enquiry inbox (6.3):** number, date, customer, site, region, line count, owner, overall status, RFQ, quote and finalisation summaries. Filters: date range, region, crane category, customer, status, stage.
- **Enquiry detail (6.4):** header, line table, rolled-up counts, drill into a line. Internal-only fields visible to internal users only.
- **Line detail:** the line editor, with the internal-only block, and the link into quote comparison (P3).
- **SML fleet section (6.6):** shown before vendors. Matches by type and capacity (honouring `capacity_rule`) and basic availability.
- **SML crane list (admin):** add, edit, deactivate.
- **Internal fulfilment:** mark "Fulfilled internally" or "Checked internally, not available".

## Done when
A CR user enters an enquiry with several lines using every template field, including internal-only customer and budget. It appears in the inbox as Received, Pending Sourcing. An RFQ created from a line links to it and carries no customer name, address or budget (tested). Trail and roll-up follow the definitions above.
