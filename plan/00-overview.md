# Platform overview (read first)

Goal (BPD section 1): the CR team (Cross Rental team) enters an enquiry, the platform checks SML's own fleet and registered vendors' fleets, ranks matching cranes by distance to the job site, estimates mobilisation cost, and lets the team run RFQs, compare quotes and finalise a vendor.

Enquiries arrive through a Sales Partner. The CR team types them in. A future SAP feed would call the same `create_enquiry(payload, source)` service (source = manual today).

## Already built (do not rebuild)
Vendor, VendorContact (with `receives_rfqs`), VendorDocument, VendorInvitation, Crane, User (`vendor_user`, `admin_user`, `sales_user`), Reservation (dated, overlap-protected), AuditLog, EmailLog, DistanceCache, RFQ, RFQVendorRecipient, Quotation (versioned, tax basis, demobilisation), vendor onboarding and approval with SAP vendor creation sheet, fleet management incl. updates on a vendor's behalf, RFQ inbox, quote submission and history, vendor dashboard, minimal RFQ creation and tracking, distance-sorted candidate picker, `award_quotation`, geocoding provider interface with stub, Microsoft 365 email, OTP login for internal users.

Phase P0 checks the built portal against these items.

## Phases
| Phase | Name | Depends on |
|---|---|---|
| P0 | Portal gap check and admin basics | built portal |
| P1 | Native enquiry intake, enquiry screens, SML fleet | P0 |
| P2 | Recommendation engine, cost, booking calendar | P1, geocoding decision |
| P3 | Quote comparison and final selection | P1, P2 |
| P4 | Discovery, detail screens, history viewers, heat map | P2 |
| P5 | Dashboards, alerts, configuration, reports, SSO | P1 to P3 |
| P6 | WhatsApp, reply parsing, validation queue | P3 |
| P7 | Rollout and operations | all |

## Decisions
| Topic | Decision |
|---|---|
| SAP | Parked. Adapter point only (`create_enquiry`, source = manual). No feed, no write-back |
| "Sales user" | The CR team. Sales Partners have no account |
| Channel | Email only (Microsoft 365). WhatsApp is P6 |
| Geocoding / maps | On hold. Interface and stub only |
| Vendor code | Platform `vendor_id`. SAP vendor code optional, never blocks anything |
| PO reference | Manual text field "PO / SAP reference" on the line item |
| Booking record | The Reservation table is the single record for SML and vendor cranes |
| Customer name, address, rental budget | Internal only, never copied into RFQs |
| Stale data | 30 days due + reminder, 60 days flagged. Not hidden from candidates |
| Inspection / GO-NO-GO | Not in the BPD. Not built |
| Vendor performance analysis | Out of scope. Win ratio and responsiveness from RFQ participation are allowed |

## Roles
| Capability | Sales (CR team) | Vendor | Admin | Mgmt Viewer (P5) |
|---|---|---|---|---|
| Enquiries, sourcing workspace | Own (all with a setting) | No | View all | View all, read-only |
| Create enquiry, RFQ, shortlist, compare, finalise | Yes | No | Yes / award override | No |
| Customer name, address, budget | Yes | Never | Yes | Read-only |
| Own fleet, RFQ inbox, quotes | No | Own only | View all | No |
| Edit vendor fleet on behalf | Yes (audited) | n/a | Yes (audited) | No |
| Discovery, vendor and crane detail | Yes | Own profile | Yes | Read-only |
| Bank details | No | Own, masked | Yes | No |
| Configuration, user management | No | No | Yes | No |
| Reports | Own scope | No | All | All, read-only |

Enforce on the server on every query.

## Working rules
1. Extend existing entities and services; do not duplicate.
2. Keep SML and vendor recommendation sets separate everywhere, and always snapshot recommendations.
3. Dummy data in tests. Secrets in configuration. Never log PAN or bank details.
4. One phase per session. Report against "Done when".
