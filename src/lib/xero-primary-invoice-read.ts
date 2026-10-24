/**
 * #3980 review M1: the primary invoice create's ONE read of the booking, taken
 * from ONE snapshot.
 *
 * The create builds its lines from the guests, nights and promotion rows it
 * reads, and records the worth it built from (`finalPriceCents` plus the
 * recorded fee) so the link's gap check can tell an edit that landed mid-create
 * from how the lines price the booking (`primaryInvoiceWorthGap`). A
 * `findUnique` with relations runs as several SELECTs; under Read Committed an
 * edit committing between them would leave the worth from before it and the
 * lines from after it - a $400 booking, a $100 guest added between the reads,
 * lines billing $500 and a worth of $400 - and the check would bill the $100 a
 * second time. One REPEATABLE READ transaction makes every statement see the
 * same snapshot, so the worth and the lines always describe the same booking.
 *
 * The same snapshot also names the edits already marked as settled against
 * the primary invoice (`markedModificationIdsAtBuild`): an edit marked after it
 * is one that landed while the create was in flight, which is what the
 * treasurer's task describes (review M5).
 *
 * #3953 (`INV-PAY-139`): and the card captures the payment's cash figure holds,
 * oldest first with their net cash (`capturesAtBuild`). The link's save keeps
 * those the cash it recorded covers (`paymentIntentIdsRecordedAtLink`); every
 * other change capture is recorded by its own receipt.
 */
import { prisma } from "@/lib/prisma";
import { FEE_ON_PRIMARY_INVOICE_PATH } from "@/lib/booking-finished-stay-correction";
import { SETTLED_AGAINST_PRIMARY_INVOICE_PATH } from "@/lib/booking-primary-invoice-claim";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";

/**
 * The edits that settled against the primary invoice: an ordinary edit's #3980
 * marker, or a finished-stay correction that routed its fee there (#3955).
 */
export function markedPrimaryInvoiceEditsWhere(bookingId: string) {
  return {
    bookingId,
    OR: [
      { newData: { path: [...SETTLED_AGAINST_PRIMARY_INVOICE_PATH], equals: true } },
      { changeFeeCents: { gt: 0 }, newData: { path: [...FEE_ON_PRIMARY_INVOICE_PATH], equals: true } },
    ],
  };
}

export async function readBookingForPrimaryInvoice(bookingId: string) {
  return prisma.$transaction(
    async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          // Per-night rows (issue #713) so non-contiguous stays produce one line
          // item per contiguous run.
          guests: { include: { nights: true } },
          payment: true,
          promoRedemptions: { include: { promoCode: true, allocations: true } },
          nightAdjustments: true,
          // #2258: recipient for the withheld-send audit row when the booking's
          // "No emails" switch stops Xero emailing the invoice.
          member: { select: { email: true } },
          // #3369: the owner may be an Organisation; bookingOwner() reads both.
          organisation: { select: { name: true, email: true } },
        },
      });
      const marked = booking
        ? await tx.bookingModification.findMany({ where: markedPrimaryInvoiceEditsWhere(bookingId), select: { id: true } })
        : [];
      const captured = booking?.payment
        ? await tx.paymentTransaction.findMany({
            where: {
              paymentId: booking.payment.id,
              source: "STRIPE",
              status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
              stripePaymentIntentId: { not: null },
            },
            orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
            select: { stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
          })
        : [];
      return {
        booking,
        markedModificationIdsAtBuild: marked.map((row) => row.id),
        capturesAtBuild: captured.flatMap((row) =>
          row.stripePaymentIntentId
            ? [{ paymentIntentId: row.stripePaymentIntentId, netCents: Math.max(0, row.amountCents - row.refundedAmountCents) }]
            : [],
        ),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
