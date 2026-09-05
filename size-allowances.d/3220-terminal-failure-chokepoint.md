# File-size allowances for #3220

file: src/lib/payment-recovery.ts
lines: 2844
reason: This change makes the module SHORTER in machinery and longer in prose.
  The three terminal-failure transitions became one function, and the
  stale-worker reaper lost a whole bulk-update arm and a second query - but the
  chokepoint has to argue why terminality is an argument rather than a
  re-derivation, why `nextRetryAt` is forced null, and why the write is
  status-fenced (a `P2025` from the old `update` by id escaped the worker
  loop's own catch and abandoned the rest of the batch). Every one of those is
  a rule a future edit would otherwise re-derive wrongly, and this repository's
  convention is that the reasoning lives at the site it governs.

  Splitting is worse here rather than merely inconvenient. The transition is
  the module's own state machine: the chokepoint, the two status-set constants
  the readers share, the claim, the completion and the stale-worker reaper are
  one topic that has to be read together, and moving half of it into a sibling
  module would put the fence and the thing it fences in different files. The
  seam this module genuinely has - the per-type processors - is unaffected by
  this change and is where a future split belongs.

  The cancel round adds the rest. `cancelStrandedAdditionalIntentForDeadRecovery`
  and its audit record are new behaviour on the terminal path, and most of their
  length is the reasoning a future edit would otherwise have to re-derive from
  three separate issues: why an ask can exist on a path that failed to make one,
  why the withdrawal runs after the status write and can never throw (a Stripe
  outage holding a row out of FAILED would re-block the repair tool for ever,
  and a throw from the worker loop's own catch abandons the batch), why an
  already-paid ask is locked out twice, and why the refusal branch writes an
  audit row rather than a log line. The officer-facing prose in that record is
  itself a chunk of the growth, and it is prose an officer reads rather than
  code - it belongs with the decision that writes it.

  The seam argument above is unchanged: the transition and its consequences are
  one topic, and the withdrawal is a consequence of the transition rather than a
  separate concern that could live elsewhere.

  The last of the growth is a correction rather than new machinery. The first
  draft of this module's status-set docblock said the booking-vs-Xero repair tool
  reads a recovery's DEADNESS as permission to stop deferring. It does not:
  `OPEN_PAYMENT_RECOVERY_STATUSES` is `[PENDING, PROCESSING]` and carries no
  `attempts` filter, so it stops deferring at the FIRST failure. The two-readings
  rule is this module's own, and a reader who carried it across the boundary
  would predict a deferral that is not there. Saying so where the constants live,
  and again beside the withdrawal whose reach it bounds, is worth its lines.
