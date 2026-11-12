/**
 * The late-notice change fee on a date edit (owner decision, 10 Nov 2026).
 *
 * An unpaid booking is not charged one, and none is recorded. A booking counts
 * as paid when its status is paid-like (`PAID` or `COMPLETED`) — including one
 * paid entirely with account credit or a promotion, whose payment captured
 * nothing — or when a payment has already been captured, even if the status
 * has not flipped yet. Who holds a bed is not part of the question.
 *
 * `calculateChangeFee` stays the tier math. This leaf is its only production
 * caller, so a door cannot charge the fee and forget the gate. Callers still
 * force zero themselves when lifecycle rules are skipped or the check-in did
 * not change, before they get here. A finished stay's removal retention does
 * not come through here.
 */
import type { CalendarDate } from "@/lib/club-time";
import { hasCapturedPayment, type BookingPaymentState } from "@/lib/booking-payment-state";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import {
  daysUntilDate,
  loadCancellationPolicy,
  type CancellationPolicyDb,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";

/** Whether a date edit of this booking can incur a late-notice change fee. */
export function lateNoticeChangeFeeApplies(booking: {
  status: string;
  payment?: BookingPaymentState | null;
}): boolean {
  return isPaidLikeBookingStatus(booking.status) || hasCapturedPayment(booking.payment);
}

/**
 * The late-notice fee for moving `booking.checkIn` to `newCheckIn`, or zero
 * when the booking has not been paid. `db` is the caller's client: a door
 * inside a transaction passes its `tx` (`INV-LOCK-004`).
 */
export async function lateNoticeChangeFee(input: {
  booking: {
    status: string;
    checkIn: Date;
    finalPriceCents: number;
    payment?: BookingPaymentState | null;
  };
  lodgeId: string | null;
  newCheckIn: Date;
  db: CancellationPolicyDb;
  todayAtClub: CalendarDate;
}): Promise<number> {
  if (!lateNoticeChangeFeeApplies(input.booking)) return 0;
  const { db } = input;
  const policy = await loadCancellationPolicy(input.booking.checkIn, input.lodgeId, db);
  return calculateChangeFee({
    // One club day for both operands, so the old and new day-counts cannot
    // be measured from two different todays.
    daysUntilOriginalCheckIn: daysUntilDate(input.booking.checkIn, input.todayAtClub),
    daysUntilNewCheckIn: daysUntilDate(input.newCheckIn, input.todayAtClub),
    originalFinalPriceCents: input.booking.finalPriceCents,
    policyRules: policy,
  }).feeCents;
}
