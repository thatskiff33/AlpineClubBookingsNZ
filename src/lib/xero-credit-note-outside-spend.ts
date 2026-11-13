/**
 * The one reading of a Xero credit note's spend, said once (`INV-SSOT`): what
 * Xero lists against the note, whether that list accounts for what the note has
 * lost, and how much of it the app has no record of.
 *
 * Three callers decide from it and must agree: the failure-triggered converge
 * (#4219, `xero-applied-credit-spent-outside-app.ts`), the inbound mirror (#4270,
 * `xero-credit-note-mirror.ts`) and the early warning that a booking's credit note
 * was spent outside the app (#4220, `xero-credit-note-spent-outside-flag.ts`). A
 * comparator that drifted between them would write the member's credit down twice,
 * or not at all, or warn about a spend the writers would not act on.
 */
import type { Prisma } from "@prisma/client";
import { exactProviderAmountToCents } from "@/lib/money-provider-amount";
import { isLiveXeroPaymentStatus } from "@/lib/xero-payment-status";
import type { XeroNoteAllocation, XeroNotePayment } from "@/lib/xero-credit-note-spent-outside-app";
import { BOOKING_INVOICE_LINK_MODELS } from "@/lib/xero-credit-note-write-down";
import { NOT_CARD_REFUND_REVERSAL_INVOICE_LINK } from "@/lib/xero-card-refund-reversal-outbox";

/** The note's allocations with an exact-cent amount and an invoice (anything else is skipped). */
export function xeroAllocationsOf(
  allocations: ReadonlyArray<{ invoice?: { invoiceID?: string } | null; amount?: unknown; isDeleted?: boolean }> | null | undefined,
): XeroNoteAllocation[] {
  return (allocations ?? []).flatMap((allocation) => {
    if (allocation.isDeleted === true) return [];
    const invoiceId = allocation.invoice?.invoiceID;
    const cents = exactProviderAmountToCents(allocation.amount);
    return invoiceId && cents !== null ? [{ invoiceId, cents }] : [];
  });
}

/** The payments made against the note (refunds of its credit) with an exact-cent amount. */
export function xeroPaymentsOf(
  payments: ReadonlyArray<{ paymentID?: string; amount?: unknown; status?: unknown }> | null | undefined,
): XeroNotePayment[] {
  return (payments ?? []).flatMap((payment) => {
    if (!isLiveXeroPaymentStatus(payment.status)) return [];
    const cents = exactProviderAmountToCents(payment.amount);
    return payment.paymentID && cents !== null ? [{ paymentId: payment.paymentID, cents }] : [];
  });
}

/**
 * The explained-shortfall rail: Xero's list must account for exactly what the
 * note has lost (its total less what remains). A list that does not add up (a
 * removed entry still shown, an amount we could not read) is not acted on.
 */
export function spendIsExplained(evidence: {
  allocations: readonly XeroNoteAllocation[];
  payments: readonly XeroNotePayment[];
  totalCents: number | null;
  remainingCents: number | null;
}): boolean {
  if (evidence.totalCents === null || evidence.remainingCents === null) return false;
  const listedCents =
    evidence.allocations.reduce((sum, a) => sum + a.cents, 0) + evidence.payments.reduce((sum, p) => sum + p.cents, 0);
  return listedCents === evidence.totalCents - evidence.remainingCents;
}

/** A note changed more recently than this is left for a later look (owner decision, 24 Oct 2026). */
export const CREDIT_NOTE_MIRROR_SETTLE_MS = 2 * 60 * 1000;

/** The statuses whose spend is read; a voided or deleted note is a different class of change. */
const ACTIVE_NOTE_STATUSES: readonly string[] = ["AUTHORISED", "PAID"];

/** When a reading changed at `updatedAt` has settled enough to be judged; null when Xero sent no change time. */
export function creditNoteSettlesAt(updatedAt: Date | null): Date | null {
  return updatedAt ? new Date(updatedAt.getTime() + CREDIT_NOTE_MIRROR_SETTLE_MS) : null;
}

/**
 * THE GATES A READING OF A NOTE MUST PASS BEFORE ITS SPEND IS JUDGED, in order:
 * an active note, a list that accounts for exactly what it lost, and a change at
 * least two minutes old (so the app's own allocation or refund payment that is not
 * yet recorded is never read as someone else's). The inbound mirror (#4270) and
 * the early warning (#4220) both ask this one function; `null` means judgeable.
 */
export function judgeOutsideSpendEvidence(
  evidence: Parameters<typeof spendIsExplained>[0] & { status: string | null; updatedAt: Date | null },
  now: Date,
): "note-not-active" | "unexplained-spend" | "unsettled" | null {
  if (!evidence.status || !ACTIVE_NOTE_STATUSES.includes(evidence.status)) return "note-not-active";
  if (!spendIsExplained(evidence)) return "unexplained-spend";
  const settledAt = creditNoteSettlesAt(evidence.updatedAt);
  return !settledAt || settledAt.getTime() > now.getTime() ? "unsettled" : null;
}

/**
 * How much of the note Xero shows spent on things the app has no record of: the
 * allocations to invoices that are not a booking's and the payments it did not
 * make. An invoice is a booking's if a payment's `xeroInvoiceId` is it or a booking
 * `XeroObjectLink` names it; a payment is the app's if a link names it.
 */
export async function outsideSpendCents(
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "payment">,
  allocations: readonly XeroNoteAllocation[],
  payments: readonly XeroNotePayment[],
): Promise<number> {
  const invoiceIds = [...new Set(allocations.map((a) => a.invoiceId))];
  const paymentIds = [...new Set(payments.map((p) => p.paymentId))];
  const [invoiceLinks, localPayments, paymentLinks] = await Promise.all([
    invoiceIds.length
      ? db.xeroObjectLink.findMany({
          // Only a booking's invoice is "the app's own" here: those are the ones the inbound sync
          // mirrors. An offset against a subscription or other invoice moved the member's credit
          // and nothing else will record it.
          where: {
            xeroObjectType: "INVOICE",
            xeroObjectId: { in: invoiceIds },
            localModel: { in: [...BOOKING_INVOICE_LINK_MODELS] },
            // A failed-card-refund reversal is money back in Stripe, not the booking's bill (`INV-PAY-151`).
            ...NOT_CARD_REFUND_REVERSAL_INVOICE_LINK,
          },
          select: { xeroObjectId: true },
        })
      : [],
    invoiceIds.length
      ? db.payment.findMany({ where: { xeroInvoiceId: { in: invoiceIds } }, select: { xeroInvoiceId: true } })
      : [],
    paymentIds.length
      ? db.xeroObjectLink.findMany({
          where: { xeroObjectType: "PAYMENT", xeroObjectId: { in: paymentIds } },
          select: { xeroObjectId: true },
        })
      : [],
  ]);
  const knownInvoices = new Set([
    ...invoiceLinks.map((l) => l.xeroObjectId),
    ...localPayments.flatMap((p) => (p.xeroInvoiceId ? [p.xeroInvoiceId] : [])),
  ]);
  const knownPayments = new Set(paymentLinks.map((l) => l.xeroObjectId));
  return (
    allocations.filter((a) => !knownInvoices.has(a.invoiceId)).reduce((sum, a) => sum + a.cents, 0) +
    payments.filter((p) => !knownPayments.has(p.paymentId)).reduce((sum, p) => sum + p.cents, 0)
  );
}
