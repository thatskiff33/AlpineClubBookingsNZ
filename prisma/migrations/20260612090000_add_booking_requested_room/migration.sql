-- Room request at booking time (issue #706).
-- Adds an optional preferred-room reference on Booking that auto-allocation
-- consults before falling back to family-grouping/first-fit. SetNull keeps
-- existing bookings intact if the requested room is later deleted.

ALTER TABLE "Booking"
  ADD COLUMN "requestedRoomId" TEXT;

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_requestedRoomId_fkey"
  FOREIGN KEY ("requestedRoomId") REFERENCES "LodgeRoom"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Booking_requestedRoomId_idx"
  ON "Booking" ("requestedRoomId");
