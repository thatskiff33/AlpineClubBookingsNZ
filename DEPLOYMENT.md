# Deployment Reference

This guide describes the AlpineClubBookingsNZ production deployment shape. It is a
reference for operators adapting the project to their own infrastructure.

Do not reuse another club's credentials, domains, payment accounts, accounting
tenants, email identities, Sentry projects, or database backups in a fork.
Create your own service accounts and secrets.

## Target Architecture

- Ubuntu 24.04 host with Docker and Docker Compose
- Caddy reverse proxy on ports 80 and 443
- PostgreSQL 16 in Docker
- Next.js app and migration images built by GitHub Actions and pulled from GHCR
- Optional S3-compatible storage for PostgreSQL backups
- Stripe, Xero, SES, and Sentry configured through environment variables

Production Compose services:

- `postgres` - database
- `app` - cron leader and warm fallback web upstream
- `app_blue` / `app_green` - web-only blue/green slots
- `caddy` - public reverse proxy and health-aware upstream routing
- `migrate` - explicit Prisma migration runner

## Connection pool sizing

Each app container's Prisma pool size is the `connection_limit` in its
`DATABASE_URL` (in `docker-compose.yml`). Prisma treats it as a hard ceiling,
and advisory-lock waiters hold their connection while blocked — so an
undersized web pool lets a single-lodge booking burst exhaust it and stall
unrelated requests. The defaults are sized for ~100 concurrent users against
Postgres `max_connections=40`:

| Service | Role | `connection_limit` |
| --- | --- | --- |
| `app_blue` / `app_green` | web slots | 10 each |
| `app` | cron leader + warm fallback web | 5 |
| `migrate` | deploy-window migrations | 2 |

The worst case is a blue/green handover (both web slots briefly live) that
overlaps a migration:

```
app_blue(10) + app_green(10) + app(5) = 25 steady
                                 + migrate(2) = 27
```

That leaves the pools **13 slots** under the 40 ceiling — but those slots are
**not** a protected admin reservation. The app connects as role `tac`, which the
`postgres` image creates as a **superuser** (`POSTGRES_USER`), so
`superuser_reserved_connections` (the 3 slots Postgres nominally holds back) does
**not** fence the app's own pools off: once the pools reach the ceiling, even a
superuser `psql` is refused. The headroom is therefore best-effort room for the
**non-pool** consumers you must budget alongside the pools:

- the nightly `pg_dump` backup (its own backend, outside every pool)
- the deploy-window shadow/drift database and admin `psql`, on the same server
- the `pg_isready` health probe (every 5s)
- any operator `psql`

So the real invariant is **sum(pools) + non-pool consumers ≤ `max_connections`**,
not just the pools; steady state (one active web slot + cron leader) is far lower.

`max_connections` was raised from 30 to 40 (and the `postgres` `mem_limit` from
512m to 768m) after production transiently hit `FATAL: sorry, too many clients`:
at 30 the deploy-window pools (27) sat one slot under the ceiling, so a single
overlapping backup, shadow DB, probe, or operator `psql` overflowed it — and
because the app role is a superuser (above), Postgres then refused *all* new
logins, the nominally-reserved slots included, locking operators out exactly when
they needed to diagnose. 40 restores real headroom for those consumers. The 768m
`mem_limit` covers the extra backends plus their `work_mem` (~256m more per host —
negligible above ~1 GiB free).

A true protected admin slot would need a dedicated **`NOSUPERUSER`** application
role (so `superuser_reserved_connections` can hold slots back from it). This is a
**consciously accepted limitation**: because the pools are hard-capped at 27 well
under the 40 ceiling, the ~13-slot margin covers the non-pool consumers in
practice, so the simpler single-superuser model is retained. Revisit the
`NOSUPERUSER` split only if a future change makes the margin tight (a new pooled
consumer, a much larger replica count, or enabling the audit-archive client via
`AUDIT_ARCHIVE_DATABASE_URL`, which opens its own pool). A constrained-VPS fork
may lower both values, but keep the invariant above whenever you change a pool
size, `max_connections`, or the replica count.

## App CPU sizing

The app containers ship with **no CPU control at all** in `docker-compose.yml`
— no `cpus` cap, and deliberately no explicit `cpu_shares` weight either
(#2351). The reasons, and how scheduling then behaves:

> **Partly addressed since #2352 slice 1.** The admin-authored CMS pages are now
> served from a cache rather than re-rendered per visit, so they no longer pay the
> cold-render cost described below on every visit — only on the first visit per
> path per container, and after an admin edit or the five-minute backstop.
> Everything below still holds for `/`, `/join`, `/contact`, `/join/apply` and
> every member/admin page, which are still rendered per request. Note those four
> public pages DO already carry the fixed per-release CSP nonce, even though they
> are not cached — the nonce is decided for the whole `(website)` route group. The
> keep-warm pinger and the uncapped CPU default stay in place as belt and braces
> either way. See "Public website page cache" below.

Page renders are fully dynamic (every page is rendered per request), and the
JavaScript engine throws away a
route's optimised code once that route sits idle briefly. The next request to
the route then pays several CPU-seconds rebuilding it — most of it in the
engine's background compiler threads, which parallelise across cores. The
reference numbers, measured on a production deployment during issue #2351
(Node 24, 1 GiB heap — expect them to drift across Node/Next upgrades, though
the shape persists): optimised code flushed after **~10 seconds** of route
idleness; **~3.5–5 CPU-seconds** per cold render. Uncapped, a cold render
spreads across the idle cores and takes 1–2 seconds (warm ones take tens of
milliseconds); under the hard `cpus: 0.8` cap earlier templates shipped, the
same render was CFS-throttled into **4–13 second page loads** — a mysteriously
slow site with an idle database (that deployment's container had been
throttled in 64% of all scheduler periods). Low-traffic club sites feel this
the most, because sparse visits mean *every* visit is a cold render.

With no cap set, the app can use **all idle CPU** — on any host size, a
1-core VPS included (there is no limit for Docker to validate, so nothing to
adjust for small hosts). Only while containers genuinely compete does the
kernel share CPU out by scheduler weight, and *unset* weights are equal by
default on both cgroup versions — which is why no explicit `cpu_shares`
value is written: an explicit value maps inconsistently between cgroup v1
and v2 (on a v2 host — any modern distro — an explicit `1024` becomes
`cpu.weight` 39 against the default 100, silently *deprioritising* the
container it was meant to describe as "normal"). Under equal weights,
contention splits CPU evenly across the runnable containers: on hosts with
a few cores or more, `postgres`'s share of a fully-contended machine meets
or exceeds the `cpus: 0.5` ceiling it runs under anyway; on a 1-core host
everything necessarily shares the single core, exactly as it did under the
old capped arrangement. The practical effect: renders get the whole machine
when it is free, and the database and proxy still get a fair share when it
is not.

If you share the host with other workloads and need an absolute "the app may
never use more than X cores" guarantee, add a `cpus:` override in your fork —
but note that a numeric cap must not exceed the host's core count (Docker
refuses to create the container), budget roughly one dedicated core minimum
for the live web slot, and treat multi-second cold renders below ~1 CPU as
the expected symptom, not a bug. Two mitigations for genuinely starved hosts:
a keep-warm pinger (curl the key public routes on each app container every
~8 seconds — warm renders are so cheap the pings cost ~1–2% of a core), and
the structural fix tracked in #2352 (static/ISR public pages). Changing the
app CPU arrangement also changes the load-testing baseline profile — see the
note in `docs/LOAD_TESTING.md`.

## Public website page cache

Slice 1 of #2352. The admin-authored CMS pages (`/privacy`, `/faq`, `/rules`,
`/committee`, `/terms` and every page an admin adds) are rendered once per path
and then served from a cache. Four operational facts:

- **The cache is IN MEMORY, per container, and bounded.** Next writes runtime
  full-route entries under `.next/server/app`, which is read-only in this
  container, so `next.config.ts` sets `experimental.isrFlushToDisk: false` and
  `cacheMaxMemorySize: 64MB`. The bound is a least-recently-used eviction, which
  is deliberate: it means a crawler walking nonsense addresses evicts old entries
  instead of filling something up. The `/app/.next/cache` tmpfs (Next's fetch and
  image caches) now carries an explicit `size=64m` for the same reason — an
  uncapped tmpfs defaults to half the host's RAM and counts against the
  container's 1 GiB `mem_limit`.
- **It is emptied by every restart and every deploy**, so a stored page can never
  outlive its release. That matters beyond freshness: the CSP nonce on these pages
  is fixed per release (see `docs/SECURITY-ATTACK-SURFACE.md` → "The Public
  Website's Fixed CSP Nonce"), and a page from an older release would not hydrate.
- **The fixed nonce covers five addresses and no others.** `/`, the CMS catch-all,
  `/join`, `/contact` and `/join/apply` (owner decision D1, narrowed to exactly
  these on 3 Aug 2026). `/hut-leader-instructions` and the two group-join screens
  are rendered fresh for every visitor with their own one-time nonce, the same as
  the member area and the admin area. Nothing about this is configurable and there
  is nothing for an operator to do; it is recorded here because "the public website
  has a fixed nonce" is not the whole truth, and the difference is what a security
  reviewer will ask about.
- **`RELEASE_ID` should reach the image, and CI proves it does.** It is a build ARG
  carrying the deployed commit SHA; the fixed nonce is derived from it. CI's
  `publish-ghcr-images` job passes it to the app image and then runs that pushed
  image and asserts the value equals the built commit, so an ordinary GHCR deploy
  cannot ship without it. `scripts/run-production-blue-green-deploy.sh` also exports
  it, which covers the build-on-the-host path (it is skipped when prebuilt registry
  images are used, which is the normal case). `GIT_COMMIT_SHA` is a second fallback,
  readable in the runtime image.
- **If neither reaches the image, the nonce still works.** A bare `docker build` or
  a plain `docker compose build` has no release, so `next.config.ts` bakes a random
  per-BUILD seed into every bundle and the nonce is derived from that instead — one
  value per release, shared by every process, exactly as intended. What you lose is
  the ability to identify the deployed revision from the image, and the build prints
  a warning saying so. The old note here claimed the fallback was "one nonce per
  process — fine for a single process": that was wrong in both halves. The module is
  loaded twice in one process (the proxy bundle and the app bundle are compiled
  separately), so a per-process value was never self-consistent even on a single
  container — it made the analytics scripts on public pages fail their own policy.
  See `src/lib/release-nonce.ts`.
- **The new release is warmed and VERIFIED before traffic moves to it** (#2566,
  owner decision Option 4). Step 16 of 20 in the blue/green engine renders the
  release's approved public website routes and every published Page Content address
  on the new colour, proves the page cache really was populated for the addresses
  this release stores, then blocks the cutover if a critical page failed. See
  "Pre-cutover warm-up gate" below for what it checks, what it tolerates, and what
  to do when it refuses.
- **The five-minute backstop bounds when a REBUILD is triggered, not when a visitor
  first sees fresh content.** An admin edit is genuinely instant — it clears the
  stored copy outright, so the next request has to render again. A change with no
  save behind it (a site banner whose start time simply arrives) is different: after
  five minutes the next request is still served the OLD stored copy and only
  triggers the rebuild in the background, so the change appears from the request
  after that one. On a quiet weekend that second request can be a long time coming.
  A Next.js Link prefetch is served the stored copy and does not trigger a rebuild
  at all.

Every page the public website serves carries
`Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, except
`/`, which carries a deliberate 60-second browser window (#2322). Nothing invites a
shared cache to keep a public page, which matters because `revalidatePublicSite()`
cannot reach one: a CDN or corporate proxy holding a stale copy would make "an edit
appears immediately" false for those visitors with no expiry an admin can wait out.
`src/proxy.ts` sets that header explicitly — the `revalidate` export otherwise makes
Next fill in an `s-maxage` of its own.

## Pre-cutover warm-up gate

Step 16 of 20 in the blue/green engine, added by #2566 (owner decision Option 4). It
runs after the migrations, after the new colour and the cron leader are both healthy,
and **before** Caddy is repointed. If it refuses, no traffic ever reaches the new
release and the old colour keeps serving.

What it does, in order:

- reads the new release's own build output to establish which public addresses it
  stores and which it renders per request
- cross-checks its hand-written critical list against the repository's public-route
  census (`FIXED_NONCE_WEBSITE_ROUTES`), and refuses to plan a run while any
  approved public address is missing from it. That is what stops a release that
  gained a public page from passing the gate having never requested it
- reads the club's published Page Content rows for the addresses to warm, and the
  configured Book Now page target
- requests each address **on the new container itself**, over its own loopback
  origin, carrying the deployment's public host as `X-Forwarded-Host` (with
  `X-Forwarded-Proto`) — never through the public domain, which would warm whichever
  colour is currently live. The forwarded header is the mechanism, deliberately
  stated: an HTTP client writes the wire `Host` from the URL authority, so a loopback
  request cannot carry a production `Host` however it is set. Nothing on a public
  render path reads the raw header today — absolute URLs and `metadataBase` come
  from `NEXTAUTH_URL` — and a unit test fails if one starts to
- requests each stored page a second time and requires the release to report it as
  served **from its cache**: `x-nextjs-cache: HIT` or `STALE`, read on its own. A 200
  is not accepted as proof, and neither is `x-nextjs-prerender: 1` — Next sets that
  header on every prerender-capable response including a `MISS`, so it says which
  route answered, not that anything was stored
- checks that the served document's inline scripts still match the security policy
  served with them, which is what a page that renders but never comes alive looks
  like
- prints a summary naming every count, every failed path with its HTTP result, and
  the verdict

It runs once per web instance that can serve public traffic: the new colour **and**
the `app` cron leader, because the Caddy config lists `app` as the second upstream
and it therefore serves public pages whenever the new colour fails a health probe.
Each instance keeps its own in-memory page cache, so warming one says nothing about
the other.

**What blocks the cutover.** Any failure on a critical public route — the home page,
`/join`, `/join/apply`, `/contact`, and the Book Now page target when the club has
configured one.

What counts as a failure depends on how this release renders the address, and today
that split matters: `/`, `/join`, `/join/apply` and `/contact` are `force-dynamic`
under #2352 slice 1, so for them the gate proves the page RENDERS and proves it
reports no cache. **Store verification — a second request that must come back
`x-nextjs-cache: HIT` or `STALE` — therefore applies only to the published Page
Content pages and the configured Book Now page target**, which the ISR catch-all
serves. When #2352 slice 2 or 3 converts the critical routes into stored pages, their
declarations in `src/lib/deploy/warmup-route-policy.ts` are updated in the same PR
(the gate refuses to cut over while a declaration and the build output disagree, in
either direction), and from that release on a critical page that renders but is never
proved stored blocks the cutover as well.

The failures themselves: a server error, an unexpected 404 or redirect, a redirect to
login, an empty or non-HTML response, a page that renders but is never stored, a
per-request page that has started being stored, a policy/nonce mismatch, a release
that does not identify itself as the one being deployed, and any failure to discover
the routes at all — including an approved public address that the critical list does
not name. On a critical route each of those stops the cutover outright; on a published
content page the tolerance below decides. The critical route list is written out explicitly in
`src/lib/deploy/warmup-route-policy.ts` so it is reviewable rather than inferred, and
the census cross-check above is what keeps "explicit" from becoming "out of date".

A `prebuilt` address — one frozen at build time — is warmed but not required to prove
a store: there is no store to populate, and Next reports a cache header on it anyway,
so one is accepted rather than treated as a fault. Only a per-request address is
required to report **no** cache.

**What it tolerates.** An isolated failure on one published content page, and only
when the failure is genuinely isolated: at most **one** failed page **and** at most
**10%** of the published pages discovered. Both conditions must hold, so a club with
fewer than ten published pages tolerates none — that is deliberate, not an
oversight. The deploy then completes labelled **with a warning**, the failed path and
its response are printed, and the operator is expected to raise or link a follow-up
issue for it before closing the deploy out.

That label is not left at step 16. Every warm-up warning is accumulated and
**re-printed after the completion banner**, and the final line reads "Blue/green
deploy complete WITH WARNINGS" rather than "complete". There is no deploy log file, so
the operator's terminal is the only record: without this, four more steps, the
container table and 80 lines of application logs scroll past between the warning and
the last thing on screen.

"Every warning" means the summary's own WARNINGS block, read out of the report rather
than inferred from the verdict — so a gate that returned a plain **pass** and still
warned about something is carried to the end too. That is a real case rather than a
theoretical one: a page unpublished between discovery and warming, a Book Now setting
the gate could not read, an image carrying no release identifier, a deploy that could
not say which commit it is releasing, or a tolerance the operator widened all pass the
gate and all still need recording. A clean run adds nothing and the banner still reads
"complete".

**What it skips.** A club whose site-style setup is not finished. Every public
address answers the "Site setup in progress" holding screen until then, so there is
nothing to warm; the gate says so and the deploy continues.

Settings, all optional and all read by `scripts/run-production-blue-green-deploy.sh`:

| Variable | Default | Accepted | Effect |
| --- | --- | --- | --- |
| `DEPLOY_WARMUP_CONCURRENCY` | `3` | `1`-`8` | Requests in flight at once. Kept small so the release is not under its heaviest load of the day moments before it takes traffic. |
| `DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS` | `20` | `1`-`120` | Per-request ceiling. A cold render is 1-2s on an idle host and up to ~13s on a CPU-starved one. |
| `DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS` | `240` | `5`-`1800` | Whole-gate ceiling, applied **per warmed service** — the default pair therefore costs up to 480s. Addresses it never reached, and stored pages it never got to verify, count as failures. |
| `DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES` | `1` | `0`-`100` | The count half of the tolerance. |
| `DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT` | `10` | `0`-`100` | The percentage half. |
| `DEPLOY_WARMUP_SERVICES` | target colour + `app` | one or more app service names | Which app services to warm. A value that resolves to no services is refused rather than treated as "nothing to check". |
| `DEPLOY_WARMUP_ENABLED` | `1` | `0` or `1` | Set to `0` to skip the gate entirely. Refused unless `DEPLOY_WARMUP_OVERRIDE_REASON` is also set, and the reason is printed in the deploy log and repeated after the completion banner. |

The accepted ranges are enforced twice on purpose. The deploy script checks them
before it asks a container anything, so a mistyped setting is named immediately; the
endpoint enforces them too, and reports a refusal as a readable `blocked` summary
rather than a bare HTTP 400, because the container's only HTTP client is busybox
`wget` and it discards the body of a non-2xx response. Out of range, either way, you
are told **which** setting was refused — not that the gate could not be read.

Widening the tolerance is allowed and recorded in the summary; it is never silent.

**When the gate refuses.** Nothing has changed for members — the old colour is still
serving and the schema migrations have already been applied in a
backward-compatible way, so this is a blocked upgrade rather than an outage. Read
the failed paths in the summary, open the same addresses on the old colour to see
whether the fault is new, and check `docker compose logs app_blue` (or `app_green`)
for the render error. Fix forward and re-run the deploy; the gate is idempotent and
warming is safe to repeat. If the gate itself is the problem at an unrecoverable
moment, `DEPLOY_WARMUP_ENABLED=0` with a written reason is the documented escape
hatch — the deploy then cuts over unwarmed and unverified, which is exactly the state
this gate exists to prevent, so use it knowingly.

The gate is exercised end to end against a production-mode stack by
`e2e/deploy-warmup.spec.ts`, and its rules by the unit suites in
`src/lib/deploy/__tests__/`.

## Prerequisites

- A host sized for your traffic and runtime memory needs
- DNS control for your deployment domain
- Docker and Docker Compose installed
- GHCR read access for private image packages, unless the image packages are
  public
- A PostgreSQL backup and restore plan
- Stripe live or test account, depending on environment
- Xero app or demo tenant, depending on environment
- SES or another SMTP-compatible transactional email service
- Sentry project, if source maps and runtime error reporting are desired

## Environment

Start from `.env.example` and the configuration reference:

```bash
cp .env.example .env
```

See `CONFIGURATION.md` for every supported environment variable and
`config/club.json` field.

Generate unique secrets:

```bash
openssl rand -base64 48   # AUTH_SECRET and NEXTAUTH_SECRET
openssl rand -base64 24   # CRON_SECRET
openssl rand -base64 24   # DB_PASSWORD
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The Node command produces a 64-character hex key suitable for Xero token
encryption variables.

Minimum production categories:

- Environment safety: `APP_ENVIRONMENT_ROLE` — set it to exactly `production` on
  the club's live deployment (ENV-SAFETY 1, #3034). This is the deployment's own
  declaration of whether it is the club's **live site** or a **copy** of it, and
  nothing infers it: not `NODE_ENV`, not the hostname, not which database it is
  pointed at. A deployment that does not declare itself resolves **UNKNOWN**, and
  UNKNOWN fails closed — member email and writes into the club's Xero
  organisation are held back until it is declared. A staging site, a rehearsal
  after restoring a backup, or a developer's checkout uses
  `APP_ENVIRONMENT_ROLE=non-production` instead; `docker-compose.staging.yml`
  already hard-codes that for the staging and E2E stacks, so only a copy you have
  brought up yourself needs the line by hand.
  `scripts/run-production-blue-green-deploy.sh` refuses to run without exactly
  `production` — at step 3 of 20, before the migration and long before the
  cutover — so a live deployment cannot reach UNKNOWN through the supported path.
  **It is not `APP_RUNTIME_ROLE`**, which sits beside it in the same Compose
  environment, names which container *slot* a process is (`web-blue`,
  `web-green`, `cron-leader`, `staging`), and is never read to decide whether
  this is the live site. Full guide: `docs/guides/environment-role.md`.
- Database: `DATABASE_URL`, `DB_PASSWORD`
- Auth: `AUTH_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST`
- Public app: `DOMAIN`.
  `DOMAIN` is the root public host consumed by `Caddyfile` through the
  `{$DOMAIN}` placeholder. Caddy derives `www`, `bookings`, and `dashboard`
  subdomains from that value.
- Modules: optional modules are database-backed in `ClubModuleSettings` and
  controlled from Admin > Modules after first login. No `FEATURE_*`
  environment variables are supported or read by the app.
- Stripe: **no env vars** (#2082). The Stripe secret key, publishable key, and
  webhook signing secret are captured **in-app** through the guided setup wizard
  at **Admin > Integrations > Stripe** (Full Admin only) and stored encrypted.
  The publishable key is delivered to the browser at **runtime** from the store
  (`GET /api/stripe/publishable-key`), so there is no build-time
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` inlining. The webhook route is
  **fail-closed** (no stored signing secret ⇒ every event rejected). Any legacy
  `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` /
  `STRIPE_WEBHOOK_SECRET` env vars still present are ignored and flagged in setup
  readiness — see the **Upgrade: DB-only provider credentials** runbook below.
- Xero: **no env vars** (#2079). The Xero client id/secret, webhook key, and
  token-encryption key are captured **in-app** through the guided setup wizard at
  **Admin > Xero > Setup** (#2080; Full Admin only) and stored encrypted; the
  redirect URI derives from `NEXTAUTH_URL`. This
  single connection serves bookings, payments, subscriptions, and the finance
  dashboard. Configure the Xero app with the exact operational scopes requested
  by `src/lib/xero-config.ts`: `openid`, `profile`, `email`,
  `accounting.contacts`, `accounting.invoices`, `accounting.payments`,
  `accounting.settings.read`, `accounting.reports.profitandloss.read`,
  `accounting.reports.balancesheet.read`,
  `accounting.reports.banksummary.read`, and `offline_access`. Do not grant the
  stale generic all-reports scope; reconnect Xero from `/admin/integrations`
  after changing allowed scopes so new tokens carry the granular report scopes.
  Any legacy `XERO_*` credential env vars still present are ignored and flagged
  in setup readiness — see the **Upgrade: DB-only provider credentials** runbook
  below.
- Email: `SMTP_HOST`, `SMTP_PORT`, `AWS_SES_ACCESS_KEY_ID`,
  `AWS_SES_SECRET_ACCESS_KEY`, `EMAIL_FROM`, `SES_SNS_TOPIC_ARN`. `EMAIL_FROM` is
  the only email-identity env var (besides these transport secrets): it is the
  envelope / Return-Path sender and must be a provider-verified (SES) address.
  Email identity — from display name, support address, and contact-form
  recipient — is admin-managed DB-first from **Admin > Email Messages**
  (`EmailMessageSetting`); the former `EMAIL_FROM_NAME`, `SUPPORT_EMAIL`,
  `CONTACT_EMAIL`, and the dead `NEXT_PUBLIC_CONTACT_EMAIL` env vars were removed
  (#1986). **Upgrade note:** a deployment that previously relied on the
  `CONTACT_EMAIL` env var to route the contact form must set the DB
  `contactEmail` (Admin > Email Messages); if unset it falls back to the support
  address per the existing precedence, so there is no hard break.
- Cron and backups: `CRON_SECRET`, `BACKUP_CRON_SCHEDULE` (nightly backup
  timing; all other backup settings are configured in-app at `/admin/backups`,
  #2095), optional `AUDIT_ARCHIVE_DATABASE_URL`
- Bootstrap provisioning (optional): `CONFIG_BUNDLE_IMPORT_PATH` — path to a
  config-transfer bundle applied non-interactively on boot **only** when the
  database is empty of non-seed configuration. See "Config Bundle Auto-Import On
  Boot (DR / clone)".
- AI Diagnostics (optional module, default off): `AI_DIAGNOSTICS_DATABASE_URL` —
  a **dedicated non-superuser, SELECT-only** database role for the diagnostics
  tool substrate, provisioned with `npm run diagnostics:provision-role`. It is
  never the app's `DATABASE_URL` (the Compose app role is a superuser), and the
  app verifies the role's privileges with the server before every read. Required
  before the module can be used. See
  [`docs/ai-diagnostics/deployment.md`](docs/ai-diagnostics/deployment.md).
- Admin health: optional `CRON_LEADER_RUNTIME_STATUS_URL` when the cron leader
  is not reachable from web containers at
  `http://app:3000/api/deploy/runtime-status`
- Observability: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`

Do not commit `.env` files or production secrets.

## GitHub Container Registry

GitHub Actions publishes production images after CI passes on `main`:

```text
ghcr.io/<owner>/alpineclubbookingsnz-app:<commit-sha>
ghcr.io/<owner>/alpineclubbookingsnz-migrate:<commit-sha>
```

If those packages are private, log in to GHCR once on the production host as
the same Linux user that runs deployments. Use a token with only
`read:packages` access:

```bash
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u <owner> --password-stdin
```

Do not store that token in the repository or `.env`.

## First Bootstrap

From the target host:

```bash
git clone https://github.com/<owner>/AlpineClubBookingsNZ.git AlpineClubBookingsNZ
cd AlpineClubBookingsNZ
cp .env.example .env
# edit .env with your own values
docker compose up -d --build postgres
docker compose run --rm migrate
docker compose up -d --build app app_blue app_green caddy
docker compose ps
```

To validate the production image alone (without Compose), build it locally:

```bash
docker build -t tacbookings:local .
```

Club identity, capacity, age tiers, seasons, and rates are configured **in the
database**, not in a file. After the migrate/seed steps, sign in as the seeded
admin and complete configuration at `/admin/setup` (identity, lodges/capacity,
seasons/rates, email, Stripe, Xero). Optionally run `npm run setup:wizard`
against the migrated database to bootstrap the club identity, capacity, and age
tiers from the CLI — it writes those database settings rows (no `config/club.json`
is written). `config/club.json` remains an optional seed/fallback only: copy
`config/club.example.json` to `config/club.json` and edit it if you want to pin
a boot-time fallback, but it is no longer required.

Create or seed accounts only for the intended environment. The first admin
from `prisma/seed.ts` is controlled by `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` (optionally `SEED_ADMIN_FIRST_NAME` and
`SEED_ADMIN_LAST_NAME`), and the shared lodge kiosk account by
`SEED_LODGE_PASSWORD`. The seeded admin can log in immediately and is forced
to change password on first login; change all seed credentials before any
shared environment is exposed. The seed is create-if-missing throughout, so
re-running it against an existing database changes nothing; committee and
chore placeholders are only inserted when those tables are empty.

## Routine Production Deploy

The supported AlpineClubBookingsNZ deploy path is:

```bash
./scripts/run-production-blue-green-deploy.sh
```

The script snapshots the resolved `origin/main` commit into a clean deployment
workspace, selects the matching GHCR image tags, copies the environment file,
preserves Caddy upstream state, then re-enters itself with
`--internal-blue-green-deploy` to run the blue/green deployment engine before it
fast-forwards the clean checkout after success.

For a fork, set `GHCR_APP_IMAGE_REPOSITORY` and
`GHCR_MIGRATE_IMAGE_REPOSITORY` if your image names differ from the defaults.

The internal deployment engine in the same script:

- pulls the app and migration images for the resolved commit SHA
- skips local Docker builds when `APP_IMAGE` and `MIGRATE_IMAGE` are supplied
- validates pending migrations against the blue/green migration policy
- runs Prisma migrations through the `migrate` service
- starts the inactive color slot with `CRON_ENABLED=false`
- waits for `/api/health/ready`
- warms the new release's public pages and verifies its page cache, refusing to
  continue if a critical page failed (see "Pre-cutover warm-up gate")
- updates Caddy upstream routing
- verifies the public domain is serving the target runtime through
  `/api/deploy/runtime-status`, authenticated with the existing `CRON_SECRET`
  as the `x-cron-secret` header
- drains the previous slot

If `APP_IMAGE` and `MIGRATE_IMAGE` are not supplied, the internal engine keeps
the old local-build path for bootstrap, staging, and recovery work.

## Public Rate Limits And Proxy Headers

Public route rate limits are process-local sliding windows keyed by
`getClientIp()` in `src/lib/rate-limit.ts`. This is acceptable for the supported
production shape because Caddy is the only public listener and routes traffic to
one active web slot at a time.

During a blue/green deployment, the old slot can still serve requests while the
configured drain window expires. Rate-limit counters are not shared between the
old and new slots, so public abuse controls can be temporarily split across both
runtimes during that drain. Do not run multiple publicly routed app replicas
long-term unless the in-memory limiter is replaced with a shared store.

**A `Caddyfile` change does not ship with an app deploy.** The blue/green runner
rebuilds and cuts over the app slots; it does not reload Caddy. After pulling a
release whose diff touches `Caddyfile` or `Caddyfile.staging` — request-body
caps, security headers, routing — reload Caddy explicitly on the host, and check
the config first so a typo cannot take the site down:

```bash
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

`reload` is a graceful, zero-downtime config swap; it keeps existing
connections and the TLS certificate cache. If `validate` fails, fix the file
before reloading — the running config stays in place until a reload succeeds.

The app trusts proxy-derived client IP headers only under that Caddy boundary.
`getClientIp()` uses the rightmost `X-Forwarded-For` value, which is the peer
Caddy appended closest to the app container, then falls back to `X-Real-IP`.
Do not expose app containers directly to the Internet or through another proxy
that preserves attacker-supplied `X-Forwarded-For` values without appending its
own trusted peer address.

## Migration Safety

Read `docs/BLUE_GREEN_MIGRATION_POLICY.md` before deploying schema changes.
Migrations must be compatible with old and new app versions during cutover.

Potentially breaking migrations require explicit operator acknowledgement with:

```bash
ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="..."
BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1
```

Use this only with a written rollback and lock-impact plan. For a pending
`windowed` row, set the stopped-runtime acknowledgement only after public traffic
is removed, the old web colour and every worker/scheduler/queue consumer are
stopped, and `pg_stat_activity` confirms no old connection remains.

### Expand then contract (multi-lodge)

Some features ship as a two-step expand/contract pair: an expand release adds
nullable columns and backfills, and a later contract release tightens them
(`NOT NULL`, dropped superseded columns, added unique indexes). The
multi-lodge feature is the current example — its `lodgeId` columns landed
nullable and backfilled, with the tightening deferred.

**Do not run the multi-lodge contract release until the expand release is
fully cut over and the old (pre-lodge) app colour is completely drained.** A
draining old colour can still write `NULL`-`lodgeId` rows, which the `NOT NULL`
migration will reject, and the runtime keeps null-tolerant compatibility
branches alive until the contract release lands. Follow
`docs/multi-lodge/contract-release.md` for the item list, backfill
verification queries, sequencing, and the ledger entries that release needs;
each contract migration must name its `previous_expand_release` in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.

### Windowed migrations: a deploy with a maintenance window

Not every change can be expand-then-contract across two releases. When the owner
decides to complete one in a **single** release, the migration is declared
`old_code_compatible=windowed` in the safety ledger, which says plainly: the
previous release **will** break the moment migrate commits, so the deploy takes a
short planned outage instead of a rolling cutover.

Check for these before every deploy:

```bash
awk -F'\t' '$4 == "windowed" { print $1 }' docs/BLUE_GREEN_MIGRATION_SAFETY.tsv
```

**Current windowed migrations — there are three, and pending rows share ONE
window.** `prisma migrate deploy` applies them in the same command, so the
sequence below is run once, not once per migration.

- `20260803010000_contract_subscription_lockout_drop_enabled` (#2543 / #2561). It
  drops `MembershipLockoutSettings.enabled`. The previous release's Prisma client
  names that column on every read of the model, and the booking gates resolve the
  club's subscription-lockout policy through that read — so between migrate and
  cutover the old colour cannot take a booking at all.
- `20260803030000_contract_drop_family_group_member_role` (#2520). It drops
  `FamilyGroupMember.role`. The previous release's client names that column in
  ordinary projections, in the column list of every insert (a static
  `@default("MEMBER")` is materialised client-side), and in a `WHERE` clause —
  `role: "ADMIN"`, the one-step partner declaration read that the member profile
  page renders. So the old colour fails across the whole family surface: member
  profile, admin family groups, onboarding, family join/invite/removal, member
  merge, Xero member import and nomination. The owner authorised this one as a
  windowed drop on 3 Aug 2026, superseding an earlier plan that would have carried
  the obsolete column through another release.
- `20260806010000_fence_hosting_coverage_delivery_claims` (#2596). Its nullable
  columns are harmless to the previous Prisma client, but its worker protocol is
  not: an old hosting worker ignores the token/expiry fields and can take, email and
  complete work that a new worker already owns. The old web colour and **every** old
  worker must therefore be stopped before migrate, and only new workers may start.

There is no ordering that keeps both runtime protocols working, which is why the
window exists.

**The sequence, in order. Each step is there because the next one cannot be
undone without it.** This is the combined order — the one the owner directed for
#2520 and the one that governs a window carrying both migrations. It differs from
the runbook's §2.4 list in one place, the position of the backup, and the runbook
says which governs when:

1. **Build, publish and validate the new images first**, before touching the
   database — and confirm the image carries both the new runtime code and the
   expected migration. A build that fails after the column is dropped leaves no
   working release to start.
2. **Enter maintenance mode / remove user traffic.** Nobody should be mid-booking.
3. **Stop the old app *and* every worker, scheduler, cron runner and queue
   consumer** that can reach the shared database, then **verify nothing old is
   still connected** (`pg_stat_activity`). Anything left running produces the same
   failures with nobody watching them.
4. **Take a fresh backup and verify it.** Immediately before migrating, and — note
   the order — *after* everything that writes has stopped, so the snapshot is a quiet
   point with no writes landing between it and the migration. For an ordinary
   migration you can abort up to the cutover; for a windowed one the point of no
   return is the migrate step, so this is the last unconditional way back. See
   [Backups](#backups). **Do the full restore drill before the window**, on the most
   recent durable artifact — it is tens of minutes on a production-sized database and
   this step is inside the outage. Verify *this* artifact by integrity and completion
   instead: the exact commands, and why `pg_restore --list` is not one of them, are in
   `docs/PRODUCTION_UPGRADE_RUNBOOK.md` §2.4.1 step 7.
5. **Record the pre-migration checks** the runbook lists for the migration in hand
   — for `20260803030000` that is the row count, the distinct `role` values with
   counts, the column-exists confirmation, the proof that the replacement runtime
   cannot name the column, and the **required** per-row dump. Both of the
   `role`-related checks run inside the replacement image rather than at the host
   shell (this host has only Docker and Docker Compose), and the dump has to land on a
   **host** path and then move somewhere durable — a `\copy` through
   `docker compose exec postgres psql` writes inside that container's writable layer,
   which the deploy recreates. After migrate those values are unrecoverable.
6. **Run the safety validator, then migrate** — two commands, in that order. The
   validator is `scripts/validate-blue-green-migrations.sh`, a **separate script**
   that `prisma migrate deploy` knows nothing about: the only thing that runs it
   automatically is `scripts/run-production-blue-green-deploy.sh`, which performs
   the whole ordinary cutover this window replaces. So in a hand-run window the
   operator runs it or nothing does, and passing
   `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` to Prisma alone achieves nothing. It
   refuses without the acknowledgement above, a
   `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` naming this window, and
   `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1` set only after step 3; it refuses
   regardless if the migration ships no `rollback.sql`. Then migrate through the
   dedicated compose service the deploy script uses,
   `docker compose --profile migrate run --rm migrate` — not `npx`, which this host
   is not documented as having and which is deliberately removed from the runtime
   image. Pass all six pending migration files, in order — `20260803010000`,
   `20260803020000`, `20260803030000`, `20260803070000`, `20260806000000` and
   `20260806010000` — including the additive rows; exact commands are in
   `docs/PRODUCTION_UPGRADE_RUNBOOK.md` §2.4.1 step 9.
7. **Verify the migrate step**: the dropped column is gone and
   `_prisma_migrations` records each migration once.
8. **Start the replacement release and replacement workers only**, confirm
   `/api/health/ready`, smoke-test the affected surfaces, check the app, worker,
   Prisma and PostgreSQL logs for missing-column errors, then leave maintenance
   mode.

**If it goes wrong.** Prefer going *forward*: the schema is migrated and the data is
intact, so finishing the deploy is usually the fastest recovery. If the new release
will not start, run the reverse script beside the migration —
`prisma/migrations/<migration>/rollback.sql` — as the migration role, then redeploy
the previous release's images. **Never restart the previous release before running
the reverse script or restoring the backup**: after the drop commits, its client
names a column that no longer exists, so re-pointing traffic at it does not restore
service. Restore from backup only if the **data** is wrong rather than the schema.

**Before starting any previous-release image, complete this mandatory compatibility
and drain preflight while the NEW runtime and its cron/drain are still available.**
Demote the club-wide ENFORCED policy **and every explicit lodge ENFORCED override**
through the new Booking Policies UI; changing only the club row does not supersede an
explicit lodge override. Use the operator-approved `ADMIN_REVIEW_REQUIRED` or
`DISABLED` fallback, then run:

```sql
SELECT "id", "scopeKey", "lodgeId", "mode"
FROM "AdultMemberHostingPolicy"
WHERE "mode" = 'ENFORCED';
```

The result must be empty. The previous Prisma client cannot decode `ENFORCED`, and
the policy loader is on every booking write path. If any row is returned, prefer a
forward-fix. If rollback is unavoidable, record an operator-approved fallback for
each returned club/lodge policy, use the replacement runtime to save it as
`ADMIN_REVIEW_REQUIRED` or `DISABLED`, and repeat the query. Never guess the policy
or start the old runtime while the query still returns a row. If the replacement
runtime is unavailable, stop for a separately reviewed SQL mapping or restore the
verified backup.

After the **last** override change, keep the new runtime/cron running until both of
these queries also return zero rows:

```sql
SELECT "id", "memberId", "lodgeId", "attempts", "lastError",
       "claimToken", "claimExpiresAt"
FROM "HostingCoverageReevaluation"
WHERE "processedAt" IS NULL
ORDER BY "enqueuedAt", "id";

SELECT "id", "bookingId", "lodgeId", "stateKey", "openedAt"
FROM "HostingCoverageIncident"
WHERE "resolvedAt" IS NULL
ORDER BY "openedAt", "id";
```

Any row blocks rollback. A maximum-attempt or `lastError` re-evaluation is not safe
to ignore: it may no longer be automatically claimable, so diagnose/recover it with
the new runtime or a separately reviewed repair. An unresolved incident blocks even
when the queue is empty. Repeat the ENFORCED, unprocessed-work and unresolved-incident
proofs after the last policy change. **Only after all three remain empty** may you
stop every new worker and start the old-only release.

**When all three windowed migrations were applied in one window, first follow
`20260806010000/rollback.sql`'s no-op operational boundary:** keep traffic removed,
stop every new app/worker, and leave its nullable columns plus migration history
intact. Then roll back the two schema-removal migrations in reverse order —
`20260803030000` first, then `20260803010000`. One schema script is not enough:
whichever you skip leaves its column missing
and the previous release still broken, and if you skip `20260803010000` what stays
broken is every booking write path, while the family-group pages look fine and
suggest the rollback worked. The two touch different tables, so the order cannot
corrupt anything; it is the rule to follow because it generalises. Rehearsed both
scripts in that order.

The first three additive hosting migrations (`20260803020000`, `20260803070000`
and `20260806000000`) need no reverse scripts. `20260806010000` ships a mandatory
but deliberately no-op `rollback.sql`: its added schema is inert to the previous
client. Its operational rollback first keeps the new runtime available to demote all
club/lodge ENFORCED rows, drain every re-evaluation and close every incident; only
then does it stop new workers and start old-only. The columns/history stay intact for
a clean roll-forward.

**After a `rollback.sql` the migration history lies, and nothing in the deploy path
notices.** `_prisma_migrations` still records the migration as applied, so
`prisma migrate status`, `prisma migrate deploy` and the deploy script's own drift
gate all report a clean database — measured, not assumed. The one command that sees
the leftover column is
`prisma migrate diff --exit-code --from-config-datasource --to-schema prisma/schema.prisma`.
Rolling forward later is best done by re-applying `migration.sql` by hand, which
leaves the already-correct history row alone; deleting the `_prisma_migrations` row
and migrating again works too but edits the history for no gain. You do not have to
roll the schema forward before starting the replacement release: the replacement
client works against the rolled-back schema, because the restored column is
`NOT NULL` with a constant default.

Full step-by-step, including the rehearsal evidence for the schema-removal windowed
migrations, is in `docs/PRODUCTION_UPGRADE_RUNBOOK.md` → "Windowed migration deploy
sequence" (the #2520 sequence is its §2.4.1).

## Config Self-Heal On Boot

A routine production deploy runs `prisma migrate deploy` **only**. The seed
(`prisma/seed.ts`) does **not** run on an upgrade, and a SQL migration **cannot
read `config/club.json`** — so any config value the DB is expected to hold
cannot be backfilled by the migration or the seed on a live upgrade.

To close that gap the app runs a **boot-time config self-heal**
(`src/lib/config-self-heal.ts`, invoked from `src/instrumentation.node.ts`).
On every Node process start it walks a registry of self-heal steps and, for each
registered setting, copies the current **effective `config/club.json` value**
into the DB — using one of two presence rules, depending on whether the migration
that enabled the setting added a whole **row** or a single **column**. Properties:

- **Never overwrites admin intent.** Two write shapes, both guarded so a value an
  admin (or an earlier boot) already set is never touched:
  - **Row-level create-if-absent** — for a setting that owns its table/singleton
    row (e.g. the club identity row). The step writes only when the row is
    **absent** and leaves an existing row — including one an admin deliberately
    left partially null — completely untouched (`update: {}`).
  - **Column-level backfill** — for a **new nullable column** added to an existing
    singleton row long after that row was created (e.g.
    `ClubIdentitySettings.facebookUrl`, C5 #1984). A row-level check would skip
    every install whose row predates the column, so presence is keyed on the
    **column** instead: the step create-if-absent-upserts the row, then fills the
    column with an atomic `updateMany` scoped to `WHERE facebookUrl IS NULL`. It
    can therefore only ever populate a **still-null** column and never clobbers an
    admin-set value or a concurrent booter's write. A null on such a
    later-added column cannot be admin intent — the column did not exist when any
    prior admin edit was made.
- **Idempotent.** A healthy install re-checks and writes nothing on later boots.
- **Blue/green-safe.** When both slots boot at once, the second writer's
  unique-constraint conflict (Prisma `P2002`) is treated as already-present, so
  exactly one row is populated and no error surfaces.
- **Best-effort.** Self-heal runs regardless of `CRON_ENABLED` and can never
  block or fail startup; a step failure is logged (`scope: "config-self-heal"`)
  and boot continues.
- **Fallback-guarded.** Healing runs **only when the effective config came from
  a valid primary `config/club.json`** (loader provenance `"primary"`). If the
  primary is missing, unreadable, or malformed, the app boots on the
  `club.example.json` identity or the hard-coded safe default — and the
  self-heal **skips every step** rather than freezing that placeholder identity
  (or safe-default capacity and rates) into the create-if-absent DB rows. Those
  rows are DB-first authoritative and are never overwritten, so one bad boot
  would otherwise strand the site on `"Example Mountain Club"` until an admin
  edit or DB surgery. A skipped run logs a warning
  (`scope: "config-self-heal"`) naming the provenance; **it self-repairs
  automatically on the next boot** once a valid primary config is present. Every
  step (including the capacity / age-tier / rate steps later collapse children
  register) inherits this guard automatically.

This mechanism — not migration/seed backfill — is what lets later config
"collapse" changes remove a file/env fallback without stranding an existing
deployment: the DB is already populated with the club's real value before the
fallback is dropped. New settings register their own step in `SELF_HEAL_STEPS`.
Registered steps:

- **`club-identity-settings`** — backfills the club identity
  (`ClubIdentitySettings`) from `config/club.json`.
- **`club-identity-facebook-url`** (#1984) — column-level backfill of the
  `facebookUrl` column added after the identity row existed.
- **`age-tiers`** (#1983) — table-empty presence + one atomic create-if-absent
  row per effective-config tier (mirroring `prisma/seed.ts`'s tier seed); an
  admin-edited or pruned tier set is never touched. Heals **tiers only** —
  nightly rates live independently in `MembershipTypeSeasonRate` (#1930, E4).
  `src/lib/policies/age-tier.ts` reads age tiers DB-only at runtime; its
  hard-coded 4-tier default is only the last-resort net for an empty table.
- **`lodge-capacity`** (#1982) — backfills the default lodge's
  `LodgeSettings.capacity` from the `config/club.json` bed total (column-level:
  it fills a null `capacity`, create-if-absent, and never overwrites an
  admin-set value), gated so it only fires when the lodge would otherwise
  resolve to capacity 0. This is what keeps a Bed-Allocation-off default lodge
  from dropping to capacity 0 — and refusing all bookings — after the runtime
  `club.json` capacity fallback was removed.
- **`club-time-zone`** (#2989) — records the installation's club timezone in
  `ClubTimeSettings` from the zone the deployment is **already effectively
  using** (`TZ`, else `NEXT_PUBLIC_TZ`, else `Pacific/Auckland`), create-if-absent
  and never overwriting. This is the whole upgrade path for CT-1: a SQL migration
  cannot read a process environment, so seeding `Pacific/Auckland` in the
  migration would have silently reassigned the civil time of any club running on
  another zone. **It is the one step that runs regardless of config provenance**
  (see below), because the value it copies comes from the environment and not
  from `config/club.json`.

For a deliberate two-phase deploy, or to heal a cold database out-of-band
without a restart, run the same routine manually:

```bash
npm run config:self-heal
```

It prints, per registered setting, whether the row was `healed`,
`already-present`, or `failed`, and exits non-zero if any step failed.

If the effective config is a fallback (no valid primary `config/club.json`), the
`club.json`-dependent steps write nothing: it prints the provenance and the
remediation ("fix `config/club.json`, then rerun") and **exits non-zero** — an
out-of-band run that silently no-oped would hide the misconfiguration. Since
#2989 that skip is **partial rather than total**: the `club-time-zone` step is
exempt from the provenance guard and still runs, and the script now prints the
results of the steps that did run alongside the skip notice. The exit code stays
non-zero, because a partial run is not a success. The exemption is narrow and
deliberate — that guard exists to stop a placeholder *identity* being frozen into
create-if-absent rows, and the timezone step reads the environment rather than the
file, so there is no placeholder for it to freeze. Since #1987 an absent
`config/club.json` is normal for a database-first install, so gating the timezone
on the file would have meant those installs never recorded one.

## Config Bundle Auto-Import On Boot (DR / clone)

To seed a fresh instance — disaster recovery, or standing up a replacement /
clone — from a known-good configuration instead of hand-configuring it, drop the
club's exported **config-transfer bundle** on disk and point
`CONFIG_BUNDLE_IMPORT_PATH` at it. On the next Node boot — **after** migrations,
the base seed, and the C2 self-heal — the app applies that bundle
**non-interactively**, through the same validated import pipeline the admin
Export & Import page uses (`src/lib/config-transfer/bootstrap-import.ts`,
implementing ADR-003).

The whole provisioning flow becomes:

```text
deploy env + bundle file  →  prisma migrate deploy  →  base seed  →  boot auto-import  →  operational site
```

### Placement and enabling

- Export the source club's bundle from **Admin → Setup & Configuration →
  Export & Import** (tick the categories to carry; door codes are opt-in).
- The app containers run with a **read-only root filesystem** and, out of the
  box, mount only the `image_uploads` volume — there is no pre-existing
  `config/` mount. Bind-mount a host directory containing the bundle into the
  app services (read-only), and add the env var to the shared
  `x-app-environment` anchor so **all** replicas (`app`, `app_blue`,
  `app_green`) see the same file and the same setting:

  ```yaml
  # docker-compose.yml (or an override file)
  x-app-environment: &app-environment
    # ... existing entries ...
    CONFIG_BUNDLE_IMPORT_PATH: ${CONFIG_BUNDLE_IMPORT_PATH:-}

  x-app-service: &app-service
    # ... existing entries ...
    volumes:
      - image_uploads:/app/public/images
      - ./config-bundle:/app/config-bundle:ro   # bundle drop directory
  ```

  Then on the host:

  ```bash
  mkdir -p config-bundle
  cp /path/to/club-bundle.zip config-bundle/
  echo 'CONFIG_BUNDLE_IMPORT_PATH=/app/config-bundle/club-bundle.zip' >> .env
  docker compose up -d
  ```

  The path is the **in-container** path (`/app/config-bundle/club-bundle.zip`
  in this example). Because every replica boots the import step, the file must
  be readable by all of them — a shared bind mount on the `x-app-service`
  anchor guarantees that; the in-lock re-check (below) guarantees only one
  replica actually applies. The variable is unset by default; leaving it unset
  is a silent no-op.
- The file is **operator-controlled deployment configuration** but its bytes are
  treated as **untrusted** — full structural validation, resource caps, the
  secret/auth/member-coupling allowlist, and per-field Prisma-DMMF type checks
  all apply (a bundle can never carry secrets, auth material, members, or
  transactional data). The file is also `stat`ed before it is read: an
  oversized (> 50 MB bundle cap) or non-regular file is refused without being
  loaded into memory.

### The empty-target guarantee (fail closed)

The import applies **only when the database is empty of non-seed configuration**
— the pristine post-seed state with **no operator footprint**, defined as the
absence of ALL SIX of these signals:

1. no config bundle has ever been imported (interactive or bootstrap),
2. no bookings exist,
3. no members exist beyond the seeded system accounts (admin + lodge kiosk),
4. the setup wizard was never marked finished,
5. the setup wizard was never even started — no completed or skipped wizard
   steps (a club configured through `/admin/setup` without pressing "finish"
   is still configured), and
6. no audit-log row has a member actor (every admin configuration edit —
   direct editors included — audits with the admin's member id; only
   `system:`-prefixed synthetic actors and actor-less system rows are ignored).

If **any** of those is present, the import is **refused and nothing is written**
— a file dropped on disk can never overwrite a live or already-configured club,
whether it was configured by imports, bookings, members, the wizard, or direct
admin edits. A malformed / tampered / oversized bundle, an unreadable
`CONFIG_BUNDLE_IMPORT_PATH`, a probe query error, or any apply failure also
refuses and leaves the database untouched. The apply runs in a single atomic
transaction — with the emptiness probe **re-run inside the import lock** before
anything is written, and the idempotence marker committed in the same
transaction — so a mid-apply failure rolls back completely and two concurrent
boots can never double-apply. **Boot always continues**; a bootstrap bundle can
never block or crash startup.

One refusal deserves a special note: the seed creates key-weak defaults (the
default induction template, the example chore templates), so a bundle whose
source club **renamed** those defaults produces rename candidates that need a
human decision, and the bootstrap aborts with `refused-invalid` (nothing
written) — see the rename-abort log below. The fallback is the interactive
import (**Admin → Setup & Configuration → Export & Import**), where the renames
are resolved by hand.

Unlike the self-heal, this import is **not** gated on config provenance: the
bundle is the config source in a DR restore where `config/club.json` may be
absent, so it runs regardless of `clubConfigSource`. The pre-apply `pg_dump`
backup is the **one** ADR-002 safeguard waived here (an empty database has
nothing to protect); every other safeguard applies.

### Expected logs (`scope: "config-bootstrap-import"`)

- **Applied** (fresh empty target — exactly ONE replica logs this):
  `Config bundle auto-imported on boot: created N, updated M, unchanged K.`
  A `configuration.bootstrap_imported` audit row is written in the same
  transaction (system/deploy actor, bundle sha256, outcome); the admin audit
  log shows the actor as "System".
- **Multi-replica first boot** (INFO — expected, not an error): the compose
  stack boots `app`, `app_blue`, and `app_green` near-simultaneously; every
  replica probes, one wins the import lock and applies, and each **losing
  replica** logs
  `Config bundle auto-import refused: another writer configured the target
  while this import was being prepared (…). On a multi-replica boot this is the
  expected outcome for every replica that did not win the race. Nothing was
  written by this replica; boot continues.`
  (A replica that boots after the winner committed logs the steady-state
  refusal below instead. Either way: one "auto-imported" line total, calm INFO
  everywhere else.)
- **Steady state** (later boots with the variable still set, INFO — expected,
  not an error): `Config bundle auto-import refused: a config bundle was already
  auto-imported on a prior boot; the target is configured (steady state).`
  Steady-state boots do **zero file I/O** — the probe refuses before the bundle
  file is even statted.
- **Non-empty target** (WARN):
  `Config bundle auto-import refused: target already has … ; …` (or the
  wizard/member-actor variants of the six signals above).
- **Rename abort** (ERROR, `refused-invalid` — see the note above):
  `Config bundle auto-import refused: N row(s) need an interactive rename
  decision, which cannot be made non-interactively: induction-template "…", … .
  This can happen when the source club renamed seed-created defaults (e.g. the
  induction template or example chore templates). Import the bundle through
  Admin → Setup & Configuration → Export & Import instead, and resolve the
  renames there. Nothing was written.`
- **Bad bundle / path** (ERROR or WARN): a validation-error, oversized-file,
  unreadable-path, or apply-failure message — always stating that nothing was
  written and boot continues.

Because a successful import commits the `configuration.bootstrap_imported`
marker atomically with the config writes, the step is **idempotent and
race-safe**: leaving `CONFIG_BUNDLE_IMPORT_PATH` set across restarts simply
logs the calm steady-state refusal (with no file I/O) on every subsequent boot.
You may unset it once the site is up.

## Staging

Use staging for browser checks, accessibility review, and integration rehearsal.

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml run --rm migrate
```

See `docs/STAGING_ACCESSIBILITY.md` for route coverage and Lighthouse guidance.
Use Stripe test mode, Xero demo credentials, non-production email settings, and
synthetic data.

## Backups

The app runs scheduled PostgreSQL dumps to S3-compatible storage. **Backups are
configured in-app (#2095), not by environment variables.** Enable and configure
them at **Admin → Integrations → Database Backups** (`/admin/backups`):

- the **enabled** switch and the **retention** window (support-area edit),
- the S3 **bucket** and **region** (Full Admin only — repointing the destination
  exfiltrates the entire dump),
- the S3 **access key ID** / **secret access key** (Full Admin only, write-only,
  encrypted at rest in the `IntegrationCredential` store),
- an optional **restore-validation shadow database URL** (Full Admin,
  write-only) — each backup is restored into it and smoke-checked.

`BACKUP_CRON_SCHEDULE` remains an environment variable (cron-leader timing). The
legacy `BACKUP_ENABLED`, `BACKUP_S3_*`, `BACKUP_RETENTION_DAYS`, and
`BACKUP_RESTORE_VALIDATION_URL` variables are **no longer read**. On upgrade, a
deployment that still sets them completes the in-app re-entry (the Backups page
shows a "no longer used — re-enter in-app, then remove from the environment"
warning) and then removes the variables from the environment.

**Encryption-key coupling:** backup credentials are wrapped with a key derived
from `AUTH_SECRET`/`NEXTAUTH_SECRET` (HKDF-SHA256). Rotating that secret makes
stored credentials undecryptable, so the nightly backup fails **loudly** — it
records a `FAILURE` cron run and an error Sentry check-in (never a silent skip),
and the Backups page shows a "re-enter credentials" banner. Re-enter the S3
credentials in-app after any auth-secret rotation.

Do not treat local backup files as durable. The production Docker service runs
with `read_only: true` and mounts `/tmp` as tmpfs, so `/tmp/tacbookings-backups`
is RAM-backed and is wiped whenever the app container is recreated, including
routine blue/green deploys. If backups are enabled but no S3 bucket is
configured, the job no longer reports healthy: the dump is marked
`backup-not-durable`, the cron run records `FAILURE`, and the Sentry monitor
check-in is sent as an error. A healthy scheduled backup requires S3 upload and
readback verification.

**Run-now and concurrency:** the Backups page has a "Run backup now" button that
executes off the request path as a background job. Both it and the nightly cron
claim a DB-level cross-process lock (a `BackupRun` row under a
`pg_advisory_xact_lock`), so two containers (blue/green web slots + cron-leader)
never start overlapping dumps; a run whose container died mid-dump is reaped to
`FAILURE` after a staleness window.

The retention window prunes only the local backup files; it does not delete
objects already uploaded to S3. Enforce S3 retention with a bucket lifecycle
policy (or equivalent object-expiry rule) so uploaded dumps do not accumulate
indefinitely.

Operators should also keep provider-level snapshots or equivalent independent
backups. Test restore procedures before relying on backups.

## Webhooks

Configure webhook endpoints for the deployed domain:

- Stripe: `/api/webhooks/stripe`
- Xero: `/api/webhooks/xero`
- SES SNS: `/api/webhooks/ses-sns`

Stripe and SES webhook secrets are env-configured (`STRIPE_WEBHOOK_SECRET`,
`SES_SNS_TOPIC_ARN`); rotate them if exposed. The **Xero** webhook key is **not**
an env var since #2079 — it is captured in-app (Admin > Integrations) and stored
encrypted, and the `/api/webhooks/xero` route resolves it from there and stays
**fail-closed** (a missing/unreadable key rejects every delivery, it never
accepts).

The guided setup wizard (**Admin → Xero → Setup**, step 4 "Webhooks", #2081)
shows the exact delivery URL to paste into Xero, captures the webhook signing
key (Full Admin only), and **Verify** waits for Xero's intent-to-receive
validation ping to reach `/api/webhooks/xero` and pass HMAC before confirming.
Verification is freshness-scoped and bound to the currently stored key
(replacing the key re-arms it), so a green tick provably corresponds to a live
round-trip on the same resolver/HMAC path production uses. Webhooks are
optional: a deployment can invoice immediately and finish them later, in which
case a persistent amber **"Webhooks not configured — payment updates rely on
scheduled sync"** badge shows on the Xero pages until verified. A
localhost/non-public-HTTPS deployment cannot receive the ping — verify only
works once the site is reachable over public HTTPS. Because credential reads are
cached across the blue/green web slots + cron-leader for up to ~45s (#2079), the
wizard's verify polling window runs to 90s so a genuine ping still lands green
after a key write.

Subscribe the Stripe endpoint to these event types:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `payment_intent.requires_action`
- `payment_intent.processing`
- `setup_intent.succeeded`
- `setup_intent.setup_failed`
- `setup_intent.canceled`
- `charge.refunded`

If Stripe webhook delivery was missed while the endpoint, DNS, TLS, or
`STRIPE_WEBHOOK_SECRET` was wrong, fix the endpoint first, then use Stripe
Dashboard > Developers > Webhooks > the configured endpoint > Event deliveries
to resend failed events. Verify the event appears in webhook logs and the
affected booking/payment state before retrying operator actions. Do not repair
Stripe state by editing payment rows directly; unresolved payment-intent cleanup
is replayed by the payment recovery cron.

## Provider credentials: DB-only upgrade & auth-secret rotation (#2079)

### Upgrade: DB-only provider credentials

Since #2079 provider credentials (Xero here; Stripe/Google/Backup in later
releases) are stored **only** in the encrypted `IntegrationCredential` table and
captured in-app under **Admin > Integrations** (Full Admin only). Bootstrap-class
config (`AUTH_SECRET`, `DATABASE_URL`, `NEXTAUTH_URL`, SMTP/SES) is unchanged.

**What stops working at the upgrade** for a previously env-configured deployment
(e.g. an existing Xero-connected install):

- The old `XERO_ENCRYPTION_KEY` is no longer read, so the previously stored Xero
  OAuth tokens become **unreadable by design** (deliberately no silent key
  import). Xero surfaces a clean **"reconnect Xero"** state — no crash.
- `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` / `XERO_REDIRECT_URI` /
  `XERO_WEBHOOK_KEY` are ignored; setup readiness raises a warning naming the
  exact vars still present ("configured in-app now — re-enter there, then remove
  these from the environment").

**Re-entry order (per provider):**

1. Ensure `AUTH_SECRET` (or `NEXTAUTH_SECRET`) is strong (>= 32 chars, not the
   `.env.example` placeholder). Credential capture is **hard-blocked** on a weak
   secret; setup readiness shows a passive amber warning before you start.
2. Deploy the new release. Nothing fails at boot; readiness shows the legacy-env
   warnings and the Xero "reconnect" prompt.
3. Open **Admin > Xero > Setup** (the Integrations hub and the Modules "Set up"
   CTA link here) and follow the **guided Xero setup wizard** (#2080): it walks
   you through creating the Xero app with copy-paste-exact values (including the
   resolved redirect URI), re-entering the client id and client secret, and
   reconnecting. Each credential write is Full-Admin only, encrypted at rest, and
   audited (metadata only); values are never displayed back. Entering a new value
   resets the connection, so the wizard has you reconnect on the next step. The
   wrapped token-encryption key is auto-generated on first use.
4. Complete the wizard's **Connect** step (OAuth) so fresh tokens are stored
   under the new key, and confirm the connected organisation name it shows.
5. Remove the now-ignored `XERO_*` credential env vars from the environment;
   the readiness warning clears.

**Stripe (#2082):** the same cutover applies to payments. At the upgrade
`STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and
`STRIPE_WEBHOOK_SECRET` stop being read (setup readiness flags any still present).
Card payments pause until the keys are re-entered because the publishable key is
now delivered at runtime from the store, and the webhook route is fail-closed
until its signing secret is stored. Re-enter under **Admin > Integrations >
Stripe**: (1) with a strong auth secret, open the wizard and paste the secret and
publishable keys (test mode first if validating); (2) run **Verify connection** and
confirm the Stripe account name shown is the right one; (3) **reuse the webhook
endpoint your Stripe account already has** at this site's
`/api/webhooks/stripe` URL — open it under Developers > Webhooks, reveal its
current signing secret, and paste that back into the wizard. Only add a new
endpoint if none exists yet (fresh installs); creating a second endpoint on an
upgrade issues a *different* signing secret and orphans deliveries queued
against the old one. Send a Stripe test event to turn the webhook badge green
(this step is skippable — payments still process, but bookings only
auto-reconcile once the webhook is verified). **Events that arrive during the
re-entry gap are rejected fail-closed, and Stripe retries deliveries for about
72 hours** — restore the *same* signing secret within that window and the
queued events verify and replay on retry; duplicate deliveries are deduplicated
automatically. Replacing any Stripe key clears the verified webhook badge.
Then remove the legacy `STRIPE_*` env vars.

**Google Analytics (#2573):** the same in-app cutover, with one difference — the
GA4 measurement id is ordinary configuration rather than an encrypted credential,
so it is stored in plain text in the `AnalyticsSettings` table rather than in the
vault. At the upgrade `NEXT_PUBLIC_GA_MEASUREMENT_ID` stops being read, there is no
fallback to it, and **its value is not imported automatically** — so Google
Analytics goes inactive on every club at that deploy and stays inactive until an
admin enters and saves a valid measurement id.

**This is a required post-deploy step for any club that uses analytics.** With
finance edit access: enable the **Google Analytics** module at
**Admin → Modules** if it is not already on, then open **Admin → Integrations**,
select **Set up Google Analytics** on that card, and enter the measurement id
(`G-…`), the consent-banner mode, and the banner wording. Save takes effect at
once — it clears both the tagged public-layout cache and the stored public pages,
so no restart or redeploy is needed, and a removed or invalid id can never leave a
stale Google tag firing from a stored page. Then remove
`NEXT_PUBLIC_GA_MEASUREMENT_ID` from the environment.

The integration fails closed throughout: module off, no id, an invalid id, or a
database read failure all mean no analytics, and the public website keeps rendering
normally in every one of those states. Step-by-step walkthrough in
[`docs/guides/integrations.md`](docs/guides/integrations.md); the operator-facing
release note is in [`docs/UPGRADING.md`](docs/UPGRADING.md).

**Expected downtime:** none at deploy. Xero-backed operations (sync, webhooks,
invoice/payment automation) pause between the upgrade and step 4 completing, and
resume once credentials are re-entered and Xero is reconnected. Because
production runs blue/green web slots plus a cron-leader, a wizard write in one
web slot is observed by the cron-leader within the credential cache TTL
(30–60s), no restart required. Analytics is off for the same kind of gap — from
the deploy until the measurement id is saved.

### Auth-secret rotation runbook

Rotating `AUTH_SECRET`/`NEXTAUTH_SECRET` is a **planned maintenance event**, not
a casual refresh. Rotation drops, all at once:

- **all sessions** (everyone is signed out);
- **all 2FA enrolments and recovery-code hashes** — every member is forced back
  through two-factor enrollment on next sign-in. **Admin-lockout risk:** an admin
  who cannot immediately re-enroll (lost authenticator) can be locked out.
- **all stored provider credentials, for every provider in the store** — and the
  **wrapped Xero token-encryption key**. These fail GCM decryption afterwards and
  must be re-entered in-app; Xero must be reconnected (re-OAuth) and the Stripe
  webhook re-verified. **This runbook deliberately does not list the providers.**
  It used to name Xero and Stripe only, and stayed that way while Google, the
  backup destination and two AI keys joined the same store — an operator planned
  a rotation for two providers and would have met six mid-rotation. The one
  current list is
  [Credentials at rest → the provider list](docs/SECURITY-ATTACK-SURFACE.md#the-provider-list-and-the-one-place-it-lives-2720);
  read it before you start and budget re-entry for everything on it.

**Safe procedure:**

1. Announce the maintenance window to members and admins.
2. Before rotating, have at least one Full Admin **disable their 2FA** (so they
   can still sign in immediately after rotation), or confirm a break-glass access
   path.
3. Rotate the secret and redeploy.
4. Sign in, **re-enable/re-enroll 2FA** for admins first, then re-enter provider
   credentials (Admin > Integrations) and reconnect Xero.
5. Communicate to members that they must re-enroll 2FA on next sign-in.

**Security consequence (see `docs/SECURITY-ATTACK-SURFACE.md`):** because all
provider credentials are encrypted under key material derived from this one
secret, a database backup **plus** the auth secret is enough to decrypt every
stored credential. Production and staging/clones must therefore **never** share
an auth secret.

## Cron Schedule

The supported Docker Compose deployment runs scheduled work inside the `app`
cron-leader container when `CRON_ENABLED=true`. Blue/green web slots set
`CRON_ENABLED=false` and do not schedule jobs. The secured POST endpoints remain
available for the internal scheduler, manual operator retries, and custom
non-Compose deployments that intentionally use an external scheduler. Auth is
the `x-cron-secret` header set to `CRON_SECRET`.

The full schedule and all job names live in `docs/ARCHITECTURE.md`. Keep that
table and the cron registry in `src/lib/admin-cron-health.ts` as the source of
truth. The public POST endpoints are:

| Endpoint | Task(s) | Typical cadence | Recorded `CronJobRun.jobName` |
| -------- | ------- | --------------- | ----------------------------- |
| `POST /api/cron` | General cron cycle: pending booking confirmation, group-settlement reaper, abandoned policy-exception capacity-hold reaper, pre-arrival reminders, booking-request retention purge, quote-expiry reminders, school attendee confirmations, and placeholder guest-name reminders. | Every 3 hours in the cron leader. | `confirm-pending`, `group-settlement-reaper`, `placeholder-guest-name-reminders`, `policy-exception-hold-reaper`, `pre-arrival-reminders`, `purge-booking-requests`, `quote-expiry-reminders`, `school-attendee-confirmations` |
| `POST /api/cron/payments?task=recovery` | Durable Stripe payment recovery, expired Internet Banking hold release, and stale `WAITING_PAYMENT` Xero outbox reaping. | Every 15 minutes in the cron leader. | `payment-recovery` |
| `POST /api/cron/xero?task=memberships` | Optional Xero-backed membership status refresh. | Daily when `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH=true` and the Xero module is effectively enabled. | `xero-membership-refresh` |
| `POST /api/cron/xero?task=outbox` | Process queued outbound Xero operations. | Every 15 minutes when the Xero module is effectively enabled. | `xero-outbox` |
| `POST /api/cron/xero?task=retries` | Replay failed retryable Xero operations. | Every 15 minutes when the Xero module is effectively enabled. | `xero-operation-replay` |
| `POST /api/cron/xero?task=inbound` | Reconcile inbound Xero invoice, payment, contact, and membership state. | Every 15 minutes when the Xero module is effectively enabled. | `xero-inbound-reconcile` |
| `POST /api/cron/xero?task=backfill` | Backfill historical Xero object links; the default runner also performs link cleanup with this task. | Daily when the Xero module is effectively enabled. | `xero-link-backfill`, `xero-link-cleanup` |
| `POST /api/cron/xero?task=link-cleanup` | Deactivate stale canonical Xero object links. | Daily when the Xero module is effectively enabled. | `xero-link-cleanup` |
| `POST /api/cron/xero?task=report` | Send the Xero reconciliation report. | Daily when the Xero module is effectively enabled. | `xero-reconciliation-report` |
| `POST /api/cron/issue-reports` | Redact expired issue-report sensitive data. | Daily. | Not recorded |
| `POST /api/cron/alpine-server-sync` | Bidirectional Other Clubs sync with the Alpine Central Server: upload local rows changed since the last upload, download centrally-distributed rows changed since the last cursor. No-op when Other Clubs sync is disabled or the server is not configured. | Daily at 03:00 in the cron leader. | `alpine-server-other-lodges-sync` |

Without `/api/cron/payments?task=recovery` running on a regular schedule,
abandoned zero-dollar batch edits leave PaymentIntents held in Stripe
indefinitely. The admin `/api/admin/health` detailed report surfaces a stale
recovery queue when any `PaymentRecoveryOperation` row has been `PENDING` for
more than 15 minutes (the public `/api/health` report does not include this
signal). Each cron tick also sends an admin alert (re-using
`sendAdminPaymentFailureAlert`) when the queue contains a row that has
been pending for more than 30 minutes, with a one-hour cooldown to avoid
storming the inbox.

## Health Checks

Use these endpoints for smoke tests and load-balancer readiness:

```bash
curl -fsS https://your-domain.example/api/health
curl -fsS https://your-domain.example/api/health/ready
```

`/api/health/ready` is the readiness endpoint used by blue/green cutover.
Setup readiness and `/admin/setup` report optional modules as layered state:
`.env` capability, Admin Modules activation, and the resulting effective state.
The blue/green deploy script still validates explicit `.env` capability values
before deployment; Admin Modules do not replace that safety check.

## Rollback

Preferred rollback is to route Caddy back to the previous healthy color while it
is still running. If schema changes have already applied, rollback must respect
the migration policy and any compatibility constraints in the migration PR.

Keep deploy logs, the target commit SHA, migration output, and health-check
results with the release record.
