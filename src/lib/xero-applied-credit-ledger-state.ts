/**
 * The applied-credit ledger's two questions the allocation engine asks before
 * it plans (#1620, #3836), split from `xero-applied-credit-allocation.ts` so the
 * engine stays within its size budget: what is still unallocated, and whether a
 * cancel has already settled it.
 */
import { BookingStatus, CreditType, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { paymentHasCaptureEvidence } from "@/lib/cancel-flattened-payment-backfill";

/**
 * THE unallocated predicate (#1620, #3836 `INV-PAY-024`): per booking, the
 * applied credit whose `BOOKING_APPLIED` rows carry no Xero note yet. The
 * engine, its enqueue and the Xero booking repair pass all read this one form.
 */
export async function unallocatedAppliedCreditCentsByBooking(
  bookingIds: string[],
  db: { memberCredit: Pick<Prisma.TransactionClient["memberCredit"], "groupBy"> } = prisma,
): Promise<Map<string, number>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db.memberCredit.groupBy({
    by: ["appliedToBookingId"],
    where: { appliedToBookingId: { in: bookingIds }, type: CreditType.BOOKING_APPLIED, xeroCreditNoteId: null },
    _sum: { amountCents: true },
  });
  return new Map(
    rows.flatMap((row) =>
      row.appliedToBookingId ? [[row.appliedToBookingId, Math.max(0, -(row._sum.amountCents ?? 0))] as const] : [],
    ),
  );
}

/**
 * #3836 (H1): whether the cancel has settled this booking's applied credit -
 * the booking is CANCELLED, or a restore row names it, AND its payment holds no
 * captured money (`paymentHasCaptureEvidence`). Such an invoice is answered by
 * a clearing note sized net of the slices already committed (the unpaid
 * cancel's, or the repair pass's `CANCELLED_BOOKING_OPEN_INVOICE`), so the
 * engine then only finishes those slices: a new plan or mint would credit the
 * invoice a second time beside that note. A captured booking's cancel clears
 * nothing - its invoice stands as paid - so its allocation still runs, as
 * before. Read under the member's credit-ledger key, which the cancel's
 * restore takes too.
 */
export async function appliedCreditSettledByCancel(
  bookingId: string,
  db: Prisma.TransactionClient | typeof prisma,
): Promise<boolean> {
  const [booking, restore] = await Promise.all([
    db.booking.findUnique({
      where: { id: bookingId },
      select: {
        status: true,
        payment: {
          select: { id: true, bookingId: true, source: true, status: true, amountCents: true, refundedAmountCents: true, transactions: { select: { status: true } } },
        },
      },
    }),
    db.memberCredit.findUnique({ where: { restoredFromBookingId: bookingId }, select: { id: true } }),
  ]);
  const cancelled = booking?.status === BookingStatus.CANCELLED || restore !== null;
  return cancelled && !(booking?.payment && paymentHasCaptureEvidence(booking.payment));
}
