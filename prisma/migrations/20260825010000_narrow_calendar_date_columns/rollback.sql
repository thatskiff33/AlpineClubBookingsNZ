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
-- on all twelve columns — and here it also restores the VALUES exactly, which is
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
-- Each statement takes an ACCESS EXCLUSIVE lock and rewrites its table, exactly
-- as the forward direction does. Run it with traffic removed.

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
ALTER TABLE "MembershipNominationSettings" ALTER COLUMN "gateEffectiveFrom" SET DATA TYPE TIMESTAMP(3);
ALTER TABLE "GroupBooking" ALTER COLUMN "joinDeadline" SET DATA TYPE TIMESTAMP(3);
