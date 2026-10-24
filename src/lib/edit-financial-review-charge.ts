import "server-only";

import {
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";

import {
  canAskCardForReviewCharge,
  refusesReviewChargeForCancellation,
} from "@/lib/booking-payment-state";
import { paidByOrganiserCard, paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import {
  REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
  REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE,
  REVIEW_CHARGE_BOOKING_CANCELLED_ORGANISER_MESSAGE,
  REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
  REVIEW_CHARGE_ORGANISER_PAID_BY_BANK_MESSAGE,
  REVIEW_CHARGE_ORGANISER_PAID_MESSAGE,
  REVIEW_CHARGE_REQUEST_ALREADY_PAID_MESSAGE,
  REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
} from "@/lib/edit-financial-review-charge-refusals";
import {
  findEditReviewChargeRequest,
  hasIssuedSupplementaryInvoice,
  recordShortEditReviewChargeInvoice,
  sumEditReviewChargeSharesCents,
  type EditReviewChargeStore,
} from "@/lib/edit-financial-review-charge-request";
import {
  syncEditFinancialReviewChargeRequest,
  type EditReviewChargeMember,
  type EditReviewChargeSyncOutcome,
} from "@/lib/edit-financial-review-charge-sync";
import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { enqueueEditFinancialReviewChargeRecovery } from "@/lib/payment-recovery";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import {
  resolvedSupplementaryInvoiceOperationsWhere,
  supplementaryInvoiceStillComingWhere,
} from "@/lib/xero-supplementary-invoice-statuses";
import {
  enqueueEditReviewChargeInvoiceInTransaction,
  kickQueuedXeroOutboxOperationsIfConnected,
  type XeroSupplementaryInvoiceEnqueueOutcome,
} from "@/lib/xero-operation-outbox";
import type { Prisma } from "@prisma/client";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import type { ClubFormat } from "@/lib/club-format";

// #3402: the sync moved to its own module with the raise claim around it;
// re-exported so the recovery replay and existing importers keep one path.
// The member type lives with the sync, which takes it as a parameter, so the
// dependency points one way.
export { syncEditFinancialReviewChargeRequest };
export type { EditReviewChargeMember };

/**
 * #3170 (epic #2797): the one direction of a settled review that ASKS FOR MONEY,
 * and the rule that ONE BOOKING EDIT RAISES ONE REQUEST.
 *
 * ## Why this is its own module
 *
 * `edit-financial-review-settlement.ts` answers "where does a confirmed review
 * amount GO", and until this issue every answer was a way of handing money back:
 * a card refund, a ledger mirror of a hand-back, or account credit. #3032 parked
 * only guest REMOVALS, which can only ever owe the member, so refund-shaped was
 * enough. #3170 is the first child that parks an edit which moves the price UP -
 * a check-out extension, or a guest added - and a charge shares none of that
 * machinery: no refund allocation, no cap against captured cash, no credit
 * anchor, and no `REFUNDED` event.
 *
 * Keeping it beside them as a fourth branch was tried and is what the file-size
 * ratchet caught. It is also the worse arrangement on its merits: the one thing
 * that must never happen here is a charge quietly taking a refund path, and the
 * strongest guard against that is that the two live in different modules and
 * share no code at all. The union that picks between them is still ONE function,
 * in the settlement module, so there is still exactly one place that decides.
 *
 * ## ONE EDIT, ONE REQUEST (owner decision, #3170, 30 Aug 2026)
 *
 * One edit can raise TWO review tasks - one per guest strand whose history could
 * not be read - and an officer may settle both as money owed to the club. The
 * first #3170 round minted one request per TASK, and that lost money outright:
 * minting an additional PaymentIntent queues every OTHER outstanding `ADDITIONAL`
 * transaction on that payment for cancellation, and `reconcilePaymentAggregates`
 * carries a single `additionalAmountCents` rather than a sum. $200 then $30
 * collected $30 of $230, with both tasks COMPLETED and both audited as settled.
 *
 * The owner's answer: both reviews contribute to a SINGLE request for the total,
 * each task recording its own share. So:
 *
 *   * THE REQUEST is anchored to the EDIT. One `BookingModification`, one Stripe
 *     PaymentIntent, one PENDING `ADDITIONAL` PaymentTransaction, one figure on
 *     the member's pay link. A second settlement RAISES that request's amount
 *     rather than minting a second one, which is why nothing is superseded and
 *     `queueSupersededAdditionalIntentCancellations` never runs between two shares
 *     of one edit.
 *   * THE SHARE stays anchored to the TASK: its `amountCents`, its
 *     `settlementDirection` and its audit entry are untouched by this, so the
 *     combined figure stays explainable back to the two decisions that produced
 *     it.
 *   * THE TOTAL IS DERIVED, NEVER INCREMENTED - `sumEditReviewChargeSharesCents`
 *     re-reads the settled shares every time. Two officers closing two tasks at
 *     the same moment therefore cannot double-count: each share is counted once
 *     because it is counted from the row it lives on. See
 *     `syncEditFinancialReviewChargeRequest` for why neither of them can lose a
 *     share either.
 *
 * ## AND IT CARRIES WHAT ITS MINT RETIRES (#3371, owner decision 13 Sep 2026)
 *
 * Those bullets cover two shares of ONE edit, the only case #3170 saw. A booking
 * can also carry an unpaid ask raised by a DIFFERENT edit, and minting this one
 * cancels it - which is how $260 across two parked edits collected $60. The ask
 * is now the share sum PLUS that balance, built by the module the ordinary path
 * has used since #3340 and stored beside the sum, never inside it. The rule is
 * `INV-PAY-098` and is not restated here.
 *
 * ## What it is NOT
 *
 * It is not a fourth settlement mechanism, which the epic forbids outright.
 * `createModificationAdditionalPaymentIntent` is the same function every ordinary
 * booking-edit price increase goes through, so the instrument, the PENDING
 * `ADDITIONAL` PaymentTransaction row, the chase reminders, the member's pay link
 * and the Xero supplementary invoice's wait-for-payment are all the existing
 * ones.
 *
 * And NOTHING IS TAKEN FROM THE MEMBER'S CARD HERE. The completion mints or
 * raises the REQUEST; the member pays it themselves, exactly as they would for an
 * ordinary extension. That is why a provider failure is recoverable rather than a
 * lost charge, and why the admin copy is allowed to say so.
 */


/**
 * How the club will ask, decided from the booking's own facts rather than offered
 * as a choice.
 *
 * A DISCRIMINATED UNION on `collectVia`, and deliberately so: the card arm cannot
 * be constructed without a payment to hang the `ADDITIONAL` transaction off and a
 * member to bill, because both are things `createModificationAdditionalPaymentIntent`
 * requires. Before this they were nullable fields with `?? actingMemberId` and
 * `?? ""` fallbacks at the call site, which would have minted a Stripe customer
 * for the ADMIN with an empty email - dead in practice, because a booking's member
 * is required, but a wrong answer written down where a refusal belongs.
 */
export type EditReviewChargeRoute =
  | {
      kind: "additional-charge";
      /**
       * The booking's payment is one the card may be asked against
       * (`canAskCardForReviewCharge`: captured by card, or a settled booking
       * paid wholly with credit, #3947), so an additional PaymentIntent is
       * minted against it - or, when this edit already has one, raised to the
       * new total.
       */
      collectVia: "stripe";
      bookingModificationId: string;
      paymentId: string;
      member: EditReviewChargeMember;
      /**
       * #3181: whether this booking's PRIMARY Xero invoice had already been
       * issued when the route was chosen - carried rather than re-read, because
       * a mint failure freezes it on the recovery row and the replay bills what
       * the settlement decided rather than what is true when the cron arrives.
       * Only the card route carries it: the `invoice` route mints no intent, so
       * it enqueues no recovery row for a replay to read.
       */
      hasIssuedXeroInvoice: boolean;
    }
  | {
      kind: "additional-charge";
      /**
       * The internet-banking booking: there is no intent to mint, so the
       * supplementary Xero invoice IS the ask and the club's existing
       * additional-payment chasing carries it.
       */
      collectVia: "invoice";
      bookingModificationId: string;
      paymentId: string | null;
      member: EditReviewChargeMember | null;
    };

/**
 * Decide how a charge will be collected, or throw the refusal that stops it.
 *
 * MUST be called BEFORE the caller's status claim and inside its transaction,
 * exactly as the refund routes are: a refusal that fired after the claim would
 * leave a task COMPLETED with nothing collected, which is the "pretends money
 * moved" failure `INV-PAY-051` forbids, in the direction where the club is the
 * one left short.
 */
export async function chooseEditReviewChargeRoute({
  bookingModificationId,
  booking,
  bookingPayment,
  member,
  hasIssuedXeroInvoice,
  store,
}: {
  bookingModificationId: string | null;
  /**
   * #3653, #3949: whether the group organiser paid for this booking (`paidByOrganiserCard`,
   * `paidByOrganiserInternetBanking`). #3947: and its `status`, half of the card question
   * (`canAskCardForReviewCharge`), and the whole of the cancelled-booking refusal (#4272).
   */
  booking: { status: string; organiserSettled: boolean; parentBookingId: string | null };
  bookingPayment: {
    id: string;
    status: string;
    amountCents: number | null;
    refundedAmountCents: number | null;
    source: PaymentSource;
    stripeCustomerId: string | null;
  } | null;
  member: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  } | null;
  hasIssuedXeroInvoice: boolean;
  store: EditReviewChargeStore;
}): Promise<EditReviewChargeRoute> {
  if (!bookingModificationId) {
    throw new ManualBookingPaymentError(
      REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
      409,
    );
  }
  // #4272 (owner decision 21 Oct 2026): a CANCELLED booking is refused before
  // any route is chosen, and before every other refusal that reads its payment:
  // the cancellation is what makes every instrument wrong. A card ask on it is
  // one the member cannot pay (`INV-ADDPAY-023`), and the recovery replay skips
  // it, so asking here would leave the inline path and the replay disagreeing.
  // The helper the card question asks refuses it too, so a cancellation landing
  // after this commit stops the sync's mint as well.
  if (refusesReviewChargeForCancellation(booking)) {
    // A joiner the organiser settled, by card or internet banking, is pointed
    // at the organiser, as the organiser-paid refusal below does.
    const organiserSettledJoiner = booking.organiserSettled && booking.parentBookingId != null;
    throw new ManualBookingPaymentError(
      organiserSettledJoiner
        ? REVIEW_CHARGE_BOOKING_CANCELLED_ORGANISER_MESSAGE
        : REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE,
      409,
    );
  }
  // #3653 (`INV-PAY-114`): the organiser paid for this booking by card. Its
  // payment mirror is a slice of the organiser's combined payment, so a card
  // ask would charge the joiner's own card and an invoice would bill the joiner;
  // the edit doors refuse the same increase (`organiserChildChargeRefusal`).
  if (paidByOrganiserCard({ ...booking, payment: bookingPayment })) {
    throw new ManualBookingPaymentError(REVIEW_CHARGE_ORGANISER_PAID_MESSAGE, 409);
  }
  // #3949: so is one the organiser paid for by Internet Banking - refused in the organiser's words, before the
  // no-instrument refusal below would answer it in general ones.
  if (paidByOrganiserInternetBanking({ ...booking, payment: bookingPayment })) {
    throw new ManualBookingPaymentError(REVIEW_CHARGE_ORGANISER_PAID_BY_BANK_MESSAGE, 409);
  }
  // #3947 (owner decision 15 Oct 2026): the review charge's ONE card question,
  // which the sync's mint asks again after the commit - so the two cannot
  // disagree and strand the debt on a replay that never raises. It is the
  // edit doors' `canAskCardForIncrease` (#3502), so a booking paid wholly with
  // credit - a $0 SUCCEEDED card payment - is asked by card, Xero or not; plus
  // the captured-card test this path used before, for a booking outside the
  // settled statuses other than a cancelled one (refused above; the helper's
  // docblock says why the clause stays). `Payment.source` alone
  // is not enough - its schema DEFAULT is STRIPE, so a hand-settled booking
  // carries it with nothing captured behind it. A MEMBER is part of the test
  // rather than a fallback: minting needs somebody to bill, and a booking with
  // none has no card route - it falls to the invoice route, or to the
  // no-instrument refusal below.
  const canChargeCard =
    canAskCardForReviewCharge({ status: booking.status, payment: bookingPayment }) &&
    Boolean(member);
  // An ISSUED Xero invoice is the other instrument. It has to be ISSUED rather
  // than merely possible - with no invoice to add to,
  // `classifyXeroBookingEditSettlement` takes its `none` branch, so the
  // completion would move nothing at all while recording that the club had
  // collected the money.
  if (!canChargeCard && !hasIssuedXeroInvoice) {
    throw new ManualBookingPaymentError(
      REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
      409,
    );
  }

  // #3170: is this edit's ONE request still open to a further share? Both
  // answers below are refusals rather than a second request - see the two
  // message docblocks for why, and why that is not the "refuse until the first
  // is paid" option the owner rejected.
  const existing = bookingPayment
    ? await findEditReviewChargeRequest({
        paymentId: bookingPayment.id,
        bookingModificationId,
        store,
      })
    : null;
  if (existing) {
    if (isCapturedTransactionStatus(existing.status)) {
      throw new ManualBookingPaymentError(
        REVIEW_CHARGE_REQUEST_ALREADY_PAID_MESSAGE,
        409,
      );
    }
    if (
      existing.status !== PaymentStatus.PENDING &&
      existing.status !== PaymentStatus.PROCESSING
    ) {
      throw new ManualBookingPaymentError(
        REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
        409,
      );
    }
  }
  // #3947 review: ONE INSTRUMENT PER EDIT. A share of an edit whose earlier
  // share took the `invoice` route - its supplementary invoice still coming
  // (queued, being sent, or failed and not resolved), and no card request for
  // this edit - stays on that route, so the Xero leg bills both shares on the
  // one invoice. Taking the card here would mint an ask for the edit's whole
  // total beside an invoice that bills at least the earlier share: the member
  // billed twice. Before #3947 a credit-paid booking's shares all took the
  // invoice route; this is the transition #3947 opens. A card-route edit's own
  // invoice always has a card request beside it (the leg defers it until one
  // exists), so it never reaches this check.
  //
  // READ BEFORE THE "already issued" check below, and the order is the
  // guarantee (round 4, concurrency F1). These are two READ COMMITTED
  // statements, and the outbox worker moves a row from still-coming to issued
  // (SUCCEEDED and its link) in ONE commit, under neither `lock(1)` nor the
  // anchor key. Read this way round, every such row is seen by one of the two:
  // still coming at the first read, or already issued by the second, which
  // refuses. The other way round, a commit landing between them reads "no
  // invoice issued" and then "nothing coming", and the share takes the card
  // beside the invoice just sent. An officer's resolve-in-Xero mark moves a
  // FAILED row the same one way (coming -> resolved), so the same order holds;
  // the one mark that moves BACK - withdrawn by the resolve route because a
  // retry of the row is running - leaves that retry on the anchor, which the
  // still-coming read counts as coming in every state of the mark (round 5).
  const joinsQueuedInvoice =
    canChargeCard &&
    existing === null &&
    hasIssuedXeroInvoice &&
    (await hasReviewChargeInvoiceStillComing({ bookingModificationId, store }));
  if (await isReviewChargeInvoiceDone({ bookingModificationId, store })) {
    throw new ManualBookingPaymentError(
      REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
      409,
    );
  }

  if (canChargeCard && !joinsQueuedInvoice && bookingPayment && member) {
    return {
      kind: "additional-charge",
      collectVia: "stripe",
      bookingModificationId,
      paymentId: bookingPayment.id,
      // #3181: this function's own argument, carried forward rather than
      // re-derived downstream, so the charge and any replay of it answer the
      // same question with the same value.
      hasIssuedXeroInvoice,
      member: {
        id: member.id,
        email: member.email,
        name: `${member.firstName} ${member.lastName}`,
        stripeCustomerId: bookingPayment.stripeCustomerId,
      },
    };
  }
  return {
    kind: "additional-charge",
    collectVia: "invoice",
    bookingModificationId,
    paymentId: bookingPayment?.id ?? null,
    member: member
      ? {
          id: member.id,
          email: member.email,
          name: `${member.firstName} ${member.lastName}`,
          stripeCustomerId: bookingPayment?.stripeCustomerId ?? null,
        }
      : null,
  };
}


/**
 * #3947: whether this edit's supplementary invoice is DONE, so no further share
 * may join it or be asked beside it: issued (an active `SUPPLEMENTARY_INVOICE`
 * link, `hasIssuedSupplementaryInvoice`, #3170) or - round 4, money F1 - made by
 * hand in Xero after its operation failed, which an officer records by marking
 * the row resolved (`INV-INT-025`: done, never re-sent and never minted beside).
 * Treating that row as "not coming" sent a later share to the card for the
 * edit's whole total beside the hand-made invoice.
 */
async function isReviewChargeInvoiceDone({
  bookingModificationId,
  store,
}: {
  bookingModificationId: string;
  store: EditReviewChargeStore;
}): Promise<boolean> {
  if (await hasIssuedSupplementaryInvoice({ bookingModificationId, store })) return true;
  const resolved = await store.xeroSyncOperation.findFirst({
    where: resolvedSupplementaryInvoiceOperationsWhere({
      localModel: "BookingModification",
      localId: bookingModificationId,
    }),
    select: { id: true },
  });
  return resolved !== null;
}

/**
 * #3947 review: whether this edit's supplementary invoice is still coming
 * (`supplementaryInvoiceStillComingWhere`): the enqueue's own outstanding read
 * (round 2: `RUNNING` included, which the restate's narrower set missed) plus a
 * FAILED row nobody has resolved, which a Requeue would still send. Asked on
 * the chooser's transaction.
 */
async function hasReviewChargeInvoiceStillComing({
  bookingModificationId,
  store,
}: {
  bookingModificationId: string;
  store: EditReviewChargeStore;
}): Promise<boolean> {
  const queued = await store.xeroSyncOperation.findFirst({
    where: supplementaryInvoiceStillComingWhere({
      localModel: "BookingModification",
      localId: bookingModificationId,
    }),
    select: { id: true },
  });
  return queued !== null;
}

/** #3947: the invoice route's invoice, as queued inside the completion's transaction. */
export type QueuedEditReviewChargeInvoice = {
  queueOperationId: string | null;
  outcome: XeroSupplementaryInvoiceEnqueueOutcome;
  /** The edit's combined total the invoice was asked to bill. */
  totalCents: number;
};

/**
 * #3947 (owner decision 22 Oct 2026, option 2): THE `invoice` ROUTE'S INVOICE IS
 * QUEUED INSIDE THE COMPLETION'S TRANSACTION, the in-transaction outbox pattern
 * the refund notes use (`queueRefundRequestCreditNoteInTransaction`,
 * `queueCancelledBookingHandBackNoteInTransaction`).
 *
 * WHY. On this route the supplementary invoice IS the ask. Queued after the
 * commit, it left a window in which the share was COMPLETED and its edit had no
 * invoice in the outbox, so a second share of the same edit, chosen in that
 * window, read no invoice still coming and took the card: a card ask for the
 * edit's total beside the invoice that then went out. Queued here, the invoice
 * commits with the share, and the next share - serialised behind this one on
 * `lock(1)` - always sees it (`supplementaryInvoiceStillComingWhere`).
 *
 * WHAT. The decision every caller of the enqueue makes (link-check ->
 * queued-check -> raise-or-create, under the per-anchor key), for the edit's
 * combined total re-derived on THIS transaction, which already holds this share's
 * claim. It replaces, for this route only, the post-commit restate-then-enqueue
 * in `dispatchEditReviewXeroSettlement`; the ordinary edit path's
 * `queueXeroBookingEditSettlement` is untouched.
 *
 * LOCK ORDER. Called LAST in the completion's transaction, after every other
 * lock it takes: `lock(1)` -> ... -> the per-anchor supplementary-invoice key.
 * Nothing holding that key takes another, so no cycle (`INV-LOCK-002`,
 * docs/CONCURRENCY_AND_LOCKING.md). No provider call: only the outbox row is
 * written here, and `finishEditReviewChargeInvoice` kicks it after the commit.
 *
 * A write that fails here rolls the completion back and leaves the task OPEN,
 * which is the point of the pattern: the share never commits without its ask.
 */
export async function queueEditReviewChargeInvoiceInTransaction({
  bookingId,
  route,
  hasIssuedXeroInvoice,
  createdByMemberId,
  store,
}: {
  bookingId: string;
  route: EditReviewSettlementRoute | null;
  hasIssuedXeroInvoice: boolean;
  createdByMemberId: string;
  store: Prisma.TransactionClient;
}): Promise<QueuedEditReviewChargeInvoice | null> {
  // The `invoice` route reaches here only with an issued primary invoice (the
  // chooser refuses otherwise); the guard keeps the ordinary dispatch's own
  // rule that an edit with no primary invoice has nothing to supplement.
  if (route?.kind !== "additional-charge" || route.collectVia !== "invoice" || !hasIssuedXeroInvoice) {
    return null;
  }
  const totalCents = await sumEditReviewChargeSharesCents({
    bookingId,
    bookingModificationId: route.bookingModificationId,
    store,
  });
  if (totalCents <= 0) return null;
  const queued = await enqueueEditReviewChargeInvoiceInTransaction(
    { bookingId, bookingModificationId: route.bookingModificationId, totalCents, createdByMemberId },
    store,
  );
  return { queueOperationId: queued.queueOperationId, outcome: queued.outcome, totalCents };
}

/**
 * #3947: after the commit, what the post-commit dispatch used to do once its
 * enqueue answered: start the outbox, and record a share the invoice could not
 * take (`recordShortEditReviewChargeInvoice`, the one function that decides what
 * is short - a second ask for `short-sent`, a recorded shortfall for
 * `short-in-flight`, nothing for `covers-total`). Best-effort, as that leg was: a
 * Xero outage must not undo a completion whose ask is already durable.
 */
export async function finishEditReviewChargeInvoice({
  queued,
  bookingId,
  taskId,
  bookingModificationId,
  shareCents,
  memberId,
  actingMemberId,
  format,
}: {
  queued: QueuedEditReviewChargeInvoice;
  bookingId: string;
  taskId: string;
  bookingModificationId: string;
  shareCents: number | null;
  memberId: string | null;
  actingMemberId: string;
  format: ClubFormat;
}): Promise<void> {
  if (queued.queueOperationId) {
    // Fire-and-forget, as the dispatch it replaces was (round 4, money F2): the
    // kick can reach Xero, and the officer's request must not wait on it.
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((err) =>
      logger.error({ err, bookingId, taskId }, "Failed to kick the Xero outbox after a review charge's invoice was queued"),
    );
  }
  await recordShortEditReviewChargeInvoice({
    outcome: queued.outcome,
    bookingId,
    format,
    bookingModificationId,
    reviewTaskId: taskId,
    shareCents,
    memberId,
    totalCents: queued.totalCents,
    createdByMemberId: actingMemberId,
  }).catch((err) =>
    logger.error({ err, bookingId, taskId }, "Failed to record a review charge share its queued invoice could not take"),
  );
}

/**
 * Raise the request, AFTER the caller's transaction has committed - the same
 * placement the refund side uses, and for the same reason: the Stripe call is a
 * provider round trip and the locking guide forbids one inside a transaction.
 *
 * Returns the request's intent id and the combined total it now asks for. The
 * intent id is null on the `invoice` route, where there is no intent to mint and
 * the supplementary Xero invoice IS the ask, and on a provider failure, which the
 * caller turns into an honest message rather than a receipt.
 */
export async function executeEditReviewCharge({
  bookingId,
  taskId, route, format,
}: {
  bookingId: string;
  taskId: string;
  route: EditReviewChargeRoute;
  format: ClubFormat; // #3565: resolved before any transaction by the caller
}): Promise<{
  paymentIntentId: string | null;
  totalCents: number;
  /** The sync's answer on the card route (#4272: `booking-cancelled` asks nothing). */
  outcome?: EditReviewChargeSyncOutcome;
  /** #4272: on `booking-cancelled`, whether that run wrote the uncollected-share record. */
  recordedUncollected?: boolean;
}> {
  // Derived here as well as inside the sync, because BOTH arms need it and the
  // failure arm needs it after the sync has thrown: the supplementary Xero
  // invoice the caller queues must bill the whole edit rather than this one share
  // of it, on the `invoice` route where there is no intent at all and on a
  // provider failure where the intent has not been raised yet.
  const totalCents = await sumEditReviewChargeSharesCents({
    bookingId,
    bookingModificationId: route.bookingModificationId,
  });
  if (route.collectVia !== "stripe") {
    return { paymentIntentId: null, totalCents };
  }
  try {
    return await syncEditFinancialReviewChargeRequest({
      format, bookingId, bookingModificationId: route.bookingModificationId,
      paymentId: route.paymentId,
      member: route.member,
      hasIssuedXeroInvoice: route.hasIssuedXeroInvoice,
    });
  } catch (err) {
    // Only the UPDATE arm's provider call (or a claim statement, #3402) reaches
    // here: the mint arm is
    // `createModificationAdditionalPaymentIntent`, which swallows its own
    // provider failure and enqueues the identical recovery row itself. Either
    // way the debt becomes durable and the cron replays this same function,
    // which re-derives the total - so a failure costs a delay, never a share.
    logger.error(
      { err, bookingId, taskId, bookingModificationId: route.bookingModificationId },
      "Failed to raise the combined additional PaymentIntent for a completed edit financial review - the persisted recovery operation will replay it",
    );
    await enqueueEditFinancialReviewChargeRecovery({
      bookingId,
      paymentId: route.paymentId,
      bookingModificationId: route.bookingModificationId,
      // Advisory only: the replay re-derives the total from the settled shares.
      advisoryAmountCents: totalCents,
      // #3181: NOT advisory - the replay's answer to "was there an invoice to
      // supplement" is this value and nothing it can re-derive.
      hadIssuedXeroInvoice: route.hasIssuedXeroInvoice,
    }).catch((enqueueErr) =>
      logger.error(
        { err: enqueueErr, bookingId, taskId },
        "Failed to enqueue additional PaymentIntent recovery for a completed edit financial review",
      ),
    );
    return { paymentIntentId: null, totalCents };
  }
}
