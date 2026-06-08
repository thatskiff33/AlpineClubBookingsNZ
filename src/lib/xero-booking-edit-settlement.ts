import type { PaymentStatus } from "@prisma/client";
import logger from "@/lib/logger";
import {
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroModificationAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
  recordSkippedXeroBookingInvoiceUpdateOperation,
} from "@/lib/xero-operation-outbox";

const UNSAFE_PRIMARY_INVOICE_PAYMENT_STATUSES = new Set<string>([
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

export type XeroBookingEditFinancialAction =
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

export type XeroBookingEditPrimaryUpdateAction =
  | { type: "none"; reason: string }
  | { type: "queue"; reason: string }
  | { type: "skip"; reason: string };

export interface XeroBookingEditSettlementDecision {
  xeroNetAmountCents: number;
  originalInvoiceUnsafe: boolean;
  financialAction: XeroBookingEditFinancialAction;
  primaryInvoiceUpdateAction: XeroBookingEditPrimaryUpdateAction;
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

function isPrimaryInvoiceUnsafe(paymentStatus?: PaymentStatus | string | null) {
  return paymentStatus ? UNSAFE_PRIMARY_INVOICE_PAYMENT_STATUSES.has(paymentStatus) : false;
}

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
    financialAction = {
      type: "supplementary-invoice",
      priceDiffCents: Math.max(input.priceDiffCents, 0),
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
  } else if (originalInvoiceUnsafe) {
    primaryInvoiceUpdateAction = {
      type: "skip",
      reason:
        "Skipped primary Xero invoice update because the original invoice has local paid, refunded, or partially refunded payment state.",
    };
  } else {
    primaryInvoiceUpdateAction = {
      type: "queue",
      reason: "Queue a safe primary invoice date/narration update.",
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
) {
  const decision = classifyXeroBookingEditSettlement(input);

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

  return decision;
}
