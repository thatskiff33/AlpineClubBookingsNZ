-- Reverse script for 20260825010000_narrow_calendar_date_columns (#2872, CT-3).
--
-- NOT REQUIRED BY THE GATE. `scripts/validate-blue-green-migrations.sh` demands a
-- `rollback.sql` only for an `old_code_compatible=windowed` row, and this
-- migration's ledger row declares `yes`. It ships anyway because a column TYPE
-- change is the shape an operator most wants a reverse script for, and because
-- `docs/BLUE_GREEN_MIGRATION_POLICY.md` is explicit that an operator finding an
-- empty folder mid-deploy is the failure a reverse script exists to prevent.
--
-- IT IS NEVER RUN AUTOMATICALLY. Prisma and every gate in this repository address
-- a migration folder by its `migration.sql` alone: this file is not applied, not
-- checksummed, and only ever run by an operator on purpose.
--
-- WHAT IT RESTORES, AND WHAT IT CANNOT. It restores the SHAPE — `timestamp(3)`
-- on all eleven columns — and here it also restores the VALUES exactly, which is
-- unusual for a reverse script and worth stating rather than assuming. `date` ->
-- `timestamp(3)` yields midnight on the same calendar day, and midnight on that
-- same day is precisely what every row held before the forward migration: the
-- forward migration's fail-closed preflight refuses to run at all if any row
-- carries a time, so there is no time-of-day for the round trip to have lost.
-- The one thing it cannot restore is a row WRITTEN while the new schema was
-- live: such a row was always a calendar day, so it comes back as that day at
-- midnight, which is the same encoding every other row uses.
--
-- WHEN AN OPERATOR NEEDS IT. Only after the forward migration has committed and
-- the deploy is being abandoned rather than carried forward. If the preflight
-- RAISED, nothing was altered and this file is not needed — the abort is already
-- the rollback.
--
-- ROLLING FORWARD AFTER THIS SCRIPT, and the reason it needs saying out loud.
-- Rehearsed on a throwaway PostgreSQL rather than reasoned about — apply every
-- migration, run this script, then try to roll forward:
--
--   * `_prisma_migrations` still records 20260825010000 as APPLIED, and nothing
--     in the deploy path notices that the database no longer matches it.
--     `prisma migrate deploy` answers "No pending migrations to apply." and SKIPS
--     this file. So the eleven columns stay `timestamp(3)` while every subsequent
--     release's Prisma Client is generated from a schema that declares them
--     `@db.Date` — and, the part that actually matters, the fail-closed preflight
--     never runs again, so a value that acquires a time after this point is
--     caught by nothing. No command in the deploy errors. That silence is what
--     makes this worth a paragraph rather than a footnote.
--   * The one command that SEES it is `prisma migrate diff --exit-code
--     --from-config-datasource --to-schema prisma/schema.prisma`, which exits 2
--     and prints "Altered column `validFrom` (type changed)" and its neighbours.
--     Run it if you want the state confirmed rather than assumed; it is the only
--     one of these that reads the live database.
--   * To roll forward, RE-APPLY migration.sql BY HAND as the migration role.
--     Measured: the columns come back to `date`, the preflight runs again on the
--     way through, and `migrate diff` returns to "No difference detected" — the
--     history row was already correct, so history, schema and database end in
--     agreement with nothing to clean up. Deleting the `_prisma_migrations` row
--     and migrating again is equivalent, but it edits migration history for no
--     gain.
--
-- Each statement takes an ACCESS EXCLUSIVE lock and rewrites its table, exactly
-- as the forward direction does. Run it with traffic removed. Unlike the forward
-- direction it does NOT take the tables exclusively up front: the forward lock is
-- there to make a fail-closed CHECK atomic with the cast it guards, and this
-- script has no check to protect.

ALTER TABLE "Member" ALTER COLUMN "dateOfBirth" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "Member" ALTER COLUMN "joinedDate" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "Member" ALTER COLUMN "lifeMemberDate" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "MemberApplication" ALTER COLUMN "applicantDateOfBirth" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "FamilyGroupJoinRequest" ALTER COLUMN "childDateOfBirth" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "FamilyGroupJoinRequest" ALTER COLUMN "requestedDateOfBirth" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "PromoCode" ALTER COLUMN "validFrom" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "PromoCode" ALTER COLUMN "validUntil" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "PromoCode" ALTER COLUMN "bookingStartFrom" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "PromoCode" ALTER COLUMN "bookingStartUntil" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "GroupBooking" ALTER COLUMN "joinDeadline" SET DATA TYPE TIMESTAMP(3);
