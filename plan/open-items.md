# Open items (use the working assumption and say so)

| # | Open item | Working assumption |
|---|---|---|
| 1 | Enquiry template fields (list in p1 derived from the template) | At the start of P1 compare against the template file; the template wins |
| 2 | SML fleet source now SAP is parked | **Resolved in P1 by the owner: SML has no crane fleet — every crane is a vendor crane.** The SML-crane model was dropped entirely. The internal check stays manual ("Checked internally, not available" / "Fulfilled internally"), recorded on the line with no crane record. P1's "matching SML cranes appear first in the workspace" is therefore superseded: vendor recommendations appear first |
| 3 | Vendor-facing customer details (template's vendor sheet shows customer name and address) | Do not show. Vendors see site location only. Confirm |
| 4 | Per-km mobilisation cost values and dimensions | One table by crane category and capacity band, optional ownership column. Owner supplies values |
| 5 | Quote ranking rule | Total estimated cost ascending (rental + mobilisation + demobilisation), configurable |
| 6 | Business vertical source | Admin-maintained master list chosen on the enquiry |
| 7 | Logins per vendor | One primary login. Contacts are records |
| 8 | SSO provider | Likely Microsoft Entra ID. Confirm whether OTP stays as fallback |
| 9 | WhatsApp provider | None. Decide at P6 |
| 10 | Data protection and retention | Legal review. Retention periods as configuration |
| 11 | Alert SLA values | Configurable. Owner supplies defaults |
| 12 | Heat map (BPD 5.10, 6.9) | Built in P4 only after the provider decision, if wanted |
| 13 | Geocoding fallback (pincode lookup option, see portal brief) | Owner decides. Not built |
| 14 | Capacity matching ("700 TMC or higher") | Match in tonnes with the line's `capacity_rule` (At least by default). Confirm whether TMC must be captured |
| 15 | Status spelling in the BPD (Finalised / Finalized) | Use the BPD's. Docs use "Finalised" |
