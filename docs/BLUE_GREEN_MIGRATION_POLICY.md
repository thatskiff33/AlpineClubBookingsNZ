# Blue/Green Migration Policy

Production deploys run Prisma migrations before the new web color receives traffic while the old color can still be serving requests against the shared Postgres database. Every committed migration must therefore preserve old-code/new-schema compatibility until the previous color has drained.

## Required Sequence

- Expand release: add nullable columns, new tables, new indexes, dual-write/backfill support, or compatibility views without removing the old shape used by the currently live app.
- Runtime release: move all reads and writes to the new shape while still tolerating the old one.
- Contract release: remove old columns, tables, indexes, enum values, token fields, or compatibility code only after the previous deployed runtime no longer depends on them.

Destructive contract migrations must name the previous expand/runtime release in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` and must declare `old_code_compatible=yes`. If that cannot be true, the migration is not valid for normal blue/green deploy and needs a separate maintenance/bootstrap plan.

## Deploy Gate

`scripts/blue-green-deploy.sh` calls `scripts/validate-blue-green-migrations.sh` before `prisma migrate deploy`. The validator checks pending migration SQL for:

- destructive schema removals, renames, type changes, `SET NOT NULL`, and constraint drops
- operations touching hot tables: `Member`, `Booking`, `Payment`, membership tables, finance token tables, and auth/action-token tables
- matching entries in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`

Hot-table migrations require a lock-impact plan in the ledger. Potentially breaking migrations also require `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and a non-empty `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` at deploy time, after the ledger documents why the active old color remains compatible.

## Historical Migrations

The April 2026 migration history contains single-step destructive changes that predate this policy. Those files are not edited retroactively because Prisma records migration checksums after deployment. If any environment still has one of those migrations pending, do not run it through the normal blue/green path; treat it as a bootstrap or maintenance migration with an explicit operator plan.
