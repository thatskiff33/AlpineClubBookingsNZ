-- Reverse script for 20260808000000_contract_drop_booking_expected_arrival_time.
--
-- READ THIS FIRST. THE ARRIVAL TIMES ARE GONE. This script brings back an EMPTY
-- column, nothing more. Every expected arrival time a member ever entered was
-- destroyed when the migration ran, PostgreSQL cannot un-drop a column, and this
-- script has nowhere to read the old values from. Running it does NOT restore
-- them, and no amount of re-running it will. That is the owner's decision D-M2
-- on epic #2629 — the data deletion is deliberate and irreversible — written
-- here so that an operator who sees the column reappear does not conclude the
-- values came back with it. If you need the actual times, the ONLY sources are a
-- copy taken before migrating (the runbook's pre-migration checks) or the
-- verified backup taken in the same maintenance window. Restore from one of
-- those instead of relying on this file.
--
-- WHAT THIS IS FOR. That migration is declared `old_code_compatible=windowed` in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv, so its rollback boundary is the MIGRATE
-- step, not the cutover: once it commits, the previous release is already broken
-- and aborting the deploy no longer restores service. This script is the path
-- that undoes the SCHEMA change without a full restore. See
-- docs/BLUE_GREEN_MIGRATION_POLICY.md -> "A `windowed` migration moves the
-- rollback boundary".
--
-- Prisma never applies, checksums or even reads this file. Run it by hand, as
-- the migration role, against the database you are rolling back.
--
-- WHEN TO USE IT. To go back to the release immediately before this one — the
-- release whose prisma/schema.prisma still declares
-- `expectedArrivalTime String? @db.VarChar(5)` on model Booking. Prisma's client
-- SELECTs every scalar of a model on any unnarrowed find, so that release names
-- the column on ordinary reads of "Booking": the booking detail page, the member
-- bookings list, the lodge guests route, the pre-arrival reminder cron and the
-- booking-create paths. Without this script it cannot serve any of them — it
-- raises Postgres 42703 / Prisma P2022 on the busiest table in the product. If
-- you are rolling back further than that release, use the verified backup.
--
-- WHAT IT RESTORES, AND WHAT IT DOES NOT.
--
--   * The COLUMN comes back byte-identical to the one
--     20260408060000_add_expected_arrival_time created: `VARCHAR(5)`, NULLABLE,
--     no default, no index, no constraint. That is exactly the shape the
--     previous release's client expects from `String? @db.VarChar(5)`, so its
--     reads, its omitted-column inserts and its writes through the
--     PUT/DELETE /api/bookings/[id]/arrival-time route all work again. Adding a
--     nullable column with no default is metadata-only on PostgreSQL, so there
--     is no table rewrite and no window in which "Booking" is locked for long.
--
--   * THE PER-ROW VALUES ARE NOT RESTORED, and cannot be. Every booking comes
--     back with NULL. On the rolled-back release that reads as "no expected
--     arrival time given", which is the value the great majority of bookings
--     genuinely held and is what every surface already renders gracefully: the
--     booking card shows its empty editor, the kiosk chip reads "Arrival time:
--     Not specified", and the pre-arrival email composes no arrival line at all
--     (the token is empty, so there is no dangling "Expected arrival:" label).
--     Nothing fails and nothing is mis-stated — the club has simply lost the
--     times, and members who care would have to re-enter them.
--
--     NULL is not a "safe compatibility value" chosen from among several: it is
--     the ONLY value available, because the column was free-text and there is no
--     other field on the booking from which an arrival time could be derived.
--     Guessing one — from check-in date, from a club default, from anything —
--     would put a time in front of a hut leader that no member ever said, which
--     is the one mistake a rollback script must not make.
--
-- After running this, redeploy the previous release's images.
--
-- ROLLING FORWARD AFTER THIS SCRIPT. `_prisma_migrations` still records this
-- migration as applied, so `prisma migrate status` answers "up to date",
-- `prisma migrate deploy` answers "No pending migrations to apply", and the
-- deploy script's drift gate (`migrate diff --from-migrations prisma/migrations
-- --to-schema prisma/schema.prisma`) reports no difference — it compares
-- committed history to the schema file and never reads the live database. The
-- one command that sees the restored column is `prisma migrate diff --exit-code
-- --from-config-datasource --to-schema prisma/schema.prisma`, which exits 2. To
-- roll forward, RE-APPLY migration.sql BY HAND as the migration role; the
-- history row is already correct, so that leaves history, schema and database in
-- agreement. Any values members entered on the rolled-back release are destroyed
-- again at that point, for the same reason and with the same finality.
--
-- This script is NOT idempotent. A second run fails with `column
-- "expectedArrivalTime" of relation "Booking" already exists`, which is the safe
-- direction — a loud refusal rather than a silent double-apply.

-- 1. Recreate the column in the exact shape the previous release's client
--    expects. Nullable with no default, so every existing row is NULL and the
--    statement is metadata-only.
ALTER TABLE "Booking"
  ADD COLUMN "expectedArrivalTime" VARCHAR(5);

-- 2. Confirm the shape before you redeploy. Expect one row:
--    expectedArrivalTime | character varying | 5 | YES | (null)
SELECT
  column_name,
  data_type,
  character_maximum_length,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'Booking'
  AND column_name = 'expectedArrivalTime';

-- 3. There is no step 3. There is no value-restore step for this rollback and
--    there never can be, by owner decision D-M2. If the times matter, restore
--    the verified backup taken before the migration ran.
