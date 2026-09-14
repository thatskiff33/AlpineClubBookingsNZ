BEGIN;

-- #3369 (stage 4 of programme #2912, child of MAD epic #2725): every school
-- booking stops being owned by an invented person and starts being owned by its
-- Organisation.
--
-- WINDOWED, and the second half of the pair opened by 20260922010000. THIS is
-- the migration the pre-epic release cannot survive: after it, bookings exist
-- whose "memberId" is NULL, and that release reads the column as required.
-- Required deploy acknowledgements: ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1, a
-- non-empty BLUE_GREEN_MIGRATION_OVERRIDE_REASON naming #3369's maintenance
-- window, and BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1. A fresh, verified
-- backup taken immediately before is a precondition, not a precaution.
--
-- IT DERIVES NOTHING. Which historical school-shaped member row is a school and
-- which is a teacher is read from "SchoolMemberClassification", which the
-- read-only census tool and the club's own officers fill in BEFORE the window
-- opens. This migration's first act is to refuse, in full, if any row that owns
-- a booking is missing from it. That is the #2912 rule in executable form: no
-- fuzzy merge, no invented surname, no silent ambiguous fallback, and cutover
-- blocked rather than guessed.
--
-- Everything below runs inside the one transaction this file opens, so a
-- refusal at any point leaves the database exactly as it was.
--
-- Operator sequence: docs/guides/school-organisation-cutover.md.
-- Rollback: rollback.sql beside this file, run BEFORE 20260922010000's.

-- ---------------------------------------------------------------------------
-- 1. FAIL CLOSED. Nothing below runs while any candidate is unclassified.
-- ---------------------------------------------------------------------------
-- The candidate predicate is the one in
-- src/lib/school-member-classification.ts, and
-- src/lib/__tests__/school-member-classification-contract.test.ts fails if the
-- two have drifted. They have to agree or the census would report "nothing left
-- to decide" about a row this migration then demands an answer for.
--
-- The message names no member, no school and no count. It is raised in a
-- maintenance window to an operator who is about to run the census again, and
-- the census is what prints the list.
DO $fail_closed$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Member" m
        WHERE m."role" = 'SCHOOL' AND EXISTS (SELECT 1 FROM "Booking" b WHERE b."memberId" = m."id")
          AND NOT EXISTS (
              SELECT 1 FROM "SchoolMemberClassification" c WHERE c."memberId" = m."id"
          )
    ) THEN
        RAISE EXCEPTION 'school_member_classification_incomplete'
            USING HINT = 'Run npm run db:school-classification-census and record a decision for every row it lists as CANNOT TELL, then run the migration again.';
    END IF;
END;
$fail_closed$;

-- ---------------------------------------------------------------------------
-- 2. The rows being re-parented, and the school name each one carries.
-- ---------------------------------------------------------------------------
-- Only ORGANISATION-classified rows. A PERSON-classified one is a real teacher
-- who happens to have booked, and nothing about their booking changes.
--
-- The school's name is the name the old writer stored in "firstName", folded
-- exactly the way resolveOrCreateSchoolOrganisation() folds it: COLLAPSE every
-- run of whitespace to one space, THEN trim, then cap at the 200 characters
-- "Organisation"."name" holds, then trim again. Comparisons add lower().
--
-- THE ORDER IS NOT A STYLE CHOICE. PostgreSQL's one-argument btrim() strips
-- only the space character while '\s' also matches a tab, so trimming first
-- leaves a leading tab in place for the collapse to turn into a leading SPACE
-- that nothing then removes -- and the record minted under that name does not
-- resolve back, which raises section 3's exception in the middle of the
-- window. The second trim is what makes the fold idempotent, so the folded name
-- stored in "Organisation"."name" folds to itself when section 3 looks it up.
-- src/lib/school-organisations.ts is the one home for all of it and
-- school-member-classification-contract.test.ts fails if this copy drifts.
--
-- No other transformation: a name is evidence, and tidying it is editing
-- evidence.
CREATE TEMP TABLE "school_backfill_map" ON COMMIT DROP AS
SELECT
    m."id" AS member_id,
    btrim(left(btrim(regexp_replace(m."firstName", '\s+', ' ', 'g')), 200)) AS school_name,
    lower(btrim(left(btrim(regexp_replace(m."firstName", '\s+', ' ', 'g')), 200))) AS folded_name,
    NULLIF(btrim(m."email"), '') AS school_email,
    m."xeroContactId" AS member_xero_contact_id
FROM "Member" m
JOIN "SchoolMemberClassification" c ON c."memberId" = m."id"
WHERE c."classification" = 'ORGANISATION'
  AND m."role" = 'SCHOOL' AND EXISTS (SELECT 1 FROM "Booking" b WHERE b."memberId" = m."id");

-- ---------------------------------------------------------------------------
-- 3. An Organisation for every school that does not have one yet.
-- ---------------------------------------------------------------------------
-- The id is DERIVED from the folded school name rather than random, so a
-- rehearsal against a copy of the club's database produces the same ids as the
-- real run, and a verification fixture can name one. DISTINCT ON collapses two
-- member rows that spell one school the same way onto one record, which is the
-- whole reason the name is folded.
--
-- "email" comes from the invented member's own address, which is the address
-- the club has been sending that school's invoices to. Carrying it over is why
-- no school loses its delivery address in the move; a school whose row had none
-- gets NULL, and NULL is the honest answer rather than a fabricated one.
INSERT INTO "Organisation" ("id", "kind", "name", "email", "createdAt", "updatedAt")
SELECT DISTINCT ON (map.folded_name)
    'org' || substr(md5('school-organisation:' || map.folded_name), 1, 22),
    'SCHOOL'::"OrganisationKind",
    map.school_name,
    map.school_email,
    timezone('UTC', statement_timestamp()),
    timezone('UTC', statement_timestamp())
FROM "school_backfill_map" map
WHERE NOT EXISTS (
    SELECT 1 FROM "Organisation" o
    WHERE o."kind" = 'SCHOOL'
      AND lower(btrim(left(btrim(regexp_replace(o."name", '\s+', ' ', 'g')), 200))) = map.folded_name
)
ORDER BY map.folded_name, map.member_id;

-- Which record each re-parented member resolves to. The ordering is the one
-- resolveOrCreateSchoolOrganisation() uses — a live record before an archived
-- one, then the oldest — so the migration and the runtime pick the same record
-- when a club has archived a school and created it again.
CREATE TEMP TABLE "school_backfill_org" ON COMMIT DROP AS
SELECT DISTINCT ON (map.member_id)
    map.member_id,
    map.member_xero_contact_id,
    o."id" AS organisation_id
FROM "school_backfill_map" map
JOIN "Organisation" o
  ON o."kind" = 'SCHOOL'
 AND lower(btrim(left(btrim(regexp_replace(o."name", '\s+', ' ', 'g')), 200))) = map.folded_name
ORDER BY map.member_id, o."archivedAt" ASC NULLS FIRST, o."createdAt" ASC, o."id" ASC;

-- Fail closed a second time. A classified row that resolves to no organisation
-- would otherwise be silently skipped by every statement below, leaving a
-- school booking owned by an invented person after a migration that reported
-- success.
--
-- THERE WAS A PATH THAT PRODUCED IT, and the comment here used to say there was
-- not. A school whose stored name began with a tab folded to a name beginning
-- with a SPACE, minted a record under it, and then failed to match that record
-- back; see section 2 on the order of the fold. That is fixed, and this refusal
-- now carries a HINT, because it is the one refusal in this migration an
-- operator has no tool to decode: the census reports classification, not name
-- resolution, and the message deliberately names no school.
DO $unresolved$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "school_backfill_map" map
        WHERE NOT EXISTS (
            SELECT 1 FROM "school_backfill_org" o WHERE o.member_id = map.member_id
        )
    ) THEN
        RAISE EXCEPTION 'school_backfill_organisation_unresolved'
            USING HINT = 'A classified school row resolved to no Organisation record, which means its folded name does not match the record minted from it. Nothing has been written. See docs/guides/school-organisation-cutover.md, "Troubleshooting", which carries the query that lists the rows involved; do not re-run until it is understood.';
    END IF;
END;
$unresolved$;

-- ---------------------------------------------------------------------------
-- 4. The bookings change hands.
-- ---------------------------------------------------------------------------
-- One statement, so no row is ever visible owned by both or by neither: the
-- CHECK constraint added at the end is satisfied at the end of this statement
-- and at every point a reader could see.
UPDATE "Booking" b
SET "organisationId" = o.organisation_id,
    "memberId" = NULL
FROM "school_backfill_org" o
WHERE b."memberId" = o.member_id;

-- The school's own requests point at the record too, proved by the same
-- evidence that classified the member: the request named this member as the one
-- it converted to. Without this the organisation's history starts at the
-- booking and the request it came from is orphaned.
UPDATE "BookingRequest" r
SET "organisationId" = o.organisation_id
FROM "school_backfill_org" o
WHERE r."convertedMemberId" = o.member_id
  AND r."type" = 'SCHOOL'
  AND r."organisationId" IS NULL;

-- ---------------------------------------------------------------------------
-- 5. The two dependent money-adjacent rows follow their booking.
-- ---------------------------------------------------------------------------
-- Keyed on the member rather than on the booking, so nothing belonging to any
-- other member can be touched even by accident.
--
-- NO AMOUNT CHANGES. "discountCents", "priceAdjustmentCents" and
-- "freeNightsUsed" are untouched here and in every statement of this migration:
-- what a school was charged is what a school was charged, and repairing money
-- rows is explicitly out of this issue's scope.
--
-- This UPDATE fires PromoRedemption_sync_allocation_update, which 20260922010000
-- taught to return early on a NULL booker. Running that migration first is what
-- stops this statement from minting a spurious all-null allocation row.
UPDATE "PromoRedemption" pr
SET "memberId" = NULL
FROM "school_backfill_org" o
WHERE pr."memberId" = o.member_id;

-- At most one allocation row per redemption can carry a given member, because
-- of the pre-existing unique index on (promoRedemptionId, memberId) -- so this
-- cannot produce two NULL-member rows in one scope and cannot violate the
-- partial unique indexes 20260922010000 added.
UPDATE "PromoRedemptionAllocation" pra
SET "memberId" = NULL
FROM "school_backfill_org" o
WHERE pra."memberId" = o.member_id;

-- ---------------------------------------------------------------------------
-- 6. The school's Xero customer moves to the school.
-- ---------------------------------------------------------------------------
-- Only where the census PROVED the contact is the school's, which is exactly
-- what an ORGANISATION classification says: that contact was created from this
-- row's own name, and this row is the school.
--
-- A PERSON'S CONTACT IS NEVER TAKEN. Only rows in the map are read, and every
-- row in the map is classified ORGANISATION.
--
-- Where two member rows spell one school and both hold a contact, only the
-- first is moved; the second keeps its own link and the club ends with two
-- provider contacts for one school, which an officer merges in Xero. That is a
-- visible duplicate rather than a silent overwrite, and a silent overwrite is
-- the one outcome that cannot be undone.
UPDATE "Organisation" org
SET "xeroContactId" = pick.member_xero_contact_id,
    "updatedAt" = timezone('UTC', statement_timestamp())
FROM (
    SELECT DISTINCT ON (o.organisation_id)
        o.organisation_id,
        o.member_xero_contact_id
    FROM "school_backfill_org" o
    WHERE o.member_xero_contact_id IS NOT NULL
    ORDER BY o.organisation_id, o.member_id
) pick
WHERE org."id" = pick.organisation_id
  AND org."xeroContactId" IS NULL;

-- The invented member lets go of the link it is no longer the owner of, and
-- ONLY of a link the organisation now actually holds. A row whose contact was
-- not moved keeps it, so nothing is dropped on the floor.
UPDATE "Member" m
SET "xeroContactId" = NULL
FROM "school_backfill_org" o
JOIN "Organisation" org ON org."id" = o.organisation_id
WHERE m."id" = o.member_id
  AND m."xeroContactId" IS NOT NULL
  AND org."xeroContactId" = m."xeroContactId";

-- The emptied member row itself is deliberately left alone: not deleted, not
-- archived, not deactivated. It still carries audit history and it is a
-- Role.SCHOOL row, which the enum already documents as a non-member category
-- carrying no access. What it no longer carries is authority -- it owns no
-- booking and holds no provider contact. Retiring those rows is a separate
-- decision about a club's own records and is not made by a migration.

-- ---------------------------------------------------------------------------
-- 7. Exactly one owner, from now on, enforced by the database.
-- ---------------------------------------------------------------------------
-- Added last, because until section 4 ran there were rows with a member and
-- (in an installation that has already run the epic's earlier stages) an
-- organisation too. From here the model is unrepresentable rather than policed:
-- bookingOwner() in src/lib/booking-owner.ts can promise its several hundred
-- readers a non-null owner without any of them branching, and no writer can
-- produce a booking that nobody owns.
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_owner_exactly_one"
    CHECK (num_nonnulls("memberId", "organisationId") = 1);

COMMIT;
