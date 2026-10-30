-- Reverse 20261128010000_add_subscription_category_and_widen_charge_type_shape.
--
-- THIS SCRIPT RUNS SECOND. The window applied 20261128010000 then
-- 20261128020000, so the reverse runs
-- 20261128020000/rollback.sql FIRST (it drops the CHECK and the
-- category-axis partial unique index) and this one after. Run in the other
-- order and the guard below refuses, loudly and without changing anything.
--
-- THAT GUARD IS STRUCTURAL: "MembershipCharge_type_xor_category" is added by
-- 20261128020000 and dropped by its reverse, so while it exists that
-- reverse has not run and this script must not either — this holds
-- regardless of whether any category charge actually exists yet.
--
-- Use this script only while every old and new app process, worker,
-- scheduler and queue consumer is stopped, exactly as the forward migration
-- required. For this club's single-instance production deployment that is
-- just the one `app` container — see
-- docs/guides/subscription-category-redesign-production-reconciliation.md.
--
-- AFTER TRAFFIC HAS RUN AGAINST THIS SHAPE, THIS IS NOT A RELEASE ROLLBACK.
-- Once a category charge has actually been confirmed, this script's final
-- SET NOT NULL statements refuse (the next section explains why), and the
-- only way back is the verified backup taken immediately before the forward
-- migration, with owner-led recovery.

BEGIN;

DO $wrong_order$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'MembershipCharge_type_xor_category'
          AND conrelid = '"MembershipSubscriptionCharge"'::regclass
    ) THEN
        RAISE EXCEPTION 'subscription_category_reverse_wrong_order'
            USING HINT = 'Run prisma/migrations/20261128020000_route_category_charges_and_enforce_axis_exclusivity/rollback.sql first.';
    END IF;
END;
$wrong_order$;

ALTER TABLE "MembershipBillingException" DROP COLUMN IF EXISTS "subscriptionCategoryId";

ALTER TABLE "MembershipSubscriptionCharge" DROP COLUMN IF EXISTS "subscriptionCategoryFeeId";
ALTER TABLE "MembershipSubscriptionCharge" DROP COLUMN IF EXISTS "subscriptionCategoryName";
ALTER TABLE "MembershipSubscriptionCharge" DROP COLUMN IF EXISTS "subscriptionCategoryKey";
ALTER TABLE "MembershipSubscriptionCharge" DROP COLUMN IF EXISTS "subscriptionCategoryId";

-- These refuse if any row still carries a NULL membershipTypeId/Key/Name —
-- i.e. if a category charge was actually confirmed while this shape was
-- live. That is a second line of defence; the structural guard above is the
-- one that fires even when no such row exists.
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeName" SET NOT NULL;
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeKey" SET NOT NULL;
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeId" SET NOT NULL;

ALTER TABLE "SeasonalMembershipAssignment" DROP CONSTRAINT IF EXISTS "SeasonalMembershipAssignment_subscriptionCategoryId_fkey";
ALTER TABLE "SeasonalMembershipAssignment" DROP COLUMN IF EXISTS "subscriptionCategoryId";

DROP TABLE IF EXISTS "SubscriptionCategoryFeeComponent";
DROP TABLE IF EXISTS "SubscriptionCategoryFee";
DROP TABLE IF EXISTS "SubscriptionCategory";

COMMIT;
