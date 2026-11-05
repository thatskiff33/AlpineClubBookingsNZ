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
  db: Pick<Prisma.TransactionClient, "memberCredit"> = prisma,
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
 * The same predicate for one booking: THE figure the allocation engine
 * (`allocateAppliedCreditForBooking`) allocates, and the one the primary
 * invoice's Stripe cash is capped by so that allocation always fits
 * (`cardSettleAppliedCreditCents`, #3955 round 5, finding 2). Reading the
 * payment's `creditAppliedCents` mirror instead would let the two part.
 */
export async function unallocatedAppliedCents(
  bookingId: string,
  db: Pick<Prisma.TransactionClient, "memberCredit"> = prisma,
): Promise<number> {
  return (await unallocatedAppliedCreditCentsByBooking([bookingId], db)).get(bookingId) ?? 0;
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
      select: SETTLED_BY_CANCEL_BOOKING_SELECT,
    }),
    db.memberCredit.findUnique({ where: { restoredFromBookingId: bookingId }, select: { id: true } }),
  ]);
  return settledByCancel(booking, restore !== null);
}

/** What the rule reads of a booking: its status and its payment's capture evidence. */
const SETTLED_BY_CANCEL_BOOKING_SELECT = {
  status: true,
  payment: {
    select: { id: true, bookingId: true, source: true, status: true, amountCents: true, refundedAmountCents: true, transactions: { select: { status: true } }, booking: { select: { organiserSettled: true, parentBookingId: true } } }, // #3949
  },
} as const satisfies Prisma.BookingSelect;

type SettledByCancelBooking = Prisma.BookingGetPayload<{ select: typeof SETTLED_BY_CANCEL_BOOKING_SELECT }>;

/** THE RULE of {@link appliedCreditSettledByCancel}, over what it read. */
function settledByCancel(booking: SettledByCancelBooking | null, restored: boolean): boolean {
  const cancelled = booking?.status === BookingStatus.CANCELLED || restored;
  return cancelled && !(booking?.payment && paymentHasCaptureEvidence(booking.payment));
}

/**
 * {@link appliedCreditSettledByCancel} for many bookings in two reads: the ids of
 * those whose applied credit the cancel settled. The early warning (#4220) asks it,
 * because the engine plans nothing new for such a booking.
 */
export async function bookingsAppliedCreditSettledByCancel(
  bookingIds: readonly string[],
  db: Prisma.TransactionClient | typeof prisma,
): Promise<Set<string>> {
  if (bookingIds.length === 0) return new Set();
  const [bookings, restores] = await Promise.all([
    db.booking.findMany({ where: { id: { in: [...bookingIds] } }, select: { id: true, ...SETTLED_BY_CANCEL_BOOKING_SELECT } }),
    db.memberCredit.findMany({ where: { restoredFromBookingId: { in: [...bookingIds] } }, select: { restoredFromBookingId: true } }),
  ]);
  const byId = new Map(bookings.map((booking) => [booking.id, booking]));
  const restored = new Set(restores.map((row) => row.restoredFromBookingId));
  return new Set(bookingIds.filter((id) => settledByCancel(byId.get(id) ?? null, restored.has(id))));
}
