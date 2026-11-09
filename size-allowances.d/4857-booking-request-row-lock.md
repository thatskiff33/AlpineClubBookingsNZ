# File-size allowances for #4857

file: src/lib/booking-request.ts
lines: 3100
reason: one import and the held booking's row lock in `approveBookingRequest`,
  with the short note on why it sits between the lodge key and the claim. The
  lock has to run inside that transaction at that point, so it cannot move to
  another module; the statement itself already lives in `booking-row-lock.ts`,
  and the locking guide carries the full reasoning.
