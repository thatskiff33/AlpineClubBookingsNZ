# File-size allowances for #5017

The Paid another way close queues a reversal invoice beside the bank note.
These four files already held that close, and the reversal is a branch in
each of them.

file: src/app/api/admin/bookings/search/route.ts
lines: 279
reason: the booking search already excludes invoice creates on the Payment
  that are the booking bill. The reversal invoice is one more exclusion on
  that same query, and lifting the query out is a separate change.

file: src/lib/payment-reconciliation.ts
lines: 2890
reason: reconciliation already decides which invoice creates on a Payment
  count as the booking bill. The reversal exclusion sits in those two
  queries, beside the bill they describe.

file: src/lib/xero-operation-outbox.ts
lines: 3472
reason: the outbox worker already dispatches every queue type. The reversal
  invoice is one more branch of that dispatch, calling the worker that
  writes it.

file: src/lib/xero-operation-retry.ts
lines: 2186
reason: retry already knows which queue types it may run again. The reversal
  invoice follows the same claim, so its type is named beside the others.
