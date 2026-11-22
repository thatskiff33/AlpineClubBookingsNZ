# Paid From Cash — Inventory

**Audience:** developer, agent. Index: [`docs/README.md`](../README.md) ·
[blueprint](paid-from-cash.md#3-inventory).

Every place in the app that reads a booking's status where "paid" or
"settled" could be meant, one row each, with the class of decision it makes
and when it moves to the cash-cover reader. The [blueprint](paid-from-cash.md)
holds the reader contract and the stage order; this page is its evidence.

## 1. How to read a row

- **Site** is a file under `src/` and the function, constant or branch in it.
  A file has more than one row when it makes more than one kind of decision.
- **Decides** is what the app does with the status there.
- **Moves** says when the site stops reading status for money:
  - **stage N** — a display stage of this programme
    ([blueprint §4](paid-from-cash.md#4-stages)), one PR each;
  - **own plan** — needs its own plan in #4069 before any code;
  - **M15** — moves with #4527's refund, cancel and ask cohort;
  - **no move** — stays, for the reason the row gives.
- **G1** to **G13** after "own plan" or "M15" name the gated cohort the row
  moves with ([blueprint §4.2](paid-from-cash.md#42-gated-cohorts)).

A site is never both "own plan" and "M15".

## 2. How it was built

The base is `main` at `da2c858ec`. A TypeScript syntax-tree pass read all
3,355 production `.ts` and `.tsx` files under `src/` (tests, mocks, generated
code and test support left out) and recorded:

| Recorded | Occurrences | Files |
| --- | --- | --- |
| The string `PAID`, `COMPLETED`, `CONFIRMED` or `PAYMENT_PENDING` | 270 | 124 |
| The same four names read off an enum whose name ends in `Status` | 218 | 61 |
| The same four names as an object key (label and tone maps) | 27 | 8 |
| A core status helper (list 1 below) | 97 | 62 |
| A helper that wraps one (list 2 below) | 183 | 76 |

That is 243 files. Each occurrence was then read in its source, with the
condition around it, and given one of the classes below. Occurrences that
make the same decision in the same file share a row; the pass reads the
syntax tree, so a condition split over several lines is one occurrence, not
several.

- **List 1:** `isPaidLikeBookingStatus`, `PAID_LIKE_BOOKING_STATUSES`,
  `isSettledBookingStatus`, `PAYMENT_OWED_BOOKING_STATUSES`,
  `isPaymentOwedBookingStatus`, `isBookingOwnAmountOwed`,
  `IMMEDIATE_PAYMENT_BOOKING_STATUSES`, `readBookingAmountOwed`,
  `bookingAmountOwedCents`, `bookingOutstandingCardCents`,
  `hasOutstandingCollectionEvidence`, `isAdditionalPaymentOwed`,
  `bookingOutstandingCents`, `getPaymentDisplayStatus`.
- **List 2:** the lists and helpers built on list 1 or on the four names —
  `OPERATIONAL_STAY_BOOKING_STATUSES`, `FINANCE_FORWARD_*`,
  `ADDITIONAL_OWED_BOOKING_STATUSES`, `isBookingFullyPaidForGuestNameEdits`,
  `isSwitchableToInternetBanking`, `canCreateImmediatePaymentIntent`,
  `PAYMENT_LINK_PAYABLE_BOOKING_STATUSES`, `hasIssuedPrimaryXeroInvoice`,
  `canAskCardForIncrease`, `lateNoticeChangeFeeApplies`,
  `bookingStatusLabel`, `getBookingManualPaymentState`,
  `getInvoiceSyncEligibility`, `resolveBookingNarrative`,
  `getDashboardPaymentOwedCents` and the others named in the rows. Following
  these is how indirect callers were reached.

### Limits of the pass

- It cannot see a status held in a variable of another name, or built at run
  time. Three sites it missed were found by reading callers and are marked †.
- Helpers that already read money rather than status — `hasCapturedPayment`,
  `organiserSettled`, `paidByOrganiser`, `getNetCollectedCashParts`,
  `bookingLedgerBalance` — are not listed as sites. They appear only where a
  row says a decision is "already cash-gated".
- #4069 §5 quotes 255 occurrences in 128 files for an older base (`ee8053d`)
  and calls them candidate counts. These counts are for `da2c858ec` and are
  not comparable line for line.

## 3. Summary

317 rows over 245 files: the 243 the pass found and 2 it did not. The three
† sites sit in three files, one of which the pass had already found for
another row.

| Class | Rows | A display stage | Own plan | M15 | No move |
| --- | --- | --- | --- | --- | --- |
| Display, notification, report | 50 | 41 | 1 | 3 | 5 |
| Eligibility | 58 | 0 | 36 | 10 | 12 |
| Replay guard or paid assertion | 17 | 0 | 6 | 3 | 8 |
| Unpaid-amount reader sizing a payment instrument | 17 | 0 | 0 | 3 | 14 |
| Financial writer | 26 | 0 | 3 | 12 | 11 |
| Diagnostic or census | 7 | 0 | 3 | 0 | 4 |
| Lifecycle read (§10) | 43 | — | — | — | 43 |
| Another domain's status (§11) | 99 | — | — | — | 99 |
| **All** | **317** | | | | |

## 4. Display, notification, report

What a member or officer is told. These are the display stages.

| Site | Decides | Moves |
| --- | --- | --- |
| `lib/booking-exception-approval.ts` — `notifyApproved` | approval email's amount owed (moved by this PR) | stage 1 |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-history.ts` — `amountOwed`, `bookingNarrative` | booking page narrative | stage 2 |
| `lib/booking-narrative.ts` — `PAYABLE_STATUSES`, `resolveBookingNarrative` | "money arrived" narrative on the booking page and pay link | stage 2 |
| `lib/payment-link-context.ts` — `amountOwed`, `narrative`, `paymentState` | public pay link's amount and narrative | stage 2 |
| `app/(authenticated)/bookings/[id]/_components/booking-payment-cards.tsx` — `BookingPaymentCards` | pay card shows | stage 3 |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-payment.ts` — `showCompletePaymentCard`, `showCreditApplied`, `changeFeeOwedCents` | pay card and breakdown show | stage 3 |
| `lib/booking-status.ts` — `PAYMENT_OWED_BOOKING_STATUSES`, `isPaymentOwedBookingStatus`, `isBookingOwnAmountOwed` | "this booking owes" from status (callers move; the list stays for lifecycle callers) | stages 3, 4, 15 |
| `app/(authenticated)/dashboard/page.tsx` — `paymentOwed` (`PAYMENT_OWED_BOOKING_STATUSES`, `loadDashboardPaymentSnapshots`) | Payment Owed card | stage 4 |
| `lib/member-dashboard.ts` — `loadDashboardPaymentSnapshots`, `getDashboardPaymentOwedCents` | Payment Owed card | stage 4 |
| `lib/booking-fresh-email-copy.ts` — `paymentDue`, `outstandingBalance` | confirmation email's due or processed line | stage 5 |
| `app/(admin)/admin/finance/payments/page.tsx` — `displayStatus` | payment label on the officer payments page | stage 6 |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-payment.ts` — `paymentDisplay` | payment label on the booking page | stage 6 |
| `lib/payment-status-display.ts` — `getPaymentDisplayStatus` | "Paid" label on the booking and payments pages | stage 6 |
| `components/group-booking/organiser-group-booking-card.tsx` — `unsettledJoiners`, `notOnInvoice`, `invoiceTotalChanged` | organiser's paid and outstanding figures | stage 7 |
| `lib/pre-arrival-reminder-email.ts` — `outstandingAdditionalAmountCents` | reminder's outstanding extra | stage 8 |
| `app/api/admin/reports/route.ts` — `outstandingAdditional` | report's outstanding additional amounts | stage 9 |
| `components/admin/booking-additional-payment-panel.tsx` — `BookingAdditionalPaymentPanel` | officer's "extra still owed" panel | stage 9 |
| `lib/admin-bookings-service.ts` — `deriveBookingOperationalState` | booking list's outstanding additional figure | stage 9 |
| `lib/finance-booking-metrics.ts` — `getAdditionalPaymentStatusKey`, `summarizePayments` | finance report's outstanding additional figures | stage 9 |
| `lib/duplicate-capture-kept-alert-drain.ts` — `judgeOwedAlert` | alert text says "closed" from status | stage 10 |
| `lib/finance-booking-metrics.ts` — `FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES`, `FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES`, `FINANCE_REALIZED_BOOKING_STATUSES`, `buildForwardMetrics`, `getStatusFilter` | committed, at-risk and realised revenue | stage 11 |
| `lib/finance-legacy-dashboard-export.ts` — `getLegacyDashboardExportStatuses`, `pipelineBucket` | export's committed and at-risk buckets | stage 11 |
| `lib/admin-bookings-service.ts` — `buildBookingWhere` | unpaid-finished-stays filter | stage 12 |
| `lib/unpaid-finished-stays.ts` — `buildUnpaidFinishedStaysStatusWhere`, `buildAdditionalOwedWhere`, `buildAdditionalOwedPaymentWhere` | officer collection queue and badge | stage 12 |
| `lib/group-late-joiner.ts` — `paymentModeForNewJoiner`, `organiserPaysForNewJoiner` † | join page tells the joiner who pays, from the settlement payment's status | stage 13 |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-messages.ts` — `isConfirmedWholeLodge` | whole-lodge unpaid wording | stage 14 |
| `app/(authenticated)/book/_hooks/use-booking-wizard.ts` — `handleSubmit` | wizard sends the member to pay | stage 15 |
| `lib/booking-history.ts` — `buildBookingHistoryItems` "Payment recorded" fallback † | history item quotes `Payment.amountCents` as paid | stage 16 |
| `app/(admin)/admin/booking-desk/waitlist/page.tsx` — force-confirm report label | status label | stage 17 |
| `app/(admin)/admin/dashboard/page.tsx` — recent bookings label | status label | stage 17 |
| `app/(admin)/admin/membership/members/[id]/_components/member-history-group.tsx` — `BookingHistoryTable` | status label | stage 17 |
| `app/(authenticated)/bookings/_components/my-bookings-list.tsx` — `BookingSummary`, `MyBookingsList` | status label | stage 17 |
| `app/(authenticated)/bookings/_components/non-member-guests-section.tsx` — `NonMemberGuestsSection` | status label | stage 17 |
| `app/(authenticated)/dashboard/page.tsx` — booking row label | status label | stage 17 |
| `components/admin-booking-calendar.tsx` — legend label | status label | stage 17 |
| `components/admin/booking-filters.tsx` — filter labels | status label | stage 17 |
| `components/booking-editor.tsx` — header label | status label | stage 17 |
| `components/group-booking/organiser-group-booking-card.tsx` — joiner row label | status label | stage 17 |
| `components/ui/status-chip.tsx` — `BOOKING_TONES`, `resolveLabel` | status chip tone and label | stage 17 |
| `lib/status-colors.ts` — `bookingStatusLabels`, `bookingStatusLabel`, `BOOKING_STATUS_TONES` | "Paid" and "Confirmed (Unpaid)" labels | stage 17 |
| `lib/admin-member-detail-service.ts` — `getAdminMemberDetail` booking aggregate | member's total spend, stay count and last stay from `PAID` and `COMPLETED` prices | stage 18 |
| `lib/xero-inbound/settle-from-cash-notice.ts` — `readCashSettlementNotice` | officer notice comparing bank cash with what the booking owes; rides the settle writer | own plan · G6 |
| `app/(authenticated)/bookings/[id]/_components/booking-outstanding-payments.tsx` — `hasEvidence` | additional-ask panel shows | M15 · G9 |
| `app/(authenticated)/bookings/[id]/_components/booking-status-section.tsx` — `additionalCollectionPending` | history shows an additional ask pending | M15 · G9 |
| `lib/superseded-additional-refund.ts` — `loadReportContext.amountOwingCents` | officer report's amount owing after a superseded additional capture | M15 · G9 |
| `app/(admin)/admin/finance/reports/_components/report-charts.tsx` — `TrendsLineChart` | status trend lines, labelled as statuses (label text: stage 17) | no move |
| `app/(admin)/admin/finance/reports/page.tsx` — `statusPieData`, `exportCSV` | status breakdown counts, labelled as statuses (label text: stage 17) | no move |
| `app/(authenticated)/bookings/[id]/_components/booking-status-banners.tsx` — `stayConfirmed` | "stay confirmed" banner: the beds, not the money | no move |
| `app/api/admin/reports/route.ts` — `statusBreakdown` | status breakdown counts, labelled as statuses | no move |
| `lib/admin-reports.ts` — `REPORT_BOOKING_STATUSES`, `trendStatusKey` | status breakdown counts, labelled as statuses | no move |

## 5. Eligibility

Whether something is allowed or shown as available. None moves in a display
stage: each changes what a person or a job may do.

| Site | Decides | Moves |
| --- | --- | --- |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-admin-tools.ts` — `manualPaymentState` | officer may mark paid or reverse | own plan · G3 |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-edit-access.ts` — `canEditNonMemberGuestNames`, `canFixNonMemberGuestName` | guest-name edits on a fully paid booking | own plan · G4 |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-payment.ts` — `canSwitchToInternetBanking` | bank switch offered | own plan · G2 |
| `app/(authenticated)/dashboard/page.tsx` — `stayingGuestBooking` | "staying now" tools, `PAID` only | own plan · G1 |
| `app/(authenticated)/layout.tsx` — `stayingBooking` | "staying now" navigation, `PAID` only | own plan · G1 |
| `app/api/admin/bookings/search/route.ts` — `getInvoiceSyncEligibility` | only a `PAID` booking may be synced to Xero | own plan · G5 |
| `app/api/admin/deletion-requests/[id]/route.ts` — `futurePaidBookings` | future `PAID` stays block account deletion; a held unpaid one does not | own plan · G1 |
| `app/api/admin/reports/route.ts` — `occupancyBookings` | occupancy counts operational stays (`PAID`, `COMPLETED`) | own plan · G1 |
| `app/api/admin/xero/force-sync/route.ts` — `POST` | only a `PAID` booking may be force-synced | own plan · G5 |
| `app/api/bookings/[id]/confirm-payment/route.ts` — `canCreateImmediatePaymentIntent` gate | card payment allowed | own plan · G2 |
| `app/api/lodge/guests/[date]/route.ts` — `bookings.where` | lodge guest list shows operational stays | own plan · G1 |
| `app/api/lodge/week/route.ts` — `bookings.where` | lodge week view shows operational stays | own plan · G1 |
| `app/api/payments/create-payment-intent/route.ts` — payable-status gate, `payableStatuses`, `canCreateImmediatePaymentIntent` | card intent allowed | own plan · G2 |
| `app/api/payments/switch-to-internet-banking/route.ts` — `wholeLodgeConfirmed`, `isSwitchableToInternetBanking`, `canCreateImmediatePaymentIntent` | bank switch allowed | own plan · G2 |
| `lib/admin-occupancy.ts` — `getAdminOccupancyMonth` | occupancy shows operational stays | own plan · G1 |
| `lib/booking-batch-modification-service.ts` — `paidNameTypoFix` | guest-name edits on a fully paid booking | own plan · G4 |
| `lib/booking-modify-plan.ts` — `fullyPaidLockActive` | guest-name edits on a fully paid booking | own plan · G4 |
| `lib/booking-modify-validation.ts` — `FULLY_PAID_BOOKING_STATUSES`, `isBookingFullyPaidForGuestNameEdits` | guest-name edits on a fully paid booking | own plan · G4 |
| `lib/booking-modify.ts` — re-export of `isBookingFullyPaidForGuestNameEdits` | as above | own plan · G4 |
| `lib/booking-payment-flow.ts` — `canCreateImmediatePaymentIntent` | card payment allowed | own plan · G2 |
| `lib/booking-payment-flow.ts` — `isSwitchableToInternetBanking` | bank switch allowed | own plan · G2 |
| `lib/booking-status.ts` — `IMMEDIATE_PAYMENT_BOOKING_STATUSES` | card payment allowed | own plan · G2 |
| `lib/booking-status.ts` — `OPERATIONAL_STAY_BOOKING_STATUSES` | who is treated as staying: `PAID` and `COMPLETED` only | own plan · G1 |
| `lib/cron-checkin-reminders.ts` — `sendCheckinReminders` | check-in reminders go to operational stays | own plan · G1 |
| `lib/cron-confirm-pending.ts` — `parentSettledWithoutCard` | a guest portion is not card-chased when its parent is on Internet Banking or reads `CONFIRMED`, `PAID` or `COMPLETED` | own plan · G7 |
| `lib/hut-leader-stayed-nights.ts` — `hutLeaderStayStatusWhere` | hut-leader duty counts operational stays | own plan · G1 |
| `lib/late-notice-change-fee.ts` — `lateNoticeChangeFeeApplies` | a late-notice fee applies (input to a money writer) | own plan · G7 |
| `lib/lodge-date-scoping.ts` — `LODGE_VISIBLE_BOOKING_STATUSES` | kiosk arrive and depart lookups see operational stays | own plan · G1 |
| `lib/lodge-display-state.ts` — `buildDisplayState` | lodge display shows operational stays | own plan · G1 |
| `lib/manual-booking-payment-state.ts` — `PAYABLE_STATUSES`, `getBookingManualPaymentState` | officer may mark paid or reverse | own plan · G3 |
| `lib/member-lodge-roster.ts` — `buildMemberLodgeRoster` | member's lodge roster shows operational stays | own plan · G1 |
| `lib/payment-link-intent.ts` — `payableStatuses` | link payable | own plan · G2 |
| `lib/payment-link.ts` — `PAYMENT_LINK_PAYABLE_BOOKING_STATUSES`, `isPayableByLink` | link payable | own plan · G2 |
| `lib/payment-reconciliation.ts` — `prepareManualSettlement`, `reverseManualBookingPayment` | officer may mark paid or reverse | own plan · G3 |
| `lib/roster-eligibility.ts` — `getOperationalRosterGuestsForDate` | roster draws from operational stays | own plan · G1 |
| `lib/roster-status.ts` — `getRosterMonthStatus`, `countRosterDaysNeedingChores` | roster needs follow operational stays | own plan · G1 |
| `lib/additional-ask-reduction.ts` — `readUnpaidPriceAsk`, `unpaidChain` | an unpaid additional ask can be reduced | M15 · G9 |
| `lib/additional-payment-chase.ts` — `ADDITIONAL_OWED_BOOKING_STATUSES`, `ADDITIONAL_PAYABLE_BOOKING_STATUSES`, `isAdditionalPaymentOwed` | an additional ask is still owed (display callers: stage 9) | M15 · G9 |
| `lib/additional-payment-resend-service.ts` — `resendAdditionalPaymentEmail`, `explainLostClaim` | an additional-ask email may be resent | M15 · G9 |
| `lib/additional-payment-withdraw.ts` — `withdrawAdditionalPaymentAsk` | an additional ask may be withdrawn | M15 · G9 |
| `lib/booking-guest-acceptance-reprice.ts` — `priceSettled` | a raise after guest acceptance is skipped | M15 · G13 |
| `lib/booking-guest-acceptance-return-route.ts` — `fullReductionReturnRoute` | how a full reduction is returned | M15 · G13 |
| `lib/booking-modify-credit-give-back.ts` — `isPaid` | credit is given back or the amount owed is lowered | M15 · G13 |
| `lib/cron-additional-payment-reminders.ts` — `sendAdditionalPaymentReminders` | a reminder for an additional ask is sent | M15 · G9 |
| `lib/group-cancel.ts` — `planChildRefund` | a `PAID` child with a captured payment is refunded on organiser cancel | M15 · G11 |
| `lib/organiser-child-refund.ts` — `planOrganiserCancelChildRefunds` | a `PAID` card child with a captured payment is refunded | M15 · G11 |
| `app/api/bookings/[id]/guests/route.ts` — `hasSucceededPayment`, `hasIssuedXeroInvoice` | already cash-gated: status and a captured payment or an issued invoice | no move |
| `lib/booking-batch-modification-service.ts` — `feeOnPrimaryInvoice` | already gated on an issued invoice | no move |
| `lib/booking-guest-acceptance-reprice.ts` — `hasIssuedXeroInvoice` | already gated on an issued invoice | no move |
| `lib/booking-modify-settlement-options.ts` — `editReductionDisputeHold`, `hasSettledPayment` | already cash-gated: status and a captured payment | no move |
| `lib/booking-modify-settlement.ts` — `inSettledStatus`, `organiserChildChargeRefusal`, `zeroDollarCardIncrease`, `hasIssuedXeroInvoice` | already cash-gated: status and a captured payment or an issued invoice | no move |
| `lib/booking-payment-flow.ts` — `isUnpaidConfirmedWholeLodge`, `buildUnpaidConfirmedWholeLodgeWhere` | already cash-gated: `CONFIRMED` whole-lodge with no captured row | no move |
| `lib/booking-payment-state.ts` — `hasIssuedPrimaryXeroInvoice`, `canAskCardForIncrease`, `canAskCardForReviewCharge`, `editReviewSettlementPayment` | already cash-gated: status and a captured payment or an issued invoice | no move |
| `lib/edit-financial-review-charge-sync.ts` — `syncEditReviewChargeRequestUnderClaim` | already cash-gated (`canAskCardForReviewCharge`) | no move |
| `lib/edit-financial-review-charge.ts` — `chooseEditReviewChargeRoute` | already cash-gated (`canAskCardForReviewCharge`) | no move |
| `lib/edit-financial-review-still-owed.ts` — `previewEditReviewStillOwed` | already gated on an issued invoice | no move |
| `lib/edit-review-cleanup-headline.ts` — `editReviewHeadlineRebase` | already gated on an issued invoice | no move |
| `lib/xero-period-lock-guard.ts` — `checkInNeedingLockDateCheck` | already gated on an issued invoice | no move |

## 6. Replay guard or paid assertion

Code that treats a paid-looking status as proof that a payment already
landed.

| Site | Decides | Moves |
| --- | --- | --- |
| `app/api/bookings/[id]/confirm-payment/route.ts` — `POST` already-paid branch | skips to the invoice queue when the booking reads `PAID` | own plan · G2 |
| `lib/payment-link-context.ts` — used-link burn | a link on a paid-status booking is marked used | own plan · G2 |
| `lib/payment-link-intent.ts` — `isPaidLikeStatus` refusal | a link on a paid-status booking takes no payment | own plan · G2 |
| `lib/payment-link.ts` — `isPaidLikeStatus`, `resolvePaymentLink` | a used link is still valid only while the booking is unpaid by status | own plan · G2 |
| `lib/xero-inbound/invoice-paid-effects.ts` — `syncInternetBankingPaymentsForPaidInvoice` already-paid branches | the paid arm is skipped when the booking reads paid | own plan · G6 |
| `lib/xero-inbound/settlement-conflicts.ts` — `findSecondInstrumentSettlement` | a second payment instrument is flagged | own plan · G6 |
| `lib/duplicate-capture-guard.ts` — `judgeCaptureOnPaidBooking` † | judges a capture on a booking its caller read as `PAID` or `COMPLETED` | M15 · G12 |
| `lib/payment-reconciliation.ts` — `settleBookingPaymentInTransaction` paid-like branch | a capture on a paid-status booking is treated as a replay | M15 · G12 |
| `lib/stripe-webhook-service.ts` — `capturedOnSettledBooking` | a capture on a paid-status booking skips the owed-amount check | M15 · G12 |
| `app/api/admin/bookings/[id]/confirm-pending-guests/route.ts` — `zeroResult`, `runClaim`, `releaseChargeClaim` | status-guarded claims around the saved-card charge | no move |
| `app/api/payments/charge-saved-method/route.ts` — `runClaim`, `releaseChargeClaim` | status-guarded claims around the saved-card charge | no move |
| `app/api/payments/switch-to-internet-banking/route.ts` — `isLiveSwitchState` | replay guard on the live booking | no move |
| `lib/booking-status.ts` — `PAID_LIKE_BOOKING_STATUSES`, `isPaidLikeBookingStatus` | "paid" from status; the definition stays while callers remain, and every caller has its own row | no move |
| `lib/cron-confirm-pending.ts` — `resolveHoldWindowUnderLock` claims, `releaseOutcome` | status-guarded claims | no move |
| `lib/internet-banking-payment-cron.ts` — `releaseOneHold`, `releaseExpiredInternetBankingHolds` | reads the pending bank payment row; status is the claim fence | no move |
| `lib/internet-banking-switch-replay.ts` — `isLiveSwitchState` | replay guard on the live booking | no move |
| `lib/saved-card-charge-claim.ts` — `releaseSavedCardChargeClaim`, `recoverStaleSavedCardClaims` | status-guarded claim around the saved-card charge | no move |

## 7. Unpaid-amount reader that sizes a payment instrument

`readBookingAmountOwed` (`INV-PAY-119`) and its callers size what a pay step
asks for. They are not changed by this programme: an unpaid booking has no
cash to subtract, and the cash-cover reader must never size an instrument
(`INV-PAY-159`).

| Site | Decides | Moves |
| --- | --- | --- |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-outstanding.ts` — `cardDueCents` | sizes the additional-ask card door | M15 · G9 |
| `lib/additional-payment-ask.ts` — `bookingOutstandingCents` | what the booking still owes including its additional ask | M15 · G9 |
| `lib/booking-outstanding-payment.ts` — `bookingOutstandingCardCents`, `hasOutstandingCollectionEvidence` | sizes and shows the additional-ask card door | M15 · G9 |
| `app/api/bookings/[id]/confirm-payment/route.ts` — `confirmOwedCents` | the amount the capture must equal | no move |
| `app/api/payments/create-payment-intent/route.ts` — `readBookingAmountOwed` (two calls) | sizes the card intent | no move |
| `app/api/payments/switch-to-internet-banking/route.ts` — `amountCents` | sizes the bank-transfer payment | no move |
| `lib/booking-amount-owed.ts` — `readBookingAmountOwed` | the one owed reader (`INV-PAY-119`) | no move |
| `lib/booking-credit-election.ts` — `outstandingPriceCents` | what credit may cover | no move |
| `lib/booking-payment-state.ts` — `bookingAmountOwedCents` | owed arithmetic (`INV-PAY-119`) | no move |
| `lib/cron-confirm-pending.ts` — `emailOutcome.amountDueCents` | the amount the payment request quotes | no move |
| `lib/manual-booking-payment-state.ts` — `amountOwingCents` | the amount a manual settle records | no move |
| `lib/manual-settlement-intent-hygiene.ts` — `withdrawManualSettlementIntentCancellations` | sizes which stale card intents a reversal withdraws | no move |
| `lib/payment-link-intent.ts` — `owedCents` | sizes the link's card intent | no move |
| `lib/payment-link-reissue.ts` — `amountDueCents` | the amount the reissued link quotes | no move |
| `lib/payment-link-split-guest.ts` — `amountDueCents` | the amount the split-guest link quotes | no move |
| `lib/payment-reconciliation.ts` — `effectiveAmountCents` | the amount a manual settle records | no move |
| `lib/stripe-webhook-service.ts` — `expectedOwedCents` | the amount a capture must equal | no move |

## 8. Financial writer

Code that writes money or a paid status. "No move" rows write the status in
the same transaction as the money that justifies it.

| Site | Decides | Moves |
| --- | --- | --- |
| `lib/booking-ledger-back-post.ts` — `mustConfirm` | confirmation lines are back-posted (after `INV-MONEY-037`) | own plan · G8 |
| `lib/booking-ledger-group-settlement-sync.ts` — `groupSettledChildCancellationKeptCents` | ledger lines for a cancelled group child (after `INV-MONEY-037`) | own plan · G8 |
| `lib/xero-booking-repair-classify.ts` — `classifyBookingContext` `PAID` branch | a `PAID` booking is expected to have an invoice. The classifier only reads; its finding lets the repair path queue one, so it is listed with the writers | own plan · G5 |
| `lib/booking-batch-modification-service.ts` — zero-dollar auto-pay follow-up | a whole-lodge booking repriced to nothing is written `PAID` | M15 · G10 |
| `lib/booking-date-modification-service.ts` — `modifyBookingDates` zero-dollar auto-pay, `effectivePriceCents` | a date change repriced to nothing is written `PAID` | M15 · G10 |
| `lib/booking-guest-acceptance-reprice.ts` — zero-dollar auto-pay follow-up | a reprice to nothing is written `PAID` | M15 · G10 |
| `lib/booking-guest-removal-service.ts` — zero-dollar auto-pay follow-up | a removal repriced to nothing is written `PAID` | M15 · G10 |
| `lib/booking-modify-settlement.ts` — `applyLifecycleTransitions` zero-dollar auto-pay, `effectivePriceCents` | an edit repriced to nothing is written `PAID` | M15 · G10 |
| `lib/credit-release-ask-close.ts` — `closeCreditReleaseAsksPaidInXero` | which additional asks a Xero payment may close | M15 · G9 |
| `lib/cron-group-settlement-reaper.ts` — `releaseSettlementChildren`, `cancelReapedChildren` | children of a reaped settlement are released or cancelled | M15 · G11 |
| `lib/edit-financial-review-account-credit.ts` — `reviewInvoiceReductionCents` | how far a review reduces the invoice | M15 · G13 |
| `lib/group-late-joiner.ts` — `LEFT_BEHIND_STATUSES`, `releaseUnpaidJoinersToMemberPaysInTx` | joiners a paid bill did not cover switch to paying for themselves | M15 · G11 |
| `lib/group-settlement-invoice-replacement.ts` — `clearBoundInvoiceForReplacement` | group invoice replaced when a joiner is added | M15 · G11 |
| `lib/group-settlement.ts` — `SETTLEABLE_CHILD_STATUSES`, `commitChildrenToConfirmed`, `settleConfirmedChildrenAndNotify` | children are held, then settled, with the organiser's payment | M15 · G11 |
| `lib/xero-group-settlement-invoice-lines.ts` — `buildGroupSettlementInvoiceLines` | which children go on the organiser's invoice | M15 · G11 |
| `app/api/admin/bookings/[id]/force-confirm/route.ts` — `nextStatus` | writes `PAID` with its payment, or `PAYMENT_PENDING` | no move |
| `app/api/bookings/[id]/confirm-draft/route.ts` — `data.status` | writes `PAID` with its payment | no move |
| `app/api/bookings/[id]/waitlist-confirm/route.ts` — `runZeroDollarFlip`, `runOfferRelease` | status-guarded claims; a zero-priced offer is written `PAID` | no move |
| `app/api/payments/create-payment-intent/route.ts` — zero-owed settle | writes `PAID` with its payment | no move |
| `app/api/payments/switch-to-internet-banking/route.ts` — `claimed` | status-guarded claim to `CONFIRMED` | no move |
| `lib/booking-create.ts` — `requestedStatus`, `creditApplicationStatus`, zero-owed settle | writes the first status; `PAID` only with its payment | no move |
| `lib/booking-credit-election.ts` — `settleFullyCreditCoveredBooking` | status-guarded claim; writes `PAID` with its credit | no move |
| `lib/manual-booking-payment.ts` — `applyManualBookingPayment` | writer argument: settle to `PAID` | no move |
| `lib/payment-reconciliation.ts` — `PAYABLE_SUCCESS_STATUS_LIST`, `settleBookingPaymentInTransaction` claim | status-guarded settle claim; writes `PAID` with its payment | no move |
| `lib/school-booking-request.ts` — `approveSchoolBookingRequest`, `approveMemberWholeLodgeRequest` | writes `CONFIRMED`; `PAID` only with its credit payment | no move |
| `lib/xero-inbound/invoice-paid-effects.ts` — `syncInternetBankingPaymentsForPaidInvoice` settle | writes `PAID` with the bank receipt | no move |

## 9. Diagnostic or census

A census that read the cash-cover reader would be checking the payment
mirror against itself, so these keep reading status.

| Site | Decides | Moves |
| --- | --- | --- |
| `app/(admin)/admin/finance/xero/_components/types.ts` — `MissingInvoiceBooking` | type of the missing-invoice list (`xero-admin-health.ts`) | own plan · G5 |
| `lib/booking-provider-mismatches.ts` — `getBookingProviderMismatches` | a `PAID` booking is expected to have an invoice | own plan · G5 |
| `lib/xero-admin-health.ts` — `getMissingXeroInvoiceBookings`, `formatBookingSnapshot` | `PAID` bookings missing an invoice | own plan · G5 |
| `lib/booking-ledger-projection-census-classes.ts` — `nothingCapturedFaceCents` | census class | no move |
| `lib/booking-ledger-projection-census.ts` — `hasMoneyColumns`, `evaluateBookingLedgerIdentities` | census identities | no move |
| `lib/diagnostics/tools/packs/finance-evidence.ts` — `additionalPaymentOwed`, `displayStatus`, `invoiceExpected` | diagnostic pack reports what the app's own readers say | no move |

The rounding audit's no-move row (`scanGroupSettlementRoundingDrift`) left
`main` with the audit (#5404); the audit remains in the `v0.14.0` tag. The
counts in §3 are for `da2c858ec` and still include it.

## 10. Lifecycle reads — no move

The status is read as what it is: where the booking is in its life. None of
these treats it as money. 43 rows.

| Site | What the status decides |
| --- | --- |
| `app/(authenticated)/bookings/[id]/_components/booking-admin-tools-section.tsx` — `canPlaceHold` | capacity hold offered on a `PAYMENT_PENDING` booking |
| `app/(authenticated)/bookings/[id]/_components/booking-status-banners.tsx` — pre-payment status list | pre-payment banner |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-edit-access.ts` — `showArrivalTime`, `requestedRoomEditable` | editable until cancelled or completed |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-editor-data.ts` — `creditElectionEligible` | credit election offered before payment starts |
| `app/(authenticated)/bookings/[id]/_lib/booking-detail-linked-party.ts` — `canOpenGroup` | a group can be opened on a live booking |
| `app/(authenticated)/bookings/[id]/page.tsx` — `showMemberArrivalInstructions` | arrival instructions for a held stay (`CONFIRMED` or `PAID`) |
| `app/(authenticated)/dashboard/page.tsx` — upcoming-bookings `where` | live and completed bookings listed |
| `app/api/admin/bookings/[id]/capacity-hold/route.ts` — `POST` | hold placed on a `PAYMENT_PENDING` booking |
| `app/api/admin/bookings/[id]/exclusive-hold/route.ts` — `POST` | whole-lodge hold refused unless the booking holds beds |
| `app/api/admin/bookings/[id]/return-to-waitlist/route.ts` — `POST` | only a `PAYMENT_PENDING` offer returns to the waitlist |
| `app/api/admin/bookings/[id]/review/route.ts` — `claim` | review release to `PAYMENT_PENDING` |
| `app/api/admin/deletion-requests/[id]/route.ts` — `CANCELLABLE_DELETION_BOOKING_STATUSES` | bookings cancelled on anonymisation |
| `app/api/booking-calendar/[id]/route.ts` — `SERVABLE_BOOKING_STATUS` | calendar file served for a live booking |
| `app/api/bookings/[id]/arrival-time/route.ts` — `PUT`, `DELETE` | editable until cancelled or completed |
| `app/api/bookings/[id]/guests/route.ts` — hold adjustment (`PENDING`, `PAYMENT_PENDING`) | hold recalculated when a guest is added before payment |
| `app/api/bookings/[id]/waitlist-confirm/route.ts` — `requiresPayment` | an accepted offer with a price goes to the pay step |
| `app/api/bookings/route.ts` — credit application gate | credit applied only to a booking created `PAYMENT_PENDING` |
| `app/api/payments/create-payment-intent/route.ts` — `draftTransition` | draft advanced to `PAYMENT_PENDING` |
| `lib/admin-calendar-status-preference.ts` — `LEGACY_ENABLED_LIST_STATUSES` | calendar filter preference |
| `lib/bed-allocation-lifecycle.ts` — `BED_ALLOCATABLE_BOOKING_STATUSES` | beds may be allocated |
| `lib/booking-cancel-eligibility.ts` — `CANCELLABLE_BOOKING_STATUSES` | a booking may be cancelled |
| `lib/booking-cancel.ts` — `claim`, `released` | status-guarded cancel claim |
| `lib/booking-credit-election.ts` — `consumeStoredCreditElection`, `CREDIT_ELECTION_WRITABLE_STATUSES` | credit election applies before payment starts |
| `lib/booking-date-modification-service.ts` — `adminShiftBookingDates` | shifted booking returns to `PAYMENT_PENDING` |
| `lib/booking-edit-policy.ts` — `MEMBER_FUTURE_EDIT_STATUSES`, `IN_PROGRESS_EDIT_STATUSES`, `ACTIVE_BOOKING_EDIT_LIFECYCLE_STATUSES`, `isFinishedStay`, `canModifyBookingInActiveLifecycle` | a booking may be edited |
| `lib/booking-fresh-email-copy.ts` — `CONFIRMATION_STATUSES` | a confirmation may be sent |
| `lib/booking-guest-self-removal.ts` — `SELF_REMOVABLE_GUEST_BOOKING_STATUSES` | a guest may remove themself |
| `lib/booking-member-night-conflicts.ts` — `MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES` | a member night is taken |
| `lib/booking-payment-state.ts` — `SETTLED_BOOKING_STATUSES`, `isSettledBookingStatus` | the payment and invoice lifecycle has been entered; not "paid" |
| `lib/booking-payment-state.ts` — `refusesReviewChargeForCancellation` | a review charge is refused on a cancelled or bumped booking |
| `lib/booking-status.ts` — `CAPACITY_HOLDING_BOOKING_STATUSES`, `bookingHoldsCapacity`, `capacityHoldingBookingFilter`, `ACTIVE_BOOKING_STATUSES`, `UPCOMING_CHECK_IN_BOOKING_STATUSES`, `HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES`, `HISTORICAL_HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES`, `DUPLICATE_STAY_BOOKING_STATUSES`, `ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES`, `BOOKING_STATUS_LIFECYCLE_RANK` | capacity, hosting, duplicate-stay and ordering lists |
| `lib/cron-complete-bookings.ts` — `completeBookings` | a `PAID` stay past check-out becomes `COMPLETED` |
| `lib/cron-pre-arrival-reminders.ts` — `sendPreArrivalReminders` | reminders go to held stays (`CONFIRMED`, `PAID`) |
| `lib/edit-financial-review-charge-cancelled.ts` — `closeCancelledEditReviewChargeReplay` | a review charge is refused on a cancelled booking |
| `lib/group-booking.ts` — `OPENABLE_ORGANISER_STATUSES`, `requiresPayment` | a group can be opened; a new joiner with a price goes to the pay step |
| `lib/hut-leader-stayed-nights.ts` — `schoolBookingAwaitingInvoiceWhere` | an accepted school booking awaiting its invoice counts (owner decision, #3820) |
| `lib/member-stay-nights.ts` — `COMMITTED_BOOKING_STATUSES` | nights stayed count held and finished stays |
| `lib/policies/booking-route-decisions.ts` — `calculateBookingHoldDecision`, `calculateBookingCreditApplication` | first status and credit application at creation |
| `lib/pre-arrival-reminder-email.ts` — `PRE_ARRIVAL_REMINDER_STATUSES` | reminders go to held stays (`CONFIRMED`, `PAID`) |
| `lib/privacy-retention-selection.ts` — `formerMemberRetentionBlockers` | a live booking blocks retention deletion |
| `lib/requested-room-write.ts` — `writeRequestedRoom` | editable until cancelled or completed |
| `lib/waitlist-return-contract.ts` — `hasStrandedWaitlistConfirmShape` | shape of a half-finished free waitlist confirm |
| `lib/waitlist.ts` — `confirmWaitlistOffer` | first status of an accepted offer |

## 11. Another domain's status — no move

The same four words on a record that is not a booking: a subscription, a
roster or chore assignment, an induction, a guest consent or partner link, a
manual refund task, a Xero invoice or credit note, a webhook lease. 99
rows.

| Site | Whose status it is |
| --- | --- |
| `app/(admin)/admin/finance/subscriptions/page.tsx` | subscription status |
| `app/(admin)/admin/membership/members/_components/member-filter-toolbar.tsx` | subscription status filter |
| `app/(admin)/admin/membership/members/_types.ts` | subscription status |
| `app/(admin)/admin/membership/members/_utils.ts` | subscription status label |
| `app/(admin)/admin/membership/membership-cancellations/page.tsx` | membership cancellation request status |
| `app/(admin)/admin/roster/[date]/print/page.tsx` | roster assignment status |
| `app/(admin)/admin/roster/page.tsx` | roster assignment status |
| `app/(authenticated)/book/_hooks/use-booking-wizard.ts` — subscription status type | subscription status |
| `app/(authenticated)/bookings/consent/[guestId]/page.tsx` | guest consent status |
| `app/(authenticated)/dashboard/page.tsx` — `inductionComplete` | induction status |
| `app/(authenticated)/induction/page.tsx` | induction status |
| `app/(lodge)/lodge/kiosk/page.tsx` | chore assignment status |
| `app/(lodge)/lodge/roster/[date]/setup/page.tsx` | roster assignment status |
| `app/(public)/chores/[token]/page.tsx` | chore assignment status |
| `app/api/admin/inductions/route.ts` | induction status |
| `app/api/admin/members/export/route.ts` | subscription status |
| `app/api/admin/membership-cancellation-requests/route.ts` | membership cancellation request status |
| `app/api/admin/reports/route.ts` — subscription `where` | subscription status |
| `app/api/admin/subscriptions/route.ts` | subscription status |
| `app/api/bookings/[id]/confirm-draft/route.ts` — `paidSub` | subscription status |
| `app/api/bookings/route.ts` — `paidSub` | subscription status |
| `app/api/lodge/roster/[date]/confirm/route.ts` | roster assignment status |
| `app/api/lodge/roster/[date]/route.ts` | roster assignment status |
| `app/api/member/subscription-status/route.ts` | subscription status |
| `components/admin/induction-register-table.tsx` | induction status |
| `components/admin/roster-editor.tsx` | roster assignment status |
| `components/book/member-guest-preview.tsx` | guest consent status |
| `components/ui/status-chip.tsx` — `SUBSCRIPTION_TONES` | subscription status |
| `lib/admin-members-service.ts` | subscription status; partner link status |
| `lib/admin-roster-service.ts` | roster assignment status |
| `lib/bank-refund-void-answer.ts` | Xero credit note status |
| `lib/bank-refund-void-scan.ts` | manual refund task status |
| `lib/booking-guest-removal-service.ts` — `removeGuestChoreAssignments` | chore assignment status |
| `lib/booking-ledger-back-post.ts` — `byHand` | manual refund task status |
| `lib/booking-ledger-group-child-plan.ts` | manual refund task status |
| `lib/booking-ledger-projection-census-classes.ts` — task-status filters | manual refund task status |
| `lib/booking-ledger-projection-census-review-adjustments.ts` | manual refund task status |
| `lib/booking-ledger-projection-census.ts` — `sourceDrift` | manual refund task status |
| `lib/booking-narrative-cancelled-post-payment.ts` | manual refund task status |
| `lib/cancelled-booking-late-capture.ts` | manual refund task status |
| `lib/card-refund-cap-overflow.ts` | manual refund task status |
| `lib/card-refund-group-paid-another-way.ts` | manual refund task status |
| `lib/card-refund-paid-another-way-cash.ts` | manual refund task status |
| `lib/card-refund-paid-another-way.ts` | manual refund task status |
| `lib/deleted-booking-modification-payment.ts` | manual refund task status |
| `lib/diagnostics/tools/packs/booking-evidence.ts` | induction status |
| `lib/diagnostics/tools/packs/booking-records.ts` | guest consent status |
| `lib/duplicate-capture-kept-alert-drain.ts` — `shortfallPart` | manual refund task status |
| `lib/edit-financial-review-cancel-netting.ts` | manual refund task status |
| `lib/edit-financial-review-charge-shape.ts` | manual refund task status |
| `lib/finance-revenue-reconciliation.ts` | subscription status |
| `lib/group-booking.ts` — `paidSub` | subscription status |
| `lib/group-settlement-mirror-hand-back.ts` | manual refund task status |
| `lib/guest-chore-token.ts` | chore assignment status |
| `lib/induction-baseline.ts` | induction status |
| `lib/induction-display.ts` | induction status |
| `lib/induction.ts` | induction status |
| `lib/late-capture-kept-xero-rules.ts` | manual refund task status |
| `lib/late-capture-xero-receipt.ts` | manual refund task status |
| `lib/manual-refund-task-resolution.ts` | manual refund task status |
| `lib/manual-refund-task-settlement-rules.ts` | manual refund task status |
| `lib/manual-subscription-payment.ts` | subscription status |
| `lib/member-family-tree.ts` | partner link status |
| `lib/member-guest-consent-card.ts` | guest consent status |
| `lib/member-guest-consent-service.ts` | guest consent status |
| `lib/member-guest-consent.ts` | guest consent status |
| `lib/member-guest-delegate-page.ts` | guest consent status |
| `lib/member-lifecycle-actions.ts` | subscription status |
| `lib/member-merge.ts` | partner link status; subscription status |
| `lib/member-partner-link-shared.ts` | partner link status |
| `lib/membership-cancellation-admin.ts` | membership cancellation request status |
| `lib/membership-cancellation-status-labels.ts` | membership cancellation request status |
| `lib/membership-cancellation-xero.ts` | subscription status |
| `lib/membership-subscription-billing.ts` | subscription status |
| `lib/nomination.ts` | subscription status |
| `lib/nominator-eligibility.ts` | induction status |
| `lib/notices.ts` | subscription status |
| `lib/organiser-extra-adjustment.ts` | manual refund task status |
| `lib/paid-another-way-receipt-note.ts` | manual refund task status |
| `lib/paid-cancellation-event.ts` | manual refund task status |
| `lib/roster-status.ts` — assignment status type | roster assignment status |
| `lib/status-colors.ts` — subscription labels and classes | subscription status |
| `lib/subscription-charge-already-paid.ts` | subscription status |
| `lib/subscription-lockout-facts.ts` | subscription status |
| `lib/webhook-claim-lease.ts` | webhook lease status |
| `lib/xero-booking-invoices.ts` | Xero invoice status |
| `lib/xero-booking-repair-classify.ts` — late-capture task branch | manual refund task status |
| `lib/xero-booking-repair-paid-another-way.ts` | manual refund task status |
| `lib/xero-booking-repair.ts` | manual refund task status |
| `lib/xero-credit-note-outside-spend.ts` | Xero credit note status |
| `lib/xero-group-settlement-invoice-voids.ts` | Xero invoice status |
| `lib/xero-inbound/account-credit-modification-notes.ts` | manual refund task status |
| `lib/xero-inbound/invoice-paid-effects.ts` — `isPaidXeroInvoice` | Xero invoice status |
| `lib/xero-invoice-balance.ts` | Xero invoice status |
| `lib/xero-invoice-payable-observation.ts` | Xero invoice status |
| `lib/xero-kept-late-capture-invoice.ts` | manual refund task status |
| `lib/xero-membership-sync.ts` | subscription status |
| `lib/xero-refund-note-settlement.ts` | Xero credit note status |
| `lib/xero-subscription-invoices.ts` | subscription status |
