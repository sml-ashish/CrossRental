# SML Crane Discovery & Vendor Repository

Internal portal for Sanghvi Movers Limited: vendor onboarding, crane fleet
management, RFQ distribution, quotations, award and hire tracking.

Two independent npm projects, no workspace tooling:

| Directory   | What it is                                | Dev port |
| ----------- | ----------------------------------------- | -------- |
| `backend/`  | Express 4 + Prisma 7 REST API, PostgreSQL | 4000     |
| `frontend/` | React 19 + Vite 6 SPA, Tailwind CSS 4     | 5173     |

The frontend dev server proxies `/api` to the backend, so the browser only ever
talks to one origin and CORS never enters local development.

## Prerequisites

- Node.js 20+ (developed on 26.x)
- PostgreSQL 14+ with two databases: `crossrental` and `crossrental_test`

## Getting started

```bash
# 1. Backend
cd backend
cp .env.example .env          # then edit DATABASE_URL / secrets
npm install
npx prisma migrate deploy
npm run seed                  # reference data + two demo vendors
npm run dev

# 2. Frontend, in a second terminal
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:5173.

### Is my setup wired up?

```bash
cd backend && npm run doctor
```

Checks Postgres, seed data, both dev servers, the `/api` proxy, and actually
exercises the seeded logins. Read-only — safe to run any time. Run this first if
a sign-in fails; it will tell you which layer is broken.

### Demo accounts

Seeded by `npm run seed`, all values fabricated:

| Email                       | Password            | Role   | Signs in at                    |
| --------------------------- | ------------------- | ------ | ------------------------------ |
| `vendor1@example.com`       | `Vendor@Portal2026` | vendor | `/auth/login`                  |
| `vendor2@example.com`       | `Vendor@Portal2026` | vendor | `/auth/login`                  |
| `admin@sanghvimovers.com`   | none                | admin  | `/auth/otp` (emailed code)     |
| `sales@sanghvimovers.com`   | none                | sales  | `/auth/otp` (emailed code)     |

Internal accounts **have no password**. Entering one at `/auth/login` returns
"Invalid email or password" — deliberately, so the endpoint cannot be used to
discover which addresses exist. Use `/auth/otp` for those two.

With the default `MAIL_TRANSPORT=console` the OTP is printed to the backend log
instead of being emailed, so staff sign-in is testable offline:

```bash
grep -A20 'sign-in code' /tmp/cr-dev.log   # or wherever the backend is logging
```

## Common commands

Run from the directory in question.

```bash
npm run dev      # backend: watch mode   | frontend: vite dev server
npm run build    # backend: tsc          | frontend: production bundle
npm run lint     # backend: tsc --noEmit | frontend: tsc --noEmit
npm test         # backend: vitest
npm run seed     # backend: idempotent seed
npm run doctor   # backend: end-to-end setup check (read-only)
```

Two end-to-end scripts drive a *running* dev server over real HTTP, the way the
browser does. The Vitest suite covers the same rules in-process; these catch what
an in-process suite cannot — a route that was never mounted, a proxy that does
not forward, a response shape that drifted from what the frontend reads. Both
clean up after themselves, so they are safe to run repeatedly.

```bash
cd backend
npx ts-node scripts/e2e-onboarding-check.ts   # 32 checks — registration and approval
npx ts-node scripts/e2e-fleet-check.ts        # 53 checks — fleet rules and isolation
```

Pass `--keep` to leave the records in place for poking at in the UI. Both write
to the **development** database, so point them at a local server only. The fleet
script takes about 70s: settings are cached for 30s in the server process, so a
flag it flips does not take effect on the next request until that cache expires.

## Documentation

- `VendorPortalImplementation.md` — the brief. Scope, milestones, field rules.
- `design.md` — design system: brand red, slate chrome, badge palette.
- `docs/` — source material the brief was derived from. Contains real PAN,
  GSTIN and bank numbers; nothing from these files is copied into code,
  fixtures or seeds.
- `backend/README.md`, `frontend/README.md` — per-project detail: endpoint tables,
  conventions, and what each rule is defending.

## Vendor registration (M2)

Replaces the paper registration form. The flow, end to end:

1. An admin or sales user opens **Vendor Onboarding** and sends an invitation.
   The email carries a link to `/onboarding/start?token=…`.
2. The vendor opens the link and fills the form in sections — Company (with a
   structured address and the SML states), Contact persons, Registration (GST,
   MSME and TDS blocks asked conditionally, as the paper form does), Bank,
   Fleet summary, Declaration — saving as they go. No account is needed; the
   token in the link is the credential.
3. They upload a cancelled cheque, a PAN copy and a scan of the signed
   declaration page — plus a GST certificate when they are GST-registered —
   then submit.
4. The vendor appears in the approval queue. An admin checks the detail view,
   fills the office-use block and approves or rejects.
5. **Approval is what creates the login.** The vendor is emailed an activation
   link; before that they cannot sign in, and rejection returns the form to them
   for correction with the admin's remarks.
6. Cross-field checks run at submit: the PAN's 4th letter must match the nature
   of the company (C company, F partnership, P proprietorship), the GSTIN must
   embed the PAN, and unregistered vendors must leave the GST block empty.

To try it without sending mail, send an invitation as the admin, then copy the
link shown under the form — it is displayed once, because only a hash of the
token is stored.

Bank account number and IFSC are encrypted at rest and are **only ever returned
decrypted to an admin**. A sales user sees the same registration with the bank
block absent from the response entirely, not masked.

### Gotcha: migration history drift

`npx prisma migrate dev` will refuse to run against the development database —
an applied migration (`20261003095000_crane_serial_partial_unique`) has a
checksum that no longer matches its file. Use `npx prisma migrate deploy`, or
`npx prisma migrate diff` to author changes without touching history.

## Fleet management (M3)

Replaces the shared crane spreadsheet. A vendor signs in and works **My Fleet**:

1. **Add a crane** at `/app/fleet/new`. Every field in brief 5.2 is required
   except the status, which defaults to Available because adding a crane usually
   means adding one that is ready to work. Optional jib lengths accept blank or
   `NA` — both mean "this crane has none", which is a different statement from
   zero. The serial is checked for placeholders, because a fleet full of `NA`
   would collide with itself.
2. **The location is geocoded on save** and the coordinates come back with the
   crane. If the lookup fails the crane still saves, flagged as having no map pin
   rather than rejected — a crane with no coordinates is one SML must not treat
   as deployable, not one that cannot be recorded.
3. **Correct the pin** by entering coordinates in the form. A pin you set is
   kept across later automatic lookups, unless you change the location text —
   at that point the old pin is describing somewhere the crane no longer is.
4. **Quick actions sit on the list row**: change status and location together,
   duplicate, confirm the details are still true, upload a load chart, deactivate.
5. **Deactivating is not deleting.** The crane leaves the default list but stays
   findable behind *Show deactivated*, and freeing its serial is deliberate —
   it can be reused once the old crane is gone, and reactivating is refused with
   a 409 if the serial is live again.

Two rules are enforced on the server rather than in the UI, because a UI-only
rule is not a rule:

- **Booked and Hired are SML's to set.** A vendor chooses Available, Engaged or
  Under maintenance. A crane on an SML contract cannot be edited at all, and
  says so.
- **Engaged requires an available-from date**, today or later, and going back to
  Available clears it.

**There is no map.** Open item 1 in the brief puts the map provider on hold
pending an accuracy test, so no tiles and no third-party script are loaded. The
form explains this and takes typed coordinates instead.
`backend/src/lib/geo.ts` is the interface where a provider drops in — the stub is
deterministic in development and test, and production refuses to invent
coordinates.

### Fleet approval toggle

Brief 6.4 asks for the code path with the review UI deferred, which is what
`FLEET_APPROVAL_REQUIRED` is. It defaults to off and vendor changes go live
immediately. Switched on, new and edited cranes park in `PENDING` until an
admin approves them via `PATCH /api/cranes/:id/approval`. No screen for that yet.

### Trying it

`npm run seed` creates four demo cranes across the two demo vendors, so sign in
as `vendor1@example.com` / `Vendor@Portal2026` and open **My Fleet**. They cover
Available, Engaged and Under maintenance, and none carries coordinates, so they
show the "no map pin" state — useful for seeing, and one reason the geocoding
path is worth exercising by hand.

What the seed deliberately does *not* contain is a stale, deactivated or
system-locked crane, because those three states only arise over time and none of
them is worth faking into a fresh database. To see them, run the fleet check
with `--keep` and use the credentials it prints, or deactivate a seeded crane by
hand.

## RFQs (M4)

Turns the RFQ email thread into tracked work. **One RFQ is one enquiry line item**,
not a whole enquiry — so `enquiryNo` and `lineNo` are both mandatory, and a
ten-crane enquiry is ten separate RFQs. The flow, end to end:

1. **Create** at `/app/rfqs/new`: requirement, job site, deployment window,
   commercial terms, SML contact, response deadline.
2. **Confirm the job-site pin.** The site is geocoded on save exactly like a crane
   location. If the lookup fails the RFQ still saves, flagged as having no pin.
   Coordinates can be typed in instead, and confirming the pin is its own action
   so "SML checked where this actually is" is recorded separately from "SML typed
   it in".
3. **The candidate picker** at `/app/rfqs/$rfqId` lists matching vendor cranes
   grouped by vendor, nearest first, with the distance and how it was obtained.
4. **Pick vendors** from the picker or from the all-approved-vendors list, then
   **send**. Recipients resolve from vendor IDs to the vendor's own active email
   addresses — an address supplied by the browser is ignored, so a crafted request
   cannot mail a stranger.
5. **Track** per recipient: delivery status, response status, first viewed,
   reminders sent. Remind one recipient or all pending ones, extend the deadline,
   or cancel with a reason.

Rules enforced on the server, because a UI-only rule is not a rule:

- **A vendor cannot reach any RFQ route.** There is no vendor path into this
  router at all; the vendor inbox lives on a separate surface
  (`/api/vendor/rfqs`), described below.
- **Only approved vendors with an active user can be picked**, and that is
  re-checked at send time rather than trusted from the picker.
- **One bounced mailbox does not sink the RFQ.** A failed delivery is recorded
  against that recipient and logged, and everyone else still receives theirs.
- **Cranes are filtered on type, capacity, status and vendor approval.**
  Capacity matches "at least", not "exactly" — an RFQ for 100 t can be answered by
  a 250 t crane. An `ENGAGED` crane qualifies only if its release date is on or
  before the required start date; one with no release date is dropped rather than
  offered, because an RFQ sent on an unknown release date collapses after the
  vendor has quoted.
- **An un-geocoded crane is listed separately, not dropped.** Dropping it would be
  worse than listing it: a crane with no pin can still do the job. Coordinates
  decide which group a crane lands in and whether it can be ranked by distance,
  not whether it is offered.
- **Candidates are snapshotted when the RFQ is sent** and never recomputed, so
  what a vendor was told, and what the audit trail shows, cannot drift afterwards.

### Straight-line distance is labelled as such

If routing is unavailable, `distance.service.ts` falls back to a great-circle
figure and reports `method: "straight_line"` with `approximate: true`; the picker
shows that it is an approximation. **Only genuine road distances are cached.** A
cached approximation would shadow the real number for the whole cache lifetime
once routing starts working, with nothing in the data to tell the two apart.

### Deadlines and expiry

Extending a deadline notifies recipients who are still `Pending` and *revives*
those the expiry sweep sent to `Expired` back to `Pending` (brief C1) — the sweep
only ever expires recipients who never responded, so a later deadline hands them
their window back instead of dead-lettering them over a date sales has since
moved. A recipient who declined stays declined, and one who quoted stays quoted.
The automatic reminder fires inside the smaller of the configured lead time and
half the RFQ's send-to-deadline window, and is suppressed entirely when that
window is shorter than `RFQ_REMINDER_MIN_WINDOW_HOURS` (default 4) — a vendor
handed a two-hour window needs no nudge (brief C2). The automatic sweeps
(reminders and the expiry pass) arrived with M7 and now run on cron timers; M4
also ships both as callable functions plus `POST /api/rfqs/expire-pending` so
the rules can be run by hand.

### Trying it

Sign in as `sales@sanghvimovers.com`, open **RFQ Tracking**, and create one. The
seeded demo cranes carry no coordinates, so pick a site you type coordinates for
if you want to see the distance column populated — otherwise every crane lands in
the "location unverified" group, which is also worth seeing once.

There is no RFQ end-to-end script yet; `npm test` covers the M4 rules in-process.

## Vendor quotations (M5)

A vendor answers an RFQ by filing a quotation against one of their own cranes.
The surface is deliberately separate from the internal `/api/rfqs`: it hangs off
`/api/vendor/rfqs` and is gated on `rfq:respond`, a capability held by
`vendor_user` and by **no internal role** — nothing in SML can file a quotation in
a vendor's name.

| Method | Path | What |
| ------ | ---- | ---- |
| `GET` | `/api/vendor/rfqs` | The vendor's inbox, soonest deadline first |
| `GET` | `/api/vendor/rfqs/:rfqId` | One RFQ as the vendor sees it; records first viewed |
| `POST` | `/api/vendor/rfqs/:rfqId/quotations/preview` | Live total and warnings, stores nothing |
| `POST` | `/api/vendor/rfqs/:rfqId/quotations` | Submit (optional `loadChart` file) |
| `GET` | `/api/vendor/rfqs/:rfqId/quotations` | Every version, grouped into per-crane series |
| `POST` | `/api/vendor/rfqs/:rfqId/decline` | Decline the RFQ |
| `POST` | `/api/vendor/rfqs/quotations/:id/revisions` | Revise into a new version |
| `POST` | `/api/vendor/rfqs/quotations/:id/withdraw` | Withdraw the latest version |
| `GET` | `/api/vendor/rfqs/quotations/:id/attachments` | File names and sizes on a quotation (metadata only) |

### The total is worked out, not trusted

`total = rental charge + mobilisation`. A per-day or per-month rate is multiplied
by the RFQ's duration, converting **30 days to a month** when the units differ —
in whichever direction the mismatch goes. A lump sum is the rental charge on its
own, because the vendor has priced the whole job. The sentence explaining the
arithmetic is stored on the quotation, not just shown, so a receipt reprinted a
year later reproduces the same figures.

### Warnings never block

A crane of a different type or capacity, one older than the customer's criterion,
or one Engaged until after the required start, are recorded as warnings on the
quotation and shown to sales. They do not refuse submission: refusing them would
make it impossible to offer the next-best crane, which is exactly what a vendor
does when their best machine is out on another job.

### What the vendor sees

**My RFQs** is one screen per audience rather than a shared one: the internal
tracking list and the vendor inbox read different entities (the RFQ against the
recipient row) behind different endpoints, so `/app/rfqs` and `/app/rfqs/:id`
each pick their screen from the signed-in role before any query runs.

- **The inbox** is deadline-ordered, so an RFQ that has already passed sits at the
  top instead of hiding below live work. It is not hidden, because a vendor needs
  to see that a deadline went by; it is marked instead, and the actions are gone.
- **The quote form** takes a crane from the vendor's own fleet, shows the total as
  the rate is typed, and asks for a load chart only when the chosen crane has none
  on file. Every figure comes from the backend's own `calculationNote` — the
  browser never multiplies anything out, because a second implementation of the
  30-day month would eventually disagree with the one that was emailed.
- **Warnings are shown and acknowledged, not enforced.** The submit button stays
  live; brief 6.7 treats these as advice for sales.
- **Several cranes can be quoted on one RFQ**, each with its own version series,
  and the vendor may revise or withdraw any of them before the deadline.
- **A cancelled or expired RFQ stays readable**, with its quotations on record and
  the actions removed.

### Three things worth knowing

- **The RFQ creator is emailed, not the customer.** `Rfq.createdBy` receives the
  notification. The customer's `smlContactEmail` never does — a quotation carries
  this vendor's price.
- **Another vendor's id is a 404, not a 403,** on every route, because a 403 would
  confirm the row exists. Ownership is checked before the body is even parsed.
- **A withdrawn quotation stays in history,** and the recipient stays marked
  `QUOTED`: "quoted then withdrew" is a different conversation from "never replied".

### Withdrawing does not lock a crane out

Withdrawal marks the version `WITHDRAWN` and clears its `isLatest` flag, but the
series can be revived: revising a withdrawn version files the next version and
leaves the withdrawn one in history. This matters because submitting refuses a
second quote for a crane that already has one — correctly, since a double
submission is not a revision. Without the revive path, a vendor who withdrew
could never offer that crane on that RFQ again.

Whether a version can still be acted on is decided by the backend per row
(`editable`), not guessed by the screen: the latest version of a crane, still
`SUBMITTED` or withdrawn, and only while the RFQ is open.

### Attachments, and what is deliberately missing

A load chart can arrive two ways, and either one satisfies the rule: the crane
already has one on file, or the vendor attaches one with the submission or
revision. Later versions of the same crane's series reuse the chart from the
earlier one, so a vendor is not made to re-upload the same document per revision.

Two things are **not** built, on purpose:

- **No download route, for either audience.** The only attachment endpoint lists
  file names, types and sizes. The vendor already holds the file they uploaded,
  so serving it back adds a file-authorisation surface for no benefit; and the
  internal side has no attachment route at all yet, including for the files
  internal users send with an RFQ. Opening a vendor's load chart is a need of the
  comparison/award work, not of this milestone.
- **Only the load chart can be uploaded.** Brief 7.8 lists "attachments" and "load
  chart" as separate form fields and the schema has an `OTHER` attachment kind,
  but nothing writes an `OTHER` row. Whether a vendor should be able to attach,
  say, a written mobilisation quote is **an open question for the brief's owner**,
  not a decision taken here.

## Award, dashboard and reminders (M7)

### Awarding a quotation (brief 6.7)

When SML decides, an admin marks one quotation the winner:

```
POST /api/rfqs/:rfqId/quotations/:quotationId/award     (admin only)
```

One act, in a transaction: the selected quotation becomes `SELECTED` and the
winning crane gets a dated **`BOOKED` reservation** (brief 5.3/6.1 — the booking
is a reservation now, not a status flag; Booked/Hired are derived from it). The
window comes from the RFQ's start date and duration, or from the explicit dates
the admin enters when the start date is TBC. On the award that reaches the RFQ's
`quantity`, every other **live** quotation becomes `NOT_AWARDED` (superseded and
withdrawn versions are left alone — their vendor already knows that state and
rewriting it would contradict the history) and the RFQ is finalised.
`quotation_awarded` goes to the winner — with the reserved period — and
`quotation_not_awarded` to everyone passed over, each with the optional free-text
reason the admin typed, rendered through the same escaping as every other free
text in mail.

Only the latest + `SUBMITTED` quotation on an RFQ that is still open is
awardable, and a crane that is Under Maintenance or already has an overlapping
active reservation cannot be booked again. A quantity-2 RFQ is awarded in two
steps: the first is partial and leaves the other quotations open. The award is
audited.

On the screen it is an **Award** button in the RFQ detail's quotation table,
admin-only, with a confirm step that names what it will do. Once the quantity is
reached the RFQ reads finalised and the vendors covered.

### The vendor dashboard (brief 7.5)

**Dashboard** is the vendor's landing screen after sign-in. One read
(`GET /api/vendor/dashboard`) returns counters and, because a counter is only
useful if it leads somewhere, the rows behind it:

- **Fleet counters** — active cranes, how many need a status update, how many
  are Booked or Hired (bookings are SML's doing; the vendor sees, cannot set).
- **Cranes due for an update** — the `statusUpdatedAt` staleness window from
  `app_settings`, each row linking into the crane's edit screen.
- **The RFQ side** — open, awaiting-your-quote, awarded and not-awarded counts,
  with the ten nearest-deadline RFQs listed, overdue rows colored red at the top
  rather than hidden.
- **Quotation counters** — series submitted (a version rollout counts once),
  awarded and not awarded.

### The reminder sweeps (brief 6.5)

Three schedules registered at boot in `job/registerJobs.ts`:

| Job | Cadence | What |
| --- | ------- | ---- |
| stale-fleet-reminders | daily | Cranes past the staleness window get one email to the vendor's addresses. Silence within the repeat window: the same crane is not nagged daily, checked against `EmailLog`. |
| rfq-reminders | hourly | RFQs whose deadline is inside the lead hours (default 24) email every still-`PENDING` recipient. At most one automated reminder per day per vendor, bumped on the recipient row. |
| rfq-expiry | hourly | The same expiry sweep `POST /rfqs/expire-pending` runs by hand: past-deadline `PENDING` recipients become `EXPIRED`. |

Thresholds are `app_settings` keys, adjustable without a deploy.
`RFQ_REMINDER_LEAD_HOURS` widens the sprint `STALE_DUE_DAYS` etc.; the same
cadence the fleet uses, because one familiar window outlives a clever one.

## Status

M1 (foundation), M2 (vendor onboarding and approval), M3 (fleet management),
M4 (RFQ creation, dispatch and tracking), **M5** (vendor RFQ inbox, quotations,
versions and history, on both the API and the vendor screens), **M7** (award
outcome, vendor dashboard and the reminder sweeps) and **M8** (hardening) are
complete. On top of the milestones, the revised brief's rework phases A–E are
built: the SAP-aligned fields and admin settings (A), the dated reservation
entity and derived Booked/Hired (B), the RFQ lifecycle fixes — deadline-extension
revival, reminder timing, TBC start date, decline notes (C), on-behalf fleet
updates, the inline quotation crane add, the SAP vendor creation sheet with
admin-editable office-use master lists, and `expected_ready_date` (D), and the
access-isolation, upload, rate-limit, masking, geocoding/email-failure and
field-validation tests (E). See "Vendor quotations (M5)" and "Award, dashboard
and reminders (M7)" above.

**P0** (portal gap check and admin basics) is the first phase of the platform
roadmap in `plan/`. Section A checked the built portal against the revised design
and fixed what was missing: the six RFQ terms a CR enquiry line carries
(mobilisation/demobilisation, support crane, steel mats and ground prep, EHS/HR,
insurance, extension clause), the jib-shortfall warning, the contact-mobile rule
(ten digits, no leading zero), a friendly duplicate-PAN/GSTIN message on submit,
and the seven-day invitation expiry. Section B added the admin screen: the
dashboard counters, internal user management (create, role, enable/disable, reset
credentials) and vendor suspension/reinstate, enforced at login, dispatch and the
candidate picker.

**P1** (native enquiry intake, enquiry screens, sourcing workspace) is the
current phase. The enquiry and line-item tables were added (31 template fields,
including the five scope terms — additional manpower, intra-site movement,
pre-release, PPE and ROW — plus an internal-only block), with an RFQ now able to
link back to the line it was raised from. Status is event driven: a
forward-only trail moves a line as an RFQ is sent, a quotation arrives or an
award books it, and the enquiry header rolls up from its lines. An RFQ raised
from a line is prefilled from the **vendor-safe** subset only — customer name and
address, rental budget, internal notes, PO/SAP reference and the Sales Partner's
name cannot cross over, and a test asserts their absence by string. There is no
SML crane fleet in this platform (all cranes are vendor cranes), so internal
fulfilment is a manual line outcome rather than a machine match; the design
stores it as Fulfilled Internally with no crane record. Screens: the enquiry list,
the intake form, the detail with the trail, and the line workspace with vendor
recommendations, RFQ history and quotations.

Verified at the time of writing: backend `tsc` clean and 388/388 tests, frontend
typecheck and build clean, and both end-to-end scripts green against a running
server — 32/32 for onboarding, 53/53 for fleet. Phase E added
`validation.test.ts` (PAN, GSTIN and the GSTIN-embeds-PAN rule, IFSC,
mobile/telephone, account number, MICR, pincode, CIN) and a vendor-RFQ-detail
contract test pinning the response to its key whitelist and asserting no
customer-identity or budget key is present.

The vendor flow was additionally walked end to end against a running server with
a seeded database — vendor sign-in, inbox, detail, preview, multipart submission
with a load chart, revision, withdrawal, reinstatement, history, decline and
cross-vendor isolation — checking that every field the frontend reads is actually
present in each response. That walkthrough is what caught the inbox reporting an
arbitrary total for a multi-crane RFQ (it was ordered by version number, so two
cranes quoted once each tied); it is now ordered by submission time.

The vendor screens have no automated tests, because the frontend has no test
runner: they are verified by typecheck, build, and that manual walkthrough. They
have **not** been clicked through in a browser, so layout and interaction details
are unverified.

The suite is also run at `TZ=America/New_York`, which is not incidental. A `date`
input sends a calendar day with no timezone, and the code was truncating it in
the server's own zone — so a vendor who picked 5 October had the 4th stored on any
deployment behind UTC, and nothing caught it because tests ran at UTC where both
readings agree. Calendar dates are now anchored to UTC on both sides, which is
also what lets an RFQ's required start date and a crane's release date be compared
to each other at all. See `backend/src/lib/dates.ts`.