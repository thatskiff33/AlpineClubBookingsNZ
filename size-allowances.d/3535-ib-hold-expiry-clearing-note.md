# File-size allowances for #3535 — hold-expiry clearing note

The internet-banking hold-expiry release now enqueues the invoice-applied
modification credit note inside its own transaction, so the one enqueue that
builds that note learns to take the caller's transaction client and to carry
the unpaid-invoice wording choice through to the worker.

file: src/lib/xero-operation-outbox.ts
lines: 3311
reason: the transaction-client option and the wording choice belong on the
  existing enqueue and its dispatch arm, beside the dedupe they change; a
  second enqueue elsewhere would fork the booking-anchored clearing key that
  the cancel path, the repair tool and the cron must share.
