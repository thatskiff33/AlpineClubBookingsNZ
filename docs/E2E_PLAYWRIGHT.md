# Playwright E2E Suite

Browser end-to-end tests for the **Critical** journeys in
[`END_TO_END_TEST_MATRIX.md`](END_TO_END_TEST_MATRIX.md), driven against the
staging Docker Compose stack (`docker-compose.staging.yml`, compose project
`tacbookings-staging`) seeded with the base seed (`prisma/seed.ts`) followed by
the demo seed (`prisma/demo-seed.ts`).

## What is covered

| Spec | Matrix row | Journey |
| --- | --- | --- |
| `e2e/two-factor-login.spec.ts` | Global two-factor enforcement (Critical) | Forced TOTP enrollment on first login, recovery codes, protected-route gating for unverified sessions, wrong-code rejection, TOTP re-login, single-use recovery codes |
| `e2e/two-factor-email.spec.ts` | Global two-factor enforcement — email method (Critical) | Forced **email-code** enrollment on first login (send → capture the emailed code from the mailpit SMTP capture → enroll → recovery codes), then an email-code re-login that rejects a wrong code and accepts the emailed one. The code is read back over mailpit's HTTP API (`e2e/helpers/mailpit.ts`); no live mail provider is used |
| `e2e/booking.spec.ts` | Create booking with capacity lock (Critical) | Member books a bed through `/book` (confirm-details gate → dates → guests → review → payment step); while payment is owed the booking holds **no** bed (issue #737 — only committed money reserves capacity); the same member cannot hold the same lodge night twice |
| `e2e/stripe-payment.spec.ts` | Stripe payment success/failure (Critical) | In-wizard step-4 card payment with Stripe test cards: `4242…` confirms the booking and the paid booking occupies its beds; `4000 0000 0000 0002` declines and leaves it payable. **Skips unless genuine Stripe test-mode keys are configured** |
| `e2e/admin-roles.spec.ts` | Role boundaries (High) | One persona per bundled access role (ADMIN_READONLY, ADMIN_BOOKINGS, ADMIN_MEMBERSHIP, ADMIN_CONTENT, FINANCE_USER, FINANCE_ADMIN, LODGE). Each asserts an in-area page renders and an out-of-area page is blocked (redirect), per the authoritative matrix in `src/lib/admin-permissions.ts` and the `/finance` (finance-auth) and `/lodge` (kiosk) gates |
| `e2e/waitlist.spec.ts` | Waitlist / force-confirm / offer (High) | Member is refused a seeded-full night and joins the waitlist (WAITLISTED); admin force-confirms it off the waitlist (overbook branch) through `/admin/waitlist`; member accepts a seeded, non-expired offer through the offer card; the admin waitlist surfaces offer + expiry state |
| `e2e/internet-banking.spec.ts` | Internet Banking settlement (Critical) | With Xero **absent**, a card PAYMENT_PENDING booking is switched to Internet Banking; the detail page shows the Internet Banking card with a `BOOKING-…` reference and does not crash (the Xero invoice is queued but never sent while disconnected). Toggles the Xero + Internet Banking modules on for its run and restores them |
| `e2e/membership-application.spec.ts` | Membership application (High) | Public application submit; both nominators agree through the real `/nominations/<token>` pages; admin approves; the applicant then exists as a member |

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

First-time setup: `npx playwright install chromium` (CI uses `--with-deps`).
The HTML report lands in `playwright-report/`; traces and screenshots for
failures land in `test-results/`.

The suite is serial (one worker) on purpose: specs assert on lodge capacity
and share seeded personas, so they must not interleave.

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
  three weeks out). The base seed's seasons cover Jun–Sep 2026 and Nov
  2026–Mar 2027; a run whose windows fall in a season gap fails loudly at the
  season assertion — extend the seeded seasons if that happens.

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

CI installs the deps with `npx playwright install --with-deps`.

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

- The staging app sends over **SMTP relay** rather than SES: the env sets
  `USE_AWS_SES=false`, `USE_SMTP_RELAY=true`, and
  `EMAIL_SERVER_HOST=mailpit` / `EMAIL_SERVER_PORT=1025` with dummy
  `EMAIL_SERVER_USER` / `EMAIL_SERVER_PASSWORD` (see `.env.staging.example` and
  the CI env writer in `.github/workflows/e2e.yml`). All four SMTP_RELAY vars
  must be present and `USE_AWS_SES` must be false, or `resolveEmailDeliveryConfig`
  returns `invalid` and every send throws.
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

Note on scope: `main` is not branch-protected, so a red E2E run is an honest
failing signal but does not itself hard-block a merge. Making E2E a required
status that blocks merges is a separate branch-protection setting.

The Stripe payment specs remain an environment dependency: they run only when
the `STRIPE_TEST_SECRET_KEY` / `STRIPE_TEST_PUBLISHABLE_KEY` repository secrets
hold genuine Stripe **test-mode** keys, and otherwise `test.skip` cleanly (they
are also retry-scoped to absorb the datacenter-IP Link/hCaptcha flake). So a
green E2E run does not imply Stripe E2E coverage ran unless those secrets are set.

## Safety

- The stack is the isolated `tacbookings-staging` compose project with its own
  Postgres volume. The scripts never touch port 5432 or the production compose
  project.
- No live providers: Stripe stays in test mode; email is delivered to the local
  mailpit capture container (SES/SMTP relay to a live host stays unconfigured, so
  no real mailbox is ever contacted); Xero and cron stay disabled.
