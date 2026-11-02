-- Reverse 20261128020000_route_category_charges_and_enforce_axis_exclusivity.
--
-- THIS SCRIPT RUNS FIRST. The window applied 20261128010000 then
-- 20261128020000, so the reverse runs this script first (it drops the CHECK
-- and the category-axis partial unique index, giving
-- 20261128010000/rollback.sql's SET NOT NULL statements a chance to
-- succeed) and that one second.
--
-- Use this script only while every old and new app process, worker,
-- scheduler and queue consumer is stopped, exactly as the forward migration
-- required.
--
-- AFTER TRAFFIC HAS RUN AGAINST THIS SHAPE, THIS IS NOT A RELEASE ROLLBACK.
-- If a category charge has actually been confirmed, dropping this CHECK
-- does not undo the charge — it only makes the column shape loose again.
-- Recovering from a confirmed category charge needs owner-led data
-- decisions, not this script, and the next statement in
-- 20261128010000/rollback.sql will refuse until every such row's
-- membershipTypeId/Key/Name is resolved by hand.
--
-- Maintainer review: that "next statement" guard lived only in the OTHER
-- script, one transaction later. Run as two separate transactions, THIS
-- script's own DROPs always committed regardless of what the next one
-- found — so a confirmed category charge left the CHECK and the category
-- partial-unique index gone (this script succeeded) while
-- 20261128010000/rollback.sql's SET NOT NULL then failed and rolled back
-- ONLY ITSELF, leaving a restarted app free to insert a second live
-- category charge for the same family/year with nothing to stop it. The
-- guard below makes the two scripts fail together, before either commits
-- anything, by checking the SAME fact the other script's SET NOT NULL
-- would refuse on.

BEGIN;

DO $confirmed_category_charge$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "MembershipSubscriptionCharge"
        WHERE "membershipTypeId" IS NULL OR "subscriptionCategoryId" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'subscription_category_charge_confirmed'
            USING HINT = 'At least one MembershipSubscriptionCharge row is category-shaped (or missing its membershipTypeId). Dropping this CHECK and the category unique index would leave that confirmed data with no exclusivity protection. This is not a release rollback once traffic has run against this shape — recover from the verified backup instead, with owner-led data decisions.';
    END IF;
END;
$confirmed_category_charge$;

ALTER TABLE "MembershipSubscriptionCharge" DROP CONSTRAINT IF EXISTS "MembershipCharge_type_xor_category";

DROP INDEX IF EXISTS "MembershipCharge_family_category_year_live_key";

COMMIT;
