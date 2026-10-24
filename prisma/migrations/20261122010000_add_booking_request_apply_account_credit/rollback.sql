-- Reverse script for 20261122010000_add_booking_request_apply_account_credit (#4019).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- WHAT IT LOSES: which open member whole-lodge requests asked for account
-- credit to be applied on approval. An approval made after the rollback
-- applies none; a request approved before it keeps its ledger rows, which
-- live on MemberCredit and are untouched here.
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261122010000 as APPLIED, so `prisma migrate deploy` skips it. Re-apply
-- migration.sql BY HAND before the release serves traffic; every row then
-- reads false again, and a member re-ticks the election on a new request.

ALTER TABLE "BookingRequest" DROP COLUMN IF EXISTS "applyAccountCredit";
