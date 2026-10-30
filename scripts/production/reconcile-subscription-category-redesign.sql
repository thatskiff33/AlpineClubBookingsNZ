-- Standalone, OUT-OF-BAND reconciliation script for one specific situation:
-- a production database already ran the ORIGINAL (pre-review-rework) two
-- subscription-category migrations (20261121010000_add_subscription_category,
-- 20261121020000_widen_membership_charge_for_category), and this fork is now
-- moving to the REDESIGNED pair (20261128010000/20261128020000) that replaces
-- them. This is NOT a normal migration file and must NEVER be placed under
-- prisma/migrations/ or run as part of an ordinary `prisma migrate deploy` —
-- see docs/guides/subscription-category-redesign-production-reconciliation.md
-- for the full operator runbook this script is one step of.
--
-- WHAT THIS DOES: removes the two old migrations' `_prisma_migrations` ledger
-- rows (so Prisma's checksum-drift detection does not refuse `migrate deploy`
-- once those migration folders are gone from the repo) and drops every schema
-- artifact those two migrations created, so `migrate deploy` can then apply
-- the full, current migration history — including the redesigned pair —
-- against a schema with no conflicting leftover state.
--
-- WHAT THIS ASSUMES, defended by the guard below rather than trusted blindly:
-- the subscription-category feature was NEVER ACTUALLY USED in production —
-- no club, group, or admin ever created a SubscriptionCategory row or
-- assigned one to a member. If that assumption is false, this script refuses
-- outright rather than silently discarding real data.
--
-- EXCEPTION: the built-in "Individual" sentinel row (isBuiltIn = true) that
-- the ORIGINAL migration's own DML inserted is expected on every production
-- that ran it — it is scaffolding, never looked up by id at billing time, not
-- admin-entered data, and the whole table is dropped in step 2 regardless.
-- The guard ignores isBuiltIn rows and only refuses on a real one.
--
-- NO rollback.sql is provided for THIS script, unlike an ordinary migration.
-- The only way back is the backup taken immediately before running it (see
-- the runbook) — this script is deliberately destructive against an
-- already-applied, now-superseded schema shape.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Guard: refuse if real category data exists anywhere.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "SubscriptionCategory" WHERE NOT "isBuiltIn") THEN
    RAISE EXCEPTION 'subscription_category_data_exists'
      USING HINT = 'At least one non-built-in SubscriptionCategory row exists. This script assumes the feature was never used in production — stop and handle the real data by hand rather than running this.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "MembershipSubscriptionCharge" WHERE "subscriptionCategoryId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'subscription_category_charges_exist'
      USING HINT = 'At least one MembershipSubscriptionCharge row is category-routed. Stop and handle it by hand.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "SeasonalMembershipAssignment" WHERE "subscriptionCategoryId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'subscription_category_assignments_exist'
      USING HINT = 'At least one SeasonalMembershipAssignment names a subscription category. Stop and handle it by hand.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "MembershipBillingException" WHERE "subscriptionCategoryId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'subscription_category_exceptions_exist'
      USING HINT = 'At least one MembershipBillingException names a subscription category. Stop and handle it by hand.';
  END IF;
END;
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Remove the ledger rows for the two OLD (replaced) migrations.
-- ---------------------------------------------------------------------------
DELETE FROM "_prisma_migrations"
WHERE migration_name IN (
  '20261121010000_add_subscription_category',
  '20261121020000_widen_membership_charge_for_category'
);

-- ---------------------------------------------------------------------------
-- 2. Drop the old schema artifacts, in dependency order: constraints/indexes
--    before the columns/tables they depend on.
-- ---------------------------------------------------------------------------

-- MembershipSubscriptionCharge: drop the old CHECK and partial index (both
-- guard-confirmed to apply to zero rows), the four category columns, then
-- re-require the type trio — safe, since the guard above proved every row
-- already has it populated.
ALTER TABLE "MembershipSubscriptionCharge" DROP CONSTRAINT IF EXISTS "MembershipCharge_type_xor_category";
DROP INDEX IF EXISTS "MembershipCharge_family_category_year_live_key";
ALTER TABLE "MembershipSubscriptionCharge" DROP COLUMN IF EXISTS "subscriptionCategoryId";
ALTER TABLE "MembershipSubscriptionCharge" DROP COLUMN IF EXISTS "subscriptionCategoryKey";
ALTER TABLE "MembershipSubscriptionCharge" DROP COLUMN IF EXISTS "subscriptionCategoryName";
ALTER TABLE "MembershipSubscriptionCharge" DROP COLUMN IF EXISTS "subscriptionCategoryFeeId";
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeId" SET NOT NULL;
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeKey" SET NOT NULL;
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeName" SET NOT NULL;

-- MembershipSubscriptionChargeCoverage: the original design's per-covered-
-- member audit columns, dropped from the redesign entirely (they were
-- write-only — nothing ever read them back). A production run under the
-- original migrations never populated them (the guard above already proved
-- no category charge exists), so dropping them loses nothing.
ALTER TABLE "MembershipSubscriptionChargeCoverage" DROP COLUMN IF EXISTS "membershipTypeId";
ALTER TABLE "MembershipSubscriptionChargeCoverage" DROP COLUMN IF EXISTS "membershipTypeName";

-- MembershipBillingException: the additive nullable column.
ALTER TABLE "MembershipBillingException" DROP COLUMN IF EXISTS "subscriptionCategoryId";

-- SeasonalMembershipAssignment: the FK, then the column (DROP COLUMN
-- cascades to drop the two simple-column indexes built on it automatically).
ALTER TABLE "SeasonalMembershipAssignment" DROP CONSTRAINT IF EXISTS "SeasonalMembershipAssignment_subscriptionCategoryId_fkey";
ALTER TABLE "SeasonalMembershipAssignment" DROP COLUMN IF EXISTS "subscriptionCategoryId";

-- The three new tables, children before parents.
DROP TABLE IF EXISTS "SubscriptionCategoryFeeComponent";
DROP TABLE IF EXISTS "SubscriptionCategoryFee";
DROP TABLE IF EXISTS "SubscriptionCategory";

COMMIT;
