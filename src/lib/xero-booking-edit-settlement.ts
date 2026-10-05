import type { PaymentStatus } from "@prisma/client";
import logger from "@/lib/logger";
// The check-in-dated-update condition is shared with the Xero period
// lock-date guard (#1729) via a dependency-free module so the guard can never
// drift from this classification.
import {
  isPrimaryInvoiceUnsafe,
  wouldQueueCheckInDatedInvoiceUpdate,
} from "@/lib/xero-booking-edit-conditions";
import {
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroModificationAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
  recordSkippedXeroBookingInvoiceUpdateOperation,
  type XeroSupplementaryInvoiceEnqueueOutcome,
} from "@/lib/xero-operation-outbox";
import { giveBackNoteScope } from "@/lib/xero-review-task-key";
import {
  refundMethodForSettlementMethod,
  type RefundMethod,
} from "@/lib/xero-refund-method";

type XeroBookingEditFinancialAction =
  | { type: "none"; reason: string }
  | {
      type: "primary-invoice";
      reason: string;
    }
  | {
      type: "supplementary-invoice";
      priceDiffCents: number;
      changeFeeCents: number;
      recordPayment: boolean;
      waitForPaymentIntentId: string | null;
      reason: string;
    }
  | {
      type: "modification-credit-note";
      refundAmountCents: number;
      /** `INV-PAY-101`: how the reduction went back, as the note will say. */
      refundMethod: RefundMethod;
      /**
       * #3809: applied credit given back - always an allocated note of its own,
       * worded as account credit and scoped (`giveBackNoteScope`), beside the
       * refund's note above or alone where the refund (`refundAmountCents`) is
       * nothing, since one note may name only one method (`INV-PAY-101`).
       */
      allocatedGiveBackCents: number;
      reason: string;
    }
  | {
      type: "modification-account-credit-note";
      refundAmountCents: number;
      /**
       * #3809: applied credit the same edit gave back, which the deallocation
       * reopened the invoice by: an invoice-ALLOCATED note of its own beside
       * the unallocated one for the minted credit.
       */
      allocatedGiveBackCents: number;
      reason: string;
    };

type XeroBookingEditPrimaryUpdateAction =
  | { type: "none"; reason: string }
  | { type: "queue"; reason: string }
  | { type: "skip"; reason: string };

export interface XeroBookingEditSettlementDecision {
  xeroNetAmountCents: number;
  originalInvoiceUnsafe: boolean;
  financialAction: XeroBookingEditFinancialAction;
  primaryInvoiceUpdateAction: XeroBookingEditPrimaryUpdateAction;
}

/**
 * What the classification decided, plus what the accounting ask actually did
 * about it (#3170 fix round, F2).
 *
 * The decision alone says what this dispatcher INTENDED. `supplementaryInvoice`
 * says what the enqueue then found under its per-anchor lock, which is the only
 * moment anyone can tell whether a settled share reached the invoice: once the
 * outbox worker has claimed the operation, `createXeroSupplementaryInvoice`
 * overwrites its payload with the Xero invoice body, so the queued amount is
 * gone. `"none"` on every branch that does not queue a supplementary invoice at
 * all - including the deferred one below, where the invoice is waiting for an
 * additional PaymentIntent that does not exist yet and no ask has been made to
 * fall short of.
 */
export interface XeroBookingEditSettlementResult
  extends XeroBookingEditSettlementDecision {
  supplementaryInvoice: XeroSupplementaryInvoiceEnqueueOutcome;
}

export interface ClassifyXeroBookingEditSettlementInput {
  hasIssuedXeroInvoice: boolean;
  originalPaymentStatus?: PaymentStatus | string | null;
  priceDiffCents: number;
  changeFeeCents?: number;
  datesChanged?: boolean;
  guestIdentityChanged?: boolean;
  createPrimaryInvoiceWhenMissing?: boolean;
  requiresAdditionalStripePayment?: boolean;
  additionalPaymentIntentId?: string | null;
  settlementMethod?: "card" | "credit" | null;
  settlementAmountCents?: number | null;
  /**
   * `INV-PAY-101` (#3529): how the money went back, for the wording on the
   * credit note. `settlementMethod` is the member's two-way choice (money back
   * or credit kept) and still picks WHICH note is raised; this says what the
   * note reads, for the caller that knows the money went back by bank transfer
   * rather than to a card. Omitted, it follows `settlementMethod`.
   */
  refundMethod?: RefundMethod | null;
  /**
   * Whether the reduction's "money back" is a Stripe refund — the services'
   * `hasSucceededPayment`. False means the club returns the money itself, and
   * the note must not say a card was refunded (review of #3537). Read only
   * when `refundMethod` is omitted.
   */
  refundedThroughStripe?: boolean | null;
  /**
   * #3809: applied credit a paid booking's reduction gave back
   * (`appliedCreditGivenBackCents`). Its deallocation reopens the invoice by
   * this much, so an invoice-allocated note takes it off again, as for a card
   * refund: the edit's allocated note, worded as account credit, where it is
   * all that came back; else an allocated note of its own, beside the card or
   * bank refund's note or the credit election's unallocated one.
   */
  appliedCreditGiveBackCents?: number;
  /**
   * #3653 (`INV-PAY-114`): the reduction is an organiser-settled child's,
   * returned to the organiser's card out of the group's combined payment. Its
   * refund credit note is raised by `processOrganiserChildRefundOperation` in
   * the transaction that records the refund Stripe made - AFTER the money moved
   * - so this dispatcher raises no modification note of its own for it. Two
   * notes would credit the joiner's invoice twice for one refund.
   */
  organiserChildRefundOwnsCreditNote?: boolean;
}

export interface QueueXeroBookingEditSettlementInput
  extends ClassifyXeroBookingEditSettlementInput {
  bookingId: string;
  bookingModificationId: string;
  createdByMemberId?: string;
  /**
   * #3791: the review task whose share this settles, which scopes the credit
   * note it raises to that task, so a sibling review of the same edit raises
   * its own. Absent on every edit's own settlement.
   */
  reviewTaskId?: string;
}

// test seam
export function classifyXeroBookingEditSettlement(
  input: ClassifyXeroBookingEditSettlementInput
): XeroBookingEditSettlementDecision {
  const changeFeeCents = input.changeFeeCents ?? 0;
  const xeroNetAmountCents = input.hasIssuedXeroInvoice
    ? input.priceDiffCents + changeFeeCents
    : 0;
  const originalInvoiceUnsafe = isPrimaryInvoiceUnsafe(input.originalPaymentStatus);

  let financialAction: XeroBookingEditFinancialAction;
  if (!input.hasIssuedXeroInvoice) {
    financialAction = input.createPrimaryInvoiceWhenMissing
      ? {
          type: "primary-invoice",
          reason: "No original Xero invoice exists, so the edit should create the primary booking invoice.",
        }
      : {
          type: "none",
          reason: "No original Xero invoice exists for this booking edit.",
        };
  } else if (xeroNetAmountCents > 0) {
    const waitForPaymentIntentId =
      input.requiresAdditionalStripePayment ? input.additionalPaymentIntentId ?? null : null;
    // The components stay SIGNED (#1356): a mixed-sign edit (price reduction
    // plus a larger late-change fee) must invoice the fee AND the negative
    // price adjustment so the supplementary invoice total and its recorded
    // payment equal the net the member is actually charged. Clamping the
    // reduction to zero over-records Xero income and the Stripe clearing
    // account by the dropped component and breaks bank reconciliation.
    financialAction = {
      type: "supplementary-invoice",
      priceDiffCents: input.priceDiffCents,
      changeFeeCents,
      recordPayment: input.requiresAdditionalStripePayment
        ? Boolean(waitForPaymentIntentId)
        : false,
      waitForPaymentIntentId,
      reason: input.requiresAdditionalStripePayment
        ? "Positive booking-edit delta needs a supplementary invoice after the additional Stripe payment succeeds."
        : "Positive booking-edit delta needs an unpaid supplementary invoice; no confirmed additional Stripe payment exists.",
    };
  } else if (xeroNetAmountCents < 0) {
    const refundAmountCents = Math.max(0, input.settlementAmountCents ?? Math.abs(xeroNetAmountCents));
    const giveBackCents = Math.max(0, input.appliedCreditGiveBackCents ?? 0);
    if (refundAmountCents <= 0 && giveBackCents <= 0) {
      financialAction = {
        type: "none",
        reason: "Booking edit reduction has no policy-returnable settlement amount.",
      };
    } else if (input.organiserChildRefundOwnsCreditNote) {
      financialAction = {
        type: "none",
        reason:
          "The reduction is refunded to the group organiser's card; its refund credit note is raised once Stripe has made the refund.",
      };
    } else if (input.settlementMethod === "credit" && refundAmountCents > 0) {
      financialAction = {
        type: "modification-account-credit-note",
        refundAmountCents,
        allocatedGiveBackCents: giveBackCents,
        reason: "Negative booking-edit delta held as account credit needs an unapplied modification credit note.",
      };
    } else {
      // #3809: the give-back is ALWAYS its own note, under its own scope, even
      // where it is all that came back - one key identifies it everywhere, so
      // the repair pass reads it there and can never mint a second.
      financialAction = {
        type: "modification-credit-note",
        refundAmountCents,
        refundMethod:
          input.refundMethod ??
          refundMethodForSettlementMethod(input.settlementMethod, input.refundedThroughStripe),
        allocatedGiveBackCents: giveBackCents,
        reason: "Negative booking-edit delta needs a modification credit note instead of mutating the original invoice.",
      };
    }
  } else {
    financialAction = {
      type: "none",
      reason: "Booking edit has no Xero financial delta.",
    };
  }

  let primaryInvoiceUpdateAction: XeroBookingEditPrimaryUpdateAction;
  const primaryInvoiceNarrationChanged =
    Boolean(input.datesChanged) || Boolean(input.guestIdentityChanged);
  if (!input.hasIssuedXeroInvoice || !primaryInvoiceNarrationChanged) {
    primaryInvoiceUpdateAction = {
      type: "none",
      reason: "No primary invoice date or narration update is required.",
    };
  } else if (wouldQueueCheckInDatedInvoiceUpdate(input)) {
    // The shared predicate (#1729) IS this queue decision — the ordinary-edit
    // lock-date guard consults the same function pre-transaction.
    primaryInvoiceUpdateAction = {
      type: "queue",
      reason: "Queue a safe primary invoice date/narration update.",
    };
  } else {
    primaryInvoiceUpdateAction = {
      type: "skip",
      reason:
        "Skipped primary Xero invoice update because the original invoice has local paid, refunded, or partially refunded payment state.",
    };
  }

  return {
    xeroNetAmountCents,
    originalInvoiceUnsafe,
    financialAction,
    primaryInvoiceUpdateAction,
  };
}

async function kickQueuedXeroOperation(queued: { queueOperationId: string | null }) {
  if (queued.queueOperationId) {
    await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
  }
}

/**
 * #3809: the allocated note for applied credit given back beside another note
 * on the same edit. Scoped by the existing per-share key slot
 * (`reviewTaskKeyParts`, #3791) under `APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE`, so
 * the edit's own note neither answers for it by its link nor folds an equal
 * amount into one key, and an operator retry rebuilds the same keys.
 */
async function queueGiveBackNote(input: QueueXeroBookingEditSettlementInput, cents: number) {
  if (cents <= 0) return;
  const queued = await enqueueXeroModificationCreditNoteOperation(
    {
      bookingId: input.bookingId,
      refundAmountCents: cents,
      bookingModificationId: input.bookingModificationId,
      refundMethod: "account-credit",
      // Always distinct from the caller's own scope, so a review task's note and
      // a give-back beside it can never share a key and dedupe one away.
      reviewTaskId: giveBackNoteScope(input.reviewTaskId),
    },
    { createdByMemberId: input.createdByMemberId }
  );
  await kickQueuedXeroOperation(queued);
}

export async function queueXeroBookingEditSettlement(
  input: QueueXeroBookingEditSettlementInput
): Promise<XeroBookingEditSettlementResult> {
  const decision = classifyXeroBookingEditSettlement(input);
  let supplementaryInvoice: XeroSupplementaryInvoiceEnqueueOutcome = "none";

  if (decision.financialAction.type === "primary-invoice") {
    const queued = await enqueueXeroBookingInvoiceOperation(input.bookingId, {
      createdByMemberId: input.createdByMemberId,
      invoiceEmailDelivery: null,
    });
    await kickQueuedXeroOperation(queued);
  } else if (decision.financialAction.type === "supplementary-invoice") {
    if (
      input.requiresAdditionalStripePayment &&
      !decision.financialAction.waitForPaymentIntentId
    ) {
      // Deferred, not short: nothing has been asked for yet, so there is no ask
      // for a share to fall short of. The intent's recovery replay is what
      // eventually mints one.
      logger.warn(
        {
          bookingId: input.bookingId,
          bookingModificationId: input.bookingModificationId,
        },
        "Skipping Xero supplementary invoice queue until an additional Stripe PaymentIntent exists"
      );
    } else {
      const queued = await enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: input.bookingId,
          priceDiffCents: decision.financialAction.priceDiffCents,
          changeFeeCents: decision.financialAction.changeFeeCents,
          bookingModificationId: input.bookingModificationId,
        },
        {
          createdByMemberId: input.createdByMemberId,
          paymentIntentId: decision.financialAction.waitForPaymentIntentId,
          waitForConfirmedAdditionalPayment: Boolean(
            decision.financialAction.waitForPaymentIntentId
          ),
          recordPayment: decision.financialAction.recordPayment,
        }
      );
      supplementaryInvoice = queued.outcome;
      await kickQueuedXeroOperation(queued);
    }
  } else if (decision.financialAction.type === "modification-credit-note") {
    if (decision.financialAction.refundAmountCents > 0) {
      const queued = await enqueueXeroModificationCreditNoteOperation(
        {
          bookingId: input.bookingId,
          refundAmountCents: decision.financialAction.refundAmountCents,
          bookingModificationId: input.bookingModificationId,
          refundMethod: decision.financialAction.refundMethod,
          ...(input.reviewTaskId ? { reviewTaskId: input.reviewTaskId } : {}),
        },
        {
          createdByMemberId: input.createdByMemberId,
        }
      );
      await kickQueuedXeroOperation(queued);
    }
    await queueGiveBackNote(input, decision.financialAction.allocatedGiveBackCents);
  } else if (decision.financialAction.type === "modification-account-credit-note") {
    const queued = await enqueueXeroModificationAccountCreditNoteOperation(
      {
        bookingId: input.bookingId,
        refundAmountCents: decision.financialAction.refundAmountCents,
        bookingModificationId: input.bookingModificationId,
        ...(input.reviewTaskId ? { reviewTaskId: input.reviewTaskId } : {}),
      },
      {
        createdByMemberId: input.createdByMemberId,
      }
    );
    await kickQueuedXeroOperation(queued);
    await queueGiveBackNote(input, decision.financialAction.allocatedGiveBackCents);
  }

  if (decision.primaryInvoiceUpdateAction.type === "queue") {
    const queued = await enqueueXeroBookingInvoiceUpdateOperation(input.bookingId, {
      createdByMemberId: input.createdByMemberId,
    });
    await kickQueuedXeroOperation(queued);
  } else if (decision.primaryInvoiceUpdateAction.type === "skip") {
    await recordSkippedXeroBookingInvoiceUpdateOperation({
      bookingId: input.bookingId,
      bookingModificationId: input.bookingModificationId,
      reason: decision.primaryInvoiceUpdateAction.reason,
      createdByMemberId: input.createdByMemberId,
    });
  }

  return { ...decision, supplementaryInvoice };
}

export interface CompleteDeferredXeroSupplementaryInvoiceInput {
  bookingId: string;
  /** The `BookingModification` the deferred invoice is anchored to. */
  bookingModificationId: string;
  /** The intent the recovery replay minted or found. Never null: see below. */
  paymentIntentId: string;
  /**
   * The edit's signed components, as the `BookingModification` row holds them.
   * The same pair the booking-vs-Xero repair pass reads when it offers to queue
   * this very invoice by hand, so an automatic completion and an operator's
   * repair bill the same figure.
   */
  priceDiffCents: number;
  changeFeeCents: number;
  /**
   * THE EDIT'S answer, carried in - never a fresh read. See the convergence
   * paragraph below for why the fresh read double-bills; the caller freezes this
   * on the recovery row rather than deriving it when the cron runs.
   */
  hasIssuedXeroInvoice: boolean;
  originalPaymentStatus?: PaymentStatus | string | null;
  createdByMemberId?: string;
}

/**
 * COMPLETE THE SUPPLEMENTARY INVOICE THE EDIT PATH DEFERRED (#3181, epic #2797).
 *
 * `queueXeroBookingEditSettlement` above SKIPS the supplementary invoice when an
 * edit needs an additional Stripe payment whose intent could not be minted. That
 * is right in the moment - there is nothing to invoice against yet - and its log
 * line says the intent's recovery replay is what eventually mints one. It was
 * half a sentence. The replay minted the intent and only ever ATTACHED it to an
 * operation already waiting, and no operation was ever queued, because the inline
 * attempt had skipped it. So the "later" never arrived: the member was asked for
 * the money and could pay it, and the club's accounts never heard of the charge.
 *
 * This is the other half. The recovery worker calls it once the intent exists,
 * and it re-enters the same dispatcher with the same inputs, differing only in
 * that `additionalPaymentIntentId` is now set - so a recovered edit converges on
 * exactly the arrangement a first-time-successful mint would have produced,
 * rather than on a second arrangement that has to be kept in step with it.
 *
 * THAT CONVERGENCE IS ONLY TRUE BECAUSE `hasIssuedXeroInvoice` IS THE EDIT'S OWN
 * ANSWER, and it is worth saying why, because the obvious implementation breaks
 * it silently. Re-deriving the flag from the payment row at replay time is a
 * DIFFERENT question - "does this booking have a primary invoice NOW" - and on a
 * booking whose primary invoice was still queued when the edit committed the two
 * answers differ. There the edit classified `none` and queued nothing, correctly,
 * because the primary invoice reads the booking's CURRENT state when the worker
 * finally mints it and therefore bills the edit itself. A replay deriving `true`
 * would add a supplementary invoice on top of that, and the club would record
 * more income than the booking is worth plus a receivable nobody owes. So the
 * caller freezes the value on the recovery row (`PaymentRecoveryOperation.
 * hadIssuedXeroInvoice`) at enqueue time and passes it back in here; this
 * function never reads it for itself, and must not start.
 *
 * ONE INVOICE, AND THIS IS WHY IT CANNOT BE TWO. It never asks "does this edit
 * already have an invoice going out". `enqueueXeroSupplementaryInvoiceOperation`
 * answers that under its per-anchor advisory lock, refusing an anchor that
 * carries an active `SUPPLEMENTARY_INVOICE` link and finding any
 * PENDING/RUNNING/WAITING_PAYMENT operation for the same anchor. A caller-side
 * copy of that question is exactly how two answers came to disagree in #3170, so
 * there is not one here. It is also what makes this safe to run twice, which a
 * replay path has to be.
 *
 * `requiresAdditionalStripePayment` is TRUE rather than a parameter, and the
 * guarantee is the ARGUMENT IN HAND, not the row that led here. An earlier draft
 * of this paragraph argued from the recovery row - "it exists only because a mint
 * was attempted and failed" - and that is false: `syncEditFinancialReviewCharge
 * Request` enqueues one when its `hasSucceededPayment`/`paymentId` guard answers
 * false on the re-read, which returns BEFORE its `try` with nothing attempted at
 * all. Reasoning from the row is therefore reasoning from something that is not
 * true.
 *
 * The real guarantee is narrower and holds unconditionally: `paymentIntentId` is
 * a REQUIRED, non-null argument, so by the time this function runs a live
 * additional PaymentIntent exists for this edit. An additional intent IS the card
 * route - it is minted only against a captured Stripe payment - so the invoice
 * must wait for that intent to confirm and must record its payment when it does,
 * which is exactly what this flag plus `additionalPaymentIntentId` select. A
 * caller with no intent has nothing to pass and cannot reach here; where the
 * inline dispatch instead queued an UNPAID invoice, this call finds that
 * operation under the enqueue's per-anchor lock and queues nothing.
 *
 * THE DATE/NARRATION LEGS ARE DELIBERATELY FALSE. A failed mint does not stop the
 * edit's own dispatch, which already ran them when the edit committed; claiming
 * them again here would queue a second, redundant primary-invoice update. For
 * the same reason no primary invoice is created when one is missing - the
 * recovery of a collectable is not the place to decide a booking needs its first
 * invoice.
 *
 * A NON-POSITIVE NET RETURNS BEFORE THE DISPATCHER, and that guard is the point
 * of this paragraph rather than an aside. Handed a reduction, the dispatcher does
 * not do nothing - it classifies `modification-credit-note` and queues a REFUND
 * to the member. A function called "complete the deferred supplementary invoice",
 * reached only from a replay whose whole subject is money the member OWES, must
 * not be able to issue one; today no caller can reach it with a reduction, and
 * making that unrepresentable is cheaper than a rule saying they must not
 * (`INV-SSOT`). The refund paths are `queueXeroBookingEditSettlement`'s to
 * dispatch, from the edit that decided on a refund.
 *
 * Returns the enqueue's own verdict so the caller can record a short ask. It
 * does not catch: the caller owns what a failure to queue means for the recovery
 * operation it is processing.
 */
export async function completeDeferredXeroSupplementaryInvoice(
  input: CompleteDeferredXeroSupplementaryInvoiceInput
): Promise<XeroSupplementaryInvoiceEnqueueOutcome> {
  if (input.priceDiffCents + input.changeFeeCents <= 0) {
    return "none";
  }
  const settled = await queueXeroBookingEditSettlement({
    bookingId: input.bookingId,
    bookingModificationId: input.bookingModificationId,
    createdByMemberId: input.createdByMemberId,
    hasIssuedXeroInvoice: input.hasIssuedXeroInvoice,
    originalPaymentStatus: input.originalPaymentStatus,
    priceDiffCents: input.priceDiffCents,
    changeFeeCents: input.changeFeeCents,
    datesChanged: false,
    guestIdentityChanged: false,
    requiresAdditionalStripePayment: true,
    additionalPaymentIntentId: input.paymentIntentId,
  });
  return settled.supplementaryInvoice;
}
