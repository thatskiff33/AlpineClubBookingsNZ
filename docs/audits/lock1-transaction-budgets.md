# Lock(1) transaction budgets: the INV-LOCK-006 census

Audit for the follow-up to #4933, run 14 Nov 2026 on branch `alp-592`. It lists
every interactive transaction that waits for the global key
`pg_advisory_xact_lock(1)`, the budget each ran on before the follow-up (the tree
at `c0b8bf5f7`, #4933 merged) and the budget it runs on now. The rule is
[`INV-LOCK-006`](../invariants/operations.md#inv-lock-006); the guide is
[`CONCURRENCY_AND_LOCKING.md`](../CONCURRENCY_AND_LOCKING.md#the-lock1-transaction-budget-4933).

## How the list was produced

The list is the output of the reader the census test uses,
`src/lib/__tests__/support/lock1-transaction-scan.ts`, run over both trees. It
starts from the INV-LOCK-003 site list (`advisory-lock-scan.ts`) and follows each
wait out to the call that opens the transaction: `$transaction`,
`withOptionalTransaction` or `withStoreTransaction`. It follows named helpers and
named callbacks into every module that calls them, so a writer that waits for the
key inside a caller's transaction is charged to that caller's opener.

`lock1-transaction-budget-census.test.ts` now fails when any opener on the list
passes anything other than:

- `LOCK1_HOLDER_TRANSACTION_BUDGET`, or a `const` that is exactly it
  (`ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS`, `LINKED_MOVE_TRANSACTION_BUDGET`);
- a comment inside the options argument reading `INV-LOCK-006 exception:` and a
  reason.

One function waits for the key but has no caller yet,
`raiseEditFinancialReviewTask` (`src/lib/edit-financial-review.ts`). The census
holds it on a reasoned allowlist that fails once a caller appears.

## Summary

154 openers (an opener reached by two routes is counted twice). Rebasing onto
main on 14 Nov 2026 brought four the first run did not see: three new writers
on Prisma's defaults, now on the constant, and the #4919 group-invoice email
fence, which moved to `xero-group-settlement-invoice-email.ts` with its own
options and is now the fourth exception.

| Before the follow-up | Openers | Now |
| --- | ---: | --- |
| Prisma defaults (`maxWait` 2 s / `timeout` 5 s) | 131 | constant |
| 10 s / 30 s written out as literals | 4 | constant |
| 10 s / 30 s under a local name | 4 | constant, or an alias of it |
| `timeout` 30 s with the default `maxWait` | 4 | constant |
| `timeout` 15 s only | 2 | constant (`privacy-retention-jobs` now READ COMMITTED, `INV-LOCK-005`) |
| The #4933 constant or its alias | 5 | unchanged |
| Deliberately different | 3 | unchanged, each with an exception comment |
| #4919's email fence (10 s / 10 s), from main | 1 | unchanged, with an exception comment |

`PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS` (`src/lib/payment-transactions.ts`) is not
on the list: no transaction it governs waits for lock(1), so it stays a separate
budget for row-lock waits.

## The four exceptions

- `src/lib/deleted-booking-modification-payment.ts` (5 s / 10 s). A Stripe
  webhook handler. Stripe's delivery timeout caps it; 30 s here would trade a lost
  row for a lost delivery.
- `src/app/api/bookings/[id]/waitlist-confirm/route.ts` (5 s / 10 s, two
  attempts). The compensating release of a member's waitlist offer runs in a
  bounded retry loop the member waits on; two attempts on the shared budget would
  hold the request for a minute.
- `src/lib/booking-ledger-back-post.ts` (30 s / 120 s). An operator-run back-post
  of a whole booking's history does more work under the key than any request, and
  nobody waits on it.
- `src/lib/xero-group-settlement-invoice-email.ts` (10 s / 10 s,
  `XERO_EMAIL_FENCE_TRANSACTION_OPTIONS`). The one Xero call held inside lock(1)
  is bounded by its own deadline, and the timeout is sized to it, so a slow
  answer defers the email rather than outliving the transaction (#4919).

## How contention is answered

- **Interactive routes** map P2028 / P2034 through `transactionContendedResponse`
  (`src/lib/transaction-contended-response.ts`), which decides with
  `isTransactionContention` and answers 503 with `Retry-After: 2`. A one-step
  operation says nothing was saved. A multi-step operation, where an earlier step
  may already have committed, asks the user to check the current status before
  retrying. Booking create keeps its #4933 wording and code.
- **Services that caught every error** now rethrow contention so the route can
  answer it, instead of reporting it as a refusal: `waitlist.ts`,
  `waitlist-cross-lodge.ts`, `admin-member-detail-service.ts` and
  `admin-roster-service.ts` (all under `src/lib/`).
- **Bed-allocation routes** use the same response through their shared
  `admin-bed-allocation-routes.ts` mapper. Range assignment keeps its existing
  single retry; an exhausted P2034 retry reaches the mapper instead of becoming
  a 409 refusal. P2002 bed-night collisions keep their 409 answer.
- **Recovery answers are preserved.** Where a payment was already captured, or an
  earlier step already committed, the route's existing recovery response wins
  over the 503.
- **Crons, webhooks and outbox workers** do not answer 503. They rethrow and keep
  the retry behaviour their scheduler or provider already gives them.

## Limits

- GitHub was not reachable from the sandbox that ran this audit, so the issue
  the brief asked for was not filed and recent pull requests touching these
  writers were not inspected there.
- Lock keys, lock order, hold times and `connection_limit` are unchanged. The
  pool trade-off of the wider budget is in the guide section linked above.

## Every opener

`Site` is the INV-LOCK-003 site name. `Reached through` lists the named functions
between the site and the opener, nearest first; `direct` means the site is inside
the opener's callback.

| File (under `src/`) | Opener | Site | Reached through | Before | Now |
| --- | --- | --- | --- | --- | --- |
| `app/api/admin/bookings/[id]/confirm-pending-guests/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/admin/bookings/[id]/confirm-pending-guests/route.ts` | \$transaction | `POST#2` | direct | defaults | budget |
| `app/api/admin/bookings/[id]/confirm-pending-guests/route.ts` | \$transaction | `POST#3` | direct | defaults | budget |
| `app/api/admin/bookings/[id]/exclusive-hold/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/admin/bookings/[id]/force-confirm/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/admin/bookings/[id]/return-to-waitlist/route.ts` | \$transaction | `POST#1` | direct | 10 s / 30 s, named copy | budget |
| `app/api/admin/bookings/[id]/review/route.ts` | \$transaction | `loadPendingReviewUnderEligibilityLocks#1` | `loadPendingReviewUnderEligibilityLocks` | defaults | budget |
| `app/api/admin/bookings/[id]/review/route.ts` | \$transaction | `loadPendingReviewUnderEligibilityLocks#1` | `loadPendingReviewUnderEligibilityLocks` | defaults | budget |
| `app/api/admin/deletion-requests/[id]/route.ts` | \$transaction | `acquireFuturePartnerSharedAllocationLocks#1` | `acquireFuturePartnerSharedAllocationLocks` | defaults | budget |
| `app/api/admin/hut-leaders/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/admin/members/bulk-update/route.ts` | \$transaction | `acquireFuturePartnerSharedAllocationLocks#1` | `acquireFuturePartnerSharedAllocationLocks` | defaults | budget |
| `app/api/admin/refund-requests/[id]/route.ts` | \$transaction | `PUT#1` | direct | defaults | budget |
| `app/api/admin/refund-requests/[id]/route.ts` | \$transaction | `PUT#2` | direct | defaults | budget |
| `app/api/bookings/[id]/confirm-draft/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/bookings/[id]/guests/[guestId]/route.ts` | \$transaction | `removeBookingGuestInTransaction#1` | `removeBookingGuestInTransaction` | defaults | budget |
| `app/api/bookings/[id]/guests/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/bookings/[id]/waitlist-confirm/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/bookings/[id]/waitlist-confirm/route.ts` | \$transaction | `POST#2` | direct | 5 s / 10 s, named | exception |
| `app/api/lodge/guests/[date]/depart/route.ts` | \$transaction | `PUT#1` | direct | defaults | budget |
| `app/api/lodge/roster/[date]/confirm/route.ts` | \$transaction | `lockRosterEligibilityMutation#1` | `lockRosterEligibilityMutation` | defaults | budget |
| `app/api/payments/charge-saved-method/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/payments/charge-saved-method/route.ts` | \$transaction | `POST#2` | direct | defaults | budget |
| `app/api/payments/create-payment-intent/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `app/api/payments/switch-to-internet-banking/route.ts` | \$transaction | `POST#1` | direct | defaults | budget |
| `lib/additional-ask-queue-transaction.ts` | \$transaction | `lockAdditionalAskQueue#1` | `lockAdditionalAskQueue` | 10 s / 30 s, named copy | alias |
| `lib/additional-ask-reissue.ts` | \$transaction | `lockAdditionalAskQueue#1` | `lockAdditionalAskQueue` | 10 s / 30 s, named copy | alias |
| `lib/additional-payment-withdraw.ts` | \$transaction | `withdrawAdditionalPaymentAsk#1` | direct | 10 s / 30 s literal | budget |
| `lib/admin-member-detail-service.ts` | \$transaction | `acquireFuturePartnerSharedAllocationLocks#1` | `acquireFuturePartnerSharedAllocationLocks` | defaults | budget |
| `lib/admin-roster-service.ts` | \$transaction | `lockRosterEligibilityMutation#1` | `lockRosterEligibilityMutation` | defaults | budget |
| `lib/admin-roster-service.ts` | \$transaction | `lockRosterEligibilityMutation#1` | `lockRosterEligibilityMutation` | defaults | budget |
| `lib/admin-roster-service.ts` | \$transaction | `lockRosterEligibilityMutation#1` | `lockRosterEligibilityMutation` | defaults | budget |
| `lib/admin-roster-service.ts` | \$transaction | `lockRosterEligibilityMutation#1` | `lockRosterEligibilityMutation` | defaults | budget |
| `lib/admin-roster-service.ts` | \$transaction | `lockRosterEligibilityMutation#1` | `lockRosterEligibilityMutation` | defaults | budget |
| `lib/bank-refund-void-follow-up.ts` | \$transaction | `lockAndClassify#1` | `lockAndClassify` | timeout 30 s only (maxWait default) | budget |
| `lib/bank-refund-void-follow-up.ts` | \$transaction | `lockAndClassify#1` | `lockAndClassify` | timeout 30 s only (maxWait default) | budget |
| `lib/bank-refund-void-follow-up.ts` | \$transaction | `lockAndClassify#1` | `lockAndClassify` | defaults | budget |
| `lib/bed-allocation-approval.ts` | \$transaction | `approveBedAllocations#1` | direct | defaults | budget |
| `lib/bed-allocation-auto-allocate.ts` | \$transaction | `runAutoBedAllocation#1` | `writeUnderLocks` | defaults | budget |
| `lib/bed-allocation-beds.ts` | \$transaction | `updateBedAllocationBed#1` | direct | defaults | budget |
| `lib/bed-allocation-beds.ts` | \$transaction | `deleteBedAllocationBed#1` | direct | defaults | budget |
| `lib/bed-allocation-lifecycle.ts` | \$transaction | `reconcileBedAllocationsForBooking#1` | `runLocked` | defaults | budget |
| `lib/bed-allocation-manual-writes.ts` | \$transaction | `manuallyAllocateBed#1` | direct | defaults | budget |
| `lib/bed-allocation-manual-writes.ts` | \$transaction | `moveBedAllocationsSameDate#1` | direct | defaults | budget |
| `lib/bed-allocation-manual-writes.ts` | \$transaction | `manuallyAllocateBedForNights#1` | direct | defaults | budget |
| `lib/bed-allocation-manual-writes.ts` | \$transaction | `deleteBedAllocation#1` | direct | defaults | budget |
| `lib/bed-allocation-move.ts` | \$transaction | `applyBedAllocationMove#1` | direct | 10 s / 30 s literal | budget |
| `lib/bed-allocation-range-assign.ts` | \$transaction | `assignBedRange#1` | direct | shared budget | budget |
| `lib/bed-allocation-removal.ts` | \$transaction | `applyBedAllocationRemoval#1` | direct | defaults | budget |
| `lib/bed-allocation-rooms.ts` | \$transaction | `updateBedAllocationRoom#1` | direct | defaults | budget |
| `lib/bed-allocation-rooms.ts` | \$transaction | `deleteBedAllocationRoom#1` | direct | defaults | budget |
| `lib/booking-batch-modification-service.ts` | withOptionalTransaction | `modifyBookingBatch#1` | direct | defaults | budget |
| `lib/booking-cancel.ts` | \$transaction | `cancelLinkedProvisionalChildBookings#1` | direct | defaults | budget |
| `lib/booking-cancel.ts` | \$transaction | `performBookingCancellation#1` | direct | defaults | budget |
| `lib/booking-cancel.ts` | \$transaction | `performBookingCancellation#2` | direct | defaults | budget |
| `lib/booking-cancel.ts` | \$transaction | `performBookingCancellation#3` | direct | defaults | budget |
| `lib/booking-cancel.ts` | \$transaction | `performBookingCancellation#4` | direct | defaults | budget |
| `lib/booking-change-request-execution.ts` | \$transaction | `approveAndExecuteLockedPeriodChangeRequest#1` | direct | defaults | budget |
| `lib/booking-create.ts` | \$transaction | `createDraftBooking#1` | direct | shared budget | budget |
| `lib/booking-create.ts` | withOptionalTransaction | `createConfirmedBooking#1` | direct | shared budget | budget |
| `lib/booking-date-modification-service.ts` | \$transaction | `modifyBookingDates#1` | direct | defaults | budget |
| `lib/booking-date-modification-service.ts` | \$transaction | `adminShiftBookingDates#1` | direct | defaults | budget |
| `lib/booking-delete.ts` | \$transaction | `hardDeleteDraftBooking#1` | direct | defaults | budget |
| `lib/booking-delete.ts` | \$transaction | `softDeleteCancelledBookingInTransaction#1` | direct | defaults | budget |
| `lib/booking-exception-execution.ts` | \$transaction | `acquireGlobalBookingLock#1` | `acquireGlobalBookingLock` | defaults | budget |
| `lib/booking-exception-execution.ts` | \$transaction | `acquireGlobalBookingLock#1` | `acquireGlobalBookingLock` | defaults | budget |
| `lib/booking-exception-request-service.ts` | \$transaction | `acquireGlobalBookingLock#1` | `acquireGlobalBookingLock` | defaults | budget |
| `lib/booking-exception-request-service.ts` | \$transaction | `acquireGlobalBookingLock#1` | `acquireGlobalBookingLock` | defaults | budget |
| `lib/booking-ledger-back-post.ts` | \$transaction | `lockBookingForBackPost#1` | `lockBookingForBackPost` → `backPostBooking` | 30 s / 120 s | exception |
| `lib/booking-linked-date-move-service.ts` | \$transaction | `runLinkedDateMove#1` | direct | shared budget | alias |
| `lib/booking-request-corrections.ts` | \$transaction | `correctBookingRequest#1` | direct | defaults | budget |
| `lib/booking-request-quotes.ts` | \$transaction | `respondToBookingRequestQuote#1` | direct | defaults | budget |
| `lib/booking-request-quotes.ts` | \$transaction | `respondToBookingRequestQuote#2` | direct | defaults | budget |
| `lib/booking-request-quotes.ts` | \$transaction | `respondToBookingRequestQuote#3` | direct | defaults | budget |
| `lib/booking-request-quotes.ts` | \$transaction | `holdBookingRequestSlots#1` | direct | defaults | budget |
| `lib/booking-request-quotes.ts` | \$transaction | `holdBookingRequestSlots#2` | direct | defaults | budget |
| `lib/booking-request.ts` | \$transaction | `approveBookingRequest#1` | direct | defaults | budget |
| `lib/card-intent-attach.ts` | \$transaction | `attachMintedCardIntent#1` | direct | defaults | budget |
| `lib/card-refund-dead-row-actions.ts` | \$transaction | `lockDeadCardRefundRow#1` | `lockDeadCardRefundRow` | defaults | budget |
| `lib/card-refund-dead-row-actions.ts` | \$transaction | `lockDeadCardRefundRow#1` | `lockDeadCardRefundRow` | defaults | budget |
| `lib/card-refund-group-paid-another-way.ts` | \$transaction | `lockDeadCardRefundRow#1` | `lockDeadCardRefundRow` | defaults (from main) | budget |
| `lib/card-refund-group-try-again.ts` | \$transaction | `lockDeadCardRefundRow#1` | `lockDeadCardRefundRow` | defaults (from main) | budget |
| `lib/card-refund-paid-another-way.ts` | \$transaction | `lockDeadCardRefundRow#1` | `lockDeadCardRefundRow` | defaults | budget |
| `lib/credit-release-ask-close.ts` | \$transaction | `closeCreditReleaseAsksPaidInXero#1` | direct | 10 s / 30 s literal | budget |
| `lib/credit-release-ask-close.ts` | \$transaction | `recordReleasePaidInXeroCash#1` | direct | 10 s / 30 s literal | budget |
| `lib/cron-complete-bookings.ts` | \$transaction | `completeBookings#1` | direct | defaults | budget |
| `lib/cron-confirm-pending.ts` | \$transaction | `resolveHoldWindowUnderLock#1` | direct | defaults | budget |
| `lib/cron-confirm-pending.ts` | \$transaction | `releaseChargeClaim#1` | direct | defaults | budget |
| `lib/cron-confirm-pending.ts` | \$transaction | `confirmPendingBookings#1` | direct | defaults | budget |
| `lib/cron-group-settlement-reaper.ts` | \$transaction | `releaseSettlementChildren#1` | direct | defaults | budget |
| `lib/cron-group-settlement-reaper.ts` | \$transaction | `cancelReapedChildren#1` | direct | defaults | budget |
| `lib/cron-quote-expiry-reminders.ts` | \$transaction | `releaseExpiredQuoteHolds#1` | direct | defaults | budget |
| `lib/cron-quote-expiry-reminders.ts` | \$transaction | `releaseStaleModificationHolds#1` | direct | defaults | budget |
| `lib/cron-waitlist.ts` | \$transaction | `processWaitlistCronOnce#1` | direct | defaults | budget |
| `lib/deleted-booking-modification-payment.ts` | \$transaction | `raiseDeletedBookingModificationRefundTask#1` | direct | defaults | budget |
| `lib/deleted-booking-modification-payment.ts` | \$transaction | `recordAutomaticCancelledBookingRefundTask#1` | direct | 5 s / 10 s | exception |
| `lib/edit-review-cleanup-headline.ts` | \$transaction | `editReviewHeadlineRebase#1` | direct | defaults (from main) | budget |
| `lib/group-booking.ts` | \$transaction | `setGroupBookingJoinStatus#1` | direct | defaults | budget |
| `lib/group-cancel.ts` | \$transaction | `settleGroupBookingOnOrganiserCancel#1` | direct | defaults | budget |
| `lib/group-cancel.ts` | \$transaction | `settleGroupBookingOnOrganiserCancel#2` | direct | defaults | budget |
| `lib/group-cancel.ts` | \$transaction | `settleGroupBookingOnOrganiserCancel#3` | direct | defaults | budget |
| `lib/group-cancel.ts` | \$transaction | `settleGroupBookingOnOrganiserCancel#4` | direct | defaults | budget |
| `lib/group-late-joiner.ts` | \$transaction | `releaseJoinersLeftBehindPaidSettlements#1` | direct | defaults | budget |
| `lib/group-organiser-hand-back.ts` | \$transaction | `updateGroupHandBackAlertRecord#1` | direct | defaults | budget |
| `lib/group-settlement.ts` | \$transaction | `createGroupSettlementIntent#1` | direct | defaults | budget |
| `lib/group-settlement.ts` | \$transaction | `createGroupSettlementInvoice#1` | direct | defaults | budget |
| `lib/group-settlement.ts` | \$transaction | `commitChildrenToConfirmed#1` | direct | defaults | budget |
| `lib/group-settlement.ts` | \$transaction | `settleConfirmedChildrenAndNotify#1` | direct | shared budget | budget |
| `lib/group-settlement.ts` | \$transaction | `markGroupSettlementIntentRefunded#1` | direct | defaults | budget |
| `lib/group-settlement.ts` | \$transaction | `markGroupSettlementIntentFailed#1` | direct | defaults | budget |
| `lib/hut-leader-assignment-service.ts` | \$transaction | `applyHutLeaderAssignmentEditUnderLocks#1` | direct | defaults | budget |
| `lib/internet-banking-payment-cron.ts` | \$transaction | `releaseOneHold#1` | direct | timeout 15 s only | budget |
| `lib/late-capture-refund-hold.ts` | \$transaction | `holdLateCaptureForTreasurerIfRequired#1` | direct | defaults | budget |
| `lib/manual-refund-task-reopen.ts` | \$transaction | `reopenManualRefundTask#1` | direct | defaults | budget |
| `lib/manual-refund-task-resolution.ts` | \$transaction | `resolveManualRefundTask#1` | direct | defaults | budget |
| `lib/member-guest-consent-service.ts` | \$transaction | `respondToMemberGuestConsent#1` | direct | defaults | budget |
| `lib/member-guest-consent-service.ts` | \$transaction | `expireMemberGuestConsent#1` | direct | defaults | budget |
| `lib/member-guest-consent-service.ts` | \$transaction | `removeBookingGuestInTransaction#1` | `removeBookingGuestInTransaction` → `removeClaimedConsentGuest` | defaults | budget |
| `lib/member-guest-consent-service.ts` | \$transaction | `removeBookingGuestInTransaction#1` | `removeBookingGuestInTransaction` → `removeClaimedConsentGuest` | defaults | budget |
| `lib/member-partner-link.ts` | \$transaction | `acquireFuturePartnerSharedAllocationLocks#1` | `acquireFuturePartnerSharedAllocationLocks` | defaults | budget |
| `lib/member-partner-link.ts` | \$transaction | `acquireFuturePartnerSharedAllocationLocks#1` | `acquireFuturePartnerSharedAllocationLocks` | defaults | budget |
| `lib/organiser-child-refund-executor.ts` | \$transaction | `processOrganiserChildRefundOperation#1` | direct | defaults | budget |
| `lib/organiser-child-refund-executor.ts` | \$transaction | `reconcilePendingOrganiserChildRefunds#1` | direct | defaults | budget |
| `lib/organiser-child-refund.ts` | \$transaction | `planOrganiserCancelChildRefunds#1` | direct | defaults | budget |
| `lib/organiser-extra-raced-cash.ts` | \$transaction | `reserveOrganiserExtraRacedCash#1` | direct | defaults | budget |
| `lib/organiser-extra-receipt.ts` | \$transaction | `syncOrganiserExtraInvoiceCash#1` | direct | defaults | budget |
| `lib/payment-reconciliation.ts` | \$transaction | `reverseManualBookingPayment#1` | direct | defaults | budget |
| `lib/payment-reconciliation.ts` | \$transaction | `settleBookingPaymentInTransaction#1` | `settleBookingPaymentInTransaction` → `settleAndPostBookingReceipts` | defaults | budget |
| `lib/payment-reconciliation.ts` | \$transaction | `settleBookingPaymentInTransaction#1` | `settleBookingPaymentInTransaction` → `settleAndPostBookingReceipts` | defaults | budget |
| `lib/payment-recovery.ts` | \$transaction | `lockAdditionalAskQueue#1` | `lockAdditionalAskQueue` | 10 s / 30 s, named copy | alias |
| `lib/privacy-retention-jobs.ts` | \$transaction | `anonymiseFormerMember#1` | `anonymiseFormerMember` | timeout 15 s only | budget |
| `lib/requested-room-write.ts` | \$transaction | `writeRequestedRoom#1` | direct | defaults | budget |
| `lib/school-booking-request.ts` | \$transaction | `approveSchoolBookingRequest#1` | direct | defaults | budget |
| `lib/school-booking-request.ts` | \$transaction | `approveMemberWholeLodgeRequest#1` | direct | defaults | budget |
| `lib/school-pending-adult-resolution.ts` | \$transaction | `resolveAcceptedSchoolPendingAdults#1` | direct | defaults | budget |
| `lib/seasonal-membership-assignments.ts` | \$transaction | `acquireFuturePartnerSharedAllocationLocks#1` | `acquireFuturePartnerSharedAllocationLocks` | defaults | budget |
| `lib/seasonal-membership-assignments.ts` | \$transaction | `acquireFuturePartnerSharedAllocationLocks#1` | `acquireFuturePartnerSharedAllocationLocks` | defaults | budget |
| `lib/waitlist-cross-lodge.ts` | \$transaction | `confirmCrossLodgeWaitlistOffer#1` | direct | defaults | budget |
| `lib/waitlist-cross-lodge.ts` | \$transaction | `confirmCrossLodgeWaitlistOffer#2` | direct | defaults | budget |
| `lib/waitlist-cross-lodge.ts` | \$transaction | `confirmCrossLodgeWaitlistOffer#3` | direct | defaults | budget |
| `lib/waitlist-cross-lodge.ts` | \$transaction | `confirmCrossLodgeWaitlistOffer#4` | direct | defaults | budget |
| `lib/waitlist-cross-lodge.ts` | \$transaction | `confirmCrossLodgeWaitlistOffer#5` | direct | defaults | budget |
| `lib/waitlist-cross-lodge.ts` | \$transaction | `confirmCrossLodgeWaitlistOffer#6` | direct | defaults | budget |
| `lib/waitlist.ts` | \$transaction | `processWaitlistForDates#1` | direct | defaults | budget |
| `lib/waitlist.ts` | \$transaction | `revertSameLodgeOfferToWaitlisted#1` | direct | defaults | budget |
| `lib/waitlist.ts` | \$transaction | `confirmWaitlistOffer#1` | direct | defaults | budget |
| `lib/waitlist.ts` | \$transaction | `expireStaleOffers#1` | direct | defaults | budget |
| `lib/xero-applied-credit-spent-outside-app.ts` | \$transaction | `convergeCreditNoteSpentOutsideApp#1` | direct | defaults | budget |
| `lib/xero-group-settlement-invoice-lines.ts` | \$transaction | `releaseUninvoiceableGroupSettlement#1` | direct | defaults | budget |
| `lib/xero-group-settlement-invoices.ts` | \$transaction | `createXeroInvoiceForGroupSettlement#1` | direct | defaults | budget |
| `lib/xero-group-settlement-invoice-email.ts` | \$transaction | `runGroupInvoiceEmailFence#1` | direct | 10 s / 10 s (#4919, from main) | exception |
| `lib/xero-group-settlement-invoices.ts` | \$transaction | `bindCreatedGroupSettlementInvoice#1` | `bindCreatedGroupSettlementInvoice` | defaults | budget |
| `lib/xero-inbound/invoice-paid-effects.ts` | \$transaction | `syncInternetBankingPaymentsForPaidInvoice#1` | direct | defaults | budget |
| `lib/xero-resolve-refund-note.ts` | \$transaction | `claimResolveRecordingRefundNote#1` | direct | timeout 30 s only (maxWait default) | budget |
| `lib/xero-resolve-refund-note.ts` | \$transaction | `withdrawResolveRecordingRefundNote#1` | direct | timeout 30 s only (maxWait default) | budget |