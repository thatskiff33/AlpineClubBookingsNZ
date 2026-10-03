import "server-only";

import {
  BookingEventType,
  BookingStatus,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
} from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { postHandBackLedgerLine } from "@/lib/booking-ledger-hand-back";
import { recordBookingEvent } from "@/lib/booking-events";
import { recordManualRefundTaskClosureAudit } from "@/lib/manual-refund-task-audit";
import { hasIssuedPrimaryXeroInvoice } from "@/lib/booking-payment-state";
import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";
import {
  chooseEditReviewSettlementRoute,
  executeEditReviewSettlement,
  type EditReviewSettlementRoute,
} from "@/lib/edit-financial-review-settlement";
import {
  writeEditReviewAccountCredit,
  type EditReviewAccountCreditOutcome,
} from "@/lib/edit-financial-review-account-credit";
import { refundMethodForEditReviewRoute, refundRequestCreditNoteAsk } from "@/lib/edit-financial-review-xero-leg";
import { enqueueXeroRefundRequestCreditNoteOperation } from "@/lib/xero-refund-request-credit-note-outbox";
import { MANUAL_PAYMENT_NOTE_MAX, normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { requireMemberCreditRecipient } from "@/lib/member-credit";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { enqueueEditFinancialReviewRefundRecovery } from "@/lib/payment-recovery";
import { applyLocalRefundAllocation } from "@/lib/payment-transactions";
// A settlement write's refusal, as the operator reads it (#3827 split it out).
import { settlementWriteRefusal } from "@/lib/manual-refund-task-settlement-refusal";
import { prisma } from "@/lib/prisma";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
// #3195: the $0 refusal is said by the settle SCREEN as well as thrown here, and
// this module is `server-only` - so the sentence lives in a client-safe home and
// both read it (`INV-SSOT`).
import { zeroCompletionRefusal } from "@/lib/manual-refund-task-copy";
import {
  EDIT_REFUND_HAND_BACK_DISMISS_AFTER_CANCEL_MESSAGE,
  isEditRefundHandBackTask,
  isNonCancellationHandBackTask,
  refundRequestIdOfHandBack,
  isPartPaymentReviewTask,
  nonCancellationHandBackCompletedSnapshot,
  manualRefundTaskSettlementRefusal,
} from "@/lib/manual-refund-task-settlement-rules";
// #3498: what a settle MAY repair is the plan module's; the writes are the store's.
import { planStoredNightPriceRepair } from "@/lib/stored-night-price-repair-plan";
import { recordReviewClosurePricing } from "@/lib/stored-night-price-repair-store";

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

export type { ManualRefundTaskResolution } from "@/lib/manual-refund-task-resolution-input";
import type { ManualRefundTaskResolution } from "@/lib/manual-refund-task-resolution-input";
import { MANUAL_REFUND_TASK_RESOLUTION_SELECT } from "@/lib/manual-refund-task-resolution-select";
import type { ClubFormat } from "@/lib/club-format";
import { persistLateCaptureApprovalRefundDebt } from "@/lib/late-capture-refund-approval";
import { settleKeptLateCaptureRecordOnApproval } from "@/lib/xero-kept-late-capture-invoice";
import {
  finishKeptLateCaptureXeroRecord,
  planKeptLateCaptureXeroRecord,
  type KeptLateCaptureXeroPlan,
} from "@/lib/late-capture-kept-xero";

/** `INV-PAY-101` (#3529): the invoice a cancellation hand-back refunds against. */
function cancellationHandBackInvoiceIdOf(task: {
  kind: ManualRefundTaskKind | null;
  booking: { payment?: { xeroInvoiceId?: string | null } | null };
}): string | null {
  return task.kind === ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK
    ? (task.booking.payment?.xeroInvoiceId ?? null)
    : null;
}

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
 * DISMISSED carries its #2797 meaning: reviewed, and THIS SYSTEM MOVED NO MONEY
 * for that occurrence — which is a real decision, and is why it is not the same
 * thing as an unknown amount. The required note is what says which decision it
 * was: nothing was owed, or the club settled it outside this task. Both are
 * honest, and neither pretends money moved, which is the property the epic's
 * requirement 7 actually asks for. Reading DISMISSED as the narrower "no
 * adjustment is due" makes the row assert the opposite of what happened whenever
 * an operator is told to settle by hand and close — which the anchor-taken
 * refusal in `edit-financial-review-settlement.ts` does tell them.
 *
 * Both are TERMINAL for the occurrence. The OPEN -> terminal transition is a
 * status-fenced conditional update, so a double click or two admins closing at
 * once can never double-apply the allocation — and since #3030 the confirmed
 * amount is written inside that same claim, so an amount can no more be applied
 * twice than a status can.
 *
 * Holds NO advisory lock across a provider round trip (the Stripe refund and
 * Xero leg run after the commit); the `updateMany` claim is the single-flight
 * guarantee. Since #3582 an `EDIT_FINANCIAL_REVIEW` closure takes `lock(1)`
 * first, inside the transaction only — `docs/CONCURRENCY_AND_LOCKING.md`.
 */
export async function resolveManualRefundTask(
  input: ManualRefundTaskResolution,
  format: ClubFormat
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
  const requestedDirection =
    resolution === "completed" ? (input.direction ?? null) : null;
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

  // #3219 `INV-LOCK-004`: read outside the transaction; dates the promo window,
  // and (#3635) the day a kept late capture's Xero receipt is dated.
  const clubZone = await readClubTimeZoneOutsideRequest();
  const todayAtClub = clubToday(clubZone);
  const result = await prisma.$transaction(async (tx) => {
    // #3740 (concurrency F1): only the immutable `kind` is read unlocked. An
    // edit review takes lock(1) as this transaction's FIRST lock (INV-LOCK-002)
    // and only then reads what picks its money route, so nothing that route
    // depends on is stale. Why: docs/CONCURRENCY_AND_LOCKING.md.
    //
    // #3827 (`INV-PAY-115`): an EDIT REFUND HAND-BACK takes the same key, and
    // so (D-3813-7) does an approved refund request's. Its
    // completion moves `refundedAmountCents` and closes the task in one commit,
    // and every edit, acceptance and paid cancel reads those two separately to
    // size a refund net of what is already promised back
    // (`refundableCashNetOfOpenHandBacks`). Under `lock(1)` the completion
    // cannot commit between the two reads, which would count the same money
    // as neither refunded nor promised. Its occurrence key, like its kind, is
    // written once at creation and never again.
    const head = await tx.manualRefundTask.findUnique({
      where: { id: taskId },
      select: { kind: true, occurrenceKey: true },
    });
    if (
      head?.kind === ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW ||
      (head !== null && isNonCancellationHandBackTask(head))
    ) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    }
    const task = await tx.manualRefundTask.findUnique({
      where: { id: taskId },
      select: MANUAL_REFUND_TASK_RESOLUTION_SELECT,
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
    // #3213 (`INV-PAY-051`): the DISMISS-ONLY door. Refused before the claim and
    // before any write, so no input reaches a money path - and asked of
    // `manual-refund-task-settlement-rules.ts`, the one client-safe home the
    // settle screen reads to decide whether that control exists at all.
    const refusal = manualRefundTaskSettlementRefusal(
      task.kind,
      resolution,
      isPartPaymentReviewTask(task),
    );
    if (refusal) throw new ManualBookingPaymentError(refusal, 400);
    // #3827 (`INV-PAY-115`): a cancelled booking's edit refund hand-back is
    // settled by paying it. The cancel counted it as going back; dismissing it
    // now would leave the cancellation's kept figure wrong. Read under lock(1)
    // (taken above for this kind), which a paid cancel also holds.
    if (
      resolution === "dismissed" &&
      isEditRefundHandBackTask(task) &&
      task.booking.status === BookingStatus.CANCELLED
    ) {
      throw new ManualBookingPaymentError(EDIT_REFUND_HAND_BACK_DISMISS_AFTER_CANCEL_MESSAGE, 409);
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
      if (isEditReview && requestedDirection === null) {
        // #3170: an edit-review completion must SAY which way the money goes.
        // Every other kind is a hand-back by its own definition, so silence there
        // means REFUND_TO_MEMBER and always has; here silence would be a guess on
        // the one task type whose whole nature is that nobody could work the
        // figure out. Refused before anything is claimed, so the task stays OPEN.
        throw new ManualBookingPaymentError(
          "Say whether this amount is owed to the member or owed to the club — a review cannot be closed without it.",
          400,
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
        //
        // #3195 question 1 put the rule itself back to the owner, who kept it -
        // and required the refusal to name the way out. `zeroCompletionRefusal`
        // is where that sentence lives and why there are two of them.
        throw new ManualBookingPaymentError(
          zeroCompletionRefusal(isEditReview),
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
    // #3170: NULL means REFUND_TO_MEMBER, which is what every kind older than
    // EDIT_FINANCIAL_REVIEW can mean and nothing else. An edit review has already
    // been refused above if it did not say.
    const settlementDirection =
      requestedDirection ?? ManualRefundTaskDirection.REFUND_TO_MEMBER;
    const hasIssuedXeroInvoice = hasIssuedPrimaryXeroInvoice(task.booking);
    const settlementRoute: EditReviewSettlementRoute | null = settlement
      ? await chooseEditReviewSettlementRoute({
          task,
          amountCents: settlement.amountCents,
          hasIssuedXeroInvoice,
          direction: settlementDirection,
          // #3536: the officer's cash-or-bank answer, carried into the route
          // chosen here under the lock.
          handedBackInCash:
            input.resolution === "completed" && input.handedBackInCash === true,
          store: tx,
        })
      : null;

    // #3191/#3219 D2: the night prices, checked BEFORE the claim so a refusal
    // leaves the task OPEN - one plan per repairable strand since #3498.
    const nightPriceRepairs = await planStoredNightPriceRepair({
      format,
      task,
      requested: input.recordedNightPrices,
      settled: settlement
        ? { direction: settlementDirection, amountCents: settlement.amountCents }
        : null,
      store: tx,
    });

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
        // "reviewed, and this system moved no money for this occurrence", and
        // writing a zero there would be the magic value this epic exists to
        // remove.
        ...(settlement
          ? {
              amountCents: settlement.amountCents,
              // #3170: written inside the SAME status-fenced claim as the amount,
              // for the same reason - a direction applied separately from the
              // status it belongs to is a direction that can be applied twice, or
              // to a row somebody else already closed. A dismissal writes none:
              // nothing moved, so there is no direction, and
              // `ManualRefundTask_direction_only_when_completed` says so in the
              // database too.
              settlementDirection,
            }
          : {}),
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
        }
        // `account-credit` is written by the closure's re-price below, once the
        // re-price has run: what of a share is applied credit coming back
        // depends on what that re-price removed (#3791).
        // `stripe-refund` writes no LEDGER allocation here on purpose: the
        // provider call has to happen outside this transaction, and
        // `refundPaymentTransactions` writes the allocation as part of it.
        // Writing one here as well would consume the refundable headroom twice
        // for one refund.
        //
        // What it DOES write here is the refund DEBT - booking-cancel's #1349
        // persist-the-plan-first pattern, on the same infrastructure. This
        // completion's `lock(1)` (#3582) is released at commit - the locking
        // guide forbids holding it across a provider round trip - so across the
        // Stripe call its single-flight guarantee is the claim above.
        // Without a durable row a crash in that window would leave a COMPLETED
        // task, an untouched `refundedAmountCents` and NO trace that money was
        // owed - a worse state than the booking-edit path's, precisely because
        // this route writes no allocation. With it, the recovery cron replays the
        // frozen slices under the same task-scoped Stripe key prefix the inline
        // call uses, so Stripe answers a repeat with the original refund and the
        // ledger dedupes on refund id.
        // #3639: the same persist-the-debt-first rule for an approved late
        // capture, under the webhook's own Stripe prefix.
        else if (settlementRoute.kind === "late-capture-refund") {
          await persistLateCaptureApprovalRefundDebt({
            bookingId: task.bookingId,
            route: settlementRoute,
            amountCents: settlement.amountCents,
            store: tx,
          });
        }
        else if (settlementRoute.kind === "stripe-refund") {
          await enqueueEditFinancialReviewRefundRecovery({
            bookingId: task.bookingId,
            paymentId: settlementRoute.paymentId,
            taskId: task.id,
            amountCents: settlement.amountCents,
            allocationPlan: settlementRoute.allocation,
            store: tx,
          });
        }
      } catch (error) {
        throw settlementWriteRefusal(error);
      }
      // #3599: the money the club handed back by hand, on the booking ledger.
      if (settlementRoute.kind === "local-allocation") {
        await postHandBackLedgerLine({
          bookingId: task.bookingId,
          lodgeId: task.booking.lodgeId,
          manualRefundTaskId: task.id,
          amountCents: settlement.amountCents,
          refundMethod: refundMethodForEditReviewRoute(settlementRoute),
          paymentSource: task.payment?.source ?? null,
          officerMemberId: actingMemberId,
          store: tx,
        });
        // #3827 (D-3813-8, review F4): a refund request's own Xero note, queued
        // in this transaction so a paid-back request never commits without it.
        const requestNote = refundRequestCreditNoteAsk({
          route: settlementRoute,
          cancellationHandBackInvoiceId: cancellationHandBackInvoiceIdOf(task),
          amountCents: settlement.amountCents,
          refundRequestId: refundRequestIdOfHandBack(task),
        });
        if (requestNote) {
          await enqueueXeroRefundRequestCreditNoteOperation({ ...requestNote, createdByMemberId: actingMemberId, store: tx });
        }
      }
    }

    // #3635 (`INV-PAY-110`): DISMISSED keeps the money, recorded in Xero from
    // inside this claim, so a replayed dismissal queues nothing.
    const keptLateCaptureXeroPlan: KeptLateCaptureXeroPlan =
      resolution === "dismissed" && task.lateCaptureApprovalIntentId
        ? await planKeptLateCaptureXeroRecord({
            manualRefundTaskId: task.id,
            bookingId: task.bookingId,
            paymentIntentId: task.lateCaptureApprovalIntentId,
            actingMemberId,
            clubZone,
            store: tx,
          })
        : { kind: "none" };
    // #3635: approving a reopened keep settles what that keep queued, here.
    if (resolution === "completed" && task.lateCaptureApprovalIntentId) {
      await settleKeptLateCaptureRecordOnApproval({
        manualRefundTaskId: task.id,
        paymentIntentId: task.lateCaptureApprovalIntentId,
        store: tx,
      });
    }

    // #3791: the account-credit route's write, run by the re-price below once
    // it has re-priced (an edit review is the only kind that reaches this route).
    let accountCredit: EditReviewAccountCreditOutcome | null = null;
    const creditRoute = settlement && settlementRoute?.kind === "account-credit" ? settlementRoute : null;
    // #3191/#3219/#3257: blanks become numbers inside the claim; the booking
    // re-prices on EVERY parked review closing. Why, and why the KIND is the
    // condition, is `recordReviewClosurePricing`'s docblock.
    if (task.kind === ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW) {
      await recordReviewClosurePricing({
        settleAgainstRebase: creditRoute && settlement
          ? async (rebase) => {
              try {
                accountCredit = await writeEditReviewAccountCredit({
                  route: creditRoute,
                  taskId: task.id,
                  memberId: requireMemberCreditRecipient(bookingOwner(task.booking).memberId),
                  bookingId: task.bookingId,
                  amountCents: settlement.amountCents,
                  rebase,
                  clubZone,
                  format,
                  store: tx,
                });
              } catch (error) {
                throw settlementWriteRefusal(error);
              }
              // What the member was actually credited: the stand-in line and
              // the invoice-divergence check read this, not the typed share.
              return {
                creditedCents: accountCredit.givenBackCents + accountCredit.mintedCents,
                invoiceReductionCents: accountCredit.invoiceReductionCents,
                agreedGiveBackCents: accountCredit.agreedGiveBackCents,
              };
            }
          : null,
        format,
        plans: nightPriceRepairs,
        task,
        actingMemberId,
        resolution,
        note: trimmedNote,
        todayAtClub,
        hasIssuedXeroInvoice,
        settlementRoute,
        settlementAmountCents: settlement?.amountCents ?? null,
        settlementDirection: settlement ? settlementDirection : null,
        store: tx,
      });
    }

    await recordManualRefundTaskClosureAudit({
      task,
      resolution,
      actingMemberId,
      note: trimmedNote,
      settlement,
      settlementRoute,
      settlementDirection,
      store: tx,
    });

    return {
      taskId: task.id,
      bookingId: task.bookingId,
      paymentId: task.paymentId,
      amountCents: settlement?.amountCents ?? null,
      raisedAmountCents: task.raisedAmountCents,
      amountAmended: settlement?.amended ?? false,
      kind: task.kind,
      /** #3643: a part-payment review, for the dismissal's wording. */
      partPaymentReview: isPartPaymentReviewTask(task),
      /**
       * #3191: how many of this booking's blank nights this decision filled in,
       * so the operator's receipt can say it happened. Zero when none were sent,
       * which is the ordinary case and is not a failure.
       */
      recordedNightPriceCount: nightPriceRepairs.reduce((n, p) => n + p.entries.length, 0),
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
       * #3032 NARROWED IT from "the task had a payment id" to "this completion
       * took the `local-allocation` route". The two other routes move money too,
       * and both write their own event after the commit where the money actually
       * moves: the Stripe route records `REFUNDED` only once the provider call
       * has returned a refund id, and the account-credit route records
       * `CREDITED`. Leaving the old test in place would have double-recorded the
       * Stripe case - once here for an allocation this transaction never wrote,
       * and once after the commit.
       *
       * THE TEST IS THE ROUTE, NOT "an allocation was written in this
       * transaction", and the difference is real: the account-credit route DOES
       * write a local allocation inside this transaction when the booking has a
       * captured payment behind it (`createBookingModificationCredit` consumes
       * the refundable headroom, #1031), and it still belongs on `CREDITED`
       * rather than `REFUNDED` - the member got credit, not their money back.
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
      /** #3791: what the account-credit route gave back and minted, else null. */
      accountCredit: accountCredit as EditReviewAccountCreditOutcome | null,
      /** #3170: which way this completion sent the money, or null on a dismissal. */
      settlementDirection: settlement ? settlementDirection : null,
      memberId: bookingOwner(task.booking).memberId,
      /**
       * #3032: the two facts the post-commit Xero dispatch needs, read under the
       * same transaction as everything else rather than re-queried afterwards.
       */
      hasIssuedXeroInvoice,
      bookingPaymentStatus: task.booking.payment?.status ?? null,
      bookingXeroInvoiceId: task.booking.payment?.xeroInvoiceId ?? null,
      // `INV-PAY-101` (#3529): the invoice a cancellation hand-back refunds
      // against - `hasIssuedXeroInvoice` is false for every CANCELLED booking.
      cancellationHandBackInvoiceId: cancellationHandBackInvoiceIdOf(task),
      /**
       * #3827 (`INV-PAY-115`): the Xero leg owes nothing for an edit refund
       * hand-back - its edit already queued the credit note that corrects the
       * invoice. A refund request's (D-3813-8) queues that request's own note
       * instead (`refundRequestId` below), never the cancellation's.
       */
      nonCancellationHandBack: isNonCancellationHandBackTask(task),
      /**
       * #3827 (D-3813-8): a refund request's hand-back - its completion queues
       * that request's own Xero refund credit note. Null on a dismissal (no
       * route, so the leg queues nothing) as on every other task.
       */
      refundRequestId: refundRequestIdOfHandBack(task),
      /** The REFUNDED event's marker for those two (`INV-PAY-115`), else null. */
      nonCancellationHandBackSnapshot: isNonCancellationHandBackTask(task)
        ? nonCancellationHandBackCompletedSnapshot({ id: task.id, kind: task.kind, occurrenceKey: task.occurrenceKey })
        : null,
      status:
        resolution === "completed"
          ? ManualRefundTaskStatus.COMPLETED
          : ManualRefundTaskStatus.DISMISSED,
      keptLateCaptureXeroPlan,
    };
  });

  if (result.recordedRefund) {
    await recordBookingEvent({
      bookingId: result.bookingId,
      type: BookingEventType.REFUNDED,
      actorMemberId: actingMemberId,
      amountCents: result.recordedRefund.amountCents,
      reason: "manual_refund_completed",
      // #3827 (`INV-PAY-115`): an edit's refund on a live booking, or an
      // appeal's decided after the cancel - marked so the narrative never reads
      // it as the cancellation's settlement.
      ...(result.nonCancellationHandBackSnapshot
        ? { snapshot: result.nonCancellationHandBackSnapshot }
        : {}),
    });
  }

  /**
   * #3032: everything that must happen AFTER the commit - the provider call, the
   * member-facing events for the routes whose money moves out there, and the Xero
   * leg. It lives in `edit-financial-review-settlement.ts` beside the decision
   * that chose the route, because "where does this amount go and how does it get
   * there" is one question; this module is the DOOR - validate, claim, audit -
   * and it ends at the commit.
   */
  const { stripeRefundId, additionalPaymentIntentId } =
    await executeEditReviewSettlement({
      bookingId: result.bookingId,
      taskId: result.taskId,
      actingMemberId,
      route: result.settlementRoute,
      amountCents: result.settlementAmountCents,
      accountCredit: result.accountCredit,
      bookingXeroInvoiceId: result.bookingXeroInvoiceId,
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      bookingPaymentStatus: result.bookingPaymentStatus,
      cancellationHandBackInvoiceId: result.cancellationHandBackInvoiceId,
      nonCancellationHandBack: result.nonCancellationHandBack,
      refundRequestId: result.refundRequestId,
      format,
    });

  // #3635: the kept capture's Xero record, after the commit; never returned.
  const { keptLateCaptureXeroPlan, ...closed } = result;
  await finishKeptLateCaptureXeroRecord(keptLateCaptureXeroPlan);

  return { ...closed, stripeRefundId, additionalPaymentIntentId };
}
