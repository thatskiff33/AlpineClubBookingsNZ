# File-size allowances for #4998 (#4516, Ledger M4d)

A hand-back's refund debt (R05) has to post in the same transaction, under the
same locks, as the task it records, so each door that raises or releases a
hand-back gains a line or a few beside the write it already makes. Moving those
lines elsewhere would separate the journal post from the write and the locks it
depends on.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 767
reason: a released approval withdraws its bank hand-back's debt beside the release, under the same Payment row.

file: src/lib/booking-batch-modification-service.ts
lines: 2759
reason: one argument passes the edit's journal context to the hand-back raise it already calls.

file: src/lib/booking-cancel.ts
lines: 2882
reason: the paid cancel's hand-back debt posts beside its task, under the claim's lock(1).

file: src/lib/booking-date-modification-service.ts
lines: 2255
reason: one argument passes the edit's journal context to the hand-back raise it already calls.

file: src/lib/booking-guest-removal-service.ts
lines: 1232
reason: one argument passes the removal's journal context to the hand-back raise it already calls.

file: src/lib/payment-transactions.ts
lines: 1879
reason: the local allocation returns the receipts it consumed, which fund the hand-back's payment and nothing else.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2113
reason: an organisation's late cash posts its hand-back debt beside the task, under the delivery's lock(1).

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2385
reason: a bank or cash hand-back's row shows why it cannot be dismissed (#4516, owner decision 14 Nov 2026) where the Dismiss button renders, beside the group organiser's rule it follows; a part to check's dismiss dialog says to dismiss only once the card refund is confirmed, and a disputed card payment's once its dispute is lost (owner decisions, 15 Nov 2026).

function: src/app/api/admin/refund-requests/[id]/route.ts#PUT
lines: 703
reason: the approval passes its journal context to the bank part's raise and a release withdraws that part's R05, each beside the write it belongs to, under the same lock(1) and Payment row.

function: src/components/admin/manual-refund-task-queue.tsx#ManualRefundTaskQueue
lines: 1328
reason: the row prints why a bank or cash hand-back cannot be dismissed (owner decision, 14 Nov 2026) where the Dismiss button renders, beside the group organiser's rule it follows.

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1808
reason: one argument passes the edit's actor to the hand-back raise it already calls.

function: src/lib/booking-cancel.ts#performBookingCancellation
lines: 2123
reason: the cash hand-back's R05 posts beside its task, under the claim's lock(1).

function: src/lib/booking-date-modification-service.ts#modifyBookingDates
lines: 1179
reason: one argument passes the edit's actor to the hand-back raise it already calls.

function: src/lib/booking-guest-removal-service.ts#removeBookingGuestInTransaction
lines: 825
reason: one argument passes the edit's actor to the hand-back raise it already calls.

function: src/lib/xero-inbound/invoice-paid-effects.ts#syncInternetBankingPaymentsForPaidInvoice
lines: 1621
reason: an organisation's late cash posts its hand-back R05 beside the task, reading the owner plainly after the Payment row (review C).
