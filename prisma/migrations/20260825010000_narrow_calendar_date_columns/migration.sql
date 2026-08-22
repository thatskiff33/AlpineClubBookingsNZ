-- #2872 (CT-3, epic #2988 "Club Time") — make twelve true CALENDAR DATES
-- structurally date-only, so the schema carries their meaning instead of
-- depending on every writer honouring a convention.
--
-- WHAT A "CALENDAR DATE" IS HERE. A birthday, a membership start day, a promo
-- window edge: a day on the wall calendar, the same day in every timezone, with
-- no time inside it. The epic's contract (docs/CLUB_TIME_KERNEL.md, INV-DATE)
-- keeps those strictly apart from INSTANTS — createdAt, when a payment settled —
-- which are a real moment and must never be truncated to a day. Only the first
-- kind is touched here. Not one instant column is narrowed.
--
-- THE TWELVE, AND THE WRITE THAT PROVES EACH ONE:
--
--   "Member"."dateOfBirth"                          parseDateOnly / new Date('yyyy-mm-dd') / Date.UTC on
--                                                   every writer; the two Xero parsers that built
--                                                   SERVER-LOCAL midnight were fixed by #2867 and their
--                                                   ten rows repaired by 20260814010000
--   "Member"."joinedDate"                           ^\d{4}-\d{2}-\d{2}$ -> new Date on the admin paths,
--                                                   parseDateOnly on CSV import, the Xero first-invoice
--                                                   date on the sync
--   "Member"."lifeMemberDate"                       the same admin/CSV writers as joinedDate
--   "MemberApplication"."applicantDateOfBirth"      zod ^\d{4}-\d{2}-\d{2}$ handed straight to Prisma
--   "FamilyGroupJoinRequest"."childDateOfBirth"     parseDateOnly on the family request routes
--   "FamilyGroupJoinRequest"."requestedDateOfBirth" parseDateOnly on the family request routes
--   "PromoCode"."validFrom"                         parseDateOnly from a `dateOnlyString` schema
--   "PromoCode"."validUntil"                        the same
--   "PromoCode"."bookingStartFrom"                  the same; gates on Booking.checkIn, itself @db.Date
--   "PromoCode"."bookingStartUntil"                 the same
--   "MembershipNominationSettings"."gateEffectiveFrom"
--                                                   an <input type="date"> value re-encoded as
--                                                   `${day}T00:00:00Z` by the admin panel, read back with
--                                                   .slice(0, 10), and compared against Member.joinedDate
--                                                   — a calendar-day comparison on both sides
--   "GroupBooking"."joinDeadline"                   isDateOnlyString + parseDateOnly on the API, from an
--                                                   <input type="date"> labelled "Close to new joins after"
--
-- WHAT IS DELIBERATELY NOT HERE. `MemberInduction`.`inductionDate` reads like a
-- calendar date and is not one: `induction.ts` stamps it `new Date()` when the
-- last sign-off lands. `CalendarEventSeries`.`until` IS a calendar date in the
-- admin UI, but its API accepts an unvalidated ISO string and its readers use
-- host-LOCAL getters, so narrowing it would silently truncate a caller-supplied
-- time on a feature that has to be corrected first. Both are classified in the
-- pull request's census and neither is touched.
--
-- THE PREFLIGHT IS FAIL-CLOSED, AND THAT IS THE POINT. Narrowing timestamp(3) to
-- DATE throws away the time part of every stored value. For a row already at
-- 00:00:00 that is exactly value-preserving; for a row carrying a time it would
-- change the value's meaning and, for a value written as SERVER-LOCAL midnight
-- east of UTC, would freeze in a day-early day with the evidence destroyed.
-- Issue #2872 says it plainly: if any value would be changed or truncated, STOP
-- that field and reconcile the data with evidence before narrowing. So this
-- block counts every offending row and RAISES rather than guessing. It reports
-- COUNTS ONLY and never a stored value, because these columns hold dates of
-- birth.
--
-- date_trunc('day', x) on a naive timestamp is pure timestamp arithmetic: no
-- AT TIME ZONE, no dependence on the database container's zone or its tzdata.
-- That matters, because the whole point of this migration is to stop civil
-- meaning depending on a machine's zone.

DO $preflight$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s.%s (%s row(s))', t, c, n), '; ' ORDER BY t, c)
    INTO offenders
    FROM (
      SELECT 'Member' AS t, 'dateOfBirth' AS c, count(*) AS n
        FROM "Member"
       WHERE "dateOfBirth" IS NOT NULL
         AND "dateOfBirth" <> date_trunc('day', "dateOfBirth")
      UNION ALL
      SELECT 'Member', 'joinedDate', count(*)
        FROM "Member"
       WHERE "joinedDate" IS NOT NULL
         AND "joinedDate" <> date_trunc('day', "joinedDate")
      UNION ALL
      SELECT 'Member', 'lifeMemberDate', count(*)
        FROM "Member"
       WHERE "lifeMemberDate" IS NOT NULL
         AND "lifeMemberDate" <> date_trunc('day', "lifeMemberDate")
      UNION ALL
      SELECT 'MemberApplication', 'applicantDateOfBirth', count(*)
        FROM "MemberApplication"
       WHERE "applicantDateOfBirth" IS NOT NULL
         AND "applicantDateOfBirth" <> date_trunc('day', "applicantDateOfBirth")
      UNION ALL
      SELECT 'FamilyGroupJoinRequest', 'childDateOfBirth', count(*)
        FROM "FamilyGroupJoinRequest"
       WHERE "childDateOfBirth" IS NOT NULL
         AND "childDateOfBirth" <> date_trunc('day', "childDateOfBirth")
      UNION ALL
      SELECT 'FamilyGroupJoinRequest', 'requestedDateOfBirth', count(*)
        FROM "FamilyGroupJoinRequest"
       WHERE "requestedDateOfBirth" IS NOT NULL
         AND "requestedDateOfBirth" <> date_trunc('day', "requestedDateOfBirth")
      UNION ALL
      SELECT 'PromoCode', 'validFrom', count(*)
        FROM "PromoCode"
       WHERE "validFrom" IS NOT NULL
         AND "validFrom" <> date_trunc('day', "validFrom")
      UNION ALL
      SELECT 'PromoCode', 'validUntil', count(*)
        FROM "PromoCode"
       WHERE "validUntil" IS NOT NULL
         AND "validUntil" <> date_trunc('day', "validUntil")
      UNION ALL
      SELECT 'PromoCode', 'bookingStartFrom', count(*)
        FROM "PromoCode"
       WHERE "bookingStartFrom" IS NOT NULL
         AND "bookingStartFrom" <> date_trunc('day', "bookingStartFrom")
      UNION ALL
      SELECT 'PromoCode', 'bookingStartUntil', count(*)
        FROM "PromoCode"
       WHERE "bookingStartUntil" IS NOT NULL
         AND "bookingStartUntil" <> date_trunc('day', "bookingStartUntil")
      UNION ALL
      SELECT 'MembershipNominationSettings', 'gateEffectiveFrom', count(*)
        FROM "MembershipNominationSettings"
       WHERE "gateEffectiveFrom" IS NOT NULL
         AND "gateEffectiveFrom" <> date_trunc('day', "gateEffectiveFrom")
      UNION ALL
      SELECT 'GroupBooking', 'joinDeadline', count(*)
        FROM "GroupBooking"
       WHERE "joinDeadline" IS NOT NULL
         AND "joinDeadline" <> date_trunc('day', "joinDeadline")
    ) counted
   WHERE n > 0;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'CT-3 (#2872): refusing to narrow calendar-date columns to DATE. These columns hold values with a time in them, and narrowing would discard it: %', offenders
      USING HINT = 'A calendar-date column must hold midnight exactly. List the rows with SELECT "id" FROM "<table>" WHERE "<column>" <> date_trunc(''day'', "<column>"), establish which calendar day each value was MEANT to be, repair them with evidence, then run this migration again. A value at 11:00, 12:00 or 13:00 is the shape a server-local-midnight parser east of UTC writes and is one day EARLY - see 20260814010000_repair_local_midnight_dates_of_birth. Do not simply truncate: that keeps the wrong day and destroys the evidence of which rows were wrong.';
  END IF;
END
$preflight$;

-- The narrowing itself. `timestamp(3)` -> `date` is an assignment cast that keeps
-- the year, month and day and discards the time, which the block above has just
-- proven is empty on every row. PostgreSQL rewrites each table in place under an
-- ACCESS EXCLUSIVE lock; every one of these is a club-sized table (a membership
-- in the hundreds to low thousands; promo codes, applications and join requests
-- in the tens), so each rewrite is milliseconds. The lock and old-colour analysis
-- is in this migration's row in docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.
ALTER TABLE "Member" ALTER COLUMN "dateOfBirth" SET DATA TYPE DATE;
ALTER TABLE "Member" ALTER COLUMN "joinedDate" SET DATA TYPE DATE;
ALTER TABLE "Member" ALTER COLUMN "lifeMemberDate" SET DATA TYPE DATE;
ALTER TABLE "MemberApplication" ALTER COLUMN "applicantDateOfBirth" SET DATA TYPE DATE;
ALTER TABLE "FamilyGroupJoinRequest" ALTER COLUMN "childDateOfBirth" SET DATA TYPE DATE;
ALTER TABLE "FamilyGroupJoinRequest" ALTER COLUMN "requestedDateOfBirth" SET DATA TYPE DATE;
ALTER TABLE "PromoCode" ALTER COLUMN "validFrom" SET DATA TYPE DATE;
ALTER TABLE "PromoCode" ALTER COLUMN "validUntil" SET DATA TYPE DATE;
ALTER TABLE "PromoCode" ALTER COLUMN "bookingStartFrom" SET DATA TYPE DATE;
ALTER TABLE "PromoCode" ALTER COLUMN "bookingStartUntil" SET DATA TYPE DATE;
ALTER TABLE "MembershipNominationSettings" ALTER COLUMN "gateEffectiveFrom" SET DATA TYPE DATE;
ALTER TABLE "GroupBooking" ALTER COLUMN "joinDeadline" SET DATA TYPE DATE;
