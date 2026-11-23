/**
 * EVERY NOTICE SENT AFTER A COMMIT IS OWED, OR HAS A RECORDED REASON (#5433,
 * `INV-INT-004`).
 *
 * A job that commits a change and then sends the email about it loses that
 * email for good if it stops between the two: a re-run finds the change made
 * and has nothing left to do. The owed-notice mechanism (`src/lib/owed-notice/`)
 * closes that gap: the change records the notice in its own transaction and a
 * later run sends what the first attempt never did. This census finds every
 * send that follows a transaction in the scoped files (the reader and its exact
 * rules are in `support/post-commit-send-scan.ts`) and requires each one to be
 * either
 *
 * - routed through the mechanism: a deliverer call (`deliverOwedNotice`, or a
 *   kind's wrapper such as `deliverBumpNotices`) is not a send, so a converted
 *   site drops out of the scan; or
 * - listed in `POST_COMMIT_SEND_REASONS` with its call count and a reason: the
 *   later pull request of #5433 that converts it, or why it needs no marker.
 *
 * A new site fails until it is converted or listed; a listed site that is gone
 * (or converted) fails until its entry is removed; a changed call count fails
 * until the entry is re-read.
 *
 * Blind spots, stated as `INV-SSOT-004` asks:
 * - Only the scoped files are read (`POST_COMMIT_SEND_SCOPE`): the paths #5433's
 *   plan traced. A transaction-then-send elsewhere is not found.
 * - A sender is found by NAME (`send`, `alert` or `notify` and a capital
 *   letter, or a unit of the same module that contains one). A sender with
 *   another name, or one reached through an imported function with another
 *   name (`triggerWaitlistProcessing`, say), is not found.
 * - A transaction is found by its opener (`TRANSACTION_OPENERS`, shared with the
 *   lock(1) census, plus `runSavedCardClaimRelease`) or a unit of the same
 *   module that contains one. A transaction opened inside an imported function
 *   is not found.
 * - Order is source order within a unit, not control flow: a send on a branch
 *   that returned before the transaction, or in another `switch` case, is
 *   counted (and listed here as a false positive), and a loop that sends then
 *   commits on its next pass is not.
 *
 * `pnpm run test:related` cannot select this file (it imports none of the
 * scanned modules); run it by name with `pnpm run test:named`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { relativeSource, sourceFiles } from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import {
  COMMITTING_CALLS,
  POST_COMMIT_SEND_SCOPE,
  scanPostCommitSends,
} from "@/lib/__tests__/support/post-commit-send-scan";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

type Entry = { calls: number; reason: string };

const RECURRING_REMINDER =
  "Recurring officer reminder, left uncovered by decision (#5433, settled by the lane): the booking stays PENDING with its hold extended, so the next due reminder goes out anyway.";
const SAVED_CARD_RETRY =
  "Not a notice a committed change owes: a refused or failed saved-card charge leaves the booking PENDING (or its claim handed back), so a later run reaches it again and alerts on the refusal cadence (`shouldAlertOnSavedCardChargeRefusal`). #5433's plan traced this as not this shape.";
const STRIPE_SWITCH =
  "False positive: another `switch` case of the one event dispatch; the earlier case's transaction never runs before this handler, which the census reads as its own unit.";

/** Every post-commit send the scan finds that does not go through the owed-notice mechanism. */
const POST_COMMIT_SEND_REASONS: Readonly<Record<string, Entry>> = {
  // cron-confirm-pending.ts
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendConfirmationEmail": {
    calls: 2,
    reason:
      "#5433 PR 3 converts the saved-card success confirmation (CP-2) to the shared booking-confirmed kind; PR 4 converts the zero-balance confirmation (CP-1) onto the same kind.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendBookingRequestPaymentExpiredEmail": {
    calls: 1,
    reason: "#5433 PR 4 (CP-4): the requester's email when a request hold ends in cancellation.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminBookingRequestHoldCancelledEmail": {
    calls: 1,
    reason: "#5433 PR 4 (CP-4): the officers' notice when a request hold ends in cancellation.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendSplitGuestPortionCancelledEmail": {
    calls: 1,
    reason: "#5433 PR 4 (CP-5): the member's email when a split child is cancelled at the end of the check-in day.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminSplitSettlementCancelledAlert": {
    calls: 1,
    reason: "#5433 PR 4 (CP-5): the officers' alert when a split child is cancelled at the end of the check-in day.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendSplitGuestPaymentLinkEmail": {
    calls: 1,
    reason: "#5433 PR 4 (CP-6): the split child's payment link, keyed by link, with an email-row check before any re-mint.",
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminBookingRequestHoldExpiredEmail": {
    calls: 1,
    reason: `${RECURRING_REMINDER} (CP-3)`,
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminSplitSettlementUnpaidAlert": {
    calls: 2,
    reason: `${RECURRING_REMINDER} (B3, B4)`,
  },
  "src/lib/cron-confirm-pending.ts#confirmPendingBookings#sendAdminPaymentFailureAlert": {
    calls: 3,
    reason: SAVED_CARD_RETRY,
  },

  // stripe-webhook-service.ts
  "src/lib/stripe-webhook-service.ts#handlePaymentIntentSucceeded#sendPaidBookingConfirmedEmail": {
    calls: 1,
    reason: "#5433 PR 3 (ST): the card payment confirmation, which a redelivered webhook never sends again.",
  },
  "src/lib/stripe-webhook-service.ts#handlePaymentIntentSucceeded#alertPaymentAmountMismatch": {
    calls: 2,
    reason:
      "False positive: the transaction before it is a cancelled booking's capture, on a branch that returns first; a mismatch commits nothing and refuses to apply the payment.",
  },
  "src/lib/stripe-webhook-service.ts#processStripeWebhookEvent#handlePaymentIntentFailed": { calls: 1, reason: STRIPE_SWITCH },
  "src/lib/stripe-webhook-service.ts#processStripeWebhookEvent#handleSetupIntentFailed": { calls: 1, reason: STRIPE_SWITCH },
  "src/lib/stripe-webhook-service.ts#processStripeWebhookEvent#handleChargeRefunded": { calls: 1, reason: STRIPE_SWITCH },

  // waitlist.ts
  "src/lib/waitlist.ts#processWaitlistForDates#sendWaitlistOfferEmail": {
    calls: 1,
    reason: "#5433 PR 2 (WL-1): the waitlist offer email, with the offer window restarted from the real send (owner decision D2).",
  },
  "src/lib/waitlist.ts#processWaitlistForDates#sendAdminWaitlistOfferAlert": {
    calls: 1,
    reason: "#5433 PR 2 (WL-1): the officers' waitlist offer alert.",
  },
  "src/lib/waitlist.ts#expireStaleOffers#sendWaitlistOfferExpiredEmail": {
    calls: 1,
    reason: "#5433 PR 2 (WL-2): the offer-expired email, withheld for an offer the member was never told about (owner decision D2).",
  },
  "src/lib/waitlist.ts#expireStaleOffers#processWaitlistForDates": {
    calls: 1,
    reason: "#5433 PR 2 (WL-1): offering the lapsed place on (#5441) sends the next offer, which PR 2 makes owed inside processWaitlistForDates.",
  },

  // xero-inbound/
  "src/lib/xero-inbound/invoice-paid-effects.ts#syncInternetBankingPaymentsForPaidInvoice#sendBookingConfirmedEmail": {
    calls: 1,
    reason: "#5433 PR 5 (XP): the bank-transfer booking confirmation, which a replayed event never sends again.",
  },
  "src/lib/xero-inbound/invoice-paid-effects.ts#syncInternetBankingPaymentsForPaidInvoice#sendBookingCancelledEmail": {
    calls: 2,
    reason: "#5433 PR 5 (XC, XA): the member's cancellation-with-credit emails.",
  },
  "src/lib/xero-inbound/invoice-paid-effects.ts#syncInternetBankingPaymentsForPaidInvoice#sendAdminPaymentFailureAlert": {
    calls: 6,
    reason: "#5433 PR 5 (XC, XA, and the arms it traces): the officers' alerts on the Xero paid-invoice arms.",
  },
  "src/lib/xero-inbound/credit-note-repairs.ts#repairAccountCreditAllocationBusinessState#notifyXeroSyncError": {
    calls: 1,
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 5 (Xero inbound). The refused allocation change (#3792) is not posted, and each later sync of the note computes the refusal and alerts again, so a lost alert waits for the next sync of that note.",
  },
  "src/lib/xero-inbound/retire-unlisted-credit-note-allocations.ts#writeCurrentCreditNoteAllocations#sendFloorAlerts": {
    calls: 1,
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 5 (Xero inbound): the bank-transfer floor alerts after each allocation write commits (#4449).",
  },
  "src/lib/xero-inbound/retire-unlisted-credit-note-allocations.ts#retireUnlistedCreditNoteAllocations#sendFloorAlerts": {
    calls: 1,
    reason:
      "Outside the paths #5433's plan traced; to be traced with #5433 PR 5 (Xero inbound): the bank-transfer floor alerts after each allocation removal commits (#4449).",
  },

  // internet-banking-payment-cron.ts
  "src/lib/internet-banking-payment-cron.ts#releaseExpiredInternetBankingHolds#sendBookingCancelledEmail": {
    calls: 1,
    reason: "#5433 PR 6 (IB): the member's cancellation email when an Internet Banking hold expires.",
  },
  "src/lib/internet-banking-payment-cron.ts#releaseExpiredInternetBankingHolds#alertExpiredHold": {
    calls: 2,
    reason:
      "#5433 PR 6 (IB) moves the released-unreadable alert into the release transaction. The other call (a part payment recorded before the lock) follows a release that skipped: nothing committed, and the hold stays a candidate the next run decides again.",
  },
  "src/lib/internet-banking-payment-cron.ts#releaseExpiredInternetBankingHolds#alertStartedStayHoldOnce": {
    calls: 1,
    reason:
      "Not a notice a committed change owes: the release skipped a started stay and committed nothing; the once-ever claim keeps, holds or gives back by the send's result (#3663), and the hold is selected again on a later run.",
  },

  // cron-group-settlement-reaper.ts, group-settlement.ts, group-late-joiner.ts
  "src/lib/cron-group-settlement-reaper.ts#reapAndResume#finishReap": {
    calls: 1,
    reason: "#5433 PR 7 (RP-1): the organiser's and joiners' emails after a stale settlement is reaped.",
  },
  "src/lib/cron-group-settlement-reaper.ts#reapAndResume#expireReapedChildren": {
    calls: 1,
    reason: "#5433 PR 7 (RP-2): the joiners' cancellation emails, sent from finishExpiry inside expireReapedChildren.",
  },
  "src/lib/cron-group-settlement-reaper.ts#expireReapedChildren#finishExpiry": {
    calls: 1,
    reason: "#5433 PR 7 (RP-2): the joiners' cancellation emails after the expiry commits.",
  },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#sendGroupSettlementReceiptEmail": {
    calls: 1,
    reason: "#5433 PR 7 (B1): the organiser's receipt after a group settlement is paid.",
  },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#sendGroupJoinSettledEmail": {
    calls: 1,
    reason: "#5433 PR 7 (B1): the joiners' settled emails after a group settlement is paid.",
  },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#notifyJoinersReleasedToMemberPays": {
    calls: 1,
    reason: "#5433 PR 7 (B1): the joiner's pay-for-your-own-place email, recovered like the others (owner decision D3).",
  },
  "src/lib/group-settlement.ts#settleConfirmedChildrenAndNotify#alertStartedStayJoinersOnce": {
    calls: 1,
    reason:
      "Already recovered: the treasurer's mid-stay alert is a once-ever claim that the group reaper re-drives from the payer-switch events (alertStartedStayPayerSwitches, #3672).",
  },
  "src/lib/group-settlement.ts#createGroupSettlementIntent#applyGroupSettlementSucceeded": {
    calls: 2,
    reason:
      "#5433 PR 7 (B1): applyGroupSettlementSucceeded commits the settlement and sends from settleConfirmedChildrenAndNotify (listed above). Counted here after the Internet Banking branch's invoice transaction, which returns first; one call also follows the children's commit on the card path, when the intent has already succeeded.",
  },
  "src/lib/group-late-joiner.ts#releaseJoinersLeftBehindPaidSettlements#notifyJoinersReleasedToMemberPays": {
    calls: 1,
    reason: "#5433 PR 7 (B2): the joiners left behind a paid settlement, told to pay for their own place (owner decision D3).",
  },
  "src/lib/group-late-joiner.ts#releaseJoinersLeftBehindPaidSettlements#alertStartedStayPayerSwitches": {
    calls: 1,
    reason:
      "Already recovered: this is the re-drive itself, a once-ever claim per group read from the payer-switch events on every reaper run (#3672).",
  },

  // cron-age-up.ts
  "src/lib/cron-age-up.ts#checkAgeUpMembers#sendAgeUpInvitationEmail": {
    calls: 1,
    reason: "#5433 PR 8 (B5): the age-up invitation, replaced with a fresh one when lost (owner decision D4).",
  },
};

/** Every site in the scoped files of the tree. */
function scanTree(): Map<string, number> {
  const sites = new Map<string, number>();
  for (const file of sourceFiles()) {
    const rel = relativeSource(file);
    if (!POST_COMMIT_SEND_SCOPE.some((pattern) => pattern.test(rel))) continue;
    const code = readFileSync(file, "utf8");
    // A cheap first pass: a module whose code names no committing call has no
    // site. Comments are stripped first, so a comment naming one costs a parse
    // and nothing more (the syntax tree decides).
    const stripped = stripComments(code);
    if (![...COMMITTING_CALLS].some((name) => stripped.includes(name))) continue;
    for (const [key, count] of scanPostCommitSends(rel, code)) sites.set(key, count);
  }
  return sites;
}

/** What the census compares: sites with no entry, entries with no site, and entries whose count moved. */
function compare(sites: ReadonlyMap<string, number>, reasons: Readonly<Record<string, Entry>>) {
  return {
    missing: [...sites.keys()].filter((key) => !(key in reasons)).sort(),
    stale: Object.keys(reasons).filter((key) => !sites.has(key)).sort(),
    miscounted: Object.entries(reasons)
      .filter(([key, entry]) => sites.has(key) && sites.get(key) !== entry.calls)
      .map(([key, entry]) => `${key}: listed ${entry.calls}, found ${sites.get(key)}`),
  };
}

describe("#5433: every notice sent after a commit is owed, or has a recorded reason (INV-INT-004)", () => {
  const sites = scanTree();
  const result = compare(sites, POST_COMMIT_SEND_REASONS);

  it("finds no unlisted post-commit send in the scoped files", () => {
    expect(
      result.missing,
      "A send after a transaction: record the notice as owed in the transaction and deliver it through the owed-notice mechanism (src/lib/owed-notice/), or add an entry to POST_COMMIT_SEND_REASONS with the reason it needs no marker",
    ).toEqual([]);
  });

  it("has no stale entry", () => {
    expect(result.stale, "This site is gone or now goes through the owed-notice mechanism: remove its entry").toEqual([]);
  });

  it("pins each listed site's call count", () => {
    expect(result.miscounted, "A listed site gained or lost a send call: re-read it, then update its entry").toEqual([]);
  });

  it("gives every entry a reason that names a later pull request of #5433, a recovery, or why it is not owed", () => {
    for (const [key, entry] of Object.entries(POST_COMMIT_SEND_REASONS)) {
      expect(entry.reason, key).toMatch(/#5433 PR \d|Already recovered|Not a notice a committed change owes|False positive|Recurring officer reminder/);
    }
  });

  // The mutation probes, kept: each edit the census must catch, applied to a copy.
  it("fails on a new site, a deleted entry and a stale entry", () => {
    const fixture = scanPostCommitSends(
      "src/lib/cron-fixture.ts",
      `export async function run() { await prisma.$transaction(async (tx) => {}); await sendFixtureEmail(); }`,
    );
    expect(compare(new Map([...sites, ...fixture]), POST_COMMIT_SEND_REASONS).missing).toContain(
      "src/lib/cron-fixture.ts#run#sendFixtureEmail",
    );

    const [firstKey] = Object.keys(POST_COMMIT_SEND_REASONS);
    const withoutFirst = Object.fromEntries(Object.entries(POST_COMMIT_SEND_REASONS).filter(([key]) => key !== firstKey));
    expect(compare(sites, withoutFirst).missing).toContain(firstKey);

    const withStale = { ...POST_COMMIT_SEND_REASONS, "src/lib/cron-fixture.ts#run#sendGone": { calls: 1, reason: "#5433 PR 9" } };
    expect(compare(sites, withStale).stale).toContain("src/lib/cron-fixture.ts#run#sendGone");
  });
});

describe("the post-commit send reader", () => {
  const scan = (code: string) => [...scanPostCommitSends("src/lib/cron-x.ts", code)].map(([key, n]) => `${key.split("#").slice(1).join("#")}x${n}`);

  it("counts a send after a transaction, and not one before it or inside its callback", () => {
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
    ).toEqual(["run#sendAfterx2", "run#alertAfterx1", "run#notifyAfterx1"]);
  });

  it("follows a module helper that opens a transaction, and a module helper that sends", () => {
    expect(
      scan(`
        async function commit() { return withOptionalTransaction(null, async () => {}); }
        const finish = async () => { await sendDone(); };
        export async function run() { await commit(); await finish(); }`),
    ).toEqual(["run#finishx1"]);
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
        }`),
    ).toEqual([]);
  });

  it("reads a class method and the saved-card claim release as committing", () => {
    expect(
      scan(`
        class Job { async go() { await runSavedCardClaimRelease(x); await sendLater(); } }`),
    ).toEqual(["Job.go#sendLaterx1"]);
  });
});
