import "server-only";

import { PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";

import { ASK_CAUSE_ROWS, isPureCreditReleaseChain } from "@/lib/additional-ask-cause";
import { bookingLedgerResidualCents } from "@/lib/additional-payment-ask";
import { ADDITIONAL_PAYABLE_BOOKING_STATUSES, isAdditionalPaymentDoorOpenForBooking } from "@/lib/additional-payment-chase";

import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import logger from "@/lib/logger";
import {
  CREDIT_RELEASE_ASK_REASON,
} from "@/lib/credit-release-ask-keys";
import { lockPaymentForRefundedTotal, recordInternetBankingPaymentTransaction } from "@/lib/payment-transactions";
import { LEDGER_ROWS_NEWEST_FIRST } from "@/lib/payment-ledger-order";
import { prisma } from "@/lib/prisma";
import { cancelPaymentIntentIfCancellableWithResult } from "@/lib/stripe";
import { isSettledInXero, readXeroInvoiceBalance, type XeroInvoiceBalanceReader } from "@/lib/xero-invoice-balance";

/**
 * CLOSE A CREDIT-RELEASE REQUEST WHEN XERO SHOWS THE INVOICE PAID (#4253,
 * `INV-ADDPAY-045`, owner decision D6: the member may pay by card OR bank transfer).
 *
 * The released amount stands on the booking's own invoice, so a member who pays
 * that invoice by bank transfer, or a treasurer who settles it in Xero, has paid
 * what the card request asks for. Left open, the request would go on chasing the
 * member and a later card payment would pay the same money twice. So when Xero
 * shows the invoice PAID while the request is unpaid here, the request is closed
 * and the money is written into the ledger as what it was: internet-banking cash on
 * the booking's additional payments, so the booking still balances (`INV-PAY-047`).
 *
 * This is the SEAM #4270's inbound mirror will feed: it reads Xero on a schedule
 * today, and takes a pre-read balance when the inbound sync knows the invoice
 * changed. The decision and the write stay here.
 *
 * ORDER, as the officer's withdrawal does it: the provider cancel first and outside
 * any lock; then one transaction under the global key that re-asserts the row
 * before writing. An intent Stripe reports as succeeded or still processing is
 * LEFT ALONE - the card payment won, and the payment recorder will hold and alert
 * (the invoice is no longer open) rather than record it twice.
 *
 * ONLY A REQUEST MADE OF RELEASED CREDIT. One that carries nothing, or one that carried
 * only earlier credit-release requests (#4253 release 2, `INV-ADDPAY-049`): every cent of either
 * stands on the booking's own invoice, so that invoice reading PAID says the whole request is
 * paid. One that absorbed an edit's balance is part money on another invoice, which a paid
 * booking invoice says nothing about, so it stays open for a person. The chain is read before
 * any provider call; under the locks the fence pins the row's own carried figure, which no writer
 * changes, and the payment still naming this request as its live ask, so nothing can have been
 * folded into it since.
 */
const UNPAID_STATUSES = [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED];

export const CREDIT_RELEASE_PAID_IN_XERO_REASON = "credit_released_paid_in_xero";

export type CreditReleaseCloseResult = { closed: number; left: number };

export type CreditReleaseCloseDeps = {
  readInvoiceBalance: XeroInvoiceBalanceReader;
  cancelIntent: typeof cancelPaymentIntentIfCancellableWithResult;
};

export async function closeCreditReleaseAsksPaidInXero(
  options: { limit?: number; deps?: Partial<CreditReleaseCloseDeps>; now?: Date } = {},
): Promise<CreditReleaseCloseResult> {
  const deps: CreditReleaseCloseDeps = {
    readInvoiceBalance: readXeroInvoiceBalance,
    cancelIntent: cancelPaymentIntentIfCancellableWithResult,
    ...options.deps,
  };
  const result: CreditReleaseCloseResult = { closed: 0, left: 0 };
  // Payments that have an uncollected ask on a booking that can still be paid, with a
  // credit-release request among their rows. Selected by PAYMENT, so a settled or superseded
  // request on another booking never takes a slot; the live request is then found by the intent
  // the payment points at.
  const payments = await prisma.payment.findMany({
    where: {
      xeroInvoiceId: { not: null },
      additionalPaymentIntentId: { not: null },
      additionalAmountCents: { gt: 0 },
      additionalPaymentStatus: { not: PaymentStatus.SUCCEEDED },
      booking: { deletedAt: null, status: { in: [...ADDITIONAL_PAYABLE_BOOKING_STATUSES] } },
      transactions: {
        some: {
          kind: PaymentTransactionKind.ADDITIONAL,
          source: PaymentSource.STRIPE,
          reason: CREDIT_RELEASE_ASK_REASON,
          withdrawnAt: null,
          status: { in: UNPAID_STATUSES },
        },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: options.limit ?? 100,
    select: {
      id: true,
      xeroInvoiceId: true,
      additionalPaymentIntentId: true,
      booking: { select: { id: true, memberId: true, member: true, organisation: { select: { name: true, email: true } } } },
    },
  });

  for (const payment of payments) {
    if (!payment.additionalPaymentIntentId) continue;
    const ask = await prisma.paymentTransaction.findFirst({
      where: {
        paymentId: payment.id,
        stripePaymentIntentId: payment.additionalPaymentIntentId,
        kind: PaymentTransactionKind.ADDITIONAL,
        source: PaymentSource.STRIPE,
        reason: CREDIT_RELEASE_ASK_REASON,
        withdrawnAt: null,
        status: { in: UNPAID_STATUSES },
      },
      select: { id: true, paymentId: true, amountCents: true, carriedAskCents: true, stripePaymentIntentId: true },
    });
    // Only the LIVE request (the one the payment's summary points at) is closed.
    if (!ask || !payment.xeroInvoiceId || !(await carriesOnlyReleasedCredit(ask))) {
      result.left += 1;
      continue;
    }
    let settled: Awaited<ReturnType<XeroInvoiceBalanceReader>>;
    try {
      settled = await deps.readInvoiceBalance(payment.xeroInvoiceId);
    } catch (err) {
      logger.warn({ err, askRowId: ask.id }, "Could not read the booking's Xero invoice to close a credit-release request; leaving it open");
      result.left += 1;
      continue;
    }
    if (!isSettledInXero(settled)) {
      result.left += 1;
      continue;
    }

    if (ask.stripePaymentIntentId) {
      try {
        const cancelled = await deps.cancelIntent(ask.stripePaymentIntentId, { cancellationReason: "duplicate" });
        const status = cancelled.paymentIntent.status;
        if (status === "succeeded" || (!cancelled.canceled && status !== "canceled")) {
          result.left += 1;
          continue;
        }
      } catch (err) {
        logger.error({ err, askRowId: ask.id }, "Could not cancel a credit-release request's card payment; leaving it open");
        result.left += 1;
        continue;
      }
    }

    const closed = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await lockPaymentForRefundedTotal(tx, ask.paymentId);
        // Re-read under the locks: the request is still the payment's LIVE ask, uncollected, and the
        // booking has not ended meanwhile (a cancel retires the ask but leaves its row FAILED, which
        // this must not turn into cash on a cancelled booking).
        const live = await tx.payment.findUnique({
          where: { id: ask.paymentId },
          select: {
            additionalPaymentIntentId: true,
            additionalPaymentStatus: true,
            booking: { select: { status: true, deletedAt: true } },
          },
        });
        if (
          !live ||
          live.additionalPaymentIntentId !== ask.stripePaymentIntentId ||
          live.additionalPaymentStatus === PaymentStatus.SUCCEEDED ||
          !isAdditionalPaymentDoorOpenForBooking({ bookingStatus: live.booking.status, bookingDeletedAt: live.booking.deletedAt })
        ) {
          return false;
        }
        // The fence: the row is still this unpaid, unwithdrawn request.
        const stamped = await tx.paymentTransaction.updateMany({
          where: {
            id: ask.id,
            withdrawnAt: null,
            carriedAskCents: ask.carriedAskCents,
            status: { in: UNPAID_STATUSES },
          },
          data: { status: PaymentStatus.FAILED, withdrawnAt: options.now ?? new Date() },
        });
        if (stamped.count !== 1) return false;
        await recordInternetBankingPaymentTransaction({
          paymentId: ask.paymentId,
          kind: PaymentTransactionKind.ADDITIONAL,
          amountCents: ask.amountCents,
          status: PaymentStatus.SUCCEEDED,
          xeroInvoiceId: settled.invoiceId,
          xeroInvoiceNumber: settled.invoiceNumber,
          reference: settled.invoiceNumber ? `Xero ${settled.invoiceNumber}` : null,
          reason: CREDIT_RELEASE_PAID_IN_XERO_REASON,
          store: tx,
        });
        await createAuditLog(
          {
            action: "payment.credit_release_ask.closed_paid_in_xero",
            subjectMemberId: bookingOwner(payment.booking).memberId,
            targetId: payment.booking.id,
            entityType: "Booking",
            entityId: payment.booking.id,
            category: "payment",
            severity: "important",
            outcome: "success",
            summary: "A card payment request for credit used in Xero was closed because Xero shows the invoice paid",
            metadata: { askRowId: ask.id, amountCents: ask.amountCents, paymentIntentId: ask.stripePaymentIntentId },
          },
          tx,
        );
        return true;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    if (closed) result.closed += 1;
    else result.left += 1;
  }
  return result;
}

/**
 * Did this request absorb nothing but earlier credit-release requests? Carrying nothing answers
 * yes without a read. Otherwise the payment's newest ADDITIONAL rows must start with this one and
 * carry back only through credit-release rows, every one in hand (`isPureCreditReleaseChain`).
 */
async function carriesOnlyReleasedCredit(ask: { id: string; paymentId: string; carriedAskCents: number }): Promise<boolean> {
  if (ask.carriedAskCents === 0) return true;
  const rows = await prisma.paymentTransaction.findMany({
    where: { paymentId: ask.paymentId, kind: PaymentTransactionKind.ADDITIONAL },
    orderBy: [...LEDGER_ROWS_NEWEST_FIRST],
    take: ASK_CAUSE_ROWS,
    select: { id: true, reason: true, carriedAskCents: true, withdrawnAt: true },
  });
  return rows[0]?.id === ask.id && isPureCreditReleaseChain(rows);
}

/**
 * A release whose booking invoice Xero ALREADY shows paid when the request would be raised
 * (#4253): nothing is asked, but the booking's ledger would still read the released amount as
 * owed and unasked (`INV-PAY-047`), so the money is written as what it was, the same bank-cash row
 * a request closed later gets. Sized under the locks from the booking's own figures, never more
 * than the release, so a repeat finds nothing unasked and writes nothing. Returns the cents written.
 */
export async function recordReleasePaidInXeroCash({
  paymentId,
  releasedCents,
  balance,
}: {
  paymentId: string;
  releasedCents: number;
  balance: { invoiceId: string; invoiceNumber: string | null };
}): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await lockPaymentForRefundedTotal(tx, paymentId);
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: {
          amountCents: true,
          refundedAmountCents: true,
          changeFeeCents: true,
          creditAppliedCents: true,
          additionalAmountCents: true,
          additionalPaymentStatus: true,
          booking: {
            select: { id: true, status: true, deletedAt: true, finalPriceCents: true, memberId: true, member: true, organisation: { select: { name: true, email: true } } },
          },
        },
      });
      if (
        !payment ||
        !isAdditionalPaymentDoorOpenForBooking({ bookingStatus: payment.booking.status, bookingDeletedAt: payment.booking.deletedAt })
      ) {
        return 0;
      }
      const unasked = bookingLedgerResidualCents({
        finalPriceCents: payment.booking.finalPriceCents,
        changeFeeCents: payment.changeFeeCents,
        amountCents: payment.amountCents,
        refundedAmountCents: payment.refundedAmountCents,
        creditAppliedCents: payment.creditAppliedCents,
        additionalAmountCents: payment.additionalAmountCents,
        additionalPaymentStatus: payment.additionalPaymentStatus,
      });
      const cents = Math.min(releasedCents, unasked);
      if (cents <= 0) return 0;
      await recordInternetBankingPaymentTransaction({
        paymentId,
        kind: PaymentTransactionKind.ADDITIONAL,
        amountCents: cents,
        status: PaymentStatus.SUCCEEDED,
        xeroInvoiceId: balance.invoiceId,
        xeroInvoiceNumber: balance.invoiceNumber,
        reference: balance.invoiceNumber ? `Xero ${balance.invoiceNumber}` : null,
        reason: CREDIT_RELEASE_PAID_IN_XERO_REASON,
        store: tx,
      });
      await createAuditLog(
        {
          action: "payment.credit_release_ask.closed_paid_in_xero",
          subjectMemberId: bookingOwner(payment.booking).memberId,
          targetId: payment.booking.id,
          entityType: "Booking",
          entityId: payment.booking.id,
          category: "payment",
          severity: "important",
          outcome: "success",
          summary: "Credit used in Xero was already paid on the booking's invoice, so no card payment was requested",
          metadata: { amountCents: cents },
        },
        tx,
      );
      return cents;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}
