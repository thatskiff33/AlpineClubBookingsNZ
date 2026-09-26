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

file: src/lib/booking-cancel.ts
lines: 2527
reason: the never-captured cancel path's existing clearing-note enqueue gains
  the one flag that makes its wording say the invoice was cleared, with a
  two-line note on why; the call is the rule, and moving it out of the cancel
  claim's follow-up would separate it from the sizing it sits beside.

file: src/lib/xero-booking-repair-classify.ts
lines: 1725
reason: the cancelled-open-invoice arm gains the clearing flag on its payload,
  a finding for a blocking clearing operation it cannot retry (it was silent),
  and a retry of a PARTIAL clearing note in place of a full-size allocation;
  all three are decisions of that one arm, and the classifier is kept whole
  by design (its header says why).

file: src/lib/xero-operation-retry.ts
lines: 1593
reason: the retry screen admits a FAILED booking-anchored clearing note and
  replays a PARTIAL one across its recorded invoices; the parsing and the
  already-allocated filter live in `xero-clearing-allocations.ts`, leaving
  only the two dispatch arms here, beside their siblings.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1732
reason: the already-cancelled credit arm retires a still-pending
  booking-anchored clearing note when cash arrives, beside the refund-note
  retirement it mirrors in the same transaction; the "note already issued"
  reading itself lives in `invoice-clearing-note-evidence.ts`.
