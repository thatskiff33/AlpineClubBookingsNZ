# Load Testing (k6 harness)

This is the evidence framework for the production-hardening target of
"stable at 100+ concurrent users" (issue #1884). It drives the app **over
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
  machine) port 5432 is the **live production Postgres**. The harness never
  speaks to a database at all — HTTP to the app only — and its target guard
  hard-refuses any `BASE_URL` mentioning `:5432`.
- **No live providers.** The contention scenario creates child-only
  `AWAITING_REVIEW` bookings so they genuinely hold capacity, but never calls
  payment-confirmation or Xero endpoints. The staging stack runs with
  `CRON_ENABLED=false` and captures the resulting admin-review notifications
  in Mailpit; never point it at live SES.
- A full 100-VU run is **owner-gated**: agents build and syntax-check this
  harness but do not execute load runs autonomously.

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
It is deliberately **not** an npm dependency and never runs in CI.

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
| `CONTENTION_CHECKIN` | no | `2026-08-18` | The single night everyone fights over. Must be a bookable (in-season, future) date on the seeded stack. |
| `CONTENTION_CHECKOUT` | no | check-in + 1 day | Override only for multi-night contention. |
| `CONTENTION_ATTEMPTS` | no | `1` | Booking attempts per VU. The default makes `PEAK_VUS` equal the number of write attempts. |
| `CONTENTION_P95_MS` | no | `5000` | p95 budget for the serialised booking write. |
| `CONTENTION_AUTH_WARMUP_SECONDS` | no | `60` | Seconds from setup to the shared booking-write barrier. Every VU gets one login attempt in this window; a late VU fails the run rather than mixing bcrypt CPU into booking latency. Keep at least 60 seconds for the standard 100-VU constrained-stack profile. |
| `LODGE_CAPACITY` | no | `20` | Expected capacity of the selected seeded lodge; teardown fails if observed occupancy exceeds it. |
| `CONTENTION_EXPECTED_BASELINE` | no | `0` | Required occupied-bed baseline for the contention night. A mismatch aborts before writes; reset the stack or set this deliberately for a known non-empty fixture. |

## Scenarios

All four live in `load/scenarios/` and share `load/lib/` (guard, config,
login helper). Convenience wrappers exist in `package.json` (`pnpm run
load:public` etc.) — they only pass through to `k6 run` and abort on the
guard unless the env above is set.

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
(`CONTENTION_CHECKIN`), which serialises on the per-lodge advisory lock
(`pg_advisory_xact_lock(hashtextextended(lodgeId, 0))` — see
[`CONCURRENCY_AND_LOCKING.md`](CONCURRENCY_AND_LOCKING.md) and
[`CAPACITY_MODEL.md`](CAPACITY_MODEL.md)). Race losers block on the lock,
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
  LOAD_USER_PASSWORD=<demo seed password> CONTENTION_CHECKIN=2026-08-18 \
  k6 run load/scenarios/booking-contention.js
```

Bookings use a non-member child guest plus an explicit review justification.
That follows the real child-only policy into `AWAITING_REVIEW`, a
capacity-holding state, and **touches no payment provider**. It can enqueue an
admin-review email, which the throwaway stack captures in Mailpit. Reset the
stack (`pnpm run test:e2e:down && pnpm run test:e2e:prepare`) between contention
runs so each run starts from a known-empty night.

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
  rate-limit budget when the four profiles run back to back on one throwaway
  stack. Re-running the same scenario still requires a fresh stack or an
  expired limiter window.

- **Measured baseline and rerun:** the first 100-VU evidence run found public
  p95 2.24 s, cold-login p95 23.01 s, dashboard aggregate p95 12.5 s, and
  contention p95 29.18 s. Those results are not a pass: the original harness
  amplified contention writes, did not hold capacity, and mixed bootstrap
  login into dashboard latency. Rerun all four scenarios from a freshly reset
  stack after these corrections. Keep the published thresholds unchanged and
  attach the k6 summaries to #1884.
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
  sub-one-CPU profile; a future full run happens on the uncapped-weighted
  profile of the host it runs on, and must be labelled with that host's core
  count, per the separate-resource-profile rule above. To reproduce the
  historical constrained profile, add `cpus: 0.8` back for the run.
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
  of the app bundle, `pnpm test`, or CI, and `k6` is not a dependency.
