# File-size allowances for #3535 — hold-expiry clearing note

The internet-banking hold-expiry release now enqueues the invoice-applied
modification credit note inside its own transaction, so the one enqueue that
builds that note learns to take the caller's transaction client and to carry
the unpaid-invoice wording choice through to the worker.

file: src/lib/xero-operation-outbox.ts
lines: 3311
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
lines: 1668
reason: the cancelled-open-invoice action's payload gains the same flag and a
  one-line note, inside the arm that decides the booking needs a clearing
  note; the payload is built nowhere else.
