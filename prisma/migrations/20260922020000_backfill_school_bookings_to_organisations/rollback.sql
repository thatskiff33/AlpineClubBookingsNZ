-- Reverse 20260922020000_backfill_school_bookings_to_organisations (#3369,
-- stage 4 of programme #2912).
--
-- THIS SCRIPT RUNS FIRST. The window applied 20260922010000 then
-- 20260922020000, so the reverse runs this one and then
-- 20260922010000/rollback.sql -- reverse order, as
-- docs/PRODUCTION_UPGRADE_RUNBOOK.md section 4 requires. This script gives
-- every organisation-owned booking its member back, which is the precondition
-- for the SET NOT NULL statements in the other one.
--
-- Use it only while traffic remains removed and every old and new web process,
-- worker, scheduler, queue consumer and database connection is stopped.
--
-- WHAT MAKES THIS REVERSIBLE AT ALL: the forward migration threw nothing away.
-- The member it removed from a booking is still recorded, by id, in
-- "SchoolMemberClassification" joined to the "Organisation" the booking now
-- points at, and the Xero contact it moved is still the same string in the same
-- shape. So this is a genuine reverse and not an approximation -- but only
-- until the new colour writes. See the limit below.
--
-- THE LIMIT, STATED PLAINLY. Once epic traffic has run -- a booking taken, a
-- payment captured, a refund issued, a school edited -- this script is NOT a
-- release rollback. A booking CREATED by the new colour against an organisation
-- has no member to give back and this script will refuse rather than invent
-- one. At that point stop every process and recover from the verified backup
-- taken immediately before the migration, with the owner leading.

BEGIN;

-- The constraint has to go first: the statements below put a member back on a
-- booking that still names an organisation, which "exactly one" forbids.
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_owner_exactly_one";

-- Who owned what, reconstructed from the evidence the forward migration left
-- behind. A member classified ORGANISATION owned exactly the bookings that now
-- point at the organisation its folded name resolves to.
CREATE TEMP TABLE "school_rollback_org" ON COMMIT DROP AS
SELECT DISTINCT ON (o."id")
    o."id" AS organisation_id,
    m."id" AS member_id,
    o."xeroContactId" AS organisation_xero_contact_id
FROM "Organisation" o
JOIN "SchoolMemberClassification" c ON c."classification" = 'ORGANISATION'
JOIN "Member" m ON m."id" = c."memberId"
WHERE o."kind" = 'SCHOOL'
  AND lower(regexp_replace(btrim(o."name"), '\s+', ' ', 'g'))
      = lower(left(regexp_replace(btrim(m."firstName"), '\s+', ' ', 'g'), 200))
ORDER BY o."id", m."id";

-- REFUSE rather than invent. A booking with no member and no reconstructable
-- owner is one the new colour created; putting a stranger's member on it would
-- be worse than stopping.
DO $unreconstructable$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "Booking" b
        WHERE b."memberId" IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM "school_rollback_org" r
              WHERE r.organisation_id = b."organisationId"
          )
    ) THEN
        RAISE EXCEPTION 'school_backfill_rollback_unreconstructable'
            USING HINT = 'At least one organisation-owned booking has no member to restore, which means the new release has already written. Recover from the verified pre-migration backup instead.';
    END IF;
END;
$unreconstructable$;

-- The Xero customer goes back to the member it came from, and only where the
-- member has not since been given another one.
UPDATE "Member" m
SET "xeroContactId" = r.organisation_xero_contact_id
FROM "school_rollback_org" r
WHERE m."id" = r.member_id
  AND r.organisation_xero_contact_id IS NOT NULL
  AND m."xeroContactId" IS NULL;

UPDATE "Organisation" o
SET "xeroContactId" = NULL,
    "updatedAt" = timezone('UTC', statement_timestamp())
FROM "school_rollback_org" r
WHERE o."id" = r.organisation_id
  AND o."xeroContactId" IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM "Member" m
      WHERE m."id" = r.member_id AND m."xeroContactId" = o."xeroContactId"
  );

-- The promo rows get their booker back before the bookings do, so no statement
-- ever sees a member-owned booking with an ownerless redemption.
UPDATE "PromoRedemptionAllocation" pra
SET "memberId" = r.member_id
FROM "Booking" b
JOIN "school_rollback_org" r ON r.organisation_id = b."organisationId"
WHERE pra."bookingId" = b."id"
  AND pra."memberId" IS NULL
  AND b."memberId" IS NULL;

UPDATE "PromoRedemption" pr
SET "memberId" = r.member_id
FROM "Booking" b
JOIN "school_rollback_org" r ON r.organisation_id = b."organisationId"
WHERE pr."bookingId" = b."id"
  AND pr."memberId" IS NULL
  AND b."memberId" IS NULL;

UPDATE "Booking" b
SET "memberId" = r.member_id,
    "organisationId" = NULL
FROM "school_rollback_org" r
WHERE b."memberId" IS NULL
  AND b."organisationId" = r.organisation_id;

-- The request links the forward migration added are removed for the same
-- organisations, so a re-run of the forward migration re-derives them rather
-- than finding them half-present.
UPDATE "BookingRequest" req
SET "organisationId" = NULL
FROM "school_rollback_org" r
WHERE req."organisationId" = r.organisation_id
  AND req."convertedMemberId" = r.member_id;

-- The Organisation rows the forward migration MINTED are removed; one an
-- officer created through the application is not, because its id is a cuid
-- rather than the derived 'org' + md5 prefix this backfill produces. Only rows
-- nothing references can go, which the Restrict foreign keys would enforce
-- anyway.
DELETE FROM "Organisation" o
WHERE o."kind" = 'SCHOOL'
  AND o."id" = 'org' || substr(md5('school-organisation:' || lower(regexp_replace(btrim(o."name"), '\s+', ' ', 'g'))), 1, 22)
  AND NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."organisationId" = o."id")
  AND NOT EXISTS (SELECT 1 FROM "BookingRequest" r WHERE r."organisationId" = o."id")
  AND NOT EXISTS (SELECT 1 FROM "OrganisationContact" oc WHERE oc."organisationId" = o."id");

-- "SchoolMemberClassification" is deliberately kept -- see
-- 20260922010000/rollback.sql. It is an officer's work, and the next attempt
-- needs it.

COMMIT;
