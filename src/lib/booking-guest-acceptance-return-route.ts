// Split out of `booking-guest-acceptance-reprice.ts` (#3829, composing epic
// #3813 with main, to keep that module inside its size budget): the D-3813-5
// return route a guest's acceptance re-price settles by. Code moved verbatim.

import type { Prisma } from "@prisma/client";

import type { LoadedBookingForModify } from "@/lib/booking-modify";
import {
  calculateFullReductionSettlementOptions,
  type BookingModificationSettlementOptions,
} from "@/lib/booking-modify-settlement";
import { bookingOwner } from "@/lib/booking-owner";
import { hasCapturedPayment, isSettledBookingStatus } from "@/lib/booking-payment-state";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import type { CalendarDate } from "@/lib/club-time";
import { refundableCashNetOfOpenHandBacks } from "@/lib/edit-refund-hand-back";
import { deriveBookingAppliedCreditCents, lockMemberCreditLedger } from "@/lib/member-credit";

export type CreditReturn = { amountCents: number; memberId: string };

export type FullReductionReturnRoute =
  | { kind: "none" }
  | {
      kind: "money-back";
      settlementOptions: BookingModificationSettlementOptions;
      /** The part of the reduction the cash could not cover, paid with credit (D-3813-5). */
      creditRemainder: CreditReturn | null;
    }
  | ({ kind: "account-credit" } & CreditReturn);

/**
 * D-3813-5: how the whole of a reduction goes back the way the booking was
 * paid, or null when it cannot go back in full. `none` is a booking whose
 * payment is not captured (it simply costs less) and every non-reduction.
 *
 * Cash first, up to what is still refundable, then credit for the rest. The
 * credit share is returned by netting the applied credit down to the new price
 * (`clampAppliedCreditToBookingPrice`), which gives back exactly the remainder
 * only when the refundable cash and the credit applied together ARE the price
 * — so that is the test, read under the member's ledger lock, which the return
 * then re-takes, so the two agree. An organisation holds no credit, so a
 * reduction its cash cannot cover cannot go back at all.
 */
export async function fullReductionReturnRoute(
  tx: Prisma.TransactionClient,
  booking: {
    id: string;
    status: string;
    finalPriceCents: number;
    payment: LoadedBookingForModify["payment"];
  },
  loaded: LoadedBookingForModify,
  priceDiffCents: number,
  todayAtClub: CalendarDate,
): Promise<FullReductionReturnRoute | null> {
  const reductionCents = Math.max(0, -priceDiffCents);
  if (reductionCents === 0) return { kind: "none" };
  const capturedCash = isSettledBookingStatus(booking.status) && hasCapturedPayment(booking.payment);
  if (!capturedCash && !isPaidLikeBookingStatus(booking.status)) return { kind: "none" };
  // Captured cash: the edit's money-back arm, at 100% and never above what is
  // still refundable (`calculateFullReductionSettlementOptions`); null once a
  // card has been refunded in full.
  // Net of edit refunds already promised back by hand (#3827, `INV-PAY-117`):
  // an earlier edit's open task is cash the club owes, not cash it holds.
  const settlementOptions = capturedCash
    ? calculateFullReductionSettlementOptions({
        booking: loaded,
        netChargeCents: priceDiffCents,
        refundableCashCents: await refundableCashNetOfOpenHandBacks(tx, booking.payment),
        todayAtClub,
      })
    : null;
  const cashCents = settlementOptions?.basisAmountCents ?? 0;
  if (settlementOptions && cashCents === reductionCents) {
    return { kind: "money-back", settlementOptions, creditRemainder: null };
  }
  const creditHolder = bookingOwner(loaded).memberId;
  if (creditHolder === null) return null;
  await lockMemberCreditLedger(creditHolder, tx);
  const appliedCreditCents = await deriveBookingAppliedCreditCents(booking.id, tx);
  if (appliedCreditCents + cashCents !== booking.finalPriceCents) return null;
  const creditReturn = { amountCents: reductionCents - cashCents, memberId: creditHolder };
  return settlementOptions
    ? { kind: "money-back", settlementOptions, creditRemainder: creditReturn }
    : { kind: "account-credit", ...creditReturn };
}
