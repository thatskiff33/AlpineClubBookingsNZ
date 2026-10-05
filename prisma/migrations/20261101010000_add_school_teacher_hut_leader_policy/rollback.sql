-- #3416 manual reverse, never applied by Prisma migrate.
-- Stop the new application and workers before running this script, record the
-- chosen policy value for the club, and deploy old code only with owner review:
-- old code always auto-assigns school teachers regardless of the value here.
-- Existing BookingRequestSettings and booking/contact rows stay readable.
ALTER TABLE "BookingRequestSettings"
  DROP COLUMN IF EXISTS "assignSchoolTeachersAsHutLeaders";
