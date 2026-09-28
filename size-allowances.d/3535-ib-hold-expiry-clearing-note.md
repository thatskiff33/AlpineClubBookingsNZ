# File-size allowances for #3535 — hold-expiry clearing note

The internet-banking hold-expiry release now enqueues the invoice-applied
modification credit note inside its own transaction, so the one enqueue that
builds that note learns to take the caller's transaction client and to carry
the unpaid-invoice wording choice through to the worker.

The outbox entry this fragment carried (3307 lines) was removed when #3641
merged in: #3641 moved the waiting-invoice reaper and the late-capture release
out of `xero-operation-outbox.ts`, so the composed file (3205 lines) is below
its base length and needs no allowance.

file: src/lib/xero-booking-repair-classify.ts
lines: 1838
reason: the cancelled-open-invoice arm gains the clearing flag on its payload,
  a finding for a blocking clearing operation it cannot retry (it was silent),
  and a retry of a PARTIAL clearing note in place of a full-size allocation;
  all three are decisions of that one arm, and the classifier is kept whole
  by design (its header says why). The delta review added the arm's stand-down
  for a note retired by late cash and its manual-review answer to a shortfall;
  the predicates themselves live in `xero-clearing-allocations.ts`.
  #3638 (same epic) adds one predicate call so the late-capture arm does not
  read an admin-only settlement marker as a recorded refund decision.
  Composed with #3639 at the epic sync (one file, one allowance, so its growth
  is declared here): the late-capture arm leaves out captures a
  treasurer-approval task owns and pins its refund to the rest, and the one
  home of the "cash retired the clearing note" finding moved before the
  arm's gate, replacing this arm's own copy; `booking-cancel.ts` needs no
  allowance any more, as #3639 shrank it; the #1491 test is the shared
  `isCancellationRefundDecisionRecorded`, which excludes #3638's marker too.

file: src/lib/xero-operation-retry.ts
lines: 1689
reason: the retry screen admits a FAILED booking-anchored clearing note and
  replays a PARTIAL one across its recorded invoices; the parsing and the
  already-allocated filter live in `xero-clearing-allocations.ts`, leaving
  only the two dispatch arms here, beside their siblings, and the refusal of a
  recorded plan with a redacted invoice id at the two places it is read.
  #3642 (same epic) returns a failed group-settlement invoice row (CREATE or
  VOID) to the outbox, rebuilding the CREATE's queued payload, in the existing
  outbox-requeue branch beside the applied-credit one.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1845
reason: the already-cancelled credit arm retires a still-pending
  booking-anchored clearing note when cash arrives, beside the refund-note
  retirement it mirrors in the same transaction, and the organisation arm the
  same; the reading and the retirement themselves live in
  `invoice-clearing-note-evidence.ts`.
  #3638 (same epic) writes its second-instrument marker inside this settle
  transaction, beside the receipt it describes; the detection, the writer and
  the alert live in `settlement-conflicts.ts`.
  #3672 (same epic): the group arm's already-settled guard says, in two
  comment lines, why it stays SUCCEEDED-only rather than the shared "organiser
  has paid" predicate.
  #3642 (same epic): the paid group invoice arm hands the invoice's cash to
  the settle and recognises a payment on an abandoned invoice (by its link,
  with the cancelled-group wording) and a card double payment; all read the
  invoice and cash evidence that arm already classifies. The alert lives in
  `group-settlement-invoice-alerts.ts`.

file: src/lib/redact-sensitive-json.ts
lines: 914
reason: the phone-like digit rule is lifted out of the pattern list so it
  alone reads the value with UUID shapes masked - the root-cause fix for Xero
  ids stored as "[REDACTED]". It belongs beside the rule it narrows, in the
  one privacy helper; a second module would split one redaction decision.

file: src/lib/xero-sync.ts
lines: 938
reason: `startXeroSyncOperation` gains an explicit `queueType` for a handler
  that opens its own row with an execution-shape payload, next to the
  payload-derived queue type it falls back from; the column has one writer.
