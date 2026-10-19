# P7: Rollout and operations

Read `00-overview.md` and `open-items.md` (item 10) first.

- **Environments:** separate test and production, UAT by the CR team.
- **Data migration:** CR team vendor lists sit in personal sheets (BPD 3.2). Provide an admin-assisted load. Reconsider the deferred bulk Excel upload here. Past enquiries in the Sales Partner template format can be loaded the same way if wanted.
- **Pilot:** a few trusted vendors, then widen.
- **Training and support:** vendor guide, CR team guide, support contact, launch email.
- **Operations:** backups, monitoring, error logging, uptime alerts, security review, dependency updates.
- **Data protection:** PAN, bank and contact data. Retention and notices need legal review. Bank details encrypted, masked, admin only. Legal sign-off on the declaration checkbox.
- **Domain and email:** production domain, certificate, SPF, DKIM, DMARC.
- **File storage:** decided location for uploads with access control and virus scanning.
- **Future SAP feed:** if wanted, scope it as a separate project through `create_enquiry`.
