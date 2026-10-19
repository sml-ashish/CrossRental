# P2: Recommendation engine, cost, booking calendar

Read `00-overview.md` and `open-items.md` (items 2, 4, 13, 14) first.
**Requires the geocoding provider decision.** Until then run on the stub and flag that real values cannot ship.

## 1. Recommendation engine (BPD 7.1)
Run separately for SML and vendor fleets. **Never merge the two result sets.**
| Step | Action |
|---|---|
| 1 | Match crane type and capacity per `capacity_rule` |
| 2 | Check availability for the contract dates (reservations, maintenance blocks) |
| 3 | Retrieve coordinates |
| 4 | Road distance to the job site (provider interface, DistanceCache) |
| 5 | Estimate mobilisation cost |
| 6 | Rank ascending by distance |
| 7 | Show in separate SML and vendor sections |

- Surface only deployable cranes: Available, or Engaged with `available_from` on or before the start date, and no overlapping reservation or maintenance block. If the start date is TBC, skip the date check and show a notice.
- Warn when a crane's boom or jibs are shorter than the line's required lengths.
- Store a **recommendation snapshot** on the line at evaluation time. A "refresh" action re-runs it and keeps earlier snapshots.
- Vendor section: vendor, crane, capacity, location, distance, estimated mobilisation cost, YOM, availability, region, participation metrics (BPD 6.7). Sort by distance or cost.
- This replaces the simple candidate picker. Reuse its snapshot structure.

## 2. Mobilisation cost (BPD 5.5)
Estimated cost = road distance (km) x per-km rate from the cost table. Show on every row. Seed from a config file until Admin Configuration (P5).

## 3. Booking calendar (BPD 5.12, 6.17)
- The portal's Reservation table already covers vendor cranes. Add SML cranes to it and build the calendar. Reservations are the only booking record. No migration of undated bookings is needed.
- Effective availability = vendor or SML status plus reservations plus maintenance blocks.
- Release a reservation with a reason (keep the portal's action and show it here).
- **Booking Calendar (6.17):** free, reserved, hired, blocked or unavailable over a date range. Filters: ownership type, crane type, vendor, region, location.

## Done when
For a line, SML and vendor sections show separate lists ranked by distance with cost estimates. A crane with an overlapping reservation does not appear. Short boom or jib warnings show. The snapshot is viewable later even after locations change. The calendar shows reservations for SML and vendor cranes, and releasing one makes the crane available again.
