# P3: Quote comparison and final selection

Read `00-overview.md` and `open-items.md` (item 5) first.

## 1. Quote Comparison (BPD 6.15)
Opens from the line workspace. Columns: vendor, crane, rental rate and basis, tax basis, mobilisation, demobilisation, total estimated cost, distance, crane age, availability confirmation, validity, response time, remarks, recommendation rank, warnings.
- Mark each quotation Under Review, Shortlisted, Rejected or Selected with a **reason code** (master list).
- Default rank by total estimated cost ascending (configurable).
- Line moves to Under Evaluation when the first quotation is marked.
- Only the latest non-withdrawn version of each quotation is comparable. Older versions are viewable in history.
- Show the internal rental budget beside totals to internal users only.

## 2. Final Selection and Booking Confirmation (BPD 6.16)
Shows chosen crane, vendor, final rate, mobilisation, demobilisation, start and end dates, duration, remarks. On confirm:
- Line becomes Vendor Finalised, then Booked once the Reservation exists. Roll-up recalculated.
- Reservation created for the full duration.
- Non-selected quotations become Not Awarded **only when the RFQ quantity is fully awarded**.
- Notify users and vendors.
- **Call the existing `award_quotation`. Extend it; do not write a second path.** For quantity above 1, the user awards several quotations in turn. The admin-only award action stays as an override.
- If the start date is TBC, require dates before confirming.

## 3. PO reference (manual)
After SCM raises the PO outside the platform, the CR user records "PO / SAP reference" (text) on the line. No sync status, no integration. Internal only.

## Done when
A CR user compares quotes, marks them with reason codes, selects one (or several for quantity above 1) and confirms. Remaining quotes become Not Awarded once the quantity is met, the crane is reserved for the contract dates, vendors are emailed, a PO reference can be recorded, and the full trail is auditable.
