# Frontend — Crane Discovery & Vendor Portal

React 19 + Vite 6 + Tailwind CSS 4. TypeScript strict.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:5173. The dev server proxies `/api` to the backend
(default `http://localhost:4000`); set `VITE_API_PROXY` in `.env` to point at a
backend elsewhere on the network.

## Commands

```bash
npm run dev      # dev server, port 5173
npm run build    # production bundle to dist/
npm run preview  # serve the built bundle
npm run lint     # tsc --noEmit
```

## Layout

```
src/
  main.tsx              entry: QueryClient, AuthProvider, router
  router.tsx            route map and per-role access rules
  lib/
    api.ts              fetch wrapper, ApiError, token storage
    auth.ts             session shape, role → home route
    authProvider.tsx    session lifecycle
    cn.ts               clsx + tailwind-merge
  components/
    guards.tsx          RequireAuth, RedirectIfAuthenticated
    auth-layout.tsx     signed-out shell
    ui/                 spinner, alert, badge
  lib/onboarding.ts       M2 types + API calls for both onboarding entry points
  lib/fleet.ts            M3 crane types, form serialisation, API calls
  lib/rfqs.ts             M4 RFQ types, form serialisation, API calls
  lib/quotations.ts       M5 vendor quotation types + calls, incl. multipart
  components/ui/form.tsx  Field/TextInput/Select/Checkbox/Section primitives
  routes/
    auth/               login, OTP, activate, reset-password
    onboarding/         start.tsx — the public, invitation-gated form
    app/                signed-in shell, profile, approvals, vendor-detail,
                        fleet.tsx, crane-form.tsx,
                        rfqs.tsx, rfq-form.tsx, rfq-detail.tsx,
                        vendor-rfqs.tsx, vendor-rfq-detail.tsx,
                        placeholders for M6+
  styles/index.css      design tokens (@theme) and shared component classes
```

## Conventions

- **The backend decides access; this app only displays it.** Role checks here
  pick a sensible screen. They are never what stops a request.
- **`ApiError` carries the backend's `code`**, so screens branch on
  `NOT_ACTIVATED` or `RATE_LIMITED` rather than matching message text.
- **Tokens from email links are read from the URL**, accepting either the query
  string or the fragment. An activation or reset token is never stored, so it is
  never sent in a referrer header or written to an access log.
- **A partially filled form is saved whole, not field by field.** The public
  form tracks which fields were touched and sends only those, so saving one
  section never blanks the sections the vendor has not reached.
- **Unbuilt screens say so.** A placeholder states which milestone is coming
  instead of rendering an empty page that looks broken. `/app/rfqs` is built for
  both audiences now — internal tracking for staff, the vendor inbox for
  `vendor_user` — so the remaining placeholders are M6+.
- **A date the user typed is sent as typed.** A calendar date is serialised from
  its own `YYYY-MM-DD` parts and never round-tripped through `new Date(string)`,
  which would read it as UTC midnight and then render it in the browser's zone —
  a day earlier for anyone west of Greenwich. The same anchor is used on the
  server, so the date a vendor picks is the date that is stored. A real
  date-and-time field, such as the submission deadline, keeps its instant.
  Reading one back is the mirror of this: `formatCalendarDate` renders a calendar
  date in UTC so it prints as the day it names, while `formatDateTime` renders a
  real instant in the reader's own zone. Formatting a UTC-midnight date locally
  prints the day before it for anyone west of Greenwich — a deadline stated
  wrongly.

## Routes

| Path                        | Who            | What |
| --------------------------- | -------------- | ---- |
| `/onboarding/start`         | anyone with a link | Registration form (SAP-aligned fields, conditional GST/MSME/TDS blocks, document uploads). No session — the token is the credential. |
| `/app/approvals`            | admin, sales   | Approval queue: status filters, search, send invitation |
| `/app/vendors/$vendorId`    | admin, sales   | Registration detail. Admin sees decrypted bank details and the approve/reject controls; both roles get the vendor's fleet section (add/edit on the vendor's behalf) and, for admin, the SAP creation-sheet link |
| `/app/vendors`              | internal       | Redirects to the queue |
| `/app/vendors/$vendorId/sap-sheet` | admin   | Print-friendly SAP vendor creation sheet (phase D3) |
| `/app/admin`                | admin          | Dashboard counters (B1), staff management and vendor suspend/reinstate entry point (P0 B) |
| `/app/settings`             | admin          | Day basis and the SAP office-use master lists (phase D3) |
| `/app/enquiries`            | admin, sales   | Enquiry intake list, filtered by the derived roll-up (P1) |
| `/app/enquiries/new`        | admin, sales   | Capture an enquiry and its line items (P1) |
| `/app/enquiries/$enquiryId` | admin, sales   | Header, lines, the status trail and the manual internal check (P1) |
| `/app/enquiries/$enquiryId/edit` | admin, sales | Edit the enquiry header (P1) |
| `/app/enquiries/$enquiryId/lines/new` | admin, sales | Add a line item (P1) |
| `/app/enquiries/lines/$lineId` | admin, sales | The line's sourcing workspace: vendor recommendations, RFQ history, quotations (P1) |
| `/app/enquiries/lines/$lineId/edit` | admin, sales | Edit a line item (P1) |

Sales can send invitations and view registrations; the Approve and Reject
controls are not rendered for them, and the backend refuses those calls anyway.

Fleet routes:

| Path                        | Who    | What |
| --------------------------- | ------ | ---- |
| `/app/dashboard`            | vendor | The vendor dashboard (brief 7.5): counters plus the rows behind them |
| `/app/fleet`                | vendor | The fleet list: filters, search, and the per-crane quick actions |
| `/app/fleet/new`            | vendor, admin, sales | Add a crane. `?duplicate=<craneId>` prefills from an existing one; an internal user passes `?vendorId=` to add on a vendor's behalf |
| `/app/fleet/$craneId/edit`  | vendor, admin, sales | Edit a crane. The same screen as add. An on-behalf edit is badged and emails the vendor |

An internal user reaching `/app/fleet/new` or `.../edit` writes on the vendor's
behalf (brief D1). The form shows it is on their behalf, and the backend stamps
`updatedOnBehalf` and emails `fleet_updated_on_behalf`.

### The fleet screens

One form serves add, edit and duplicate — they differ only in where the initial
values come from, and duplicating in particular should not skip review, so the
copy still goes through submit with a blank serial.

The map is deliberately absent. Open item 1 in the brief puts the map provider
on hold, so `crane-form.tsx` renders no tiles and no third-party script; it
explains the situation and accepts typed coordinates, which is a working
fallback rather than a dead end. `backend/src/lib/geo.ts` is the seam where a
real provider drops in.

Two things are deliberately *not* offered for a crane SML has booked or hired:
the status dropdown carries only the three vendor-settable values, and the row
shows the status with a note that SML manages it. The backend refuses those
changes regardless.

### The vendor dashboard (brief 7.5)

One read, `/api/vendor/dashboard`, drives the whole screen. The response carries
the rows as well as the counters, because a counter that cannot be clicked is a
dead end: an awaiting-response row opens the RFQ detail, a due-for-update crane
opens its edit screen, a booking opens the crane. Overdue RFQs sort to the top
and colour red — a deadline the vendor missed is still worth seeing until it is
cleared. `ROLE_HOME` in `lib/auth.ts` sends a vendor here after sign-in.

### The award action (brief 6.7)

On the internal RFQ detail, the quotations table gains an **Award** button,
rendered for admins only and enabled only on an awardable row (latest version,
still `SUBMITTED`). It opens a confirm form that states what an award does —
selects this quote, reserves the crane for the requirement window and emails the
vendor; the other quotations stay open until the RFQ's quantity is awarded, when
the RFQ is finalised. When the RFQ's start date is TBC the form asks for the
reservation start and end dates, since there is nothing to derive them from. The
backend refuses a sales or non-awardable call no matter what the UI renders.

### Enquiry intake and workspace (P1)

The CR team captures an enquiry in `enquiry-form.tsx` (header plus any number of
line items) and sources each line separately. The line fields are the 31 the
cross-rental template carries, including the five scope terms — additional
manpower, intra-site movement, pre-release, PPE and ROW — and an internal-only
block (rental budget, PO/SAP reference, internal notes) that is badged and never
sent to vendors.

`enquiry-detail.tsx` shows the line's status **trail** as a fixed sequence, not a
dropdown: it is event driven (RFQ sent, quotation received, award booked), so the
only manual outcomes are the internal check and cancelling a line. The header
status is the derived roll-up and is displayed, never edited.

`enquiry-line.tsx` is the line workspace: vendor recommendations first (no SML
section — SML has no fleet here), then the RFQ history and quotations raised on
the line. **Raise RFQ** sends only a deadline; the backend prefills the RFQ from
the vendor-safe subset, so the customer, budget and internal notes cannot cross
over. Comparison and final selection arrive in a later phase.

### The RFQ screens

| Path                          | Who          | What |
| ----------------------------- | ------------ | ---- |
| `/app/rfqs`                   | admin, sales | Tracking list: status filters, search, awaiting-response, deadline countdown |
| `/app/rfqs/new`               | admin, sales | Create a draft |
| `/app/rfqs/$rfqId`            | admin, sales | Detail, candidate picker, dispatch, tracking |
| `/app/rfqs/$rfqId/edit`       | admin, sales | Edit a draft. Refused by the backend once sent |

`rfq-form.tsx` serves both create and edit, as `crane-form.tsx` does for cranes:
they differ only in where the initial values come from. `/app/rfqs` and
`rfq-detail.tsx` branch on role — a vendor gets the vendor screens rather than
the internal list, which the backend would refuse to load for them anyway.

The requirement block carries the phase A3 fields: capacity rule (at least /
exact) with a free-text note, application and load descriptions, structured
boom and jib lengths, a start-date-TBC switch (which drops the availability
question from the vendor's quote form) and, for month durations, the RFQ's own
working days per month used when the admin's day basis is set to working days.

### Vendor quotation screens (M5)

| Path                          | Who          | What |
| ----------------------------- | ------------ | ---- |
| `/app/rfqs`                   | vendor       | Inbox: response tabs, search, unread, deadline countdown |
| `/app/rfqs/$rfqId`            | vendor       | Requirement, quote form, the vendor's quotes, full version history |

The role branch happens **before** any query, in both routes. Branching partway
down would fire a request to the internal endpoint that a vendor cannot read, and
the screen would show a 403 instead of their own RFQ.

These read `/api/vendor/rfqs`, a separate surface from `/api/rfqs`, so they share
paths with the internal screens but no queries, types or endpoints.

What the quote form deliberately does not do:

- **No arithmetic.** Every figure — the running total, the stored total, the
  distance — comes from the backend. The browser never multiplies a rate out,
  because brief 6.4 fixes 30 days to a month and a second implementation would
  eventually disagree with the one that was emailed.
- **Warnings never disable the button.** They are listed with a confirmation
  checkbox, because a crane of the wrong type is advice for sales, not a refusal.
- **A load chart is requested only when the chosen crane has none on file.**
  A revision inherits the chart from the earlier version of the same crane's
  series, so it is not demanded again.
- **Whether a version can be acted on is not decided here.** The backend sends
  `editable` per quotation; the screen shows Revise and Withdraw from that,
  because "latest version", "still submitted" and "RFQ still open" are three
  separate conditions the client cannot see.
- **The preview is debounced**, since it is a server call per recalculation.

`apiUpload` in `lib/api.ts` posts a file together with ordinary fields, so a
submission can be mostly JSON with one optional attachment; booleans are
stringified because multipart has no other way to carry them, which the backend's
schemas accept on purpose.

These screens have no automated tests — the frontend has no test runner — so they
rest on typecheck, build and a manual walkthrough against a running server.

Three things this app deliberately does *not* do:

- **No map.** Same reason as the crane form: open item 1 puts the map provider on
  hold. The RFQ form takes typed coordinates and explains why.
- **No client-side candidate filtering.** The picker renders what the backend
  returned. Crane eligibility depends on availability dates, approval and
  freshness, and re-deciding it in the browser would let the screen and the send
  call disagree about what was offered.
- **No "send to these email addresses".** The picker selects *vendors*; the
  addresses come from the vendor record on the server. The field does not exist
  because it could not be made safe.

An approximate distance is labelled as one. When routing is unavailable the
backend returns a straight-line figure with `distanceApproximate`, and the picker
says so rather than presenting it as a road distance. Cranes with no coordinates
are listed in a separate group — a crane with no pin can still do the job, so
dropping it would be the wrong kind of tidy.

### SAP creation sheet and settings (phase D3)

`sap-sheet.tsx` renders `/api/vendors/:vendorId/sap-sheet` as a print-friendly
page in the SAP-aligned field order, with a **Print** button and an **Export**
button that downloads the SpreadsheetML `.xls` from `.../sap-sheet.xls` (the
download is streamed with the stored token, since a plain link could not carry
the Authorization header). Both endpoints are admin-only and neither is logged.

`settings.tsx` (admin only) edits the quotation day basis and the six SAP
office-use master lists. Each list is a textarea, one value per line; they start
empty, and `vendor-detail.tsx` offers their values as selects in the office-use
block, so the owner's SAP "Legal Form Logic" values can be entered without a
code change. An empty list still lets the admin approve — the select just has
nothing but "Not set" to offer, and the sheet prints a blank cell.

### Admin screen (phase P0 B)

`admin.tsx` (admin only) is the day's exceptions and the staff who run the
portal. The counters (registrations awaiting approval, RFQs with a failed email
delivery, cranes stale/no-map-pin/past-release) link to the list that filters the
same way where one exists — approvals, and RFQs with `?delivery=FAILED`; the
crane counters are counts only until the SML fleet screen arrives in P1. The same
screen lists the internal users: create one (OTP-only, no password), change a
role, enable/disable, or reset credentials. Vendor suspension lives on
`vendor-detail.tsx` — an admin sees a **Vendor access** section with Suspend
(optional reason) and Reinstate.

### Inline crane add (phase D2)

Inside the vendor quotation form, a "Crane not in your fleet? Add it here" toggle
opens the mandatory crane fields (brief 5.2) without leaving the page. It posts
through the same `createCrane` call as the fleet screen, then selects the new
crane for the quote — so a vendor who only notices the crane is missing while
reading the requirement is not sent away to add it and come back.

## Design tokens

Declared CSS-first in `src/styles/index.css` via Tailwind v4's `@theme`, per
`design.md`: brand red `#F1221C` as a three-stop gradient for primary actions,
slate chrome, and a badge palette shared with the backend's status vocabulary.
`statusTone()` in `components/ui/badge.tsx` maps a domain status to a tone so a
word never appears in two colours.

## Environment

| Variable             | Default | Purpose                          |
| -------------------- | ------- | -------------------------------- |
| `VITE_API_BASE_URL`  | `/api`  | base path for API calls          |
| `VITE_API_PROXY`     | `http://localhost:4000` | dev proxy target |

Only `VITE_`-prefixed variables reach the browser. Never put a secret here.