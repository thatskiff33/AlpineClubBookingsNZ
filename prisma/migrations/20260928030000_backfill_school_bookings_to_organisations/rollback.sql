-- Reverse 20260928030000_backfill_school_bookings_to_organisations (#3369,
-- stage 4 of programme #2912).
--
-- THIS SCRIPT RUNS FIRST. The window applied 20260928020000 then
-- 20260928030000, so the reverse runs this one and then
-- 20260928020000/rollback.sql -- reverse order, as
-- docs/PRODUCTION_UPGRADE_RUNBOOK.md section 4 requires. This script gives
-- every organisation-owned booking its member back, which is the precondition
-- for the SET NOT NULL statements in the other one. Running them the other way
-- round is refused STRUCTURALLY by that script rather than by luck -- see its
-- own header.
--
-- Use it only while traffic remains removed and every old and new web process,
-- worker, scheduler, queue consumer and database connection is stopped.
--
-- WHAT MAKES THIS REVERSIBLE, AND EXACTLY WHERE IT STOPS BEING SO
--
-- The forward migration deliberately collapses MANY member rows onto ONE
-- organisation: that is the whole reason it folds the school's name. So
-- "which member owned this booking" is the one fact its UPDATE destroys, and an
-- earlier draft of this script reconstructed it by picking one member per
-- organisation -- which handed every booking of a twice-recorded school back to
-- whichever of its rows had the lowest id, and did the same with the school's
-- Xero customer. That is a silent misattribution the application cannot detect,
-- so this script does not do it. Instead:
--
--   * A BOOKING is given back to the member named alongside it by the SCHOOL
--     booking request that converted it. The forward migration does not touch
--     `convertedBookingId` or `convertedMemberId`, so that pair is untouched
--     evidence of the original ownership, recorded by the approval code in the
--     same transaction that created the member. This is a reconstruction, not a
--     guess.
--   * Where an organisation resolves from exactly ONE classified member there
--     is nothing to be ambiguous about, so a booking with no converted request
--     -- an officer-entered school booking, say -- goes back to that one member.
--   * Anything else REFUSES and sends the operator to the backup. There is no
--     tie-break, for the same reason the census has no tie-break.
--
-- THE XERO HALF IS HELD TO A HIGHER BAR, because a provider identity handed to
-- the wrong party survives the rollback and nothing on any screen shows it. A
-- moved customer is returned only where the post-state can PROVE where it came
-- from: the organisation was minted by this backfill (so its contact cannot
-- have come from anywhere else) and exactly one of its classified members now
-- holds none (so that member is the only possible source). Otherwise the script
-- refuses. That is deliberately stricter than it needs to be for the common
-- case -- an organisation an officer created through the application may hold a
-- customer the backfill never touched, and the post-state cannot tell the two
-- apart -- and the honest answer to "cannot tell" here is the backup.
--
-- THE LIMIT, STATED PLAINLY. Once epic traffic has run -- a booking taken, a
-- payment captured, a refund issued, a school edited -- this script is NOT a
-- release rollback. A booking CREATED by the new colour against an organisation
-- has no member to give back and this script will refuse rather than invent
-- one. At that point stop every process and recover from the verified backup
-- taken immediately before the migration, with the owner leading.
--
-- ROLLING FORWARD AFTER BOTH REVERSES. `_prisma_migrations` still records both
-- migrations as APPLIED, and nothing in the deploy path notices that the
-- database no longer matches them: `prisma migrate deploy` answers "No pending
-- migrations to apply" and `prisma migrate diff` reports no drift, because the
-- reverses restore the shape as well as the data. To roll forward, RE-APPLY
-- both `migration.sql` files by hand, in order, as the migration role -- they
-- are written to be re-runnable, which is why 20260928020000 section 4 guards
-- its type and table creation. Deleting the two `_prisma_migrations` rows and
-- migrating again is equivalent and edits migration history for no gain.
-- docs/PRODUCTION_UPGRADE_RUNBOOK.md section 4 carries the same sequence.

BEGIN;

-- The constraint has to go first: the statements below put a member back on a
-- booking that still names an organisation, which "exactly one" forbids.
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_owner_exactly_one";

-- ---------------------------------------------------------------------------
-- 1. Every member the forward migration COULD have re-parented onto each
--    organisation. Many rows per organisation, which is the point.
-- ---------------------------------------------------------------------------
-- The fold is the one in src/lib/school-organisations.ts -- collapse, trim,
-- cap, trim -- and school-member-classification-contract.test.ts fails if this
-- copy has drifted from it. `organisation_is_minted` records whether this
-- backfill created the record, by the same derived-id test the DELETE at the
-- bottom uses.
CREATE TEMP TABLE "school_rollback_member" ON COMMIT DROP AS
SELECT
    o."id" AS organisation_id,
    m."id" AS member_id,
    m."xeroContactId" AS member_xero_contact_id,
    o."xeroContactId" AS organisation_xero_contact_id,
    (o."id" = 'org' || substr(md5('school-organisation:' || lower(btrim(left(btrim(regexp_replace(o."name", '\s+', ' ', 'g')), 200)))), 1, 22)) AS organisation_is_minted
FROM "Organisation" o
JOIN "SchoolMemberClassification" c ON c."classification" = 'ORGANISATION'
JOIN "Member" m ON m."id" = c."memberId"
WHERE o."kind" = 'SCHOOL'
  AND lower(btrim(left(btrim(regexp_replace(o."name", '\s+', ' ', 'g')), 200)))
      = lower(btrim(left(btrim(regexp_replace(m."firstName", '\s+', ' ', 'g')), 200)));

-- An organisation only one classified member resolves to. For those there is no
-- ambiguity to resolve and no evidence to need.
CREATE TEMP TABLE "school_rollback_sole_member" ON COMMIT DROP AS
SELECT organisation_id, min(member_id) AS member_id
FROM "school_rollback_member"
GROUP BY organisation_id
HAVING count(*) = 1;

-- ---------------------------------------------------------------------------
-- 2. WHO OWNED EACH BOOKING -- per booking, from untouched evidence.
-- ---------------------------------------------------------------------------
-- First the converted SCHOOL request that names this booking and a classified
-- member of this organisation as one pair; then, only where the organisation
-- has a single classified member, that member. `member_id` NULL means neither
-- held, which the refusal below turns into a stop.
CREATE TEMP TABLE "school_rollback_booking" ON COMMIT DROP AS
SELECT
    b."id" AS booking_id,
    b."organisationId" AS organisation_id,
    COALESCE(
        (
            SELECT r."convertedMemberId"
              FROM "BookingRequest" r
              JOIN "school_rollback_member" sm
                ON sm.member_id = r."convertedMemberId"
               AND sm.organisation_id = b."organisationId"
             WHERE r."type" = 'SCHOOL'
               AND r."convertedBookingId" = b."id"
             ORDER BY r."convertedMemberId"
             LIMIT 1
        ),
        (
            SELECT s.member_id
              FROM "school_rollback_sole_member" s
             WHERE s.organisation_id = b."organisationId"
        )
    ) AS member_id
FROM "Booking" b
WHERE b."memberId" IS NULL;

-- REFUSE rather than invent. A booking with no member and no reconstructable
-- owner is either one the new colour created, or one of a twice-recorded
-- school's whose converted request has since been deleted. Putting a stranger's
-- member on it would be worse than stopping.
DO $unreconstructable$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "school_rollback_booking" WHERE member_id IS NULL
    ) THEN
        RAISE EXCEPTION 'school_backfill_rollback_unreconstructable'
            USING HINT = 'At least one organisation-owned booking has no member to restore: either the new release has already written, or two member rows spell one school and the booking request that would say which owned this booking is gone. Recover from the verified pre-migration backup instead.';
    END IF;
END;
$unreconstructable$;

-- ---------------------------------------------------------------------------
-- 3. THE XERO CUSTOMER -- returned only where the post-state proves its source.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "school_rollback_xero" ON COMMIT DROP AS
SELECT
    sm.organisation_id,
    sm.organisation_xero_contact_id,
    bool_or(sm.organisation_is_minted) AS organisation_is_minted,
    count(*) FILTER (WHERE sm.member_xero_contact_id IS NULL) AS source_candidates,
    min(sm.member_id) FILTER (WHERE sm.member_xero_contact_id IS NULL) AS source_member_id
FROM "school_rollback_member" sm
WHERE sm.organisation_xero_contact_id IS NOT NULL
GROUP BY sm.organisation_id, sm.organisation_xero_contact_id;

-- Every classified member still holding its own contact kept it: the forward
-- migration moved at most one per organisation and cleared only that one. So a
-- moved customer came from one of the members that now hold none, and the
-- reconstruction is certain only when there is exactly one of those AND the
-- organisation is one this backfill minted -- a record an officer created
-- through the application may hold a customer that was never the backfill's to
-- move, and nothing in the post-state distinguishes the two.
DO $xero_unreconstructable$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "school_rollback_xero"
        WHERE source_candidates > 1
           OR (source_candidates = 1 AND NOT organisation_is_minted)
    ) THEN
        RAISE EXCEPTION 'school_backfill_rollback_xero_unreconstructable'
            USING HINT = 'A school record holds a Xero customer whose original owner cannot be proved from what is left: either two member rows spell that school and both could have supplied it, or the record was not created by this backfill. Returning it to the wrong party would misattribute a provider identity in a way nothing on any screen shows. Recover from the verified pre-migration backup instead.';
    END IF;
END;
$xero_unreconstructable$;

-- The Xero customer goes back to the member it came from, and only where the
-- member has not since been given another one.
UPDATE "Member" m
SET "xeroContactId" = x.organisation_xero_contact_id
FROM "school_rollback_xero" x
WHERE m."id" = x.source_member_id
  AND x.source_candidates = 1
  AND x.organisation_is_minted
  AND m."xeroContactId" IS NULL;

UPDATE "Organisation" o
SET "xeroContactId" = NULL,
    "updatedAt" = timezone('UTC', statement_timestamp())
FROM "school_rollback_xero" x
WHERE o."id" = x.organisation_id
  AND x.source_candidates = 1
  AND x.organisation_is_minted
  AND EXISTS (
      SELECT 1 FROM "Member" m
      WHERE m."id" = x.source_member_id AND m."xeroContactId" = o."xeroContactId"
  );

-- ---------------------------------------------------------------------------
-- 4. The bookings, and the money-adjacent rows that follow them.
-- ---------------------------------------------------------------------------
-- The promo rows get their booker back before the bookings do, so no statement
-- ever sees a member-owned booking with an ownerless redemption. Both are keyed
-- on the per-booking owner from section 2, not on a per-organisation one.
UPDATE "PromoRedemptionAllocation" pra
SET "memberId" = rb.member_id
FROM "school_rollback_booking" rb
WHERE pra."bookingId" = rb.booking_id
  AND pra."memberId" IS NULL;

UPDATE "PromoRedemption" pr
SET "memberId" = rb.member_id
FROM "school_rollback_booking" rb
WHERE pr."bookingId" = rb.booking_id
  AND pr."memberId" IS NULL;

UPDATE "Booking" b
SET "memberId" = rb.member_id,
    "organisationId" = NULL
FROM "school_rollback_booking" rb
WHERE b."id" = rb.booking_id;

-- The request links the forward migration added are removed for EVERY member it
-- could have added them for, so a re-run of the forward migration re-derives
-- them rather than finding them half-present -- and so the organisation delete
-- below is not blocked by a link this script left behind.
UPDATE "BookingRequest" req
SET "organisationId" = NULL
FROM "school_rollback_member" sm
WHERE req."organisationId" = sm.organisation_id
  AND req."convertedMemberId" = sm.member_id;

-- The Organisation rows the forward migration MINTED are removed; one an
-- officer created through the application is not, because its id is a cuid
-- rather than the derived 'org' + md5 prefix this backfill produces. Only rows
-- nothing references can go, which the Restrict foreign keys would enforce
-- anyway.
DELETE FROM "Organisation" o
WHERE o."kind" = 'SCHOOL'
  AND o."id" = 'org' || substr(md5('school-organisation:' || lower(btrim(left(btrim(regexp_replace(o."name", '\s+', ' ', 'g')), 200)))), 1, 22)
  AND NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."organisationId" = o."id")
  AND NOT EXISTS (SELECT 1 FROM "BookingRequest" r WHERE r."organisationId" = o."id")
  AND NOT EXISTS (SELECT 1 FROM "OrganisationContact" oc WHERE oc."organisationId" = o."id");

-- "SchoolMemberClassification" is deliberately kept -- see
-- 20260928020000/rollback.sql. It is an officer's work, and the next attempt
-- needs it. That is also why 20260928020000 section 4 has to be re-runnable.

COMMIT;
