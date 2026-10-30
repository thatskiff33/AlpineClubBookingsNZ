# Production reconciliation: subscription-category schema redesign

Audience: Operator, running this fork's own production deployment.

This is a one-time runbook for one specific situation: a production database
already ran the ORIGINAL two subscription-category migrations before the
upstream PR review requested the schema be reworked (see
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` for the redesigned pair,
`20261128010000`/`20261128020000`, and their own migration-file headers for
why they are `windowed` rather than an ordinary rolling expand). It does not
apply to a deployment that has never run any subscription-category migration
at all — that one just runs `prisma migrate deploy` normally and never needs
this page.

**Not a new migration file.** The reconciliation script
(`scripts/production/reconcile-subscription-category-redesign.sql`)
deliberately lives outside `prisma/migrations/` and must never be run as part
of an ordinary `prisma migrate deploy` — it is a hand-run, one-time repair for
exactly this fork's own history.

## Why this is needed

Production's `_prisma_migrations` table already has rows recording the two
OLD migrations (`20261121010000_add_subscription_category`,
`20261121020000_widen_membership_charge_for_category`) as applied, with
checksums matching their OLD file content. Those two migration folders no
longer exist in this branch — they were replaced, not edited in place
(editing an applied migration's SQL breaks Prisma's checksum-drift
detection on every fork that already ran it). Simply running
`prisma migrate deploy` against that state would either find the old
migration names missing entirely (if Prisma treats that as drift) or, if it
somehow proceeded, collide applying the redesigned pair against a schema that
already has the OLD shape's artifacts (the original CHECK, the original
columns) in place.

## Confirmed before you start

No club using this fork's production deployment has ever actually used the
subscription-category feature — no real category assignment, no
category-routed charge, and no `SubscriptionCategory` row beyond the
built-in "Individual" sentinel the original migration's own DML inserted
(`isBuiltIn = true`; expected on every production that ran it, since the
whole table is dropped in step 2 regardless — the guard ignores this one
row). The reconciliation script's own guard (step 0 of the SQL) refuses
outright if any of that turns out not to be true, rather than trusting this
assumption blindly — read its refusal message if it fires; it names exactly
what still needs handling by hand.

## This deployment is single-instance — no blue/green slots

Unlike the full `scripts/run-production-blue-green-deploy.sh` runbook this
page borrows its windowed-migration vocabulary from, this fork's own
production deployment runs the simple single-instance shape described in
`DEPLOYMENT.md`'s "First Bootstrap" section: one `app` container, no
`app_blue`/`app_green`, no bundled Caddy. Do not reach for the full
blue/green script or its drain-probe machinery here — the practical
equivalent of "windowed" for this deployment is simply: stop the one `app`
container, run the steps below, start it again.

## Sequence

1. **Take and verify a fresh backup.** This is the only rollback for the
   reconciliation script itself — it ships no `rollback.sql`, deliberately:
   it is destructive against an already-applied, now-superseded schema shape
   by design.

2. **Stop the single `app` container** (and any worker/cron process sharing
   the database):

   ```bash
   docker compose --env-file .env -p <your-project-name> down --remove-orphans
   ```

3. **Confirm nothing is still connected** to the database from the stopped
   process:

   ```sql
   SELECT pid, usename, application_name, state
   FROM pg_stat_activity
   WHERE datname = '<your-database-name>';
   ```

   Expect nothing but your own interactive session.

4. **Run the reconciliation script by hand**, as the application's own
   database role — `psql`, explicitly out-of-band, never through Prisma:

   ```bash
   psql "$DATABASE_URL" -f scripts/production/reconcile-subscription-category-redesign.sql
   ```

   If the guard fires, stop here and resolve what it names before
   proceeding — do not re-run with the guard removed.

5. **Run `prisma migrate deploy` normally.** This now applies, in one pass:
   every migration from `origin/main` this production database has never
   seen, plus the redesigned `20261128010000`/`20261128020000` pair (pending
   again, since step 4 removed the conflicting old ledger rows and schema
   artifacts). Because that pair is declared `windowed`, set the
   acknowledgement environment variables per
   `docs/BLUE_GREEN_MIGRATION_POLICY.md` for this run —
   `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1`, a non-empty
   `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` naming this reconciliation, and
   `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1` — set only now, after step 3's
   confirmation:

   ```bash
   docker compose --env-file .env -p <your-project-name> \
     -f docker-compose.yml -f docker-compose.production-external-db.yml \
     --profile migrate run --rm --no-deps \
     -e ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 \
     -e BLUE_GREEN_MIGRATION_OVERRIDE_REASON="subscription-category schema reconciliation" \
     -e BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1 \
     migrate
   ```

6. **Start `app` again:**

   ```bash
   docker compose --env-file .env -p <your-project-name> \
     -f docker-compose.yml -f docker-compose.production-external-db.yml \
     up -d --no-deps app
   ```

7. **Verify:**

   - `_prisma_migrations` shows every migration applied exactly once (no
     duplicate or missing rows for the subscription-category pair).
   - `\d "MembershipSubscriptionCharge"` shows the nullable
     `membershipTypeId`/`Key`/`Name` trio, the four nullable
     `subscriptionCategory*` columns, and the
     `MembershipCharge_type_xor_category` CHECK constraint.
   - A smoke-test billing preview run (`buildSubscriptionBillingPreview`
     against a test season) returns cleanly with no error.

## If something goes wrong partway

The reconciliation script (step 4) runs inside its own transaction and is
all-or-nothing — a failure there leaves the database exactly as it was
before the script ran, with the old migrations still recorded as applied.

If `prisma migrate deploy` (step 5) fails partway through the redesigned
windowed pair, follow the ordinary windowed-migration recovery described in
each migration's own `rollback.sql` header — but note that recovering from a
*mid-window* failure here still assumes the step-0 guard already proved no
real category data exists, so the stakes are lower than an ordinary
production windowed migration failure: there is nothing irreplaceable to
lose, only schema state to put back with the verified backup from step 1.
