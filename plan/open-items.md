# Open items (use the working assumption and say so)

| # | Open item | Working assumption |
|---|---|---|
| 1 | Enquiry template fields (list in p1 derived from the template) | At the start of P1 compare against the template file; the template wins |
| 2 | SML fleet source now SAP is parked | **Resolved in P1 by the owner: SML has no crane fleet — every crane is a vendor crane.** The SML-crane model was dropped entirely. The internal check stays manual ("Checked internally, not available" / "Fulfilled internally"), recorded on the line with no crane record. P1's "matching SML cranes appear first" is therefore superseded: vendor recommendations appear first in the engine output |
| 3 | Vendor-facing customer details (template's vendor sheet shows customer name and address) | Do not show. Vendors see site location only. Confirm |
| 4 | Per-km mobilisation cost values and dimensions | One table by crane category and capacity band, optional ownership column. Owner supplies values |
| 5 | Quote ranking rule | Total estimated cost ascending (rental + mobilisation + demobilisation), configurable |
| 6 | Business vertical source | Admin-maintained master list chosen on the enquiry |
| 7 | Logins per vendor | One primary login. Contacts are records |
| 8 | SSO provider | Likely Microsoft Entra ID. Confirm whether OTP stays as fallback |
| 9 | WhatsApp provider | None. Decide at P6 |
| 10 | Data protection and retention | Legal review. Retention periods as configuration |
| 11 | Alert SLA values | Configurable. Owner supplies defaults |
| 12 | Heat map (BPD 5.10, 6.9) | **Resolved: built.** The discovery map renders crane density on Google Maps from stored coordinates. The `visualization.HeatmapLayer` library was removed in Maps JS v3.65, so the heat layer is a georeferenced `GroundOverlay` built on a canvas |
| 13 | Geocoding fallback (pincode lookup option, see portal brief) | **Resolved: Google Maps.** `GEO_PROVIDER=google` uses the Geocoding API for addresses and the Routes API for road distance, behind the existing `GeoProvider` seam. `stub` stays the dev/test default; `disabled` stays the production default until a key is supplied. Pincode-only lookup is still not built: the address string includes the pincode |
| 14 | Capacity matching ("700 TMC or higher") | Match in tonnes with the line's `capacity_rule` (At least by default). Confirm whether TMC must be captured |
| 15 | Status spelling in the BPD (Finalised / Finalized) | Use the BPD's. Docs use "Finalised" |
