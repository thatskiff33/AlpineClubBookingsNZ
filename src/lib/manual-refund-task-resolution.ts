import "server-only";

import {
  BookingEventType,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
} from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import { executeBookingModificationRefund } from "@/lib/booking-modification-settlement";
import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";
import { chooseEditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import {
  MANUAL_PAYMENT_NOTE_MAX,
  normaliseManualPaymentNote,
} from "@/lib/manual-subscription-payment";
import { createBookingModificationCredit } from "@/lib/member-credit";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { applyLocalRefundAllocation } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";

/**
 * B5 (#2262) guard 4, and since #3030 the completion door of epic #2797: closing
 * a manual refund task.
 *
 * A `ManualRefundTask` is the durable record of money the system cannot move
 * itself — a cash-settled booking that was cancelled and has no card charge to
 * reverse, and, since #3030, a booking edit whose exact adjustment could not be
 * read from the booking's own stored sold-price evidence. Raising one is the
 * business of the writer that found the problem (`booking-cancel.ts`,
 * `deleted-booking-modification-payment.ts`, `edit-financial-review.ts`);
 * CLOSING one is this module, and it is the only place an operator's decision
 * turns into a ledger entry and a member-facing booking event.
 *
 * It sits beside `manual-booking-payment.ts` rather than inside it because the
 * two answer different questions — "the club has just taken cash for this
 * booking" versus "the club has just handed money back" — and share nothing but
 * the note-length rule and the error type, both of which have their own homes.
 * `INV-PAY-051` is the invariant these rules belong to.
 */
export { ManualBookingPaymentError };
export { MANUAL_PAYMENT_NOTE_MAX };

/**
 * What a completion claims about the amount, and it must be stated.
 *
 * #2797 owner decision D2 chose *"amend at completion, audited"* over a separate
 * `confirmedAmountCents` column, so the confirmed figure arrives HERE rather than
 * through some earlier pricing step, and a separate pre-completion AMEND was
 * deliberately not built. Not because a priced-but-still-OPEN task is undefined
 * — it is defined, in `INV-PAY-051`, and the raise can create one when the edit
 * could prove a figure — but because that state means "proposed, not yet
 * confirmed", and a second writer able to move the figure while the row stays
 * OPEN would turn it into something a reader could mistake for a decision. The
 * one path that changes an amount is this one, and it closes the task in the
 * same write.
 *
 * A NUMBER is the admin's confirmed POSITIVE integer cents — zero is refused, see
 * below. On a task raised with no amount (`EDIT_FINANCIAL_REVIEW`) it IS the
 * pricing. On a task that
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
 * ZERO IS REFUSED whichever way it arrives, and that is `INV-PAY-051`. COMPLETED
 * means the money genuinely went back, so a $0.00 completion records a refund
 * that did not happen — in the booking's durable, member-facing event log.
 * "Reviewed, nothing is due" is DISMISSED, which is a real decision and is what
 * this whole epic exists to make representable without a magic zero.
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
 * honest) and a REFUNDED booking event is recorded. Both of those are written
 * only where there IS a captured payment behind the task: a credit-only task
 * (`paymentId` NULL) moves nothing here, so claiming a refund in the booking's
 * member-facing event log would be a claim nothing backs — see `recordedRefund`
 * below. DISMISSED exists for
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
  const trimmedNote = normaliseManualPaymentNote(note);
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
        // #3032: the settlement route needs three more facts, all read inside
        // the same transaction as the claim. `reviewContext` carries the
        // `BookingModification` anchor a confirmed amount settles against
        // (D-3032-1); the task's own payment says whether the money went out on
        // a card (Stripe) or by hand (internet banking); and the BOOKING's
        // payment is what an account credit must be allocated against, which is
        // a different question from whether the TASK sits on one.
        reviewContext: true,
        payment: { select: { source: true } },
        booking: {
          select: {
            memberId: true,
            payment: {
              select: {
                id: true,
                status: true,
                amountCents: true,
                refundedAmountCents: true,
              },
            },
          },
        },
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

    // #3032: pick the settlement route BEFORE the claim, and let it refuse from
    // there rather than after. A refusal that fired after the status claim would
    // leave the task COMPLETED with nothing moved, which is precisely the
    // "pretends money moved" failure `INV-PAY-051` forbids; a refusal from here
    // leaves the row untouched and still OPEN. The rules, the three routes and
    // the two refusals live in `edit-financial-review-settlement.ts`.
    const settlementRoute = settlement
      ? await chooseEditReviewSettlementRoute(task, tx)
      : null;

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

    if (settlement && settlementRoute) {
      // #2797 (owner decision D2) and #3032: the money moves only NOW, after the
      // claim, so a lost claim moves nothing at all. `applyLocalRefundAllocation`
      // INCREMENTS `refundedAmountCents` and is not idempotent - its only
      // protection is a cap that throws - so it must never run ahead of a
      // terminal claim, and it must never run alongside the Stripe route, which
      // writes the same allocation itself.
      //
      // Doing any of this at RAISE time would have the ledger claim a refund
      // before the club handed anything back, which is the whole reason the task
      // exists.
      try {
        if (settlementRoute.kind === "local-allocation") {
          await applyLocalRefundAllocation({
            paymentId: settlementRoute.paymentId,
            amountCents: settlement.amountCents,
            store: tx,
          });
        } else if (settlementRoute.kind === "account-credit") {
          // #3032: the canonical account-credit writer, re-entered unchanged.
          // Its exactly-once key is the `BookingModification` id (D-3032-1), and
          // it writes the refund allocation itself when handed a payment id.
          await createBookingModificationCredit(
            task.booking.memberId,
            settlement.amountCents,
            task.bookingId,
            settlementRoute.bookingModificationId,
            undefined,
            tx,
            settlementRoute.allocateAgainstPaymentId ?? undefined,
          );
        }
        // `stripe-refund` writes NOTHING here on purpose: the provider call has
        // to happen outside this transaction, and `refundPaymentTransactions`
        // writes the ledger allocation as part of it. Writing one here as well
        // would consume the refundable headroom twice for one refund.
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
          // #3032: WHICH settlement path this amount went down, and the anchor it
          // settled against. Without these the entry says an amount was closed
          // but not whether that meant a card refund, a ledger mirror of a hand
          // -back, or freshly minted account credit - three materially different
          // claims about the club's money.
          settlementRoute: settlementRoute?.kind ?? null,
          settlementBookingModificationId:
            settlementRoute && settlementRoute.kind !== "local-allocation"
              ? settlementRoute.bookingModificationId
              : null,
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
       * Non-null exactly when a local refund allocation was written INSIDE the
       * transaction above, which is what the `REFUNDED` booking event is the
       * record of. Recording `REFUNDED` where nothing moved would put a claim in
       * the booking's DURABLE event log that the system can point to nothing to
       * back - and that log is member-facing, because `booking-narrative.ts`
       * turns the first `REFUNDED`/`CREDITED` event into the sentence a member
       * reads about a cancelled booking's settlement. What a member would be
       * shown is the test this fails: "your money was refunded" when nothing in
       * this system returned any.
       *
       * #3032 NARROWED IT from "the task had a payment id" to "this route wrote
       * the allocation here". The two other routes move money too, and both write
       * their own event after the commit where the money actually moves: the
       * Stripe route records `REFUNDED` only once the provider call has returned
       * a refund id, and the account-credit route records `CREDITED`. Leaving the
       * old test in place would have double-recorded the Stripe case - once here
       * for an allocation this transaction never wrote, and once after the
       * commit.
       */
      recordedRefund:
        settlement && settlementRoute?.kind === "local-allocation"
          ? { amountCents: settlement.amountCents }
          : null,
      /**
       * #3032: the two routes whose money moves OUTSIDE this transaction, carried
       * out so the post-commit block below can run them. Null on every other
       * outcome, including a dismissal.
       */
      settlementRoute,
      settlementAmountCents: settlement?.amountCents ?? null,
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

  /**
   * #3032: everything that must happen AFTER the commit.
   *
   * The transaction is closed by the time control reaches here, which is the
   * point: `AGENTS.md` and `docs/CONCURRENCY_AND_LOCKING.md` both forbid a
   * provider round trip inside a database transaction, and this path is also the
   * one the locking guide singles out as deliberately holding no advisory lock
   * for exactly that reason. The single-flight guarantee is the status claim
   * above, which has already committed: a second completion of this task is
   * refused by the status check, so nothing below can run twice for one task.
   *
   * A crash between the commit and these calls leaves the task COMPLETED with
   * the money not yet moved. That exposure is inherent to the no-lock design and
   * is the same one the booking-edit path carries; `executeBookingModificationRefund`
   * narrows it by enqueueing a durable recovery operation on any Stripe failure,
   * replaying the identical idempotency key rather than minting a new one.
   */
  let stripeRefundId: string | undefined;
  if (result.settlementRoute?.kind === "stripe-refund") {
    stripeRefundId = await executeBookingModificationRefund({
      bookingId: result.bookingId,
      result: {
        pendingRefundAmountCents: result.settlementAmountCents ?? 0,
        paymentId: result.settlementRoute.paymentId,
        bookingModificationId: result.settlementRoute.bookingModificationId,
      },
      // #1507: the reason is rebuilt byte-identically by a recovery replay from
      // the stored key prefix, so it is a fixed discriminator, never prose.
      metadataReason: "edit_financial_review",
      // Scoped to the modification, exactly as every other modification refund
      // is: two reviews on one booking that confirm the same amount must not
      // collapse onto one Stripe key and silently under-refund the member.
      idempotencyKeyPrefix: `mod_review_refund_${result.bookingId}`,
      failureMessage:
        "Stripe refund failed after an edit financial review was completed - enqueueing recovery",
      recoveryFailureMessage:
        "Failed to enqueue payment recovery for the Stripe refund of a completed edit financial review",
    });
    if (stripeRefundId) {
      // Only on a refund that actually issued. A failure enqueues recovery and
      // records NO event: a REFUNDED row is member-facing through
      // `booking-narrative.ts`, so writing one for money still sitting in the
      // club's account would tell the member their refund had happened.
      await recordBookingEvent({
        bookingId: result.bookingId,
        type: BookingEventType.REFUNDED,
        actorMemberId: actingMemberId,
        amountCents: result.settlementAmountCents ?? 0,
        reason: "edit_financial_review_completed",
      });
    }
  }

  if (result.settlementRoute?.kind === "account-credit") {
    // `INV-PAY-051` asks for the booking event to be written where the money
    // moves, and this is that place: the credit row is committed, so the claim
    // the member reads is one the ledger can be pointed at.
    await recordBookingEvent({
      bookingId: result.bookingId,
      type: BookingEventType.CREDITED,
      actorMemberId: actingMemberId,
      amountCents: result.settlementAmountCents ?? 0,
      reason: "edit_financial_review_credited",
    });
  }

  return { ...result, stripeRefundId: stripeRefundId ?? null };
}
