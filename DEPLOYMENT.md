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
| `app` (cron leader), `AUDIT_RETENTION_DATABASE_URL` | nightly audit retention, only when set (#4453) | 2 |

The ceiling holds per container because `src/lib/prisma.ts` shares one client
through `globalThis` (#4269). Before that, each of Next's server bundles built its
own client and pool: one container with `connection_limit=10` was measured at 22
backends under load, which made the 27-connection budget below an undercount by
about a factor of two. The same measurement after the change reads 10. A pool you
add elsewhere (the audit-archive client, the diagnostics pool) is extra and is
opened only when that feature is configured.

The worst case is a blue/green handover (both web slots briefly live) that
overlaps a migration:

```
app_blue(10) + app_green(10) + app(5) = 25 steady
                                 + migrate(2) = 27
```

That leaves the pools **13 slots** under the 40 ceiling. The audit-retention pool
(2, only while the nightly job runs, and only once the roles are split) brings the
worst case to 29. Those slots are **not** a protected admin reservation while the
app connects as role `tac`, which the `postgres` image creates as a **superuser**
(`POSTGRES_USER`) and which is still the default: `superuser_reserved_connections`
(the 3 slots Postgres nominally holds back) does **not** fence the app's own pools
off, so once the pools reach the ceiling even a superuser `psql` is refused. With
the [least-privilege roles](#least-privilege-database-roles) in place no pool
connects as a superuser, and those 3 slots really are kept for the operator. The headroom is therefore best-effort room for the
**non-pool** consumers you must budget alongside the pools:

- the nightly `pg_dump` backup (its own backend, outside every pool)
- the deploy-window shadow/drift database and admin `psql`, on the same server
- the `pg_isready` health probe (every 5s)
- any operator `psql`

So the real invariant is **sum(pools) + non-pool consumers ≤ `max_connections`**,
not just the pools; steady state (one active web slot + cron leader) is far lower.

The same "waiters hold their connection" property is why the **migrate**
connection carries a 5-second `lock_timeout` (#3377, `MIGRATION_LOCK_TIMEOUT_MS`).
A migration's `ALTER TABLE` waiting for `ACCESS EXCLUSIVE` on a hot table puts
every later reader of that table in the lock queue behind it; each of those
readers holds a web-pool connection while it waits, so ten of them exhaust a
slot and every further request is refused with Prisma `P2024` after that URL's
`pool_timeout` (10 s). The lock timeout has to fire well inside that window or it
cannot prevent anything — which is exactly why the deploy script refuses a value
at or over that `pool_timeout` (it derives the ceiling from the resolved Compose
model rather than restating it, so today the highest it accepts is `9999`), and
refuses `0`, which PostgreSQL reads as *wait forever* rather than as *off*. The measurement behind the default is in
[`docs/CONCURRENCY_AND_LOCKING.md`](docs/CONCURRENCY_AND_LOCKING.md#the-migration-lock-timeout-3377);
what an operator does when a deploy stops for this reason is in
[`docs/PRODUCTION_UPGRADE_RUNBOOK.md` §2.1a](docs/PRODUCTION_UPGRADE_RUNBOOK.md#21a-step-1320-stopped-on-a-lock-timeout).

`max_connections` was raised from 30 to 40 (and the `postgres` `mem_limit` from
512m to 768m) after production transiently hit `FATAL: sorry, too many clients`:
at 30 the deploy-window pools (27) sat one slot under the ceiling, so a single
overlapping backup, shadow DB, probe, or operator `psql` overflowed it — and
because the app role is a superuser (above), Postgres then refused *all* new
logins, the nominally-reserved slots included, locking operators out exactly when
they needed to diagnose. 40 restores real headroom for those consumers. The 768m
`mem_limit` covers the extra backends plus their `work_mem` (~256m more per host —
negligible above ~1 GiB free).

A true protected admin slot needs a **`NOSUPERUSER`** application role, so that
`superuser_reserved_connections` can hold slots back from it. The
[least-privilege roles](#least-privilege-database-roles) provide one (#4453, which
replaces #2240's decision to keep the single superuser). Until a deployment
switches, the hard-capped pools leave the ~13-slot margin described above. A
constrained-VPS fork may lower both values, but keep the invariant above whenever
you change a pool size, `max_connections`, or the replica count.

## Least-privilege database roles

Audience: Operator.

By default every container connects as `tac`, the PostgreSQL superuser. Since
#4453 a deployment can split that into roles that each hold only what their job
needs. The application then cannot change a booking-ledger line or an audit entry,
even if its credential leaks (owner decision, 27 Oct 2026). One route remains on
purpose: **deleting a booking still deletes its ledger lines** (below).

| Role | Default name | Used by | May |
| --- | --- | --- | --- |
| Operator | `tac` (`POSTGRES_USER`) | people: provisioning, restores, repairs | everything (superuser) |
| Migration | `tac_migrator` | the `migrate` service | own every object in schema `public`; run `prisma migrate deploy`; create temporary tables |
| Application | `tac_app` | both web slots and the cron leader | SELECT, INSERT, UPDATE, DELETE on ordinary tables; only SELECT on views; only **INSERT and SELECT** on `BookingLedgerLine` and `AuditLog`; only SELECT on `_prisma_migrations`; temporary tables |
| Audit retention | `tac_audit_retention` | the nightly audit retention job, on the cron leader only | SELECT and DELETE on `AuditLog`; UPDATE of `ipAddress` and `userAgent`, which a trigger lets it set only to empty |

None of the three new roles is a superuser, may create roles or databases, or is a
member of any role. The application role cannot TRUNCATE, `SELECT … FOR UPDATE` an
append-only row, alter or drop a table, `SET ROLE`, or run superuser-only
statements. It cannot reach a ledger line or audit row by another route either:
- a view or rule over them is SELECT-only;
- a `SECURITY DEFINER` routine is refused;
- changing a booking's or a lodge's key is refused (a trigger on each parent,
  so the foreign keys' `ON UPDATE CASCADE` can never fire).

`src/lib/__tests__/database-roles.realdb.test.ts` proves each of these against
PostgreSQL. The AI Diagnostics role (ADR-007) and the audit archive database's
role are separate and unchanged.

**Deleting a booking still deletes its ledger lines.** `BookingLedgerLine.bookingId`
is `ON DELETE CASCADE`, and a cascade runs with the table owner's rights, not the
application's. That is how booking deletion works today. Whether it should change
belongs to the ledger design, not to these grants; #4482 tracks it.

### Switching a deployment over (blue/green)

Rehearse every step on staging first (`.env.staging`, the `-p tacbookings-staging`
stack in [Staging](#staging)), then repeat on production.

1. **Choose three passwords**, hex so they need no URL encoding:
   `openssl rand -hex 24`. Put them in `.env` as `MIGRATION_DB_PASSWORD`,
   `APP_DB_PASSWORD` and `AUDIT_RETENTION_DB_PASSWORD`. A password alone switches
   nothing. **Do not set `APP_DB_USER` or `MIGRATION_DB_USER` in `.env` yet**: they
   are the switch (step 3). If you want role names other than the defaults
   (`tac_app`, `tac_migrator`, `tac_audit_retention`), export them in the shell for
   step 2 only.
2. **Preview, then provision, in a quiet window**, as the operator. The first
   `--apply` hands every table to the migration role, and `ALTER … OWNER TO` holds
   an exclusive lock on each table until the run commits. So run it when no long
   report, merge or open `psql` transaction is going. Each lock wait is bounded at
   5 seconds. A run that cannot get a lock stops with nothing changed and says
   "retry in a quiet window". The tables it has already handed over stay locked
   until the run commits. Each statement, not the whole run, is bounded at 120
   seconds: handing the tables over is one statement and can take that long on a
   slow server, and the checks after it run while the locks are still held. App
   requests that touch those tables wait meanwhile. Later runs only
   grant and revoke, and wait on nothing the app holds. Nothing connects without
   `--apply`.

   Export the values in the shell first. Docker then reads each bare `-e NAME` from
   that environment, so no password appears on the command line or in a process
   listing:

   ```bash
   export DB_ROLES_PROVISION_DATABASE_URL="postgresql://tac:<your-operator-password>@postgres:5432/tacbookings"
   export MIGRATION_DB_PASSWORD=<your-migration-password> APP_DB_PASSWORD=<your-app-password> \
     AUDIT_RETENTION_DB_PASSWORD=<your-retention-password>
   # and, only if you chose other names: export APP_DB_USER=… MIGRATION_DB_USER=… AUDIT_RETENTION_DB_USER=…
   docker compose --profile migrate run --rm --no-deps \
     -e DB_ROLES_PROVISION_DATABASE_URL \
     -e MIGRATION_DB_PASSWORD -e APP_DB_PASSWORD -e AUDIT_RETENTION_DB_PASSWORD \
     -e APP_DB_USER -e MIGRATION_DB_USER -e AUDIT_RETENTION_DB_USER \
     migrate ./node_modules/.bin/tsx scripts/provision-database-roles.ts          # dry run
   # …the same command with --apply at the end
   ```

   From a checkout with dependencies installed, `pnpm run db:provision-roles
   [--apply]` does the same. The run is one transaction:
   - it creates or repairs the roles;
   - it hands every object in schema `public` to the migration role;
   - it grants the rights above, and sets default privileges so tables that later
     migrations create reach the application at once;
   - it re-checks the result, and rolls back if the application role could still
     change a ledger or audit row.

   The running app still connects as `tac` and keeps working.
3. **Set the switch** in `.env`: `APP_DB_USER=tac_app`, `MIGRATION_DB_USER=tac_migrator`
   (their passwords are already there) and
   `AUDIT_RETENTION_DATABASE_URL=postgresql://tac_audit_retention:<your-retention-password>@postgres:5432/tacbookings?connection_limit=2&pool_timeout=10`.
   Compose gives that last one to the cron leader only. All three belong together:
   once the app role is split, the retention job needs its own role, because the
   application role may no longer change audit rows. The deploy script refuses
   `APP_DB_USER` without the other two. It also refuses a role password still
   exported from step 2 that differs from `.env`, because Compose would use the
   shell value; `unset` it, or open a fresh shell, before deploying.
4. **Deploy** as usual (`scripts/run-production-blue-green-deploy.sh`). The
   `migrate` service now runs as the migration role, and the new colour and the cron
   leader start as the application role. The old colour keeps its superuser
   connection until it is stopped, and no grant it relies on is removed. After the
   migrate, the deploy script checks two things: every relation in `public` is
   owned by the migration role and readable by the application role, and no view
   is writable by the application role. If either fails, it stops before the new
   colour starts and tells you to re-run `--apply`.
5. **Check**: the next `data-pruning` cron run succeeds, and
   `psql -U tac -d tacbookings -c "\du"` lists the three roles without
   `Superuser`.

**Rollback** is the reverse of step 3: unset `APP_DB_USER`, `MIGRATION_DB_USER`
and `AUDIT_RETENTION_DATABASE_URL`, and deploy. Ownership stays with the migration
role, which the superuser can still use, so nothing needs undoing in the database.
**Before switching back on**, re-run `--apply`. Tables that migrations created while
the stack ran as `tac` belong to `tac`, and the application role cannot see them.
The deploy script's post-migrate check would stop the deploy and tell you so.

**Rotating a password.** Every `--apply` sets all three passwords to the values it
is given. Running containers keep their open connections, but each new connection
needs the new password. So rotate in this order:
1. Put the new password in `.env`, and update `AUDIT_RETENTION_DATABASE_URL` if it
   is the retention one.
2. Run `--apply`.
3. Deploy straight away.

A "repair" re-run with a freshly generated password is a rotation too.

**Re-run `--apply`** in these cases:
- after the first migration of a brand-new database;
- after a release whose upgrade note changes `APPEND_ONLY_RELATIONS` or
  `AUDIT_ANONYMISED_REQUEST_COLUMNS` (`src/lib/database-roles.ts`,
  `src/lib/audit-retention-classes.ts`);
- after anyone creates an object as `tac`, including a `rollback.sql` or a
  hand-applied statement;
- to rotate a password.

It is idempotent and repairs drift. A hand-granted UPDATE on the ledger, a stray
role membership, a writable view, or a table someone created as `tac` is put back
on the next run.

### What changes for operators

- **Backups** keep working: the nightly `pg_dump` runs as the application role,
  which can read every table. A dump now carries `OWNER TO tac_migrator` and the
  grants. It restores with them **as the operator** on a cluster where the roles
  exist. On a new cluster, run step 2 against the empty database first.
- **Restore validation** (the optional shadow database on Admin → Backups) never
  needs a superuser. Give it a dedicated role that owns only the shadow database:

  ```sql
  CREATE ROLE tac_restore_check LOGIN PASSWORD '<your-restore-check-password>';
  CREATE DATABASE tacbookings_restore_check OWNER tac_restore_check;
  ```

  The validation restore leaves out the dump's owner and grant statements, so this
  role can replay it. **Never enter a superuser connection string there.** The app
  stores and uses that credential, so a compromised app would become a superuser.
  The app will not validate against a URL that names the same database as its own
  `DATABASE_URL` or the audit archive, whatever host, port or role it gives. It
  still takes and stores that night's backup, skips only the validation restore,
  and reports the run as failed with the reason. So give the shadow database its
  own name. A URL with no database names the
  database after its user, as libpq does.
- **Restoring over the live database from Admin → Backups no longer works** once
  the app is split: the application role may not drop the schema, so PostgreSQL
  refuses the restore before anything is touched. Restore as the operator with
  `psql`, on a cluster that has the roles.
- **AI Diagnostics provisioning** (`pnpm run diagnostics:provision-role`) needs the
  operator connection. Set `AI_DIAGNOSTICS_PROVISION_DATABASE_URL` to it once
  `DATABASE_URL` is no longer a superuser. Its `TEMPORARY` revoke no longer affects
  the migration or application role: provisioning grants both `TEMPORARY` directly.
- **A migration that needs a superuser**, such as an untrusted extension or
  `ALTER SYSTEM`, fails under the migration role. Apply that one statement as the
  operator, re-run `--apply`, then re-run the deploy. Every migration in the
  repository today runs without one.
- **A role password may not contain a backslash**, as well as `@ / : ? # %` or
  whitespace. The provisioning SQL refuses one rather than rely on
  `standard_conforming_strings`.

**The ceiling is a setting, and the pool arithmetic above is not what a live host
measured.** `POSTGRES_MAX_CONNECTIONS` in `.env` sets `max_connections`
(default `40`, unchanged); it is applied when the `postgres` container is next
created, which a blue/green deploy does at step 11 when the compose model has
changed. The deploy refuses it at step 3, before that, unless the value the
`postgres` command would carry is a whole number above the pools the resolved
Compose model can open together (27 with the shipped pools) and at most `1000`:
Compose passes any string through, and PostgreSQL would reject `abc` only once
the container is being recreated. It became a setting because a routine
handover on a live host, before the
[#4269](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4269) fix
above, was sampled two seconds apart at **39 client connections** (the serving
web slot at 11, the cron leader at 18 and the freshly warmed target slot at 8
to 11) against the 27-connection budget — about 1.44 times it — and the
warm-up gate's page renders failed with `P2037: too many database connections
opened` while three app containers were live. With #4269's one pool per
container the default should hold again; a host that still sees that error
raises the ceiling rather than lowering a pool (a smaller pool moves the
failure to `P2024` pool timeouts under real traffic), and raises
`POSTGRES_MEM_LIMIT` with it: each
backend costs its `work_mem` and connection overhead, so going from 40 to 80
wants the limit taken from the default `768m` towards `1g`. The pairing
`POSTGRES_MAX_CONNECTIONS=80` with the default `768m` has run on one fork host
since mid-October 2026 without memory pressure, which is one host's evidence,
not a measurement of the headroom.

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
rather than a bare HTTP 400, because the deploy script asks it with busybox
`wget`, which discards the body of a non-2xx response. Out of range, either way, you
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
- Xero: **no env vars** (#2079). The Xero client id/secret and webhook key are
  captured **in-app** through the guided setup wizard at
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
- Email: `EMAIL_FROM`, plus the transport the provider flags declare — exactly
  one of `USE_AWS_SES`, `USE_SMTP_RELAY` or `USE_LOCAL_CAPTURE` may be true,
  and the step-3 preflight requires only that provider's keys: `SMTP_HOST`,
  `SMTP_PORT`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` and
  `SES_SNS_TOPIC_ARN` for AWS SES, or `EMAIL_SERVER_HOST`, `EMAIL_SERVER_PORT`,
  `EMAIL_SERVER_USER` and `EMAIL_SERVER_PASSWORD` for an SMTP relay or a
  capture mailbox. It checks what each app service would **receive** — the
  `docker compose config` values, after Compose's defaults and any shell
  export — not the `.env` lines. `docker-compose.yml` defaults `USE_AWS_SES`
  to `true`, so a relay sets **both** `USE_SMTP_RELAY=true` and
  `USE_AWS_SES=false`; naming no flag at all leaves AWS SES selected. Every flag
  false is refused, as the app refuses it, and `USE_LOCAL_CAPTURE=true` is
  refused because this deploy only runs a production-role site. `EMAIL_FROM` is
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
  tool substrate, provisioned with `pnpm run diagnostics:provision-role`. It is
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

### Supply chain

Builds use reviewed, immutable inputs. Every third-party Action is pinned to a
full commit SHA with its version in a comment; the CI Lint job rejects unpinned
workflow and composite-action references, including `docker://` actions.
External images in the Dockerfile and Compose files keep readable tags and pin
the multi-architecture index digest. Dependabot proposes Action and Docker
updates for review. The pnpm minimum release age matches the npm Dependabot
cooldown: seven days (`10080` minutes).
The already-locked `nodemailer@10.2.1` has an exact-version exception so frozen
installs work during rollout; remove it after the next Nodemailer update.

Both published images include a BuildKit SBOM and maximum build provenance,
plus a GitHub build provenance attestation tied to the pushed image digest.
Before deploying a published image, verify it with GitHub CLI (replace the
placeholders with the registry owner, image name and release tag):

```bash
gh attestation verify oci://ghcr.io/<owner>/<image>:<tag> --owner <owner>
```

Check that the verified repository and workflow are the expected publisher.
For an immutable deployment reference, set `APP_IMAGE` and `MIGRATE_IMAGE` to
the verified images' `ghcr.io/<owner>/<image>@sha256:<digest>` references.
Their Compose defaults remain local build outputs, whose digests exist only
after building. Verify the first published image after this change merges and
record the result in the release close-out.

The weekly and main-push OpenSSF Scorecard workflow uploads advisory SARIF
findings to code scanning; it is never a required check. App containers
(including staging and blue/green slots) drop all Linux capabilities and use
`no-new-privileges`. PostgreSQL and Caddy retain their existing capabilities;
Caddy binds privileged ports 80/443 and needs `NET_BIND_SERVICE`.

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
seasons/rates, email, Stripe, Xero). Optionally run `pnpm run setup:wizard`
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
`GHCR_MIGRATE_IMAGE_REPOSITORY` if your image names differ from the defaults —
either in the shell environment or, more durably, in the source repository's
`.env`. The shell wins over the file, the file wins over the upstream default,
and the file is read with Compose's own `.env` rules (quotes removed, `export`
allowed, the last duplicate wins). Step 3/8 prints which source each name came
from, because a default that silently points at the upstream registry is how
a fork's deploy fails at step 9 with "not found". Note that `sudo` strips the
shell environment; the `.env` route survives it.

### The deploy refuses a commit that exists on no remote (#3539)

Before it builds the workspace, the wrapper asks git whether the commit it
resolved is reachable from any **remote** branch. A commit that only your deploy
host holds — a local branch, a detached `HEAD`, a tag nobody pushed — is
refused.

This is not bureaucracy. A release nobody else has cannot be rebuilt, cannot be
reviewed, and quietly invalidates the *next* release's preconditions: the
pending-migration list, the ledger rows in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` and the upgrade notes are all worked out
against a commit that is not the one running. It has happened in production.

Building from a local branch is still legitimate — a registry outage, a depleted
CI budget — so there is an override, and it wants the decision written down:

```bash
ALLOW_UNPUBLISHED_DEPLOY_COMMIT=1 \
UNPUBLISHED_DEPLOY_COMMIT_REASON="GHCR outage 2026-09-20; hotfix built on the host" \
  ./scripts/run-production-blue-green-deploy.sh
```

The flag on its own is refused: without a non-empty reason the deploy stops. The
reason is printed in the deploy log. Push the commit as soon as the reason no
longer holds.

The check asks the remote, not this host's copy of it. A remote-tracking ref
such as `origin/feature` is a local cache, and the deploy's fetch prunes only
the branch it fetched — so a branch deleted on the remote can leave a ref here
that would vouch for a commit nobody else has. If **no** remote can be reached
at all, the deploy does not refuse on that ground: it warns that it could not
confirm, says the local refs may be stale, and continues. An outage is not a
reason to block a deploy whose commit really is pushed.

### Building the images on the host (#3539)

When CI cannot build the images — a depleted Actions budget, a registry you
cannot reach from CI — build them on the deploy host with the supported mode
rather than by hand:

```bash
./scripts/run-production-blue-green-deploy.sh --build-and-push-images
```

**This mode pushes, so the host needs a GHCR token with `write:packages`** —
not the `read:packages` token the "GitHub Container Registry" section above
tells you to log the host in with, and which is the right default for a host
that only ever pulls. Log in with a push-capable token for the build, and log
back in with the read-only one afterwards. The script says so before it starts
building, because the alternative is finding out after a full `next build` on a
small server.

It resolves and checks the commit exactly as a deploy does, extracts the same
clean `git archive` workspace, and builds with the same build arguments CI
passes — including `RELEASE_ID`, which a bare `docker compose build` does not
set. Before it pushes anything it starts the image it just built and reads
`RELEASE_ID` back out of the running container. If the identifier did not reach
the runtime environment, nothing is pushed.

That read-back matters because a missing `RELEASE_ID` is invisible from outside
the image, and two things quietly degrade without it: the pre-cutover warm-up
gate can no longer confirm it warmed the release being deployed (it warns
instead), and the public website's per-release CSP nonce falls back to a
per-build seed.

Then deploy the pushed tags normally:

```bash
./scripts/run-production-blue-green-deploy.sh
```

### A failed deploy leaves a record (#3539)

From the migrate step onward the database may no longer match either release,
and until #3539 the only account of what happened was the operator's terminal.
Any failure at or after step 13 now writes a file to
`$HOME/tacbookings-deploy-failures` (override with `DEPLOY_FAILURE_RECORD_DIR`)
naming:

- the step the deploy died on, the release attempted, and both image references;
- the migrations that were pending when the deploy began;
- what the database says about them — selected on `started_at`, so a migration
  that began and did **not** finish is reported as exactly that rather than as
  "nothing applied";
- whether traffic had already moved to the new colour — and, when it had and
  the new colour was already verified healthy from outside, that it **stays**
  there and no restore is attempted, because that is what the script really
  does.

If the database could not be reached, the record says `UNKNOWN.` as its own
state. It does not say `NONE STARTED.`, because a database that is down after a
migration was attempted against it is the one case where a reassuring answer
would be the most damaging. Those two strings are the ones printed in the file,
so they are the ones to look for.

### What the internal engine does

The internal deployment engine in the same script:

- pulls the app and migration images for the resolved commit SHA
- skips local Docker builds when `APP_IMAGE` and `MIGRATE_IMAGE` are supplied
- validates pending migrations against the blue/green migration policy
- runs Prisma migrations through the `migrate` service
- starts the inactive color slot with `CRON_ENABLED=false`
- waits for `/api/health/ready`
- warms the new release's public pages and verifies its page cache, refusing to
  continue if a critical page failed (see "Pre-cutover warm-up gate")
- holds the previous release's images back from its own prune, so the rollback
  below stays possible (see "Rollback")
- updates Caddy upstream routing
- verifies the public domain is serving the target runtime through
  `/api/deploy/runtime-status`, authenticated with the existing `CRON_SECRET`
  as the `x-cron-secret` header
- drains the previous slot

If `APP_IMAGE` and `MIGRATE_IMAGE` are not supplied, the internal engine keeps
the old local-build path for bootstrap, staging, and recovery work.
Image validation reads each service's image from `docker compose config`, so
directory-name normalization, a `.env`-only `COMPOSE_PROJECT_NAME`, and explicit
image overrides match the images Compose actually builds and runs. An unresolved
image stops the engine before image inspection; it never guesses a local tag.

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
Caddy sets that header to its resolved client IP (`header_up X-Forwarded-For
{client_ip}` in `deploy/caddy/tacbookings-active.caddy`), which is the connecting
peer when Caddy is the edge and, in `CADDY_TLS_MODE=local`, the address the
trusted proxy forwarded — see "Client IPs behind the proxy" below.

### Behind a TLS-terminating proxy: `CADDY_TLS_MODE=local`

The shipped `Caddyfile` assumes Caddy is the public edge: `{$DOMAIN}` is an
HTTPS site, Caddy obtains its certificates from Let's Encrypt over ports 80 and
443, and plain HTTP is answered with a `308` to HTTPS. An installation that
puts another proxy in front — Nginx Proxy Manager, Traefik, a cloud load
balancer — breaks both halves at once: Let's Encrypt can no longer reach Caddy
to validate, so a freshly created Caddy container has **no certificate at all**
and the proxy answers `502`; and if the proxy forwards to port 80 instead, it
relays Caddy's `308` back to the browser forever. The deploy's outside check
(`https://<DOMAIN>/api/health/ready`) fails the same way the browser does, so
step 17 reports an empty health payload and rolls the upstream back.

Set `CADDY_TLS_MODE=local` in `.env` for that shape, with
`CADDY_TRUSTED_PROXIES` set to the proxy's address (see "Client IPs behind the
proxy" below; the deploy refuses local mode without it). The Caddyfile's global
options import `deploy/caddy/tls-local.caddy`, which turns on `local_certs`:
Caddy issues every site's certificate from its own internal CA and never
contacts Let's Encrypt. Then point the proxy at the VM's **443** with scheme
**https** and tell it to accept a certificate that is not publicly trusted
(Nginx Proxy Manager: "Ignore Invalid SSL"). The browser only ever sees the
proxy's certificate.

A `.env` change reaches Caddy when its container is next created, and every
deploy recreates it at step 17 from that deploy's workspace. **Apply it by
running the deploy wrapper**, as for a release: it validates the Caddyfile with
the resolved `CADDY_TLS_MODE` and `CADDY_TRUSTED_PROXIES` at step 4, before the
migration, and carries the live upstream into its workspace at step 5/8. If
`main` has moved on and no release is due, set `DEPLOY_REF` to the commit that
is live — but only once the live commit already carries the `CADDY_TLS_MODE`
wiring (the Caddyfile import, the `deploy/caddy/tls-*.caddy` snippets and the
compose settings). Turning local mode on for the first time takes a deploy of a
commit that has them, because the deploy builds its workspace from the commit,
not from the checkout.

Do **not** run `docker compose up -d caddy` from the source checkout. The
running Caddy bind-mounts the live deploy workspace, whose
`deploy/caddy/tacbookings-active.caddy` names the serving colour. Compose run
from the checkout recreates Caddy with the checkout's mounts instead, and the
tracked copy of that file names `app_blue` and the cron leader `app`: on a host
serving green, whose blue container the last deploy removed, every request
then reaches the cron leader.

If a deploy is not possible, the manual route is equivalent to the deploy's
step 17 (`docker compose up -d caddy` in its workspace), run by hand in the live
workspace with the edited `.env` copied into it; the deploy's own call needs
neither flag below, because it already runs in that project and workspace:

```bash
cid=$(docker compose --project-name <project> -f <checkout>/docker-compose.yml ps -q caddy)
live=$(docker inspect "$cid" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/deploy"}}{{.Source}}{{end}}{{end}}')
workspace=$(dirname "$(dirname "$live")")
cp <checkout>/.env "$workspace/.env"
cd "$workspace" && docker compose --project-name <project> up -d --no-deps caddy
```

`<project>` is the deploy's Compose project (by default the checkout's
directory name, lower-cased); without `--project-name` Compose names a new
project after the workspace directory and starts a second Caddy. This route
skips the step-3 and step-4 checks, so a mistyped or missing value stops Caddy
instead of the deploy: an unset `CADDY_TRUSTED_PROXIES` reaches Caddy as a
placeholder it rejects.

Do **not** edit `Caddyfile` on the host for this: the deploy refuses a dirty
checkout, and the workspace it builds is a clean `git archive` that would drop
the edit on the next release.

#### Client IPs behind the proxy

Behind another proxy, the only peer Caddy sees is that proxy, so without more
the app would take the proxy's address as every visitor's: the per-IP rate
limits on login, registration, forgotten-password and magic-link requests would
share one bucket for the whole site (ten failed logins from anyone would lock
every member out for the window), and the audit log would record the proxy's
IP on every row. `tls-local.caddy` therefore declares the proxy as a trusted
proxy (`servers { trusted_proxies static … }`, from `CADDY_TRUSTED_PROXIES`)
with `trusted_proxies_strict`, and reads the visitor's address from the
proxy's `X-Forwarded-For`; the app's `reverse_proxy` then sends that resolved
address as the one `X-Forwarded-For` value the app reads.

`CADDY_TRUSTED_PROXIES` is **required** in local mode and has no usable
default: left unset, Compose hands Caddy a placeholder that Caddy rejects. Set
it to the proxy's own IP address or CIDR, for example `10.0.0.2/32`. Caddy
believes the forwarded address from any peer on the list, so the list should
be the proxy and nothing else. The step-3 preflight refuses local mode without
it, and refuses `private_ranges` (it trusts every private address on the
network, and the setting exists to make the trust explicit), any `/0` range,
and any entry that is not an IP address or CIDR. With
`trusted_proxies_strict`, Caddy reads `X-Forwarded-For` from the right and
takes the first address not on the list. The proxy must therefore append the
connecting address to `X-Forwarded-For` (Nginx Proxy Manager's default) or
overwrite the header; a proxy that passes the client's header through
unchanged is not suitable for local mode.


### Keep-alive windows must stay ordered (#3293)

**The app must hold an idle connection open for longer than Caddy will keep one
pooled.** Two settings say so, and they are set in opposite files:

| Where | Setting | Value |
| --- | --- | --- |
| App | `KEEP_ALIVE_TIMEOUT` (ms) in `docker-compose.yml` | `65000` |
| Caddy | `transport http { keepalive }` in `deploy/caddy/tacbookings-active.caddy` and `Caddyfile.staging` | `30s` |

Left to their defaults these are the wrong way round — Node closes an idle
connection at about 5 seconds while Caddy pools one for 2 minutes — so Caddy
reuses connections the app has already closed. A reuse that lands on the close
boundary is reset by the kernel, and Caddy's transport **cannot replay a request
with a streamed body**: a `POST`, `PUT` or `PATCH` therefore reaches the browser
as a bare `502` with no JSON body, and every admin form falls back to its generic
"could not save" message while the app logs nothing and the database sees no
statement. `GET`s never show it, because those *are* replayable and Caddy retries
them on a fresh connection invisibly.

If you change either value, keep the app's comfortably above Caddy's. Lowering
`KEEP_ALIVE_TIMEOUT` below the Caddy value reintroduces the fault exactly.

Fronting the app with something other than Caddy? Set that proxy's idle-connection
timeout below `KEEP_ALIVE_TIMEOUT` (nginx: `keepalive_timeout` on the upstream;
HAProxy: `timeout http-keep-alive`).

### Access logs

Every Caddyfile in this repository enables an access log on the application site
and attaches a redaction filter to Caddy's **default** logger, so both access
entries and `http.log.error` entries are covered. The rules live in one place,
`deploy/caddy/log-redaction.caddy`, and strip the same two families of secret the
application's own logger strips (`src/lib/redact-sensitive-json.ts`): bearer
tokens carried as a path segment, and secrets carried as a query parameter. Add a
new token-bearing path prefix to both files in the same change.

Logs go to the container's stderr, which Compose caps at `max-size: 10m` /
`max-file: 5`. Read them with:

```bash
docker compose logs --since 1h caddy | grep '"uri"'
```

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
stopped, and `pg_stat_activity` confirms no old connection remains. The
validator reads these three only from the deploy shell's environment, never from
`.env`. A `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1` kept in `.env` is a different
thing: the app's lasting #3413 acknowledgement, described in
`docs/PRODUCTION_UPGRADE_RUNBOOK.md`, and it never satisfies this check.

Immediately before step 13 migrates the app database, the deploy checks every
`app`, `app_blue` and `app_green` replica is stopped or absent, then requires
zero other app-database client backends, including idle/admin/external clients.
Paused-running containers, failed commands, invalid results and nonzero counts
refuse before migration or new app startup. A failed pending-migration read is
also refused, rather than interpreted as nothing pending (#4071). Ordinary
non-windowed deployments skip these drain probes.

These checks are snapshots. Keep the offline window until the new runtime is
ready: the deploy neither stops containers nor terminates sessions or prevents
clients reconnecting. The earlier shadow-database replay remains separate.
See the [migration policy](docs/BLUE_GREEN_MIGRATION_POLICY.md#a-windowed-migration-moves-the-rollback-boundary)
and [windowed upgrade sequence](docs/PRODUCTION_UPGRADE_RUNBOOK.md#24-windowed-migration-deploy-sequence)
for the drain and recovery requirements.

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

**The ledger is the list; this guide does not keep a copy.** The `awk` line
above names every windowed migration, and
[`docs/PRODUCTION_UPGRADE_RUNBOOK.md` §2.4](docs/PRODUCTION_UPGRADE_RUNBOOK.md#24-windowed-migration-deploy-sequence)
is the one per-migration list: what each one breaks in the previous release,
its preconditions, its `rollback.sql` and the order the reverse scripts run in.
**Pending windowed migrations share ONE window**: `prisma migrate deploy`
applies them in the same command, so the sequence below is run once, not once
per migration. For each of them there is no ordering that keeps the previous
release working, which is why the window exists.

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
   — for `20260928030000` that is the census's own output, saved: the counts by
   classification, the CANNOT TELL list (which must be empty) and how many school
   bookings the backfill is about to re-parent. §2.4.2 has the commands. The
   census is read-only and can be run as often as you like; run it once more
   after step 3, because a school approval landing between the last run and the
   window would add an unclassified row and the migration would refuse. For
   `20260803030000` that is the row count, the distinct `role` values with
   counts, the column-exists confirmation, the proof that the replacement runtime
   cannot name the column, and the **required** per-row dump. Both of the
   `role`-related checks run inside the replacement image rather than at the host
   shell (this host has only Docker and Docker Compose), and the dump has to land on a
   **host** path and then move somewhere durable — a `\copy` through
   `docker compose exec postgres psql` writes inside that container's writable layer,
   which the deploy recreates. After migrate those values are unrecoverable.
   For `20260929010000`, obtain the authorized private deployment lane's verified
   repair and full read-only overlap-census result, and record publicly only that
   the deployment prerequisite passed. Any changed row or additional pair stops
   the release for an individual owner decision.
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
   image. Pass all eighteen pending migration files, in order —
   `20260803010000`, `20260803020000`, `20260803030000`, `20260803070000`,
   `20260806000000` and `20260806010000`, followed by `20260913010000`,
   `20260913020000`, `20260913030000`, `20260923010000` and `20260927010000`,
   then programme #2912's `20260928010000`, `20260928020000`, `20260928030000`,
   `20260928040000`, `20260928050000` and `20260928060000`, and finally
   `20260929010000` — including the additive rows; exact commands are in
   `docs/PRODUCTION_UPGRADE_RUNBOOK.md` §2.4.1 step 9, and for the school pair
   §2.4.2 and for #3271 §2.4.3.
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
the previous release's images. **When a window carried more than one windowed
migration, run their reverse scripts in the OPPOSITE order to the one they were
applied in** — newest first. The #3369 pair is the worked example, and it enforces
that rule rather than relying on it: `20260928030000/rollback.sql` gives every
organisation-owned booking its member back, and only then can
`20260928020000/rollback.sql` re-impose the NOT NULL constraints, which refuse
loudly if it has not run. That refusal is the guard, not the failure. **Never restart the previous release before running
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

**When all four windowed migrations were applied in one window, keep traffic
removed and stop every new app/worker, then reverse them in application order.**
Run `20260929010000/rollback.sql` first while no relationship writer is active;
verify its pair table, functions, and triggers are gone without changing either
source table. Then follow `20260806010000/rollback.sql`'s no-op operational
boundary and leave its nullable columns plus migration history intact. Finally
roll back the two schema-removal migrations in reverse order —
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
pnpm run config:self-heal
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
  write-only) — each backup is restored into it and smoke-checked. Use a
  non-superuser role that owns only that database, never a superuser; the
  restore leaves out owners and grants so such a role can run it (see
  [Least-privilege database roles](#least-privilege-database-roles)).

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
with `read_only: true` and mounts `/tmp` as tmpfs, but `/tmp/tacbookings-backups`
is the disk-backed `backup_spool` named volume (#4487): dumps are compressed into
it as they stream, so a large database never has to fit in RAM. It is only a
working area on the same host as the database, so it is not a backup destination.
Each run that starts a dump, failed or not, removes its own files and anything
over an hour old, so another backup still running is untouched; it keeps its own
dump only while no destination received it. A dump in progress is written as
`<name>.partial` and given its final name only once complete. A healthy scheduled backup
needs at least one destination to hold the dump: a verified S3 upload (upload,
then readback with a size check) or a copy in the configured local backup
directory. If neither does, the job does not report healthy: the dump is marked
`backup-not-durable`, the cron run records `FAILURE`, and the Sentry monitor
check-in is sent as an error. A local directory sits on the same host as the
database, so only S3 is off-site; see
[docs/guides/backups.md](docs/guides/backups.md).

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
backups. Test restore procedures before relying on backups. With the
[least-privilege roles](#least-privilege-database-roles), restore as the operator
role: the in-app restore over the live database is refused.

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

Subscribe the Stripe endpoint to the event types in
[`src/lib/stripe-webhook-events.ts`](src/lib/stripe-webhook-events.ts) - the one
list the Stripe setup wizard's **Webhook** step shows, and which the webhook
handles every event of. Today that is:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `payment_intent.requires_action`
- `payment_intent.processing`
- `setup_intent.succeeded`
- `setup_intent.setup_failed`
- `setup_intent.canceled`
- `charge.refunded`
- `refund.failed` (#4104)

**Upgrading to #4104: add `refund.failed` to an existing endpoint.** In Stripe
open Workbench → Webhooks (Developers → Webhooks), select the endpoint, choose
**Edit destination** (or **Update details**) and add the `refund.failed` event.
It tells the app when a card refund Stripe first accepted has failed, so the
refund is owed again (it shows under **Refunds owed** and is retried). It is
**required**: the payments cron reads back only refunds still recorded as
pending, every 15 minutes, so it catches a pending refund that fails, but a
refund Stripe reported as succeeded and then failed reaches the app only
through this event. `refund.updated` and `charge.refund.updated` are also
understood if an endpoint already sends them; neither is needed. Add it once
the new release is the only one serving: an older release acknowledges an
event it does not know and drops it. Such a refund is still recorded pending,
so the new release's read-back finds it within a run or two. While old and new
releases both run, an old release's payments cron can claim a row the new
release raised or re-planned for a refund that failed later: it re-sends the refund under the old metadata reason,
so a re-send that fails later too is asked for once more rather than raised
dead, and a plan it rewrites drops the failed refunds it recorded (their Xero
card note then reads as uncovered when that row is closed as **Paid another
way**, and the Xero reconciliation report lists the difference). Adding
`refund.failed` only after the new release alone serves keeps the event's rows
out of that window, but not every row: the new release raises one from any
refund status it reads - a `charge.refunded` event, its cron's read-back, a
door's replay - so finish the switch-over promptly. In the same window an old
release's "Resolved" on a paid-twice task overwrites the close record where a
new close keeps its card-note cover, and an old release's card-note executor
does not subtract a close's cash; the Xero reconciliation report lists any
resulting difference.

**Refunds Stripe created before the upgrade are not re-sent.** The release
ships a marker migration (`20261115010000_card_refund_failed_later_cutoff`, no
schema change). A card refund Stripe CREATED before it finished, found failed
after the upgrade - most often by the cron's first read-back of older pending
refunds - is raised with its retries already spent, and the officers are
emailed: the member may already have been paid back by hand. It is listed
under **Card refunds Stripe gave up on** on the Stuck states page; check each
in Stripe and close it there as **Paid another way** once settled. Two
exceptions: a refund an open card refund row still counts as one of its own
slices is asked for again with that row, which no close can have settled yet;
and with a migration history that lacks the marker (rolled back), every
failed-later refund is raised this way.

**Check once after the upgrade: refunds the old release already saw fail.**
The old release took a card refund that failed later out of the payment's
refunded total without owing it again, whenever a later refund on the same
charge made it re-read the charge's refunds. Those rows already say `failed`,
so the new release never sees them change, and nothing in the database tells
one apart from a refund Stripe refused outright (which its door already asked
for again). In the Stripe dashboard, list the refunds that failed in the last
few months, and for any the member is still owed, pay them another way and
record it in Xero by hand.

If Stripe webhook delivery was missed while the endpoint, DNS, TLS, or the
signing secret stored under **Admin > Integrations > Stripe** was wrong (it is
entered in-app since #2082, not from an env var), fix that first, then in Stripe
open Workbench → Webhooks (Developers → Webhooks), select the endpoint and
resend the failed deliveries. Verify the event appears in webhook logs and the
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
   resets the connection, so the wizard has you reconnect on the next step.
4. Complete the wizard's **Connect** step (OAuth) so fresh tokens are stored
   under the new key, and confirm the connected organisation name it shows.
5. Remove the now-ignored `XERO_*` credential env vars from the environment;
   the readiness warning clears.

**Stripe (#2082):** the same cutover applies to payments. At the upgrade
`STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and
`STRIPE_WEBHOOK_SECRET` stop being read (setup readiness flags any still
present). Card payments pause until the keys are re-entered because the
publishable key is now delivered at runtime from the store, and the webhook
route is fail-closed until its signing secret is stored. Re-enter under
**Admin > Integrations > Stripe**: (1) with a strong auth secret, open the
wizard and paste the secret and publishable keys (test mode first if
validating); (2) run **Verify connection** and confirm the Stripe account name
shown is the right one; (3) **reuse the webhook endpoint your Stripe account
already has** at this site's `/api/webhooks/stripe` URL — open it under
Workbench → Webhooks (Developers → Webhooks), reveal its current signing secret,
and paste that back into the wizard. Only add a new endpoint if none exists yet
(fresh installs); creating a second endpoint on an upgrade issues a *different*
signing secret and orphans deliveries queued against the old one. To turn the
webhook badge green, Resend a recent delivery to this endpoint from the same
Workbench → Webhooks screen — or, if it has none yet, make a payment (a test
payment in test mode) — then click **Re-check verification**. This step is
skippable — payments still process, but bookings only auto-reconcile once the
webhook endpoint and signing secret are configured. **Events that arrive during
the re-entry gap are rejected fail-closed, and Stripe retries deliveries for
about 72 hours** — restore the *same* signing secret within that window and the
queued events verify and replay on retry; duplicate deliveries are deduplicated
automatically. Replacing any Stripe key clears the verified webhook badge. Then
remove the legacy `STRIPE_*` env vars.

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
- **all stored provider credentials, for every provider in the store**, the
  Xero tokens among them. These fail GCM decryption afterwards and
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
| `POST /api/cron/payments?task=recovery` | The payments cycle: durable Stripe payment recovery (with a read-back of card refunds still recorded pending, so one Stripe failed is owed again, #4104), expired Internet Banking hold release, stale `WAITING_PAYMENT` Xero outbox reaping, a retry of the held late-capture alert for any approval still open, and delivery of an owed alert for a card payment kept on a paid booking that nothing else paid for (#4285), and the released-credit requests (raise, record the card payment in Xero, close when Xero shows paid; raising is off until an operator enables it, see `docs/xero/ARCHITECTURE.md`). The cron leader runs the same cycle itself (`src/lib/payments-cron-runner.ts`), so no external scheduler is needed; each task is error-isolated and records its own run. | Every 15 minutes in the cron leader. | `payment-recovery`, `internet-banking-hold-release`, `xero-waiting-invoice-reaper`, `late-capture-held-alert`, `credit-release-asks`, `duplicate-capture-kept-alert` |
| `POST /api/cron/xero?task=memberships` | Optional Xero-backed membership status refresh. | Daily when `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH=true` and the Xero module is effectively enabled. | `xero-membership-refresh` |
| `POST /api/cron/xero?task=outbox` | Process queued outbound Xero operations. | Every 15 minutes when the Xero module is effectively enabled. | `xero-outbox` |
| `POST /api/cron/xero?task=retries` | Replay failed retryable Xero operations. | Every 15 minutes when the Xero module is effectively enabled. | `xero-operation-replay` |
| `POST /api/cron/xero?task=inbound` | Reconcile inbound Xero invoice, payment, contact, and membership state. | Every 15 minutes when the Xero module is effectively enabled. | `xero-inbound-reconcile` |
| `POST /api/cron/xero?task=backfill` | Backfill historical Xero object links; the default runner also performs link cleanup with this task. | Daily when the Xero module is effectively enabled. | `xero-link-backfill`, `xero-link-cleanup` |
| `POST /api/cron/xero?task=link-cleanup` | Deactivate stale canonical Xero object links. | Daily when the Xero module is effectively enabled. | `xero-link-cleanup` |
| `POST /api/cron/xero?task=report` | Send the Xero reconciliation report. | Daily when the Xero module is effectively enabled. | `xero-reconciliation-report` |
| `POST /api/cron/issue-reports` | Redact expired issue-report sensitive data. | Daily. | Not recorded |
| `POST /api/cron/alpine-server-sync` | Bidirectional Other Clubs sync with the Alpine Central Server: upload local rows changed since the last upload, download centrally-distributed rows changed since the last cursor. No-op when Other Clubs sync is disabled or the server is not configured. | Daily at 03:00 in the cron leader. | `alpine-server-other-lodges-sync` |

**Upgrading to the release that switches the payments cycle on (#3663).** Before
it, the cron leader never released expired Internet Banking holds, so a club can
carry a backlog. On the first 15-minute run after the upgrade, every expired
hold whose stay has not started is released: the booking is cancelled, the
member is emailed a cancellation, any account credit they used is restored, and
the unpaid invoice is cleared with a credit note. A hold whose check-in is on or before the club's today is never
cancelled; it is left for the treasurer, who is emailed once. And a hold with
any payment recorded against its Xero invoice is not released either (#3643):
it is kept with its beds and the treasurer is emailed; a hold whose invoice
Xero cannot read is kept too, until check-in or seven days past its deadline,
whichever comes first. Before
upgrading:

1. Reconcile outstanding Internet Banking payments, so a member who paid by
   transfer is recorded as paid rather than cancelled.
2. Count what the first run will release: `PENDING` Internet Banking payments
   holding beds (`internetBankingHoldSlots`), unreleased, past
   `internetBankingHoldUntil`, on a `CONFIRMED` booking whose check-in is after
   today. Expect the cancellations and emails that count implies, less any
   hold with a payment recorded against its Xero invoice, which is kept.

Without the payments cycle running on a regular schedule (the cron leader, or
`/api/cron/payments?task=recovery` on a custom deployment), expired Internet
Banking holds keep their beds and open invoices, and abandoned zero-dollar batch edits leave PaymentIntents held in Stripe
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

**The previous release's images are held back from the deploy's own prune
(#3539).** That rollback needs the previous images on the host, and the deploy
used to evict them itself: step 18 removes the inactive colour's container,
which leaves its image referenced by nothing, and step 20 then prunes it. The
deploy reported success while the rollback it documents had quietly become
impossible.

Before the first prune, the deploy now records the **image IDs** of the running
app containers and holds each one with a stopped placeholder container named
`tacbookings-rollback-hold-<image id>`. Docker never prunes an image a container
references, running or not. The holds are replaced on the next deploy, so at most
one release's worth exists at a time.

The ID rather than the tag is deliberate: in local-build mode the running colour
reports the mutable `<project>-app:local`, which the build then re-tags onto the
*new* image — a hold written against the tag would protect the image being
deployed, let the real rollback image fall dangling into the prune, and report it
retained.

To see what is held, and which image each hold is keeping:

```bash
docker ps -a --filter "label=nz.alpineclub.deploy.rollback-image-hold" \
  --format '{{.Names}}\t{{.Image}}'
```

**Using a held image depends on how the release was built.** With the normal
registry deploy, both images are tagged by commit SHA, so rolling back is
`APP_IMAGE=<repo>:<old sha> MIGRATE_IMAGE=<repo>:<old sha>` on the deploy — the
hold simply guarantees the tag still resolves. With a **local build** the tag
`<project>-app:local` has already been moved onto the new image, so point it
back at the held one first:

```bash
docker tag <held image id> <project>-app:local
```

The held id is the second column of the listing above, and it is also the
suffix of the placeholder's name.

Keep deploy logs, the target commit SHA, migration output, and health-check
results with the release record.
