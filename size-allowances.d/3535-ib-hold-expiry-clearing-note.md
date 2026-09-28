# File-size allowances for #3535 — hold-expiry clearing note

The internet-banking hold-expiry release now enqueues the invoice-applied
modification credit note inside its own transaction, so the one enqueue that
builds that note learns to take the caller's transaction client and to carry
the unpaid-invoice wording choice through to the worker.

The outbox entry this fragment carried (3307 lines) was removed when #3641
merged in: #3641 moved the waiting-invoice reaper and the late-capture release
out of `xero-operation-outbox.ts`, so the composed file (3205 lines) is below
its base length and needs no allowance.

file: src/lib/booking-cancel.ts
lines: 2547
reason: the never-captured cancel path's existing clearing-note enqueue gains
  the one flag that makes its wording say the invoice was cleared, with a
  two-line note on why; the call is the rule, and moving it out of the cancel
  claim's follow-up would separate it from the sizing it sits beside.
  #3638 (same epic) adds its share: the card-intent cancel marks the row FAILED
  only when Stripe confirms the intent dead, through the shared predicate.
  #3643 (same epic, one entry per file) adds the three call sites of the
  part-payment recognition - the read before the dispatch, the record inside
  the paid claim, the clearing note after it - whose bodies live in
  `internet-banking-part-payment-at-cancel.ts`; the calls must sit at those
  three points of the cancel's own sequence. The delta round adds the officer
  gate and the no-note unpaid cancel of DECISION 2, and the throw that rolls a
  refused claim back, at the same points.
  #3639 (same epic) shrank the file, so the composed length is #3643's share
  alone. The owner's 28 Sep 2026 decision adds the one call that raises the
  DECISION 2 hand-back task inside the unpaid claim, beside the status flip it
  must commit with; the task writer lives in the same helper module.

file: src/lib/xero-booking-repair-classify.ts
lines: 1990
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
  arm's gate, replacing this arm's own copy; #3639 shrank `booking-cancel.ts`
  (its entry above carries #3643's share alone); the #1491 test is the shared
  `isCancellationRefundDecisionRecorded`, which excludes #3638's marker too.
  #3643's fix round counts an OPEN part-payment review as a recorded invoice
  payment in the same arm's gate, beside the recorded-link test it widens.
  #3643 (same epic) adds the manual-review answer to a recorded or recognised
  part payment, naming it; the predicates live in `xero-inbound/object-links.ts`
  and `part-payment-recognition-reason.ts`. Composed with #3639, the recognised
  part payment still enters that arm past its captured-money gate, only while
  the rest note its cancel queued is outstanding; and the one "cash retired"
  home also reads the organisation arm's hand-back task, so both are single
  predicates beside the gate they decide. One predicate says an officer's
  resolved-in-Xero mark ends a clearing note's finding, and a rest note's
  missing allocation is sized from the note's own recorded amount, with a
  manual-review answer when none is recorded. The owner's 28 Sep 2026
  decision adds one predicate: a closed DECISION 2 hand-back task ends that
  arm's finding, read from the loader's context.

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
lines: 1894
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
  #3643 exports the cash rule for the hold payment check and corrects its
  "only caller" comments. Its fix rounds stop both late-cash arms sizing or
  minting anything while a part-payment review names the payment, and alert
  when the event is noted on the review; the lookup, the note and the reopen
  live in `part-payment-review-cover.ts`, and what stays is the call, the
  zeroing of each arm's figure, and the alert beside its three siblings.

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
