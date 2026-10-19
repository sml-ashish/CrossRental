# AGENTS.md

Project: SML Crane Discovery & Vendor Repository Platform (cross-rental sourcing).
The **vendor portal is already built**. This repo work is the rest of the platform, phase by phase.

## How to work
- Read `plan/00-overview.md` first (about one page). Then read ONLY the phase file you are given (`plan/p0-...` to `plan/p7-...`).
- Do one phase per session. Start with a short plan (files, tables, endpoints), wait for approval, then implement.
- Report against that phase's "Done when" lines. Stop when they pass.
- Open questions are in `plan/open-items.md`. Use the stated working assumption and say so.

## Stack and commands (fill in)
- Stack: <fill in>
- Run: <fill in>
- Test: <fill in>
- Migrate: <fill in>

## Hard rules
- Extend existing entities and services (Vendor, Crane, Reservation, RFQ, Quotation, `award_quotation`). Do not create parallel ones.
- Never show vendors: other vendors' data, the end customer's name or address, the rental budget, or the Sales Partner's name. Enforce on the server and test it.
- SAP integration is parked. Do not build it. Do not build inspection or GO / NO-GO. Do not build vendor performance analysis.
- Geocoding provider is on hold: use the interface and stub only.
- Use dummy data. Keep secrets in configuration. Never log PAN or bank details.
- Do not choose the stack or hosting beyond what is above.
