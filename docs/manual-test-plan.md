# Manual test plan

Manual walkthrough of crossrentel, mapped to
the BPD (Cross Rental_Platform_BPD.docx, sections 2, 4, 5 and 6) and checked
against what is actually built in this repo: phases **P0–P4** (vendor portal from
the base build, native enquiry intake, recommendation engine, booking calendar,
quote comparison and selection, discovery and history viewers).

Use it as a checklist. Each item names the screen, how to reach it, and the
result to confirm. `[ ]` = not yet tried, `[x]` = passed.

---

## 0. Environment

| Item | Value |
|---|---|
| Frontend (dev) | `http://localhost:5173` (Vite; proxies `/api` to the backend) |
| Backend | `http://localhost:4000` |
| Seed data | `npm run seed` in `backend/` (idempotent) |
| OTP / email reading | `MAIL_TRANSPORT=console` — every email prints as an `[email:console]` block in the **backend terminal** |

### Test accounts

| Role | Login screen | Credentials | Notes |
|---|---|---|---|
| Admin (`admin_user`) | `/auth/otp` | `admin@sanghvimovers.com` | Code printed in the backend terminal |
| Sales / CR (`sales_user`) | `/auth/otp` | `sales@sanghvimovers.com` | Code printed in the backend terminal |
| Vendor 1 | `/auth/login` | `vendor1@example.com` / `Vendor@Portal2026` | M K Hiring (demo) |
| Vendor 2 | `/auth/login` | `vendor2@example.com` / `Vendor@Portal2026` | VJ Cranes (demo) |
| Vendor 3 | `/auth/login` | `vendor3@example.com` / `Vendor@Portal2026` | Sanghvi Heavy Lift (demo) |
| Vendor 4 | `/auth/login` | `vendor4@example.com` / `Vendor@Portal2026` | Southline Crane Services (demo) |
| Vendor 5 | `/auth/login` | `vendor5@example.com` / `Vendor@Portal2026` | Eastern Lifters (demo) |

Internal users are **OTP-only**; vendors are **password-only**. Requesting an OTP
for a vendor address deliberately does nothing.

### Seeded dummy data

- 5 approved vendors with 67 cranes across 42 cities — enough to exercise the
  discovery map: seven dense city clusters, a long tail of single cranes, 64
  cranes with a stored coordinate and 2 active ones without (so the
  "location unverified" group is populated).
- Statuses are mixed (available, engaged with a future `availableFrom`, under
  maintenance with an `expectedReadyDate`), and five cranes are 33–95 days past
  their last update so the stale badge and stale reminder have data.
- No enquiries — create them during the walkthrough.

---

## 1. What is built vs parked (BPD coverage)

| BPD area | Ref | Status |
|---|---|---|
| Vendor repository, onboarding & approval | 5.3, 6.20 | Built |
| Fleet management (vendor + on-behalf) | 6.19, D1 | Built |
| Enquiry intake, detail, line detail | 4.1–4.2, 6.3–6.5 | Built (manual capture; no SAP feed) |
| Recommendation engine, SML/vendor segregation, snapshot | 4.5, 5.4, 6.6–6.7 | Built |
| Mobilisation cost estimate | 5.5 | Built (fabricated rate table; Google or stub geocoding by config) |
| RFQ generation, dispatch, tracking | 4.7, 5.6, 6.12–6.13 | Built (email only) |
| Quotation capture (portal) | 4.8, 6.14 | Built |
| Quote comparison, marks, final selection / booking | 4.9–4.10, 6.15–6.16 | Built |
| Booking calendar & reservations | 5.12, 6.17 | Built |
| Discovery search | 5.9, 6.8 | Built |
| Vendor detail, crane detail | 6.10–6.11 | Built |
| Communication history, audit trail | 5.14, 6.21 | Built |
| Role-based access | 5.13 | Built |
| Admin configuration, user management | 6.22 | Built (partial) |
| SAP integration | 4.1, 5.1–5.2 | **Parked** — manual intake only |
| WhatsApp, reply parsing, validation queue | 4.8, 5.7, P6 | **Not built** |
| Heat maps | 5.10, 6.9 | Built — Google Maps heat overlay (canvas PNG on a `GroundOverlay`), toggle on discovery |
| Reports/analytics, management dashboard | 5.15, 6.2, 6.23 | Built |
| SSO (Microsoft Entra) | 6.1, P5 | Built — needs tenant credentials to verify; OTP remains the fallback |
| Inspection / GO-NO-GO, vendor performance analysis | — | **Out of scope** |

---

## 2. Shared: login and routing (BPD 6.1)

- [ ] Open `/auth/login`. Confirm it is the password entry point for vendors.
- [ ] Open `/auth/otp`. Enter `sales@sanghvimovers.com`, request a code. Confirm
      the message "If that email address belongs to an SML user account, a
      sign-in code has been sent."
- [ ] Read the code in the backend terminal and sign in. Expect to land on
      `/app/rfqs`.
- [ ] Enter a wrong code. Expect "That code is not valid. Please request a new
      one." (and, after several tries, a temporary lock).
- [ ] Repeat OTP login for `admin@sanghvimovers.com`. Expect to land on
      `/app/approvals`.
- [ ] Vendor: sign in with `vendor1@example.com`. Expect to land on
      `/app/dashboard`.
- [ ] Confirm the nav differs by role. Internal nav is grouped: **Overview**
      (Dashboard), **Sourcing** (Enquiries, Discovery, RFQs, Quotations),
      **Operations** (Booking calendar), **Network** (Vendor onboarding),
      **Insights** (Reports, Admin, Reply queue, Settings). Vendors see
      Dashboard, RFQs, My fleet.
- [ ] Below `lg` width, confirm the sidebar collapses to a hamburger that opens
      a drawer; Escape and following a link close it.
- [ ] Sign out; confirm redirect to `/auth/login`.

Vendor password lifecycle (not the OTP path):

- [ ] `/auth/reset-password`: request a reset; confirm the reset link prints in
      the backend terminal and completes.
- [ ] Try a bad password on `/auth/login`; confirm a clear error.

---

## 3. Sales / CR team — end-to-end sourcing

### 3.1 Enquiry list (BPD 6.3)

- [ ] `/app/enquiries`. Confirm the heading and the "New enquiry" affordance.
- [ ] Create one if the list is empty (see 3.2).

### 3.2 Enquiry intake (BPD 4.1–4.2, 6.3–6.4)

- [ ] `/app/enquiries/new`. Enter customer name, site location and site state
      (these are internal-only fields), save.
- [ ] Confirm the enquiry appears in the list and the detail screen opens.
- [ ] Confirm the detail header shows enquiry number, customer name, site
      location and the roll-up status badge.

### 3.3 Enquiry line items (BPD 6.4–6.5)

- [ ] On the enquiry detail, add a line: crane type (e.g. Crawler), capacity
      (e.g. 100) and rule (at least / exact), quantity, start date (or start
      TBC), duration.
- [ ] Add a second line with a different requirement to exercise multi-line.
- [ ] Confirm the detail shows per-line status, the rolled-up counts, and the
      "Sourcing history" and "Communication history" buttons.
- [ ] Test "Edit" on the enquiry and on a line; test cancelling a line with a
      reason.

### 3.4 Line detail (BPD 6.5, 4.3–4.6)

- [ ] Open a line's editor from the enquiry detail (`Edit line`) and confirm
      every template field, including the internal-only budget and PO/SAP
      reference, loads and saves.
- [ ] Confirm the line card links into **Compare quotes** for that line.
- [ ] The recommendation engine (P2) is API-only now: `GET
      /api/enquiries/lines/:lineId/recommendations` returns the two separate
      sets (SML empty, vendors ranked), and `POST …/recommendations/refresh`
      writes a new snapshot while older snapshots remain. Its output is surfaced
      as the recommendation rank badge on the comparison screen.
- [ ] With `GEO_PROVIDER=google`, distances are **road** kilometres and the
      snapshot records `provider: "google"`. The job site is geocoded once and
      stored on the enquiry (`siteCoordinateSource = auto`); a refresh reuses
      that pin instead of calling Google again.
- [ ] A line with a site nobody has used yet takes a few seconds on first
      evaluation (one route per candidate); a refresh is fast because the
      distance cache answers. If every distance disappears, check the backend log
      for the provider and the Google error text before suspecting the engine.

### 3.5 Raise an RFQ (BPD 6.12–6.13, 4.7)

Every RFQ is raised against one enquiry line item. There is no free-form
enquiry/line entry any more: the line is the input, and the enquiry/line
reference is derived from it on the server.

- [ ] From an enquiry line card, click "Raise RFQ", set the submission deadline
      and confirm. Alternatively open `/app/rfqs` → "Raise RFQ" and pick the line
      from the picker (the picker only lists lines with a crane type and
      capacity that are still open for sourcing).
- [ ] Confirm navigation to `/app/rfqs/$rfqId` and the recipient list.
- [ ] Confirm the RFQ detail header shows `Enquiry {enquiryNo}/{lineNo}` and its
      "Open line item" link opens that line's editor.
- [ ] In "Choose vendors to send to", toggle **Technical** and **Distance
      based**. Technical matches the RFQ's crane type and capacity (at least, or
      exactly when the RFQ says so); Distance based keeps the type but drops the
      tonnage filter, listing the nearest cranes of that type at any capacity and
      flagging any that are below the required tonnage. Selections survive the
      switch.
- [ ] Edit the draft: the "Raised against" panel shows the enquiry and line
      numbers read-only, with no way to retype them.
- [ ] Confirm an `rfq_invitation` email block appears in the backend terminal.
- [ ] On the RFQ detail, edit the deadline ("Extend deadline"); confirm the
      `rfq_deadline_changed` email in the terminal.
- [ ] Cancel an RFQ; confirm the cancelled banner and vendor notification.
- [ ] `/app/rfqs` tracking list: confirm RFQ number, linked enquiry/line, status
      and delivery state. Try `?delivery=FAILED` to filter failures.
- [ ] API check: `POST /api/rfqs` with an `enquiryLineId` whose `enquiryNo`/
      `lineNo` disagree with the body still stores the line's own values, and a
      cancelled line is refused.

### 3.6 Communication history (BPD 6.21)

- [ ] From the RFQ header (or enquiry header) click "Communication history".
- [ ] Confirm the list is in order, shows template label, direction, business
      event badge, recipient, channel and status.
- [ ] Confirm the banner "Only outbound messages are recorded today. Inbound
      vendor replies are not captured until the messaging work in P6."

### 3.7 Quote comparison and marks (BPD 6.15, 4.9)

Prerequisite: at least one vendor quotation exists (do §4.4 first), then return.

- [ ] On the line, click "Compare quotes" → the comparison screen.
- [ ] Confirm the columns: vendor/crane, rental (rate + tax basis), mob/demob,
      total, distance, age/availability, validity, response, state, actions.
- [ ] Confirm the **Internal reference** block shows the rental budget and the
      ranking rule ("Total estimated cost … lowest first").
- [ ] Mark a quotation Under Review / Shortlisted / Rejected with a reason code
      and note; confirm the status and note show on the row and that the vendor
      still sees it as Submitted.
- [ ] Confirm the comparison is internal-only (do not expose it to a vendor).

### 3.8 Final selection and booking (BPD 6.16, 4.10)

- [ ] In the comparison, click "Select" on a quotation; enter reason code,
      remarks, and reservation dates if the line's start was TBC; confirm.
- [ ] Confirm: the crane is reserved for the full window, the vendor receives an
      award email (terminal), and — once the line quantity is met — the other
      quotations are marked Not Awarded. A partial award must leave the rest open.
- [ ] Confirm the line status moves to Vendor Finalised / Booked and the enquiry
      roll-up updates.
- [ ] Confirm the "Fully awarded" badge appears when the quantity is met.

### 3.9 Booking calendar (BPD 5.12, 6.17)

- [ ] `/app/bookings`. It opens on the current month as a **month grid**
      (Monday first), with `‹ month ›` and **Today** above it.
- [ ] Confirm the legend: Free, Reserved, Hired, Blocked, Under maintenance.
- [ ] Confirm the grid draws whole weeks: days from the previous and next month
      appear muted at the edges, and the current day carries a filled circle.
- [ ] Confirm a day cell lists the cranes that are **not** free as coloured
      chips joined to the serial (max two, then `+N more`) and shows the count of
      busy cranes. A free day stays quiet.
- [ ] Click a day. The detail opens directly **under that week's row** — the
      date, busy/free/total counters, and every busy crane grouped by state
      (Hired, Reserved, Blocked, Under maintenance) with capacity and vendor.
      Clicking another day moves the panel to that week.
- [ ] Switch to **Timeline**: one compact row per crane over the same month,
      only non-free days marked, weekends tinted. Switching back must show the
      same states.
- [ ] Confirm the summary strip above the grid (utilisation, hired, reserved,
      blocked, maintenance crane-days) moves when you change month or filters.
- [ ] Move to the previous and next month. The seeded demo bookings straddle
      today, so each of last, this and next month has hired, reserved and
      blocked days. Confirm a booking that started reads **Hired** and one that
      starts later reads **Reserved**.
- [ ] Filter by ownership and crane type. The grid and the timeline both narrow,
      and the day counts follow.
- [ ] Confirm the awarded crane shows Reserved across the booking window.

### 3.10 Manual vendor discovery (BPD 6.8, 5.9)

- [ ] `/app/discovery`. Exercise each filter: crane type, capacity + rule,
      location (free text), crane state, vendor name, vendor region, company
      size, fleet size (min), YOM from/to, ownership, availability.
- [ ] Confirm results in **grouped** view (vendor header + nearest distance) and
      **flat** view (ranked table).
- [ ] Enter a job site as text (`Vadodara, Gujarat`, pincode `390001`) and search.
      The address is geocoded server-side; the note should say the list is sorted
      by **road** distance and each crane should show a road figure. With a primer
      such as `Mundra, Gujarat` the nearest rows should be the Mundra cranes.
- [ ] Switch to **Map and heat map**. Expect Google tiles, a red job-site pin, a
      marker per crane (clustered with a count at national zoom), and heat blobs
      whose colour follows density. Toggle **Heat map** off and on.
- [ ] If `VITE_GOOGLE_MAPS_BROWSER_KEY` is empty, the map falls back to the
      coordinate plot and says why — confirm that message rather than a blank box.
- [ ] Confirm "Location unverified" cranes are listed separately and cannot be
      distance-sorted.
- [ ] From a row, open Crane detail and Vendor detail.

#### Map and heat walkthrough (Google Maps)

Run this after `npm run seed` with `GEO_PROVIDER=google` on the backend and a
browser key in `frontend/.env`. The seeded fleet is built for it; the counts
below are the expected answers, not illustrations.

| Step | Expected |
| --- | --- |
| `select count(*) total, count("latitude") mapped, count(*) filter (where "latitude" is null) unverified from cranes where "isActive";` | `66 / 64 / 2` |
| Open **Map and heat map**, no filters | 64 markers, clustered at national zoom; header says 64 of 66 have coordinates |
| Zoom into Gujarat | Ahmedabad, Vadodara and Mundra clusters split into single pins |
| Toggle **Heat map** off then on | Blobs disappear and return; the viewport does not jump |
| Site `Vadodara, Gujarat` + `390001` | note: "sorted by road distance"; nearest Vadodara **3.47 km**, then Ahmedabad ~110 km, Surat ~154 km |
| Site `Mundra, Gujarat` + `370421` | nearest Mundra **2.15 km**; the ranking changes, not just the note |
| Repeat either search | near-instant (was 14 s cold); `distance_cache` row count unchanged |
| Bad site `zzzz nowhere` | "Job site not found", list unsorted, no error page |
| Filters `LARGE` + capacity ≥ 600 t + Available | 16 cranes across 3 vendors, markers and heat follow |
| Unverified group | `DEMO-SL-0111`, `DEMO-EL-0113`; no distance, absent from the map |
| Stale badge | 5 cranes at 33, 65, 75, 80 and 95 days |
| Empty `VITE_GOOGLE_MAPS_BROWSER_KEY`, restart | coordinate plot plus "not configured" message |

The first search at a job site nobody has used yet takes ~7 s (64 real Routes
calls, 4 in flight); every repeat is cached for 30 days. If no crane gets a
distance, check `GEO_PROVIDER` and the backend log line `geo provider: google`
before suspecting the map.

### 3.11 Vendor detail (BPD 6.10)

- [ ] `/app/vendors/$vendorId`. Confirm sections: Company, Registration,
      Contacts (Primary / Receives RFQs), Participation, Fleet, Bank details,
      Communication preferences, Documents, Declaration, History.
- [ ] Confirm **Participation** shows RFQs received, quotations submitted,
      invitations/quoted/awarded, responsiveness % and win ratio %.
- [ ] **As sales**, confirm the Bank details section is absent.
- [ ] Use Fleet "Detail" / "Edit" / "Add crane" links.

### 3.12 Crane detail (BPD 6.11)

- [ ] `/app/cranes/$craneId`. Confirm sections: Identity and specification,
      Location and availability (incl. Next available), Transport cost
      assumption, Reservations, Booking calendar (next 90 days).
- [ ] Confirm flags (stale / no coordinates / under maintenance) appear when
      applicable.
- [ ] Confirm back-links (Discovery, Vendor) work.

### 3.13 Audit trail (BPD 5.14)

- [ ] Enquiry detail → "Sourcing history".
- [ ] Confirm chronological entries across enquiry / line / RFQ / quotation with
      actor, role, timestamp and field diffs; on-behalf actions are flagged.

---

## 4. Vendor portal

### 4.1 Vendor dashboard (BPD 6.18)

- [ ] `/app/dashboard` as `vendor1@example.com`. Confirm counters: Active cranes,
      Need a status update, Booked / hired, Open RFQs, Awaiting my quote,
      Quotations submitted.
- [ ] Confirm sections "Awaiting my response", "Cranes needing a status update"
      and "Booked and hired cranes" link into the owning screens.

### 4.2 Fleet management (BPD 6.19)

- [ ] `/app/fleet`. Add a crane; confirm mandatory-field and duplicate validations.
- [ ] Edit a crane. When status is Engaged, confirm available-from is required.
      When Under maintenance, confirm a ready date is required.
- [ ] Deactivate and reactivate a crane.
- [ ] Upload a load chart; download it back.
- [ ] "Confirm still accurate" and "Duplicate" behave as expected; the freshness
      badge updates after a confirm.

**Bulk upload (sales/admin, `.xlsx`)**

- [ ] Open a vendor at `/app/vendors/:vendorId` and use Fleet → "Bulk upload".
      Download the template; it has `Cranes`, `Lists` and `Instructions` sheets
      and dropdowns for crane type, state and status.
- [ ] Add two valid rows, choose the file, and confirm "Check file" lists both as
      Ready without changing the fleet. Then import; both cranes appear and the
      vendor receives one summary email (not one per crane).
- [ ] Imported cranes are visible in the vendor's fleet and in the normal edit
      form; their rules are the single-crane rules.
- [ ] Paste a Google Maps link with coordinates into the Maps column; confirm the
      saved crane is pinned there. Leave the Maps cell empty and confirm the
      pincode locates the crane. Paste a non-Maps URL and confirm a warning plus
      pincode fallback.
- [ ] Re-upload a serial already on the fleet and a serial repeated in the same
      file: both are skipped and named in the report, and no existing crane is
      changed.
- [ ] Make one row invalid (no pincode, capacity 0, unknown crane type) and
      confirm the other rows still import while the report names the Excel row and
      column.
- [ ] Upload a file with a missing mandatory header, a non-`.xlsx` file, and a
      sheet with 251 rows: each is refused with a usable message and nothing is
      written.
- [ ] As a vendor user, confirm `/app/vendors/:id` is not reachable and
      `GET /api/cranes/bulk/template` answers 403.

**Bulk load charts (sales/admin)**

- [ ] Fleet → "Attach charts". Drop a batch of PDF/JPG/PNG files named after
      crane serials; confirm each is matched to the right crane and nothing is
      uploaded before the button is pressed.
- [ ] Confirm `SERIAL.pdf`, `SERIAL-chart.pdf`, `SERIAL (1).pdf` and
      `serial with spaces.pdf` all match by serial, while a name containing a
      longer serial is not wrongly claimed as a prefix.
- [ ] Add an unmatched file and an ambiguous file: both are left out until a
      crane is chosen. Add a `.txt` file and a file over 10 MB: both are refused
      before any request.
- [ ] Select two files for the same crane and upload; the second is skipped
      with "one chart per crane" rather than replacing the first.
- [ ] Attach a chart to a crane that already has one: the row starts deselected;
      tick it to opt in (it then shows "Will replace"), and after upload it
      reports "Replaced".
- [ ] One failing upload (for example a malformed PDF) reports that row as
      failed while the rest attach; the fleet then shows each crane's chart, and
      the audit trail records `crane_load_chart_uploaded` per crane.
- [ ] Confirm a vendor user cannot reach the screen or the chart endpoints for
      another vendor's crane.

### 4.3 RFQ inbox and quotation (BPD 6.14, 4.8)

- [ ] `/app/rfqs` then open an RFQ. Confirm the requirement, site, duration and
      deadline are shown without any customer, budget or other-vendor data.
- [ ] Submit a quotation: rental rate, mob/demob, validity, availability, remarks.
      Confirm the `quotation_receipt` / `quotation_received` email in the terminal.
- [ ] Revise then withdraw the quotation; confirm the history panel.
- [ ] On another RFQ, decline with a reason; confirm the declined state.
- [ ] Confirm a submitted quotation cannot be resubmitted for the same RFQ unless
      the flow allows a fresh version.

### 4.4 Profile and data isolation

- [ ] `/app/profile`: own details render; own bank details are masked.
- [ ] Confirm a vendor never sees another vendor, the customer name/address, the
      rental budget, or an internal user's name.

---

## 5. Admin

### 5.1 Invite and register a vendor (BPD 6.20)

- [ ] `/app/approvals` → "Invite a vendor to register": enter an email and send.
      Confirm the invite email in the terminal and the copy-able link.
- [ ] Open the link (`/onboarding/start?token=…`) in a private window; complete
      the form including the required documents; submit.

### 5.2 Approve / reject and access (BPD 7.3)

- [ ] Open the submitted vendor from the queue. Confirm Approve is blocked until
      all required documents are present.
- [ ] Approve with an SAP vendor code and office-use fields; confirm the
      activation email and History entry.
- [ ] Reject another with remarks; confirm the vendor can resubmit through the
      original link.
- [ ] Suspend an approved vendor (reason recorded), then reinstate.

### 5.3 SAP creation sheet (BPD D3, admin only)

- [ ] `/app/vendors/$vendorId/sap-sheet` prints/exports and reflects the approved
      data.

### 5.4 Admin dashboard and user management (BPD 6.2, 5.13)

- [ ] `/app/admin`: confirm the Attention counters (registrations awaiting
      approval, RFQs with email delivery failures, cranes stale, cranes with no
      map location, engaged cranes past release date).
- [ ] Under "SML users", create an internal user, change a role, and deactivate
      one. Confirm you cannot deactivate your own account.

### 5.5 Configuration (BPD 6.22)

- [ ] `/app/settings`: quotation day basis; SAP office-use master lists; quote
      and award reason codes; business verticals.
- [ ] Change a reason-code list, then confirm the new value appears in the
      comparison screen's mark / award dropdowns.

### 5.6 Admin oversight

- [ ] Re-run §3.10–3.13 as admin; confirm access to every vendor, bank details
      (admin only), and all enquiries.

---

## 6. End-to-end scenario (single sitting)

- [ ] Sales: create an enquiry with a line (Crawler, ≥ 100t).
- [ ] Sales: open the line; confirm vendor recommendations are ranked.
- [ ] Sales: raise an RFQ to both demo vendors.
- [ ] Terminal: confirm both `rfq_invitation` email blocks.
- [ ] Vendor 1: submit a quotation. Vendor 2: decline.
- [ ] Sales: Compare quotes → mark Vendor 1 Shortlisted → Select with a reason.
- [ ] Verify: reservation on `/app/bookings`, line Vendor Finalised, award email
      in terminal, the other quotation Not Awarded, enquiry roll-up updated.
- [ ] Sales: open Communication history and Sourcing history for the full trail.
- [ ] Admin: confirm the vendor's Participation counters advanced
      (invitations / quoted / awarded, responsiveness, win %).

---

## 7. Cross-cutting checks

Run as each role; a hidden control is not a check — the server must refuse too.

- [ ] **Vendor isolation**: sign in as a vendor and open an internal URL
      (`/app/enquiries`, `/app/discovery`, `/app/enquiries/$id/history`). Expect a
      redirect / forbidden notice.
- [ ] **Bank visibility**: sales sees no bank block; admin sees it; vendor sees
      only its own, masked.
- [ ] **Route guards**: as sales, open `/app/settings`, `/app/admin` and an SAP
      sheet URL; expect them to be blocked.
- [ ] **Server enforcement**: with a vendor bearer token, `GET
      /api/discovery/cranes` and `GET /api/enquiries/:id/history` return 403.
- [ ] **No secret leakage**: confirm the backend log never prints PAN or bank
      numbers (only last-4 where applicable).

---

## 8. Not testable yet (do not chase)

- SAP enquiry feed and SML fleet sync (parked — intake is manual).
- WhatsApp dispatch and inbound reply parsing / assisted validation queue (P6).
- Heat-map overlays (skipped).
- Reports and analytics, management dashboard, SSO (P5).
- Inspection / GO-NO-GO and vendor performance analysis (out of scope).
