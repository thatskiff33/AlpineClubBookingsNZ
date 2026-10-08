/**
 * A PRICE REDUCTION RETIRES THE UNPAID ASK BEFORE IT RETURNS ANY MONEY (#3954,
 * owner decision 8 Oct 2026; `INV-PAY-047`, `INV-MOD-011`).
 *
 * A booking that grew carries an unpaid additional card ask until the member
 * pays it. A later edit that brings the price back down used to settle against
 * money already paid - a refund, account credit or give-back - and leave the
 * ask live, so a member who then paid it left the club holding more than the
 * booking cost. Now the reduction is set against the ask first
 * (`setReductionAgainstUnpaidAsk`, the arithmetic's one home) and only what is
 * left of it is refunded or credited.
 *
 * This module holds the two database halves:
 *
 * - `readUnpaidPriceAsk` - which ask a reduction may be set against. Read by the
 *   settlement options, the save (under its locks) and the quote, so the three
 *   cannot disagree.
 * - `retireUnpaidAskChain` - inside the edit's transaction: the ask's rows are
 *   FAILED and stamped `withdrawnAt` (the projection reads past them,
 *   `INV-ADDPAY-040`), each intent's Stripe cancellation is queued durably, any
 *   Xero supplementary invoice parked on them is retired, and the `Payment`
 *   mirror is reconciled. A smaller ask, when one is left, is minted after
 *   commit through the ordinary minter (`reissueUnpaidAdditionalAsk`).
 *
 * And the after-commit half, `cancelRetiredAdditionalAsksNow`, which the minter
 * runs before minting anything.
 *
 * THE RACE WITH A PAYMENT. The webhook does not take the edit's locks, so the
 * member can pay the ask while the reduction is being saved. Two outcomes, both
 * safe. A capture that lands between this read and the retire's fenced write
 * leaves the row captured, the fence matches nothing, and the whole edit rolls
 * back (409) - the member's retry sees the ask paid and refunds by policy. A
 * capture after the fence finds the queued cancellation, and the existing
 * superseded-capture path refunds it in full
 * (`queueSupersededPaymentIntentRefundRecovery`, `processCancelPaymentIntentOperation`).
 *
 * ONLY A PRICE ASK. A review-raised request is money an officer decided, not the
 * price (`INV-ADDPAY-040`, D-3528-2), so a chain holding one is left alone and
 * the reduction settles exactly as before.
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";

import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { ApiError } from "@/lib/api-error";
import type { ClubFormat } from "@/lib/club-format";
import { isEditReviewChargeRequestRow } from "@/lib/edit-financial-review-charge-shape";
import logger from "@/lib/logger";
import {
  enqueuePaymentIntentCancellationRecovery,
  runPaymentRecoveryOperationNow,
} from "@/lib/payment-recovery";
import {
  CAPTURED_TRANSACTION_STATUS_LIST,
  isCapturedTransactionStatus,
} from "@/lib/payment-transaction-status";
import { reconcilePaymentAggregates } from "@/lib/payment-transactions";
import { ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE } from "@/lib/unpaid-ask-offset-marker";

export const ADDITIONAL_ASK_CHANGED_DURING_REDUCTION_MESSAGE =
  "A payment on this booking was being made while you saved this change. Nothing was changed - refresh the booking and try again.";

/** One unpaid row of the ask a reduction is set against. */
export type UnpaidPriceAskRow = {
  id: string;
  amountCents: number;
  stripePaymentIntentId: string | null;
};

export type UnpaidPriceAsk = {
  /** What the member is still asked for; 0 when nothing can be set against. */
  askCents: number;
  /**
   * The live ask and every unpaid ask it superseded since the last paid one -
   * all of it retires together, so the mirror cannot fall back to an older
   * unpaid row and read it as owed.
   */
  rows: readonly UnpaidPriceAskRow[];
};

export const NO_UNPAID_PRICE_ASK: UnpaidPriceAsk = { askCents: 0, rows: [] };

export type UnpaidAskDb = Pick<
  Prisma.TransactionClient,
  "paymentTransaction" | "bookingModification"
>;

/**
 * The unpaid price ask a reduction on this booking may be set against, or
 * nothing. The `Payment` mirror says whether an ask is owed
 * (`isAdditionalPaymentOwed`, the chase's own predicate); the ledger rows say
 * which rows it is and whether any of them is review-raised.
 */
export async function readUnpaidPriceAsk(
  db: UnpaidAskDb,
  booking: {
    id: string;
    status: string;
    payment: {
      id: string;
      additionalAmountCents: number;
      additionalPaymentStatus: string | null;
      additionalPaymentIntentId: string | null;
    } | null;
  },
): Promise<UnpaidPriceAsk> {
  const payment = booking.payment;
  if (!payment || !isAdditionalPaymentOwed({ bookingStatus: booking.status, payment })) {
    return NO_UNPAID_PRICE_ASK;
  }
  const rows = await db.paymentTransaction.findMany({
    where: { paymentId: payment.id, kind: PaymentTransactionKind.ADDITIONAL, withdrawnAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      source: true,
      status: true,
      reason: true,
      amountCents: true,
      stripePaymentIntentId: true,
    },
  });
  let lastPaid = -1;
  rows.forEach((row, index) => {
    if (isCapturedTransactionStatus(row.status)) lastPaid = index;
  });
  const chain = rows.slice(lastPaid + 1);
  const live = chain.at(-1);
  // The mirror is derived from the newest row (`reconcilePaymentAggregates`);
  // a disagreement is a mirror this edit did not write, and it is not guessed at.
  if (
    !live ||
    live.source !== PaymentSource.STRIPE ||
    live.amountCents !== payment.additionalAmountCents ||
    live.stripePaymentIntentId !== payment.additionalPaymentIntentId
  ) {
    logger.warn(
      { bookingId: booking.id, paymentId: payment.id },
      "An unpaid additional ask does not match its ledger row; a reduction settles without setting against it (#3954)",
    );
    return NO_UNPAID_PRICE_ASK;
  }
  const modifications = await db.bookingModification.findMany({
    where: { bookingId: booking.id },
    select: { id: true },
  });
  const reviewRaised = chain.some((row) =>
    modifications.some((modification) => isEditReviewChargeRequestRow(row, modification.id)),
  );
  if (reviewRaised) return NO_UNPAID_PRICE_ASK;
  return {
    askCents: live.amountCents,
    rows: chain.map((row) => ({
      id: row.id,
      amountCents: row.amountCents,
      stripePaymentIntentId: row.stripePaymentIntentId,
    })),
  };
}

/** A retired ask's intent, and the durable cancellation queued for it. */
export type RetiredAdditionalAsk = {
  paymentTransactionId: string;
  paymentIntentId: string;
  cancelOperationId: string;
};

/**
 * Retire the ask a reduction was set against, inside the edit's transaction and
 * under its locks. Throws a 409 when a row was captured since it was read, so
 * the edit rolls back rather than release a member from money they just paid.
 */
export async function retireUnpaidAskChain(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    ask,
    now = new Date(),
  }: {
    bookingId: string;
    paymentId: string;
    ask: UnpaidPriceAsk;
    now?: Date;
  },
): Promise<RetiredAdditionalAsk[]> {
  const retired: RetiredAdditionalAsk[] = [];
  for (const row of ask.rows) {
    // THE FENCE: still unpaid and still unretired, or the whole edit rolls back.
    const stamped = await tx.paymentTransaction.updateMany({
      where: {
        id: row.id,
        withdrawnAt: null,
        status: { notIn: [...CAPTURED_TRANSACTION_STATUS_LIST] },
      },
      data: { status: PaymentStatus.FAILED, withdrawnAt: now },
    });
    if (stamped.count !== 1) {
      throw new ApiError(ADDITIONAL_ASK_CHANGED_DURING_REDUCTION_MESSAGE, 409);
    }
    if (!row.stripePaymentIntentId) continue;
    const operation = await enqueuePaymentIntentCancellationRecovery({
      bookingId,
      paymentId,
      paymentTransactionId: row.id,
      paymentIntentId: row.stripePaymentIntentId,
      amountCents: row.amountCents,
      store: tx,
    });
    // An older row an earlier supersede already cancelled keeps its finished
    // operation (the upsert never reopens one); there is nothing to run now.
    if (operation.status === PaymentRecoveryOperationStatus.SUCCEEDED) continue;
    retired.push({
      paymentTransactionId: row.id,
      paymentIntentId: row.stripePaymentIntentId,
      cancelOperationId: operation.id,
    });
  }

  const intentIds = ask.rows.flatMap((row) =>
    row.stripePaymentIntentId ? [row.stripePaymentIntentId] : [],
  );
  if (intentIds.length > 0) {
    // The increase's supplementary invoice waits on its card payment and is
    // never raised before it, so nothing reached Xero for the ask; the parked
    // operation is retired, as a withdrawal retires one (`INV-ADDPAY-040`).
    await tx.xeroSyncOperation.updateMany({
      where: {
        status: "WAITING_PAYMENT",
        direction: "OUTBOUND",
        OR: intentIds.map((intentId) => ({
          requestPayload: { path: ["paymentIntentId"], equals: intentId },
        })),
      },
      data: {
        status: "CANCELLED",
        completedAt: now,
        lastErrorCode: ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE,
        lastErrorMessage:
          "Retired: a price reduction cancelled or re-issued the unpaid card request this invoice was waiting on (#3954).",
      },
    });
  }

  await reconcilePaymentAggregates({ paymentId, store: tx });
  return retired;
}

/**
 * After commit: cancel the retired asks' intents at Stripe now, rather than at
 * the recovery cron's next pass. Best-effort - the queued rows written in the
 * edit's transaction are the guarantee, and a capture before the cancel lands
 * is refunded by the superseded-capture path.
 */
export async function cancelRetiredAdditionalAsksNow({
  format,
  bookingId,
  retired,
}: {
  format: ClubFormat;
  bookingId: string;
  retired: readonly RetiredAdditionalAsk[];
}): Promise<void> {
  for (const entry of retired) {
    const outcome = await runPaymentRecoveryOperationNow(entry.cancelOperationId, format).catch(
      (err) => {
        logger.error(
          { err, bookingId, paymentIntentId: entry.paymentIntentId },
          "Immediate cancellation of an ask a reduction retired did not run; the queued recovery operation stands",
        );
        return "failed" as const;
      },
    );
    if (outcome !== "succeeded") {
      logger.warn(
        { bookingId, paymentIntentId: entry.paymentIntentId, operationId: entry.cancelOperationId, outcome },
        "An ask a reduction retired was not cancelled immediately; it stays confirmable until the queued recovery operation runs, and a capture in that window is refunded (#3954)",
      );
    }
  }
}
