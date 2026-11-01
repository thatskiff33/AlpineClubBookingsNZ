import { assertAdditionalAskSizingCurrent, withAdditionalAskQueueTransaction } from "@/lib/additional-ask-queue-transaction";
import type { ModificationLine } from "@/lib/booking-modification-lines";
import { PaymentRecoveryOperationStatus, PaymentStatus, PaymentTransactionKind } from "@prisma/client";

import type { AdditionalAsk } from "@/lib/additional-payment-ask";
import type { RetiredAdditionalAsk } from "@/lib/additional-ask-reduction";
import {
  cancelRetiredAdditionalAsksNow,
  readReissuedAskRecovery,
  type ReissuedAskRecovery,
  writeReissuedAskUnderRecovery,
} from "@/lib/additional-ask-reissue";
import { PENDING_ASK_NETTED_BY_REDUCTION_NOTE } from "@/lib/additional-ask-recovery-close";
import { queueFoldedReissuedAskInvoices, queueReissuedAskSupplementaryInvoice } from "@/lib/reissued-ask-invoice";
import {
  mintedIntentCustomerId,
  mintReissuedAskIntent,
  planReissuedAskMint,
  readAskMintPayment,
  resolveAskCustomerId,
} from "@/lib/reissued-ask-mint";
import { mintOrdinaryAskIntent } from "@/lib/ordinary-ask-mint";
import {
  ADDITIONAL_ASK_INTENT_TYPE,
  ordinaryAskDoorRequest,
  planOrdinaryAskMint,
  type OrdinaryAskDoor,
} from "@/lib/ordinary-ask-request";
import {
  cancelSupersededAdditionalIntentsNow,
  queueSupersededAdditionalIntentCancellationRows,
} from "@/lib/booking-payment-cleanup";
import { bookingEndedBeforeAskMint, retireAskOnEndedBooking } from "@/lib/ended-booking-ask-guard";
import logger from "@/lib/logger";
import {
  enqueueAdditionalPaymentIntentRecovery,
  enqueueBookingModificationRefundRecovery,
  processPaymentRecoveryOperations,
} from "@/lib/payment-recovery";
import { runOrganiserChildRefundDebtNow } from "@/lib/organiser-child-refund-executor";
import type { BookingModifiedRefundDestination } from "@/lib/booking-modified-email-copy";
import {
  buildAdditionalIntentRecoveryIdempotencyKey,
  bookingModificationRefundReasonForKeyPrefix,
  buildBookingModificationRefundMetadata,
  buildOrganiserChildModificationRefundKey,
} from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";
import {
  planStripeRefundAllocation,
  type RefundAllocationSlice,
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import {
  createPaymentIntent,
  findOrCreateCustomer,
} from "@/lib/stripe";
import type { ClubFormat } from "@/lib/club-format";
import { chargeCurrencyRefusal } from "@/lib/stripe-charge-currency";
import { ownCardRefundMade, STRIPE_REFUND_EXCEEDS_CAPTURED_MESSAGE } from "@/lib/payment-transaction-status";
import {
  alertRefusedCardRefund,
  inlineRefundAfterAttempt,
  refundSliceCents,
  type InlineRefundRead,
} from "@/lib/refused-card-refund-retry";

export type BookingModificationPaymentContext = {
  pendingRefundAmountCents: number;
  /**
   * #3653: non-null when the refund comes out of a group organiser's combined
   * card payment; its debt was written under the edit's
   * `BookingModification` key (`reserveOrganiserChildModificationRefund`).
   */
  organiserChildRefund: { amountCents: number } | null;
  paymentId: string | null;
  /**
   * WHAT THIS EDIT ASKS FOR, AND WHAT ASKING FOR IT WILL ABSORB (#3371).
   *
   * A plain `additionalAmountCents: number` used to live here, and it is the
   * shape the money leaked through twice: minting this ask retires every other
   * live one on the payment, so a figure sized without them deletes their unpaid
   * balance. `AdditionalAsk` can only be built by `@/lib/additional-payment-ask`,
   * and every constructor that can return a positive one is handed the payment
   * whose ask is about to be retired - so a future writer cannot hand the minter
   * a bare delta, and cannot record the total without the carried part beside
   * it.
   *
   * Paths that ask for nothing through this instrument - a reduction, a Xero-only
   * edit - pass `NO_ADDITIONAL_ASK`, which is zero and therefore never mints.
   * A caller that also needs a plain number for an email, a response body or the
   * Xero leg keeps its own field for it; those are different figures and the
   * Xero one must NOT carry a superseded Stripe balance.
   */
  additionalAsk: AdditionalAsk;
  /**
   * #3954: the unpaid asks this edit's price reduction retired inside its
   * transaction (`retireUnpaidAskChain`). The minter cancels them at Stripe
   * after commit, before it mints any smaller ask. Empty for every other edit.
   */
  retiredAdditionalAsks: readonly RetiredAdditionalAsk[];
  hasSucceededPayment: boolean;
  /**
   * #3181: whether this booking's PRIMARY Xero invoice had already been issued
   * when this edit dispatched. Read only when the mint FAILS, to freeze the
   * edit's own answer on the recovery row - the replay that later raises the
   * deferred supplementary invoice must bill what the edit decided, not what is
   * true when the cron reaches it. Required rather than optional so a new caller
   * cannot omit it into a silent `false` (`INV-SSOT`).
   *
   * `null` ONLY from the recovery replay's own re-entry, where the recovery row
   * already exists and this value is therefore never written. It is not a third
   * answer to the question; it is "the row that carries the answer is already
   * there". Every ordinary edit path passes the boolean it fed
   * `queueXeroBookingEditSettlement`.
   */
  hasIssuedXeroInvoice: boolean | null;
  paymentCustomerId: string | null;
  memberEmail: string;
  memberName: string;
  /** The owner's first name, as `bookingOwner()` projects it (#3369). */
  memberFirstName: string;
  /**
   * The booking OWNER's member id, or null when the booking is owned by an
   * `Organisation` (#3369). `memberEmail` and `memberName` beside it are the
   * owner's person-shaped projection and are never empty, which is why the
   * settlement email still reaches a school.
   */
  memberId: string | null;
  bookingModificationId: string;
  /**
   * #3530: the itemised lines this edit stored on its modification row, or
   * null when it stored none - carried out so the audit row can list them.
   */
  priceLines: ModificationLine[] | null;
};

export async function drainSupersededPrimaryIntents({
  bookingId,
  supersededPrimaryPaymentIntents,
}: {
  bookingId: string;
  supersededPrimaryPaymentIntents: { length: number };
}): Promise<void> {
  if (supersededPrimaryPaymentIntents.length === 0) return;
  try {
    await processPaymentRecoveryOperations({
      limit: supersededPrimaryPaymentIntents.length,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to immediately process queued Stripe payment recovery operations",
    );
  }
}

/**
 * #4057: what an edit's after-commit refund came to. `refundDestination` is
 * the one answer the "Booking Modified" email names (`bookingModifiedRefundSentence`):
 * an organiser-card refund is `organiser_card` only when its debt says Stripe
 * made it, otherwise `organiser_card_pending`. #4070: an own-card refund is
 * `own` only when `ownCardRefundMade` says so, otherwise `own_card_pending`.
 */
export type BookingModificationRefundOutcome = {
  stripeRefundId: string | undefined;
  refundDestination: BookingModifiedRefundDestination;
};

export async function executeBookingModificationRefund({
  format,
  bookingId,
  result,
  idempotencyKeyPrefix,
  failureMessage,
  recoveryFailureMessage,
}: {
  format: ClubFormat;
  bookingId: string;
  result: BookingModificationPaymentContext;
  idempotencyKeyPrefix: string;
  failureMessage: string;
  recoveryFailureMessage: string;
}): Promise<BookingModificationRefundOutcome> {
  if (result.pendingRefundAmountCents <= 0 || !result.paymentId) {
    // #4057: an organiser child's refund that was not run here is still owed.
    return { stripeRefundId: undefined, refundDestination: result.organiserChildRefund ? "organiser_card_pending" : "own" };
  }

  // #3653: an organiser-settled child's edit wrote its refund debt before it
  // committed (`reserveOrganiserChildModificationRefund`). Run THAT row now; the
  // child has no transaction of its own for the path below to refund. A row
  // that is missing is logged, never replaced by the ordinary path, which would
  // find nothing to refund and close its own recovery as done.
  // #4057: made only once the debt's own status, re-read after the run and
  // outside any transaction, says so (`runOrganiserChildRefundDebtNow`).
  if (result.organiserChildRefund) {
    // #4057: the edit has committed, so a failed read is logged, not thrown, and the debt stays owed.
    const debt = await prisma.paymentRecoveryOperation
      .findUnique({
        where: { idempotencyKey: buildOrganiserChildModificationRefundKey(result.bookingModificationId) },
        select: { id: true },
      })
      .catch((err: unknown) => {
        logger.error({ err, bookingId }, "Could not read the organiser child refund debt after the edit committed (#4057)");
        return undefined;
      });
    if (debt === null) logger.error({ bookingId }, "Organiser child refund debt missing after the edit committed (#3653)");
    const made = debt ? await runOrganiserChildRefundDebtNow(debt.id, format) : false;
    return { stripeRefundId: undefined, refundDestination: made ? "organiser_card" : "organiser_card_pending" };
  }

  // The exact prefix this route uses (#1152): recovery retries replay the
  // identical Stripe keys, so a refund that succeeded on Stripe without being
  // recorded is replayed, never re-minted.
  const stripeKeyPrefix = `${idempotencyKeyPrefix}_${result.bookingModificationId}`;
  const paymentId = result.paymentId;
  const keepOwed = (amountCents: number, allocationPlan?: RefundAllocationSlice[]) =>
    enqueueBookingModificationRefundRecovery({
      bookingId,
      paymentId,
      bookingModificationId: result.bookingModificationId,
      amountCents,
      stripeKeyPrefix,
      allocationPlan,
    }).catch((enqueueErr) => {
      logger.error({ err: enqueueErr, bookingId }, recoveryFailureMessage);
      return null;
    });

  const keepUnmade = async (read: InlineRefundRead) => {
    if (read.unmadeCents <= 0) return;
    const queued = await keepOwed(refundSliceCents(read.plan), read.plan);
    // #4117: when no row could be written, the alert is the only record.
    if (read.refusedCents > 0 && (queued === null || queued?.created)) {
      await alertRefusedCardRefund({
        bookingId,
        paymentIntentId: read.refused[0]?.paymentIntentId || queued?.paymentIntentId || "",
        refusedCents: read.refusedCents,
      }, format);
    }
  };

  let plan: RefundAllocationSlice[] | undefined;
  try {
    // #3984: freeze before Stripe; a webhook may record an unrecorded refund
    // before recovery runs, but must never shift its slice amount and key.
    const planned = await planStripeRefundAllocation({ paymentId, amountCents: result.pendingRefundAmountCents });
    if (planned.plannedAmountCents < result.pendingRefundAmountCents) {
      throw new Error(STRIPE_REFUND_EXCEEDS_CAPTURED_MESSAGE);
    }
    plan = planned.slices;
    const refundResult = await refundPaymentTransactions({
      format,
      paymentId,
      amountCents: result.pendingRefundAmountCents,
      allocation: plan,
      // #1507: build the Stripe metadata from the shared helper so a recovery
      // replay (which reconstructs this same reason from the stored key prefix)
      // sends a byte-identical body and Stripe replays the original refund
      // instead of rejecting the reused idempotency key.
      metadata: buildBookingModificationRefundMetadata(bookingId, bookingModificationRefundReasonForKeyPrefix(idempotencyKeyPrefix)),
      // Each edit gets its own prefix: two equal reductions must create two
      // refunds, while this edit's recovery replays its original request.
      idempotencyKeyPrefix: stripeKeyPrefix,
    });
    const read = inlineRefundAfterAttempt(plan, refundResult);
    if (read.refusedCents > 0) logger.error({ bookingId, refusedCents: read.refusedCents }, failureMessage);
    await keepUnmade(read);
    return {
      stripeRefundId: refundResult.refunds[0]?.refundId,
      refundDestination: ownCardRefundMade(refundResult.refunds) ? "own" : "own_card_pending",
    };
  } catch (refundErr) {
    logger.error(
      { err: refundErr, bookingId, amount: result.pendingRefundAmountCents },
      failureMessage,
    );
    if (plan) {
      // Made slices stay marked, refusals move keys, unanswered slices keep
      // theirs: a made-but-unrecorded refund must replay the original request.
      await keepUnmade(inlineRefundAfterAttempt(plan, { error: refundErr }));
    } else {
      // Planning failed before Stripe was asked: keep today's whole debt.
      await keepOwed(result.pendingRefundAmountCents);
    }
    // #4070: not made here, so the email says it is on its way.
    return { stripeRefundId: undefined, refundDestination: "own_card_pending" };
  }
}

/** What a door's after-commit mint of its additional ask came to. */
export type ModificationAdditionalAskMint = {
  /** Offered only while the minted ask is still live (#3954 round 7). */
  additionalPaymentClientSecret: string | undefined;
  /** Returned even when retired, for the edit's Xero leg (round 8). */
  additionalPaymentIntentId: string | undefined;
  /**
   * #3954 round 9: minted, but a reduction retired it before it was offered -
   * the same liveness that withholds the secret. Nothing is owed on it. Final
   * review: also a re-issue a later reduction netted off before the door
   * minted it (`reissueNotMinted`).
   */
  additionalAskRetired: boolean;
};

const NOTHING_MINTED: ModificationAdditionalAskMint = {
  additionalPaymentClientSecret: undefined,
  additionalPaymentIntentId: undefined,
  additionalAskRetired: false,
};

/** Retired, nothing owed or offered: a netted-off re-issue (#3954), or a booking ended since its edit (#4316). */
const ASK_RETIRED_UNMINTED: ModificationAdditionalAskMint = { ...NOTHING_MINTED, additionalAskRetired: true };

/**
 * #3954 final review: what a door that did not mint its re-issue reports. A
 * later reduction that netted the waiting re-issue off retired it - that
 * reduction's own message told the member - so it is not named as due. A
 * runner that claimed it, or a later increase that folded it in, still asks
 * for that money, so it stays named.
 */
function reissueNotMinted(
  recovery: Pick<ReissuedAskRecovery, "status" | "lastError"> | null,
): ModificationAdditionalAskMint {
  const nettedOff =
    recovery?.status === PaymentRecoveryOperationStatus.SUCCEEDED &&
    recovery.lastError === PENDING_ASK_NETTED_BY_REDUCTION_NOTE;
  return nettedOff ? ASK_RETIRED_UNMINTED : NOTHING_MINTED;
}

function mintedAsk(pi: { id: string; client_secret: string | null }, live: boolean): ModificationAdditionalAskMint {
  return {
    additionalPaymentClientSecret: live ? (pi.client_secret ?? undefined) : undefined,
    additionalPaymentIntentId: pi.id,
    additionalAskRetired: !live,
  };
}

/**
 * #3954 round 9: the additional figure a member-facing message may name as
 * due. An ask a reduction retired before it was offered is owed by nobody -
 * that reduction's own message told the member - so it is never named.
 */
export function additionalAmountToName(
  amountCents: number,
  mint: Pick<ModificationAdditionalAskMint, "additionalAskRetired">,
): number {
  return mint.additionalAskRetired ? 0 : amountCents;
}

/**
 * Mint the additional PaymentIntent that collects a booking edit's price
 * increase, and write the PENDING `ADDITIONAL` PaymentTransaction the club's
 * whole additional-payment machinery keys off - the chase reminders, the resend
 * service, the member's /pay link and the Xero supplementary invoice's
 * wait-for-payment.
 *
 * #3170 RE-ENTERS THIS RATHER THAN ADDING A COLLECTION PATH. A completed
 * `EDIT_FINANCIAL_REVIEW` task whose officer decided the MEMBER owes the club
 * comes through here, so a review charge and an ordinary price increase are the
 * same instrument, chased by the same cron and reconciled the same way. The epic
 * forbids a fourth settlement mechanism, and this is the third's charging half.
 *
 * IT PASSES EDIT-SCOPED KEYS, NOT TASK-SCOPED ONES, and an earlier draft of this
 * docblock said the opposite. The owner's 30 Aug 2026 decision is that one
 * booking edit raises ONE request, so both of a review's two tasks contribute
 * shares to a single ask anchored to the `BookingModification`. Task-scoping
 * these keys would mint a second intent for the second share, and minting queues
 * every other outstanding additional on that payment for cancellation - which is
 * how $230 of debt became a $30 ask. `payment-recovery-keys.ts` holds the full
 * reasoning and both builders.
 *
 * IT TAKES AN `AdditionalAsk`, NOT A NUMBER (#3371). Because minting retires
 * every other live ADDITIONAL intent on the payment, the figure has to include
 * their unpaid balance AND say how much of itself that balance is - this row is
 * the only place that fact survives, since the intents it came from are about to
 * be cancelled. Pairing the two in one value that only
 * `@/lib/additional-payment-ask` can build is what stops a future caller doing
 * one and not the other. `INV-PAY-098` is the rule.
 *
 * IT ASKS NOTHING OF A BOOKING THAT HAS ENDED (#4316, `INV-ADDPAY-044`): it
 * re-reads the booking before the provider call and after its row write, and
 * retires what a cancel committing in between could not see.
 *
 * THE CALLER READS THE RESULT, and must. This function swallows a provider
 * failure by design - the ordinary edit path has to return the member's saved
 * change, and the recovery row it writes is the retry. A caller for whom
 * "minted nothing" is not an acceptable outcome (the review charge's recovery
 * replay is the one such caller) has to test `additionalPaymentIntentId` rather
 * than wait for an exception that never comes.
 */
export async function createModificationAdditionalPaymentIntent(
  params: {
    bookingId: string;
    result: BookingModificationPaymentContext;
    failureMessage: string;
    /** The club's format (#3565), resolved before any transaction by the caller. */
    format: ClubFormat;
  } & (
    | {
        /**
         * #4036 review: an ordinary edit's door. Its Stripe key and its reason
         * are both derived from it here (`ordinaryAskDoorRequest`), so a key and
         * a reason from different doors cannot be written.
         */
        door: OrdinaryAskDoor;
        reviewCharge?: never;
      }
    | {
        door?: never;
        /**
         * #3170: a review charge's request, its key and reason built by its
         * own sync. `recoveryIdempotencyKey` is the dedup key for the durable
         * retry: `buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey`,
         * EDIT-scoped - a different namespace from the ordinary edit's key over
         * the same `BookingModification`, so the two paths' debts stay separate
         * rows, but deliberately the SAME row for both review tasks of one edit,
         * because they are two shares of one debt. The ordinary doors use the
         * modification-scoped default, one per modification by construction.
         */
        reviewCharge: { reason: string; idempotencyKey: string; recoveryIdempotencyKey: string };
      }
  ),
): Promise<ModificationAdditionalAskMint> {
  const { bookingId, result, failureMessage, format } = params;
  const recoveryIdempotencyKey = params.reviewCharge?.recoveryIdempotencyKey;
  const { reason, idempotencyKey } = params.reviewCharge
    ? params.reviewCharge
    : ordinaryAskDoorRequest(params.door, bookingId, result.bookingModificationId);
  // #3954: the asks this edit's reduction retired are cancelled at Stripe
  // first, whether or not it owes a smaller one: their rows were retired, and
  // their cancellations queued, inside the edit's transaction.
  await cancelRetiredAdditionalAsksNow({
    format,
    bookingId,
    retired: result.retiredAdditionalAsks,
  });

  if (
    result.additionalAsk.amountCents <= 0 ||
    // #3954: a re-issued ask was already asked of this card, so a credit-paid
    // ($0) booking whose reduction captured nothing still mints it.
    !(result.hasSucceededPayment || result.additionalAsk.reissuesUnpaidAsk) ||
    !result.paymentId
  ) {
    return NOTHING_MINTED;
  }

  // #4316: a booking ended since the edit committed is asked nothing, and owes nothing.
  if (await bookingEndedBeforeAskMint(bookingId, result.bookingModificationId)) return ASK_RETIRED_UNMINTED;

  // #3954 review round 4: a RE-ISSUED ask's recovery was written in the edit's
  // own transaction (`queueReissuedAskRecovery`). This mint runs under that
  // row's Stripe key and completes the row with its own write - unless a later
  // reduction netted it off or the runner claimed it after its grace, in which
  // case whoever moved it owns the ask and this mints nothing.
  const reissueRecovery = result.additionalAsk.reissuesUnpaidAsk
    ? await readReissuedAskRecovery(result.bookingModificationId)
    : null;
  if (reissueRecovery && reissueRecovery.status !== PaymentRecoveryOperationStatus.PENDING) {
    logger.info(
      { bookingId, bookingModificationId: result.bookingModificationId, operationId: reissueRecovery.id, status: reissueRecovery.status },
      "A re-issued additional ask's recovery has moved on since the edit committed; the door's mint leaves it to the recovery (#3954)",
    );
    return reissueNotMinted(reissueRecovery);
  }
  const stripeIdempotencyKey = reissueRecovery?.paymentIntentId ?? idempotencyKey;

  // Durable retry (#1096): a price increase with no instrument to collect it
  // must never be lost. One spelling for both ways a mint can fail below.
  const paymentId = result.paymentId;
  const keepTheDebt = () =>
    enqueueAdditionalPaymentIntentRecovery({
      bookingId,
      paymentId,
      idempotencyKey:
        recoveryIdempotencyKey ??
        buildAdditionalIntentRecoveryIdempotencyKey(result.bookingModificationId),
      amountCents: result.additionalAsk.amountCents,
      stripeIdempotencyKey,
      // #3181: the EDIT's answer, frozen here because this is the last moment it
      // is known. The replay reads it back rather than re-deriving one.
      hadIssuedXeroInvoice: result.hasIssuedXeroInvoice,
    }).catch((enqueueErr) =>
      logger.error({ err: enqueueErr, bookingId }, "Failed to enqueue additional PaymentIntent recovery"),
    );

  // #3567: refused before the customer lookup and the mint, but the DEBT is kept
  // (re-review): the recovery row is written, and the recovery runner leaves it
  // unclaimed until an administrator sets a currency cards can be charged in.
  const chargeRefusal = chargeCurrencyRefusal(format);
  if (chargeRefusal) {
    logger.error({ bookingId, currencyCode: chargeRefusal.currencyCode }, `${failureMessage}: ${chargeRefusal.message}`);
    await keepTheDebt();
    return NOTHING_MINTED;
  }

  try {
    if (reissueRecovery) {
      // #3954 round 6: the ONE request both of a re-issue's minters send
      // (`planReissuedAskMint`) - sized on the outstanding ask as it stands
      // now, exactly as the recovery's replay sizes it, so an ask minted since
      // the reduction (an officer's review charge, say) is carried rather than
      // superseded away, and the two never answer each other with an
      // `idempotency_error`. The row, the recovery's completion and the
      // supersede's durable rows commit together, or not at all (see above).
      const current = await readAskMintPayment(paymentId);
      // Round 7: the customer resolved exactly as the recovery runner resolves
      // it, so the two minters of this key send one request.
      const customerId = await resolveAskCustomerId(current);
      const plan = planReissuedAskMint({
        bookingId,
        recovery: { amountCents: reissueRecovery.amountCents, stripeKey: reissueRecovery.paymentIntentId },
        payment: current,
      });
      const pi = await mintReissuedAskIntent({
        format,
        plan,
        customerId,
        recoveryCreatedAt: reissueRecovery.createdAt,
      });
      const superseded = await writeReissuedAskUnderRecovery(reissueRecovery, pi.id, async (store) => {
        await assertAdditionalAskSizingCurrent(store, paymentId, plan.ask);
        await upsertPaymentIntentTransaction({
          paymentId,
          kind: PaymentTransactionKind.ADDITIONAL,
          paymentIntentId: pi.id,
          amountCents: plan.ask.amountCents,
          carriedAskCents: plan.ask.carriedCents,
          status: PaymentStatus.PENDING,
          reason: plan.reason,
          stripeCustomerId: mintedIntentCustomerId(pi, customerId),
          // #3954 round 8: the reducing edit whose re-issue this is, so a later
          // reduction that retires it names this edit.
          bookingModificationId: result.bookingModificationId,
          store,
        });
        return queueSupersededAdditionalIntentCancellationRows({
          bookingId,
          paymentId,
          newPaymentIntentId: pi.id,
          store,
        });
      });
      if (superseded === null) {
        logger.warn(
          { bookingId, bookingModificationId: result.bookingModificationId, paymentIntentId: pi.id },
          "A re-issued additional ask's recovery moved while the door minted it (#3954); nothing written - the recovery's owner asks the member",
        );
        // Final review: whoever moved it decides whether it is still owed. A
        // failed re-read names it, as before.
        const moved = await readReissuedAskRecovery(result.bookingModificationId).catch((err) => {
          logger.error({ err, bookingId }, "Could not re-read a re-issued ask's recovery; the email names it (#3954)");
          return null;
        });
        return reissueNotMinted(moved);
      }
      await cancelSupersededAdditionalIntentsNow({ format, bookingId, paymentId, queued: superseded, newPaymentIntentId: pi.id });
      // #4316: a cancel that committed while this minted could not see it.
      if (await retireAskOnEndedBooking({ format, bookingId, paymentId, paymentIntentId: pi.id })) return ASK_RETIRED_UNMINTED;
      // Decision A (#3954): the smaller ask's own invoice, waiting on it - only
      // while it is still live (round 7): a reduction may have retired it during
      // the cancels above, and named this edit for it. Round 8: only the secret
      // is withheld then; the minted intent's id is still returned.
      const live = await queueReissuedAskSupplementaryInvoice({
        bookingId,
        bookingModificationId: result.bookingModificationId,
        paymentIntentId: pi.id,
      });
      return mintedAsk(pi, live);
    }

    let customerId: string | undefined;
    let pi: Awaited<ReturnType<typeof createPaymentIntent>>;
    if (recoveryIdempotencyKey) {
      // #3170: a review charge's request. Its replay re-enters this function
      // (`syncEditFinancialReviewChargeRequest`), so both of its minters send
      // this same request.
      customerId = result.paymentCustomerId ?? undefined;
      if (!customerId) {
        const customer = await findOrCreateCustomer({
          email: result.memberEmail,
          name: result.memberName,
          memberId: result.memberId,
        });
        customerId = customer.id;
      }
      pi = await createPaymentIntent({
        format,
        amountCents: result.additionalAsk.amountCents,
        customerId,
        metadata: {
          bookingId,
          type: ADDITIONAL_ASK_INTENT_TYPE,
          reason,
        },
        idempotencyKey: stripeIdempotencyKey,
      });
    } else {
      // #4036: an ordinary increase's request is the one its recovery replays
      // (`planOrdinaryAskMint`) - the same key, amount, metadata and reason, and
      // the customer resolved exactly as the runner resolves it
      // (`resolveAskCustomerId`, the organisation included) - so a lost reply's
      // replay is answered with this intent, never an `idempotency_error`. The
      // stored customer is that rule's first answer, and this edit has just
      // read it; the owner is read only when there is none.
      customerId =
        result.paymentCustomerId ?? (await resolveAskCustomerId(await readAskMintPayment(paymentId)));
      ({ intent: pi } = await mintOrdinaryAskIntent({
        format,
        plan: planOrdinaryAskMint({
          bookingId,
          bookingModificationId: result.bookingModificationId,
          stripeKey: stripeIdempotencyKey,
          frozenAmountCents: result.additionalAsk.amountCents,
          amountCents: result.additionalAsk.amountCents,
        }),
        customerId,
        recovery: null,
      }));
    }

    // THE NEW INTENT'S OWN ROW IS WRITTEN FIRST, AND THE ORDER IS LOAD-BEARING
    // (#3340 fix round). Cancelling a superseded intent reconciles the payment
    // aggregates - both terminal branches of the cancel processor call
    // `reconcilePaymentAggregates` - and that reconcile mirrors the LATEST
    // ADDITIONAL transaction into `Payment.additionalAmountCents` and
    // `additionalPaymentIntentId`. Run with the cancel first, the latest
    // ADDITIONAL row is still the one being retired, so the reconcile writes the
    // OLD, smaller ask back over the payment and points it at an intent that has
    // just been cancelled. The line below normally corrects that a moment later;
    // a process death in between does not, and leaves a booking whose price has
    // risen reading the superseded figure with no live instrument behind it.
    //
    // Writing the row first cannot select itself for cancellation: the
    // `findMany` in `queueSupersededAdditionalIntentCancellationRows` excludes
    // `newPaymentIntentId` explicitly. The cost is one database upsert of
    // latency before the old secret dies, which is far inside the window the
    // synchronous cancel exists to close.
    const queued = await withAdditionalAskQueueTransaction(paymentId, result.additionalAsk, async (store) => {
      await upsertPaymentIntentTransaction({
        paymentId,
        kind: PaymentTransactionKind.ADDITIONAL,
        paymentIntentId: pi.id,
        amountCents: result.additionalAsk.amountCents,
        // #3371: the row records what this ask absorbed from the intents the
        // cancel below is about to retire. Written in the SAME upsert as the
        // amount, from the same value, so the two cannot be sized from different
        // inputs and the provenance cannot be forgotten. Once those rows are
        // cancelled it is not recoverable from anything.
        carriedAskCents: result.additionalAsk.carriedCents,
        status: PaymentStatus.PENDING,
        reason,
        stripeCustomerId: customerId,
        store,
        // #3954 round 7: the edit's own invoice answer, on the row it asks with,
        // so a later reduction knows which invoice billed this money. Round 8:
        // and the edit itself, so a reduction that retires the row names it.
        // A member's price ask only: a review charge is never set against.
        ...(result.hasIssuedXeroInvoice !== null ? { hadIssuedXeroInvoice: result.hasIssuedXeroInvoice } : {}),
        ...(recoveryIdempotencyKey ? {} : { bookingModificationId: result.bookingModificationId }),
      });
      return queueSupersededAdditionalIntentCancellationRows({
        bookingId, paymentId, newPaymentIntentId: pi.id, store,
      });
    });
    await cancelSupersededAdditionalIntentsNow({
      format, bookingId, paymentId, queued, newPaymentIntentId: pi.id,
    });

    // #4316: a cancel that committed while this minted could not see it.
    if (await retireAskOnEndedBooking({ format, bookingId, paymentId, paymentIntentId: pi.id })) return ASK_RETIRED_UNMINTED;

    // #3954 round 6: the re-issues this increase folded in are asked for on
    // this intent now, so their own invoices wait on it. An ordinary edit's ask
    // only: a review charge folds nothing.
    // Round 7: only while this intent is still live - a reduction may have
    // retired it during the cancels above, and then no secret is offered.
    // Round 8: but its id still goes back to the edit's Xero leg, which parks
    // the increase's own invoice on it (retired with the intent) rather than
    // raising it unpaid; the reduction named this edit when it retired the row.
    const live = recoveryIdempotencyKey
      ? true
      : await queueFoldedReissuedAskInvoices({
          bookingId,
          increaseModificationId: result.bookingModificationId,
          paymentIntentId: pi.id,
        });

    return mintedAsk(pi, live);
  } catch (piErr) {
    logger.error({ err: piErr, bookingId }, failureMessage);
    // The recovery cron re-creates the intent with this same modification-scoped
    // Stripe idempotency key, so route retry and cron retry never double-mint.
    await keepTheDebt();
    return NOTHING_MINTED;
  }
}
