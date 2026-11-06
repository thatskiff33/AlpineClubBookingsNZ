/**
 * What the inbound credit-note sync counts as refunded for a modification
 * credit note, and the payment-side facts the refunded-total repair reads
 * (#3979, `INV-PAY-126`). Split out of `credit-note-repairs.ts` by size; that
 * module's `repairRefundedPaymentBusinessState` is the one consumer of the
 * payment-side helpers here, and `credit-note.ts` calls the note-side one.
 */
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { isCapturedTransactionStatus, latestTransactionOfKind } from "@/lib/payment-transaction-status";
import { type AccountCreditAllocationTarget } from "./types";
import { invoiceCorrectionNoteIds, noCashModificationNoteIds } from "./account-credit-modification-notes";
import { receiptCountsInvoiceCorrections } from "./settle-from-cash";

async function resolvePaymentIdsByInvoiceTargets(
  creditNoteId: string,
  allocationTargets: AccountCreditAllocationTarget[]
) {
  const uniqueInvoiceIds = Array.from(
    new Set(
      allocationTargets
        .map((target) => target.invoiceId)
        .filter((invoiceId): invoiceId is string => Boolean(invoiceId))
    )
  );
  if (uniqueInvoiceIds.length === 0) {
    return new Map<string, string>();
  }

  const paymentIdsByInvoiceId = new Map<string, Set<string>>();
  const directMatches = await prisma.payment.findMany({
    where: {
      xeroInvoiceId: {
        in: uniqueInvoiceIds,
      },
    },
    select: {
      id: true,
      xeroInvoiceId: true,
    },
  });

  for (const payment of directMatches) {
    if (!payment.xeroInvoiceId) {
      continue;
    }

    const ids = paymentIdsByInvoiceId.get(payment.xeroInvoiceId) ?? new Set<string>();
    ids.add(payment.id);
    paymentIdsByInvoiceId.set(payment.xeroInvoiceId, ids);
  }

  const unresolvedInvoiceIds = uniqueInvoiceIds.filter(
    (invoiceId) => (paymentIdsByInvoiceId.get(invoiceId)?.size ?? 0) !== 1
  );
  if (unresolvedInvoiceIds.length > 0) {
    const linkedMatches = await prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        xeroObjectType: "INVOICE",
        xeroObjectId: {
          in: unresolvedInvoiceIds,
        },
        active: true,
      },
      select: {
        localId: true,
        xeroObjectId: true,
      },
    });

    for (const link of linkedMatches) {
      const ids = paymentIdsByInvoiceId.get(link.xeroObjectId) ?? new Set<string>();
      ids.add(link.localId);
      paymentIdsByInvoiceId.set(link.xeroObjectId, ids);
    }
  }

  const resolvedPaymentIds = new Map<string, string>();
  for (const invoiceId of uniqueInvoiceIds) {
    const paymentIds = paymentIdsByInvoiceId.get(invoiceId);
    // "Exactly one payment" said as a first with no rest, so the id the
    // resolution stores is a value this branch already holds (#2800).
    const [onlyPaymentId, ...extraPaymentIds] = paymentIds ?? [];
    if (onlyPaymentId !== undefined && extraPaymentIds.length === 0) {
      resolvedPaymentIds.set(invoiceId, onlyPaymentId);
      continue;
    }

    if ((paymentIds?.size ?? 0) > 1) {
      logger.warn(
        {
          creditNoteId,
          invoiceId,
          matchedPayments: paymentIds?.size ?? 0,
        },
        "Skipping refunded-payment repair because the allocated invoice resolved to multiple local payments"
      );
    }
  }

  return resolvedPaymentIds;
}

/**
 * What a modification credit note being synced adds to each matched payment's
 * refunded total: its allocations, by the payment each allocated invoice
 * resolves to. Nothing for a note that moved no cash (`noCashModificationNoteIds`:
 * #3809's give-back, #3954's billed offset, and #3979's invoice correction,
 * `INV-PAY-126`), except that an invoice correction still counts against a
 * payment whose bank receipt was recorded at the stored figure
 * (`paymentsCountingInvoiceCorrections`). The current note's half of what
 * `repairRefundedPaymentBusinessState` counts; the notes already on the payment
 * are filtered by the same rule there.
 */
export async function resolveModificationRefundAmountsByPaymentId(input: {
  creditNoteId: string;
  isModificationNote: boolean;
  allocationTargets: AccountCreditAllocationTarget[];
}): Promise<Map<string, number>> {
  const amounts = new Map<string, number>();
  if (!input.isModificationNote) return amounts;
  const [noCash, corrections] = await Promise.all([
    noCashModificationNoteIds([input.creditNoteId]),
    invoiceCorrectionNoteIds([input.creditNoteId]),
  ]);
  const isCorrection = corrections.has(input.creditNoteId);
  const excludesCash = noCash.has(input.creditNoteId) && !isCorrection;
  const paymentIdsByInvoiceId = await resolvePaymentIdsByInvoiceTargets(
    input.creditNoteId,
    input.allocationTargets
  );
  const counting = isCorrection
    ? await paymentsCountingInvoiceCorrections([...paymentIdsByInvoiceId.values()])
    : null;
  for (const target of input.allocationTargets) {
    const paymentId = paymentIdsByInvoiceId.get(target.invoiceId);
    if (!paymentId || (counting && !counting.has(paymentId))) continue;
    // #4315: retain the affected payment even when this note contributes zero.
    // A resync must remove an early refund counted before this fix; an empty
    // map skips that payment's repair entirely. The shared classifier owns
    // which notes moved no cash (including OPEN and DISMISSED edit hand-backs).
    amounts.set(paymentId, (amounts.get(paymentId) ?? 0) + (excludesCash ? 0 : target.amountCents));
  }
  return amounts;
}

/**
 * #3979 (`INV-PAY-126`): of these payments, those an invoice correction still
 * counts against (`receiptCountsInvoiceCorrections`).
 */
export async function paymentsCountingInvoiceCorrections(paymentIds: string[]): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set();
  const rows = await prisma.paymentTransaction.findMany({
    where: { paymentId: { in: paymentIds }, kind: PaymentTransactionKind.PRIMARY },
    select: { paymentId: true, kind: true, source: true, status: true, reason: true },
  });
  return new Set(
    paymentIds.filter((paymentId) =>
      receiptCountsInvoiceCorrections(rows.filter((row) => row.paymentId === paymentId)),
    ),
  );
}

/**
 * A payment's latest PRIMARY row status when it has PRIMARY rows and none of
 * its rows was ever captured; null otherwise - when something was captured, or
 * when there are no rows at all (a legacy payment, or an organiser-settled
 * child, whose mirror keeps today's answer).
 */
export async function uncapturedPrimaryStatus(paymentId: string): Promise<PaymentStatus | null> {
  const rows = await prisma.paymentTransaction.findMany({
    where: { paymentId },
    select: { kind: true, status: true, createdAt: true, insertionSeq: true },
  });
  if (rows.some((row) => isCapturedTransactionStatus(row.status))) return null;
  return latestTransactionOfKind(rows, PaymentTransactionKind.PRIMARY)?.status ?? null;
}

