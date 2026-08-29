import "server-only";

import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import {
  MANUAL_PAYMENT_NOTE_MAX,
  normaliseManualPaymentNote,
} from "@/lib/manual-subscription-payment";
import {
  ManualBookingPaymentError,
  markBookingPaymentManuallySettled,
  reverseManualBookingPayment,
  type ManualAdditionalCoverage,
} from "@/lib/payment-reconciliation";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";
import { prisma } from "@/lib/prisma";

/**
 * B5 (#2262): admin-recorded settlement of a booking payment made in cash, or
 * by a bank transfer that never reached Xero.
 *
 * This module is the ORCHESTRATION around the settlement core: it normalises the
 * admin's note, calls the sibling entry point in `payment-reconciliation.ts`
 * (which is where every lock, capacity check, fence and durable fact lives), and
 * then — AFTER the transaction commits — dispatches the member's confirmation
 * email and reports honestly what became of it.
 *
 * Semantics, mirroring the #1944 subscription precedent verbatim:
 *  * manual mark-paid exists ONLY where NO Xero invoice exists. It is refused
 *    when the payment carries a Xero invoice link, a credit note, a Xero id on
 *    any of its transactions, an active PRIMARY_INVOICE object link, a completed
 *    CREATE-INVOICE outbox operation, or one still in flight. It NEVER calls
 *    Xero and NEVER creates or voids an invoice.
 *  * both directions are status-fenced (conditional updateMany, 409 when no row
 *    matches), so two admins clicking at once — or a Xero sync landing between
 *    read and write — can never double-apply or clobber.
 *  * #2260: marking paid REQUIRES the club's "email the member or not" choice
 *    (a discriminated union, so omitting it is a compile error) and records it
 *    in the audit entry either way. A reversal emails nobody, so the union
 *    forbids passing the flag at all on that path.
 *  * #2258: the per-booking "No emails" switch is enforced by the MAILER, not
 *    by a per-action bypass here. If it is on, the send is withheld and the
 *    receipt honestly reports not-delivered.
 *  * #2397: when the booking carries an OUTSTANDING upward-modification delta,
 *    the admin is asked whether the cash covers it and the answer travels with
 *    the settle. Said covered, the extra is settled through the same columns
 *    every surface reads (so nothing chases it). Said NOT covered, the extra is
 *    left outstanding AND subtracted from the settled figure (owner decision,
 *    31 Jul 2026), so the club records what it actually took rather than the
 *    booking's whole worth. A booking with no extra sends nothing and behaves
 *    identically to before this feature existed.
 */
export { ManualBookingPaymentError };
export { MANUAL_PAYMENT_NOTE_MAX };

export type ManualBookingPaymentDirection = "paid" | "unpaid";

/**
 * What actually became of the member's receipt, so no caller can turn a
 * decision into a claim that the member was emailed:
 *   not_requested — the admin declined it, or this was a reversal
 *   queued        — handed to the mailer for delivery (not proof of arrival)
 *   not_delivered — the mailer suppressed it (including the #2258 switch), the
 *                   address was a club-internal placeholder, or the send failed
 */
export type ManualBookingPaymentReceipt =
  | "not_requested"
  | "queued"
  | "not_delivered";

export type ApplyManualBookingPaymentInput =
  | {
      bookingId: string;
      direction: "paid";
      note?: string | null;
      actingMemberId: string;
      notifyMember: boolean;
      /** The amount owing the admin saw in the dialog; stale-price protection. */
      expectedAmountCents: number;
      /**
       * #2397: the admin's answer to "does this cash cover the outstanding
       * extra?", or null/absent to claim the dialog showed no extra. Absence is
       * a CLAIM, not a shrug — the settle re-derives the outstanding extra under
       * its locks and 409s when the claim is wrong — so the common no-extra
       * screen stays exactly as it was while a stale client can never settle
       * only the primary on a booking that has since grown one.
       */
      additionalCoverage?: ManualAdditionalCoverage | null;
    }
  | {
      bookingId: string;
      direction: "unpaid";
      note?: string | null;
      actingMemberId: string;
      notifyMember?: never;
      expectedAmountCents?: never;
      additionalCoverage?: never;
    };

/**
 * #2397: what became of a booking's outstanding upward-modification delta.
 * Null when the booking carried none — the overwhelmingly common case, and the
 * one where the dialog asks nothing.
 */
export type ManualBookingAdditionalOutcome = {
  /** What was outstanding when the settle ran, in integer cents. */
  outstandingCents: number;
  /**
   * On "paid": the admin said this cash covered it, so it is settled and no
   * surface will chase it. On "unpaid": this reversal put it back to owing.
   */
  settled: boolean;
  /**
   * #2397 (owner decision, 31 Jul 2026): what the club recorded as received.
   * When the extra was NOT covered this is the amount owing before the change —
   * strictly less than the booking's worth — because the books must show what
   * was actually handed over.
   */
  recordedAmountCents: number;
  /**
   * #2397 F4: on an extra left owing, whether the member can pay it themselves
   * from their booking page — i.e. whether the settlement left the addition's
   * card intent armed instead of cancelling it. False means the only route to
   * the money is the club contacting them, and the admin standing at the till
   * has to be told that, because "we will keep asking" is a very different
   * instruction from "they can pay it online tonight". Always false on a
   * reversal and on the covered answer, where there is nothing left to pay.
   *
   * DELIBERATELY CONSERVATIVE, and it can under-promise. It is derived from the
   * intent the settlement actually SPARED, which exists only when a live
   * PENDING/PROCESSING ADDITIONAL `PaymentTransaction` row pointed at
   * `Payment.additionalPaymentIntentId`. A legacy or hand-repaired payment that
   * carries the pointer with no such local row is told "the club will be in
   * touch" even though `/api/bookings/[id]/additional-payment-secret` reads the
   * pointer alone and their pay card would still open. That way round is the
   * safe one: the failure is an extra phone call, whereas claiming a pay door
   * that this settle has just cancelled sends the member to a dead intent and
   * leaves the club chasing money nobody can send. Do not "fix" this by reading
   * the pointer directly unless something first proves the intent is still live
   * at Stripe.
   */
  payableOnline: boolean;
};

export type ApplyManualBookingPaymentResult = {
  bookingId: string;
  paymentId: string;
  direction: ManualBookingPaymentDirection;
  /** The admin's email decision as recorded in the audit log. */
  memberNotified: boolean;
  receipt: ManualBookingPaymentReceipt;
  /**
   * Settlement amount (paid) or the amount un-recorded (unpaid), in cents.
   *
   * #2397: on "paid" this is what the club RECORDED AS RECEIVED, which is the
   * amount owing less any outstanding extra the admin said the cash did not
   * cover — not the booking's whole worth.
   */
  amountCents: number;
  /** Booking status after the action. */
  bookingStatus: string;
  /**
   * #2265 (#2262 door 3): the stored credit election this action moved, in
   * integer cents, or null when there was none.
   *
   * On "paid" it is what the settle CLEARED — the member had asked to spend
   * this much credit and the cash settlement could not honour it. On "unpaid"
   * it is what the reversal RESTORED. Returned synchronously so the admin
   * standing at the till is told at once, rather than only through the
   * post-commit operator alert, which a club that has muted the
   * `adminPaymentFailure` preference will never receive.
   */
  creditElectionCents: number | null;
  /**
   * #2397: the outstanding extra this action moved, and which way. Null when
   * the booking carried none. Returned synchronously so the admin standing at
   * the till is told what happened to the extra at the same moment they are
   * told the payment was recorded.
   */
  additional: ManualBookingAdditionalOutcome | null;
};

export async function applyManualBookingPayment(
  input: ApplyManualBookingPaymentInput
): Promise<ApplyManualBookingPaymentResult> {
  const note = normaliseManualPaymentNote(input.note);

  if (input.direction === "unpaid") {
    const reversal = await reverseManualBookingPayment({
      bookingId: input.bookingId,
      actingAdminMemberId: input.actingMemberId,
      note,
    });
    return {
      bookingId: reversal.bookingId,
      paymentId: reversal.paymentId,
      direction: "unpaid",
      memberNotified: false,
      receipt: "not_requested",
      amountCents: reversal.reversedAmountCents,
      bookingStatus: reversal.restoredStatus,
      creditElectionCents: reversal.restoredCreditElectionCents,
      additional:
        reversal.restoredAdditionalAmountCents != null
          ? {
              outstandingCents: reversal.restoredAdditionalAmountCents,
              settled: false,
              recordedAmountCents: reversal.reversedAmountCents,
              // A reversal un-records the whole settlement; the booking is
              // unpaid again and the member's ordinary pay door governs, so
              // there is no partial-balance instrument to point at.
              payableOnline: false,
            }
          : null,
    };
  }

  const settlement = await markBookingPaymentManuallySettled({
    bookingId: input.bookingId,
    actingAdminMemberId: input.actingMemberId,
    note,
    expectedAmountCents: input.expectedAmountCents,
    notifyMember: input.notifyMember,
    additionalCoverage: input.additionalCoverage ?? null,
  });

  // Dispatched AFTER commit, never inside the transaction. A send failure must
  // never undo or 500 the committed money state — but it must never be
  // swallowed either, or the admin is told a confirmation went out when nothing
  // did. Every branch that ends without a queued send says so, in the log and
  // in the returned receipt.
  let receipt: ManualBookingPaymentReceipt = "not_requested";
  if (input.notifyMember) {
    const recipient = await prisma.booking
      .findUnique({
        where: { id: input.bookingId },
        select: {
          lodgeId: true,
          memberId: true,
          checkIn: true,
          checkOut: true,
          finalPriceCents: true,
          discountCents: true,
          promoAdjustmentCents: true,
          member: { select: { email: true, firstName: true } },
          promoRedemption: { select: { promoCode: { select: { code: true } } } },
          _count: { select: { guests: true } },
        },
      })
      .catch((err) => {
        logger.error(
          { err, bookingId: input.bookingId },
          "Manual booking mark-paid: could not read the booking to send the member's confirmation"
        );
        return null;
      });

    if (!recipient?.member?.email) {
      logger.warn(
        { bookingId: input.bookingId },
        "Manual booking mark-paid: a confirmation was requested but the member has no address to send it to"
      );
      receipt = "not_delivered";
    } else {
      try {
        // Split-booking parent (#738/#1942), parity with every comparable
        // settle-time send (invoice-paid-effects et al.): describe the
        // provisional non-member child so the confirmation explains the
        // separate later charge. Read-only; null on non-split bookings.
        const provisionalGuests = await getProvisionalNonMemberChildSummary({
          id: input.bookingId,
          memberId: recipient.memberId,
        });
        // The SAME message the Xero-inbound settle sends, so a cash-settled
        // member reads exactly what a bank-transfer-settled member reads.
        //
        // #2397 F1: EXCEPT when the club knowingly took less than the booking
        // is worth. `finalPriceCents` is still the booking's price — it is what
        // the promo rows and the "Booking Total" line are derived from — but
        // the settled figure and the price now DIVERGE, and the default
        // confirmation would say "Total Paid: <whole price>. Payment has been
        // processed successfully." while the admin's own receipt says only part
        // of it was recorded and the member will still be asked for the rest.
        // The same HTTP response cannot say both. Passing the balance switches
        // the money rows to Booking Total / Paid / Still Owing and replaces the
        // success box with what actually happens next — which is the very
        // contradiction #2397 exists to remove, stated to the member rather
        // than only to the admin.
        const outcome = await sendBookingConfirmedEmail(
          { bookingId: input.bookingId, recipientMemberId: recipient.memberId },
          recipient.member.email,
          recipient.member.firstName,
          recipient.checkIn,
          recipient.checkOut,
          recipient._count.guests,
          recipient.finalPriceCents,
          {
            lodgeId: recipient.lodgeId,
            ...(provisionalGuests ? { provisionalGuests } : {}),
            ...(settlement.uncollectedAdditionalCents > 0
              ? {
                  outstandingBalance: {
                    amountCents: settlement.uncollectedAdditionalCents,
                    // #2397 F4: true only when the settlement actually left the
                    // addition's card intent armed, so the email never sends
                    // the member to a pay door that will not open. Conservative
                    // by design — see `payableOnline` on
                    // ManualBookingAdditionalOutcome for the legacy shape where
                    // it under-promises, and why that is the right way round.
                    payableOnline:
                      settlement.sparedAdditionalPaymentIntentId !== null,
                  },
                }
              : {}),
            ...(recipient.promoRedemption?.promoCode
              ? {
                  discountCents: recipient.discountCents,
                  promoAdjustmentCents: recipient.promoAdjustmentCents,
                  promoCode: recipient.promoRedemption.promoCode.code,
                }
              : {}),
          }
        );
        // "sent" means the mailer accepted and dispatched it. Anything else —
        // the #2258 No-emails switch, a suppression, a club-internal
        // placeholder address, an outright failure — means the member will not
        // read this, and the admin has to hear that.
        receipt = outcome?.status === "sent" ? "queued" : "not_delivered";
        if (receipt === "not_delivered") {
          logger.warn(
            { bookingId: input.bookingId, outcome: outcome?.status ?? "unknown" },
            "Manual booking payment recorded, but the member confirmation was not sent"
          );
        }
      } catch (error) {
        logger.error(
          { err: error, bookingId: input.bookingId },
          "Manual booking payment recorded, but the member confirmation failed to send"
        );
        receipt = "not_delivered";
      }
    }
  }

  return {
    bookingId: settlement.bookingId,
    paymentId: settlement.paymentId,
    direction: "paid",
    memberNotified: input.notifyMember,
    receipt,
    amountCents: settlement.effectiveAmountCents,
    bookingStatus: "PAID",
    creditElectionCents: settlement.staleCreditElectionCents,
    additional:
      settlement.outstandingAdditionalCents > 0
        ? {
            outstandingCents: settlement.outstandingAdditionalCents,
            settled: settlement.settledAdditionalAmountCents > 0,
            recordedAmountCents: settlement.effectiveAmountCents,
            payableOnline: settlement.sparedAdditionalPaymentIntentId !== null,
          }
        : null,
  };
}
