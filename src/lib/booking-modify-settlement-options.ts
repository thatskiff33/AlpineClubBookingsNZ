// Split out of src/lib/booking-modify-settlement.ts (#3829, composing epic
// #3813 with main): what a booking reduction may return and how - the
// policy-tiered options, the untiered full-reduction options (D-3813-5) and
// the one basis both read. Code moved verbatim; import via
// "@/lib/booking-modify" or "@/lib/booking-modify-settlement".

import { setReductionAgainstUnpaidAsk } from "@/lib/additional-payment-ask";
import { readUnpaidPriceAsk, type UnpaidAskDb } from "@/lib/additional-ask-reduction";
import type { CalendarDate } from "@/lib/club-time";
import {
  calculateDualRefundAmounts,
  daysUntilDate,
  loadCancellationPolicy,
  type CancellationPolicyDb,
} from "@/lib/cancellation";
import { hasCapturedPayment, isSettledBookingStatus } from "@/lib/booking-payment-state";
import {
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";
import {
  refundableCashNetOfOpenHandBacks,
  type OpenNonCancellationHandBackDb,
} from "@/lib/edit-refund-hand-back";
import { paidByOrganiserCard } from "@/lib/group-organiser-paid";
import { ApiError } from "@/lib/api-error";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement-required";

export type BookingModificationSettlementOptions = {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
  /**
   * #3653: the booking was paid for by its group organiser, so the reduction
   * goes back to the organiser's card and there is no choice to make - the
   * joiner paid nothing and is never handed account credit for it.
   */
  returnsToOrganiser: boolean;
};

/**
 * `db` is REQUIRED and reads the cancellation policy set: this module is
 * transaction-scoped and imports no module-level client, so a default would hide
 * a second pooled connection under the caller's locks. `INV-LOCK-004`; see
 * `CancellationPolicyDb` in `cancellation.ts`.
 *
 * `todayAtClub` is REQUIRED for the SAME reason and is the other half of the
 * same rule (#3123). `INV-LOCK-004` names the club timezone as one of only two
 * reads that cannot take a transaction client, so the club's day is resolved by
 * whichever caller opened the transaction, BEFORE it opened it, and arrives here
 * as a value. All four production callers hold the global cohort key and the
 * per-lodge capacity key when they reach this line.
 */
export async function calculateModificationSettlementOptions({
  booking,
  netChargeCents,
  db,
  todayAtClub,
}: {
  booking: Pick<
    LoadedBookingForModify,
    "id" | "checkIn" | "status" | "payment" | "lodgeId" | "organiserSettled" | "parentBookingId"
  >;
  netChargeCents: number;
  /**
   * Also reads the payment's OPEN edit refund hand-backs (#3827,
   * `INV-PAY-117`), so a reduction is sized off cash not already promised back,
   * and its unpaid ask (#3954), so it is sized off what that ask leaves.
   */
  db: CancellationPolicyDb & OpenNonCancellationHandBackDb & UnpaidAskDb;
  /**
   * The club's own calendar day (`INV-CONFIG-002`), resolved outside this
   * transaction. It feeds `daysUntilDate` below, which is the refund-tier
   * boundary: a day early tiers a member's reduction refund one step down from
   * the club's published policy.
   */
  todayAtClub: CalendarDate;
}): Promise<BookingModificationSettlementOptions | null> {
  const basisAmountCents = settlementBasisCents(
    booking,
    await reductionLeftAfterUnpaidAsk(db, booking, netChargeCents),
    await refundableCashNetOfOpenHandBacks(db, booking.payment),
  );
  if (basisAmountCents === null) return null;

  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, db);
  const daysUntilCheckIn = daysUntilDate(booking.checkIn, todayAtClub);
  const {
    cardRefundAmountCents,
    cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
  } = calculateDualRefundAmounts(basisAmountCents, daysUntilCheckIn, policy);

  if (paidByOrganiserCard(booking)) {
    // #3653: one disposition, the organiser's card, so nothing to choose. A
    // child the organiser settled by Internet Banking keeps the ordinary
    // options: no card money moved, and that group's settlement is #3642's.
    return {
      basisAmountCents,
      cardRefundAmountCents,
      cardRefundPercentage,
      accountCreditAmountCents: 0,
      accountCreditPercentage: 0,
      daysUntilCheckIn,
      requiresSettlementMethod: false,
      returnsToOrganiser: true,
    };
  }
  return {
    basisAmountCents,
    cardRefundAmountCents,
    cardRefundPercentage,
    accountCreditAmountCents: creditRefundAmountCents,
    accountCreditPercentage: creditRefundPercentage,
    daysUntilCheckIn,
    requiresSettlementMethod:
      cardRefundAmountCents > 0 || creditRefundAmountCents > 0,
    returnsToOrganiser: false,
  };
}

/**
 * #3954: the edit's net once a reduction has been set against the booking's
 * unpaid ask - the figure every settlement option is sized on, so the quote,
 * the save's refusal and the save itself agree (`applyPaymentAdjustments` sets
 * the same ask against the same reduction under its locks).
 */
export async function reductionLeftAfterUnpaidAsk(
  db: UnpaidAskDb,
  booking: Pick<LoadedBookingForModify, "id" | "status" | "payment">,
  netChargeCents: number,
): Promise<number> {
  if (netChargeCents >= 0) return netChargeCents;
  const ask = await readUnpaidPriceAsk(db, booking);
  return setReductionAgainstUnpaidAsk({ netChargeCents, unpaidAskCents: ask.askCents })
    .netChargeLeftCents;
}

/**
 * What a reduction can return from the captured payment: the reduction, capped
 * at what is still refundable — or null when the booking holds no captured
 * payment in a settled status, or there is nothing to return. ONE basis for the
 * policy-tiered options above and the untiered ones below.
 *
 * `refundableCashCents` is REQUIRED and is
 * `refundableCashNetOfOpenHandBacks` (#3827, `INV-PAY-117`): the captured
 * cash not yet refunded AND not already promised back by an open edit refund
 * hand-back.
 */
function settlementBasisCents(
  booking: Pick<LoadedBookingForModify, "status" | "payment">,
  netChargeCents: number,
  refundableCashCents: number,
): number | null {
  const basisAmountCents = Math.min(Math.max(0, -netChargeCents), refundableCashCents);
  const hasSettledPayment =
    isSettledBookingStatus(booking.status) && hasCapturedPayment(booking.payment);
  return basisAmountCents > 0 && hasSettledPayment ? basisAmountCents : null;
}

/**
 * The settlement options for a reduction that is NOT a cancellation, so no
 * cancellation-policy tier applies: the whole basis comes back, by either arm
 * (#3827, owner decision D-3813-5 — a guest's acceptance re-pricing the
 * booking's promo codes). The same basis and shape as
 * {@link calculateModificationSettlementOptions}, at 100%, so the ordinary
 * `applyPaymentAdjustments` settles it unchanged. Pure: no policy is read.
 */
export function calculateFullReductionSettlementOptions({
  booking,
  netChargeCents,
  refundableCashCents,
  todayAtClub,
}: {
  booking: Pick<
    LoadedBookingForModify,
    "checkIn" | "status" | "payment" | "organiserSettled" | "parentBookingId"
  >;
  netChargeCents: number;
  /** `refundableCashNetOfOpenHandBacks`, read by the caller under its locks (`INV-PAY-117`). */
  refundableCashCents: number;
  todayAtClub: CalendarDate;
}): BookingModificationSettlementOptions | null {
  const basisAmountCents = settlementBasisCents(booking, netChargeCents, refundableCashCents);
  if (basisAmountCents === null) return null;
  const daysUntilCheckIn = daysUntilDate(booking.checkIn, todayAtClub);
  if (paidByOrganiserCard(booking)) {
    // #3653, composed by #3829: the booking was paid on the group organiser's
    // card, so "the same way it was paid" (D-3813-5) is that card - one
    // disposition, nothing to choose, exactly as the tiered options above.
    return {
      basisAmountCents,
      cardRefundAmountCents: basisAmountCents,
      cardRefundPercentage: 100,
      accountCreditAmountCents: 0,
      accountCreditPercentage: 0,
      daysUntilCheckIn,
      requiresSettlementMethod: false,
      returnsToOrganiser: true,
    };
  }
  return {
    basisAmountCents,
    cardRefundAmountCents: basisAmountCents,
    cardRefundPercentage: 100,
    accountCreditAmountCents: basisAmountCents,
    accountCreditPercentage: 100,
    daysUntilCheckIn,
    requiresSettlementMethod: true,
    returnsToOrganiser: false,
  };
}

/**
 * Which of the settlement options the member chose, and what the policy keeps.
 * Moved here verbatim from `booking-modify-settlement.ts` (the #3948 merge).
 */
export function resolveSelectedSettlementAmount({
  settlementOptions,
  settlementMethod,
}: {
  settlementOptions: BookingModificationSettlementOptions | null | undefined;
  settlementMethod: BookingModificationSettlementMethod | undefined;
}) {
  if (!settlementOptions) {
    return {
      settlementMethod: null,
      amountCents: 0,
      policyRetainedAmountCents: 0,
    };
  }

  if (settlementOptions.returnsToOrganiser) {
    if (settlementMethod === "credit") {
      throw new ApiError(
        "This booking was paid for by the group organiser, so a reduction goes back to the organiser's card and cannot be held as account credit.",
        400,
      );
    }
    const amountCents = settlementOptions.cardRefundAmountCents;
    return {
      settlementMethod: amountCents > 0 ? ("card" as const) : null,
      amountCents,
      policyRetainedAmountCents: Math.max(0, settlementOptions.basisAmountCents - amountCents),
    };
  }

  if (settlementOptions.requiresSettlementMethod && !settlementMethod) {
    throw new BookingModificationSettlementMethodRequiredError();
  }

  if (!settlementOptions.requiresSettlementMethod) {
    return {
      settlementMethod: null,
      amountCents: 0,
      policyRetainedAmountCents: settlementOptions.basisAmountCents,
    };
  }

  const resolvedMethod = settlementMethod ?? "card";
  const amountCents =
    resolvedMethod === "credit"
      ? settlementOptions.accountCreditAmountCents
      : settlementOptions.cardRefundAmountCents;

  return {
    settlementMethod: resolvedMethod,
    amountCents,
    policyRetainedAmountCents: Math.max(
      0,
      settlementOptions.basisAmountCents - amountCents,
    ),
  };
}
