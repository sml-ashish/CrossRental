# P0: Portal gap check and admin basics

Read `00-overview.md` first.

The portal is built. Before P1, verify it against the items below. For each one report **Present / Missing / Different**, then fix what is missing. Do not rebuild what exists.

## A. Gap check against the revised portal design
1. **Reservation** table exists with crane, start and end date, type (Booked, Blocked), source RFQ and quotation, status (Active, Released, Completed), release reason, and **overlap protection inside a transaction**. There is no stored "Booked" or "Hired" crane status; those are derived badges.
2. `award_quotation`: quantity-aware. Others become Not Awarded only when awarded count reaches RFQ quantity (then RFQ Closed). Skips Withdrawn quotes and older versions. Rechecks crane and reservation overlap. Creates a Reservation for the RFQ dates (dates required if start TBC). Warns and blocks on competing RFQs for the same crane.
3. Quotation has `tax_basis` and `demobilisation_charges`; total = rental + mobilisation + demobilisation.
4. RFQ has: capacity_rule, capacity_note, application_description, load_description, structured required boom and jib lengths (numbers), start_date_tbc, working_days_per_month, mobilisation and demobilisation terms, support crane, steel mats and ground prep, EHS/HR, insurance and extension-clause terms. **RFQ must not hold customer name, address or budget.**
5. RFQ.status is lifecycle only (Draft, Sent, Closed, Cancelled). `response_state` is derived (No Quotes Yet, Quotes Received).
6. Warnings include: capacity fails the capacity rule, boom or jib shorter than required.
7. Vendor contacts have `receives_rfqs`; RFQ emails go to those contacts. Vendor has `communication_preferences`.
8. Onboarding: GSTN and GST certificate conditional on "GST registered"; MSME and TDS conditional fields; PAN 4th letter matches company type; GSTN chars 3 to 12 equal PAN; mobile 10 digits no leading zero; one valid email; unique PAN and GSTN; SAP vendor creation sheet on the approval screen.
9. VendorInvitation (single use, 7-day expiry, resend).
10. Admin and sales can edit a vendor's cranes on their behalf, with the audit mark and vendor notice.
11. Reminder timing: smaller of 24 hours and half the response window; none if the window is under the minimum. Extending a deadline returns Expired, never-responded recipients to Pending and emails them.
12. Crane has `expected_ready_date`; lapsed `available_from` is flagged; inline "add crane" in the quote form.

## B. Admin basics
1. **Admin dashboard (minimal):** onboarding requests awaiting approval, RFQs with email delivery failures, cranes stale at 60 days, cranes "location unverified", cranes with a lapsed `available_from`. Counters link to filtered lists.
2. **User management:** admins create and disable internal users, assign roles, trigger credential reset, suspend or reinstate a vendor (suspended vendors cannot log in or receive RFQs). All audited.

## Done when
A written Present / Missing / Different list for section A is delivered, all Missing items are fixed, an admin sees the dashboard counters, can create and disable a sales user, and can suspend a vendor.
