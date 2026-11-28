BEGIN;

-- #5239 (INV-HOST-045, INV-HOST-046): a persistent record that a Group Trip's
-- cover re-evaluation fan-out was truncated, so some booking in the trip may
-- never have been queued for the re-check it was owed.
--
-- The kiosk shows adult cover resting on a trip sibling only when the hosting
-- snapshot was evaluated under the trip's CURRENT revision. Every truncation
-- moves the revision on, so a booking the fan-out missed keeps the older value
-- and stays "needs re-checking" until a canonical re-evaluation reaches it. The
-- revision never goes backwards: it is not derived from audit rows, which a
-- retention sweep may delete, nor from the trip's present size, which says
-- nothing about who an earlier fan-out missed.
ALTER TABLE "GroupBooking"
ADD COLUMN "coverageInvalidationRevision" INTEGER NOT NULL DEFAULT 0;

-- The fan-out already writes one audit row per truncated trip, in the same
-- transaction as its queue rows and while holding the trip's coverage key. The
-- increment rides on that insert rather than on new application code, so a
-- deployed old colour that truncates during a blue/green window bumps the
-- revision exactly as the new colour does, and a rolled-back fan-out rolls its
-- increment back with it.
CREATE FUNCTION "bumpGroupBookingCoverageInvalidationRevision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."entityType" = 'GroupBooking' AND NEW."entityId" IS NOT NULL THEN
    UPDATE "GroupBooking"
    SET "coverageInvalidationRevision" = "coverageInvalidationRevision" + 1
    WHERE "id" = NEW."entityId";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "AuditLog_bump_group_trip_coverage_invalidation"
AFTER INSERT ON "AuditLog"
FOR EACH ROW
WHEN (NEW."action" = 'booking.hostingCoverage.groupTripFanoutTruncated')
EXECUTE FUNCTION "bumpGroupBookingCoverageInvalidationRevision"();

COMMIT;
