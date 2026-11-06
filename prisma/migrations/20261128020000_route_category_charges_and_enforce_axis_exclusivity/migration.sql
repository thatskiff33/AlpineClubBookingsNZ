BEGIN;

-- Subscription-category decoupling, step 2 of 2 (close the window). Adds the
-- category-axis live-charge partial unique index and the CHECK that makes
-- "every charge bills on exactly one axis" true. Paired with
-- 20261128010000, which this follows; never applied apart — see that
-- migration's header for why.
--
-- NO BACKFILL DML. Unlike the Booking.memberId/organisationId precedent,
-- there is no historical data to re-key here: no club has ever had a
-- category charge (the feature has never shipped to production), so every
-- existing MembershipSubscriptionCharge row already satisfies the CHECK
-- this adds (membershipTypeId populated, subscriptionCategoryId null). This
-- migration's whole job is closing the gap the first half left open, not
-- moving any row's meaning.
--
-- WINDOWED, for the reason given in 20261128010000's header: between the
-- two halves, a writer could insert a category-only row (membershipTypeId
-- NULL) that the currently-deployed app's own un-null-checked reads of that
-- column would then silently mishandle. Required deploy acknowledgements:
-- ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1, a non-empty
-- BLUE_GREEN_MIGRATION_OVERRIDE_REASON naming this window, and
-- BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1, set only once the old app and
-- every worker/scheduler/queue consumer are stopped and verified via
-- pg_stat_activity. Take and verify a fresh backup immediately before
-- running (shared with 20261128010000 — one backup covers the whole
-- window, taken once, before the first of the pair).
--
-- The pre-existing #4110 "at most one LIVE family charge" partial unique
-- index for the type axis (MembershipCharge_family_type_year_live_key,
-- added by 20261118010000_membership_charge_family_unique_live_only) is
-- left COMPLETELY UNTOUCHED — not dropped, not re-scoped. It does not need
-- to be: a multi-column unique/partial-unique index never treats two NULLs
-- as equal (standard SQL), so any number of category charges
-- (membershipTypeId always NULL on them) coexist under this existing index
-- with no collision against each other or against type charges, with zero
-- changes to its definition.
--
-- LOCK IMPACT: the CHECK is added with ADD CONSTRAINT, which on PostgreSQL
-- validates by scanning the table — MembershipSubscriptionCharge is a cold
-- billing table (one row per family or member per season), so the scan is
-- small, but the validation does take ACCESS EXCLUSIVE for its duration,
-- same lock class as 20261118010000's own index build. The new CREATE
-- UNIQUE INDEX (the category-axis partial index only — the type-axis index
-- is untouched) likewise takes ACCESS EXCLUSIVE on
-- MembershipSubscriptionCharge for the build; the table has zero rows with
-- subscriptionCategoryId NOT NULL at this point (no category charge can
-- exist before this migration closes the window), so the build is over an
-- empty partial set. No advisory-lock key, acquisition order, provider call
-- or status transition changes.
--
-- Prisma cannot express a predicated index or a CHECK constraint, so neither
-- appears in prisma/schema.prisma as a modelled attribute; the new partial
-- index is registered in prisma/partial-unique-indexes.tsv, which
-- scripts/check-partial-indexes.sh holds to set equality in CI. The CHECK is
-- documented in a schema.prisma comment only (Prisma has no CHECK
-- primitive).

-- ---------------------------------------------------------------------------
-- 1. The category-axis live-charge partial unique index.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "MembershipCharge_family_category_year_live_key"
  ON "MembershipSubscriptionCharge"("seasonYear", "subscriptionCategoryId", "familyGroupId")
  WHERE "subscriptionCategoryId" IS NOT NULL AND "status" NOT IN ('NOT_REQUIRED', 'VOIDED');

-- ---------------------------------------------------------------------------
-- 2. Every charge bills on exactly one axis, from here on.
--
-- Maintainer review: `num_nonnulls(membershipTypeId, subscriptionCategoryId)
-- = 1` only constrains the two ID columns — it says nothing about Key/Name/
-- FeeId, so a type-axis charge (membershipTypeId set) could still carry a
-- stray subscriptionCategoryName with subscriptionCategoryId left NULL (or
-- vice versa), passing this CHECK while leaving a half-populated axis group
-- on the row. Widened so each axis's FULL column group is all-null or
-- all-set together, with exactly one group populated — matching the model
-- comment's own stated intent ("the whole type trio or the whole category
-- quartet").
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipSubscriptionCharge" ADD CONSTRAINT "MembershipCharge_type_xor_category"
  CHECK (
    num_nonnulls("membershipTypeId", "subscriptionCategoryId") = 1
    AND num_nonnulls("membershipTypeId", "membershipTypeKey", "membershipTypeName") IN (0, 3)
    AND num_nonnulls("subscriptionCategoryId", "subscriptionCategoryKey", "subscriptionCategoryName", "subscriptionCategoryFeeId") IN (0, 4)
  );

COMMIT;
