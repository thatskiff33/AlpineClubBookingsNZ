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

BEGIN;

ALTER TABLE "MembershipSubscriptionCharge" DROP CONSTRAINT IF EXISTS "MembershipCharge_type_xor_category";

DROP INDEX IF EXISTS "MembershipCharge_family_category_year_live_key";

COMMIT;
