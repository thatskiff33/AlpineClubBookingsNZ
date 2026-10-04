-- #3413 rollback boundary. Run only after disabling pending-adult writes and
-- proving BOTH queries return zero:
--   SELECT count(*) FROM "BookingRequest" WHERE "pendingAdultCount" <> 0;
--   SELECT count(*) FROM "BookingRequestPendingAdultReservationNight";
-- The previous runtime cannot read this relation, so restarting it earlier
-- would undercount held beds. The forward cutover also requires all old
-- web/worker processes stopped before the new runtime enables writes.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BookingRequest" WHERE "pendingAdultCount" <> 0)
     OR EXISTS (SELECT 1 FROM "BookingRequestPendingAdultReservationNight") THEN
    RAISE EXCEPTION 'pending_school_adult_rollback_blocked: resolve or cancel pending adults and reservations before rolling back';
  END IF;
END $$;

DROP TABLE IF EXISTS "BookingRequestPendingAdultReservationNight";
ALTER TABLE "BookingRequest"
  DROP CONSTRAINT IF EXISTS "BookingRequest_pendingAdultCount_nonnegative";
ALTER TABLE "BookingRequest" DROP COLUMN IF EXISTS "pendingAdultCount";
