# Staging And Accessibility Verification

This is the non-production target for accessibility and other browser
verification. Use it whenever a release review or manual QA step should not run
against production.

## Target

Default local staging origin:

```text
http://localhost:3001
```

For shared staging, set `NEXTAUTH_URL` in `.env.staging` to the exact HTTPS
origin users will open, for example:

```text
https://staging.example.org
```

Record the actual origin used in the issue or PR that requested verification.
Do not infer a staging host from production DNS guesses.

## Auth Path

- Sign-in path: `/login`
- Seeded admin account after `run --rm seed` (which runs `prisma/seed.ts`):
  the `SEED_ADMIN_EMAIL` value from `.env.staging`.
- Required post-seed action for shared staging: change the seed admin password
  before sharing the environment.

For role-specific checks, create or update test members through `Admin > Members` after signing in as the staging admin. Do not copy production user credentials into staging.

## Start Local Staging

From a clean checkout:

```bash
cp .env.staging.example .env.staging
```

Edit `.env.staging` and replace the placeholder secrets:

```bash
openssl rand -base64 48   # AUTH_SECRET and NEXTAUTH_SECRET
openssl rand -base64 24   # CRON_SECRET
openssl rand -base64 24   # DB_PASSWORD
```

Start the non-production app and database:

```bash
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  up -d --build postgres app
```

Apply migrations and seed test data:

```bash
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  run --rm migrate

docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  run --rm seed
```

Verify the target:

```bash
curl -fsS http://localhost:3001/api/health
curl -fsS http://localhost:3001/api/health/ready
```

Stop it when finished:

```bash
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  down
```

Add `-v` to the final command only when you intentionally want to delete the staging database volume.

## Accessibility Run

Run checks against the staging origin, not production. The minimum
release-review sweep is:

The repository wrapper requires an explicit non-production target and refuses
to run when it is absent, so an agent must record the check as not run instead
of guessing a host or starting a shared/live server:

```bash
STAGING_APP_URL=http://localhost:3001 pnpm run review:staging:a11y
```

Use that command only after the staging health checks above pass. Without a
configured staging target, rely on the local static/component accessibility
contracts and leave the browser/Lighthouse pass as a named manual follow-up.

```bash
STAGING_BASE_URL=http://localhost:3001

pnpm dlx lighthouse "$STAGING_BASE_URL" --only-categories=accessibility --chrome-flags="--headless"
pnpm dlx lighthouse "$STAGING_BASE_URL/login" --only-categories=accessibility --chrome-flags="--headless"
```

For authenticated pages:

1. Sign in at `/login`.
2. Open each target page manually in the same browser profile.
3. Run Lighthouse or the browser accessibility tool against that staging URL.
4. Record the page URL, user role, tool, result, and any exception in the linked
   issue or PR.

Recommended route set for formal review:

- `/`
- `/login`
- `/book`
- `/dashboard`
- `/bookings`
- `/profile`
- `/admin/dashboard`
- `/admin/bookings`
- `/admin/members`
- `/lodge`
- `/finance`

Only include authenticated routes that the staging test account is allowed to
access. If a page depends on Stripe, Xero, SES, or finance data that is not
configured in staging, record the dependency and use seeded or demo data instead
of production credentials.

### Dialogs at high zoom

Every dialog built on the shared `DialogContent` caps its height to the viewport
and scrolls inside, because the page behind it is locked (#4967). The command
palette scrolls its own list instead, so its search box stays on screen. Side
sheets (`sheet.tsx`) are separate and not covered. At 400% browser zoom (about
320 × 256 CSS pixels), open a long confirmation, the manual-refund completion
dialog and the admin command palette. Scroll each to its final button or item
and activate it. Scroll back to the top to reach the close button, and check
that dropdowns open fully and dialogs with their own height cap still fit.
Dialogs that keep a fixed header and footer around an inner scrolling body
(`flex max-h-[90vh] flex-col`) are unchanged by #4967, so look at each of
those by hand: the body can get very little height at this size.
`pnpm run test:e2e:a11y-fixture` checks the shared dialog, confirmation and
command palette at 320 × 256 without a database.

## Shared Staging Notes

When promoting this target from local staging to a shared host:

1. Use a non-production domain and set `NEXTAUTH_URL` to that exact origin.
2. Use test-mode Stripe keys only.
3. Use Xero demo org credentials only when a test explicitly needs Xero.
4. Keep `CRON_ENABLED=false` unless the test explicitly needs scheduled jobs.
5. Leave backups disabled (the default) unless the test explicitly covers backup
   behavior; enable and configure them in-app at `/admin/backups` (#2095).
6. Verify `/api/health` and `/api/health/ready` before starting browser checks.
7. Record the staging origin and auth path in the review issue or release notes.

## Automated Axe Findings (2026-07-04)

The automated axe pass over the member flow and key admin pages (#1106) was
resolved as follows: row-select checkboxes and filter selects on
`/admin/members` carry accessible names, the booking wizard's working-bee
select and the booking detail preferred-room select are labelled, the wizard
step indicator and dashboard draft-expiry text meet AA contrast
(`text-gray-600` / `text-amber-700`), `/login` has a screen-reader `h1`,
wizard/profile heading levels descend without jumps, and the top navigation
and admin sidebar `nav` landmarks are labelled ("Primary" / "Admin
sections"). `/admin/bookings` select names and chip contrast were fixed by
the PR #1102 Radix conversion. The full manual pass described above remains
outstanding.

## Manual Staging Pass (2026-07-04)

Run against the local staging compose stack at latest `main` (post-#1123):
axe-core (WCAG 2.1 AA + best-practice) across 17 pages — public (`/`,
`/login`, `/register`, `/forgot-password`, `/booking-requests`), the
two-factor enrolment flow, member (`/dashboard`, `/book`, `/profile`,
`/bookings`), and admin (members, bookings, booking-requests, health,
stuck-states, booking-policies) — plus keyboard spot checks on `/login`.

Fixed in this pass (#1170): public request form guest labels/select
association, invalid `autocomplete` token in the address autocomplete,
theme-switcher inactive-label contrast, `.website-eyebrow` contrast under
themable brand colours, booking-calendar availability-count contrast, a
skip-to-content link on both website layouts (the `/login` form sat 28 tab
stops deep), and a `/forgot-password` h1.

Remaining (moderate/best-practice) — handed to the #1149 deep pass with
full axe data: missing h1 on `/login/enroll` and the admin pages, and
website-footer h3 heading order on sparse pages. Screen-reader (NVDA/
VoiceOver) walkthroughs remain a human task.

## #1149 Deep Pass — Booking Wizard And Admin Members (2026-07-04)

Fixed in this pass (booking wizard, date picker, admin members, plus the
configurable palette):

> **Superseded (2026-07, theme epic #2181).** The blocking contrast gate
> described in the first bullet below no longer exists. The theme moved to a
> **3-seed generated substrate** whose cross-colour contrast is guaranteed by
> construction, so a low-contrast pick is now **adjusted and disclosed**
> (before → after) rather than rejected, and the wizard accepts **hex only** (the
> oklch input path is gone). `getBlockingContrastWarnings` survives only as an
> advisory helper and gates no save. The record below is kept as the point-in-time
> state after #1149.

- **Colour contrast is now enforced, not just warned.** `getBlockingContrastWarnings`
  drives both the `/admin/site-style` API (`400` on a measurable sub-AA pair) and
  the wizard's disabled Save/Finish buttons, so an admin can no longer save a
  theme whose body/nav/button text falls below AA. Both accepted colour formats
  are measured — hex directly, and `oklch()` via an oklch→linear-sRGB conversion
  — because the wizard's value field accepts either, so neither can bypass the
  gate. The shipped default gold moved from `#7a8f6a` (3.55:1 button-on-gold) to
  `#8fa87c` (4.8:1) so first-run setup passes its own gate. A one-time,
  idempotent data migration (#1244,
  `20260705120000_bump_sub_aa_club_theme_gold`) bumps any persisted `ClubTheme`
  colour still holding `#7a8f6a` to `#8fa87c`, so existing installs converge on
  that intermediate compliant default without an admin re-save. The later
  `20260712100000_reseed_untouched_club_theme_teal` correction (#1832) advances
  only an incomplete theme still matching the complete post-#1244 generic sage
  defaults to the current teal defaults; completed, partially customised, and
  Tokoroa themes remain untouched.
- **Booking calendar** day buttons now expose their selected state to screen
  readers (`aria-label` gains ", selected as check-in/check-out/within your
  selected stay" and `aria-pressed` on the check-in/out days); previously only
  the blue highlight conveyed selection.
- **Booking wizard step indicator** is now a `nav > ol` with `aria-current="step"`
  on the active step and a visually-hidden `aria-live="polite"` "Step N of 4"
  region, so screen readers are told when a step auto-advances and its focus
  target unmounts (e.g. after the check-out date is picked). Errors already use
  `role="alert"`; dialogs use Radix (focus trap/restore handled).
- **Admin members table** sortable column headers are now real keyboard-operable
  `<button>`s inside `<th aria-sort>` cells (previously `<th onClick>` — not
  tabbable, no sort state announced).

Verified already-good (no change needed): `/book` and `/admin/members` each have
an `h1`; member filter selects, phone inputs, and row-select checkboxes carry
accessible names. Out of scope for this pass (booking wizard + admin members):
the broader admin-page h1s and footer heading order noted above, and NVDA/
VoiceOver walkthroughs.

## #1242 Static Heading Fixes (2026-07-05)

The two static findings carried over from the passes above were resolved in
code. This closes the static `page-has-heading-one` and `heading-order` axe
items; the live/manual walkthrough remains pending (item 3 below).

### Item 1 — `page-has-heading-one` (DONE, static)

The audit's page list was largely already satisfied in current `main`. Only
`/login/enroll` genuinely lacked a page-level heading. Verified state:

- **`/login/enroll` — added.** `TwoFactorEnrollPanel` used a `<CardTitle>`
  (renders as a `<div>`), so the page had no `<h1>`. Added a screen-reader
  `<h1 className="sr-only">` to both of the panel's mutually exclusive render
  branches (the enrolment card "Set up two-factor authentication" and the
  post-enrolment "Save your recovery codes" card), matching the existing
  `sr-only` `<h1>` pattern on `/login` and `/forgot-password`. Exactly one
  `<h1>` renders in any state; no visual change.
- **Already present, no change** (verified page-level `<h1>` in current `main`):
  `/forgot-password` (sr-only `<h1>` in both branches), `/admin/members`,
  `/admin/bookings`, `/admin/booking-requests`, `/admin/health` (one per
  loading/error/loaded state), `/admin/stuck-states`,
  `/admin/booking-policies/public-requests`.

### Item 2 — `heading-order` on `website-footer` (DONE, static)

The footer section headings (Quick Links, Affiliations) were `<h3>`, an
`h1 -> h3` skip on sparse pages. The markup is admin-editable stored HTML
(starter default + `20260702124500_add_site_content` backfill migration, kept
in sync by a test), not literal JSX, and the historical backfill uses
`ON CONFLICT DO NOTHING`, so editing the starter/migration would neither be
allowed nor change any existing deployment's rows. The fix is therefore a
render-layer normalization in `src/components/website-footer.tsx`:
`demoteFooterHeadings()` rewrites `<h3>` -> `<h2>` at render time and
`FOOTER_HTML_CLASSES` now styles `h2` identically to the old `h3`. Stored
content, the migration, and the sanitiser allowlist are untouched; the footer
now sits at `h2` under the page `h1` with no visual change.

### Item 3 — live keyboard-only walk (DONE, 2026-07-05, #1295)

Keyboard-only walk driven with Playwright against the running staging stack
(`:3101`, rebuilt from current `main`), as `wanda-waitlist` (booking wizard) and
`e2e-admin` (admin members). This exercised the #1149 fixes in a real browser
(they had only been analysed statically). **All three behave correctly; no code
fix was needed.**

- **Booking wizard** (`src/app/(authenticated)/book/**`,
  `src/components/booking-calendar.tsx`):
  - The 31 calendar day cells are native `<button>`s carrying `aria-pressed` and
    a descriptive `aria-label` (e.g. "Sunday, 5 July 2026, 12 of 14 beds free").
    They sit in the natural Tab order (first available day was reached at Tab
    stop 10, right after the Prev/Next-month buttons) and show a visible
    keyboard focus ring (`outline: auto 1px`; `:focus-visible` matches).
  - **Enter** picks the check-in day: `aria-pressed` flips to `true` and the
    calendar's `aria-live="polite"` hint updates "Select check-in date" →
    "Select check-out date". **Space** picks the check-out day and auto-advances
    the wizard.
  - The step indicator's visually-hidden `aria-live="polite"` announcer updates
    on auto-advance ("Step 1 of 4: Select Dates" → "Step 2 of 4: Add Guests"),
    and `aria-current="step"` tracks the active step. Note: on auto-advance the
    old step's focus target unmounts and focus falls back to `<body>` — #1149
    deliberately **announces** the transition via `aria-live` rather than moving
    focus, so this is the accepted design, not a gap.
- **Admin members table** (`src/app/(admin)/admin/membership/members/_components/member-table.tsx`):
  - The six sortable columns render real `<button>`s inside `<th aria-sort>`
    cells. They are keyboard-focusable with a visible focus-visible ring (2px
    `--ring` box-shadow). **Enter** toggles direction
    (`aria-sort` ascending → descending → ascending on Name) and **Space** sorts
    a new column (Email `none` → `ascending`); the arrow `SortIcon` and
    `aria-sort` convey state together.

Out of scope (unchanged): a **screen-reader (NVDA/VoiceOver) walkthrough by a
real assistive-technology user** remains a human manual-QA task. This automated
pass verifies focusability, focus order, the visible focus ring, keyboard
activation, and that the relevant ARIA attributes/live-regions update on
interaction — the legitimate DOM-level proxy — but does not substitute for a
real AT announcement check.

## #2779 Pay-Door Heading Semantics (2026-08-11)

Found while fixing a failing Playwright assertion on the locked-out
pick-up-and-pay journey, and the failure was telling the truth about the page
even though it was not telling the truth about the journey.

`getByRole("heading", { name: "Complete Booking" })` could never match, because
`CardTitle` (`src/components/ui/card.tsx`) renders a plain `<div>` with no role
— the same trap #1242 Item 1 hit on `/login/enroll`. On
`/bookings/[id]` that meant the **pay door itself** carried no heading
semantics: a member navigating by headings found the page `<h1>` "Booking
Details" and then nothing, on the one page a subscription-locked member is sent
to in order to pay for a booking the club saved for them.

Fixed on both payment cards in `src/app/(authenticated)/bookings/[id]/page.tsx`
— the DRAFT "Complete Booking" card and the "Complete Payment" card — with
`<CardTitle headingLevel={2}>`. Originally written as hand-rolled
`role="heading" aria-level={2}`; #2796 moved the mechanism into `CardTitle`
itself and now forbids call sites spelling it out, so both cards were migrated
onto the prop. It emits identical DOM — pinned by
`src/components/ui/__tests__/card-title-heading.test.tsx`, which renders both
forms and compares them — and the convention lives in `docs/ARCHITECTURE.md` →
"Card titles and heading semantics (#2796)". Level 2 sits directly
under the page's single `<h1>`, so there is no skipped level, and the two cards
are mutually exclusive (`DRAFT` is not a payment-owed status) so only one such
heading is ever present. No visual change: an actual `<h2>` would have been
picked up by `.app-theme-scope :is(h1, h2, h3, h4)` in `globals.css` and
restyled onto `--font-heading`, making this one card title look unlike every
other card title on the page.

**Still open, deliberately:** `CardTitle` renders a `<div>` app-wide, so most
cards in the product still have no heading semantics. Changing the primitive
touches every card in ~167 files and would put the wrong level on many of them,
so it is not a fix to make in passing — tracked in #2796, which also records
that this same trap has now been patched per-page three times (#1242,
`roster-editor.tsx`, and this one). Superseded for the member-facing screens
by #4951 below.

## #4951 Member Screen Headings and Tab Titles (2026-11-12)

Static fix. Two gaps a screen-reader user hits on the screens a member reaches
from an email link or their account:

- **No level-1 heading.** Each single-card screen's card title now renders as
  the page's `<h1>` (`headingLevel={1}`) in every render state: loading,
  invalid link, form, success, error. A loading state with no visible title
  carries an sr-only `<h1>`. Covered: `/pay/[token]` (including the "Checking
  your payment..." and redirect-return answer screens), `/reset-password`,
  `/change-password`, `/verify-email`, `/confirm-email-change`, `/login/magic`,
  `/family-invite/[token]`, `/membership-cancellation/[token]`,
  `/lodge-maintenance/[token]`, `/maintenance-report`, `/nominations/[token]`,
  `/notices/[id]`, `/join/[code]`, `/join/verify/[token]`,
  `/school-bookings/confirm/[token]`, `/lodge-instructions`,
  `/hut-leader-instructions` and the `/booking-requests` respond and verify
  screens. Pages that already had an `<h1>` (dashboard, bookings, a single
  booking, the guest-consent screen) give their cards level 2, including the
  shared cards only those pages render (recent news, message board, lodge
  kiosk, additional payment, confirm booking, waitlist offer, refund appeal,
  self-remove and group booking). A notice body is admin-written HTML, so an H1
  an admin puts in it is rendered as an H2 and the notice keeps one level-1
  heading. That is a small size change for that heading only.
- **Identical tab titles.** These routes now set a fixed page title that the
  root template turns into `<Page> | <Club>`: `/pay/[token]`,
  `/reset-password`, `/change-password`, `/verify-email`,
  `/confirm-email-change`, `/login`, `/login/magic`, `/family-invite/[token]`,
  `/membership-cancellation/[token]`, `/nominations/[token]`, `/notices/[id]`,
  `/dashboard`, `/bookings`, `/bookings/[id]`, `/bookings/consent/[guestId]`,
  `/lodge-instructions`, `/school-bookings/confirm/[token]` and the
  `/booking-requests` respond and verify screens. Client pages get theirs from a
  small server `layout.tsx`. Titles never carry a name, amount or token, and
  `/notices/[id]` is a fixed "Notice" so the title needs no second access check.

Pinned by `src/app/(public)/__tests__/single-card-screen-headings.test.tsx`,
`src/app/__tests__/member-token-screen-headings.test.tsx`,
`src/app/__tests__/client-loading-state-headings.test.tsx`, the `/pay` page
suite, and `src/app/__tests__/member-route-titles.test.ts`. The
`card-title-classification-census.test.ts` census keeps the member-facing
roots, and the shared member cards it lists, fully classified and ratchets the
remainder (`docs/ARCHITECTURE.md` -> "Card titles and heading semantics (#2796)").

Not done here, and still true after it:

- The admin and finance card titles, and the member components that several
  kinds of page share (the edit-booking panel, the booking editor and the
  guest-consent card), are swept by area, each sweep lowering the census
  baseline. Superseded by #5216 below.
- These member routes still show the default tab title: `/profile`, `/book`,
  `/induction`, `/maintenance-report`, `/forgot-password`, `/register`,
  `/login/verify`, `/login/enroll` and `/chores/[token]`. Superseded by #5217
  below, which titles them.
- Lodge and hut-leader instruction bodies are admin-written HTML shown as
  written, so an H1 inside one adds a second level-1 heading to that page.
  Superseded by #5218 below.
- The membership application page (`/join/apply`, under `src/app/(website)`)
  is outside the census roots. Its "Application submitted" state has no
  level-1 heading, and the right level depends on whether the page is embedded
  in a CMS page that already has one. Superseded by #5217 below.
- The collapsible profile cards put their level-2 title inside a `<summary>`.
  That is valid HTML, but whether each screen reader lists it in its heading
  list is untested.
- A real screen-reader walkthrough, which stays a human manual-QA task.

## #4949 Action Outcomes Announced (2026-11-14)

Member, payment and sign-in screens showed what had just happened (a declined
card, a wrong sign-in code, a finished cancellation) as a coloured box that
appeared already filled. Some screen-reader and browser pairs skip text inserted
that way, so a blind member could not tell whether the action worked. The rule
that now governs the surfaces below is in `docs/UX_FLOW_MAP.md` ("An outcome is
never a bare styled box"): a failure goes in `FocusedActionError`, a result or
progress line goes in a `StatusRegion` (a `role="status"` region mounted before
the request, one home in `src/components/status-region.tsx`), and a control
that disappears hands focus to the outcome that replaces it.

Surfaces fixed, each with a component test in `src/components/__tests__/`,
`src/lib/__tests__/` or beside its page:

- **Card payments.** `PaymentForm` (decline alert, and a success status that
  takes the focus Pay Now held), `SetupForm` (failed card save) and
  `BookingPaymentWrapper` ("Preparing payment..." status). Both forms own their
  failure, so the `onError` prop is gone and no caller shows the same decline a
  second time.
- **Pay-link page** (`/pay/[token]`). Loading and "Checking your payment..."
  status lines, the card-start and fresh-link failures as alerts, and focus on
  the "new link sent" confirmation and on "Checking your payment..." once the
  card form is gone.
- **Payment buttons.** Switch to internet banking and the guest payment link.
- **Cancel booking.** One frame keeps a status region and an error alert
  mounted across every step. Focus moves to each step's heading, back to
  **Cancel Booking** after "Keep booking" or "Try Again", and to the override
  reason when a cancellation is refused for want of a hosting override. The
  success panel lives in `cancel-booking-success-panel.tsx` with its wording
  unchanged.
- **Sign-in and account.** Forgot, reset and change password, both
  two-factor panels, the five profile cards (delete account, notification
  preferences, Google account, two-factor security, data export) and delete
  booking. Reset-password sets `aria-invalid` on each failing field, names its
  own error first in `aria-describedby` and focuses the first failing field.
  Change password has one form-level error and no field errors.
- **Other public flows.** The contact form, the booking-request reply page,
  and the membership-cancellation, nomination and partner-invite cards. Where the
  reply or confirmation replaces the button that had focus (booking-request
  reply, membership-cancellation and nomination cards), it takes the focus.

Stated limits:

- This is an automated, DOM-level check of roles, text and focus. It was not
  run with a real screen reader (NVDA, JAWS or VoiceOver), which remains a human
  manual-QA task as in the earlier sections.
- The axe scan in the browser tests (#4466) checks a page as it first settles,
  so it does not see text that appears only after an action. These component
  tests are what hold the announcements in place.
- Admin screens were out of scope.
- A status line that is on screen from the moment its screen first renders
  mounts already filled, so the "mounted before it is filled" rule cannot hold
  for it. The pay-link page's "Loading..." and `BookingPaymentWrapper`'s
  "Preparing payment..." carry `role="status"` but are not guaranteed to be read.
  The same holds for the pay-link page's "Checking your payment...": it replaces
  the whole page (a redirect return, #4955, or a card success), so the status
  region is mounted with the text in it and takes the focus.
- Not converted, because they are outside the locations #4949 lists: the
  "Preparing payment..." line in `StripeProvider`; in `AdditionalPaymentCard`, the
  "Loading payment details..." line, the box that reports a failure to load the
  payment form and its own "Payment successful!" panel; the "Payment complete"
  line on the organiser's group settlement; and the pay-link page's final
  "Payment received" card, which replaces the whole page; and the pay-link page's
  "Your payment did not go through" notice after a failed redirect return (#4955),
  which appears with the pay options, not after an action on that page. Each is
  plain text, not a status region.
- Several outcomes are both a live region and the element that takes focus (the
  cancel flow's loading line, the account-deletion confirmation, the fresh-link
  confirmation, "Checking your payment...", the payment success and the
  membership-cancellation and nomination confirmations). Whether a given screen
  reader reads such a line once or twice is untested, so the manual screen-reader
  pass should listen for it.

## #5217 Remaining Member Tab Titles and the Application Confirmation (2026-11-18)

Static fix, finishing the two items #4951 left open.

- **Tab titles.** `/profile`, `/book`, `/induction`, `/maintenance-report`,
  `/forgot-password`, `/register`, `/login/verify`, `/login/enroll` and
  `/chores/[token]` now set a fixed title, the same way as the #4951 routes.
  `/chores/[token]` is "Your chores": it carries neither the guest's name nor
  the token. `/register` only redirects to `/join/apply`, so its title shows
  for no longer than the redirect takes. With these, every page under
  `src/app/(public)`, `src/app/(authenticated)` and `src/app/(website-dynamic)`
  sets its own title, and `src/app/__tests__/member-route-titles.test.ts` now
  fails a new page there that sets none.
- **"Application submitted" on `/join/apply`.** The page's hero holds its
  `<h1>` and stays on screen when the form gives way to the confirmation, so
  the page never lacked a level-1 heading; what was missing was the
  confirmation itself, whose title only looked like a heading. It is now a
  level-2 heading under the page's `<h1>`, on `/join/apply` and on any CMS
  page that embeds the form, so someone who has just applied can jump to it.
  The form component can also draw the hero itself; there the hero goes away
  with the form, and the confirmation is level 1 instead. No visual change.
  Pinned by `src/app/__tests__/join-apply-state-headings.test.tsx`, which
  renders the real page and form together in each state.

Not done here, and still true after it:

- `/chores/[token]` shows only "Loading..." while it fetches, with no level-1
  heading in that state.
- The lodge kiosk screens under `src/app/(lodge)` are not member routes and
  still show the default tab title.
- The "Enter your details" card title on `/join/apply` is still unclassified,
  like the rest of the public website's card titles. Card-title classification
  is tracked in #5216. Superseded by #5216 below.

## #5218 Headings Inside the Lodge Instructions (2026-11-21)

Static fix, finishing the instructions item #4951 left open. An H1 an admin
writes in the lodge instructions is now rendered as an H2, as a notice body's
already is, on `/lodge-instructions`, `/hut-leader-instructions`, the lodge
kiosk's instructions section and the lobby display's rules card. Each of those
screens keeps its own one level-1 heading. That heading is drawn at heading-2
size; nothing else changes. The stored instructions and the admin editor keep
the H1 as written. Pinned by
`src/app/__tests__/instruction-screen-headings.test.tsx`, which renders each
screen from a stored document holding an H1. Since #5345 each source those
screens read is pinned too: the three instruction routes
(`/api/lodge-instructions`, `/api/lodge/instructions` and
`/api/lodge/instructions/preview`) and the lobby display state each have a
test that the same stored H1 comes back with no level-1 heading, in
`lodge-instructions.test.ts`, `lodge-instructions-preview-route.test.ts` and
`lodge-display-state.test.ts` under `src/lib/__tests__/`. Those tests do not
pin the level it lands on.

## #5216 Member card titles as headings (2026-11-22)

Static fix, the first of seven pull requests that sweep the card titles #4951
left unclassified. Each swept title is now a level-2 heading under its page's
one level-1 heading, so a screen-reader user can reach it from the heading
list. Nothing looks different: `CardTitle` draws the same element and classes
and adds `role="heading"` and `aria-level="2"`.

- **Swept.** 21 card titles in 14 files, each given `headingLevel={2}`: Stay
  Details, Guests and Payment in `booking-editor.tsx`; the eight cards of the
  Edit Booking panel in `src/components/edit-booking/` (dates, guests, account
  credit, price summary, admin override, admin request, the finished-stay
  correction, and promo codes, which has four titles); the guest-consent card's
  question and its two answers; "Admin tools", "Additional payment
  outstanding" and "Confirm pending guests now" on `/bookings/[id]`; and
  "Enter your details" on `/join/apply`.
- **Census.** `card-title-classification-census.test.ts` now fails an
  unclassified title in those 14 files and under `src/app/(website)/` (and,
  since #5372, anywhere under `src/components/website/`), and
  `UNCLASSIFIED_BASELINE` falls from 252 to 231, the 21 titles swept. All 231
  that remain are on admin and finance screens, still swept by area, each
  sweep lowering the baseline.
- **Outline helper.** `src/lib/__tests__/support/heading-outline.ts` is the one
  definition of the two outline checks: exactly one named level-1 heading, and
  no heading more than one level deeper than the one before it.

Pinned by `src/app/__tests__/booking-detail-card-headings.test.tsx` (the
officer's cards and the guest-consent card's three states on `/bookings/[id]`),
`src/components/edit-booking/__tests__/heading-outline.test.tsx` (the booking
editor and the Edit Booking panel in seven states) and
`src/lib/__tests__/support/heading-outline.test.tsx` (the helper's own six
cases). `src/app/__tests__/join-apply-state-headings.test.tsx` also asserts
that "Enter your details" is level 2 and that no state skips a level.

Stated limits:

- The booking-detail and edit-booking tests render the real cards under a
  hand-written `<h1>Booking Details</h1>`, not the real async `/bookings/[id]`
  page, so they would not notice a second level-1 heading added to that page.
  Since #5372 `issue-2779-draft-pickup-card.test.ts` reads the page's own file
  and fails unless it holds exactly one level-1 heading. It reads that file
  only, not the components the page renders.
- On the public website the census forbids an unclassified title under two
  folders: `src/app/(website)/`, the pages, which hold no card title, and,
  since #5372, `src/components/website/`, the cards those pages draw. A card a
  website page takes from any other folder is forbidden only if that folder is
  one of the member-facing roots or the file is on the census's list.
  Otherwise only the baseline count holds it.
- These are DOM-level checks of roles and levels. A real screen-reader
  walkthrough stays a human manual-QA task, as in the earlier sections.
