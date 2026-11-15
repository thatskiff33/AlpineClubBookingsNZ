# Size allowances for #5122

file: src/lib/booking-batch-modification-service.ts
lines: 2761
reason: a shared price-preserving classifier for the edit preview and save;
  those lines sit inside this file, which was already over its limit before
  this change, and lifting it apart is a refactor of its own, not part of this
  fix.

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1812
reason: a shared price-preserving classifier for the edit preview and save;
  those lines sit inside the function `modifyBookingBatch`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.
