file: src/lib/payment-reconciliation.ts
lines: 2931
reason: The import's sibling entry point must call the private settlement body inside the caller's transaction; extracting that body is a separate change across all settlement writers.

file: src/lib/xero-booking-invoices.ts
lines: 1688
reason: The shared external-settlement predicate extends the existing invoice fence to imported free stays; moving this guard away from its handler would reopen the provider call.

file: src/lib/xero-operation-outbox.ts
lines: 3475
reason: The import-row selection and refusal extend the existing invoice choke point; moving that guard outside the queue would leave other enqueuers uncovered.
