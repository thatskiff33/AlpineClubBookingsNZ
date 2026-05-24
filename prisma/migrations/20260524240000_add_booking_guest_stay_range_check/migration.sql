-- Enforce BookingGuest stay range invariant at the DB layer.
-- A bug elsewhere (admin direct DB edit, future migration that shifts
-- booking dates without touching guest dates) could otherwise produce
-- a row that silently breaks capacity reporting in
-- countActiveGuestsForNight. Stretch invariants (range inside booking
-- envelope) are still enforced at the application layer; this is the
-- minimal first-cut DB invariant.
ALTER TABLE "BookingGuest"
  ADD CONSTRAINT "BookingGuest_stayRange_valid"
  CHECK ("stayStart" < "stayEnd");
