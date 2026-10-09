/**
 * #3954 DECISION A (owner, 9 Oct 2026, "Raise a $30 invoice"): A PRICE
 * REDUCTION'S SMALLER RE-ISSUED ASK GETS ITS OWN SUPPLEMENTARY XERO INVOICE.
 *
 * The reduction retired the increase's parked invoice with the ask it waited
 * on (`retireUnpaidAskChain`) and recorded, on its own history row, what the
 * smaller ask's invoice bills (`recordedReissuedAskInvoiceCents`: the retired
 * invoices' money less the offset, never more than the ask). Once that ask is
 * minted - by the door after commit or by its recovery's replay - its invoice
 * is queued on the reducing edit, parked `WAITING_PAYMENT` on the minted
 * intent and recording the payment when it is captured, exactly as an
 * ordinary increase's invoice waits for its intent. Xero then matches what
 * the member is asked to pay.
 *
 * Best-effort, like every after-commit Xero leg: a failure is logged, and the
 * booking-vs-Xero repair pass reports the reduction's missing invoice. The
 * enqueue's one-invoice-per-anchor lock makes a second call (door and replay
 * both reaching here) queue nothing.
 */
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { recordedReissuedAskInvoiceCents } from "@/lib/unpaid-ask-offset-marker";
import { enqueueXeroSupplementaryInvoiceOperation } from "@/lib/xero-operation-outbox";

export async function queueReissuedAskSupplementaryInvoice({
  bookingId,
  bookingModificationId,
  paymentIntentId,
}: {
  bookingId: string;
  /** The REDUCING edit, whose history records the figure and which anchors the invoice. */
  bookingModificationId: string;
  /** The re-issued ask's minted intent, which releases the invoice when captured. */
  paymentIntentId: string;
}): Promise<void> {
  try {
    const modification = await prisma.bookingModification.findUnique({
      where: { id: bookingModificationId },
      select: { newData: true },
    });
    const invoiceCents = recordedReissuedAskInvoiceCents(modification?.newData);
    if (invoiceCents <= 0) return;
    await enqueueXeroSupplementaryInvoiceOperation(
      { bookingId, priceDiffCents: invoiceCents, changeFeeCents: 0, bookingModificationId },
      { paymentIntentId, waitForConfirmedAdditionalPayment: true, recordPayment: true },
    );
  } catch (err) {
    logger.error(
      { err, bookingId, bookingModificationId, paymentIntentId },
      "Failed to queue the supplementary Xero invoice for a re-issued additional ask (#3954); the booking-vs-Xero repair pass reports it",
    );
  }
}
