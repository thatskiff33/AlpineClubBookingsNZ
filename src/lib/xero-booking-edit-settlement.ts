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
      reason: string;
    }
  | {
      type: "modification-account-credit-note";
      refundAmountCents: number;
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
}

export interface QueueXeroBookingEditSettlementInput
  extends ClassifyXeroBookingEditSettlementInput {
  bookingId: string;
  bookingModificationId: string;
  createdByMemberId?: string;
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
    const refundAmountCents = input.settlementAmountCents ?? Math.abs(xeroNetAmountCents);
    if (refundAmountCents <= 0) {
      financialAction = {
        type: "none",
        reason: "Booking edit reduction has no policy-returnable settlement amount.",
      };
    } else if (input.settlementMethod === "credit") {
      financialAction = {
        type: "modification-account-credit-note",
        refundAmountCents,
        reason: "Negative booking-edit delta held as account credit needs an unapplied modification credit note.",
      };
    } else {
      financialAction = {
        type: "modification-credit-note",
        refundAmountCents,
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

export async function queueXeroBookingEditSettlement(
  input: QueueXeroBookingEditSettlementInput
): Promise<XeroBookingEditSettlementResult> {
  const decision = classifyXeroBookingEditSettlement(input);
  let supplementaryInvoice: XeroSupplementaryInvoiceEnqueueOutcome = "none";

  if (decision.financialAction.type === "primary-invoice") {
    const queued = await enqueueXeroBookingInvoiceOperation(input.bookingId, {
      createdByMemberId: input.createdByMemberId,
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
    const queued = await enqueueXeroModificationCreditNoteOperation(
      {
        bookingId: input.bookingId,
        refundAmountCents: decision.financialAction.refundAmountCents,
        bookingModificationId: input.bookingModificationId,
      },
      {
        createdByMemberId: input.createdByMemberId,
      }
    );
    await kickQueuedXeroOperation(queued);
  } else if (decision.financialAction.type === "modification-account-credit-note") {
    const queued = await enqueueXeroModificationAccountCreditNoteOperation(
      {
        bookingId: input.bookingId,
        refundAmountCents: decision.financialAction.refundAmountCents,
        bookingModificationId: input.bookingModificationId,
      },
      {
        createdByMemberId: input.createdByMemberId,
      }
    );
    await kickQueuedXeroOperation(queued);
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
