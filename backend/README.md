# Backend — Crane Discovery & Vendor Portal API

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
    rfq.service.ts         create, dispatch, track, deadline, cancel, remind,
                           expiry
    rfqNumber.service.ts   per-year sequential RFQ numbering
    email.ts, audit.ts   business logic
    emailTemplates.ts   subject/body per template, with the vars each requires
  controllers/           HTTP shaping only
  routes/                route tables
  job/scheduler.ts       cron registry; the RFQ reminder and expiry sweeps are
                         callable functions until M7 wires them to a timer
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
| `GET`    | `/rfqs/:rfqId/candidates` | `rfq:track`            | The picker: grouped by vendor, nearest first. |
| `POST`   | `/rfqs/:rfqId/send`       | `rfq:dispatch`         | Body is vendor IDs. Re-checks approval and active users. |
| `PATCH`  | `/rfqs/:rfqId/deadline`   | `rfq:extend_deadline`  | Must be later than the current one. Notifies `PENDING` recipients. |
| `POST`   | `/rfqs/:rfqId/cancel`     | `rfq:cancel`           | Requires a reason. |
| `POST`   | `/rfqs/:rfqId/remind`     | `rfq:remind`           | Optional `recipientId` for one recipient. |
| `GET`    | `/rfqs/approved-vendors`  | `rfq:track`            | The picker's "everyone else" list. |
| `POST`   | `/rfqs/expire-pending`    | `rfq:track`            | Runs the expiry sweep by hand; the timer is M7. |

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
- **Only road distances are cached.** `distance.service.ts` caches on
  `method === "road"`; a straight-line fallback is returned with
  `approximate: true` and never written to `distance_cache`, because a cached
  approximation would shadow the real figure for the whole cache lifetime once
  routing recovers.
- **Extending a deadline does not revive an `Expired` recipient.** `PENDING`
  recipients get a longer window and a notification; `Expired` is a status the
  vendor has already seen, so rewriting it would contradict their own view. The
  brief requires no revival and the sweep only ever moves `PENDING` forward.
- **A cancellation reason is required** and is injected into the email as a
  pre-escaped block, so a vendor's or an internal user's free text cannot inject
  markup into the mail.

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
| `POST` | `/vendor/rfqs/:rfqId/decline`           | Optional `reason` and `note`. |
| `POST` | `/vendor/rfqs/:rfqId/quotations/preview` | Total, warnings, distance. Stores nothing. |
| `POST` | `/vendor/rfqs/:rfqId/quotations`         | Optional `loadChart` file (multipart). |
| `POST` | `/vendor/rfqs/quotations/:id/revisions`  | Optional `loadChart`. Becomes the next version. |
| `POST` | `/vendor/rfqs/quotations/:id/withdraw`   | Optional `reason`, kept in the audit trail. |
| `GET`  | `/vendor/rfqs/quotations/:id/attachments`| File names, types and sizes. No storage paths in the response. |

Rules, all in `quotation.service.ts`:

- **Blocks:** closed deadline, cancelled RFQ, a crane that is not the vendor's or
  is deactivated / `UNDER_MAINTENANCE` / `BOOKED` / `HIRED`, a rate of zero or less,
  negative mobilisation, a validity date before today, no availability
  confirmation, and no load chart on the crane, on the submission, or already on
  this crane's series.
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
  save a draft, upload the three required documents, submit, work the queue,
  approve, reject and resubmit. Plus cross-vendor isolation via a guessed or
  reused token, and that a vendor cannot sign in before approval.
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

275/275 tests across the seven files (69 RFQ, 66 quotations, 58 fleet, 52 onboarding, 14 access isolation, 11 calendar dates, 5 rate limit). The suite opens a
real HTTP server per request against a real Postgres, because the rules being
tested are properties of the actual queries and status codes.

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
a draft, upload the three documents, submit, work the queue, approve — and
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