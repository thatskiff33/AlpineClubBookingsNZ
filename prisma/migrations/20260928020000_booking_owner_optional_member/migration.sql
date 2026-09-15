BEGIN;

-- #3369 (stage 4 of programme #2912, child of MAD epic #2725): the booking's
-- member link becomes OPTIONAL, so a school's booking can be owned by its
-- Organisation instead of by an invented surnameless person.
--
-- WINDOWED, and the pair 20260928020000 + 20260928030000 is ONE window. This
-- half changes only the SHAPE and leaves every stored value exactly as it is;
-- the backfill that actually empties a member link is 20260928030000. They are
-- never applied apart, because between them the database would allow a booking
-- with no owner at all: the CHECK constraint that makes "exactly one owner"
-- true is added by the second half, once the data satisfies it.
--
-- Required deploy acknowledgements: ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1, a
-- non-empty BLUE_GREEN_MIGRATION_OVERRIDE_REASON naming #3369's maintenance
-- window, and BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1. Take and verify a fresh
-- backup immediately before running. docs/PRODUCTION_UPGRADE_RUNBOOK.md section
-- 2.4.2 is the sequence; DEPLOYMENT.md carries the short form.

-- ---------------------------------------------------------------------------
-- 1. The owner column, and the two dependent columns that follow it.
-- ---------------------------------------------------------------------------
-- DROP NOT NULL only. No stored value changes, no row is rewritten, and no
-- index or foreign key is touched: on PostgreSQL this is a catalog update
-- taking a brief ACCESS EXCLUSIVE lock on each table, with no scan and no
-- rewrite.
--
-- The pre-epic release keeps working against this shape on its own. It writes a
-- member on every booking it creates, which a nullable column accepts, and it
-- reads one on every booking that exists, because nothing here empties one.
-- What it cannot survive is the NEXT migration.
ALTER TABLE "Booking" ALTER COLUMN "memberId" DROP NOT NULL;

-- Whose promo entitlement was spent. An organisation holds none, so an
-- organisation-owned booking's redemption names no member. Per-member promo
-- limits count the rows that DO name one, which is the same set of rows they
-- counted before.
ALTER TABLE "PromoRedemption" ALTER COLUMN "memberId" DROP NOT NULL;

-- The same, per beneficiary. This is the column the #2912 census singled out,
-- because it sits inside two unique indexes -- see section 2.
ALTER TABLE "PromoRedemptionAllocation" ALTER COLUMN "memberId" DROP NOT NULL;

-- NOT CHANGED, and that is a decision rather than an omission:
-- "BookingModification"."memberId" and "RefundRequest"."memberId" are the two
-- the #2912 census named that turn out to be the ACTOR, not the owner. Every
-- writer of either passes a signed-in person, so neither is ever null, and
-- widening them would drop a guarantee for nothing.

-- ---------------------------------------------------------------------------
-- 2. Uniqueness, restored for the rows that now carry a NULL member.
-- ---------------------------------------------------------------------------
-- "PromoRedemptionAllocation" has two unique indexes that both name "memberId":
-- (promoRedemptionId, memberId) and (promoCodeId, bookingId, memberId). In
-- PostgreSQL two NULLs are DISTINCT, so a NULL member collapses both scopes for
-- exactly the rows that carry one -- a booking could accumulate any number of
-- "no member" allocation rows against one redemption.
--
-- These two partial indexes are the missing half. Together with the two
-- existing unique indexes they are exactly NULLS NOT DISTINCT, expressed in a
-- way that leaves the original constraints in Prisma's schema: member merge
-- classifies this model resolve off those very DMMF uniques, and re-cutting
-- them as raw NULLS NOT DISTINCT indexes would take them out of it.
--
-- Registered in prisma/partial-unique-indexes.tsv, which is set-equality
-- checked against pg_indexes by the migration-drift job.
CREATE UNIQUE INDEX IF NOT EXISTS "PromoRedemptionAllocation_promoRedemption_noMember_unique"
    ON "PromoRedemptionAllocation" ("promoRedemptionId")
    WHERE "memberId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "PromoRedemptionAllocation_promoCode_booking_noMember_unique"
    ON "PromoRedemptionAllocation" ("promoCodeId", "bookingId")
    WHERE "memberId" IS NULL;

-- ---------------------------------------------------------------------------
-- 3. The allocation sync trigger learns that a booker can be absent.
-- ---------------------------------------------------------------------------
-- 20260527120000 installed this trigger so an old blue/green colour that writes
-- only "PromoRedemption" still gets the one booker allocation it semantically
-- meant. It upserts with ON CONFLICT ("promoRedemptionId", "memberId").
--
-- A NULL member breaks that upsert in a way that is silent and cumulative: ON
-- CONFLICT infers a unique index on exactly those two columns with no
-- predicate, so it can never match a NULL row, and every UPDATE OF "memberId"
-- would INSERT another all-null allocation instead of refreshing one. The
-- backfill's own UPDATE would have been the first caller to do it.
--
-- The fix is the honest one rather than a wider index: there is no booker
-- allocation to synthesise for a booking with no booker, so the trigger returns
-- early. The old colour cannot reach this branch at all -- its generated client
-- requires a member -- so nothing it does changes.
CREATE OR REPLACE FUNCTION "sync_promo_redemption_allocation_from_redemption"()
RETURNS TRIGGER AS $function$
BEGIN
    IF NEW."memberId" IS NULL THEN
        RETURN NEW;
    END IF;

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

-- ---------------------------------------------------------------------------
-- 4. Where the classification of a historical school row is recorded.
-- ---------------------------------------------------------------------------
-- The backfill does not work out which of the old school-shaped member rows is
-- a school and which is a teacher. It READS the answer from here and refuses to
-- write anything at all while any candidate is missing -- see 20260928030000
-- and docs/guides/school-organisation-cutover.md.
--
-- Rows come from two places and "decidedBy" says which: census for a row the
-- read-only census tool could PROVE from writer-authored evidence, and an
-- officer's own name for a row a person decided by hand. There is no bulk
-- classify and no default.
--
-- Created empty and inert. The pre-epic colour never selects the table.
--
-- RE-RUNNABLE, and that is load-bearing rather than tidy. Both reverse scripts
-- deliberately KEEP this table and its enum, because they are an officer's
-- recorded decisions and the next attempt needs them -- so both documented
-- roll-forward paths (re-applying migration.sql by hand, and deleting the
-- `_prisma_migrations` rows then migrating again) re-execute this section
-- against a database that already has them. A bare CREATE would fail with
-- "already exists", and the attempt those decisions were preserved FOR could
-- not start. Everything above is already re-runnable: DROP NOT NULL on a
-- nullable column is a no-op, and CREATE OR REPLACE FUNCTION replaces.
DO $classification_kind$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SchoolMemberClassificationKind') THEN
        CREATE TYPE "SchoolMemberClassificationKind" AS ENUM ('ORGANISATION', 'PERSON');
    END IF;
END;
$classification_kind$;

-- The foreign key is declared INLINE rather than added by a following ALTER,
-- which is what makes this section re-runnable without a second existence
-- check: ADD CONSTRAINT has no IF NOT EXISTS form, and wrapping one in a DO
-- block would have to spell "ON UPDATE CASCADE" inside it -- which the
-- data-migration coverage gate reads as a migration-time rewrite and demands a
-- fixture for. One CREATE TABLE carries both, and skipping it skips both
-- together. CASCADE because the classification is a fact ABOUT this row, so
-- when the row goes it is not about anything.
CREATE TABLE IF NOT EXISTS "SchoolMemberClassification" (
    "memberId" TEXT NOT NULL,
    "classification" "SchoolMemberClassificationKind" NOT NULL,
    "evidence" VARCHAR(500) NOT NULL,
    "decidedBy" VARCHAR(200) NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolMemberClassification_pkey" PRIMARY KEY ("memberId"),
    CONSTRAINT "SchoolMemberClassification_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SchoolMemberClassification_classification_idx" ON "SchoolMemberClassification"("classification");

COMMIT;
