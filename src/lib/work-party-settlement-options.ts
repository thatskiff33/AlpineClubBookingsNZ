/**
 * The settlement choice "Add to work party" offers (triyder/AlpineClubBookingsNZ#129) and the method
 * it runs with: pure rules on the booking's payment, moved out of
 * `work-party-booking-correction.ts` to keep that service under its budget.
 * The service is their one caller under the locks; the route and the dialog
 * read the same answer from the service's dry run.
 */
import { ApiError } from "@/lib/api-error";
import { paidByOrganiser } from "@/lib/group-organiser-paid";
import { defaultCorrectionSettlementMethod } from "@/lib/booking-finished-stay-correction";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";
import type { ClubFormat } from "@/lib/club-format";
import { reductionLeftAfterUnpaidAskCents } from "@/lib/additional-payment-ask";
import { workPartyAskAbsorbedSentence } from "@/lib/edit-money-back";
import { formatCents } from "@/lib/utils";

export interface WorkPartySettlementOptions {
  /**
   * The methods offered, the default first. Always one for an organiser-paid
   * joiner; none when an unpaid ask took the whole reduction
   * (`unpaidAskOffsetCents` then names it).
   */
  methods: readonly BookingModificationSettlementMethod[];
  /** A joiner's booking its group organiser paid: the money goes back to the organiser. */
  paidByOrganiser: boolean;
  /**
   * Where a refund (`card`) goes, when one is offered: to the card the booking
   * was paid with, or by bank transfer (the edit's hand-back,
   * `raiseEditRefundHandBackIfOwed`) for Internet Banking. Null when none is.
   */
  refundTo: "card" | "bank" | null;
  /**
   * Present only when an unpaid additional ask took some of the reduction
   * (#3954, the edit's own `unpaidAskOffsetCents`): what it cancelled, in
   * cents, so the dialog can say so. All of it, with `methods` empty: nothing
   * comes back (`workPartyAskAbsorbedSentence`); part of it: the rest comes
   * back as below (`workPartyAskPartlyAbsorbedSentence`).
   */
  unpaidAskOffsetCents?: number;
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
 *  - `edit.asksForMethod`: the edit's own settlement asked for a method
 *    (`requiresSettlementMethod` on its response) — a paid booking with cash a
 *    reduction can return, whatever it was paid by. Credit, or a refund: to the
 *    card where the edit refunds one (`edit.refundsToCard`, the edit's own
 *    `reductionRefundsToCard`, the answer that decides its Stripe refund,
 *    `INV-PAY-160`), else by the bank-transfer hand-back.
 *  - `unpaidAskOffsetCents`, all of it: an unpaid ask took the whole reduction (after
 *    Add, Remove, Add the reduction cancels the ask the Remove raised; B-L1 of
 *    the maintainers' comment
 *    https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6952444211).
 *    Nothing comes back, so nothing is offered.
 *  - Otherwise (unpaid, paid wholly with account credit, nothing refundable):
 *    credit only, as the ordinary edit offers no choice either.
 */
export function workPartySettlementOptions(
  booking: WorkPartySettlementBooking,
  edit: { asksForMethod: boolean; refundsToCard: boolean },
  ask: WorkPartyAskOffset = { unpaidAskOffsetCents: 0, wholly: false },
): WorkPartySettlementOptions {
  if (paidByOrganiser(booking)) {
    return {
      methods: [workPartyDefaultSettlementMethod(booking)],
      paidByOrganiser: true,
      refundTo: null,
    };
  }
  const offset = ask.unpaidAskOffsetCents > 0 ? { unpaidAskOffsetCents: ask.unpaidAskOffsetCents } : {};
  if (ask.wholly) return { methods: [], paidByOrganiser: false, refundTo: null, ...offset };
  if (!edit.asksForMethod) return { methods: ["credit"], paidByOrganiser: false, refundTo: null, ...offset };
  return {
    methods: ["credit", "card"],
    paidByOrganiser: false,
    refundTo: edit.refundsToCard ? "card" : "bank",
    ...offset,
  };
}

/** What an unpaid ask took of the reduction, and whether it took all of it. */
export interface WorkPartyAskOffset {
  unpaidAskOffsetCents: number;
  wholly: boolean;
}

/**
 * Read off the edit's own answer (`unpaidAskOffsetCents` on its result,
 * #3954): whether nothing of the reduction is left once the ask took its
 * offset, by the one rule (`reductionLeftAfterUnpaidAskCents`, `INV-SSOT-001`).
 */
export function workPartyAskOffset(edit: {
  priceDiffCents: number;
  changeFeeCents: number;
  unpaidAskOffsetCents: number;
}): WorkPartyAskOffset {
  const offset = edit.unpaidAskOffsetCents;
  const left = reductionLeftAfterUnpaidAskCents({
    netAmountCents: edit.priceDiffCents + edit.changeFeeCents,
    unpaidAskOffsetCents: offset,
  });
  return { unpaidAskOffsetCents: offset, wholly: offset > 0 && left === 0 };
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
 * the default otherwise, or none where nothing is offered (an unpaid ask took
 * the whole reduction). A method not offered — `card` where the edit offers
 * no refund — is refused (409), never quietly changed, with the reason.
 */
export function resolveWorkPartySettlementMethod(
  options: WorkPartySettlementOptions,
  requested: BookingModificationSettlementMethod | undefined,
  format: ClubFormat,
): BookingModificationSettlementMethod | null {
  if (requested !== undefined && !options.methods.includes(requested)) {
    throw new ApiError(
      options.paidByOrganiser
        ? "This booking was paid by its group organiser, so the discount goes back to the organiser."
        : options.methods.length === 0 && options.unpaidAskOffsetCents
          ? workPartyAskAbsorbedSentence(formatCents(options.unpaidAskOffsetCents, format))
          : WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE,
      409,
    );
  }
  return requested ?? options.methods[0] ?? null;
}
