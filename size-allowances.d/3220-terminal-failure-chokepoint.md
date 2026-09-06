# File-size allowances for #3220

file: src/lib/payment-recovery.ts
lines: 2927
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

  The fix round adds the last of it, and all three parts are rules rather than
  machinery. The withdrawal now has to explain the ONE ask it leaves standing -
  a supplementary invoice still parked WAITING_PAYMENT on that very intent means
  no invoice was ever raised, so there is no duplicate to remove and cancelling
  would take away the only live route to the money. The tallies comment stopped
  claiming a parity with the pre-chokepoint code that was never true. And the
  stale-worker sweep says why it is now bounded and oldest-first, which is a
  consequence of the transition being centralised: rows that used to cost one
  bulk update can now cost a provider round trip each.

file: src/lib/xero-operation-outbox.ts
lines: 3179
reason: The read this adds - is this booking change's supplementary invoice
  still waiting on this exact PaymentIntent? - is the mirror image of the
  attach that parks it there, and the two share a `where` and a payload
  parse that must never drift apart: one decides what to attach an intent
  to, the other decides whether an attached intent may be cancelled. Putting
  them in different modules is exactly the split that lets a filter change on
  one side and not the other, which is the defect INV-SSOT exists to prevent.
  The outbox is already the one home for every read and write of
  `XeroSyncOperation`, so a sibling module for a single read of that table
  would be a new home for a fact that already has one. Most of the growth is
  the docblock arguing why the intent id is part of the match - a row waiting
  on a different intent is not this ask's blocker - which is the mistake a
  future edit would otherwise make.
