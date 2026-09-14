-- Reverse 20260922010000_booking_owner_optional_member (#3369, stage 4 of
-- programme #2912).
--
-- THIS SCRIPT RUNS SECOND. The window applied 20260922010000 then
-- 20260922020000, so the reverse runs 20260922020000/rollback.sql FIRST (it
-- gives every organisation-owned booking its member back) and this one after.
-- Run in the other order and the SET NOT NULL statements below will refuse,
-- loudly and without changing anything, which is the failure mode you want.
--
-- Use this script only while traffic remains removed and every old and new web
-- process, worker, scheduler, queue consumer and database connection is
-- stopped, exactly as the forward migration required. After it commits, restore
-- the pre-epic runtime only once every other windowed migration applied in the
-- same maintenance window has completed its own reverse, in reverse order --
-- docs/PRODUCTION_UPGRADE_RUNBOOK.md section 4.
--
-- AFTER EPIC TRAFFIC HAS RUN, THIS IS NOT A RELEASE ROLLBACK. Once the new
-- colour has taken a booking, a payment or a refund, the two reverse scripts
-- together cannot put back what the new code wrote on top. Stop every process
-- and use the verified backup taken immediately before the migration, with
-- owner-led recovery.
--
-- WHAT IS DELIBERATELY NOT REVERSED: "SchoolMemberClassification" is kept. It
-- is the record of who decided that a given historical row was a school and on
-- what evidence, and it is the input the forward migration would need again on
-- the next attempt. Dropping it would throw away an officer's work and force
-- every by-hand classification to be made a second time. It is an empty,
-- unreferenced table to the pre-epic colour, which never selects it.

BEGIN;

-- The trigger goes back to the 20260527120000 body, without the null-booker
-- guard. Safe in this order because 20260922020000/rollback.sql has already
-- restored every "PromoRedemption"."memberId", so no NULL member can reach it.
CREATE OR REPLACE FUNCTION "sync_promo_redemption_allocation_from_redemption"()
RETURNS TRIGGER AS $function$
BEGIN
    INSERT INTO "PromoRedemptionAllocation" (
        "id",
        "promoRedemptionId",
        "promoCodeId",
        "bookingId",
        "memberId",
        "discountCents",
        "freeNightsUsed",
        "createdAt"
    )
    VALUES (
        gen_random_uuid()::text,
        NEW."id",
        NEW."promoCodeId",
        NEW."bookingId",
        NEW."memberId",
        NEW."discountCents",
        COALESCE(NEW."freeNightsUsed", 0),
        NEW."createdAt"
    )
    ON CONFLICT ("promoRedemptionId", "memberId") DO UPDATE SET
        "promoCodeId" = EXCLUDED."promoCodeId",
        "bookingId" = EXCLUDED."bookingId",
        "discountCents" = EXCLUDED."discountCents",
        "freeNightsUsed" = EXCLUDED."freeNightsUsed";

    RETURN NEW;
END;
$function$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS "PromoRedemptionAllocation_promoCode_booking_noMember_unique";

DROP INDEX IF EXISTS "PromoRedemptionAllocation_promoRedemption_noMember_unique";

-- These refuse if any row still carries a NULL member, which is exactly the
-- guard against running the two reverses in the wrong order.
ALTER TABLE "PromoRedemptionAllocation" ALTER COLUMN "memberId" SET NOT NULL;

ALTER TABLE "PromoRedemption" ALTER COLUMN "memberId" SET NOT NULL;

ALTER TABLE "Booking" ALTER COLUMN "memberId" SET NOT NULL;

COMMIT;
