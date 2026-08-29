import "server-only";

import {
  BookingEventType,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
} from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";
import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import {
  MANUAL_PAYMENT_NOTE_MAX,
  MANUAL_REFUND_TASK_REASON_MAX,
} from "@/lib/manual-subscription-payment";
import {
  ManualBookingPaymentError,
  markBookingPaymentManuallySettled,
  reverseManualBookingPayment,
  type ManualAdditionalCoverage,
} from "@/lib/payment-reconciliation";
import { applyLocalRefundAllocation } from "@/lib/payment-transactions";
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
export { MANUAL_PAYMENT_NOTE_MAX, MANUAL_REFUND_TASK_REASON_MAX };

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

function normaliseNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MANUAL_PAYMENT_NOTE_MAX);
}

export async function applyManualBookingPayment(
  input: ApplyManualBookingPaymentInput
): Promise<ApplyManualBookingPaymentResult> {
  const note = normaliseNote(input.note);

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

/**
 * What a completion claims about the amount, and it must be stated.
 *
 * #2797 owner decision D2 chose *"amend at completion, audited"* over a separate
 * `confirmedAmountCents` column, so the confirmed figure arrives HERE rather than
 * through some earlier pricing step — and a separate pre-completion amend was
 * deliberately not built, because a priced-but-still-OPEN task is a state no
 * invariant defines and another reader could mistake for a decision. That is the
 * same class of hazard as the magic zero this epic exists to remove.
 *
 * A NUMBER is the admin's confirmed non-negative integer cents. On a task raised
 * with no amount (`EDIT_FINANCIAL_REVIEW`) it IS the pricing. On a task that
 * already carries one it must match, EXCEPT on an `EDIT_FINANCIAL_REVIEW` task,
 * where a different figure is the audited amendment D2 permits — the row keeps
 * `raisedAmountCents` either way, so the row itself says whether the amount moved
 * and by how much. On a legacy kind a different figure is refused: those amounts
 * were computed by cancellation or capture policy and an operator closing the
 * task is not the person who gets to rewrite them, so the mismatch is treated as
 * a stale screen (409) exactly like `expectedAmountCents` on the settle path.
 *
 * NULL is an explicit claim that the task already carries its final amount, and
 * closes at it — today's behaviour, now stated rather than assumed. It 409s when
 * there is no amount to close at.
 *
 * It is REQUIRED rather than optional on purpose: making it optional would let
 * every existing call site keep the old behaviour silently, where requiring it
 * makes the compiler list them.
 */
export type ManualRefundTaskResolution =
  | {
      taskId: string;
      resolution: "completed";
      note: string | null;
      actingMemberId: string;
      confirmedAmountCents: number | null;
    }
  | {
      taskId: string;
      resolution: "dismissed";
      note: string | null;
      actingMemberId: string;
      confirmedAmountCents?: never;
    };

/**
 * B5 (#2262): close a hand-back task raised when a cash-settled booking was
 * cancelled — and, since #3030, price and close the financial-review task an
 * unpriceable booking edit raises (epic #2797).
 *
 * COMPLETED means the money genuinely went back to the member, so — and only
 * then — the local refund allocation is written (the ledger mirror stays
 * honest) and a REFUNDED booking event is recorded. DISMISSED exists for
 * "the member declined it" / "settled another way" and requires a note; it
 * moves no money and writes no allocation. For an `EDIT_FINANCIAL_REVIEW` task
 * DISMISSED carries its #2797 meaning: reviewed, no adjustment is due for that
 * occurrence — which is a real decision, and is why it is not the same thing as
 * an unknown amount.
 *
 * Both are TERMINAL for the occurrence. The OPEN -> terminal transition is a
 * status-fenced conditional update, so a double click or two admins closing at
 * once can never double-apply the allocation — and since #3030 the confirmed
 * amount is written inside that same claim, so an amount can no more be applied
 * twice than a status can.
 *
 * Deliberately holds NO advisory lock, and that is `docs/CONCURRENCY_AND_LOCKING.md`
 * speaking rather than an omission: serialising this against the Stripe webhook
 * would require holding `pg_advisory_xact_lock(1)` across a provider round trip,
 * which the bounded-exception rule in that document forbids. The structural
 * `updateMany` claim is the whole single-flight guarantee, which is why #3030
 * added nothing to it.
 */
export async function resolveManualRefundTask(
  input: ManualRefundTaskResolution
) {
  const { taskId, resolution, note, actingMemberId } = input;
  const trimmedNote = normaliseNote(note);
  if (resolution === "dismissed" && !trimmedNote) {
    throw new ManualBookingPaymentError(
      "Say why this refund is being dismissed — a note is required.",
      400
    );
  }
  const confirmedAmountCents =
    resolution === "completed" ? input.confirmedAmountCents : null;
  if (
    confirmedAmountCents !== null &&
    !isNonNegativeIntegerCents(confirmedAmountCents)
  ) {
    // `INV-MONEY-001`: integer cents, non-negative, through the ONE predicate
    // (`INV-SSOT`, #3030) rather than a fourth inline spelling of the rule. The
    // DB `ManualRefundTask_amount_nonnegative` CHECK says the same; this refuses
    // first with a message an operator can read.
    throw new ManualBookingPaymentError(
      "A confirmed refund amount must be non-negative whole cents.",
      400
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.manualRefundTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        bookingId: true,
        paymentId: true,
        amountCents: true,
        // #3030: `raisedAmountCents` is read so the audit entry can say what the
        // amount was when the task was raised, and `kind` because only an
        // `EDIT_FINANCIAL_REVIEW` task may have its amount amended at completion
        // (owner decision D2).
        raisedAmountCents: true,
        kind: true,
        status: true,
        booking: { select: { memberId: true } },
      },
    });
    if (!task) {
      throw new ManualBookingPaymentError("Refund task not found.", 404);
    }
    if (task.status !== ManualRefundTaskStatus.OPEN) {
      throw new ManualBookingPaymentError(
        "This refund task has already been closed.",
        409
      );
    }

    const isEditReview = task.kind === ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW;

    // #3030 (owner decision D2): work out the amount this completion closes at,
    // BEFORE the claim, so it is written inside the same status-fenced update and
    // cannot be applied separately from the status it belongs to.
    //
    // NULL means DISMISSED and nothing else. It is not a "could not work out an
    // amount" fallback: every branch below either produces a figure or throws,
    // which is why the code after the claim tests `settlement` rather than
    // re-checking an amount for null. A guard that can never fire on a money path
    // is worse than no guard - it would turn a future bug from a loud failure
    // into a silently skipped refund allocation on a row already COMPLETED.
    let settlement: { amountCents: number; amended: boolean } | null = null;
    if (resolution === "completed") {
      if (isEditReview && !trimmedNote) {
        // #3030: an edit-review completion is an admin pricing real money from
        // evidence, so the reasoning is part of the record. The legacy kinds keep
        // their optional note — their amount was computed by policy, not by the
        // person closing the task, so there is nothing for them to justify.
        throw new ManualBookingPaymentError(
          "Say what evidence this amount was priced from — a note is required.",
          400
        );
      }
      if (confirmedAmountCents === null) {
        // #2797 (owner decision D2): a task cannot be COMPLETED without a
        // confirmed amount. The DB `ManualRefundTask_completed_amount_present`
        // check enforces the same rule; this throws first with a message an
        // operator can read.
        if (task.amountCents === null) {
          throw new ManualBookingPaymentError(
            "This refund has no confirmed amount yet — price it before completing.",
            409
          );
        }
        settlement = { amountCents: task.amountCents, amended: false };
      } else if (
        task.amountCents !== null &&
        task.amountCents !== confirmedAmountCents
      ) {
        if (!isEditReview) {
          // A legacy hand-back amount came from cancellation or capture policy.
          // Closing the task is not licence to rewrite it, so a mismatch means
          // the screen was stale — the same answer `expectedAmountCents` gives on
          // the settle path.
          throw new ManualBookingPaymentError(
            "This refund's amount changed while you were closing it — refresh and try again.",
            409
          );
        }
        // #2797 (owner decision D2): amend at completion, audited. The row keeps
        // `raisedAmountCents`, so it says by itself that the amount moved.
        settlement = { amountCents: confirmedAmountCents, amended: true };
      } else {
        settlement = { amountCents: confirmedAmountCents, amended: false };
      }

      if (settlement.amountCents === 0) {
        // #3030 (`INV-PAY-051`): a completion at ZERO is refused, whichever way
        // the zero arrived. COMPLETED means the money genuinely went back, so a
        // $0 completion writes a row asserting a refund of nothing and a
        // `REFUNDED` booking event for $0.00 - and `booking-narrative.ts` picks a
        // cancelled booking's settlement event by TYPE without filtering on
        // amount, so that event is chosen and SHADOWS any genuine later one. The
        // member is then shown nothing about a refund that did happen.
        //
        // "Reviewed, nothing is due" already has an honest representation and it
        // is DISMISSED. Magic zero is the thing this epic exists to remove, and
        // the repository already avoids zero-amount REFUNDED events deliberately
        // elsewhere - `group-cancel.ts` writes CANCELLED rather than REFUNDED at
        // zero, and `booking-cancel.ts` carries an explicit "Deliberately NO
        // REFUNDED here" comment.
        //
        // No OPEN row is stranded by this. Neither legacy creator can make a
        // zero-amount task (both guard on a positive refund), and a row that
        // somehow carried one is still DISMISSABLE - which is the state it should
        // have been in.
        throw new ManualBookingPaymentError(
          "A completed refund must be more than zero — if nothing is due, dismiss the task with a note instead.",
          400
        );
      }
    }

    const now = new Date();
    const claimed = await tx.manualRefundTask.updateMany({
      where: { id: task.id, status: ManualRefundTaskStatus.OPEN },
      data: {
        status:
          resolution === "completed"
            ? ManualRefundTaskStatus.COMPLETED
            : ManualRefundTaskStatus.DISMISSED,
        completedByMemberId: actingMemberId,
        completedAt: now,
        note: trimmedNote,
        // #3030: only a completion writes an amount. A dismissal deliberately
        // leaves it exactly as it was — including null — because DISMISSED means
        // "reviewed, no adjustment is due for this occurrence", and writing a
        // zero there would be the magic value this epic exists to remove.
        ...(settlement ? { amountCents: settlement.amountCents } : {}),
      },
    });
    if (claimed.count === 0) {
      throw new ManualBookingPaymentError(
        "This refund task changed while you were closing it — refresh and try again.",
        409
      );
    }

    if (settlement && task.paymentId !== null) {
      // #2797 (owner decision D2): a credit-only task (`paymentId` null) has no
      // captured payment to allocate a refund against — the money is returned as
      // account credit or off-Stripe by hand — so the local refund allocation is
      // written ONLY when there is a payment to write it against. Only NOW does
      // the ledger record that money was returned; doing it at creation time
      // would have the mirror claim a refund before the club handed anything
      // back.
      try {
        await applyLocalRefundAllocation({
          paymentId: task.paymentId,
          amountCents: settlement.amountCents,
          store: tx,
        });
      } catch (error) {
        // #3030: the settlement cap is now OPERATOR-REACHABLE. Before this the
        // amount always came from cancellation or capture policy and could not
        // exceed what was captured; now an admin types it. The cap itself is not
        // weakened by a byte here - the allocation still refuses and the
        // transaction still rolls back - but a correct refusal must not be
        // reported as a server fault: an untyped Error falls past the route's
        // `instanceof ManualBookingPaymentError` check, so the operator was told
        // "Could not close the refund task" and monitoring recorded a 500 for
        // working code. This says what is wrong and what to do about it.
        if (
          error instanceof Error &&
          error.message === "Refund amount exceeds captured payments"
        ) {
          throw new ManualBookingPaymentError(
            "That is more than was ever captured on this payment — check the amount against the booking's payment history.",
            400
          );
        }
        throw error;
      }
    }

    await createAuditLog(
      {
        action:
          resolution === "completed"
            ? "booking-payment.manual-refund-task.complete"
            : "booking-payment.manual-refund-task.dismiss",
        memberId: actingMemberId,
        actorMemberId: actingMemberId,
        subjectMemberId: task.booking.memberId,
        targetId: task.bookingId,
        entityType: "ManualRefundTask",
        entityId: task.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary:
          resolution === "completed"
            ? "Manual booking refund paid back by hand"
            : "Manual booking refund task dismissed",
        details: trimmedNote,
        metadata: {
          taskId: task.id,
          bookingId: task.bookingId,
          paymentId: task.paymentId,
          // #3030: three amounts, not one, because "audited amendment" (owner
          // decision D2) is only auditable if the entry says what the figure was
          // before and after. `raisedAmountCents` is what the task was raised
          // with, `previousAmountCents` what it carried when this admin opened
          // it, and `amountCents` what it closed at.
          amountCents: settlement?.amountCents ?? null,
          previousAmountCents: task.amountCents,
          raisedAmountCents: task.raisedAmountCents,
          amountAmended: settlement?.amended ?? false,
          kind: task.kind,
          resolution,
        },
      },
      tx
    );

    return {
      taskId: task.id,
      bookingId: task.bookingId,
      paymentId: task.paymentId,
      amountCents: settlement?.amountCents ?? null,
      raisedAmountCents: task.raisedAmountCents,
      amountAmended: settlement?.amended ?? false,
      kind: task.kind,
      /**
       * #3030: the refund this completion actually MADE, or null.
       *
       * Non-null exactly when a local refund allocation was written above, which
       * is what the `REFUNDED` booking event is the record of. A credit-only task
       * (`paymentId` null) moves nothing here: no allocation, no ledger entry, no
       * account credit, and no change to `Payment.refundedAmountCents`. Recording
       * `REFUNDED` for one would put a claim in the booking's DURABLE event log
       * that the system can point to nothing to back - and that log is
       * member-facing, because `booking-narrative.ts` turns the first
       * `REFUNDED`/`CREDITED` event into the sentence a member reads about a
       * cancelled booking's settlement. What a member would be shown is the test
       * this fails: "your money was refunded" when nothing in this system
       * returned any.
       *
       * The admin's action is still fully recorded - in the AUDIT log, which is
       * where "an operator closed this task" belongs. When #3032/#3033 wire the
       * path that actually ISSUES the account credit, the booking event belongs
       * there, written where the money moves. `INV-PAY-051` says the same.
       */
      recordedRefund:
        settlement && task.paymentId !== null
          ? { amountCents: settlement.amountCents }
          : null,
      memberId: task.booking.memberId,
      status:
        resolution === "completed"
          ? ManualRefundTaskStatus.COMPLETED
          : ManualRefundTaskStatus.DISMISSED,
    };
  });

  if (result.recordedRefund) {
    await recordBookingEvent({
      bookingId: result.bookingId,
      type: BookingEventType.REFUNDED,
      actorMemberId: actingMemberId,
      amountCents: result.recordedRefund.amountCents,
      reason: "manual_refund_completed",
    });
  }

  return result;
}
