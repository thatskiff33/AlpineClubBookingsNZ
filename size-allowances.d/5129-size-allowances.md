# Size allowances for #5129

function: src/lib/cron-confirm-pending.ts#resolveHoldWindowUnderLock
lines: 506
reason: a durable saved-card claim marker and stale-claim recovery; those
  lines sit inside the function `resolveHoldWindowUnderLock`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
