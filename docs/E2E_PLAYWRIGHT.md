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
| `e2e/booking.spec.ts` | Create booking with capacity lock (Critical) | Member books a bed through `/book` (confirm-details gate → dates → guests → review → payment step) with the booker **pre-selected by default** (#1680); while payment is owed the booking holds **no** bed (issue #737 — only committed money reserves capacity); the same member cannot hold the same lodge night twice; the booker can also opt out (remove themselves) and continue with another guest to a priced review |
| `e2e/stripe-payment.spec.ts` | Stripe payment success/failure (Critical) | In-wizard step-4 card payment with Stripe test cards: `4242…` confirms the booking and the paid booking occupies its beds; `4000 0000 0000 0002` declines and leaves it payable. **Skips unless genuine Stripe test-mode keys are configured** |
| `e2e/admin-roles.spec.ts` | Role boundaries (High) | One persona per bundled access role (ADMIN_READONLY, ADMIN_BOOKINGS, ADMIN_MEMBERSHIP, ADMIN_CONTENT, FINANCE_USER, FINANCE_ADMIN, LODGE). Each asserts an in-area page renders and an out-of-area page is blocked (redirect), per the authoritative matrix in `src/lib/admin-permissions.ts` and the `/finance` (finance-auth) and `/lodge` (kiosk) gates |
| `e2e/waitlist.spec.ts` | Waitlist / force-confirm / offer (High) | Member is refused a seeded-full night and joins the waitlist (WAITLISTED); admin force-confirms it off the waitlist (overbook branch) through `/admin/waitlist`; member accepts a seeded, non-expired offer through the offer card; the admin waitlist surfaces offer + expiry state |
| `e2e/internet-banking.spec.ts` | Internet Banking settlement (Critical) | With Xero **absent**, a card PAYMENT_PENDING booking is switched to Internet Banking; the detail page shows the Internet Banking card with a `BOOKING-…` reference and does not crash (the Xero invoice is queued but never sent while disconnected). Toggles the Xero + Internet Banking modules on for its run and restores them |
| `e2e/membership-application.spec.ts` | Membership application (High) | Public application submit; both nominators agree through the real `/nominations/<token>` pages; admin approves; the applicant then exists as a member |
| `e2e/additional-payment-chase.spec.ts` | Outstanding additional payment (#2350, High) | The officer loop for money still owed after a booking change: the bookings list filtered to **Additional Payment: Still owing** marks the booking **Partly paid** with the amount due (its status chip still reading Paid); the booking page's **Additional payment outstanding** panel names the amount and reports nobody has been chased yet; **Resend payment request email** sends and the message is captured from mailpit; a second click inside the hour is refused instead of sending. The owing booking is **seeded** (`ADDITIONAL_OWED_BOOKING_ID`) rather than raised through an admin edit, because raising a real one mints a Stripe PaymentIntent and this journey must run whether or not Stripe test-mode keys are configured |
| `e2e/unmatched-url-status.spec.ts` | No matrix row — regression guard for #2405 (Medium) | The status LINE for URLs nothing serves, which only a running server can show. Anonymous throughout, because these are the shapes a crawler or a scanner asks for. Unmatched website URLs (`/definitely-missing`, `/wp-admin/setup-config.php`, `/.env`, `/admin/nope`) must each answer **404** *and* still render the club's own seeded `/404` CMS screen — pinned on the level-1 heading plus the seeded header text, since that page emits the same words as an `h2` as well and the hardcoded emergency fallback would otherwise satisfy a looser assertion. `/about` must still be **200**. Unmatched `/api` URLs — bare `/api` and `/api/` included — must answer a JSON 404 rather than ~23KB of HTML, with `POST` answered identically and `HEAD` carrying GET's `content-type`. `/api/health` must be untouched. Depends on `SEED_THEME_COMPLETE=1`: without it the layout's holding screen answers every URL with 200 |
| `e2e/asset-url-404.spec.ts` | No matrix row — regression guard for #2404 (High) | The CSP nonce on URL shapes `src/proxy.ts` used to skip, which only a running server can show. Anonymous throughout — these are the addresses scanners and stale browser tabs ask for. A MISSING asset (`/foo.png`, `/favicon.ico`, `/logo.png`, `/wp-content/uploads/x.jpg`, `/branding/definitely-missing.png`, `/_next/static/chunks/nope.js`) must answer **404 with an empty body, no `content-type`**, its own `default-src 'none'` policy and the app's security headers — never the ~29KB HTML 404 page, which used to ship 19 inline scripts with no nonce and no CSP header at all. A REAL asset must still be served: `/branding/favicon.example.ico` and a `/_next/static/chunks/*.js` URL taken from a live page render both 200 with their bytes, which is the assertion that catches an `afterFiles` -> `beforeFiles` slip turning every image in the app into a 404. `/apixyz` and `/_next/staticfoo` must carry a nonced policy (they were skipped by the old bare-prefix exclusions). `/definitely-missing` must still render the club's own 404 screen, fully nonced — nothing here may blank a human-plausible mistyped address. `/api/does-not-exist.png` and `/api/chores/zzz.svg` must still answer the JSON 404, because routing an asset-shaped `/api` URL elsewhere would reopen #2405's module-state oracle |
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

First-time setup: `npx playwright install chromium` (CI uses `--with-deps`).
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
bound to lodge B never seeing lodge A's roster, and the cross-lodge waitlist
offer → confirm happy path.

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
  (`cancelMemberBookingsOnDate`, `resetXeroSetupWizard`); they drive the product's
  own admin API, so no spec needs direct database access and no test-only
  endpoint is added. A clean first attempt is a no-op.
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

  Those retry bands cost calendar navigation: a spec reaches its dates by
  clicking the wizard calendar's "Next ›" one month at a time, bounded by
  `MAX_MONTH_HOPS` in `e2e/helpers/booking.ts`. Base 0–15 × attempt 0–2 needs at
  most 14 hops on any run date and the bound is 24, so nothing in range can run
  out — and if a future base or stride does, `selectCalendarDay` now fails on the
  month it could not reach rather than timing out on a day button.
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
