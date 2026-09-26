/**
 * ATTACHING A FRESHLY MINTED CARD INTENT TO A BOOKING'S PAYMENT — one home for
 * both card mint doors (#3638, `INV-PAY-103`): the session pay route
 * (`create-payment-intent`) and the payment-link route (`/pay/<token>`).
 *
 * The write is serialised with the Internet Banking switch on lock(1), which
 * the switch holds while it re-reads the payment's card intent and moves the
 * payment to Internet Banking. Each door checks the payment's source with no
 * lock before it mints, so a switch can commit between that check and the
 * attach; without the lock, the new intent landed on an Internet Banking
 * payment and its client secret went to the browser beside an emailed Xero
 * invoice. Worse, recording a new card PRIMARY row flips the payment's
 * `source` back to STRIPE (`reconcilePaymentAggregates` reads the newest
 * PRIMARY), which hides a later bank payment from the inbound loop altogether.
 *
 * Whichever commits first wins: a switch first is seen here and refused; this
 * attach first leaves the switch a different intent from the one it cancelled,
 * and it refuses. The booking is re-read too, so an intent minted while the
 * booking was cancelled is not attached and its secret is not handed out.
 *
 * On a refusal the minted intent is cancelled best-effort. Its client secret
 * never leaves the server, so nobody can confirm it; the cancel is tidiness,
 * not safety.
 */
import {
  type BookingStatus,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { cancelPaymentIntentIfCancellableWithResult } from "@/lib/stripe";

export type CardIntentAttachOutcome =
  | "attached"
  | "switchedToInternetBanking"
  | "notPayable";

export async function attachMintedCardIntent({
  bookingId,
  paymentIntentId,
  payableStatuses,
  paymentCreate,
  paymentUpdate,
  transaction,
}: {
  bookingId: string;
  paymentIntentId: string;
  /**
   * The door's own payable statuses, applied to the post-lock re-read. A list,
   * not a predicate: no caller-supplied code runs inside the lock(1)
   * transaction (the #3123 outside-the-transaction census).
   */
  payableStatuses: readonly BookingStatus[];
  /** The Payment row to create when the booking has none yet. */
  paymentCreate: Omit<Prisma.PaymentUncheckedCreateInput, "bookingId" | "status">;
  /** The fields to refresh on an existing Payment row. */
  paymentUpdate: Prisma.PaymentUncheckedUpdateInput;
  transaction: { amountCents: number; reason: string; stripeCustomerId: string };
}): Promise<CardIntentAttachOutcome> {
  const outcome = await prisma.$transaction(
    async (tx): Promise<CardIntentAttachOutcome> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const current = await tx.payment.findUnique({
        where: { bookingId },
        select: { source: true },
      });
      if (current?.source === PaymentSource.INTERNET_BANKING) {
        return "switchedToInternetBanking";
      }
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      });
      if (!booking || !payableStatuses.includes(booking.status)) {
        return "notPayable";
      }

      const payment = await tx.payment.upsert({
        where: { bookingId },
        create: { ...paymentCreate, bookingId, status: PaymentStatus.PENDING },
        update: paymentUpdate,
      });
      await upsertPaymentIntentTransaction({
        paymentId: payment.id,
        kind: PaymentTransactionKind.PRIMARY,
        paymentIntentId,
        amountCents: transaction.amountCents,
        status: PaymentStatus.PROCESSING,
        reason: transaction.reason,
        stripeCustomerId: transaction.stripeCustomerId,
        // Inside the lock: the transaction row and the aggregate reconcile it
        // runs must commit with the source check above, or a switch could
        // land between them.
        store: tx,
      });
      return "attached";
    },
  );

  if (outcome !== "attached") {
    await cancelPaymentIntentIfCancellableWithResult(paymentIntentId).catch(
      (err) =>
        logger.warn(
          { err, bookingId, paymentIntentId, outcome },
          "Could not cancel a card intent minted for a booking that could no longer take it (#3638)",
        ),
    );
  }
  return outcome;
}
