import "server-only";

import {
  BookingEventType,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
} from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import { hasIssuedPrimaryXeroInvoice } from "@/lib/booking-payment-state";
import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";
import {
  chooseEditReviewSettlementRoute,
  executeEditReviewSettlement,
  type EditReviewSettlementRoute,
} from "@/lib/edit-financial-review-settlement";
import {
  MANUAL_PAYMENT_NOTE_MAX,
  normaliseManualPaymentNote,
} from "@/lib/manual-subscription-payment";
import { createBookingModificationCredit } from "@/lib/member-credit";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { enqueueEditFinancialReviewRefundRecovery } from "@/lib/payment-recovery";
import {
  applyLocalRefundAllocation,
  RefundAllocationRacedError,
} from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
// #3195: the $0 refusal is said by the settle SCREEN as well as thrown here, and
// this module is `server-only` - so the sentence lives in a client-safe home and
// both read it (`INV-SSOT`).
import { zeroCompletionRefusal } from "@/lib/manual-refund-task-copy";
import {
  checkStoredNightPriceRepair,
  settlementDeltaCents,
  NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
  NIGHT_PRICE_REPAIR_NO_STRAND_MESSAGE,
  type RecordedNightPrice,
  type UnpricedNightsSummary,
} from "@/lib/stored-night-price-repair";
import {
  applyStoredNightPriceRepair,
  loadUnpricedNightsSummary,
  reviewTaskGuestId,
} from "@/lib/stored-night-price-repair-store";

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
      /**
       * #3170: WHICH WAY the money goes, and it is REQUIRED on every completion
       * for the same reason `confirmedAmountCents` is - optional would let every
       * existing call site keep the old behaviour silently, where required makes
       * the compiler list them.
       *
       * Before this issue the direction was implicit in the word "refund", and
       * that implicitness was the hazard: this child is the first to park an edit
       * that can move the price UP, so an officer reading the evidence can
       * correctly conclude the club is owed - and every settlement route was
       * refund-shaped, so acting on that conclusion sent the money the wrong way.
       *
       * NULL means REFUND_TO_MEMBER and is accepted only on the legacy kinds,
       * which cannot mean anything else. An `EDIT_FINANCIAL_REVIEW` completion
       * must state it: a task whose whole nature is "nobody could work this out"
       * is exactly the task where an unstated default is a guess.
       */
      direction: ManualRefundTaskDirection | null;
      /**
       * #3191: what the officer says each of this review's UNPRICED NIGHTS sold
       * for, or null for "I am not recording those now".
       *
       * REQUIRED rather than optional, for the reason `confirmedAmountCents` and
       * `direction` are: optional would let every existing call site keep the old
       * behaviour silently, where required makes the compiler list them.
       *
       * NULL IS A REAL AND ORDINARY ANSWER, and that is a deliberate departure
       * from making it mandatory. A settlement figure is not always a pure
       * restatement of what the nights were worth - a policy-reduced hand-back or
       * a change fee will not reconcile - and a settle screen that refused to
       * close such a task would hold the money question open over a repair that
       * is optional by nature. So the screen ASKS, prominently, and says what
       * leaving it blank costs; it does not make the officer's ability to settle
       * depend on their ability to produce a breakdown that adds up.
       *
       * A NON-NULL value is checked in full and written in full - there is no
       * partial answer (`INV-MOD-028`, and `stored-night-price-repair.ts` is the
       * home of that rule).
       */
      recordedNightPrices: RecordedNightPrice[] | null;
    }
  | {
      taskId: string;
      resolution: "dismissed";
      note: string | null;
      actingMemberId: string;
      confirmedAmountCents?: never;
      /**
       * #3191: a dismissal can record them too, and it has to be able to. A
       * parked edit whose strand kept the same nights owes nothing either way, so
       * "no adjustment" is its ordinary outcome - and if only a completion could
       * fill the blanks in, exactly the bookings with nothing to settle would
       * park forever. Nothing moves, so the figures must come to the strand's
       * stored total unchanged.
       */
      recordedNightPrices: RecordedNightPrice[] | null;
      /**
       * A dismissal moves no money, so there is no direction to record and none
       * may be sent. The database says the same thing
       * (`ManualRefundTask_direction_only_when_completed`).
       */
      direction?: never;
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
            // #3170: the CHARGE direction mints an additional PaymentIntent
            // through the same helper every ordinary price increase uses, and
            // that helper needs a Stripe customer. Read here, under the same
            // transaction as everything else, rather than re-queried after the
            // commit.
            member: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            },
            // #3032: the booking's own status and its primary Xero invoice id,
            // for `hasIssuedPrimaryXeroInvoice`. A completion that moves money on
            // a booking whose invoice was issued has to correct that invoice, or
            // the ledger and Xero disagree permanently.
            status: true,
            payment: {
              select: {
                id: true,
                status: true,
                amountCents: true,
                refundedAmountCents: true,
                xeroInvoiceId: true,
                // #3170: a charge routes on the BOOKING's payment rather than the
                // task's - the task's payment is the one money would come back
                // OUT of, and a charge has none.
                source: true,
                stripeCustomerId: true,
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
          store: tx,
        })
      : null;

    /**
     * #3191: the per-night repair, VALIDATED BEFORE THE CLAIM and written after
     * it - the same boundary the settlement route draws, for the same reason. A
     * refusal from here leaves the task OPEN with its money question intact; one
     * that fired after the claim would leave a closed task and no prices.
     *
     * The blanks are re-read from the database on this transaction rather than
     * taken from what the browser was shown, and the officer's dates are checked
     * against THOSE. A screen minutes old is exactly how a figure ends up written
     * against a night the booking no longer holds.
     */
    const requestedNightPrices = input.recordedNightPrices;
    let nightPriceRepair: {
      bookingGuestId: string;
      summary: UnpricedNightsSummary;
      entries: readonly RecordedNightPrice[];
    } | null = null;
    if (requestedNightPrices !== null) {
      const bookingGuestId = reviewTaskGuestId(task);
      if (bookingGuestId === null) {
        throw new ManualBookingPaymentError(
          NIGHT_PRICE_REPAIR_NO_STRAND_MESSAGE,
          409,
        );
      }
      const summary = await loadUnpricedNightsSummary({
        bookingGuestId,
        store: tx,
      });
      if (summary === null) {
        throw new ManualBookingPaymentError(
          NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
          409,
        );
      }
      const check = checkStoredNightPriceRepair({
        summary,
        entries: requestedNightPrices,
        // A dismissal moves no money, so it moves no total: the officer's
        // figures then have to come to the strand's stored total exactly.
        deltaCents: settlementDeltaCents(
          settlement
            ? {
                direction: settlementDirection,
                amountCents: settlement.amountCents,
              }
            : null,
        ),
      });
      if (!check.ok) {
        throw new ManualBookingPaymentError(check.message, 400);
      }
      nightPriceRepair = { bookingGuestId, summary, entries: check.entries };
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
        // `stripe-refund` writes no LEDGER allocation here on purpose: the
        // provider call has to happen outside this transaction, and
        // `refundPaymentTransactions` writes the allocation as part of it.
        // Writing one here as well would consume the refundable headroom twice
        // for one refund.
        //
        // What it DOES write here is the refund DEBT - booking-cancel's #1349
        // persist-the-plan-first pattern, on the same infrastructure. This
        // completion holds no advisory lock (the locking guide forbids holding
        // `lock(1)` across a provider round trip), so its single-flight guarantee
        // is the claim above, which has committed by the time Stripe is called.
        // Without a durable row a crash in that window would leave a COMPLETED
        // task, an untouched `refundedAmountCents` and NO trace that money was
        // owed - a worse state than the booking-edit path's, precisely because
        // this route writes no allocation. With it, the recovery cron replays the
        // frozen slices under the same task-scoped Stripe key prefix the inline
        // call uses, so Stripe answers a repeat with the original refund and the
        // ledger dedupes on refund id.
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
        // #3032: this completion holds no advisory lock, so a concurrent writer
        // on the same payment can move the ledger under it. The compare-and-set
        // inside `applyLocalRefundAllocation` turns that into a loud failure
        // instead of a lost update; the transaction rolls back, so the task is
        // still OPEN and its money is still owed when the operator retries.
        if (error instanceof RefundAllocationRacedError) {
          throw new ManualBookingPaymentError(
            "This booking's payment changed while you were closing the task — refresh and try again.",
            409
          );
        }
        throw error;
      }
    }

    /**
     * #3191: the blanks become numbers, after the claim and inside it.
     *
     * AUDITED AS A MONEY-AFFECTING ACT IN ITS OWN RIGHT, which #3191 requires,
     * and as a SECOND entry rather than as metadata on the completion below. The
     * two are different acts: one closes a task and moves money, the other
     * rewrites what a stay is recorded as having sold for - and the second can
     * happen on a DISMISSAL, where the completion entry says in as many words
     * that nothing moved. Folding it in would put a price change inside a row
     * whose summary denies one.
     */
    if (nightPriceRepair) {
      const { newGuestTotalCents } = await applyStoredNightPriceRepair({
        bookingGuestId: nightPriceRepair.bookingGuestId,
        summary: nightPriceRepair.summary,
        entries: nightPriceRepair.entries,
        store: tx,
      });
      await createAuditLog(
        {
          action: "booking-payment.stored-night-price.record",
          memberId: actingMemberId,
          actorMemberId: actingMemberId,
          subjectMemberId: task.booking.memberId,
          targetId: task.bookingId,
          entityType: "BookingGuest",
          entityId: nightPriceRepair.bookingGuestId,
          category: "payment",
          severity: "important",
          outcome: "success",
          summary:
            "Recorded what a booking's unpriced nights sold for while settling a financial review",
          details: trimmedNote,
          metadata: {
            taskId: task.id,
            bookingId: task.bookingId,
            resolution,
            // The figures themselves, night by night, because "an admin priced
            // these" is not auditable unless the entry says what they priced
            // them at - the same reason the completion entry carries three
            // amounts rather than one.
            nightPrices: nightPriceRepair.entries.map((entry) => ({
              date: entry.date,
              priceCents: entry.priceCents,
            })),
            previousGuestTotalCents:
              nightPriceRepair.summary.storedGuestTotalCents,
            newGuestTotalCents,
            knownNightTotalCents: nightPriceRepair.summary.knownNightTotalCents,
          },
        },
        tx,
      );
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
          // #3170: WHICH WAY, recorded beside the route. The route says how the
          // money travelled and the direction says who ended up with it, and
          // "additional-charge" is the only route where those two answers differ
          // from every entry written before this issue.
          settlementDirection: settlement ? settlementDirection : null,
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
       * #3191: how many of this booking's blank nights this decision filled in,
       * so the operator's receipt can say it happened. Zero when none were sent,
       * which is the ordinary case and is not a failure.
       */
      recordedNightPriceCount: nightPriceRepair?.entries.length ?? 0,
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
      /** #3170: which way this completion sent the money, or null on a dismissal. */
      settlementDirection: settlement ? settlementDirection : null,
      memberId: task.booking.memberId,
      /**
       * #3032: the two facts the post-commit Xero dispatch needs, read under the
       * same transaction as everything else rather than re-queried afterwards.
       */
      hasIssuedXeroInvoice,
      bookingPaymentStatus: task.booking.payment?.status ?? null,
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
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      bookingPaymentStatus: result.bookingPaymentStatus,
    });

  return { ...result, stripeRefundId, additionalPaymentIntentId };
}
