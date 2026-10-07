import "server-only";

import { PaymentSource } from "@prisma/client";

import { raiseReviewChargeAsk, sizeReviewChargeAsk } from "@/lib/additional-payment-ask";
import { reissueRaisedAskIfCurrencyChanged } from "@/lib/additional-intent-currency";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";
import type { ClubFormat } from "@/lib/club-format";
import { recordCarriedEditReviewChargeBalance } from "@/lib/edit-financial-review-carried-balance";
import {
  findEditReviewChargeRequest,
  recordUncollectedEditReviewChargeShare,
  sumEditReviewChargeSharesCents,
} from "@/lib/edit-financial-review-charge-request";
import {
  claimEditReviewChargeRaise,
  recordEditReviewChargeRaiseIntent,
  releaseEditReviewChargeRaise,
  type EditReviewChargeRaiseClaim,
} from "@/lib/edit-financial-review-charge-raise-claim";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  enqueueEditFinancialReviewChargeRecovery,
  isEditFinancialReviewChargeRecoveryDead,
} from "@/lib/payment-recovery";
import {
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
  buildEditFinancialReviewChargeReason,
  stripeIdempotencyKeyForAskAmount,
} from "@/lib/payment-recovery-keys";
import {
  isCapturedTransactionStatus,
  writeRaisedAdditionalRequestAmount,
} from "@/lib/payment-transactions";
import { updatePaymentIntentAmount } from "@/lib/stripe";

/**
 * #3170 / #3402: bringing ONE booking edit's review-charge request up to the
 * total of the shares settled against it - the sync the inline completion and
 * the recovery replay both call. Split out of `edit-financial-review-charge.ts`
 * when #3402 put the raise claim around it; that module still chooses the route
 * and executes the charge, and re-exports this sync for its existing importers.
 */

/** The booking member a charge may need in order to mint a Stripe customer. */
export type EditReviewChargeMember = {
  id: string;
  email: string;
  name: string;
  stripeCustomerId: string | null;
};

/**
 * What actually happened to this edit's ONE request, as a value the caller has to
 * read rather than as an absence it has to infer.
 *
 * #3170 fix round: the sync used to answer with `paymentIntentId: string | null`,
 * and `null` meant THREE different things - "nothing is owed", "the ask exists
 * and is an invoice", and "the provider refused and the club minted nothing".
 * The recovery replay could not tell them apart, so it closed the operation on
 * all three, and the third is a debt the club then never asks for. A silent
 * success on a money path is not something to log; it is something to make
 * unrepresentable, so the sync now says which of them it means.
 *
 *   * `nothing-owed`   - no settled share against this edit. Nothing to ask for,
 *                        and nothing further will ever be owed by this row.
 *   * `raised`         - the request exists and asks for at least the derived
 *                        total. Which outcomes close a replay is decided, one
 *                        entry per outcome, by `edit-financial-review-charge-recovery.ts`
 *                        (`EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY`).
 *   * `already-paid`   - the member paid before the combined total could be
 *                        raised. Terminal: the remaining share is collected by
 *                        hand, and the audit row written alongside it is how an
 *                        officer finds that out.
 *   * `not-raised`     - the ask does NOT exist and the money IS owed. The debt
 *                        is durable (a recovery row), and a replay that sees this
 *                        must leave its operation open.
 *   * `deferred`       - #3402: another run holds this edit's raise claim (or
 *                        this run lost its lease), so this run's share is not yet
 *                        known to be asked for. It is covered by that holder's
 *                        re-derivation after release or, should the holder die,
 *                        by the recovery row this run armed. Not a
 *                        receipt: like `not-raised`, a replay leaves its
 *                        operation open, and the intent id is null so the Xero
 *                        leg defers exactly as it does for a refused raise.
 */
export type EditReviewChargeSyncOutcome =
  | "nothing-owed"
  | "raised"
  | "already-paid"
  | "not-raised"
  | "deferred";

/** What the sync did, and what the request now asks for. */
export type EditReviewChargeSyncResult = {
  outcome: EditReviewChargeSyncOutcome;
  paymentIntentId: string | null;
  /** THIS EDIT'S OWN MONEY - its settled shares, nothing else. `INV-PAY-070`
   * bills it one invoice per edit, so another edit's carried balance must never
   * reach it - and says how that other invoice can be orphaned by this mint. */
  totalCents: number;
  /** #3371: the carried part; the member is asked `totalCents + carriedCents`. */
  carriedCents: number;
};

/**
 * Bring this EDIT's one request up to the total of the shares settled against it.
 *
 * THE SINGLE ENTRY POINT for both the inline completion and the recovery cron,
 * which is what makes a crash between them converge rather than diverge: the
 * replay is not "re-send what the route would have sent", it is this same
 * function asking the same question of the same rows.
 *
 * ## Why two officers closing two tasks at once neither double-count nor lose a
 * share
 *
 * The total is DERIVED from the settled shares (`sumEditReviewChargeSharesCents`)
 * at the moment this runs, and this runs AFTER the caller's transaction has
 * committed. So:
 *
 *   * NO DOUBLE COUNT. Each task contributes its share exactly once because the
 *     share is read from the task row, and a task's status-fenced claim writes
 *     that row exactly once. Two runs of this function for two tasks compute the
 *     same kind of sum, never a sum plus an increment.
 *   * NO LOST SHARE. Whichever completion COMMITS LAST necessarily reads after
 *     both commits, so at least one run always sees the full set and derives the
 *     true total. A run that started earlier may compute a smaller, stale total.
 *   * A STALE REPLAY CANNOT LOWER A LIVE ASK. A settled share is terminal, so
 *     the derived total only ever grows and a smaller figure is always the
 *     older answer; the read below REFUSES TO LOWER the recorded request, so a
 *     replay reading after the newer write leaves it alone.
 *   * TWO CONCURRENT RUNS DO NOT BOTH RAISE (#3402, `INV-PAY-112`). Refusing to
 *     lower orders nothing between two runs that each derive a figure above the
 *     stored one - both used to call Stripe, and the LAST to land won even when
 *     it was the smaller. So a run must win this edit's raise claim before any
 *     provider call; the loser calls nothing and defers. The holder re-derives
 *     AFTER releasing, and the loser committed its share before it tried to
 *     claim, which was before that release - so the holder's second look sees
 *     it and raises again. The claim is a lease, not a lock: nothing is held
 *     across the Stripe call, which `docs/CONCURRENCY_AND_LOCKING.md` forbids.
 *
 * Returns the request's intent id and the total it now asks for.
 */
export async function syncEditFinancialReviewChargeRequest(
  request: EditReviewChargeSyncRequest,
): Promise<EditReviewChargeSyncResult> {
  const { bookingId, bookingModificationId } = request;
  for (let pass = 1; pass <= MAX_RAISE_PASSES; pass += 1) {
    const owed = await sumEditReviewChargeSharesCents({ bookingId, bookingModificationId });
    if (owed <= 0) {
      // Nothing settled, so nothing to claim. Shares are terminal, so a
      // positive total can never fall back to here between passes.
      return { outcome: "nothing-owed", paymentIntentId: null, totalCents: 0, carriedCents: 0 };
    }
    const claim = await claimEditReviewChargeRaise(bookingModificationId);
    if (!claim) return deferEditReviewChargeRaise(request, owed);
    let raisePass: RaisePass;
    let released: boolean | null = null;
    try {
      raisePass = await syncEditReviewChargeRequestUnderClaim(request, claim);
    } finally {
      // A release that FAILS costs a wait, never money: the token ages out and
      // the next run takes it over. `null` is "unknown", not "lost".
      released = await releaseEditReviewChargeRaise(claim).catch((err) => {
        logger.error(
          { err, bookingId, bookingModificationId },
          "Failed to release an edit financial review charge raise claim - it will expire with its lease",
        );
        return null;
      });
    }
    const { result } = raisePass;
    if (released === false && raisePass.providerCall) {
      // The lease expired while this run was inside Stripe and another run took
      // it over, so this run's absolute amount may have landed AFTER the
      // successor's - at Stripe, on the row, or both. Nothing here can tell
      // which; what it must not do is report `raised`. The recovery row
      // re-derives and compares against the REQUEST ROW, not against Stripe: a
      // row that already covers the total gets no provider call. So if this
      // run's smaller Stripe update landed last while the successor's row write
      // did, the row says covered and Stripe asks for less - the late-write limit
      // `docs/CONCURRENCY_AND_LOCKING.md` states, which nothing here prevents.
      logger.error(
        { bookingId, bookingModificationId, ...raisePass.providerCall, outcome: result.outcome },
        "Edit financial review charge raise lost its claim during the provider call - deferring to the recovery row instead of reporting it raised",
      );
      return deferEditReviewChargeRaise(
        request,
        await sumEditReviewChargeSharesCents({ bookingId, bookingModificationId }),
      );
    }
    if (result.outcome !== "raised" && result.outcome !== "already-paid") return result;
    // `already-paid` looks again ONLY when the recovery row is dead. A share that
    // deferred to this run armed that row (or will: a deferral that has not yet
    // enqueued finds it absent or closed and reopens it), and the replay writes
    // that share's `ask-closed` record - so looking here as well wrote it twice,
    // and each record tells an officer to collect the difference by hand. A
    // terminal FAILED row is never re-armed (`INV-PAY-057`), so then nobody but
    // this run would trace the deferred share, and it looks again.
    if (
      result.outcome === "already-paid" &&
      !(await isEditFinancialReviewChargeRecoveryDead(bookingModificationId))
    ) {
      return result;
    }
    // AFTER the release, never before: a run that lost to this one committed its
    // share before its claim attempt, so this read sees it, and a share settled
    // after the release meets an unclaimed request of its own.
    const owedNow = await sumEditReviewChargeSharesCents({ bookingId, bookingModificationId });
    if (owedNow <= raisePass.coveredOwedCents) return result;
  }
  // Shares kept arriving faster than this run could raise for them - three in
  // the space of one provider round trip each. The request covers less than is
  // owed, so the debt goes to the recovery row rather than being reported raised.
  return deferEditReviewChargeRaise(
    request,
    await sumEditReviewChargeSharesCents({ bookingId, bookingModificationId }),
  );
}

/**
 * One pass under the claim: what it returns to the caller, the share total that
 * answer accounts for (the re-check after release compares against THIS, never
 * against a paid or carried figure), and the provider call it made, if any.
 */
type RaisePass = {
  result: EditReviewChargeSyncResult;
  coveredOwedCents: number;
  providerCall: { askedCents: number; providerCents: number | null } | null;
};

/**
 * How many times one run raises before handing the rest to the recovery row.
 * Each extra pass needs ANOTHER share to settle while this run holds the claim,
 * so a second pass is rare and a third is the ceiling of what is plausible.
 */
const MAX_RAISE_PASSES = 3;

type EditReviewChargeSyncRequest = {
  bookingId: string;
  bookingModificationId: string;
  paymentId: string;
  member: EditReviewChargeMember | null;
  /**
   * #3181: the EDIT's answer to "did this booking already have a primary Xero
   * invoice", carried in rather than derived here. Frozen on the recovery row
   * when the mint fails, so the replay raises the supplementary invoice the edit
   * would have raised rather than one the passage of time invented. `null` from
   * the recovery replay's own re-entry, where the row already exists and this
   * value is therefore never written - it is not a third answer, it is "the row
   * that would carry it is already there".
   */
  hasIssuedXeroInvoice: boolean | null;
  format: ClubFormat; // #3565: resolved before any transaction by the caller
};

/**
 * #3402: this run did not raise - another holds the claim, or this one lost its
 * lease - so the debt is made durable on the edit's ONE recovery row, which
 * `enqueueEditFinancialReviewChargeRecovery` also re-arms if an earlier replay
 * had closed it. It is the backstop for a holder that dies mid-raise; when the
 * holder lives, its post-release re-derivation has normally raised for this
 * share already and the replay finds the ask covering it.
 */
async function deferEditReviewChargeRaise(
  { bookingId, bookingModificationId, paymentId, hasIssuedXeroInvoice }: EditReviewChargeSyncRequest,
  totalCents: number,
): Promise<EditReviewChargeSyncResult> {
  await enqueueEditFinancialReviewChargeRecovery({
    bookingId,
    paymentId,
    bookingModificationId,
    advisoryAmountCents: totalCents,
    hadIssuedXeroInvoice: hasIssuedXeroInvoice,
  });
  return { outcome: "deferred", paymentIntentId: null, totalCents, carriedCents: 0 };
}

/** After a raised-amount write matched nothing: is the same request now paid? */
async function isRequestNowCaptured(
  { paymentId, bookingModificationId }: EditReviewChargeSyncRequest,
  paymentIntentId: string,
): Promise<boolean> {
  const now = await findEditReviewChargeRequest({ paymentId, bookingModificationId });
  return now?.stripePaymentIntentId === paymentIntentId && isCapturedTransactionStatus(now.status);
}

/**
 * The raise itself, run only while holding the edit's claim. Every provider call
 * below is preceded by recording its intent under the claim's exact token, which
 * is also the last check that the lease is still this run's.
 */
async function syncEditReviewChargeRequestUnderClaim(
  request: EditReviewChargeSyncRequest,
  claim: EditReviewChargeRaiseClaim,
): Promise<RaisePass> {
  const { bookingId, bookingModificationId, paymentId, member, hasIssuedXeroInvoice, format } =
    request;
  const totalCents = await sumEditReviewChargeSharesCents({
    bookingId,
    bookingModificationId,
  });
  if (totalCents <= 0) {
    // No settled share to ask for. Reachable only from a recovery replay of an
    // operation whose task was never claimed; minting for zero would be the
    // magic-value failure this epic exists to remove. Nothing is minted, so
    // nothing is superseded and nothing carried (#3371).
    return {
      result: { outcome: "nothing-owed", paymentIntentId: null, totalCents: 0, carriedCents: 0 },
      coveredOwedCents: 0,
      providerCall: null,
    };
  }

  const existing = await findEditReviewChargeRequest({
    paymentId,
    bookingModificationId,
  });
  const reason = buildEditFinancialReviewChargeReason(bookingModificationId);

  if (existing?.stripePaymentIntentId) {
    if (isCapturedTransactionStatus(existing.status)) {
      // Paid while this was in flight. The pre-claim refusal is the ordinary
      // guard; this is the race behind it, and it must not restate a paid ask.
      const paidShareCents = existing.amountCents - existing.carriedAskCents;
      if (paidShareCents >= totalCents) {
        // The paid request already covers every settled share: nothing is
        // uncollected, so no audit row. Routine since the re-arm - a replay that
        // a deferral reopened often finds the holder raised and the member paid -
        // and an "ask-closed, $0.00 not added" record would send an officer
        // looking for money nobody owes.
        return {
          result: {
            outcome: "already-paid",
            paymentIntentId: existing.stripePaymentIntentId,
            totalCents: paidShareCents,
            carriedCents: existing.carriedAskCents,
          },
          coveredOwedCents: totalCents,
          providerCall: null,
        };
      }
      //
      // #3170 fix round: a log line is not a queue. An officer has to be able to
      // FIND a share that was settled into a request the member had already
      // paid, and the durable, officer-readable record of a money decision in
      // this repository is the audit log. Written before the return, so the
      // trace exists whether or not anybody is watching a log stream.
      await recordUncollectedEditReviewChargeShare({
        format, // The CARD leg: the member's additional PaymentIntent is paid, so the
        // share could not be added to it. The accounting leg has its own window
        // and its own call, and the `leg` is what tells the two apart in the
        // audit list.
        leg: "payment-request",
        // The ask exists and is paid: closed, not missing (#3181).
        cause: "ask-closed",
        // #3193: a second Xero invoice is not this leg's remedy. What closed
        // here is the member's CARD request; the club's books are correct, and
        // the accounting leg raises its own second ask when its own window is
        // the one that closed.
        secondAsk: null,
        bookingId,
        bookingModificationId,
        memberId: member?.id ?? null,
        derivedTotalCents: totalCents,
        requestedTotalCents: existing.amountCents,
        // #3371: so the shortfall is measured against what this EDIT was asked
        // for. Left in, the record understates it by the carried amount.
        carriedAskCents: existing.carriedAskCents,
      });
      return {
        result: {
          outcome: "already-paid",
          paymentIntentId: existing.stripePaymentIntentId,
          // #3371: the SHARE part alone; unchanged where nothing was carried.
          totalCents: existing.amountCents - existing.carriedAskCents,
          carriedCents: existing.carriedAskCents,
        },
        // What the audit row just recorded - NOT the paid figure, which a grown
        // total would never pass and the re-check would loop on.
        coveredOwedCents: totalCents,
        providerCall: null,
      };
    }
    // #3371: shares PLUS whatever the mint absorbed, read back off the ROW -
    // never from the payment, which by now mirrors this request. Monotone,
    // which is what keeps the refusal to lower below correct.
    const raised = raiseReviewChargeAsk({ shareTotalCents: totalCents, request: existing });
    if (raised.amountCents <= existing.amountCents) {
      // Either an exact replay (equal), which must change nothing at all, or a
      // stale, smaller total, which must never lower a live ask. Either way the
      // ask that already exists covers the total this run derived, so this is
      // `raised` rather than a second write.
      const covering: EditReviewChargeSyncResult = {
        outcome: "raised",
        paymentIntentId: existing.stripePaymentIntentId,
        totalCents: existing.amountCents - existing.carriedAskCents,
        carriedCents: existing.carriedAskCents,
      };
      return { result: covering, coveredOwedCents: covering.totalCents, providerCall: null };
    }
    // #3402: the intended raise is recorded under the claim BEFORE Stripe hears
    // of it; a lease lost by now means another run owns this request.
    if (!(await recordEditReviewChargeRaiseIntent(claim, raised.amountCents))) {
      return {
        result: await deferEditReviewChargeRaise(request, totalCents),
        coveredOwedCents: 0,
        providerCall: null,
      };
    }
    const reissuedId = await reissueRaisedAskIfCurrencyChanged({ format, bookingId, paymentId, staleIntentId: existing.stripePaymentIntentId, ask: raised, reason });
    if (reissuedId) {
      return {
        result: { outcome: "raised", paymentIntentId: reissuedId, totalCents, carriedCents: raised.carriedCents },
        coveredOwedCents: totalCents,
        providerCall: { askedCents: raised.amountCents, providerCents: null },
      };
    }
    // Same currency (#3567): the SAME intent asks for more. Nothing is minted, so nothing
    // is superseded — `queueSupersededAdditionalIntentCancellations` never fires between shares.
    // A refusal THROWS from here with nothing written: the row still matches the
    // unchanged intent, the claim is released by the caller, and
    // `executeEditReviewCharge` (or the replay) makes the debt durable.
    const provider = await updatePaymentIntentAmount(existing.stripePaymentIntentId, raised.amountCents);
    // THIS arm reconciles from the provider's answer, not from the figure asked
    // for: the row is what the member's pay page shows, and it must agree with
    // the intent. (A currency re-issue and a first mint write the amount they
    // REQUESTED; both keys carry that amount, so a replayed key returns it.)
    const providerCall = { askedCents: raised.amountCents, providerCents: provider.amount };
    if (provider.amount !== raised.amountCents) {
      logger.error(
        { bookingId, bookingModificationId, askedCents: raised.amountCents, providerCents: provider.amount },
        "Stripe answered an edit financial review charge raise with a different amount - the request row records Stripe's",
      );
    }
    // Amounts only, and only onto a row that is not captured: a webhook that
    // recorded the member paying in the instant after Stripe accepted the new
    // amount must not be reverted to PENDING by this write.
    const written = await writeRaisedAdditionalRequestAmount({
      paymentId,
      paymentIntentId: existing.stripePaymentIntentId,
      amountCents: provider.amount,
      // Re-stated from the ONE value that computed both (#3371).
      carriedAskCents: raised.carriedCents,
    });
    // What the intent now covers of THIS edit's shares: short of the derived
    // total only if Stripe answered short, and then the caller's post-release
    // re-derivation raises again (or, if it was paid, records the rest).
    const coveredOwedCents = provider.amount - raised.carriedCents;
    if (!written && !(await isRequestNowCaptured(request, existing.stripePaymentIntentId))) {
      // Not captured, so the row stopped being the live ask in that window - an
      // officer withdrew it (#3528). The raise landed on a retired intent; the
      // recovery row re-derives against what is live now, exactly as a share
      // settling a moment after the withdrawal would.
      logger.warn(
        { bookingId, bookingModificationId, ...providerCall },
        "Edit financial review charge request was withdrawn as it was raised - deferring to the recovery row",
      );
      return { result: await deferEditReviewChargeRaise(request, totalCents), coveredOwedCents: 0, providerCall };
    }
    if (!written) {
      // Paid at the NEW amount (Stripe refuses to update a captured intent), so
      // nothing this pass derived is uncollected; reported as `already-paid` so
      // no caller queues an invoice to wait on a payment that already happened.
      logger.warn(
        { bookingId, bookingModificationId, ...providerCall },
        "Edit financial review charge request was paid as it was raised - its row keeps the status the payment wrote",
      );
      return {
        result: {
          outcome: "already-paid",
          paymentIntentId: existing.stripePaymentIntentId,
          totalCents: coveredOwedCents,
          carriedCents: raised.carriedCents,
        },
        coveredOwedCents,
        providerCall,
      };
    }
    return {
      result: {
        outcome: "raised",
        paymentIntentId: existing.stripePaymentIntentId,
        totalCents: coveredOwedCents,
        carriedCents: raised.carriedCents,
      },
      coveredOwedCents,
      providerCall,
    };
  }

  // No request yet: mint through the same function every ordinary booking-edit
  // price increase uses. Its guard on a captured card payment is answered with
  // the payment as it stands NOW, re-read after the commit, rather than with a
  // literal `true` - a constant there would make the minter's own guard
  // permanently dead for this caller, which is the opposite of letting it remain
  // the one definition.
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      source: true,
      stripeCustomerId: true,
      // #3371: the live ask the mint below retires. `existing` being null
      // above is what proves it belongs to another edit.
      additionalAmountCents: true,
      additionalPaymentStatus: true,
    },
  });
  // THE FIX (#3371, `INV-PAY-098`). This used to pass the bare share total, so a
  // review charge raised while an earlier change's extra was unpaid DELETED it.
  // `sizeReviewChargeAsk` is the rule the ordinary path already uses
  // (`sizeAdditionalAsk`, #3340) over this path's own figure.
  const ask = sizeReviewChargeAsk({ shareTotalCents: totalCents, payment });
  // #3402: the first mint is under the claim too. Two first shares would
  // otherwise mint two intents under two amount keys, each superseding the
  // other, and the survivor could be the smaller.
  if (!(await recordEditReviewChargeRaiseIntent(claim, ask.amountCents))) {
    return {
      result: await deferEditReviewChargeRaise(request, totalCents),
      coveredOwedCents: 0,
      providerCall: null,
    };
  }
  const mintCall = { askedCents: ask.amountCents, providerCents: null };
  const minted = await createModificationAdditionalPaymentIntent({
    format, bookingId,
    result: {
      // Only the fields the minter reads. The rest of
      // `BookingModificationPaymentContext` describes a refund it will not make
      // (`pendingRefundAmountCents` 0) and a settlement it does not choose.
      pendingRefundAmountCents: 0, organiserChildRefund: null,
      paymentId, memberFirstName: "", // #3369: mints an ask, sends nothing.
      additionalAsk: ask,
      hasSucceededPayment:
        hasCapturedPayment(payment) && payment?.source === PaymentSource.STRIPE,
      paymentCustomerId: payment?.stripeCustomerId ?? null,
      memberEmail: member?.email ?? "",
      memberName: member?.name ?? "",
      memberId: member?.id ?? "",
      bookingModificationId, priceLines: null, // #3530: typed money; no lines describe it
      // #3181: carried, not re-read. See this function's parameter docblock.
      hasIssuedXeroInvoice,
    },
    // #3170: the request's identity in the ledger. A later share finds this row
    // by exact match on it, which is why it is built rather than spelled.
    reason,
    // EDIT-scoped on both keys, which INVERTS the first #3170 round - see
    // `payment-recovery-keys.ts` for the full reasoning and for which of the two
    // (request vs share) each key belongs to. In short: the request is the thing
    // being identified, there is one per edit, and a replay converging on the
    // first intent is now the point rather than the hazard. #3371 adds THE
    // AMOUNT, because this figure is RE-DERIVED on every attempt and a fixed key
    // would then answer `idempotency_error` for ever - see that helper.
    idempotencyKey: stripeIdempotencyKeyForAskAmount(
      buildEditFinancialReviewAdditionalIntentStripeKey(bookingModificationId),
      ask.amountCents,
    ),
    recoveryIdempotencyKey:
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(
        bookingModificationId,
      ),
    failureMessage:
      "Failed to create the additional PaymentIntent for a completed edit financial review - the persisted recovery operation will replay it",
  });
  if (!minted.additionalPaymentIntentId) {
    /**
     * THE MINT PRODUCED NOTHING, AND THE MONEY IS STILL OWED.
     *
     * `createModificationAdditionalPaymentIntent` cannot throw this back at us:
     * it SWALLOWS a provider failure by design, because the ordinary edit path
     * that shares it must still return the member's saved change while the
     * recovery row carries the debt. That design is right there and wrong here,
     * so this caller reads the RESULT rather than relying on an exception -
     * which is why the fix is here and not in the minter's contract.
     *
     * Two ways to arrive, and the enqueue below covers both:
     *
     *   * the provider refused - the minter's own `catch` has already written
     *     the recovery row, and this upsert is a no-op on it;
     *   * its `hasSucceededPayment` / `paymentId` guard answered false on the
     *     re-read - it returns BEFORE its `try`, so nothing at all was written.
     *     That was the one path that settled a task, minted nothing, and left no
     *     trace of any kind.
     */
    await enqueueEditFinancialReviewChargeRecovery({
      bookingId,
      paymentId,
      bookingModificationId,
      // Advisory only: the replay re-derives the total, and re-reads the
      // carried balance off a payment the failed mint never touched (#3371).
      advisoryAmountCents: ask.amountCents,
      // #3181: NOT advisory. The replay reads this back to decide whether the
      // edit had an invoice to supplement at all.
      hadIssuedXeroInvoice: hasIssuedXeroInvoice,
    });
    return {
      result: { outcome: "not-raised", paymentIntentId: null, totalCents, carriedCents: 0 },
      coveredOwedCents: 0,
      providerCall: mintCall,
    };
  }
  if (ask.carriedCents > 0) {
    // Only after a SUCCESSFUL mint: a failed one retired nothing.
    await recordCarriedEditReviewChargeBalance({
      format, bookingId, bookingModificationId,
      memberId: member?.id ?? null,
      shareTotalCents: totalCents,
      carriedCents: ask.carriedCents,
    });
  }
  return {
    result: {
      outcome: "raised",
      paymentIntentId: minted.additionalPaymentIntentId,
      totalCents,
      carriedCents: ask.carriedCents,
    },
    coveredOwedCents: totalCents,
    providerCall: mintCall,
  };
}
