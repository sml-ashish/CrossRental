# P6: WhatsApp, reply parsing, validation queue

Start only when the owner decides to add WhatsApp (open item 9). Read `00-overview.md` first.

- **Dispatch:** RFQ channel choice (WhatsApp, email, both) becomes active. Simultaneous dispatch to all shortlisted vendors. Needs a provider and pre-approved templates.
- **Response capture:** replies via portal, email or WhatsApp. Parse where possible and map to line and RFQ using the RFQ reference. Quotation records its source (portal, email, WhatsApp, manual).
- **Assisted validation queue:** unmatched replies go to an admin queue before becoming quotations. Fields: rental rate, mobilisation, demobilisation, availability, crane reference, validity date, remarks, attachments.
- **Alerts:** unmatched responses alert admins.
- Every message lands in Communication History.

## Done when
An RFQ goes out by WhatsApp and email together, a reply by either becomes a quotation or lands in the validation queue, and the quotation shows how it was captured.
