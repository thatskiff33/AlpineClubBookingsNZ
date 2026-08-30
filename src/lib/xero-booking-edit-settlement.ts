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
