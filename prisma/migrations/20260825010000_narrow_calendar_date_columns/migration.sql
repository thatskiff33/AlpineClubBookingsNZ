-- #2872 (CT-3, epic #2988 "Club Time") — make eleven true CALENDAR DATES
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
-- THE ELEVEN, AND THE WRITE THAT PROVES EACH ONE:
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
--   "GroupBooking"."joinDeadline"                   isDateOnlyString + parseDateOnly on the API, from an
--                                                   <input type="date"> labelled "Close to new joins after"
--
-- WHAT IS DELIBERATELY NOT HERE. Three columns read like calendar dates and are
-- classified out. All three are in the pull request's census and none is touched.
--
--   "MemberInduction"."inductionDate"   Not a calendar date at all: `induction.ts`
--                                       stamps it `new Date()` when the last
--                                       sign-off lands.
--
--   "CalendarEventSeries"."until"       IS a calendar date in the admin UI, but its
--                                       API accepts an unvalidated ISO string and its
--                                       readers use host-LOCAL getters, so narrowing
--                                       it would silently truncate a caller-supplied
--                                       time on a feature that has to be corrected
--                                       first.
--
--   "MembershipNominationSettings"."gateEffectiveFrom"
--                                       MIXED, which is the same disqualification as
--                                       `inductionDate` above. On the admin path it is
--                                       a calendar day — an <input type="date"> value
--                                       re-encoded as `${day}T00:00:00Z` by
--                                       `induction-settings-panel.tsx` and read back
--                                       with .slice(0, 10). But
--                                       `api/admin/membership-nomination-settings`
--                                       stamps `effectiveFrom = new Date()` whenever
--                                       the gate is being ENABLED and no cutoff was
--                                       typed, and the panel's own help text presents
--                                       that as ordinary use ("Leave blank for no
--                                       cutoff. Defaults to the date you first enable
--                                       the gate."), so it is not an edge case. Its
--                                       reader is not a clean calendar-day comparison
--                                       either: `nominator-eligibility.ts` compares
--                                       `member.joinedDate ?? member.createdAt`
--                                       against it, and `createdAt` is a bare instant.
--
--                                       NARROWING IT WOULD ALSO BREAK THE DEPLOY. Any
--                                       club that enabled the gate without typing a
--                                       cutoff holds a genuine timestamp, so the
--                                       fail-closed preflight below would RAISE and
--                                       stop the whole single-deploy epic — handing the
--                                       operator a HINT whose advice ("a value at
--                                       11:00, 12:00 or 13:00 is one day EARLY") is
--                                       actively wrong for a value that is a true
--                                       instant, because that value is not an
--                                       encoding of a day at all.
--
--                                       AND A REPAIR IS NOT AVAILABLE HERE. Turning
--                                       such an instant into the day the club meant
--                                       needs the club's own time zone, which lives in
--                                       `ClubTimeSettings`; CT-1 deliberately seeds no
--                                       row for it in SQL — the row is created at boot
--                                       — so the table can legitimately be EMPTY while
--                                       this migration runs and the correct club-local
--                                       day is not knowable from SQL. Fixing the writer
--                                       comes first, and it is not this issue.
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
--
-- THE CHECK AND THE CAST MUST BE ATOMIC, WHICH IS WHAT THE LOCK BELOW BUYS.
-- Without it the block reads with no lock at all and each ALTER takes its own
-- ACCESS EXCLUSIVE lock afterwards, one table at a time — and the old colour is
-- still serving throughout `migrate`. A write that commits in that gap carries a
-- time, is never seen by the preflight, and is then truncated by the cast with
-- the evidence destroyed: precisely the silent outcome the HINT below says must
-- never happen. Taking every affected table exclusively BEFORE the first read
-- closes the window, because a transaction holds its locks until it commits.
--
-- It also front-loads the waiting: the deploy blocks here, once, until the five
-- tables are quiet, instead of waiting again at each of the eleven ALTERs. That
-- is the shape the deploy guard's lock timeout already handles — a lane that
-- cannot get the lock fails fast and unchanged rather than half-migrating.
--
-- WHY IT IS INSIDE THE BLOCK RATHER THAN A BARE STATEMENT ABOVE IT. Three
-- measurements, not a preference. (1) `LOCK TABLE` sent as a statement of its own
-- outside a transaction is rejected outright: "LOCK TABLE can only be used in
-- transaction blocks". (2) `prisma migrate deploy` does put the whole file in a
-- transaction, so a bare statement would in fact work on the deploy path —
-- verified by applying this migration to a throwaway PostgreSQL. (3) But the
-- data-migration verification harness replays committed migrations
-- STATEMENT BY STATEMENT and outside any transaction, deliberately, because
-- PostgreSQL refuses to use an enum value added in the same block; a bare
-- statement fails there. Inside PL/pgSQL there is always a transaction, so this
-- form is accepted on every path — and where a transaction really does span the
-- file, the lock is still held after the block returns, which is the property
-- that makes it worth taking (measured: the AccessExclusiveLock row is still in
-- pg_locks after the DO ends).

DO $preflight$
DECLARE
  offenders text;
BEGIN
  -- Every table an ALTER below rewrites. `MembershipNominationSettings` is not
  -- here because its column is not narrowed - see the exclusion note above.
  LOCK TABLE "Member", "MemberApplication", "FamilyGroupJoinRequest", "PromoCode", "GroupBooking"
    IN ACCESS EXCLUSIVE MODE;

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

-- The narrowing itself, eleven statements. `timestamp(3)` -> `date` is an
-- assignment cast that keeps the year, month and day and discards the time,
-- which the block above has just proven is empty on every row — and, because
-- the lock above is still held, no writer can have added one since.
--
-- PostgreSQL rewrites each table in place; the ACCESS EXCLUSIVE lock each
-- statement needs is already held from the LOCK above, so none of them waits.
-- Every one of these is a club-sized table (a membership in the hundreds to low
-- thousands; promo codes, applications, join requests and group bookings in the
-- tens), so each rewrite is milliseconds. The lock and old-colour analysis
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
ALTER TABLE "GroupBooking" ALTER COLUMN "joinDeadline" SET DATA TYPE DATE;
