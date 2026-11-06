# File-size allowances for #4688 (the unrecorded refund-note fence)

Two already-over-budget files grow by a call or a check each. The fence's logic
lives in `xero-refund-note-in-flight.ts`, beside the in-flight hold it extends;
these lines are only where the two existing gates call it.

file: src/lib/xero-operation-retry.ts
lines: 2106
reason: the row-level refusal in `getXeroOperationRetryMeta` (one check, its
  import, and the optional `lastErrorCode` on the row shape it reads). That
  function is the single place every Retry surface - the panel's button, the
  booking page, the repair tool, the retry enqueue and the drain - decides
  whether a row may be retried; a second decider elsewhere would let the
  surfaces disagree.
