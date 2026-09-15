-- Reverse 20260928020000_booking_owner_optional_member (#3369, stage 4 of
-- programme #2912).
--
-- THIS SCRIPT RUNS SECOND. The window applied 20260928020000 then
-- 20260928030000, so the reverse runs 20260928030000/rollback.sql FIRST (it
-- gives every organisation-owned booking its member back) and this one after.
-- Run in the other order and the guard at the top of the transaction below
-- refuses, loudly and without changing anything.
--
-- THAT GUARD IS STRUCTURAL, AND IT HAS TO BE. It used to be the three SET NOT
-- NULL statements at the foot of this file, which only fail when a NULL member
-- actually exists -- so a club with no organisation-classified school bookings
-- legitimately has none, and running the two reverses in the wrong order there
-- exits 0 and reports success while doing half a rollback. Measured on a
-- freshly migrated database: exit 0, no refusal. What the presence of
-- "Booking_owner_exactly_one" says instead is a fact about the SHAPE rather
-- than about the data -- 20260928030000 adds that constraint and its reverse
-- drops it, so while it is there the first reverse has not run, whatever the
-- club's rows happen to be.
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
--
-- ROLLING FORWARD AFTER THIS SCRIPT, and the reason keeping that table needs
-- saying twice. `_prisma_migrations` still records BOTH migrations as APPLIED
-- and neither reverse touches it, so after a rollback `prisma migrate status`
-- answers "Database schema is up to date", `prisma migrate deploy` answers "No
-- pending migrations to apply", and `prisma migrate diff` reports no drift --
-- the reverses restore the shape as well as the data, so there is nothing for
-- the drift gate to see. All three are telling the truth about a database that
-- is nonetheless back on the pre-epic model.
--
-- To roll forward, RE-APPLY both `migration.sql` files by hand, in order
-- (20260928020000 then 20260928030000), as the migration role. Section 4 of
-- this migration is written to be re-runnable for exactly this reason: the
-- classification table and its enum survive the rollback, so a bare
-- `CREATE TYPE` / `CREATE TABLE` would fail with "already exists" and the
-- officer decisions this script preserved would be unreachable to the very
-- attempt they were preserved for. Deleting the two `_prisma_migrations` rows
-- and running `prisma migrate deploy` is equivalent; it edits migration history
-- for no gain, and it applies the same re-runnable SQL either way.

BEGIN;

-- WRONG ORDER, REFUSED STRUCTURALLY. "Booking_owner_exactly_one" is added by
-- 20260928030000 and dropped by its reverse, so while it exists that reverse
-- has not run and this script must not either. Unlike a data-dependent check
-- this holds for a club with no school bookings at all.
DO $wrong_order$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'Booking_owner_exactly_one'
          AND conrelid = '"Booking"'::regclass
    ) THEN
        RAISE EXCEPTION 'school_reverse_wrong_order'
            USING HINT = 'Run prisma/migrations/20260928030000_backfill_school_bookings_to_organisations/rollback.sql first -- it gives every organisation-owned booking its member back, which this script then makes required again. See docs/guides/school-organisation-cutover.md, "Rolling back".';
    END IF;
END;
$wrong_order$;

-- The trigger goes back to the 20260527120000 body, without the null-booker
-- guard. Safe in this order because 20260928030000/rollback.sql has already
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

-- These refuse if any row still carries a NULL member. That is a second line of
-- defence rather than the wrong-order guard -- the guard is the structural one
-- at the top, because these three only fire when such a row happens to exist.
ALTER TABLE "PromoRedemptionAllocation" ALTER COLUMN "memberId" SET NOT NULL;

ALTER TABLE "PromoRedemption" ALTER COLUMN "memberId" SET NOT NULL;

ALTER TABLE "Booking" ALTER COLUMN "memberId" SET NOT NULL;

COMMIT;
