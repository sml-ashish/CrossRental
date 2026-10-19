# P5: Dashboards, alerts, configuration, reports, SSO

Read `00-overview.md` and `open-items.md` (items 6, 8, 11) first.

## Role dashboards (BPD 6.2)
- **Sales (CR team):** new enquiries, pending sourcing, lines at each stage, closed enquiries. Highlights overdue RFQs, expiring quotations, items needing action. Counters link to filtered lists.
- **Admin:** extends the P0 dashboard with fleet records pending validation (only if fleet approval is on), unmatched quotation messages (P6), system exceptions.
- **Management (new read-only role):** enquiries processed, internal vs vendor sourcing ratio, vendor participation rate, RFQ response rate, average response time, average mobilisation distance, average transport cost. Filters: date range, region, crane category, business vertical.

## Alerts (BPD 7.3)
| Trigger | Recipient |
|---|---|
| RFQ awaiting response beyond SLA | Sales |
| Quotation nearing expiry | Sales |
| Line with no vendor responses | Sales |
| Crane approaching booking start without confirmation | Sales, Admin |
| Vendor fleet data not updated for an extended period | Admin, Vendor |
| Unmatched quotation response (P6) | Admin |
| New vendor onboarding request | Admin |
| Email delivery failures | Admin |

SLA values are configuration. Alerts show on dashboards with a link to the record, and by email where useful.

## Admin Configuration (BPD 6.22)
Per-km cost assumptions, recommendation parameters, RFQ templates and term defaults, communication templates, region mapping, business verticals, vendor office-use master lists, status masters, reason codes, user roles, exception rules, alert SLAs, stale thresholds, retention periods.

## Reports (BPD 5.15, 6.23) (assumed definitions, confirm)
| Metric | Definition |
|---|---|
| Enquiries and lines processed | Count in period |
| Internal vs vendor fulfilment | Fulfilled internally / fulfilled by vendors |
| RFQ turnaround | RFQ sent to quotations received (first and last) |
| Vendor response rate | Recipients who quoted or declined / recipients |
| Quotation conversion | Awarded / submitted |
| Avg mobilisation distance and cost | Of selected cranes |
| Top vendors by participation | Quotes submitted per vendor |
| Vendor win rate | Awarded / submitted per vendor |

Views at enquiry, line, vendor, region and crane-category level. Export to Excel or CSV. Customer names and budgets appear only in internal reports.

## SSO
Add SSO for internal users. Management Viewer is read-only.

## Done when
Each role lands on the right dashboard, alerts fire and link to records, an admin changes configuration without a deploy, reports match hand-checked numbers, and SSO works.
