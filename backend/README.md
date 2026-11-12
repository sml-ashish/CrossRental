# Backend — crossrentel API

Express 4 + Prisma 7 + PostgreSQL. TypeScript throughout, strict mode.

## Setup

```bash
cp .env.example .env
npm install
npx prisma migrate deploy
npm run seed
npm run dev
```

Listens on `PORT` (default 4000). `GET /health` needs no authentication.

## Layout

```
prisma/
  schema.prisma          data model — the single source of truth
  migrations/            applied SQL, including raw CHECK constraints
src/
  config/env.ts          Zod-validated environment; fails fast on bad config
  lib/database.ts        Prisma client over the pg adapter
  lib/storage.ts         StorageProvider interface; LocalDiskStorage today
  lib/referenceData.ts   states, crane types, SML contacts, seed defaults
  lib/seed.ts            idempotent seed
  utils/crypto.ts        AES-256-GCM field encryption, masking, tokens
  utils/jwt.ts           access tokens
  utils/rbac.ts          role → capability map
  utils/settings.ts      cached app settings
  utils/masterLists.ts   admin-editable SAP office-use master lists (D3)
  lib/geo.ts             geocoding provider interface, stub, India bounds
  middleware/            auth, validate, errorHandler, upload, rate limits
  services/
    auth.ts              sign-in, OTP, activation, password reset
    onboarding.service.ts   token-scoped draft, documents, submit
    approval.service.ts     invite, queue, approve/reject, activation
    documents.service.ts    upload, replace-by-type, scoped reads
    crane.service.ts        fleet CRUD, status rules, geocoding, load charts
    candidate.service.ts    RFQ candidate matching, grouping, distance order
    distance.service.ts    road distance, straight-line fallback, caching
    enquiry.service.ts     native enquiry intake, line CRUD, manual internal
                           check, RFQ-from-line (P1)
    enquiryTrail.service.ts  line status trail and enquiry roll-up (P1)
    enquiryNumber.service.ts per-year sequential enquiry numbering (P1)
    rfq.service.ts         create, dispatch, track, deadline, cancel, remind,
                           expiry, automatic reminders
    rfqNumber.service.ts   per-year sequential RFQ numbering
    award.service.ts       award (brief 6.7): select, not-award, book, email
    quotation.service.ts   vendor inbox, quotation submit/revise/withdraw, decline
    reservations.service.ts  dated commitments, derived Booked/Hired, release
    sapSheet.service.ts    SAP vendor creation sheet + SpreadsheetML export (D3)
    admin.service.ts       admin dashboard counters, staff management,
                           vendor suspend/reinstate (P0 B)
    vendorDashboard.service.ts  vendor dashboard counters and lists (7.5)
    staleFleet.service.ts  stale-fleet reminder sweep (6.5)
    audit.service.ts, email.service.ts   business logic
    emailTemplates.ts   subject/body per template, with the vars each requires
  validation/            Zod schemas per surface, including enquiryFields.ts (P1)
  controllers/           HTTP shaping only
  routes/                route tables
  job/scheduler.ts       cron registry; three jobs are wired in
                         job/registerJobs.ts (see "Background jobs")
  generated/prisma/      generated client — do not edit
  __tests__/             Vitest suites
```

## Conventions

- **Controllers do no business logic.** They parse, delegate, and shape.
- **Every query that touches vendor data is scoped by `vendorId` from the
  verified token**, never from a request parameter. This is the rule the
  isolation tests exist to defend.
- **Encrypted columns never reach a non-admin response.** A vendor sees masks
  built from the stored clear-text last4. For a sales user the bank block is
  omitted from the payload altogether — the value is never loaded, not merely
  hidden. Only `vendorDetail` decrypts, behind `vendor:view_bank`.
- **An invitation token is a bearer credential.** It is stored only as a hash,
  compared in constant time, and re-checked for expiry and revocation on every
  request. The raw token is returned exactly once, when the invitation is
  created.
- **Errors are thrown as `AppError`** with a stable `code`; the error handler
  is the single place that turns one into a response.
- **Login failures are indistinguishable** across unknown address, wrong
  password, non-vendor role and not-yet-activated, so the endpoint cannot be
  used to enumerate accounts.

## Roles

| Role         | Signs in with | Scope                                       |
| ------------ | ------------- | ------------------------------------------- |
| `vendor_user`| password      | own vendor record, own cranes, own quotations |
| `sales_user` | email OTP     | RFQs; may send invitations and view registrations. Not bank details, not award |
| `admin_user` | email OTP     | everything, including approvals and bank details |

`vendor_user` holds `fleet:edit_own` and nothing else, which is why a vendor is
refused every RFQ route rather than merely hidden from the RFQ screens. Sales and
admin hold the same RFQ capabilities — the split between them is bank details and
`quotation:award`, not RFQs. The quotation capabilities exist now so the RBAC
shape is settled, but nothing writes quotations until M5.

Registration is `DRAFT → SUBMITTED → APPROVED` or `→ REJECTED`. A rejected
vendor can correct and resubmit through the same invitation link. Approval is
what creates the portal login, so there is deliberately no way to sign in before
it.

## Environment

See `.env.example` for the full list. The ones that matter most:

| Variable                                | Notes                                        |
| --------------------------------------- | -------------------------------------------- |
| `DATABASE_URL`                          | development database                         |
| `TEST_DATABASE_URL`                     | scratch database the test suite truncates    |
| `JWT_SECRET`                            | signs access tokens                          |
| `ENCRYPTION_KEY`                        | 32-byte key for AES-256-GCM bank fields      |
| `MAIL_TRANSPORT`                        | `console` prints mail instead of sending it  |
| `SMTP_HOST` / `SMTP_USER` / …           | required once `MAIL_TRANSPORT=smtp`          |
| `STORAGE_DRIVER`                        | `local` (default) or `s3`                    |
| `RATE_LIMIT_*`                          | credential endpoint budgets                  |

Generate dev secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

**The test suite truncates `TEST_DATABASE_URL` without asking.** Point it at a
throwaway database. There is a guard comment in `vitest.config.mts` and
`src/__tests__/harness.ts`; do not point it at anything you care about.

## Onboarding endpoints

Two ways in, one implementation:

- **Token** — `/onboarding/invitation/:token`, public. The invited vendor has no
  account, so these routes carry no `Authorization` header and the token is the
  only credential. `GET /onboarding/document-types` and
  `GET /onboarding/reference-data` are public for the same reason; the latter
  returns states only, never crane types.
- **Account** — `/onboarding`, authenticated, for a vendor returning to their own
  registration after activation.

Both share `saveVendorDraft`, so an editability rule is enforced in one place.
Approval decisions live under `/vendors/:vendorId/{approve,reject,resend-activation}`.

Note that a blank optional dropdown submits `""`, which a bare `z.enum().optional()`
rejects with an unactionable "Invalid option". `optionalChoice()` treats a blank as
"not answered", and the draft path drops blanks entirely so a half-filled form can
be parked. Required fields are still enforced at submit.

## Fleet endpoints

Under `/api/cranes`. Reads accept `fleet:edit_own` **or** `fleet:view_all`; every
write requires `fleet:edit_own`, so sales reads an approved fleet for the M4
candidate picker but cannot maintain one.

| Method   | Path                          | Notes |
| -------- | ----------------------------- | ----- |
| `GET`    | `/cranes`                     | Filters: `status`, `typeOfCraneCode`, `stateCode`, `search`, `includeInactive`. Internal callers may narrow with `vendorId`. |
| `POST`   | `/cranes`                     | Geocodes, then applies the duplicate rule. |
| `GET`    | `/cranes/:craneId`            | |
| `PUT`    | `/cranes/:craneId`            | Full form. |
| `PATCH`  | `/cranes/:craneId/status-location` | The quick action: status + location + optional pin in one call. |
| `GET`    | `/cranes/:craneId/duplicate`  | Returns a prefill for the add form; the vendor still submits it. |
| `POST`   | `/cranes/:craneId/confirm-accurate` | Refreshes the freshness clock, changes no data. |
| `POST`   | `/cranes/:craneId/deactivate` | Soft delete. Never a hard delete — quotations and audit rows point here. |
| `POST`   | `/cranes/:craneId/reactivate` | 409 if the serial is now live on another crane. |
| `POST`   | `/cranes/:craneId/load-chart` | PDF/JPG/PNG via `uploadSingle`. |
| `GET`    | `/cranes/:craneId/load-chart` | Binary, authenticated. |
| `PATCH`  | `/cranes/:craneId/approval`   | `vendor:approve` only. The brief allows the review UI to wait. |
| `GET`    | `/cranes/bulk/template`       | The `.xlsx` import template, with dropdowns for crane types and states. `fleet:edit_all`. |
| `POST`   | `/cranes/bulk`                | Multipart `file` (`.xlsx`) plus `vendorId`. `?dryRun=true` returns the per-row report without writing. `fleet:edit_all`. |

Bulk upload is the sales/admin path for loading a vendor's fleet, not a vendor
feature. It is deliberately a thin loop over `createCrane` — the same schema,
duplicate rule and geocoding as the single-crane form — so the two cannot drift.
Two limits are specific to it: at most 250 rows per file (refused up front) and
5 MB (the spreadsheet uploader, separate from the PDF/JPEG/PNG one). A duplicate
serial is skipped and reported, never used to update the existing crane; a failed
row does not stop the valid ones. The vendor gets one summary email per import.

The rules worth knowing before changing any of this:

- **Booked and Hired are system-only.** A vendor cannot set them and cannot
  change a crane that is in one; `assertNotSystemLocked` answers 409 with a
  message saying SML manages it, rather than a bare refusal.
- **The duplicate rule is active-cranes-only and case-insensitive.** A
  deactivated serial can be reused, which is why the pre-check matches on
  `isActive: true` and compares with `mode: "insensitive"` — the database's
  unique index is case-sensitive, so without that the pre-check would pass and
  the insert would still collide.
- **Geocoding never blocks a save.** A failed lookup stores null coordinates and
  `locationUnverified`, which `toView` derives rather than stores.
- **Pin precedence follows brief 6.3**: a pin submitted in the request wins; a
  pin the vendor set earlier is preserved unless the location text, state or
  pincode changed *and* no new pin was submitted. That is the one rule here
  with a genuine ambiguity in the brief, resolved in favour of not discarding a
  deliberate correction.
- **Freshness is computed, not stored.** `statusUpdatedAt` is the clock; it is
  bumped by a status or location move and by "confirm still accurate", but not
  by a spec-sheet edit. The 30/60-day windows come from `app_settings`.

## RFQ endpoints

Under `/api/rfqs`. **Internal only** — there is no `fleet:edit_own` path into
this router, so a vendor cannot reach any of it. M5's vendor inbox is a separate
surface reading recipient rows; folding it in here would mean one router serving
two audiences under one set of rules.

| Method   | Path                      | Capability             | Notes |
| -------- | ------------------------- | ---------------------- | ----- |
| `GET`    | `/rfqs`                   | `rfq:track`            | Filters: `status`, `awaitingResponse`, `search`. |
| `POST`   | `/rfqs`                   | `rfq:create`           | Saves a draft; geocodes the site first. |
| `GET`    | `/rfqs/:rfqId`            | `rfq:track`            | Detail: recipients, snapshots, quotations. |
| `PUT`    | `/rfqs/:rfqId`            | `rfq:create`           | Drafts only. 409 once sent. |
| `PATCH`  | `/rfqs/:rfqId/site-pin`   | `rfq:create`           | Confirms or corrects the job-site pin. |
| `GET`    | `/rfqs/:rfqId/candidates` | `rfq:track`            | The picker, grouped by vendor. `?mode=technical` (default: type + capacity, smallest adequate capacity first, then nearest) or `?mode=distance` (same type, any capacity, nearest first). |
| `POST`   | `/rfqs/:rfqId/send`       | `rfq:dispatch`         | Body is vendor IDs. Re-checks approval and active users. |
| `PATCH`  | `/rfqs/:rfqId/deadline`   | `rfq:extend_deadline`  | Must be later than the current one. Notifies `PENDING` recipients. |
| `POST`   | `/rfqs/:rfqId/cancel`     | `rfq:cancel`           | Requires a reason. |
| `POST`   | `/rfqs/:rfqId/remind`     | `rfq:remind`           | Optional `recipientId` for one recipient. |
| `GET`    | `/rfqs/approved-vendors`  | `rfq:track`            | The picker's "everyone else" list. |
| `POST`   | `/rfqs/expire-pending`    | `rfq:track`            | Runs the expiry sweep by hand; a cron job also runs hourly. |
| `POST`   | `/rfqs/:rfqId/quotations/:quotationId/award` | `quotation:award` | Admin only. See "Award endpoints". |
| `GET`    | `/settings`               | `vendor:approve`       | Admin only. The day basis. |
| `PATCH`  | `/settings`               | `vendor:approve`       | Admin only. Body `{ rateDayBasis: CALENDAR_DAYS \| WORKING_DAYS_PER_MONTH }`. |
| `GET`    | `/settings/master-lists`  | `vendor:approve`       | Admin only. The six SAP office-use lists (each starts empty). |
| `PUT`    | `/settings/master-lists/:name` | `vendor:approve`  | Admin only. Body `{ values: string[] }`; trimmed and case-insensitively de-duplicated. `name` ∈ VENDOR_ORIGIN, VENDOR_TYPE, PURCHASE_ORG, PAYMENT_TERM, WITHHOLDING_TAX_TYPE, LEGAL_FORM. |
| `GET`    | `/vendors/:vendorId/sap-sheet` | `vendor:view_bank` | Admin only. The SAP creation sheet (bank columns decrypted). Not logged. |
| `GET`    | `/vendors/:vendorId/sap-sheet.xls` | `vendor:view_bank` | Admin only. SpreadsheetML 2003 export of the same sheet. Not logged. |

Guards are per verb, not one blanket "any RFQ capability": the table separates
creating from dispatching from reminding, and a blanket guard would hand every one
of those to whoever holds the weakest of them.

The rules worth knowing before changing any of this:

- **An RFQ is a line item, not an enquiry.** `enquiryNo` and `lineNo` are both
  required, and the display number is `RFQ-2026-0001` — per year, sequential,
  allocated in a transaction so two concurrent sends cannot collide.
- **Recipients are vendor IDs, resolved server-side to the vendor's own active
  addresses.** Any address list in the request body is ignored outright, so a
  crafted request cannot mail a third party. Approval and the presence of an
  active user are re-checked at send time rather than trusted from the picker.
- **Capacity matches "at least" by default; the RFQ can demand exact (brief A3).**
  `capacityRule` on the RFQ switches the picker's tonnage filter for that enquiry
  alone; `capacityNote`, `applicationDescription`, `loadDescription` and the
  structured `mainBoomM` / `jibLengthM` travel with the requirement and appear on
  the vendor's screen and in the invitation mail. A crane whose boom is shorter
  than required raises a stored warning, and a quotation against an RFQ whose
  start date is TBC neither asks for nor stores an availability confirmation —
  the vendor is told why instead.
- **The day basis is an admin setting (brief 6).** `RATE_DAY_BASIS` in
  `app_settings` picks between 30 calendar days per month and the RFQ's own
  `workingDaysPerMonth`; it changes only the month-to-days conversion shown in
  every quotation note.
- **A failed delivery is per recipient.** One bouncing mailbox is recorded as
  `FAILED` on that row and written to `EmailLog`, and the RFQ still goes out
  `SENT` to everyone else.
- **Candidates are snapshotted at send time** (`candidate_snapshot` on the
  recipient) and never recomputed, so what the vendor was shown and what the
  audit trail records cannot drift.
- **Capacity matches "at least".** See `CAPACITY_MATCH` in `candidate.service.ts`
  — flipping it to exact is a one-line change and a different product.
- **An `ENGAGED` crane with no release date is excluded, not parked.** The fleet
  service already refuses to write one, so it can only be legacy data or a direct
  database write; admitting it would offer a crane whose availability nobody
  knows. It is dropped from both buckets rather than moved into `unverified`,
  which means "location unverified".
- **A TBC start date skips the date checks with a notice (brief C3).** When the
  RFQ has no fixed start there is nothing to compare, so an `ENGAGED` crane is
  admitted however its release date reads, no reservation overlap is computed,
  and the list carries `startDateTbc: true` plus a `notice` telling sales the
  dates were not checked. The quotation side does the same: the availability
  confirmation is not required and the stored warning `start_date_tbc` records
  why (brief A3).
- **Only road distances are cached.** `distance.service.ts` caches on
  `method === "road"`; a straight-line fallback is returned with
  `approximate: true` and never written to `distance_cache`, because a cached
  approximation would shadow the real figure for the whole cache lifetime once
  routing recovers.
- **Extending a deadline revives an `Expired` recipient (brief C1).** `PENDING`
  recipients get a longer window and a notification; recipients the sweep moved
  to `EXPIRED` — necessarily ones who never responded — return to `PENDING` with
  their `lastReminderAt` cleared, so the reminder job fires against the new
  deadline. A `DECLINED` or `QUOTED` recipient is untouched. The response
  carries `revived` beside `notified`. (This replaces the earlier rule that an
  `Expired` recipient was never revived.)
- **A cancellation reason is required** and is injected into the email as a
  pre-escaped block, so a vendor's or an internal user's free text cannot inject
  markup into the mail.
- **A decline carries what else the vendor can offer (brief C4).** The enquiry
  mail invites the vendor to decline and list their available fleet or contacts
  of other agencies, and the decline form asks for the same. Both `declineReason`
  and `declineNote` are stored on the recipient and returned to the RFQ's creator
  on the tracking detail, so a "no" is not a dead end.

## Vendor quotation endpoints

Under `/api/vendor/rfqs`. Gated on **`rfq:respond`**, which `vendor_user` holds and
no internal role does, so there is no path from an SML account to any of it. Every
handler scopes by the token's `vendorId` inside the service, so another vendor's
RFQ or quotation id is a **404 rather than a 403** — a 403 would confirm the row
exists. Ownership is resolved before the request body is parsed.

| Method | Path                                    | Notes |
| ------ | --------------------------------------- | ----- |
| `GET`  | `/vendor/rfqs`                          | Inbox, deadline ascending. Filters: `responseStatus`, `search`. |
| `GET`  | `/vendor/rfqs/:rfqId`                   | Vendor's view of one RFQ. Sets `firstViewedAt` once. |
| `GET`  | `/vendor/rfqs/:rfqId/quotations`        | Every version, grouped into per-crane series, newest first. |
| `POST` | `/vendor/rfqs/:rfqId/decline`           | Optional `reason` and `note`; `note` is what else they can offer (brief C4). |
| `POST` | `/vendor/rfqs/:rfqId/quotations/preview` | Total, warnings, distance. Stores nothing. |
| `POST` | `/vendor/rfqs/:rfqId/quotations`         | Optional `loadChart` file (multipart). |
| `POST` | `/vendor/rfqs/quotations/:id/revisions`  | Optional `loadChart`. Becomes the next version. |
| `POST` | `/vendor/rfqs/quotations/:id/withdraw`   | Optional `reason`, kept in the audit trail. |
| `GET`  | `/vendor/rfqs/quotations/:id/attachments`| File names, types and sizes. No storage paths in the response. |

Rules, all in `quotation.service.ts`:

- **Blocks:** closed/cancelled RFQ with the same "SML has finalised this RFQ"
  message, a closed deadline, a crane that is not the vendor's or
  is deactivated / `UNDER_MAINTENANCE` / `BOOKED` / `HIRED`, a rate of zero or less,
  negative mobilisation or demobilisation, a validity date before today, no
  availability confirmation, and no load chart on the crane, on the submission,
  or already on this crane's series.
- **Warnings, stored not thrown:** crane type differs, capacity differs in either
  direction, YOM breaks the age criterion, `ENGAGED` until after the required start.
- **Versions are per crane.** `quantity > 1` gives each crane its own independent
  series; the unique index on `(rfqId, vendorId, craneId, version)` is what actually
  enforces it under concurrency.
- **A revision re-checks the crane.** A crane booked since version 1 cannot collect
  a second price.
- **Notifications:** `quotation_received` to `Rfq.createdBy` (never the customer's
  `smlContactEmail`), and a `quotation_receipt` to the addresses the RFQ was
  dispatched to, on submit, revise and withdraw.
- **Withdrawal is reversible; supersession is not.** Withdrawing clears
  `isLatest` on the version it withdraws, so the highest version of a series is
  found by asking for a higher one rather than by reading that flag — which would
  otherwise make a withdrawn version permanently unrevisable. A withdrawn series
  head stays `editable`, so it can be revived as the next version. This matters
  because submission refuses a second quote for a crane that already has one:
  without the revive path, withdrawing would lock that crane out of the RFQ.
- **The inbox total is the most recent submission.** The roll-up orders by
  `submittedAt`, not by version: two cranes quoted once each are both version 1,
  so a version-ordered roll-up reported whichever row the database returned first.
- **No attachment download route exists,** for either audience. `attachments`
  lists metadata only, and the internal surface has no attachment route at all
  yet. The `OTHER` attachment kind is defined but never written — see the open
  question in the root README.
- **Vendor-visible statuses are mapped, not raw.** `SELECTED` arrives as
  `AWARDED` (the word the brief uses for the vendor-facing outcome);
  `NOT_AWARDED` passes through unchanged. Every vendor quotation and history
  response goes through `vendorVisibleStatus()` — see `award.service.ts` for the
  other half of the mapping.

## Award endpoints (brief 6.7 as revised, phase B2)

`POST /api/rfqs/:rfqId/quotations/:quotationId/award`, admin only. The whole
decision is one transaction in `award.service.ts`:

- Only the **latest + `SUBMITTED`** quotation on an unclosed, uncancelled RFQ is
  awardable, and only if the crane is active, not Under Maintenance and has **no
  overlapping ACTIVE reservation** ("crane now reserved").
- The award creates a **`BOOKED` reservation** for the crane (brief 5.3/6.1). It
  no longer writes a `BOOKED`/`HIRED` status: the commitment is the dated
  reservation, and the badge is derived from it everywhere.
- The **reservation window** is derived from the RFQ's `requiredStartDate` and
  `durationValue`/`durationUnit` (converted with the `RATE_DAY_BASIS` setting).
  When the RFQ's start date is `startDateTbc`, the caller must supply both
  `startDate` and `endDate`, because there is nothing to derive them from.
- **Awards are partial until the RFQ's `quantity` is reached.** One award on a
  quantity-2 RFQ leaves the other quotations open (RFQ stays `SENT`); only the
  award that reaches the quantity sets the remaining latest live quotations to
  `NOT_AWARDED` and closes the RFQ (`CLOSED`).
- On a closing award an audit entry is written and two emails go out:
  `quotation_awarded` to the winner (with the reserved period), and
  `quotation_not_awarded` to every vendor passed over. A partial award only mails
  the winner.
- An optional free-text `reason` is echoed into both emails through
  `optionalBlock`, escaping every other free text the mail renders.

Comparison and finalisation screens belong to sales-side work later; they call
the same service.

## Reservation endpoints (brief 5.3 / 6.1, phase B)

Under `/api/reservations`. **SML-side only** — there is no vendor route, because
a reservation is SML's record of who has the crane when. Reading is `rfq:track`
(sales and admin); blocking and releasing are `vendor:approve` (admin only).

| Method | Path                          | Capability       | Notes |
| ------ | ----------------------------- | ---------------- | ----- |
| `GET`  | `/reservations`               | `rfq:track`      | Filters: `status`, `type`, `craneId`, `vendorId`. |
| `POST` | `/reservations`               | `vendor:approve` | Blocks a crane for a period. Body `{ craneId, startDate, endDate, reason? }`. |
| `POST` | `/reservations/:id/release`   | `vendor:approve` | Reason required. Audit entry, `reservation_released` mail to the vendor. |
| `POST` | `/reservations/complete-overdue` | `vendor:approve` | Marks past-end ACTIVE rows `COMPLETED`; the daily job runs the same sweep. |

A reservation is a dated commitment, not a flag:

- **Booked and Hired are derived, never stored (brief 6.1).** An ACTIVE
  reservation covering today reads `HIRED`, one starting later reads `BOOKED`,
  and the crane's own status stays whatever the vendor last set.
  `deriveBookingBadge` is the single reading shared by the admin list and the
  vendor dashboard.
- **Availability is the absence of an overlapping reservation (brief 6.1/B3).**
  Candidate matching and the quotation guard no longer read a stored
  Booked/Hired status: `reservationWindowForRfq` derives the RFQ's window from
  its start date and duration (or returns nothing when the start is TBC), and a
  crane with an ACTIVE reservation intersecting it is dropped from the picker
  and refused at submit ("That crane is reserved on an SML contract for X to Y
  and cannot be quoted"). A vetting reminder: an Engaged crane whose
  `available_from` has passed is flagged "availability date lapsed, confirm" on
  the vendor dashboard and counted as due for update.
- **The database refuses overlaps.** `btree_gist` plus an `EXCLUDE` constraint
  (`reservations_active_no_overlap`) refuses two ACTIVE reservations on one crane
  whose ranges intersect, transaction or not. The service checks first so the
  caller gets a sentence naming the clash, and the constraint is the backstop for
  two writers racing.
- **Releasing frees the crane and tells the vendor.** The status becomes
  `RELEASED`, the reason, actor and timestamp are kept, an audit entry is written
  and the vendor's addresses (the RFQ's recipients when there is one, else the
  vendor's recorded address) receive `reservation_released`.
- **Dates are UTC calendar slices.** Writers normalise to UTC midnight so the
  stored end date is the crane's last committed day and the range compares whole
  days.
- **Migration synthesis.** The phase B migration turned cranes still carrying the
  legacy stored `BOOKED`/`HIRED` into one ACTIVE reservation each and reset the
  crane status to `AVAILABLE`, so no commitment was lost. From B2 the award
  writes reservations only, so the legacy statuses are no longer produced.

## Admin endpoints (P0 B)

Under `/api/admin`. Every route requires `vendor:approve` — held by `admin_user`
and not by `sales_user` — applied once with `router.use`.

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/admin/dashboard` | The five B1 counters: registrations awaiting approval, RFQs with a failed email delivery, cranes stale past `STALE_FLAG_DAYS` (60), cranes with no map location, Engaged cranes past `availableFrom`. Each phone links to the same filtered list where one exists (approvals, RFQs `?delivery=FAILED`). |
| `GET`  | `/admin/users` | Internal users only (`admin_user`, `sales_user`), oldest first. |
| `POST` | `/admin/users` | Body `{ email, fullName?, role }` where `role` ∈ `admin_user \| sales_user`. Creates an OTP-only account (no password hash) and emails `internal_user_created`. 409 on a duplicate email. |
| `PATCH`| `/admin/users/:id` | Body `{ role?, isActive? }`. Changing the role re-issues the user's capabilities. An admin cannot deactivate their own account (400). |
| `POST` | `/admin/users/:id/reset-credentials` | Forces a fresh credential: internal users get a new login code, vendor users an emailed reset link. |
| `POST` | `/admin/vendors/:id/suspend` | Body `{ reason? }`. Sets `suspendedAt`/`suspendedById`/`suspendReason`, deactivates the vendor's users and audits. 409 if already suspended. |
| `POST` | `/admin/vendors/:id/reinstate` | Clears the suspension and reactivates the users (only when the vendor is APPROVED). 400 if not suspended. |

**Suspension is enforced server-side in four places**: `loginWithPassword`
(403 `VENDOR_SUSPENDED`, and the users are deactivated so live tokens die at
`requireAuth`), `resolveRecipients` and `listApprovedVendors` in
`rfq.service.ts`, and the candidate picker in `candidate.service.ts`. A suspended
vendor cannot sign in, receive an RFQ, or appear as a candidate.

## Enquiry endpoints (P1)

Under `/api/enquiries`. Internal only — `enquiry:*` is held by `admin_user` and
the CR team (`sales_user`), and every service entry point re-checks the role.

| Method | Path | Capability | Notes |
|---|---|---|---|
| `GET`  | `/enquiries` | `enquiry:view` | List with the derived roll-up per row. Filters: `status`, `search`, `businessVertical`, `stateCode`, `from`, `to`. |
| `POST` | `/enquiries` | `enquiry:create` | Body is the header plus `lines[]`. The adapter point: all creation (manual today, a SAP feed later) goes through `createEnquiry(payload, source)`. |
| `GET`  | `/enquiries/:enquiryId` | `enquiry:view` | Header, lines and a stage-count summary. |
| `PUT`  | `/enquiries/:enquiryId` | `enquiry:manage` | Full header edit. |
| `POST` | `/enquiries/:enquiryId/lines` | `enquiry:manage` | Add a line; `lineNo` is assigned. |
| `GET`  | `/enquiries/lines/:lineId` | `enquiry:view` | One line item, for the editor and the comparison screen. |
| `GET`  | `/enquiries/lines/:lineId/recommendations` | `enquiry:view` | The P2 recommendation engine's latest result plus its snapshot history (API only; no screen). |
| `POST` | `/enquiries/lines/:lineId/recommendations/refresh` | `enquiry:manage` | Re-runs the engine, keeping earlier snapshots. |
| `GET`  | `/enquiries/lines/:lineId/comparison` | `enquiry:view` | The line's comparable quotations, ranked. |
| `PUT`  | `/enquiries/lines/:lineId` | `enquiry:manage` | Full line edit. |
| `POST` | `/enquiries/lines/:lineId/cancel` | `enquiry:manage` | Body `{ reason }`. The line becomes final; nothing revives it. |
| `POST` | `/enquiries/lines/:lineId/internal-check` | `enquiry:manage` | Body `{ outcome: CHECKED_NOT_AVAILABLE \| FULFILLED_INTERNALLY, notes? }` — the manual CR availability check. |
| `POST` | `/enquiries/lines/:lineId/rfq` | `rfq:create` | Body `{ submissionDeadline }`. Prefills an RFQ from the line's **vendor-safe** subset only. |

**Status is event driven, never set by a request.** `enquiryTrail.service.ts`
holds the forward-only trail and the roll-up. Triggers: `sendRfq` → RFQ Sent,
the first quotation → Quotes Received, an award → Booked, the internal check →
Fulfilled Internally / Availability Check, and cancel → Cancelled (final). The
header status is derived from the lines: nothing finalised → Received Pending
Sourcing, any quotes → Partially Quoted, some done → Partially Finalised, all
done → Fully Finalised, all closed/cancelled → Closed.

**The internal block never leaves the server.** `createRfqFromLine` reads only
the vendor-safe fields, so `customerName`, `customerAddress`, `rentalBudget`,
`internalNotes`, `poSapReference` and `salesPartnerName` cannot reach an RFQ.
The five scope terms (additional manpower, intra-site movement, pre-release,
PPE, ROW) and the demobilisation term go into the RFQ's `commercialTermsExtra`
JSON, which the vendor reads. An enquiry test asserts the absence by string.

## Vendor dashboard (brief 7.5)

`GET /api/vendor/dashboard` — one read returning counters **and the rows the
counters lead to**: cranes due for an update (the 30-day window from
`app_settings`), active/upcoming bookings (derived from the crane's reservations
— Booked or Hired, which only SML can set), the RFQs awaiting response (nearest
deadline first, overdue on top) and
quotation counts. Scoped by the token's vendor id like every other vendor
surface; an account without a vendor gets a 403 rather than a dashboard of
nothing.

## Background jobs

`job/registerJobs.ts` registers four schedules via `scheduler.ts`, started by
`createApp()`:

- **stale-fleet-reminders** (daily ~05:11) — `staleFleet.service.ts`. Cranes past
  the staleness window get one email to the vendor's addresses; the repeat
  window (default 7 days) is deduped by reading `EmailLog`, so no schema change
  was needed.
- **rfq-reminders** (hourly) — RFQs inside their reminder window email `PENDING`
  recipients; `lastReminderAt` within 24h is the dampener between runs. The
  window is the smaller of `RFQ_REMINDER_LEAD_HOURS` (default 24) and half the
  RFQ's send-to-deadline window, and a window shorter than
  `RFQ_REMINDER_MIN_WINDOW_HOURS` (default 4) is never chased (brief C2).
- **rfq-expiry** (hourly) — `EXPIRED` past-deadline recipients, the same sweep
  `POST /rfqs/expire-pending` runs by hand.
- **reservation-expiry** (daily ~01:23) — `reservations.service.ts` marks ACTIVE
  reservations whose end date has passed `COMPLETED`, so the crane stops reading
  as Booked/Hired (brief 6.1). The same sweep runs by hand at
  `POST /reservations/complete-overdue`.

`app_settings` keys: `STALE_DUE_DAYS`, `STALE_FLAG_DAYS`, `STALE_REMINDER_REPEAT_DAYS`,
`RFQ_REMINDER_LEAD_HOURS`, `RFQ_REMINDER_MIN_WINDOW_HOURS`, `RATE_DAY_BASIS`.

## Tests

```bash
npm test
```

Suites:

- `accessIsolation.test.ts` — brief 6.6. Cross-vendor reads, bank masking,
  deactivated-account lockout, role separation, prototype-pollution resistance,
  validation errors. Runs against a real Postgres over real HTTP, because the
  rule is only as strong as the actual query.
- `onboarding.test.ts` — brief 7.2/7.3. The whole paper-free path: invite,
  save a draft, upload the required documents (cheque, PAN copy, signed
  declaration page, GST certificate when registered), submit, work the queue,
  approve, reject and resubmit. Plus the cross-field rules at submit (PAN
  company-type letter, PAN inside the GSTIN, conditional GST/MSME/TDS blocks),
  cross-vendor isolation via a guessed or reused token, and that a vendor
  cannot sign in before approval.
- `rateLimit.test.ts` — credential limiter trips at the configured budget,
  per-email isolation, case-insensitive keys.
- `fleet.test.ts` — brief 6.3/6.4. Crane CRUD, the duplicate-serial rule, the
  status rules, geocoding and pin precedence, load charts, freshness.
- `rfq.test.ts` — brief 6.7/6.9. The whole M4 journey: create a draft, confirm
  the pin, rank candidates by distance, pick vendors, send, and read delivery and
  response status back. Plus that a vendor is refused every RFQ route, that a
  failed delivery does not sink the send, and that a routing failure yields a
  labelled straight-line figure which is never cached.

- `quotation.test.ts` — brief 6.7/7.8. The M5 vendor journey: only your own
  RFQs, quote with your own crane and load chart, see the total and the warnings,
  revise into a new version, withdraw, hit the deadline lock, and read every
  version back. Plus that another vendor gets a 404 for your RFQ and your
  quotation ids, and that the RFQ creator — never the customer's contact address —
  is the one emailed. Also that a withdrawn version can be revived as the next
  version and stays in history, that a superseded version cannot be revised or
  withdrawn, and that the inbox reports the most recently sent total.
- `dates.test.ts` — the UTC calendar-date helpers, including that an impossible
  date is rejected rather than rolled into the next month.
- `award.test.ts` — brief 6.7/7.5. The M7 journey: award one quotation and see
  the others Not Awarded, the crane Booked, the RFQ CLOSED, the audit row written
  and the two emails sent; the refusals (sales, non-latest, already-booked
  crane, cancelled RFQ); the vendor dashboard counters and lists scoped to one
  vendor; the stale-fleet reminder sweep and its dedup window; the RFQ
  automatic reminder sprint and the expiry sweep.
- `enquiry.test.ts` — P1. Native intake with every template field, the derived
  roll-up (internal fulfilment, partial, all-cancelled closes the enquiry, a
  cancelled line never revives), the RFQ-from-line vendor-safe copy (customer,
  budget, notes, PO and Sales Partner are absent by string), the line read and
  its vendor recommendations, the full trail journey (RFQ Sent → Quotes
  Received → Booked) and that a vendor is refused the whole surface.
- `admin.test.ts`, `settings.test.ts`, `reservations.test.ts` — the P0 admin
  surface, the master-list settings and the dated reservations.

388/388 tests across thirteen files. The exact per-file split shifts as phases
land, so `npx vitest list` is the authoritative count rather than this line. The
suite opens a real HTTP server per request against a real Postgres, because the
rules being tested are properties of the actual queries and status codes.

`npx vitest list` prints every collected test without running any of them, which
is the cheap way to check a count or confirm a test name. The suite takes about
four minutes end to end; the occasional `ECONNRESET` is the test HTTP server
closing a connection under load rather than a failed assertion, and re-running
the single test is the check.

Two techniques in `rfq.test.ts` worth knowing before extending it:

- **`vi.mock("../lib/mailer")`** with a per-address outcome map. Delivery failure
  is a real requirement of 6.7 but the console transport reports every send as
  successful, so this is the smallest seam that lets one address bounce while the
  rest succeed.
- **`setGeoProvider()`** swaps the routing implementation. The stub resolves every
  address, so testing an unpinned job site or a routing outage means installing a
  provider that fails — otherwise those paths are unreachable.

Fixtures are fabricated. Nothing is copied from `docs/`, which contains real
PAN, GSTIN and bank values.

### End-to-end check against a running server

```bash
npm run dev            # in one terminal
npx ts-node scripts/e2e-onboarding-check.ts
```

Drives the whole M2 path over real HTTP the way the browser does — invite, save
a draft, upload the required documents, submit, work the queue, approve — and
asserts the security rules that matter: that a vendor cannot sign in before
approval, that the queue never carries bank values, that a sales user's response
omits the bank block entirely, and that only the last four digits are stored in
clear.

The Vitest suite covers the same rules in-process against its own database. This
one catches what an in-process suite cannot: a route that was never mounted, a
proxy that does not forward, a response shape that drifted from what the
frontend reads. It cleans up after itself, so it is safe to run repeatedly;
pass `--keep` to leave the registration in place for manual poking.

It writes to the **development** database and mints its own access tokens from
`JWT_SECRET`, so point it at a local server only.

### Fleet end-to-end check

```bash
npm run dev            # in one terminal
npx ts-node scripts/e2e-fleet-check.ts
```

The same idea for the M3 fleet screens: add a crane, watch it geocoded, correct
the pin, refuse a duplicate serial, refuse Booked and Hired, apply the Engaged
date rule through the quick action, upload and download a load chart, duplicate,
confirm the data is still true, deactivate, reactivate, and exercise the approval
flag in both positions. It also asserts the isolation rules from both sides —
another vendor gets 404, sales may read but not write, and a vendor cannot
approve their own crane.

Two waits of about 31 seconds are deliberate: `getSettings` caches for 30s in
the server process, so a flag flipped from a script does not take effect on the
next request until that cache expires.