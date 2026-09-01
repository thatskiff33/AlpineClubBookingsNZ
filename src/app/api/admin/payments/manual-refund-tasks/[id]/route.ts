import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
// `INV-SSOT` (#3030): the one non-negative-integer-cents rule, not a fourth
// inline `.number().int().nonnegative()`.
import { nonNegativeCentsSchema } from "@/lib/edit-financial-review-context";
import { recordedNightPricesSchema } from "@/lib/stored-night-price-repair";
import {
  completionMessage,
  nightPricesRecordedMessage,
} from "@/lib/manual-refund-task-copy";
import {
  ManualBookingPaymentError,
  MANUAL_PAYMENT_NOTE_MAX,
  resolveManualRefundTask,
} from "@/lib/manual-refund-task-resolution";

const noteField = z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional().nullable();
// Explicit confirmation so closing a money task is never a single-click
// accident, matching the mark-paid route.
const confirmedField = z.literal(true);

/**
 * #3030: a discriminated union rather than one flat object, so `confirmedAmountCents`
 * is accepted only where it means something. A dismissal moves no money and
 * decides no amount, so a client sending one there is confused and is told so
 * (400) rather than having it quietly ignored.
 *
 * The field is OPTIONAL over HTTP and defaults to null even though the library
 * function requires it. Null is a real, honest value there — "close at the amount
 * the task already carries" — and it is exactly what the current queue screen
 * means when it posts no amount. The pricing input that will send a real figure
 * is #3033's.
 *
 * ZERO IS REFUSED (`INV-PAY-051`), BUT NOT HERE ANY MORE (#3195 question 1).
 * "Reviewed, nothing is due" is DISMISSED, not a completion at $0.00 — a $0
 * completion records a refund the club did not make. This schema used to refuse
 * it a step earlier, on the reasoning that a validation message beat a thrown
 * one and that two layers agreeing could not drift.
 *
 * The owner's 31 Aug 2026 decision kept the rule and rejected the BARE refusal
 * that came with it, and that is what moved the check. A zod failure here answers
 * "Invalid refund task request." with a field dump — which says nothing about
 * dismissing, and is exactly the outcome the decision names as the worst version
 * of this behaviour. Worse, the sentence has to name the control the officer can
 * actually see, and those are two different controls on the two task kinds — a
 * fact this route does not read. So the refusal belongs where the kind is known,
 * in `zeroCompletionRefusal`, and this schema stops at non-negative whole cents.
 * The drift the old arrangement guarded against is gone rather than managed:
 * there is one layer refusing a zero now, not two.
 */
const bodySchema = z.discriminatedUnion("resolution", [
  z
    .object({
      resolution: z.literal("completed"),
      note: noteField,
      confirmed: confirmedField,
      confirmedAmountCents: nonNegativeCentsSchema.optional().nullable(),
      /**
       * #3170: WHICH WAY the confirmed amount goes. A positive magnitude plus an
       * explicit direction, never a signed amount - the sign of a money value is
       * exactly the kind of overloading this epic exists to remove, and the
       * `ManualRefundTask_amount_nonnegative` CHECK forbids it anyway.
       *
       * Optional over HTTP and defaulted to null, which the library reads as
       * REFUND_TO_MEMBER: that is the only thing a legacy hand-back can mean, and
       * an older client posting nothing keeps working. An `EDIT_FINANCIAL_REVIEW`
       * completion that omits it is refused there, not here, because that refusal
       * depends on the task's kind - which this route does not read.
       */
      direction: z
        .enum(["REFUND_TO_MEMBER", "CHARGE_TO_MEMBER"])
        .optional()
        .nullable(),
      /**
       * #3191: what the officer says each of this review's unpriced nights sold
       * for. Optional over HTTP and defaulted to null, which means "not
       * recording those now" and is the body every client sent before this
       * issue.
       */
      recordedNightPrices: recordedNightPricesSchema.optional().nullable(),
    })
    .strict(),
  z
    .object({
      resolution: z.literal("dismissed"),
      note: noteField,
      confirmed: confirmedField,
      /**
       * #3191: ON A DISMISSAL TOO, and that is not symmetry for its own sake. A
       * parked edit whose guest kept the same nights owes nothing either way, so
       * "no adjustment" is its ordinary ending - and if only a completion could
       * fill the blanks in, exactly those bookings would park forever, which is
       * the defect this issue exists to remove.
       */
      recordedNightPrices: recordedNightPricesSchema.optional().nullable(),
    })
    .strict(),
]);

/**
 * POST /api/admin/payments/manual-refund-tasks/[id]
 *
 * B5 (#2262). Close a hand-back task raised when a cash-settled booking was
 * cancelled: "completed" means the money genuinely went back to the member (so
 * the local refund allocation and a REFUNDED booking event are written, where
 * there is a captured payment behind the task), "dismissed" means it was
 * declined or settled another way and requires a note. Gated finance:edit;
 * audited either way.
 *
 * #3030 (epic #2797, owner decision D2): a completion may also carry
 * `confirmedAmountCents`, which is how an `EDIT_FINANCIAL_REVIEW` task raised
 * with an unknown amount gets priced — and, where it differs from a figure the
 * task already held, how that amount is amended at completion with the change
 * recorded in the audit entry. On a legacy hand-back a differing figure is
 * refused as a stale screen rather than applied.
 *
 * #3032 CHANGED WHAT THIS ROUTE CAN SET IN MOTION, and the docblock used to say
 * the opposite ("never calls Stripe or Xero"). Completing an
 * `EDIT_FINANCIAL_REVIEW` task now routes the confirmed amount down whichever of
 * the club's three existing settlement paths the booking's money actually took:
 * a Stripe refund on a card booking, a ledger mirror of a hand-back, or account
 * credit — and queues the matching Xero credit note on the outbox afterwards.
 * The legacy task kinds are untouched and still move only the local ledger.
 *
 * That is why the success message below is per-route rather than one sentence.
 * "Refund recorded as paid back by hand" over a Stripe refund that FAILED is a
 * false receipt: the money is still in the club's account, and the operator who
 * reads it has no reason to look again.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid refund task request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await resolveManualRefundTask(
      parsed.data.resolution === "completed"
        ? {
            taskId: id,
            resolution: "completed",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
            confirmedAmountCents: parsed.data.confirmedAmountCents ?? null,
            direction: parsed.data.direction ?? null,
            recordedNightPrices: parsed.data.recordedNightPrices ?? null,
          }
        : {
            taskId: id,
            resolution: "dismissed",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
            recordedNightPrices: parsed.data.recordedNightPrices ?? null,
          },
    );
    revalidatePath("/admin/payments");
    revalidatePath("/admin/bookings/[id]", "page");
    return NextResponse.json({
      success: true,
      task: result,
      message: `${
        parsed.data.resolution === "completed"
          ? completionMessage(result)
          : "Refund task dismissed."
      }${nightPricesRecordedMessage(result.recordedNightPriceCount)}`,
    });
  } catch (error) {
    if (error instanceof ManualBookingPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, taskId: id }, "Manual refund task resolution failed");
    return NextResponse.json(
      { error: "Could not close the refund task." },
      { status: 500 },
    );
  }
}
