# File-size allowances for #3589

These are required-format argument threads through existing money and booking
transactions. Splitting the callers to save a handful of lines would separate
the pre-lock format authority from the lock-protected action it serves.

file: src/lib/booking-batch-modification-service.ts
lines: 2620
reason: the one required format argument belongs beside the existing batch
  settlement transition call; extracting it would obscure that call's ordering.

file: src/lib/booking-cancel.ts
lines: 2525
reason: the one required format argument belongs in the existing cancellation
  transaction beside its ledger-locked repair and notification decisions.

file: src/lib/booking-guest-removal-service.ts
lines: 1511
reason: the one required format argument belongs beside the existing guest
  removal settlement call; splitting that call would hide its transaction context.

file: src/lib/member-credit.ts
lines: 1032
reason: the required format value is threaded through this existing credit
  clamp beside the ledger lock; splitting it would separate the authority from use.

file: src/lib/xero-applied-credit-deallocation.ts
lines: 1023
reason: the required pre-lock format stays with the existing deallocation
  transaction and repair call; extracting it would obscure their lock order.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1013
reason: the required format is resolved before the existing per-target
  transactions and passed through here; splitting this path would obscure that seam.
