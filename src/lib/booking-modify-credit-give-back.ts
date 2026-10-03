import { BookingStatus, type Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import { calculateAppliedCreditRestore, daysUntilDate, loadCancellationPolicy } from "@/lib/cancellation";
import type { ClubFormat } from "@/lib/club-format";
import type { CalendarDate } from "@/lib/club-time";
import { deriveBookingAppliedCreditCents, giveBackAppliedCredit } from "@/lib/member-credit";

/** What a credit-paid booking's price reduction gave back (#3809). */
export type CreditPaidReductionGiveBack = {
  /** `min(reduction, applied credit)`, the slice the tier applies to. */
  basisCents: number;
  givenBackCents: number;
};

/**
 * A booking paid ENTIRELY with account credit: paid by its status, with nothing
 * captured. A CONFIRMED booking is left out on purpose - with nothing captured
 * it is an internet-banking hold still owing, and a reduction lowers what it
 * owes, as before.
 */
function isCreditPaid(booking: Pick<LoadedBookingForModify, "status" | "payment">): boolean {
  const paid = booking.status === BookingStatus.PAID || booking.status === BookingStatus.COMPLETED;
  return paid && !hasCapturedPayment(booking.payment);
}

/**
 * #3809 (owner decision A, 2 Oct 2026): AN ORDINARY PRICE REDUCTION ON A
 * CREDIT-PAID BOOKING GIVES BACK WHAT A CARD-PAID ONE WOULD GET. With nothing
 * captured, the card-path settlement has no base (`hasCapturedPayment`), so the
 * member got nothing back and, with no later cancellation, stayed short.
 *
 * The base is `min(reduction, applied credit)`, tiered by the CARD tier as a
 * cancellation tiers applied credit (`calculateAppliedCreditRestore`, #1164 D7,
 * no card slice), so a reduction then a cancellation returns what a card-paid
 * booking would. It is settled through the one give-back, `giveBackAppliedCredit`
 * - the clamp's and a review share's - with its Xero deallocation step, and
 * asked under the member's credit-ledger lock with the applied credit just read.
 *
 * Inside the edit's transaction, after `lock(1)` and the lodge key and before
 * any `Payment` row write: the member key comes first, then the mirror
 * (`Payment.creditAppliedCents`) is set to the ledger's applied figure, so a
 * later cancellation tiers what is still applied (`INV-LOCK-002`).
 *
 * Null where this is not a credit-paid booking's reduction, which leaves the
 * caller's settlement exactly as it was. A cheap unlocked ledger read decides
 * whether any credit is applied at all, so a booking with none never takes the
 * member's key (the clamp's F1 gate, `INV-MOD-012`).
 */
export async function giveBackCreditPaidReduction(
  tx: Prisma.TransactionClient,
  {
    booking,
    reductionCents,
    todayAtClub,
    format,
  }: {
    booking: LoadedBookingForModify;
    reductionCents: number;
    /** The club's day, resolved before the transaction (`INV-LOCK-004`): the tier boundary. */
    todayAtClub: CalendarDate;
    /** Club format resolved before the caller's transaction or ledger lock. */
    format: ClubFormat;
  },
): Promise<CreditPaidReductionGiveBack | null> {
  const memberId = bookingOwner(booking).memberId;
  if (reductionCents <= 0 || memberId === null || !isCreditPaid(booking)) return null;
  if ((await deriveBookingAppliedCreditCents(booking.id, tx)) <= 0) return null;

  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, tx);
  const days = daysUntilDate(booking.checkIn, todayAtClub);
  let basisCents = 0;
  const { appliedCreditCents, givenBackCents, payment } = await giveBackAppliedCredit(
    {
      memberId,
      bookingId: booking.id,
      format,
      description: `Applied credit returned after booking ${booking.id.slice(0, 8)} price reduction`,
      giveBackCentsOf: (applied) => {
        basisCents = Math.min(reductionCents, applied);
        return calculateAppliedCreditRestore(basisCents, 0, days, policy).creditRestoredCents;
      },
    },
    tx,
  );
  if (givenBackCents > 0 && payment) {
    await tx.payment.update({
      where: { id: payment.id },
      data: { creditAppliedCents: appliedCreditCents - givenBackCents },
    });
  }
  return { basisCents, givenBackCents };
}
