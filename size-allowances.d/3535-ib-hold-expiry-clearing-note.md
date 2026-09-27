# File-size allowances for #3535 — hold-expiry clearing note

The internet-banking hold-expiry release now enqueues the invoice-applied
modification credit note inside its own transaction, so the one enqueue that
builds that note learns to take the caller's transaction client and to carry
the unpaid-invoice wording choice through to the worker.

file: src/lib/xero-operation-outbox.ts
lines: 3307
reason: the transaction-client option and the wording choice belong on the
  existing enqueue and its dispatch arm, beside the dedupe they change; a
  second enqueue elsewhere would fork the one booking-anchored clearing note
  the cancel path, the repair tool and the cron all raise.

file: src/lib/xero-booking-repair-classify.ts
lines: 1836
reason: the cancelled-open-invoice arm gains the clearing flag on its payload,
  a finding for a blocking clearing operation it cannot retry (it was silent),
  and a retry of a PARTIAL clearing note in place of a full-size allocation;
  all three are decisions of that one arm, and the classifier is kept whole
  by design (its header says why). The delta review added the arm's stand-down
  for a note retired by late cash and its manual-review answer to a shortfall;
  the predicates themselves live in `xero-clearing-allocations.ts`.
  Composed with #3639 at the epic sync (one file, one allowance, so its growth
  is declared here): the late-capture arm leaves out captures a
  treasurer-approval task owns and pins its refund to the rest, and the one
  home of the "cash retired the clearing note" finding moved before the
  arm's gate, replacing this arm's own copy. `booking-cancel.ts` needs no
  allowance any more: #3639 shrank it.

file: src/lib/xero-operation-retry.ts
lines: 1610
reason: the retry screen admits a FAILED booking-anchored clearing note and
  replays a PARTIAL one across its recorded invoices; the parsing and the
  already-allocated filter live in `xero-clearing-allocations.ts`, leaving
  only the two dispatch arms here, beside their siblings, and the refusal of a
  recorded plan with a redacted invoice id at the two places it is read.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1726
reason: the already-cancelled credit arm retires a still-pending
  booking-anchored clearing note when cash arrives, beside the refund-note
  retirement it mirrors in the same transaction, and the organisation arm the
  same; the reading and the retirement themselves live in
  `invoice-clearing-note-evidence.ts`.

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
