import { BookingStatus, type Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import {
  calculateAppliedCreditRestore,
  daysUntilDate,
  loadCancellationPolicy,
  type CancellationPolicyDb,
  type CancellationRule,
} from "@/lib/cancellation";
import type { ClubFormat } from "@/lib/club-format";
import type { CalendarDate } from "@/lib/club-time";
import { deriveBookingAppliedCreditCents, giveBackAppliedCredit } from "@/lib/member-credit";

/** What a paid booking's price reduction gave back of its applied credit (#3809). */
export type PaidReductionCreditGiveBack = {
  /** The credit slice the tier applies to: the reduction the card basis left, capped at the credit applied. */
  basisCents: number;
  givenBackCents: number;
};

/** A paid booking - by its status. A CONFIRMED or PAYMENT_PENDING one is still owing, and a reduction lowers what it owes. */
function isPaid(status: string): boolean {
  return status === BookingStatus.PAID || status === BookingStatus.COMPLETED;
}

/**
 * THE ONE FIGURE (#3809, owner decision A: credit is tiered like a card).
 * The reduction is returned from money paid first - the card basis, which the
 * captured-payment settlement tiers as it always has - and the rest from the
 * applied credit, tiered by the CARD tier as a cancellation tiers applied
 * credit (`calculateAppliedCreditRestore`, #1164 D7), the fixed fee once,
 * card-first. So a booking paid entirely by credit, or by card and credit,
 * gets back what one paid entirely by card at the same price would.
 */
function creditGiveBack(input: {
  reductionCents: number;
  cardBasisCents: number;
  appliedCreditCents: number;
  days: number;
  policy: CancellationRule[];
}): PaidReductionCreditGiveBack {
  const basisCents = Math.max(0, Math.min(input.reductionCents - input.cardBasisCents, input.appliedCreditCents));
  if (basisCents === 0) return { basisCents, givenBackCents: 0 };
  const { creditRestoredCents } = calculateAppliedCreditRestore(basisCents, input.cardBasisCents, input.days, input.policy);
  return { basisCents, givenBackCents: creditRestoredCents };
}

type ReductionInput = {
  /** The edit's net reduction (price and change fee), positive. */
  reductionCents: number;
  /** What the captured payment's settlement tiers (`basisAmountCents`), or 0 with nothing captured. */
  cardBasisCents: number;
  /** The club's day, resolved before any transaction (`INV-LOCK-004`): the tier boundary. */
  todayAtClub: CalendarDate;
};

/**
 * #3809: A PAID BOOKING'S PRICE REDUCTION GIVES BACK APPLIED CREDIT, through
 * the one give-back, `giveBackAppliedCredit` - the clamp's and a review
 * share's - with its Xero deallocation step, asked under the member's
 * credit-ledger lock with the applied credit just read.
 *
 * Inside the edit's transaction, after `lock(1)` and the lodge key and before
 * any `Payment` row write: the member key comes first, then the mirror
 * (`Payment.creditAppliedCents`) is set to the ledger's applied figure, so a
 * later cancellation tiers what is still applied (`INV-LOCK-002`).
 *
 * Null where the booking is not paid, has no member, or has no reduction left
 * beyond the card basis, which leaves the caller's settlement exactly as it
 * was. A cheap unlocked ledger read decides whether any credit is applied at
 * all, so a booking with none never takes the member's key (the clamp's F1
 * gate, `INV-MOD-012`).
 */
export async function giveBackPaidReductionCredit(
  tx: Prisma.TransactionClient,
  {
    booking,
    reductionCents,
    cardBasisCents,
    todayAtClub,
    format,
  }: ReductionInput & {
    booking: LoadedBookingForModify;
    /** Club format resolved before the caller's transaction or ledger lock. */
    format: ClubFormat;
  },
): Promise<PaidReductionCreditGiveBack | null> {
  const memberId = bookingOwner(booking).memberId;
  if (reductionCents - cardBasisCents <= 0 || memberId === null || !isPaid(booking.status)) return null;
  if ((await deriveBookingAppliedCreditCents(booking.id, tx)) <= 0) return null;

  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, tx);
  const days = daysUntilDate(booking.checkIn, todayAtClub);
  let given: PaidReductionCreditGiveBack = { basisCents: 0, givenBackCents: 0 };
  const { appliedCreditCents, givenBackCents, payment } = await giveBackAppliedCredit(
    {
      memberId,
      bookingId: booking.id,
      format,
      description: `Applied credit returned after booking ${booking.id.slice(0, 8)} price reduction`,
      giveBackCentsOf: (applied) => {
        given = creditGiveBack({ reductionCents, cardBasisCents, appliedCreditCents: applied, days, policy });
        return given.givenBackCents;
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
  return { basisCents: given.basisCents, givenBackCents };
}

/**
 * The same figure for the edit's QUOTE (#3809): what saving would give back as
 * account credit, from an unlocked read of the applied credit. Advisory, as
 * the rest of the quote is; the save asks again under the lock.
 */
export async function previewPaidReductionCreditGiveBackCents({
  booking,
  ownerMemberId,
  reductionCents,
  cardBasisCents,
  todayAtClub,
  db,
}: ReductionInput & {
  booking: { id: string; status: string; checkIn: Date; lodgeId: string | null };
  ownerMemberId: string | null;
  db: CancellationPolicyDb & Prisma.TransactionClient;
}): Promise<number> {
  if (reductionCents - cardBasisCents <= 0 || ownerMemberId === null || !isPaid(booking.status)) return 0;
  const appliedCreditCents = await deriveBookingAppliedCreditCents(booking.id, db);
  if (appliedCreditCents <= 0) return 0;
  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, db);
  const days = daysUntilDate(booking.checkIn, todayAtClub);
  return creditGiveBack({ reductionCents, cardBasisCents, appliedCreditCents, days, policy }).givenBackCents;
}
