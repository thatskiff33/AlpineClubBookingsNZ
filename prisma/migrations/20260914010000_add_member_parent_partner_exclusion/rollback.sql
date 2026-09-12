-- Reverse 20260914010000_add_member_parent_partner_exclusion (#3271/#3292).
--
-- This migration is windowed. Use this script only while traffic remains
-- removed and every old/new web process, worker, scheduler and database
-- connection is stopped. It removes only derived state and trigger machinery;
-- it never changes Member or MemberPartnerLink source relationships. After it
-- commits, restore the pre-epic runtime only after every other windowed
-- migration applied in the same maintenance window has completed its reverse
-- sequence from PRODUCTION_UPGRADE_RUNBOOK.md section 2.4. If source
-- relationships changed after cutover, use the verified backup and owner-led
-- recovery instead of assuming this schema-only reverse is a release rollback.

BEGIN;

LOCK TABLE "Member", "MemberPartnerLink" IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS "Member_parent_partner_exclusion_insert" ON "Member";
DROP TRIGGER IF EXISTS "Member_parent_partner_exclusion_update" ON "Member";
DROP TRIGGER IF EXISTS "Member_parent_partner_exclusion_delete" ON "Member";
DROP TRIGGER IF EXISTS "MemberPartnerLink_parent_partner_exclusion_insert" ON "MemberPartnerLink";
DROP TRIGGER IF EXISTS "MemberPartnerLink_parent_partner_exclusion_update" ON "MemberPartnerLink";
DROP TRIGGER IF EXISTS "MemberPartnerLink_parent_partner_exclusion_delete" ON "MemberPartnerLink";
DROP TRIGGER IF EXISTS "MemberParentPartnerExclusion_cleanup_zero_pair" ON "MemberParentPartnerExclusion";

DROP FUNCTION IF EXISTS member_parent_partner_cleanup_zero_pair();
DROP FUNCTION IF EXISTS member_parent_partner_partner_edges_changed();
DROP FUNCTION IF EXISTS member_parent_partner_member_edges_changed();
DROP FUNCTION IF EXISTS member_parent_partner_apply_delta(TEXT, TEXT, INTEGER, INTEGER);

DROP TABLE "MemberParentPartnerExclusion";

COMMIT;
