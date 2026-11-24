/**
 * EVERY NOTICE SENT AFTER A COMMIT IS OWED, OR HAS A RECORDED REASON (#5433,
 * `INV-INT-004`).
 *
 * A job that commits a change and then sends the email about it loses that
 * email for good if it stops between the two: a re-run finds the change made
 * and has nothing left to do. The owed-notice mechanism (`src/lib/owed-notice/`)
 * closes that gap: the change records the notice in its own transaction and a
 * later run sends what the first attempt never did. This census finds every
 * send that follows a commit in the scoped files (the reader and its exact
 * rules are in `support/post-commit-send-scan.ts`) and requires each one to be
 * either
 *
 * - routed through the mechanism: a deliverer call (`deliverOwedNotice`, or a
 *   kind's wrapper such as `deliverBumpNotices`) is not a send, so a converted
 *   site drops out of the scan; or
 * - listed in `POST_COMMIT_SEND_REASONS` with its call count, the commit each
 *   call is about (`after`: one name for every call, or one per call in source
 *   order, each of which must still come before its call) and a reason: the
 *   later pull request of #5433 that converts it, why it needs no marker, the
 *   recovery it already has, or "to trace under #5433" for an imported helper
 *   that commits and sends inside itself which the plan never traced.
 *
 * A new site fails until it is converted or listed; a listed site that is gone
 * (or converted) fails until its entry is removed; a changed call count, or a
 * named commit that no longer comes before the send, fails until the entry is
 * re-read.
 *
 * Blind spots, stated as `INV-SSOT-004` asks:
 * - Only the scoped files are read (`POST_COMMIT_SEND_SCOPE`): the paths #5433's
 *   plan traced. A transaction-then-send elsewhere is not found. Among what is
 *   left out: the confirm-payment route (`src/app/api/bookings/[id]/confirm-payment/route.ts`,
 *   the plan's ST path from the browser), which #5433's PR 3 converts with the
 *   webhook, and every route an officer starts by clicking a button.
 * - A sender is found by NAME (`send`, `alert` or `notify` and a capital
 *   letter), as a unit of the same module that contains one, or as an imported
 *   helper `SENDS_THROUGH` names. Any other imported helper that sends under
 *   another name (`triggerWaitlistProcessing`'s pass, say) is not a send here.
 * - A commit is found by its opener (`TRANSACTION_OPENERS`, shared with the
 *   lock(1) census, plus `runSavedCardClaimRelease`), a unit of the same module
 *   that contains one, or a named import whose own module's unit does, ONE
 *   import level deep: a default or namespace import, a re-export, or a helper
 *   that commits only through a further import is not followed.
 * - An imported helper outside the scope that commits and sends inside itself
 *   is a site by derivation; one whose commit is single statements (no
 *   transaction) only when `COMMITS_THEN_SENDS` names it. Such a site's `after`
 *   is `OWN_COMMIT`: its commit is inside the helper, so the per-call check
 *   cannot pin it to anything else. What pins it is the derivation itself: the
 *   site, and so its entry, goes the moment the helper stops committing or
 *   sending, and its entry then fails as stale.
 * - Order is source order within a unit, not control flow: a send on a branch
 *   that returned before the commit, or in another `switch` case, is counted
 *   (and listed here as a false positive), and a loop that sends then commits
 *   on its next pass is not.
 *
 * `pnpm run test:related` cannot select this file (it imports none of the
 * scanned modules); run it by name with `pnpm run test:named`.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { relativeSource, sourceFiles } from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import {
  COMMITS_THEN_SENDS,
  OWN_COMMIT,
  COMMITTING_CALLS,
  importedRoles,
  moduleUnitRoles,
  POST_COMMIT_SEND_SCOPE,
  scanPostCommitSends,
  SENDS_THROUGH,
  type PostCommitSite,
} from "@/lib/__tests__/support/post-commit-send-scan";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * One listed site: how many calls, the commit each call is about (one name for
 * every call, or one per call in source order), and why it is not converted here.
 */
type Entry = { calls: number; after: readonly string[]; reason: string };

const RECURRING_REMINDER =
  "Recurring officer reminder, left uncovered by decision (#5433, settled by the lane): the booking stays PENDING with its hold extended, so the next due reminder goes out anyway.";
const SAVED_CARD_RETRY =
  "Not a notice a committed change owes: a refused or failed saved-card charge leaves the booking PENDING (or its claim handed back), so a later run reaches it again and alerts on the refusal cadence (`shouldAlertOnSavedCardChargeRefusal`). #5433's plan traced this as not this shape.";
const MARK_PAID_ALERTS =
  "to trace under #5433: the card settle's officer alerts after it commits (payment failure, a capture kept with no recorded settler, a capacity-race refund shortfall, a refund failure; payment-reconciliation.ts). Its duplicate-capture alert is already recovered: an owed marker in the settle transaction, drained by the payments job (duplicate-capture-guard.ts, #5433 plan).";
const HOSTING_COVER =
  "to trace under #5433: the hosting-coverage drain's loss-of-cover email to an owner after a re-evaluation commits (adult-member-hosting-coverage-drain.ts). Its docblock says a failure leaves the queue row unprocessed for the general cron; whether a stop after the commit and before the email is covered is what to trace.";
const LATE_CAPTURE_HOLD =
  "to trace under #5433: the treasurer's held-late-capture alert after the hold's task commits (late-capture-refund-hold.ts). A still-open task re-announces on the next notice for the same capture (#3635), on no schedule.";
const CARD_REFUND_ALERTS =
  "to trace under #5433: the officers' card refund alerts after the refund rows commit (failed-later card refunds, refund cap overflow; payment-transactions.ts).";
const STRIPE_SWITCH =
  "False positive: another `switch` case of the one event dispatch; the earlier case's commit never runs before this handler, which the census reads as its own unit.";

/** Every post-commit send the scan finds that does not go through the owed-notice mechanism. */
const POST_COMMIT_SEND_REASONS: Readonly<Record<string, Entry>> = {
  // cron-confirm-pending.ts
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendConfirmationEmail": {
    calls: 2,
    after: ["resolveHoldWindowUnderLock", "markBookingPaymentSucceeded"],
    reason:
      "#5433 PR 3 converts the saved-card success confirmation (CP-2, after markBookingPaymentSucceeded) to the shared booking-confirmed kind; PR 4 converts the zero-balance confirmation (CP-1, after the hold window's own commit) onto the same kind.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendBookingRequestPaymentExpiredEmail": {
    calls: 1,
    after: ["resolveHoldWindowUnderLock"],
    reason: "#5433 PR 4 (CP-4): the requester's email when a request hold ends in cancellation.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminBookingRequestHoldCancelledEmail": {
    calls: 1,
    after: ["resolveHoldWindowUnderLock"],
    reason: "#5433 PR 4 (CP-4): the officers' notice when a request hold ends in cancellation.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendSplitGuestPortionCancelledEmail": {
    calls: 1,
    after: ["resolveHoldWindowUnderLock"],
    reason: "#5433 PR 4 (CP-5): the member's email when a split child is cancelled at the end of the check-in day.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminSplitSettlementCancelledAlert": {
    calls: 1,
    after: ["resolveHoldWindowUnderLock"],
    reason: "#5433 PR 4 (CP-5): the officers' alert when a split child is cancelled at the end of the check-in day.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendSplitGuestPaymentLinkEmail": {
    calls: 1,
    after: ["resolveHoldWindowUnderLock"],
    reason: "#5433 PR 4 (CP-6): the split child's payment link, keyed by link, with an email-row check before any re-mint.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#retireAndEscalateUnusableSavedCard": {
    calls: 1,
    after: [OWN_COMMIT],
    reason:
      "#5433, a path the plan missed (to convert with PR 4, confirm-pending): the card-unusable email to the member and alert to officers after the card clear commits. A crash between them loses both: the next run takes the missing-payment-method path, which only logs.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminBookingRequestHoldExpiredEmail": {
    calls: 1,
    after: ["resolveHoldWindowUnderLock"],
    reason: `${RECURRING_REMINDER} (CP-3)`,
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminSplitSettlementUnpaidAlert": {
    calls: 2,
    after: ["resolveHoldWindowUnderLock"],
    reason: `${RECURRING_REMINDER} (B3, B4)`,
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminPaymentFailureAlert": {
    calls: 3,
    after: ["resolveHoldWindowUnderLock", "runSavedCardClaimRelease", "runSavedCardClaimRelease"],
    reason: SAVED_CARD_RETRY,
  },

  // stripe-webhook-service.ts
  "src/lib/stripe-webhook-service.ts#handlePaymentIntentSucceeded#sendPaidBookingConfirmedEmail": {
    calls: 1,
    after: ["markBookingPaymentSucceeded"],
    reason: "#5433 PR 3 (ST): the card payment confirmation, which a redelivered webhook never sends again.",
  },
  "src/lib/stripe-webhook-service.ts#handlePaymentIntentSucceeded#alertPaymentAmountMismatch": {
    calls: 2,
    after: ["handleCancelledBookingPaymentSucceeded"],
    reason:
      "False positive: the commits before it (a cancelled booking's capture, the group-settlement and superseded-intent branches) are on branches that return first; a mismatch commits nothing and refuses to apply the payment.",
  },
  "src/lib/stripe-webhook-service.ts#handlePaymentIntentSucceeded#handleAdditionalModificationPaymentSucceeded": {
    calls: 1,
    after: ["applyGroupSettlementSucceeded"],
    reason:
      "False positive: the commits before it are on the group-settlement and superseded-intent branches, which return first; the handler's own sends are listed under its own unit.",
  },
  "src/lib/stripe-webhook-service.ts#handlePaymentIntentSucceeded#refundSupersededGroupSettlementIntent": {
    calls: 1,
    after: ["applyGroupSettlementSucceeded"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 7 (group settlement): refunding a superseded group settlement intent after the settlement applied, whose alert is listed under its own unit.",
  },
  "src/lib/stripe-webhook-service.ts#refundSupersededGroupSettlementIntent#alertSupersededGroupSettlementIntent": {
    calls: 1,
    after: ["markGroupSettlementIntentRefunded"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 7 (group settlement): the officers' alert after a superseded group settlement intent is marked refunded.",
  },
  "src/lib/stripe-webhook-service.ts#handleAdditionalModificationPaymentSucceeded#alertPaymentAmountMismatch": {
    calls: 1,
    after: ["releaseXeroSupplementaryInvoiceForCapturedPaymentIntent"],
    reason:
      "False positive: the commits before it are the cancelled-booking and already-captured branches, which return first; a mismatch commits nothing and refuses to apply the payment.",
  },
  "src/lib/stripe-webhook-service.ts#handlePaymentIntentFailed#sendAdminPaymentFailureAlert": {
    calls: 1,
    after: ["markPaymentIntentTransactionFailed"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 3 (card payments): the officers' card-payment-failure alert after the attempt row is marked failed, which a redelivered webhook may not raise again.",
  },
  "src/lib/stripe-webhook-service.ts#handleChargeRefunded#notifyXeroSyncError": {
    calls: 1,
    after: ["syncRefundsFromStripeCharge"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 3 (card payments): the Xero sync error alert when the refund's credit note could not be queued after the refund sync committed (deduped to one an hour by notifyXeroSyncError).",
  },
  "src/lib/stripe-webhook-service.ts#processStripeWebhookEvent#handlePaymentIntentFailed": {
    calls: 1,
    after: ["handlePaymentIntentSucceeded"],
    reason: STRIPE_SWITCH,
  },
  "src/lib/stripe-webhook-service.ts#processStripeWebhookEvent#handleSetupIntentFailed": {
    calls: 1,
    after: ["handlePaymentIntentSucceeded"],
    reason: STRIPE_SWITCH,
  },
  "src/lib/stripe-webhook-service.ts#processStripeWebhookEvent#handleChargeRefunded": {
    calls: 1,
    after: ["handlePaymentIntentSucceeded"],
    reason: STRIPE_SWITCH,
  },

  // xero-inbound/
  "src/lib/xero-inbound/invoice-paid-effects.ts#syncInternetBankingPaymentsForPaidInvoice#sendBookingConfirmedEmail": {
    calls: 1,
    after: ["$transaction"],
    reason: "#5433 PR 5 (XP): the bank-transfer booking confirmation, which a replayed event never sends again.",
  },
  "src/lib/xero-inbound/invoice-paid-effects.ts#syncInternetBankingPaymentsForPaidInvoice#sendBookingCancelledEmail": {
    calls: 2,
    after: ["$transaction"],
    reason: "#5433 PR 5 (XC, XA): the member's cancellation-with-credit emails.",
  },
  "src/lib/xero-inbound/invoice-paid-effects.ts#syncInternetBankingPaymentsForPaidInvoice#sendAdminPaymentFailureAlert": {
    calls: 6,
    after: ["$transaction"],
    reason: "#5433 PR 5 (XC, XA, and the arms it traces): the officers' alerts on the Xero paid-invoice arms.",
  },
  "src/lib/xero-inbound/invoice-paid-effects.ts#syncGroupSettlementForPaidInvoice#alertGroupSettlementInvoice": {
    calls: 1,
    after: ["applyGroupSettlementSucceededFromInvoice"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 7 (group settlement): the officers' group settlement invoice alert after a paid invoice settles the group.",
  },
  "src/lib/xero-inbound/invoice.ts#runIncrementalInvoiceReconciliation#alertUnrecountedInvoices": {
    calls: 1,
    after: ["reconcileXeroInvoice"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 5 (Xero inbound): the alert about invoices the incremental reconciliation could not recount, after reconciling the others.",
  },
  "src/lib/xero-inbound/credit-note-repairs.ts#repairAccountCreditAllocationBusinessState#notifyXeroSyncError": {
    calls: 1,
    after: ["$transaction"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 5 (Xero inbound). The refused allocation change (#3792) is not posted, and each later sync of the note computes the refusal and alerts again, so a lost alert waits for the next sync of that note.",
  },
  "src/lib/xero-inbound/retire-unlisted-credit-note-allocations.ts#writeCurrentCreditNoteAllocations#sendFloorAlerts": {
    calls: 1,
    after: ["writeCurrentCreditNoteAllocation"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 5 (Xero inbound): the bank-transfer floor alerts after each allocation write commits (#4449).",
  },
  "src/lib/xero-inbound/retire-unlisted-credit-note-allocations.ts#retireUnlistedCreditNoteAllocations#sendFloorAlerts": {
    calls: 1,
    after: ["writeCurrentCreditNoteAllocation"],
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 5 (Xero inbound): the bank-transfer floor alerts after each allocation removal commits (#4449).",
  },

  // internet-banking-payment-cron.ts
  "src/lib/internet-banking-payment-cron.ts#releaseExpiredInternetBankingHolds#sendBookingCancelledEmail": {
    calls: 1,
    after: ["releaseOneHold"],
    reason: "#5433 PR 6 (IB): the member's cancellation email when an Internet Banking hold expires.",
  },
  "src/lib/internet-banking-payment-cron.ts#releaseExpiredInternetBankingHolds#alertExpiredHold": {
    calls: 2,
    after: ["releaseOneHold"],
    reason:
      "#5433 PR 6 (IB) moves the released-unreadable alert into the release transaction. The other call (a part payment recorded before the lock) follows a release that skipped: nothing committed, and the hold stays a candidate the next run decides again.",
  },
  "src/lib/internet-banking-payment-cron.ts#releaseExpiredInternetBankingHolds#alertStartedStayHoldOnce": {
    calls: 1,
    after: ["releaseOneHold"],
    reason:
      "Not a notice a committed change owes: the release skipped a started stay and committed nothing; the once-ever claim keeps, holds or gives back by the send's result (#3663), and the hold is selected again on a later run.",
  },

  // cron-group-settlement-reaper.ts, group-settlement.ts, group-late-joiner.ts
  "src/lib/cron-group-settlement-reaper.ts#reapAndResume#finishReap": {
    calls: 1,
    after: ["releaseSettlementChildren"],
    reason: "#5433 PR 7 (RP-1): the organiser's and joiners' emails after a stale settlement is reaped.",
  },
  "src/lib/cron-group-settlement-reaper.ts#finishReap#sendGroupSettlementExpiredEmail": {
    calls: 1,
    after: ["processWaitlistForDates"],
    reason:
      "#5433 PR 7 (RP-1): the organiser's email. Its real commit is the release in reapAndResume (listed); inside finishReap the census sees the waitlist pass before it.",
  },
  "src/lib/cron-group-settlement-reaper.ts#finishReap#sendGroupJoinReleasedEmail": {
    calls: 1,
    after: ["processWaitlistForDates"],
    reason:
      "#5433 PR 7 (RP-1): the joiners' emails. Their real commit is the release in reapAndResume (listed); inside finishReap the census sees the waitlist pass before them.",
  },
  "src/lib/cron-group-settlement-reaper.ts#reapAndResume#expireReapedChildren": {
    calls: 1,
    after: ["releaseSettlementChildren"],
    reason: "#5433 PR 7 (RP-2): the joiners' cancellation emails, sent from finishExpiry inside expireReapedChildren.",
  },
  "src/lib/cron-group-settlement-reaper.ts#expireReapedChildren#finishExpiry": {
    calls: 1,
    after: ["cancelReapedChildren"],
    reason: "#5433 PR 7 (RP-2): the joiners' cancellation emails after the expiry commits.",
  },
  "src/lib/cron-group-settlement-reaper.ts#reapStaleGroupSettlements#reapAndResume": {
    calls: 1,
    after: ["resendUnsentGroupOrganiserHandBackAlerts"],
    reason:
      "Wrapper: the sends are reapAndResume's own (RP-1, RP-2, listed under it); the commit before it is the hand-back alert resend, which already has its own recovery (swept by task, #5433 plan).",
  },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#sendGroupSettlementReceiptEmail": {
    calls: 1,
    after: ["$transaction"],
    reason: "#5433 PR 7 (B1): the organiser's receipt after a group settlement is paid.",
  },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#sendGroupJoinSettledEmail": {
    calls: 1,
    after: ["$transaction"],
    reason: "#5433 PR 7 (B1): the joiners' settled emails after a group settlement is paid.",
  },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#notifyJoinersReleasedToMemberPays": {
    calls: 1,
    after: ["$transaction"],
    reason: "#5433 PR 7 (B1): the joiner's pay-for-your-own-place email, recovered like the others (owner decision D3).",
  },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#alertStartedStayJoinersOnce": {
    calls: 1,
    after: ["$transaction"],
    reason:
      "Already recovered: the treasurer's mid-stay alert is a once-ever claim that the group reaper re-drives from the payer-switch events (alertStartedStayPayerSwitches, #3672).",
  },
  "src/lib/group-settlement.ts#createGroupSettlementIntent#applyGroupSettlementSucceeded": {
    calls: 2,
    after: ["createGroupSettlementInvoice", "commitChildrenToConfirmed"],
    reason:
      "#5433 PR 7 (B1): applyGroupSettlementSucceeded commits the settlement and sends from settleConfirmedChildrenAndNotify (listed). One call follows the children's commit on the card path, when the intent has already succeeded; the other is counted after the Internet Banking branch's invoice transaction, which returns first.",
  },
  "src/lib/group-late-joiner.ts#releaseJoinersLeftBehindPaidSettlements#notifyJoinersReleasedToMemberPays": {
    calls: 1,
    after: ["$transaction"],
    reason: "#5433 PR 7 (B2): the joiners left behind a paid settlement, told to pay for their own place (owner decision D3).",
  },
  "src/lib/group-late-joiner.ts#releaseJoinersLeftBehindPaidSettlements#alertStartedStayPayerSwitches": {
    calls: 1,
    after: ["$transaction"],
    reason:
      "Already recovered: this is the re-drive itself, a once-ever claim per group read from the payer-switch events on every reaper run (#3672).",
  },

  // cron-age-up.ts, cron-policy-exception-hold-reaper.ts, cron-member-guest-consent-expiry.ts
  "src/lib/cron-age-up.ts#checkAgeUpMembers#sendAgeUpInvitationEmail": {
    calls: 1,
    after: ["$transaction"],
    reason: "#5433 PR 8 (B5): the age-up invitation, replaced with a fresh one when lost (owner decision D4).",
  },
  "src/lib/cron-policy-exception-hold-reaper.ts#reapExpiredPolicyExceptionHolds#notifyMemberOfExpiry": {
    calls: 1,
    after: ["resolvePolicyExceptionRequestTerminal"],
    reason: "#5433 PR 8 (B6): the member's notice after a policy-exception hold expires; a re-run never reaches it (version compare-and-set).",
  },
  "src/lib/cron-member-guest-consent-expiry.ts#runMemberGuestConsentExpiryCron#finaliseMemberGuestConsentTransition": {
    calls: 1,
    after: ["expireMemberGuestConsent"],
    reason: "#5433 PR 8 (B7): the consent outcome email the finalisation sends after the expiry commits.",
  },
  // Imported helpers outside the scope that commit and send inside themselves (#5433 review, finding 4).
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#markBookingPaymentSucceeded": {
    calls: 1,
    after: [OWN_COMMIT],
    reason: MARK_PAID_ALERTS,
  },
  "src/lib/stripe-webhook-service.ts#handlePaymentIntentSucceeded#markBookingPaymentSucceeded": {
    calls: 1,
    after: [OWN_COMMIT],
    reason: MARK_PAID_ALERTS,
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#settleHostingCoverageAfterCommit": { calls: 1, after: [OWN_COMMIT], reason: HOSTING_COVER },
  "src/lib/cron-group-settlement-reaper.ts#reapAndResume#settleHostingCoverageAfterCommit": { calls: 1, after: [OWN_COMMIT], reason: HOSTING_COVER },
  "src/lib/group-settlement.ts#createGroupSettlementIntent#settleHostingCoverageAfterCommit": { calls: 1, after: [OWN_COMMIT], reason: HOSTING_COVER },
  "src/lib/group-settlement.ts#createGroupSettlementInvoice#settleHostingCoverageAfterCommit": { calls: 1, after: [OWN_COMMIT], reason: HOSTING_COVER },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#settleHostingCoverageAfterCommit": { calls: 1, after: [OWN_COMMIT], reason: HOSTING_COVER },
  "src/lib/internet-banking-payment-cron.ts#releaseExpiredInternetBankingHolds#settleHostingCoverageAfterCommit": { calls: 1, after: [OWN_COMMIT], reason: HOSTING_COVER },
  "src/lib/waitlist.ts#confirmWaitlistOffer#settleHostingCoverageAfterCommit": { calls: 1, after: [OWN_COMMIT], reason: HOSTING_COVER },
  "src/lib/xero-inbound/invoice-paid-effects.ts#syncInternetBankingPaymentsForPaidInvoice#settleHostingCoverageAfterCommit": { calls: 1, after: [OWN_COMMIT], reason: HOSTING_COVER },
  "src/lib/cron-group-settlement-reaper.ts#reapStaleGroupSettlements#resendUnsentGroupOrganiserHandBackAlerts": {
    calls: 1,
    after: [OWN_COMMIT],
    reason:
      "Already recovered: this is the sweep of unsent hand-back alerts itself; the alert record lives on the hand-back task and is swept by task (group-organiser-hand-back.ts; #5433 plan, the group hand-back alert, covered).",
  },
  "src/lib/cron-group-settlement-reaper.ts#resumeInterruptedOrganiserCancels#settleGroupBookingOnOrganiserCancel": {
    calls: 1,
    after: [OWN_COMMIT],
    reason:
      "to trace under #5433: the joiners' cancellation emails after an organiser's cancel settles the group (group-cancel.ts), resumed here by the reaper; its hand-back alert is already swept by task.",
  },
  "src/lib/stripe-webhook-service.ts#handleAdditionalModificationPaymentSucceeded#releaseXeroSupplementaryInvoiceForCapturedPaymentIntent": {
    calls: 2,
    after: [OWN_COMMIT],
    reason:
      "to trace under #5433: the officers' alerts after a captured payment releases its Xero supplementary invoice (invoice not issued on capture, Xero sync error, taken-back invoices paid again; xero-supplementary-invoice-late-capture.ts).",
  },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingPaymentSucceeded#holdLateCaptureForTreasurerIfRequired": { calls: 1, after: [OWN_COMMIT], reason: LATE_CAPTURE_HOLD },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingPaymentSucceeded#holdLateCaptureReservationRefused": { calls: 1, after: [OWN_COMMIT], reason: LATE_CAPTURE_HOLD },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingPaymentSucceeded#holdLateCaptureDisputeRefused": { calls: 1, after: [OWN_COMMIT], reason: LATE_CAPTURE_HOLD },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingPaymentSucceeded#holdLateCaptureRefusedByStripe": { calls: 1, after: [OWN_COMMIT], reason: LATE_CAPTURE_HOLD },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingAdditionalPaymentSucceeded#holdLateCaptureForTreasurerIfRequired": { calls: 1, after: [OWN_COMMIT], reason: LATE_CAPTURE_HOLD },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingAdditionalPaymentSucceeded#holdLateCaptureReservationRefused": { calls: 1, after: [OWN_COMMIT], reason: LATE_CAPTURE_HOLD },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingAdditionalPaymentSucceeded#holdLateCaptureDisputeRefused": { calls: 1, after: [OWN_COMMIT], reason: LATE_CAPTURE_HOLD },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingAdditionalPaymentSucceeded#holdLateCaptureRefusedByStripe": { calls: 1, after: [OWN_COMMIT], reason: LATE_CAPTURE_HOLD },
  "src/lib/stripe-webhook-service.ts#handleCancelledBookingAdditionalPaymentSucceeded#refundPaymentTransactions": {
    calls: 1,
    after: [OWN_COMMIT],
    reason: CARD_REFUND_ALERTS,
  },
  "src/lib/stripe-webhook-service.ts#handleChargeRefunded#syncRefundsFromStripeCharge": {
    calls: 1,
    after: [OWN_COMMIT],
    reason: CARD_REFUND_ALERTS,
  },
  "src/lib/stripe-webhook-service.ts#processStripeWebhookEvent#recordStripeDispute": {
    calls: 1,
    after: [OWN_COMMIT],
    reason:
      "Already recovered: each dispute alert is a once-ever claim whose sent stamp is kept on the StripeDispute row, so a webhook that stops before answering is redelivered by Stripe and the redelivery sends what the row shows unsent (stripe-dispute.ts docblock, INV-INT-032).",
  },
};

/** A repository file's code, or null when there is none. */
function readRepoFile(rel: string): string | null {
  return existsSync(rel) ? readFileSync(rel, "utf8") : null;
}

/** Every site in the scoped files of the tree. */
function scanTree(): Map<string, PostCommitSite> {
  const sites = new Map<string, PostCommitSite>();
  for (const file of sourceFiles()) {
    const rel = relativeSource(file);
    if (!POST_COMMIT_SEND_SCOPE.some((pattern) => pattern.test(rel))) continue;
    const code = readFileSync(file, "utf8");
    const imported = importedRoles(rel, code, readRepoFile);
    // A cheap first pass: a module whose code names no committing call, local
    // or imported, has no site. Comments are stripped first, so a comment
    // naming one costs a parse and nothing more (the syntax tree decides).
    const stripped = stripComments(code);
    const committingNames = [
      ...COMMITTING_CALLS,
      ...Object.keys(COMMITS_THEN_SENDS),
      ...[...imported].filter(([, role]) => role.commits).map(([name]) => name),
    ];
    if (!committingNames.some((name) => stripped.includes(name))) continue;
    for (const [key, site] of scanPostCommitSends(rel, code, imported)) sites.set(key, site);
  }
  return sites;
}

/**
 * Each call comes after the commit its entry names for it: one name for every
 * call, or one per call in source order (so two calls of one sender after
 * different commits are each pinned to their own).
 */
function callsFollowTheirCommits(site: PostCommitSite, entry: Entry): boolean {
  if (entry.after.length !== 1 && entry.after.length !== site.calls) return false;
  return site.afterEach.every((names, i) => names.has(entry.after.length === 1 ? entry.after[0]! : entry.after[i]!));
}

/** What the census compares: sites with no entry, entries with no site, moved counts, and named commits no longer before the send. */
function compare(sites: ReadonlyMap<string, PostCommitSite>, reasons: Readonly<Record<string, Entry>>) {
  return {
    missing: [...sites.keys()].filter((key) => !Object.hasOwn(reasons, key)).sort(),
    stale: Object.keys(reasons).filter((key) => !sites.has(key)).sort(),
    miscounted: Object.entries(reasons)
      .filter(([key, entry]) => sites.has(key) && sites.get(key)!.calls !== entry.calls)
      .map(([key, entry]) => `${key}: listed ${entry.calls}, found ${sites.get(key)!.calls}`),
    commitMoved: Object.entries(reasons)
      .filter(([key]) => sites.has(key))
      .filter(([key, entry]) => !callsFollowTheirCommits(sites.get(key)!, entry))
      .map(([key, entry]) => `${key}: listed after ${entry.after.join(", ")}, found ${sites.get(key)!.afterEach.map((names, i) => `call ${i + 1} after ${[...names].join(", ")}`).join("; ")}`),
  };
}

describe("#5433: every notice sent after a commit is owed, or has a recorded reason (INV-INT-004)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  const sites = scanTree();
  const result = compare(sites, POST_COMMIT_SEND_REASONS);

  it("finds no unlisted post-commit send in the scoped files", () => {
    expect(
      result.missing,
      "A send after a commit: record the notice as owed in the transaction and deliver it through the owed-notice mechanism (src/lib/owed-notice/), or add an entry to POST_COMMIT_SEND_REASONS with the commit it follows and the reason it needs no marker",
    ).toEqual([]);
  });

  it("has no stale entry", () => {
    expect(result.stale, "This site is gone or now goes through the owed-notice mechanism: remove its entry").toEqual([]);
  });

  it("pins each listed site's call count", () => {
    expect(result.miscounted, "A listed site gained or lost a send call: re-read it, then update its entry").toEqual([]);
  });

  it("still finds each listed site after the commit its entry names", () => {
    expect(result.commitMoved, "The commit an entry is about no longer comes before the send: re-read the site, then update its entry").toEqual([]);
  });

  it("gives every entry a reason that names a later pull request of #5433, a recovery, or why it is not owed", () => {
    for (const [key, entry] of Object.entries(POST_COMMIT_SEND_REASONS)) {
      expect(entry.reason, key).toMatch(/#5433 PR \d|#5433, a path the plan missed|to trace under #5433|Already recovered|Not a notice a committed change owes|False positive|Wrapper|Recurring officer reminder/);
    }
  });

  it("names only helpers whose own module writes and sends (COMMITS_THEN_SENDS) or sends (SENDS_THROUGH)", () => {
    for (const [name, { module }] of Object.entries(COMMITS_THEN_SENDS)) {
      // It sends by this reader's rules, and its module writes: a helper may
      // commit by single-statement writes with no transaction (the card clear).
      const code = readRepoFile(module) ?? "";
      expect(moduleUnitRoles(module, code).get(name)?.sends, `${name} in ${module} sends`).toBe(true);
      expect(stripComments(code), `${module} writes`).toMatch(/\.(?:updateMany|update|create|createMany|upsert|deleteMany|delete)\(|\$transaction/);
    }
    for (const [name, { module }] of Object.entries(SENDS_THROUGH)) {
      expect(moduleUnitRoles(module, readRepoFile(module) ?? "").get(name)?.sends, `${name} in ${module}`).toBe(true);
    }
  });

  // The mutation probes, kept: each edit the census must catch, applied to a copy.
  it("fails on a new site, a cron that commits through an imported helper, a deleted entry and a stale entry", () => {
    const fixture = scanPostCommitSends(
      "src/lib/cron-fixture.ts",
      `export async function run() { await prisma.$transaction(async (tx) => {}); await sendFixtureEmail(); }`,
    );
    expect(compare(new Map([...sites, ...fixture]), POST_COMMIT_SEND_REASONS).missing).toContain(
      "src/lib/cron-fixture.ts#run#sendFixtureEmail",
    );

    const helperModule = `export async function closeTheHold() { return prisma.$transaction(async () => {}); }`;
    const cron = `import { closeTheHold } from "@/lib/hold-fixture";\nexport async function reap() { await closeTheHold(); await notifyTheMember(); }`;
    const imported = importedRoles("src/lib/cron-imported-fixture.ts", cron, (rel) => (rel === "src/lib/hold-fixture.ts" ? helperModule : null));
    expect(compare(new Map([...sites, ...scanPostCommitSends("src/lib/cron-imported-fixture.ts", cron, imported)]), POST_COMMIT_SEND_REASONS).missing).toContain(
      "src/lib/cron-imported-fixture.ts#reap#notifyTheMember",
    );

    const [firstKey] = Object.keys(POST_COMMIT_SEND_REASONS);
    const withoutFirst = Object.fromEntries(Object.entries(POST_COMMIT_SEND_REASONS).filter(([key]) => key !== firstKey));
    expect(compare(sites, withoutFirst).missing).toContain(firstKey);

    const withStale = { ...POST_COMMIT_SEND_REASONS, "src/lib/cron-fixture.ts#run#sendGone": { calls: 1, after: ["$transaction"], reason: "#5433 PR 9" } };
    expect(compare(sites, withStale).stale).toContain("src/lib/cron-fixture.ts#run#sendGone");
  });
});

describe("the post-commit send reader", () => {
  const scan = (code: string, imported = new Map<string, { commits: boolean; sends: boolean; inScope?: boolean }>()) =>
    [...scanPostCommitSends("src/lib/cron-x.ts", code, imported)].map(
      ([key, site]) => `${key.split("#").slice(1).join("#")}x${site.calls} after ${site.afterEach.map((names) => [...names].join(",")).join(" | ")}`,
    );

  it("counts a send after a commit, and not one before it or inside its callback", () => {
    expect(
      scan(`
        async function run() {
          await sendBefore();
          await prisma.$transaction(async (tx) => { await sendInside(); });
          await sendAfter();
          await alertAfter();
          await notifyAfter();
          await sendAfter();
        }`),
    ).toEqual(["run#sendAfterx2 after $transaction | $transaction", "run#alertAfterx1 after $transaction", "run#notifyAfterx1 after $transaction"]);
  });

  it("follows a module helper that opens a transaction, and a module helper that sends", () => {
    expect(
      scan(`
        async function commit() { return withOptionalTransaction(null, async () => {}); }
        const finish = async () => { await sendDone(); };
        export async function run() { await commit(); await finish(); }`),
    ).toEqual(["run#finishx1 after commit"]);
  });

  it("reads an imported helper's commit from its own module, one level deep, and ignores a type-only import", () => {
    const helper = `export async function settle() { return prisma.$transaction(async () => {}); }\nexport async function plain() { return 1; }`;
    const code = `import { settle, plain } from "./settle-fixture";\nimport type { settle as typeOnly } from "./other";\nexport async function run() { await plain(); await sendNotYet(); await settle(); await sendNow(); }`;
    const roles = importedRoles("src/lib/cron-x.ts", code, (rel) => (rel === "src/lib/settle-fixture.ts" ? helper : null));
    expect([...roles.keys()]).toEqual(["settle"]);
    expect(scan(code, roles)).toEqual(["run#sendNowx1 after settle"]);
  });

  it("counts a listed commit-then-send helper as a site of its own, and an imported helper SENDS_THROUGH names as a send", () => {
    expect(
      scan(`
        export async function run() {
          await retireAndEscalateUnusableSavedCard({});
          await prisma.$transaction(async () => {});
          await finaliseMemberGuestConsentTransition({});
        }`),
    ).toEqual([
      `run#retireAndEscalateUnusableSavedCardx1 after ${OWN_COMMIT}`,
      "run#finaliseMemberGuestConsentTransitionx1 after $transaction",
    ]);
  });

  it("counts an imported helper outside the scope that commits and sends as a site of its own, and one inside the scope not", () => {
    const helper = `export async function settleAndTell() { await prisma.$transaction(async () => {}); await sendTold(); }`;
    const code = `import { settleAndTell } from "./outside-fixture";\nimport { listedElsewhere } from "./waitlist";\nexport async function run() { await settleAndTell(); await listedElsewhere(); }`;
    const read = (rel: string) => (rel === "src/lib/outside-fixture.ts" ? helper : rel === "src/lib/waitlist.ts" ? helper.replace("settleAndTell", "listedElsewhere") : null);
    const roles = importedRoles("src/lib/cron-x.ts", code, read);
    expect(roles.get("settleAndTell")).toEqual({ commits: true, sends: true, inScope: false });
    expect(roles.get("listedElsewhere")).toEqual({ commits: true, sends: true, inScope: true });
    expect(scan(code, roles)).toEqual([`run#settleAndTellx1 after ${OWN_COMMIT}`]);
  });

  it("pins each call to its own commit: two calls of one sender after different commits", () => {
    const code = `
      async function run() {
        await prisma.$transaction(async () => {});
        await sendIt();
        await runSavedCardClaimRelease(x);
        await sendIt();
      }`;
    const site = scanPostCommitSends("src/lib/cron-x.ts", code).get("src/lib/cron-x.ts#run#sendIt")!;
    const pinned = (after: string[]) => callsFollowTheirCommits(site, { calls: 2, after, reason: "" });
    expect(pinned(["$transaction", "runSavedCardClaimRelease"])).toBe(true);
    // The second call follows the release; the first does not.
    expect(pinned(["runSavedCardClaimRelease", "$transaction"])).toBe(false);
    expect(pinned(["runSavedCardClaimRelease"])).toBe(false);
    expect(pinned(["$transaction"])).toBe(true);
    expect(pinned(["$transaction", "$transaction", "$transaction"])).toBe(false);
  });

  it("does not count a deliverer call, a non-sender name, or a sender with a lower-case letter after its prefix", () => {
    expect(
      scan(`
        async function run() {
          await prisma.$transaction(async () => {});
          await deliverOwedNotice(deliverer, marker, subject);
          await deliverBumpNotices(booking, owed);
          await triggerWaitlistProcessing();
          await sendsomething();
          await value.toString();
          await value.constructor();
        }`),
    ).toEqual([]);
  });

  it("reads a class method and the saved-card claim release as committing", () => {
    expect(
      scan(`
        class Job { async go() { await runSavedCardClaimRelease(x); await sendLater(); } }`),
    ).toEqual(["Job.go#sendLaterx1 after runSavedCardClaimRelease"]);
  });
});
