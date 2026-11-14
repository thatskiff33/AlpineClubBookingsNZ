# Load Testing (k6 harness)

This is the evidence framework for the production-hardening target of
"stable at 100+ concurrent users" (issue #1884). The scenarios drive the app **over
HTTP only** with [k6](https://k6.io) scripts that live in
[`load/`](../load/). Each scenario ramps to a configurable peak (default
100 VUs) and has k6 `thresholds`, so every run has explicit pass/fail
criteria instead of vibes.

## Safety rules — read before anything else

Quoted from [`AGENTS.md`](../AGENTS.md) → Safety, which governs this
harness exactly as it governs every other tool in the repo:

> - Never use production credentials, databases or backups, or live Stripe, Xero,
>   SES, Sentry or provider webhooks, for exploratory work.
> - No dev servers in shared, staging or production checkouts unless the owner
>   asks; no browser automation, DAST, load tests or endpoint scanning against a
>   live deployment without a written test window.

In concrete terms for this harness:

- **No live targets.** Only the throwaway local staging compose stack (or an
  equally disposable local dev server). Never a deployed instance, never
  `tokoroa.org.nz` or any club fork's domain.
- **Throwaway database only.** A load run creates real bookings and real
  sessions on whatever it hits. The staging stack's Postgres (host port
  5433) is reset and reseeded by the e2e scripts and is the only acceptable
  datastore behind a target.
- **Never `:5432`.** On club deployment hosts (and at least one developer
  machine) port 5432 is the **live production Postgres**. The scenarios speak HTTP to the app only; the volume seeder writes directly
  to the disposable database. Both target guards refuse `:5432`.
- **No live providers.** The contention scenario creates child-only
  `AWAITING_REVIEW` bookings so they genuinely hold capacity, but never calls
  payment-confirmation or Xero endpoints. The staging stack runs with
  `CRON_ENABLED=false` and captures the resulting admin-review notifications
  in Mailpit; never point it at live SES.
- A full 100-VU run is **owner-gated**: agents may run the reduced local smoke profile; full runs require the owner.

### The pre-flight target guard

Every scenario imports [`load/lib/target-guard.js`](../load/lib/target-guard.js)
in k6's init context (and re-asserts it in `setup()`), so a run aborts
before the first VU starts unless **all** of the following hold:

1. `BASE_URL` is set explicitly — there is no default target.
2. `LOAD_TEST_CONFIRM_TARGET=1` is set — a deliberate, per-run opt-in.
3. `BASE_URL` contains no `:5432` anywhere (string check *and* parsed-port
   check, so a pasted database URL is refused too).
4. The hostname is **not** `tokoroa.org.nz` or any subdomain, contains no
   `prod`, and **is** on the local allowlist: `localhost`, `127.0.0.1`,
   `::1`, `host.docker.internal`, or a `*.localhost` / `*.test` name.

There is no override switch. If you believe you need to load test something
the guard refuses, that is an owner conversation and a written test window,
not a code edit.

## Standing up the throwaway target stack

The same staging compose stack the Playwright e2e suite uses (see
[`E2E_PLAYWRIGHT.md`](E2E_PLAYWRIGHT.md)):

```bash
cp .env.staging.example .env.staging   # first time only
pnpm run test:e2e:prepare               # up + migrate + demo-seed the stack
```

That publishes the app at **`http://localhost:3001`**, Postgres at
`127.0.0.1:5433` (never 5432), and Mailpit at `127.0.0.1:8025`. Tear it all
down afterwards with `pnpm run test:e2e:down` (removes the volume — the
bookings a load run created go with it).

The demo seed provides the test accounts. All demo personas share the
seeded demo password (`DEMO_SEED_PASSWORD`, default documented in
`prisma/demo-seed.ts` / `.env.staging.example`); the natural load persona is
`alice@demo.alpineclub.test`, a paid-up member who can book at member rates.
Credentials are passed to k6 via env only — the scripts refuse to run an
authenticated scenario without `LOAD_USER_PASSWORD`.

k6 itself is a single binary: <https://k6.io/docs/get-started/installation/>.
It is deliberately **not** an npm dependency. The advisory scheduled smoke job
installs it separately.

## Volume, local Stripe stub and scheduled smoke

For the complete fixture, use the load wrapper instead of the basic E2E stack:

```bash
cp .env.staging.example .env.staging
bash scripts/load-stack.sh prepare
LOAD_TEST_CONFIRM_TARGET=1 pnpm run load:smoke
bash scripts/load-stack.sh down
```

`prepare` creates its own `load-issue4940` Compose project, two bookable
lodges, generated stub-only Stripe credentials and TLS certificates, and a
volume history. It accepts only a project name starting `load-`. The
app resolves `api.stripe.com` to the local HTTPS stub, and the only Stripe key
it holds is a generated stub key the real API would refuse. The compose network
is not internal-only, because Docker publishes no ports for a container on an
internal network and k6 runs on the host. Mail goes to Mailpit,
Xero remains disconnected, and the volume seeder refuses a stored Xero
connection. No real provider credentials belong in the source env file.

The fixture defaults to **3,000 members and five years of seasons**, with
multi-night stays, members and non-member guests, card and bank payment rows,
credits and card refund rows. Each lodge's current seasons are repeated for each
of the five years before them, so a lodge with a winter and a summer season
gets ten past windows. `LOAD_VOLUME_MEMBERS`, `LOAD_VOLUME_SEASONS` (years back)
and `LOAD_VOLUME_SEED` change the history size and deterministic random seed.
The volume entry point reuses the demo booking and settlement writers; it
creates historical fixture rows, without contacting providers. This gives
queries realistic row counts; it does **not** load-test bank settlement or
historical card refunds. The seeder refuses repeat runs; reset the stack first.

To seed an already prepared disposable stack directly (replace the
placeholder with the `DB_PASSWORD` in that stack's env file):

```bash
LOAD_TEST_CONFIRM_TARGET=1 ALLOW_DEMO_SEED=1 \
  DATABASE_URL=postgresql://tac:<your-stack-db-password>@localhost:5433/tacbookings \
  pnpm run load:seed-volume
```

The database guard runs before reads or writes. It requires explicit opt-in,
a local allowlisted hostname and an explicit non-5432 port, and refuses routing
query parameters, including encoded names. The demo guard also refuses
production mode and existing non-demo members with bookings.

`load:smoke` runs every journey at **10 VUs**, with the published thresholds,
then recreates the app with `CRON_ENABLED=true` using
[`load/compose.cron-on.yml`](../load/compose.cron-on.yml). Its final
`cron-overlap` scenario runs dashboard reads and mixed writes concurrently
with an explicit `/api/cron` invocation, using the generated stack's local
cron secret. It requires a successful cron completion, so a short run cannot
pass simply because it missed the scheduler's three-hour boundary. The combined
profile uses 10 read workers, 10 write workers and one cron worker.

[`load-smoke.yml`](../.github/workflows/load-smoke.yml) runs weekly and on
manual dispatch, with read-only repository permission, no secrets, a 60-minute
limit and unconditional stack cleanup. It is advisory and has no PR trigger;
it is not a required check. It uploads k6 JSON summaries, stack logs and
`profile.json` for 14 days. The profile records the running app's available
cores, actual `connection_limit`, the app and Postgres CPU limits, the VU
count and the volume members counted in the database; the default uncapped app
currently uses pool **5**. Compare runs only within a labelled resource profile. Full 100-VU
evidence remains owner-gated, and the historical pool-10 results below are a
separate profile. A threshold failure is evidence to investigate, not permission
to weaken budgets, bcrypt cost or CPU constraints.

### Coverage and limits

| Scenario | Journeys exercised | Not exercised |
| --- | --- | --- |
| `public-browse` | Public pages, login page, unauthenticated availability refusal | Authenticated reads or writes |
| `login` | Simultaneous credentials login using the configured account pool | 2FA, external identity providers |
| `member-dashboard` | Dashboard HTML, lodge list, calendar, credit balance | Quote, booking wizard UI, writes |
| `booking-contention` | One lodge/night, child-only review holds, exact final occupancy | Paid booking, cross-lodge writes |
| `mixed-writes` | Create, extend dates and cancel across two lodges and several nights; final capacity ceilings | Card refund and bank settlement |
| `admin-reads` | Admin bookings JSON list, annual report, bed board as seeded admin | Browser rendering, officer writes |
| `payment-path` | Card booking, intent creation on local stub, signed test-mode webhook and duplicate replay, paid status | Stripe network latency, declines, real card processing |
| `cron-overlap` | Dashboard and mixed writes while the real general cron runner executes; scheduler enabled | Every daily job, Xero queue or webhooks |

Xero callbacks/queue, Internet Banking settlement, standalone price quotes,
real card refunds, and multi-step browser interactions remain unmeasured.
Neither a green smoke job nor the historical reads proves capacity for those
paths. File performance defects separately; this kit does not change product
performance or thresholds.

## Environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `BASE_URL` | **yes** | — | Target origin, e.g. `http://localhost:3001`. Must pass the guard. |
| `LOAD_TEST_CONFIRM_TARGET` | **yes** | — | Must be exactly `1`. The per-run "I checked the target" opt-in. |
| `LOAD_USER_EMAIL` | for auth scenarios | `alice@demo.alpineclub.test` | Member to log in as. |
| `LOAD_USER_PASSWORD` | for auth scenarios | — | That member's password (the staging demo-seed password). Never hardcoded. |
| `LOAD_USERS` | no | — | Comma-separated extra member emails (same password) used round-robin by login, dashboard, and contention VUs. Without it, auth scenarios are explicitly same-account contention tests. |
| `LOGIN_ITERATIONS_PER_VU` | no | `1` | Cold logins per VU. The primary evidence profile is exactly one; values above one are an explicit repeated-login stress profile. |
| `PEAK_VUS` | no | `100` | Peak virtual users for the ramp / contention stampede. |
| `RAMP_UP` / `STEADY` / `RAMP_DOWN` | no | `1m` / `3m` / `30s` | Stage durations for the ramping scenarios. |
| `P95_MS` | no | `800` | p95 latency budget (ms) for the read scenarios. |
| `LOGIN_P95_MS` | no | `2000` | p95 budget for the bcrypt-heavy login flow. |
| `MAX_ERROR_RATE` | no | `0.01` | Failure-rate threshold shared by all scenarios. |
| `THINK_TIME` | no | `1` | Seconds of sleep between requests in an iteration. |
| `LODGE_ID` | no | — | Lodge to book/read; empty lets the app resolve the default lodge. |
| `CONTENTION_CHECKIN` | no | the run's day + 116 days | The single night everyone fights over. Must be a bookable (in-season, future) date on the seeded stack. The default keeps clear of the seeded and mixed-writes windows (`load/lib/stay-window.js`). |
| `CONTENTION_CHECKOUT` | no | check-in + 1 day | Override only for multi-night contention. |
| `CONTENTION_ATTEMPTS` | no | `1` | Booking attempts per VU. The default makes `PEAK_VUS` equal the number of write attempts. |
| `CONTENTION_P95_MS` | no | `5000` | p95 budget for the serialised booking write. |
| `CONTENTION_AUTH_WARMUP_SECONDS` | no | `60` | Seconds from setup to the shared booking-write barrier. Every VU gets one login attempt in this window; a late VU fails the run rather than mixing bcrypt CPU into booking latency. Keep at least 60 seconds for the standard 100-VU constrained-stack profile. |
| `LODGE_CAPACITY` | no | `20` | Expected capacity of the selected seeded lodge; teardown fails if observed occupancy exceeds it. |
| `CONTENTION_EXPECTED_BASELINE` | no | `0` | Required occupied-bed baseline for the contention night. A mismatch aborts before writes; reset the stack or set this deliberately for a known non-empty fixture. |

Additional knobs for the volume scenarios:

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOAD_VOLUME_USERS` / `LOAD_VOLUME_DOMAIN` | `0` / required when positive | First N volume member accounts. Smoke counts the members in the stack's database for N and takes the domain from the demo guard, and gives login and dashboard the first `PEAK_VUS` of them (`LOAD_USERS`). |
| `LOAD_ADMIN_EMAIL` / `LOAD_ADMIN_PASSWORD` | seeded E2E admin / member password | Admin API persona. |
| `STAY_OFFSET_DAYS` / `MIXED_NIGHT_SPREAD` | `120` / `3` | Future mixed-write window, relative to the run's UTC date. |
| `MIXED_ITERATIONS` | `5` | Create/change/cancel cycles per worker; smoke uses 4. |
| `PAYMENT_ITERATIONS` / `PAYMENT_OFFSET_DAYS` | `3` / `30` | Paid stays per worker and their offset beyond the mixed window. |
| `STRIPE_STUB_URL` | `http://127.0.0.1:12111` | Local control/signing endpoint, checked by the HTTP target guard. The stub publishes 12111 on loopback only, and the port is fixed, so leave this at its default. |
| `CRON_SECRET` | required for cron overlap | Disposable stack's cron secret, read by smoke from its generated env file. |

## Scenarios

All eight live in `load/scenarios/` and share `load/lib/` (guard, config,
login helper). Entries 1 to 4 are the original read and booking-hold profiles;
entries 5 to 8 are the #4940 scenarios that need the volume-seeded load stack
(`scripts/load-stack.sh prepare`). Convenience wrappers exist in `package.json`
(`pnpm run load:public` etc.) for the original four — they only pass through
to `k6 run` and abort on the guard unless the env above is set. `pnpm run
load:smoke` runs all eight in order.

### 1. Public browse — `load/scenarios/public-browse.js`

Anonymous VUs ramp to `PEAK_VUS` walking `/`, `/join`, `/contact`,
`/login`, asserting 200s. There is **no public availability endpoint** in
this app (availability is auth-gated), so the scenario also probes
`GET /api/availability` unauthenticated and asserts the cheap `401` — the
authenticated availability read lives in the dashboard scenario instead.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  k6 run load/scenarios/public-browse.js
```

### 2. Login — `load/scenarios/login.js`

The primary profile starts `PEAK_VUS` together and performs exactly one full
cold login per VU: clear cookies →
`GET /api/auth/csrf` → form-`POST /api/auth/callback/credentials` → assert
a session cookie landed. bcrypt makes this the most CPU-expensive request
in the app, hence its own `LOGIN_P95_MS` budget and the `login_success`
rate threshold.

By default this is deliberately a **same-account contention** profile: all
VUs authenticate as `LOAD_USER_EMAIL`. To measure independent-user login
throughput instead, seed distinct member accounts with the same throwaway
password and list them in `LOAD_USERS`; VUs select accounts round-robin. For
a headline 100-user run, provide at least 100 total accounts (the primary
account plus `LOAD_USERS`) so concurrent logins are genuinely distinct.
Set `LOGIN_ITERATIONS_PER_VU` above 1 only for a separately labelled repeated
cold-login stress run; it is not the headline concurrent-user result.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  LOAD_USERS=<comma-separated seeded member emails> \
  k6 run load/scenarios/login.js
```

### 3. Booking-hold contention — `load/scenarios/booking-contention.js`

**The core scaling evidence.** `PEAK_VUS` members stampede
`POST /api/bookings` for **one lodge + one night**
(`CONTENTION_CHECKIN`). A draft or confirmed booking create
(`createDraftBooking`, `createConfirmedBooking`) takes the global advisory lock
`pg_advisory_xact_lock(1)` first and then the per-lodge capacity key from
`acquireLodgeCapacityLock` (`INV-LOCK-001` for the tier, `INV-LOCK-002` for the
global-before-lodge order — see
[`CONCURRENCY_AND_LOCKING.md`](CONCURRENCY_AND_LOCKING.md) and
[`CAPACITY_MODEL.md`](CAPACITY_MODEL.md)). Those creates therefore queue behind
one key, whichever lodge they book, so this scenario measures the whole app's
booking-write throughput, not one lodge's. A waitlist create
(`createWaitlistedBooking`) is the one create that takes only the lodge key;
no scenario here drives it. Race losers
block on the lock,
re-check capacity, and receive the app's normal sold-out answer, so the
scenario asserts on the **outcome distribution**, not just 200s:

- `201` + `status: "AWAITING_REVIEW"` → counted as `bookings_created`
  (race winners); a non-holding 201 is a harness failure;
- `409` + `code: "CAPACITY_EXCEEDED"` (with `canWaitlist: true` and a
  `fullNights` array) → counted as `booking_capacity_rejections` — this is
  a *pass*, it is the correct answer for a full lodge;
- anything else (5xx, timeout, other 4xx) trips the `booking_unexpected`
  threshold and fails the run.

Latency gets a deliberately loose `CONTENTION_P95_MS` (default 5 s) because
the lock serialises writers **by design**; the run fails on errors, not on
queueing. Before the first booking write, every VU performs its single allowed
login and waits until the same absolute write barrier. The default
`CONTENTION_AUTH_WARMUP_SECONDS=60` gives the standard 100-VU constrained-stack
profile time to finish bcrypt work. If any bootstrap is still late,
`contention_auth_ready_before_barrier` fails and that VU does not write, so a
red run cannot pass off auth CPU as advisory-lock latency. Values of
`CONTENTION_ATTEMPTS` above one remain a separate sequential stress profile;
the first attempt from every VU is the synchronized headline stampede.

Setup requires the observed baseline to equal
`CONTENTION_EXPECTED_BASELINE` (default 0), then teardown requires the exact
final occupancy `min(LODGE_CAPACITY, baseline + PEAK_VUS ×
CONTENTION_ATTEMPTS)`. A single missing capacity hold fails
`capacity_invariant`; merely staying below capacity is not enough.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  k6 run load/scenarios/booking-contention.js
```

Bookings use a non-member child guest plus an explicit review justification.
That follows the real child-only policy into `AWAITING_REVIEW`, a
capacity-holding state, and **touches no payment provider**. It can enqueue an
admin-review email, which the throwaway stack captures in Mailpit. Reset the
stack between contention runs so each run starts from a known-empty night:
`pnpm run test:e2e:down && pnpm run test:e2e:prepare` for the E2E stack, or
`bash scripts/load-stack.sh down` and then `prepare` for the load stack.

### 4. Member dashboard — `load/scenarios/member-dashboard.js`

Each VU logs in once (round-robin across `LOAD_USERS` when supplied), then
loops the authenticated read paths:
`/dashboard` (server-rendered), `/api/lodges`, `/api/availability`
(the calendar month containing `CONTENTION_CHECKIN`, so a side-by-side run
reads the calendar the write path is contending on), and
`/api/member/credit-balance`.

Dashboard request latency is thresholded only on
`{flow:member_dashboard}`. The one-time bcrypt bootstrap is reported by the
separate `dashboard_bootstrap_login_success` gate, so login time cannot make a
dashboard-read SLO fail while login failures still fail the run. A failed
bootstrap is recorded once and is not retried inside the read loop; otherwise
an unavailable login path would turn the scenario into an accidental login
storm and stop measuring dashboard reads.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  k6 run load/scenarios/member-dashboard.js
```

Entries 5 to 8 need the load stack. After `bash scripts/load-stack.sh prepare`,
`BASE_URL`, `LOAD_USER_PASSWORD`, `LOAD_VOLUME_USERS` and `CRON_SECRET` can be
read with `load-stack.sh base-url`, `demo-password`, `volume-members` and
`cron-secret`, and `LOAD_VOLUME_DOMAIN` is the seeder's demo domain
(`DEMO_SEED_DOMAIN`, `demo.alpineclub.test`). `scripts/load-smoke.sh` reads them
all and is the supported way to run these scenarios. The commands below run a
single scenario by hand.

### 5. Mixed writes — `load/scenarios/mixed-writes.js`

Each VU logs in as its **own** volume-seeded member and repeats a booking cycle
on a lodge and night chosen from its VU id: create a self-booking, extend it by
one night, cancel it, and on the first iteration also hold a bed with a
child-only review request. Neighbouring VUs land on different lodges and
nights, so writers queue on the global key and on more than one lodge key at
once. Teardown reads every night the run could touch and `capacity_ceiling`
fails the run if any lodge is over capacity. Needs `LOAD_VOLUME_USERS` at least
`PEAK_VUS` and `LOAD_VOLUME_DOMAIN`. It makes at most `MIXED_ITERATIONS + 1`
creates per VU, inside the 20 creates per hour per client IP limit.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  LOAD_VOLUME_USERS=100 LOAD_VOLUME_DOMAIN=<seeder domain> \
  k6 run load/scenarios/mixed-writes.js
```

### 6. Admin reads — `load/scenarios/admin-reads.js`

One seeded admin session (`LOAD_ADMIN_EMAIL`, default the E2E admin; its
password is `LOAD_ADMIN_PASSWORD`, else `LOAD_USER_PASSWORD`) reads the admin
bookings list for the current month, the annual report for the past 365 days
and the bed board for the next week, against the volume history. Each response
must be JSON, not a sign-in redirect. This measures read cost on a club-sized
history, not browser rendering or officer writes.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  k6 run load/scenarios/admin-reads.js
```

### 7. Payment path — `load/scenarios/payment-path.js`

Needs the Stripe stub, so only the load stack. Each VU creates a card booking,
asks the app for a payment intent, has the stub sign a succeeded-payment event,
posts that event to `/api/webhooks/stripe` twice (the second is the replay), and
then reads the booking's status through an admin session: it must be `PAID`.
The stub answers for `api.stripe.com` inside the compose network, accepts only
its own generated test key and signs with a generated secret. No Stripe
credential enters k6, and the real Stripe API is not reachable from the app by
name. It measures the app's payment and webhook handling, not Stripe's latency
or card behaviour. Needs `LOAD_VOLUME_USERS` at least `PEAK_VUS`,
`LOAD_VOLUME_DOMAIN` and a reachable `STRIPE_STUB_URL`. The admin session reuses
`LOAD_USER_PASSWORD` unless `LOAD_ADMIN_PASSWORD` is set.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  LOAD_VOLUME_USERS=100 LOAD_VOLUME_DOMAIN=<seeder domain> \
  k6 run load/scenarios/payment-path.js
```

### 8. Cron overlap — `load/scenarios/cron-overlap.js`

Runs the dashboard scenario and the mixed-writes scenario together with one
worker calling `POST /api/cron` with the stack's `CRON_SECRET`, so the real
general cron runner executes while members read and write. Run it with the
scheduler on, as the smoke run does: `bash scripts/load-stack.sh cron-on` first
and `cron-off` after. It fails unless every cron call returns `success: true` and at least one
completes. Needs `LOAD_VOLUME_USERS` at least `2 * PEAK_VUS + 1`, because
dashboard and write workers each use distinct members.

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> CRON_SECRET=<stack cron secret> \
  LOAD_VOLUME_USERS=100 LOAD_VOLUME_DOMAIN=<seeder domain> \
  k6 run load/scenarios/cron-overlap.js
```

## Reading the output

k6 prints a summary at the end of each run; the run **exits non-zero if any
threshold fails**, which is the pass/fail signal:

- `http_req_duration … p(95)` vs the scenario's budget (`P95_MS`,
  `LOGIN_P95_MS`, `CONTENTION_P95_MS`). Login and booking flows are also
  tagged (`{flow:login}`, `{flow:booking_contention}`) so their thresholds
  are scoped to the flow, not diluted by cheap requests.
- `http_req_failed` — transport/5xx failure rate vs `MAX_ERROR_RATE`.
  Expected non-2xx outcomes (the public 401 probe, the contention 409s) are
  registered via `expectedStatuses` so they do **not** count here.
- `checks` / `login_success` / `booking_unexpected` — semantic assertions
  (right status *and* right body shape).
- `dashboard_bootstrap_login_success` / `capacity_invariant` — explicit gates
  for read-scenario session establishment and the contention occupancy bound.
- Contention counters: `bookings_created` and `booking_capacity_rejections`.
  A healthy 100-VU run against a fresh 20-bed night has created exactly 20,
  capacity rejections exactly 80, unexpected 0, and final occupied beds
  exactly 20.

A smoke-scale sanity pass (recommended before any full run):

```bash
BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
  LOAD_USER_PASSWORD=<demo seed password> \
  PEAK_VUS=5 RAMP_UP=10s STEADY=30s RAMP_DOWN=5s \
  k6 run load/scenarios/public-browse.js
```

## Implementation notes

- Each scenario uses a separate block of synthetic client IPs. This prevents a
  login run from consuming the dashboard or contention scenario's fixed-window
  rate-limit budget when the profiles run back to back on one throwaway
  stack. Re-running the same scenario still requires a fresh stack or an
  expired limiter window.

- **Measured baseline (16 Jul 2026, 0.8-CPU profile, app pool 10):** the
  corrected rerun recorded on #1884
  ([evidence comment](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/1884#issuecomment-4987714526))
  ran on an isolated stack with the app container at **0.8 CPU / 1 GiB**,
  PostgreSQL `max_connections=30`, and an app connection pool of **10**:

  | Scenario | Result | Threshold verdict |
  | --- | --- | --- |
  | Public browse | p95 702.83 ms, checks 100%, failures 0% | pass |
  | Member dashboard | 100/100 bootstrap logins, read p95 247.93 ms, failures 0%, 22,127 iterations | pass |
  | Booking contention | 100/100 auth-ready, exactly 20 created + 80 capacity 409s, final occupancy 20, p95 3.78 s, failures and unexpected 0% | pass |
  | Cold-login burst | 100/100 logins succeeded, failures 0%, p95 23.98 s | **fails** the 2 s login budget |

  One isolated cold login took 290.89 ms; the burst figure is bcrypt queueing
  on a CPU pinned near 80%, with no pool exhaustion, restart or OOM. PR #1920
  kept every threshold unchanged.
- **Superseded figures (15 Jul 2026):** the first 100-VU run's public p95
  2.24 s, cold-login p95 23.01 s (2.99% failed), dashboard aggregate p95
  12.5 s, and contention p95 29.18 s (4.05% failed) are **not** current
  evidence. That harness amplified contention writes, did not hold capacity,
  and mixed bootstrap login into dashboard latency; quote the 16 Jul figures
  above instead.
- **Deployment profile remains evidence, not a code workaround:** the measured
  stack was CPU-bound while the app container was limited below one CPU. A
  follow-up run may profile roughly 2 app CPUs, but it must be reported as a
  separate resource profile; do not raise thresholds, reduce bcrypt cost, or
  silently change the standard profile to manufacture a pass.
- **Profile change (#2351, 30 Jul 2026):** the compose default the staging
  stack inherits no longer hard-caps app CPU at all — the app containers set
  no CPU control and burst into whatever cores the host has idle (the old
  `cpus: 0.8` cap was lifted after production measurement showed cold page
  renders CFS-throttling into multi-second loads — see `DEPLOYMENT.md` → "App
  CPU sizing"). The recorded baselines above predate this and describe the
  sub-one-CPU profile (0.8 CPU, pool 10); a future full run happens on the
  uncapped-weighted profile of the host it runs on, and must be labelled with
  that host's core count and app pool size, per the separate-resource-profile
  rule above. To reproduce the historical constrained profile, add
  `cpus: 0.8` back for the run.
- **Public layout reads:** module flags, theme, lodge capacity, and current
  banners use independent 15-second caches with tagged invalidation on their
  admin write paths, including lodge settings and configuration imports.
  Authentication/session state is deliberately not cached.
- **Lodge eligibility:** `/api/lodges` resolves member restrictions once per
  request rather than repeating the same query for each active lodge.

- **Rate limiters vs load:** the app keys its per-IP limiters on the last
  entry of `X-Forwarded-For` (production Caddy appends the real client IP).
  The proxyless staging stack trusts the header as sent, so — like the
  Playwright helpers — each VU presents a unique synthetic `10.99.x.x`
  address. Login rotates the address per iteration (limit 10/15 min);
  contention keeps one address per VU and stays under the 20/hour
  booking-create limit via `CONTENTION_ATTEMPTS`. This is a test-stack
  convenience, not a production bypass: behind Caddy the trusted last hop
  is always the real IP.
- **Auth:** NextAuth v5 credentials flow; the session cookie
  (`authjs.session-token`) lives in k6's per-VU cookie jar. The app's own
  JSON APIs authorise on that cookie alone (no per-request CSRF token), so
  `POST /api/bookings` needs no extra token. Keep the staging two-factor
  module disabled for load personas (the default seed state) or logins will
  park at `/login/verify`.
- k6 scripts are ES modules executed by k6's own runtime — they are not part
  of the app bundle or `pnpm test`; the scheduled smoke job runs them with k6.

## New-run evidence (#4940)

The extended journeys have no measured load baseline yet. In the implementation
sandbox, Docker is unavailable, so the complete stack and 10-VU run could not
be executed. Unit checks cover guard rejection, deterministic volume planning,
night/capacity oracles and the local Stripe stub against the real Stripe SDK;
these are correctness evidence, not latency results. The first scheduled/manual
smoke artifacts must be reviewed before quoting capacity for the new journeys.
Record its commit, resource profile, volume counts, scenario p95/error rates,
occupancy verdict and cron completion count here after that run. No 100-VU run
was performed for this change.
