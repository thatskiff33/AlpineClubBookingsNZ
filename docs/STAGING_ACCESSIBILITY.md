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
- Seeded admin account after `prisma/seed.ts`: the `SEED_ADMIN_EMAIL` value
  from `.env.staging`.
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
  exec app npx tsx --conditions=react-server prisma/seed.ts
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
STAGING_APP_URL=http://localhost:3001 npm run review:staging:a11y
```

Use that command only after the staging health checks above pass. Without a
configured staging target, rely on the local static/component accessibility
contracts and leave the browser/Lighthouse pass as a named manual follow-up.

```bash
STAGING_BASE_URL=http://localhost:3001

npx --yes lighthouse "$STAGING_BASE_URL" --only-categories=accessibility --chrome-flags="--headless"
npx --yes lighthouse "$STAGING_BASE_URL/login" --only-categories=accessibility --chrome-flags="--headless"
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
  readers (`aria-label` gains ", selected as check-in/​check-out/​within your
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
- **Admin members table** (`src/app/(admin)/admin/members/_components/member-table.tsx`):
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
`roster-editor.tsx`, and this one).
