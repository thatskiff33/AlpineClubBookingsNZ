-- #3413 — capacity-only reservations for unnamed adults in school quotes.
--
-- PHASE: windowed. The schema is additive, but the old capacity reader cannot
-- see this new table. It is forbidden to write a nonzero pendingAdultCount or
-- any reservation while an old web/worker colour can admit beds. The approved
-- maintenance window drains every old process before new code enables writes.
--
-- Existing requests default to zero. No BookingGuest, Member, Organisation,
-- contact, provider, or historical booking data is created or rewritten.
--
-- LOCK IMPACT: DDL only. The BookingRequest column takes ACCESS EXCLUSIVE
-- briefly; the new table has no existing rows. Runtime writers retain their
-- established global -> lodge lock order.
--
-- REVERSE: rollback.sql drops the relation and column only after writes are
-- disabled and zero counts/reservations are proved. An old runtime before that
-- proof would undercount held beds.

ALTER TABLE "BookingRequest"
  ADD COLUMN "pendingAdultCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "BookingRequest"
  ADD CONSTRAINT "BookingRequest_pendingAdultCount_nonnegative"
  CHECK ("pendingAdultCount" >= 0);

CREATE TABLE "BookingRequestPendingAdultReservationNight" (
  "id" TEXT NOT NULL,
  "bookingRequestId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "lodgeId" TEXT NOT NULL,
  "night" DATE NOT NULL,
  "adultCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookingRequestPendingAdultReservationNight_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingRequestPendingAdultReservationNight_adultCount_positive" CHECK ("adultCount" > 0),
  CONSTRAINT "BookingRequestPendingAdultReservationNight_bookingRequestId_fkey"
    FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingRequestPendingAdultReservationNight_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingRequestPendingAdultReservationNight_lodgeId_fkey"
    FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BookingRequestPendingAdultReservationNight_bookingRequestId_night_key"
  ON "BookingRequestPendingAdultReservationNight"("bookingRequestId", "night");
CREATE INDEX "BookingRequestPendingAdultReservationNight_lodgeId_night_idx"
  ON "BookingRequestPendingAdultReservationNight"("lodgeId", "night");
CREATE INDEX "BookingRequestPendingAdultReservationNight_bookingId_idx"
  ON "BookingRequestPendingAdultReservationNight"("bookingId");
