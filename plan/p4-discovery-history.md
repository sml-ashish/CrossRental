# P4: Discovery, detail screens, history viewers, heat map

Read `00-overview.md` and `open-items.md` (items 12, 13) first.

- **Manual Vendor Discovery (6.8, 5.9):** standalone search, no enquiry needed. Filters: crane type, capacity, location, vendor name, region, company size, fleet size, YOM, ownership type, availability. Views: list, grouped by vendor, map (needs the provider decision). Open Vendor Detail, Crane Detail, or start sourcing.
- **Vendor Detail (6.10):** profile, contacts (with `receives_rfqs`), regions, company size, fleet size, categories, onboarding status, communication preferences; fleet and availability; RFQs received, quotations submitted, win ratio, responsiveness. Actions: contact, shortlist for a line, generate RFQ, edit fleet on the vendor's behalf. Bank details admin only.
- **Crane Detail (6.11):** SML or vendor crane. Ownership, ID, type, capacity, make, model, YOM, boom and jibs, location, status, booking calendar, maintenance flags, transport cost assumptions, next available date. Back-links to the originating list.
- **Communication History (6.21):** chronological inbound and outbound messages linked to enquiry, line, RFQ and quotation: type, channel, date and time, sender, recipient, delivery status, whether it triggered a business event. Built on `EmailLog`.
- **Audit trail viewer (5.14):** reconstruct the sourcing history of any enquiry.
- **Heat map (5.10, 6.9), optional:** crane density by region or state for internal users. Only after the provider decision and only if wanted. Reuse the portal's fleet-location data.

## Done when
A CR user finds vendors without an enquiry, opens a vendor and sees fleet and participation history, and views the full communication and audit history of any enquiry. If the heat map is approved it renders from stored coordinates.
