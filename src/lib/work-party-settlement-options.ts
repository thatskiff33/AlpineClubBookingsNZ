/**
 * The settlement choice "Add to work party" offers (fork #129) and the method
 * it runs with: pure rules on the booking's payment, moved out of
 * `work-party-booking-correction.ts` to keep that service under its budget.
 * The service is their one caller under the locks; the route and the dialog
 * read the same answer from the service's dry run.
 */
import { ApiError } from "@/lib/api-error";
import { paidByOrganiser } from "@/lib/group-organiser-paid";
import { hasSettledCardPayment } from "@/lib/booking-payment-state";
import { defaultCorrectionSettlementMethod } from "@/lib/booking-finished-stay-correction";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";

export interface WorkPartySettlementOptions {
  /** The methods offered, the default first. Always one for an organiser-paid joiner. */
  methods: readonly BookingModificationSettlementMethod[];
  /** A joiner's booking its group organiser paid: the money goes back to the organiser. */
  paidByOrganiser: boolean;
  /**
   * Where a refund (`card`) goes, when one is offered: to the card the booking
   * was paid with, or by bank transfer (the edit's hand-back,
   * `raiseEditRefundHandBackIfOwed`) for Internet Banking. Null when none is.
   */
  refundTo: "card" | "bank" | null;
}

/** What `workPartySettlementOptions` reads: the booking's lifecycle and payment. */
export interface WorkPartySettlementBooking {
  status: string;
  organiserSettled: boolean;
  parentBookingId: string | null;
  payment: {
    status: string;
    amountCents: number;
    creditAppliedCents: number;
    source: string;
  } | null;
}

/**
 * The settlement methods "Add to work party" offers — exactly the ordinary
 * edit's (upstream owner decision, 15 Nov 2026: "the officer chooses a refund
 * (card or bank, as on an ordinary edit) or account credit"). Pure; the service
 * asks it under its locks, on the edit's own answer, so the preview and the
 * save agree.
 *
 *  - An organiser-paid joiner (`paidByOrganiser`): one disposition, the
 *    organiser's, as every edit of such a booking settles
 *    (`defaultCorrectionSettlementMethod` with `paidByOrganiser`).
 *  - `editAsksForMethod`: the edit's own settlement asked for a method
 *    (`requiresSettlementMethod` on its response) — a paid booking with cash a
 *    reduction can return, whatever it was paid by. Credit, or a refund: to the
 *    card when paid by card (`hasSettledCardPayment`, the test that also
 *    decides a Stripe refund), else by the bank-transfer hand-back.
 *  - Otherwise (unpaid, paid wholly with account credit, nothing refundable):
 *    credit only, as the ordinary edit offers no choice either.
 */
export function workPartySettlementOptions(
  booking: WorkPartySettlementBooking,
  editAsksForMethod: boolean,
): WorkPartySettlementOptions {
  if (paidByOrganiser(booking)) {
    return {
      methods: [workPartyDefaultSettlementMethod(booking)],
      paidByOrganiser: true,
      refundTo: null,
    };
  }
  if (!editAsksForMethod) return { methods: ["credit"], paidByOrganiser: false, refundTo: null };
  return {
    methods: ["credit", "card"],
    paidByOrganiser: false,
    refundTo: hasSettledCardPayment(booking) ? "card" : "bank",
  };
}

/** The method the edit is run with when the officer chose none: club credit, or the organiser's disposition. */
export function workPartyDefaultSettlementMethod(
  booking: WorkPartySettlementBooking,
): BookingModificationSettlementMethod {
  return defaultCorrectionSettlementMethod(booking.payment, {
    changesPromoCodes: true,
    paidByOrganiser: paidByOrganiser(booking),
  });
}

export const WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE =
  "Nothing paid on this booking can be refunded, so the discount can only go back as club credit.";

/**
 * The method the change settles by: the officer's, when it is one offered;
 * the default otherwise. A method not offered — `card` where the edit offers
 * no refund — is refused (409), never quietly changed.
 */
export function resolveWorkPartySettlementMethod(
  options: WorkPartySettlementOptions,
  requested: BookingModificationSettlementMethod | undefined,
): BookingModificationSettlementMethod {
  if (requested !== undefined && !options.methods.includes(requested)) {
    throw new ApiError(
      options.paidByOrganiser
        ? "This booking was paid by its group organiser, so the discount goes back to the organiser."
        : WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE,
      409,
    );
  }
  return requested ?? options.methods[0]!;
}
