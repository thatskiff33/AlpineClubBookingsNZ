# Playwright E2E Suite

Browser end-to-end tests for the **Critical** journeys in
[`END_TO_END_TEST_MATRIX.md`](END_TO_END_TEST_MATRIX.md), driven against the
staging Docker Compose stack (`docker-compose.staging.yml`, compose project
`tacbookings-staging`) seeded with the base seed (`prisma/seed.ts`) followed by
the demo seed (`prisma/demo-seed.ts`).

## What is covered

| Spec | Matrix row | Journey |
| --- | --- | --- |
| `e2e/booking-create-rate-isolation.spec.ts` | Booking-create retry isolation (#2599, Medium) | Provider-independent real-route proof: unauthenticated attempt/retry probes stop at the auth boundary only after the production `bookingCreate` limiter runs, and read-only snapshots prove each exact synthetic-IP key advanced in the shared PostgreSQL `RateLimitCounter` store rather than the in-process fallback. Run before the waitlist and whole-lodge specs on the same prepared isolated stack. |
| `e2e/two-factor-login.spec.ts` | Global two-factor enforcement (Critical) | Forced TOTP enrollment on first login, recovery codes, protected-route gating for unverified sessions, wrong-code rejection, TOTP re-login, single-use recovery codes |
| `e2e/two-factor-email.spec.ts` | Global two-factor enforcement — email method (Critical) | Forced **email-code** enrollment on first login (send → capture the emailed code from the mailpit SMTP capture → enroll → recovery codes), then an email-code re-login that rejects a wrong code and accepts the emailed one. The code is read back over mailpit's HTTP API (`e2e/helpers/mailpit.ts`); no live mail provider is used |
| `e2e/booking.spec.ts` | Create booking with capacity lock (Critical) | Member books a bed through `/book` (confirm-details gate → dates → guests → review → payment step) with the booker **pre-selected by default** (#1680); while payment is owed the booking holds **no** bed (issue #737 — only committed money reserves capacity); the same member cannot hold the same lodge night twice; the booker can also opt out (remove themselves) and continue with another guest to a priced review |
| `e2e/adult-member-hosting.spec.ts` | Adult-member hosting enforcement and same-owner coverage (#2569, #2576; High) | Three serial journeys: the operator card saves and states the consequence and qualifying-host dimensions independently; an enforcing club refuses a booking with no qualifying adult-member cover and persists no live booking; and another booking on the same account supplies cover, after which member cancellation of that source is refused while an officer can acknowledge the exact stranded bookings and nights, give a private reason, cancel, and verify the resulting incident and audit evidence. The spec restores the shared club-wide hosting policy to **Disabled** in `afterAll` and cancels every booking it creates. |
| `e2e/locked-out-pickup-and-pay.spec.ts` | Locked-out pick-up-and-pay (#2779, Critical) | The journey the owner ruled the `HARD_BLOCK` payment-path asymmetry exists to serve (11 Aug 2026). The club is put into **Stop them booking** with the Xero module on — both snapshotted and restored in `afterAll`, because the lockout is inert while Xero is off and the mode gates every other spec's bookings. `lyle-lockedout@demo.alpineclub.test` is refused their own booking with 403 `SUBSCRIPTION_REQUIRED`; the admin then saves a **priced** on-behalf draft for them; the member's dashboard shows it labelled "Saved for you by the club" with a **Review & pay** control, and the booking page states both the pay control and the 72-hour deletion deadline; finally `create-payment-intent` admits that same still-unpaid member and the booking moves to `PAYMENT_PENDING`; the member's own draft list carries it at the price the admin quoted. The closing card charge is Stripe-gated and skips without test-mode keys. The pay step itself runs in BOTH modes and proves the admission in both, but the response it asserts is provider-shaped: 200 with a `clientSecret` where genuine test-mode keys are configured, and — where they are not, which is every fork's CI, since GitHub never hands a fork's `pull_request` run the repository secrets (#2820) — the post-admission provider failure (500, with the booking already moved to `PAYMENT_PENDING`, because the pay transaction commits before Stripe is called). Any refusal shape still fails the test. Window base index 28 (attempts 28 / 44 / 60), asserted disjoint from every other spec by `src/lib/__tests__/e2e-stay-window-disjointness.test.ts`. |
| `e2e/stripe-payment.spec.ts` | Stripe payment success/failure (Critical) | In-wizard step-4 card payment with Stripe test cards: `4242…` confirms the booking and the paid booking occupies its beds; `4000 0000 0000 0002` declines and leaves it payable. **Skips unless genuine Stripe test-mode keys are configured** |
| `e2e/admin-roles.spec.ts` | Role boundaries (High) | One persona per bundled access role (ADMIN_READONLY, ADMIN_BOOKINGS, ADMIN_MEMBERSHIP, ADMIN_CONTENT, FINANCE_USER, FINANCE_ADMIN, LODGE). Each asserts an in-area page renders and an out-of-area page is blocked (redirect), per the authoritative matrix in `src/lib/admin-permissions.ts` and the `/finance` (finance-auth) and `/lodge` (kiosk) gates |
| `e2e/waitlist.spec.ts` | Waitlist / force-confirm / offer (High) | Member is refused a seeded-full night and joins the waitlist (WAITLISTED); admin force-confirms it off the waitlist (overbook branch) through `/admin/waitlist`; member accepts a seeded, non-expired offer through the offer card; the admin waitlist surfaces offer + expiry state |
| `e2e/double-bed-sharing.spec.ts` | Partner relationship and reviewed bed-allocation removal (#1742, #2594, High) | Partner declaration/admission and shared-double placement. S4 previews then applies removal through the production `POST`/`PUT /api/admin/bed-allocation/allocations/removal` boundary and proves the surviving second occupant is promoted to primary. This is the production-stack shared-double consequence proof; stale refresh and permission affordances remain in focused component/route suites. |
| `e2e/bed-allocation.spec.ts` | Admin bed allocation, reviewed moves, booking confirmation, and reviewed removal (#2252, #2366, #2594, #2595, High) | Approves and allocates the seeded Ken booking, then proves every move entry point uses the reviewed confirmation seam. A pointer drop opens the dialog without writing, switches to **This person on this booking**, shows the exact changing/unchanged/total counts and approval consequence, and sends the typed scope plus preview digest only after confirmation while preserving the original lodge nights. A keyboard drop opens the same dialog, Cancel writes nothing and restores focus, and the chip menu can confirm a current-bed person-scope all-noop without changing placement or approval. The reviewed-removal journey opens the shared dialog from Reset, the chip menu, a pointer drop to the unallocated bucket, and booking detail; applies an approved person-wide removal with auto-allocation enabled; proves no replacement; and restores the exact guest-nights and approvals. Retry cleanup repairs a killed worker's placement and approval state through product APIs. |
| `e2e/internet-banking.spec.ts` | Internet Banking settlement (Critical) | With Xero **absent**, a card PAYMENT_PENDING booking is switched to Internet Banking; the detail page shows the Internet Banking card with a `BOOKING-…` reference and does not crash (the Xero invoice is queued but never sent while disconnected). Toggles the Xero + Internet Banking modules on for its run and restores them |
| `e2e/membership-application.spec.ts` | Membership application (High) | Public application submit; both nominators agree through the real `/nominations/<token>` pages; admin approves; the applicant then exists as a member |
| `e2e/additional-payment-chase.spec.ts` | Outstanding additional payment (#2350, High) | The officer loop for money still owed after a booking change: the bookings list filtered to **Additional Payment: Still owing** marks the booking **Partly paid** with the amount due (its status chip still reading Paid); the booking page's **Additional payment outstanding** panel names the amount and reports nobody has been chased yet; **Resend payment request email** sends and the message is captured from mailpit; a second click inside the hour is refused instead of sending. The owing booking is **seeded** (`ADDITIONAL_OWED_BOOKING_ID`) rather than raised through an admin edit, because raising a real one mints a Stripe PaymentIntent and this journey must run whether or not Stripe test-mode keys are configured |
| `e2e/admin-reports.spec.ts` | Base Reports stay-night reporting (#2368, Medium) | Selects the seeded CONFIRMED booking's three historical stay nights even though the row was created when the current demo seed ran; verifies its full $135 Booked Revenue allocation and booking-level Net Collected Cash, its one distinct guest/current status, and the deliberate 0% occupancy because utilisation remains PAID/COMPLETED-only. The browser then drives the From/To controls and verifies the Booked Revenue, Net Collected Cash, Outstanding Additions, and Booked Revenue by Day labels. |
| `e2e/member-guest-consent.spec.ts` | Member-guest consent (#2307, Critical) | A cross-family add persists PENDING; the target answers **Yes** on the booking page's `#consent` card and the guest list badge flips to Consented; on a second booking she answers **No** on an unpaid stay and the booker's guest list no longer names her. Plus the delegate route's privacy edge — a signed-in non-delegate, including the booker, gets one neutral page from `/bookings/consent/<guestId>` with no booking facts on it, indistinguishable from a fabricated id. Toggles the `memberGuests` module on for its run and restores it; books its own stay windows per attempt, because a PENDING row holds a person-night and a retry on the same nights would be refused by the member-night guard |
| `e2e/member-guest-find.spec.ts` | Member-guest finder + privacy (#2308, High) | One journey per find mode — exact email (the shipped default) and the name type-ahead a club has deliberately switched on — plus a module-off assertion that the surface is simply absent. Its browser assertions run LAST in the serial file, so a navigation failure cannot skip the privacy ones |
| `e2e/multi-lodge/member-guest-edit-path.spec.ts` | Member-guest edit path + admin parity (#2309, High) | Adding a member guest while EDITING a booking, in the multi-lodge project because the edit path reaches capacity and pricing through lodge-scoped code. A member opens an existing booking, asserts the Guests card header carries the signed-off two-button shape (`+ Add Member Guest` then `+ Add Non-Member Guest`, and no generic `+ Add Guest`), finds a cross-family member by exact email, sees the honest pre-save promise ("will be emailed when you save this change, and their bed is held until they answer") on the new row, saves, and the consent request lands in mailpit. Then a **Booking Officer** — the #1376 persona, deliberately, because the exact-email box has to work for a role with no membership access — does the same on another booking and gets the other rule: the admin sentence inside the opened finder states the member is added immediately and told, and the ADDED notice arrives rather than a consent request |
| `e2e/policy-exception-approval.spec.ts` | Booking-policy exception request → approve → execute (#2526, Critical) | A club-wide two-night minimum refuses a one-night stay, the member asks, and the officer's approval EXECUTES the reviewed proposal: the queue screen shows the request age and the rule it breaks, an unconfirmed approve and a reason-less refusal are both refused, a stale `expectedVersion` loses the guarded claim (409), and a NO_HOLD request the lodge can no longer fit stays REQUESTED with its conflict recorded and nothing created |
| `e2e/member-policy-exception-requests.spec.ts` | Member-facing booking-policy exception lifecycle (#2562, Critical) | The member's own half of the workflow, driven by clicking rather than by API. A club-wide two-night minimum is created for the run; a stay that MEETS it still books through to the payment step with no exception step (the regression guard); re-booking a night the member already holds is refused for a reason no officer can waive and offers **no** request action at all; a one-night stay is refused and the review step offers **Request Booking Officer approval**, which names the rule, echoes the exact proposal, says plainly that no beds are held and that approval is discretionary, refuses to submit without an explanation, and then shows the proposal the SERVER froze. **My booking-rule requests** on My Bookings then tracks it (pending → replaced → refused → approved), a duplicate create is refused with the replace-it-instead remedy, **Replace with a corrected request** returns to the wizard carrying `?replaceRequest=` and supersedes the original, and **Withdraw** closes one in two clicks. An officer decides on their own screen, typing BOTH note fields, and the internal note appears in neither the member's rendered page nor their API payload. The approval leaves a real booking the member's row links to. Finally the same section is asserted at a 390x844 viewport, and the edit-panel half raises a request whose capacity sentence is the modification path's own |
| `e2e/multi-lodge/policy-exception-second-lodge.spec.ts` | Same workflow, second lodge (#2526, Critical) | A rule configured for lodge B only, an exception raised there, and an approval whose booking must land AT lodge B: the queue reports the lodge the proposal was FROZEN against, and the created booking is present in lodge B's calendar and absent from the club default's — the lodge leak a missing `lodgeId` would cause, from both sides |
| `e2e/analytics-consent.spec.ts` | Google Analytics consent + safe routes (#2573, Critical) | The one guarantee no unit test can make: whether anything actually LEFT for Google. Every request to `googletagmanager.com`, `google-analytics.com` and `analytics.google.com` is recorded from before the first navigation (on `request`, not `requestfinished` — a blocked request is still a request that left), and the expected count before the visitor clicks **Accept** is zero. Anonymous throughout, with the `analytics` module toggled on for the run and restored, and the measurement id saved and cleared through `PUT /api/admin/integrations/analytics`. Six journeys: the **hard cutover** state every club is in straight after the upgrade — module on, no measurement id saved, so nothing loads and no banner or footer link appears; **banner enabled**, where nothing at all reaches Google before Accept and only the saved id's loader is fetched after it; **decline**, which loads nothing and is honoured on reload; an **excluded route** (`/login`) with the banner OFF, i.e. the most permissive configuration there is, which must still load nothing; a **soft navigation off the public website** — the header's own "Log In" link, clicked rather than `page.goto()` — after which the runtime is unmounted and Google's per-id kill switch must read `true`, because unmounting a script element cannot unload a library the browser already executed; and **banner disabled**, where the tag loads unasked but the footer's **Analytics preferences** control still opts the visitor out and that opt-out survives a reload (the owner's clarification 1). Uses a deliberately fake `G-E2E0TEST00` — Google 404s an unknown id, which is all this needs, since every assertion is about whether a request was made and what URL it carried, never about a response, so no real property is touched and no measurement data is sent. Because that 404 stops the gtag library executing, the `page_location` check inside it is conditional and is NOT the proof of URL sanitisation: `analytics-route-policy.test.ts` and `analytics-consent.test.tsx` own that |
| `e2e/unmatched-url-status.spec.ts` | No matrix row — regression guard for #2405 (Medium) | The status LINE for URLs nothing serves, which only a running server can show. Anonymous throughout, because these are the shapes a crawler or a scanner asks for. Unmatched website URLs (`/definitely-missing`, `/wp-admin/setup-config.php`, `/.env`, `/admin/nope`) must each answer **404** *and* still render the club's own seeded `/404` CMS screen — pinned on the level-1 heading plus the seeded header text, since that page emits the same words as an `h2` as well and the hardcoded emergency fallback would otherwise satisfy a looser assertion. `/about` must still be **200**. Unmatched `/api` URLs — bare `/api` and `/api/` included — must answer a JSON 404 rather than ~23KB of HTML, with `POST` answered identically and `HEAD` carrying GET's `content-type`. `/api/health` must be untouched. Depends on `SEED_THEME_COMPLETE=1`: without it the layout's holding screen answers every URL with 200 |
| `e2e/asset-url-404.spec.ts` | No matrix row — regression guard for #2404 (High) | The CSP on the static-asset URL shapes, which only a running server can show. Anonymous throughout — these are the addresses scanners and stale browser tabs ask for. A MISSING asset (`/foo.png`, `/favicon.ico`, `/logo.png`, `/wp-content/uploads/x.jpg`, `/branding/definitely-missing.png`, `/_next/static/chunks/nope.js`) must answer **404 with an empty body, no `content-type`**, the app's security headers, and a policy from the app rather than the edge — either the terminal route's own `default-src 'none'` or the proxy's nonced page policy, since #2404 closed this from both directions and `src/proxy.ts` now runs on image-extension URLs. `/_next/static/…` is the one shape the proxy still skips, so the exact `default-src 'none'` is pinned on it. Never the ~29KB HTML 404 page, which shipped inline scripts with no nonce and no CSP header at all. A REAL asset must still be served: `/branding/favicon.example.ico` and a `/_next/static/chunks/*.js` URL taken from a live page render both 200 with their bytes, which is the assertion that catches an `afterFiles` -> `beforeFiles` slip turning every image in the app into a 404 — and the `public/` one now also carries `nosniff`, `X-Frame-Options` and a nonced policy, which is the runtime check that running middleware on static assets disturbs nothing. An ADMIN-UPLOADED image must also still be served: the spec uploads a 1x1 PNG through `/api/admin/image-manager/upload` (the uploads directory is a container volume the seeds never populate), fetches it back **anonymously** at `/api/images/uploaded/<file>` and asserts 200 with the same bytes and `image/png` — the guard against an asset rule swallowing every uploaded picture in the app — while a missing one still gets that route's own JSON 404. `/_next/staticfoo`, `/_next/imagemap`, `/_next/image/x`, `/apiary` and `/api-docs` must carry a nonced policy (the bare-prefix exclusions anchored in #2404 and #2420). `/definitely-missing` must still render the club's own 404 screen, fully nonced — nothing here may blank a human-plausible mistyped address. Asset-shaped `/api` URLs are probed on two axes. Ones no handler claims (`/api/does-not-exist.png`, `/api/definitely-missing.jpg`, `/api/nope/deeper.webp`) must answer the frozen JSON 404; ones a real handler DOES claim (`/api/chores/zzz.svg` is `[token]`'s, `/api/admin/lockers/zzz.png` is `[id]`'s) must answer as that handler does and must never be diverted to the empty asset 404. Both are sent **with `RSC: 1` and a query string** and must carry neither `x-nextjs-rewritten-path` nor `x-nextjs-rewritten-query` — that request shape is the only one in which either header can be set, so without it the assertion cannot fail, and their presence in one module state and not the other is #2405's module-state oracle. Mixed case is pinned separately and the other way round: `/API/x.png` and `/API/images/uploaded/<file>` must render the club's own nonced 404 page rather than reach an `/api` handler, which is what proves the `(?!api/)` lookahead excludes the namespace case-insensitively instead of leaving a seam |
| `e2e/print-dark-mode.spec.ts` | No matrix row — regression guard for #2146 (Medium) | Renders `/admin/reports` and `/finance` as the Full Admin with the app in **dark** mode, then flips the page to print media (`emulateMedia({ media: "print", colorScheme: "dark" })`) and asserts the computed ink is dark on a light surface — the blank-looking export in #2146 was near-white text on a forced-white card. Also asserts dark mode really is applied on screen first (so the check cannot pass vacuously), that `.dark` is still on `<html>` while printing (print wins *despite* the theme, not by switching it off), and that the printed colours are identical with and without the theme class. The only browser coverage of print/theme interaction; every other guard is a source-text parser |

Not covered by browser tests (by design):

- **Waitlist offer creation + expiry** — run only by the in-process scheduler
  (`src/lib/cron-waitlist.ts` via `instrumentation.node.ts`); `CRON_ENABLED` is
  off in staging and there is **no** HTTP waitlist-cron endpoint, so these are not
  browser-reachable. The offer/expiry *state* is asserted via the admin UI on the
  seeded (expired) offer; the transitions themselves are unit-tested
  (`src/lib/__tests__/waitlist.test.ts`).
- **Webhook signature classes** (Stripe/Xero/SES valid/duplicate/malformed/
  oversized/wrong-signature) — covered by targeted route tests (issue #1133), not
  browser flows.
- **The email delivery of nomination links** — outbound mail is captured by the
  local mailpit container (no live provider), but the membership spec drives the
  confirmation pages using seeded tokens rather than parsing the captured email
  (see below). Only the email-code two-factor spec reads a captured message back.
- **The AI help assistant LLM path** (`POST /api/help/chat`, #2211) — answering a
  free-text question requires a live paid Anthropic API key, which is never
  configured in CI or staging (no key ⇒ the route returns a structured
  `not_configured` fallback), and calling a real paid model from a browser test
  would be non-deterministic and cost money. The entire path — gate order,
  surface downgrade, budget cap, metering, and the SDK error taxonomy — is
  instead covered by jsdom-mocked Vitest suites
  (`src/app/api/help/chat/__tests__/route.test.ts`,
  `src/lib/__tests__/anthropic-client.test.ts`,
  `src/lib/__tests__/ai-assistant-usage.test.ts`) with the SDK and provider
  mocked, which is the deliberate substitute for browser coverage here.

Not covered yet, but tracked for addition (issue #1373 — restored to this list
so the gaps are not silently implied as covered):

- **Stripe refund, cancellation-with-refund, saved card, and member credit** —
  `e2e/stripe-payment.spec.ts` covers only test-mode payment success + decline;
  the refund/credit money outcomes stay Vitest/service-tested until the
  cancellation-with-refund browser spec lands.
- **Admin approve → bed allocation** — the `bedAllocation` module is enabled on
  the staging stack, but the approve-then-allocate journey has no browser spec
  yet.
- **Access-role management** (create → edit → assign a role definition) — the
  role *boundary* matrix is covered by `e2e/admin-roles.spec.ts`, but role
  *management* is not yet browser-tested (deferred from #1134).

## Running locally

```bash
cp .env.staging.example .env.staging   # once; adjust ports if taken
npm run test:e2e                       # prepare stack + run suite
```

`npm run test:e2e` (via `scripts/e2e-stack.sh`) does the following:

1. Starts the staging compose Postgres (host port `STAGING_POSTGRES_PORT`,
   default 5433 — **never** the production 5432).
2. Drops and recreates the `public` schema, then runs `prisma migrate deploy`,
   the explicitly opted-in demo seed, and the create-if-missing base seed, so
   every run starts from a known state without placing non-demo members in the
   database before the destructive demo seed guard runs. It then enables the
   modules the E2E journeys need (`e2e/setup/enable-e2e-modules.ts`) — a fresh
   database defaults these off:
   `twoFactor` (two-factor enforcement), `waitlist` (`/admin/waitlist`,
   force-confirm, waitlist-confirm), `kiosk` + `chores` (`/lodge/*` and the
   roster, for the LODGE role boundary), `financeDashboard` (`/finance`, for
   the finance role boundaries), and `bedAllocation` (`/admin/bed-allocation`,
   `/admin/rooms-beds`, for the bed-allocation board). `internetBankingPayments`
   and `xeroIntegration` stay off; the internet-banking spec toggles them on for
   its own run (via
   `PUT /api/admin/modules`) and restores them, so the rest of the suite keeps
   the default card-payment flow.
3. Builds (unless `E2E_SKIP_APP_BUILD=1`) and starts the staging app on
   `STAGING_HTTP_PORT` (default 3001), waiting for `/api/health/ready`. The app
   depends on the **mailpit** SMTP capture container, so it starts alongside the
   app (see "Email capture" below).
4. Runs `playwright test` with `E2E_BASE_URL` pointed at the staging app and
   `E2E_MAILPIT_URL` pointed at the mailpit HTTP API.

Other entry points:

```bash
npm run test:e2e:prepare   # stack + fresh database only
npm run test:e2e:run       # suite only (stack already prepared)
npm run test:e2e:run -- --ui               # Playwright UI mode
npm run test:e2e:run -- e2e/booking.spec.ts # one spec
npm run test:e2e:down      # stop the stack and delete its volumes
```

First-time setup: `npx playwright install chromium` — the same command CI runs (see "How CI installs the browser" below).
The HTML report lands in `playwright-report/`; traces and screenshots for
failures land in `test-results/`.

The suite is serial (one worker) on purpose: specs assert on lodge capacity
and share seeded personas, so they must not interleave.

## Multi-lodge project (issue #1568)

A small `multi-lodge` Playwright project — a **blocking** CI check since #1655
(launched advisory in #1623) — covers the
cross-lodge behaviours the default single-lodge suite cannot exercise: the
`/book` lodge-selection step and per-lodge availability isolation, a
capacity-holding booking at lodge B not consuming lodge A's capacity, a kiosk
bound to lodge B never seeing lodge A's roster, the cross-lodge waitlist
offer → confirm happy path, and a booking-policy exception raised at lodge B
being decided and EXECUTED there rather than at the club's default lodge.

It is opt-in and gated on `E2E_MULTI_LODGE=1`, so the default suite is entirely
unaffected:

- **Seed:** with `E2E_MULTI_LODGE=1`, the prepare step runs
  `e2e/setup/seed-second-lodge.ts` after the base seed to provision a second
  active lodge ("Second Lodge (E2E)") with its own rooms/beds and Winter/Summer
  seasons (mirroring lodge A's rates), bind the demo LODGE kiosk persona to it,
  and seed the roster/capacity/cross-lodge-offer fixtures. Multi-lodge is a
  core capability, not a module flag, so seeding the second lodge is the only
  precondition — no module needs enabling.
- **Project:** the `multi-lodge` Playwright project is only added to
  `playwright.config.ts` when `E2E_MULTI_LODGE=1`, and the default `chromium`
  project always ignores `e2e/multi-lodge/`, so the default suite's project and
  spec list are byte-identical (verify with `npx playwright test --list`).

Run it locally (uses the same staging stack; keep off ports 5432/3001 in use):

```bash
E2E_MULTI_LODGE=1 npm run test:e2e:prepare              # stack + second lodge
E2E_MULTI_LODGE=1 npm run test:e2e:run -- --project=multi-lodge
```

This project is a **coverage aid, not a substitute** for the manual two-lodge
staging matrix in `docs/multi-lodge/test-plan.md`, which remains the hard gate
before enabling multi-lodge in production.

## Environment

Configuration comes from `.env.staging` (override the path with
`E2E_ENV_FILE`). Keep placeholder provider keys — the suite never needs live
providers, and `scripts/e2e-stack.sh` refuses to run if it sees `sk_live`/
`pk_live` Stripe keys.

- `E2E_BASE_URL` — target app (default `http://localhost:$STAGING_HTTP_PORT`).
- `E2E_MAILPIT_URL` — mailpit HTTP API for reading captured mail (default
  `http://localhost:$MAILPIT_HTTP_PORT`, i.e. `http://localhost:8025`).
- `E2E_DEMO_PASSWORD` — only if the demo seed ran with a custom
  `DEMO_SEED_PASSWORD`.
- Personas: the suite signs in as `alice@demo.alpineclub.test` (PAID
  subscription; books and pays), `bob@demo.alpineclub.test` (drives TOTP
  two-factor enrollment), and `evan@demo.alpineclub.test` (drives email-code
  two-factor enrollment). TOTP secrets and recovery codes captured during
  enrollment are stored under `e2e/.auth/` (gitignored) and cleared at the
  start of each run; the email-code persona needs no stored secret because its
  code is read live from mailpit each time.
- Stay dates are computed relative to today (Monday–Wednesday windows at least
  three weeks out). Since #2117 the E2E DB's booking **seasons are also
  relative**: `e2e/setup/relativize-seasons.ts` (run by `scripts/e2e-stack.sh`
  after the base seed) re-dates them to the broad Winter/Summer bands defined in
  `SEEDED_SEASONS` (`prisma/e2e-fixtures.ts`), which always bracket the seeded
  fixtures and the stay-window horizon. Likewise **every seeded booking date is
  relative** (`DEMO_BOOKING_WINDOWS` / the window fixtures in
  `prisma/e2e-fixtures.ts`), so nothing rots red as wall-clock advances and the
  seasons never need manual extension. The production first-run seed
  (`prisma/seed.ts`) keeps its fixed real-world season dates — only the demo/E2E
  database is relativized.

## Seeded fixtures and personas

The demo seed (`prisma/demo-seed.ts`) writes deterministic E2E fixtures behind
its explicit local demo-only guard (`ALLOW_DEMO_SEED=1`, non-production,
local `DATABASE_URL`, and no non-demo member emails), shared with the specs through
`e2e/helpers/fixtures.ts` so seed data and assertions never drift:

- **Scoped-role personas** — one member per bundled access role
  (`readonly-admin@`, `booking-officer@`, `membership-officer@`,
  `content-manager@`, `finance-viewer@`, `treasurer@`, `lodge-user@`
  `demo.alpineclub.test`), each seeded with a single `MemberAccessRole` row via
  `ensureMemberAccessRoles`. `admin-roles.spec.ts` derives its expectations
  straight from `src/lib/admin-permissions.ts`, not hand-written rules.
- **`e2e-admin@demo.alpineclub.test`** — a full ADMIN with the demo password.
  The base seed admin forces a password change and uses an unknown password, so
  it cannot drive logins; this persona approves applications and toggles modules.
- **Waitlist fixtures** — a September window filled to capacity (lodge capacity
  is 20, from `config/club.example.json`) so a fresh booking there is refused,
  plus a ready-to-accept `WAITLIST_OFFERED` booking. Both are owned by
  **`wanda-waitlist@demo.alpineclub.test`**, a member seeded PAID with a
  **complete, self-confirmed profile** so she can create a booking through the
  API without the member-details gate. (alice is intentionally left with an
  unconfirmed profile so `booking.spec.ts` keeps exercising that gate, #1124.)
- **`lyle-lockedout@demo.alpineclub.test`** (#2779) — a member with the same
  complete, self-confirmed profile as `wanda-waitlist@` but an **UNPAID**
  current-season subscription, and a `xeroContactId` so the create route reaches
  the subscription gate rather than refusing them earlier with
  `XERO_CONTACT_REQUIRED`. Nobody else logs in as them or asserts on their
  bookings, so `locked-out-pickup-and-pay.spec.ts` can switch the club's lockout
  mode and the Xero module on for its own run.
- **Internet-banking fixture** — a card (Stripe) `PAYMENT_PENDING` booking owned
  by the complete-profile `wanda-waitlist@` member, far enough out to clear the
  internet-banking lead-time cutoff.
- **Membership application** — a `PENDING_NOMINATORS` application whose two
  nomination tokens have **known raw values**. `src/lib/action-tokens` hashes
  tokens with a plain SHA-256 (no secret), so the seed stores
  `sha256(<known token>)` and the spec drives `/nominations/<token>` directly —
  the email that would normally carry the link is unconfigured on staging. Both
  seeded nominators (`wanda-waitlist@`, `nadia@`) have complete, confirmed
  profiles so the onboarding modal never blocks their nomination pages.

Because these fixtures (and the two-factor enrollment) mutate seeded state, the
suite is designed to run against a **fresh** prepare each time; re-running
`test:e2e:run` without a preceding `test:e2e:prepare` is not supported.

## Browser system dependencies

Playwright's Chromium needs the usual Linux browser libraries. On a host that
is missing one (commonly `libasound.so.2`, which surfaces as
`error while loading shared libraries: libasound.so.2`), install them with
`npx playwright install-deps chromium` (needs root), or, without root, extract
the package and point the loader at it:

```bash
apt-get download libasound2t64 && dpkg -x libasound2t64*.deb extracted
LD_LIBRARY_PATH="$PWD/extracted/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH" \
  npm run test:e2e:run
```

### How CI installs the browser

Both E2E jobs get their browser from the composite action
`.github/actions/playwright-browsers`, and the order it works in is the point:

1. **Restore `~/.cache/ms-playwright`**, keyed on the resolved `@playwright/test`
   version, so a version bump misses the cache and nothing else does.
2. **`npx playwright install chromium`** — run even on a cache hit, where it is a
   ~2s no-op that verifies the restored tree and re-downloads anything partial.
3. **Launch the browser and render a page** (`launch-check.mjs`). A browser that
   launches and lays out a page has every system library it needs.
4. **Only if that check fails**, run `npx playwright install-deps chromium` and
   re-check.

CI used to run `npx playwright install --with-deps chromium` on every run
instead. It was measured at 9m15s on one run (job 32304150140, 19 Aug 2026)
against a ~25s norm, and the split is why the order above changed: the browser
downloads took **ten seconds**, and the rest was `apt-get update` plus seven and
a half minutes of unpacking X fonts and libraries that the `ubuntu-latest`
runner image already ships. That apt step is also the one that fails outright
when the runners' preinstalled third-party apt sources serve invalid clearsigned
metadata (#1634), so the retry loop that was there to survive it was retrying a
nine-minute step. Now apt is the recovery path, not the default one, and a
future runner image that genuinely drops a library still repairs itself
unattended — it just costs those nine minutes when it happens rather than always.

No spec takes a pixel snapshot, so the fonts the old command installed cannot
move an assertion.

## Enabling the Stripe payment specs

The Payment Element requires a genuine Stripe **test-mode** account; the
payment specs skip (loudly) when the keys look like placeholders and refuse to
run at all against `sk_live`/`pk_live` keys (both `scripts/e2e-stack.sh` and
`e2e/helpers/stripe.ts` guard this).

Two env vars carry the keys, and they flow into the stack differently:

| Var | Kind | How it flows |
| --- | --- | --- |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`pk_test_…`) | Build arg | `docker-compose.yml` passes it as a Docker build `arg`; Next.js **inlines** it at build time, so the app image must be **rebuilt** when it changes. |
| `STRIPE_SECRET_KEY` (`sk_test_…`) | Runtime env | Passed to the `app` container at runtime; picked up on restart, no rebuild needed. |

- **Locally**: put both real test-mode keys in `.env.staging`, then run
  `npm run test:e2e` (not `test:e2e:prepare` with `E2E_SKIP_APP_BUILD=1`) so the
  app image is rebuilt with the new publishable key. `e2e-stack.sh` parses
  `.env.staging` and exports both vars, so the Playwright process also sees them
  and stops skipping.
- **CI**: provide `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_PUBLISHABLE_KEY`
  repository secrets; `.github/workflows/e2e.yml` maps them onto the two vars
  above. The workflow refuses live keys. **Never commit real keys anywhere.**

## Email capture (mailpit)

The staging stack runs a **mailpit** SMTP capture container
(`docker-compose.staging.yml`, image `axllent/mailpit`) so the email-code
two-factor spec can enroll and re-login for real: the app relays every outbound
message to mailpit and the spec reads the emitted code back over mailpit's HTTP
API. No live mail provider is ever contacted — mailpit accepts any SMTP
credentials and forwards nothing.

The wiring is entirely non-production and lives only in the staging override and
the E2E env files:

- The staging app sends into a **declared local capture mailbox** rather than to
  SES: the three provider flags resolve to `USE_AWS_SES=false`,
  `USE_SMTP_RELAY=false`, `USE_LOCAL_CAPTURE=true`, and the relay itself is
  `EMAIL_SERVER_HOST=mailpit` / `EMAIL_SERVER_PORT=1025` with dummy
  `EMAIL_SERVER_USER` / `EMAIL_SERVER_PASSWORD` (see `.env.staging.example` and
  the CI env writer in `.github/workflows/e2e.yml`). All four `EMAIL_SERVER_*`
  vars must be present and exactly one provider flag may be true, or
  `resolveEmailDeliveryConfig` returns `invalid`.

  **The three flags are hard-coded in `docker-compose.staging.yml`**, not read
  from the env file, for the same reason `APP_ENVIRONMENT_ROLE` is: a stray value
  in whatever env file this stack is handed must not be able to point an
  accessibility or browser run at a real provider. The lines in
  `.env.staging.example` are documentation of what the stack resolves to, and are
  overridden. `EMAIL_SERVER_*` and `EMAIL_FROM` still come from the env file,
  through the base file's shared `x-app-environment` anchor.

  **A variable must be NAMED in a compose file to reach the container at all.**
  `--env-file` feeds Compose *interpolation* only; it injects nothing. #3035's
  first cut set `USE_LOCAL_CAPTURE=true` in `.env.staging.example` and in both CI
  heredocs while no compose file named it, so the container saw two false flags
  and no capture declaration — mode `invalid`, transport `unresolved`, every send
  suppressed as a *normal* outcome at info level with no error anywhere, and five
  mail-reading specs failing on an empty mailbox.
  `env-delivery-census.test.ts` now asserts the RENDERED environment of every app
  service in every stack, which is the only check that can see this.

  **`USE_LOCAL_CAPTURE`, not `USE_SMTP_RELAY`, and the difference is
  load-bearing** (ENV-SAFETY 2, #3035; `INV-CONFIG-004`). The staging stack
  declares `APP_ENVIRONMENT_ROLE=non-production`, and a non-production
  installation SUPPRESSES every send rather than contacting a provider — that is
  the whole point of epic #2986. An ordinary SMTP relay counts as a live provider
  however it is configured, so a stack relaying to mailpit as
  `USE_SMTP_RELAY=true` would capture nothing at all and every mail-reading spec
  would fail with an empty mailbox and no explanation.
  `USE_LOCAL_CAPTURE=true` declares that this transport is a sink which forwards
  nothing, and such a copy is then allowed to transmit into it. Nothing is
  inferred from the host name. `email-delivery-boundary-census.test.ts` fails any
  tracked stack that points at mailpit without declaring it.
- mailpit's HTTP API is published to the host on `MAILPIT_HTTP_PORT`
  (default 8025). `scripts/e2e-stack.sh` exports `E2E_MAILPIT_URL` so the
  Playwright process can reach it; `e2e/helpers/mailpit.ts` reads and clears
  captured mail there. Change `MAILPIT_HTTP_PORT` if 8025 is taken.
- The `app` service `depends_on` mailpit, so `up --wait app` brings mailpit up
  with the app and `test:e2e:down` tears it (and its data) back down.

The `two-factor` module is already enabled for the run by
`e2e/setup/enable-e2e-modules.ts`; the email-code path needs no extra module.

## CI

`.github/workflows/e2e.yml` runs the suite on PRs and pushes to `main`. It is a
**blocking gate** — a red E2E job fails the workflow (promoted from advisory in
#1315 after a stable green window on `main`). Check the job log and the uploaded
`playwright-report` artifact when it goes red.

Note on scope: `main` is branch-protected and `Playwright E2E` is one of the
required status checks, so a red E2E run hard-blocks a (non-admin) merge.
Because `enforce_admins` is off and no review approval is required, an admin
merge can still occasionally land `main` red, so compare against `main`'s own
latest CI before assuming an unrelated failure is yours.

The Stripe payment specs remain an environment dependency: they run only when
the `STRIPE_TEST_SECRET_KEY` / `STRIPE_TEST_PUBLISHABLE_KEY` repository secrets
hold genuine Stripe **test-mode** keys, and otherwise `test.skip` cleanly (they
are also retry-scoped to absorb the datacenter-IP Link/hCaptcha flake). So a
green E2E run does not imply Stripe E2E coverage ran unless those secrets are set.
One exception, added in #2820: the pay-step test in
`e2e/locked-out-pickup-and-pay.spec.ts` does **not** skip — it runs in both
modes and asserts the provider-shaped response (200 with a `clientSecret` when
genuine test-mode keys are configured, and the post-admission provider failure
when they are not), because the admission it proves is what #2779 turns on and
needs no provider.

The same workflow also runs a separate **`E2E multi-lodge`** job (the
`multi-lodge` project, above), and it too is a required status check: launched
advisory in #1623 and promoted to blocking in #1655 (the #1315 precedent) after
its observation window — the one observed flake class was root-caused and fixed
test-side in #1650, and the job's first functional run caught a real product
bug (#1628). A red run blocks a (non-admin) merge exactly like `Playwright
E2E`; check the job log and the `playwright-report-multi-lodge` artifact when
it goes red. It stays a separate job so the second-lodge seed never reaches
the single-lodge stack the main suite asserts on.

## Harness stability (keep-alive socket race)

Playwright's `apiRequestContext` reuses pooled keep-alive sockets. The Next.js
standalone server (`node server.js`) defaults to Node's 5-second
`keepAliveTimeout`, which is *shorter* than the gaps a spec's setup leaves
between API requests. The server would close an idle socket, the client would
reuse it for the next request, and the connection reset surfaced as an
intermittent `apiRequestContext.<verb>: socket hang up` (typically the
`PUT /api/admin/modules` in `e2e/helpers/modules.ts`) — a ~19% flake on `main`,
never a product bug. Two harness-side settings remove it:

- **Server side:** `docker-compose.staging.yml` sets `KEEP_ALIVE_TIMEOUT=65000`
  on the `app` service. The standalone `server.js` reads this env var (ms) and
  raises `http.Server#keepAliveTimeout` to 65s, so the server never closes a
  keep-alive socket before the client is done with it. Staging/E2E-scoped only;
  the production compose environment is unchanged.
- **Playwright side:** `playwright.config.ts` sets `retries: process.env.CI ? 2
  : 0` — a backstop for any residual transport-level reset in CI, with no
  retries locally so real failures surface immediately. Those retries are only
  worth having if every spec is retry-idempotent; see "Flake invariants" below.

A second, unrelated transport race lives in the **mock-Xero harness** (#2302).
Its endpoints are the app calling *itself* over the loopback origin
(`XERO_MOCK_INTERNAL_ORIGIN`, `http://127.0.0.1:3000` in CI) in place of
api.xero.com, and on a loaded runner that hop intermittently returns
`ECONNREFUSED`. Nothing downstream retried it: the organisation read threw, the
connected-org summary degraded to a null name and negative-cached it for 60
seconds, and the wizard's post-OAuth refresh is a one-shot mount effect — so one
refused socket pinned `/admin/xero/setup` on "Confirming the organisation name…"
and `xero-setup-wizard.spec.ts` could only time out. `fetchMockLoopback`
(`src/lib/xero-mock-endpoint.ts`) now retries **transport** failures on those
self-calls (three attempts, short backoff); any HTTP status the handler returns
is still surfaced unchanged, and the whole module stays production-inert.

That fixed the *harness*. The **product** side of the same dead end was fixed
separately in **#2394**: the wizard step now shows why the organisation read
failed and offers a manual **Try again**, so a real Xero blip costs an operator
one click instead of a stuck page. A spec that wants to assert the failure path
should therefore look for that explanation, not for an indefinite
"Confirming the organisation name…".

## Flake invariants — read before writing a spec (issue #2302)

Five specs flaked on `main` over the last week of July 2026
(`waitlist`, `xero-setup-wizard`, `stripe-payment`, `bed-allocation`,
plus the `#21` cross-lodge case). **Every one of them shared one of the first
two mechanisms below**, and in four of the five a *single* transient failure was
turned into three by the retry policy. Neither mechanism is a "timing" problem,
so neither is fixed by a longer timeout, an extra retry, or a `waitForTimeout`.
The third invariant — no fixed dates — is the standing rule that stops a further
class from joining them.

### 1. Retries re-run against the database the failed attempt left behind

`playwright.config.ts` sets `retries: 2` in CI, and a retry of a
`test.describe.configure({ mode: "serial" })` group re-runs **the whole group**.
The suite seeds ONCE per run (`scripts/e2e-stack.sh`) — there is no reseed
between attempts. So a spec that permanently mutates state on its way to an
assertion fails its retries *deterministically*, on a different assertion than
the one that really broke:

| Spec | Attempt 0 left behind | Retries then failed with |
| --- | --- | --- |
| `waitlist.spec.ts` | Wanda's booking on the seeded-full window | `BOOKING_MEMBER_NIGHT_CONFLICT` instead of `CAPACITY_EXCEEDED` |
| `xero-setup-wizard.spec.ts` | the wizard's persisted step cursor on step 3 | the step-1 heading never appears |
| `stripe-payment.spec.ts` | the persona booked onto its stay window | the wizard never reaches "Booking Summary" |
| `bed-allocation.spec.ts` | the seeded booking already approved | "Ken King" no longer in the pending-review list |

Four rules follow, and a new spec must satisfy all four:

- **Keep serial groups as narrow as the real dependency.** Only tests that
  genuinely hand state to the next one belong in a `mode: "serial"` describe;
  everything else stays an independent test so its failure retries *it* and
  never drags a mutating predecessor back through a dirty database.
  `waitlist.spec.ts` is the worked example — a two-test serial describe plus two
  standalone tests, where the file used to be serial end to end.
- **Make setup idempotent, in a hook that re-runs on every attempt.** A retry
  restarts the worker, so `beforeAll`/`beforeEach` run again — that is where the
  reset belongs. Use the shared primitives in
  [`e2e/helpers/reset.ts`](../e2e/helpers/reset.ts)
  (`cancelMemberBookingsOnDate`, `deactivateMinimumStayPolicies`,
  `cancelOpenExceptionRequests`, `resetXeroSetupWizard`); they drive the product's
  own admin API, so no spec needs direct database access and no test-only
  endpoint is added. A clean first attempt is a no-op.

  `bed-allocation.spec.ts` now carries that repair in its serial setup (#2594,
  #2595):
  the first journey approves or allocates only when the retry database still
  needs that step, so it restores Ken's approved full-stay placement after a
  killed removal or move worker. The reviewed-move journey restores Ken to the
  original bed and re-approves exactly the allocations that were approved on
  entry; the staged-removal journey recreates and approves the exact removed
  guest-nights in `finally`. The settings teardown always restores the demo
  seed's enabled default rather than trusting a dirty retry snapshot.

  **A per-member SLOT is state too.** A member may hold only one open
  booking-policy exception request at a time, so a leftover one is refused as a
  duplicate (409 `OPEN_EXCEPTION_REQUEST`) on the next attempt.
  `cancelOpenExceptionRequests` closes both flavours and verifies the slot is free.
  Use it rather than a local loop: the member's own read answers the member DTO,
  whose `status` is the member's word (`pending`, `pending-capacity-conflict`, ...)
  and NOT the Prisma enum, so a copied `status === "REQUESTED"` check matches
  nothing and cleans up nothing while reporting success — the shared helper keys on
  the DTO's own `canWithdraw` instead. Two specs carried that copied check before
  #2562 unified the read.

  **Configuration a spec stands up counts as state too.** A spec that creates a
  booking rule in order to break it must take that rule back down, or its own
  retry cannot create it again: a second ACTIVE minimum-stay policy sharing a
  (scope, name) pair is refused with 409 `POLICY_NAME_CONFLICT` (#2363), and the
  policy DELETE requires the row's `version` in the body — a bodyless call is a
  500 that silently leaves the rule active. `deactivateMinimumStayPolicies` does
  both correctly and verifies the names are free again; give each attempt its own
  policy NAME as well, so a reset that cannot clean still cannot wedge the retry.
- **Give each attempt its own booking dates.** `stayWindowForAttempt(index,
  testInfo.retry)` (`e2e/helpers/stay-dates.ts`) maps attempt 0/1/2 onto three
  disjoint bands of Mondays, so a retry can never collide with the booking its
  own previous attempt created. Attempt 0 is byte-identical to `stayWindow(index)`.
  Prefer this to `stayWindow(index)` in any test that creates a booking. Keep
  base indices unique per spec, as before.

  **It is unusable in two shapes, and then the reset is the tool instead:** a
  window held in a `const` at module scope has no `testInfo` to read `retry`
  from, and a test that must act on the window a PREVIOUS test booked has to keep
  that window rather than take its own. `booking.spec.ts` (test 2 re-books test
  1's window to prove the member-night lock) and `admin-override-dates.spec.ts`
  (later tests shift the booking test 1 made) are both, so each clears its
  leftover in an idempotent group `beforeAll` via `cancelMemberBookingsOnDate`
  instead — including, for the override spec, every date the booking is moved
  through.

  **Per-attempt windows fix a RETRY, never a re-RUN (#2625).** Attempt 0 draws the
  same window every time, and the past bands are derived from the RUN DATE — so a
  spec that creates a booking and leaves it behind still fails the second time it
  is run against one seeded database, and can wedge the NEXT DAY's run too,
  because the bands slide a day while the leftover stays on its absolute date.
  Both were observed on a real staging stack:
  `admin-retroactive-booking.spec.ts` was the last date-based spec with no reset,
  and a booking left by the previous day's run was found sitting on the current
  day's attempt-0 nights and had to be cancelled through the app before the suite
  would pass. A spec that creates a booking needs BOTH halves — its own window per
  attempt *and* an idempotent `beforeAll` sweep.

  Sweep every check-in that can hold one of this run's nights, not just the
  attempt's own: a two-night stay checking in on `c` occupies nights `c` and
  `c + 1`, so it collides with the window at offset `o` (nights `o`, `o + 1`)
  exactly when `c` is `o - 1`, `o` or `o + 1`. `pastStayLeftoverCheckIns()`
  (`e2e/helpers/stay-dates.ts`) derives that contiguous band straight from
  `PAST_RETRY_OFFSETS_DAYS`, so it cannot drift from the windows it protects, and
  it stops short of Alice's seeded DRAFT booking — a sweep wide enough to clear
  seeded fixtures would trade one dirty database for another.

  Those retry bands cost calendar navigation: a spec reaches its dates by
  clicking the wizard calendar's "Next ›" one month at a time, bounded by
  `MAX_MONTH_HOPS` in `e2e/helpers/booking.ts`. Base 0–15 × attempt 0–2 needs at
  most 14 hops on any run date and the bound is 24, so nothing in range can run
  out — and if a future base or stride does, `selectCalendarDay` now fails on the
  month it could not reach rather than timing out on a day button.

  The walk itself is `walkCalendarToMonth` in
  [`e2e/helpers/calendar-navigation.ts`](../e2e/helpers/calendar-navigation.ts),
  shared by the forward walk and the retroactive spec's backwards ones. Use it
  rather than a local loop: a hop count is not a time bound, and only the shared
  walk bounds the per-hop click. See "5. A bounded loop with an unbounded click in
  it is not bounded" below for the 90-second timeout that cost.
- **Give each retryable booking-create spec attempt its own client-IP bucket.**
  `POST /api/bookings` is protected by the real 20-per-hour `bookingCreate`
  limiter before authentication. The serial suite therefore must not let an
  unrelated retry spend the shared runner-IP budget that a later spec needs.
  `E2E_BOOKING_CREATE_CENSUS`
  (`e2e/helpers/booking-create-client-ip.ts`) is the closed census. Ordinary
  journey/setup entries are classified `isolated-setup` and must use
  `bookingCreateIsolation(key, testInfo.retry)`: repeated booking-create calls
  in one logical test attempt share one `10.240.0.0/16` bucket, while different
  registered tests and retry numbers cannot collide. A spec whose purpose is
  exercising the limiter is classified `intentional-limiter` and must use the
  separate typed `bookingCreateLimiterProbe`; using either allocator with the
  other classification fails both at typecheck and in the structural contract.
  Use `postBookingCreate` for a direct `APIRequestContext` create, or use
  `withBookingCreateClientIp` around exactly the browser action that emits the
  create.

  **A browser create passes two halves, never a bare function (#2610).** The
  third argument is `{ trigger, waitForOutcome }`: `trigger` fires exactly the
  gesture that emits the create, and `waitForOutcome` awaits that journey's OWN
  authoritative outcome — server-rendered content on the booking-detail page a
  navigating create reaches, the wizard step a payment-owing create reveals, or
  the refusal card a policy-refused create renders. The interception is
  installed across both halves and removed only after `waitForOutcome` resolves.

  **For a navigating create the URL is not enough on its own.** The
  booking-detail route has a `loading.tsx` boundary, so `router.push` commits
  with the skeleton and Next pushes the address while the detail RSC GET is
  still in flight. `toHaveURL` is therefore satisfied *before* the navigation
  completes, and holding only to it tears interception down inside the very
  window this helper exists to keep open. Assert something the server actually
  rendered — the `Booking Details` heading, or the persisted date the
  retroactive spec checks — after the URL.

  The reason is that `page.unroute` is not free: Playwright implements it by
  recomputing Chromium's *global* Fetch interception patterns, so a teardown
  that overlaps a navigation the trigger just started is a race by construction
  — the client-side `router.push` the create issues, and the RSC GET that
  follows it within a few milliseconds, are both in flight while the patterns
  are being rewritten. Waiting for a genuinely authoritative outcome first keeps
  teardown outside that window. Treat this as harness hygiene and the hosted A/B
  for #2610, **not** as a proven diagnosis: the stall has never reproduced
  locally.

  Do not invent a generic "some page rendered" wait to satisfy the shape — an
  outcome that is not this journey's own is worse than none, because it passes
  while proving nothing. The structural contract enforces the *shape* only; it
  cannot tell whether what you awaited was authoritative, so that judgement is
  yours and a reviewer's. Seven of the fourteen browser census entries reach the
  helper through a shared wrapper that embeds the wait for them —
  `confirmBookingToPaymentStep` waits for the payment step and
  `bookThroughWizard` waits for the exception-request offer — so those specs
  assert the outcome once, inside the hold, rather than twice. Holding the route
  longer also widens the "exactly one matching request" guard to cover the
  outcome window, so a second create that used to slip through after teardown
  now fails loudly.

  Both paths are structurally tied to the census. The same contract
  inventories direct request calls, aliases, and a bare browser/global
  `fetch("/api/bookings", { method: "POST" })`; default-GET fetches remain
  outside the create census. Never put this header on a whole browser/admin
  context: login,
  availability and policy requests must keep their own client identity. The
  login helper's `10.99.0.0/16` and whole-lodge submission worlds'
  `10.77.1.0/24` remain separate and unchanged. This is isolation, not a bypass:
  every create still traverses production rate limiting and the suite never
  resets or mocks its storage. The fast #2599 unit contract reproduces
  the old exhausted runner bucket through the shipped `bookingCreate`
  configuration, client-IP resolver, and in-process fallback counter. Runtime
  acceptance belongs to `booking-create-rate-isolation.spec.ts`: it sends
  attempt, retry-1, and retry-2 probes through the real route, then proves each
  exact counter advanced in shared PostgreSQL. Run these two commands in order
  on the **same already-prepared isolated stack**, with no `prepare` between
  them, so the later real waitlist and whole-lodge create paths follow those
  staged retry dimensions:

  ```bash
  scripts/e2e-stack.sh run e2e/booking-create-rate-isolation.spec.ts --project=chromium --workers=1
  E2E_PRESERVE_AUTH_STATE=1 scripts/e2e-stack.sh run e2e/waitlist.spec.ts e2e/whole-lodge-request.spec.ts --grep "placement then admin force-confirm|acknowledgement is byte-identical" --project=chromium --workers=1
  ```

  The first command requires no Stripe credentials: all three probes are
  deliberately unauthenticated and must return 401 after rate limiting. The
  second command explicitly preserves only the gitignored browser/TOTP files
  created by the first command; the database and its limiter counters are
  already preserved because neither command prepares or resets the stack. It
  runs the retry-sensitive real-path anchors rather than unrelated scenarios in
  those large files. It fails on any cross-spec 429 because waitlist pins 409
  then 201, while the whole-lodge setup requires a successful confirmed held-
  world booking create before its three privacy-safe request submissions.
  Neither command resets, bypasses, mocks, nor increases the limiter.
- **Restore shared state in `afterAll`, never at the end of the test body.**
  `xero-setup-wizard-completion.spec.ts` used to disconnect Xero and rewind the
  wizard on its last line; when it failed earlier it stranded the sibling spec on
  a connected, step-3 wizard.

### 2. A streaming route renders the same text twice for a beat

Every route segment with a `loading.tsx` (`/book`, `/bookings`,
`/bookings/[id]`, `/dashboard`, `/admin/bookings`, `/admin/dashboard`,
`/admin/members`, `/finance`) is a React streaming (Suspense) boundary. During
the reveal the content exists **twice** — once in a `hidden` streamed template
and once live — so a bare `getByText("…")` resolves to two elements and strict
mode fails the assertion outright (`resolved to 2 elements … unexpected value
"hidden"`). This is what broke `waitlist.spec.ts`'s offer card, and `#21` before
it in `multi-lodge/member-cross-lodge.spec.ts`.

- **Prefer `getByRole` / a `getByTestId`-scoped locator.** The streamed template
  is `hidden`, i.e. `display: none`, so it is out of the accessibility tree and
  `getByRole` cannot match it. `getByText` has no such protection.
- **If text is the only handle, add `.filter({ visible: true })`** so the
  assertion converges on the revealed node instead of the template.
- **Assert "it is gone" on the UNFILTERED locator** (`toHaveCount(0)`), so "gone"
  means gone from the DOM rather than merely hidden in a template.

### 3. Fixed dates

Nothing in a spec may hardcode a calendar date. Stay windows come from
`stayWindow` / `stayWindowForAttempt`, seeded fixtures and seasons are relative
(`prisma/e2e-fixtures.ts`, issue #2117), and prose dates are derived with
`lodgeNightLabel` / `calendarDayLabel`. A hardcoded date produces an assertion
that can only pass in the week it was written.

### 4. A pointer drag that resolves one row off

`DndContext` resolves the drop with `closestCenter`, and the rect it centres is
**not** the dragged element's. When a `DragOverlay` is rendered, `@dnd-kit/core`
uses the overlay's own measured child instead
(`draggingNodeRect = dragOverlay.rect ?? activeNodeRect`) and keeps re-measuring
it through a `ResizeObserver` for as long as the drag is live. A floating card
that grows once it has something to say therefore *moves the drop target* mid-drag,
downwards, by half of however much it grew.

Measured on the bed board (issue #2595, 1280x720 Desktop Chrome): chip 104.6px
tall, drag card 138px, target cell 57px. The card contributes
`(138 - 104.6) / 2 = 16.7px` of downward bias and the spec's own one-pixel cursor
clamp another 8.8px, against a 28.5px half-cell tolerance — 3px of margin. Any
environment that renders the same sentence one line taller spends that margin and
the drop lands on the row **below** the one the preview named. Forcing the card
22px taller locally reproduced it exactly, one row every time; the hosted runner
did the same on its own, dropping on `A3` while the spec aimed at `A2` on all
three attempts of run 31196057937.

The failure does not look like a geometry failure. The drag is live, the overlay
is up, and only the bed name in it is wrong, so a `hasText`-filtered locator
matches nothing and times out.

- **Keep the overlay's measured child the size of the dragged element.** On the
  bed board the `DragOverlay` child is a `h-full w-full` frame — which
  `DragOverlay` sizes from the chip's rect — and the readable card is absolutely
  positioned inside it. Collisions then follow the chip, and the preview copy can
  be any length. A spec that aims the dragged element's centre at a cell is only
  correct while this holds.
- **Never aim a pointer drag at a rect you did not measure.** If a spec computes a
  grab offset from element A, `closestCenter` must be centring element A.
- **Measure the handle, the dragged element and the target cell immediately before
  every drag.** Never hoist one measurement out of a loop or share it between two
  scenarios in the same test — a restored placement between two drags re-renders
  the rows.
- **Wait for a cancelled drag to tear down before starting the next one.** The
  overlay is mounted only while a drag is live, so asserting it is hidden is both
  the honest check that the cancel worked and the settle point that leaves the
  board static enough to measure.
- **Do not read a lagging collision as the cause.** `closestCenter` publishes a
  render or effect cycle behind the pointer, but `expect(...).toBeVisible()`
  polls, so pure lag resolves itself well inside the timeout. A locator that
  never matches across the full 15s means the collision settled on the wrong
  droppable, which is a geometry bug.
- **Assert the destination by name inside the preview filter.** `hasText` on the
  room/bed label is what turns a one-row overshoot into a failure instead of a
  pass on a neighbouring bed.

### 5. A bounded loop with an unbounded click in it is not bounded (issue #2626)

`playwright.config.ts` sets no `actionTimeout`, and Playwright's default is **0 —
no timeout, wait until the test itself is killed**. So the hop count on a calendar
walk bounds the number of clicks, not the time: if the nav control never becomes
actionable, hop 0's single `click()` consumes the whole 90 s budget, and the
walk's own arrival assertion is never reached. The reported error is then
`locator.click: Target page, context or browser has been closed`, which reads as a
browser crash and says nothing about the calendar — and in a serial group the
tests after it never run at all.

`admin-retroactive-booking.spec.ts` did exactly this. Measured on a real staging
stack, the three-hop loop completed **zero** hops: `getByRole('button', { name:
/Prev/ })` matched nothing, because the **"Confirm member details" onboarding gate
was still open** over the page. A Radix modal puts the rest of the document behind
an overlay *and* marks it `aria-hidden`, so the calendar is out of the
accessibility tree entirely — while `getByText("Select Your Dates")` still reports
visible, because Playwright's visibility check is not occlusion-aware. The
pre-flight assertion passed and hid the problem.

Two rules follow:

- **Use `completeMemberDetailsGateIfShown`; never hand-roll the gate.** The spec
  carried a private two-branch copy that knew only "Confirm details are correct"
  and "Confirm and finish", and sampled them in the same tick the dialog title
  appeared. The demo-seed members are missing a date of birth and a postal
  address, so the gate actually opens on its **profile** step — "Save and
  continue", which the copy had no branch for — and the shared helper exists
  precisely because the title and the current step do not mount in the same
  commit. A lossy copy of a hardened helper is a latent version of every bug that
  helper was hardened against.
- **Walk the calendar through `walkCalendarToMonth`**
  (`e2e/helpers/calendar-navigation.ts`). It asserts the nav control is present
  and enabled *before* each click, bounds the click, and asserts arrival — so an
  unreachable calendar fails in ~15 s naming the control, the direction and the
  target month (and pointing at the modal as the usual cause) instead of timing
  out on a day button or on a closed page. It returns the hop count, which is what
  makes "how many hops did it really do?" answerable at all. Bound the **day
  click** you make on arrival with the same exported `CALENDAR_CLICK_TIMEOUT_MS`:
  arrival being asserted means the month is right, but a day that resolves and is
  not actionable — disabled as past, out of season, availability still loading —
  is an unbounded click all over again. Pass `direction: "current"` when the
  calendar should already be on the target month; the walk then clicks nothing and
  asserts arrival only, because there is no control that keeps it where it is.

Note how this one hid: it **passes in hosted CI**. The full suite runs
`admin-override-dates.spec.ts` first, and that spec's `bookSelfToReviewStep`
completes Alice's onboarding through the shared helper, so by the time the
retroactive spec's member test runs the gate is gone. Running one spec on its own
— exactly what you do while working on it — leaves the gate outstanding. **A spec
must pass run on its own, not only in file order.**

### What is deliberately NOT the fix

Bumping `retries`, widening a `toBeVisible` timeout, `page.waitForTimeout`, or
relaxing an assertion so the polluted state also passes. Each hides the
mechanism and leaves the next author to rediscover it.

## Safety

- The stack is the isolated `tacbookings-staging` compose project with its own
  Postgres volume. The scripts never touch port 5432 or the production compose
  project.
- No live providers: Stripe stays in test mode; email is delivered to the local
  mailpit capture container (SES/SMTP relay to a live host stays unconfigured, so
  no real mailbox is ever contacted); Xero and cron stay disabled.
