import { revalidatePath } from "next/cache";
import { revalidateAdminPage } from "@/lib/admin-page-revalidation";
import { parseJsonRequestBody } from "@/lib/api-json";
import { BOOKING_DETAIL_ROUTE_PATTERN } from "@/lib/page-route-patterns";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { ManualRefundTaskKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";
// `INV-SSOT` (#3030): the one non-negative-integer-cents rule, not a fourth
// inline `.number().int().nonnegative()`.
import { nonNegativeCentsSchema } from "@/lib/cents-schema";
import {
  completionMessage,
  dismissalMessage,
  RETIRED_EDIT_REVIEW_REFUSAL,
} from "@/lib/manual-refund-task-copy";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import {
  MANUAL_PAYMENT_NOTE_MAX,
  resolveManualRefundTask,
} from "@/lib/manual-refund-task-resolution";
import { clubFormatValues } from "@/lib/club-format-server";
import { bankRefundVoidAnswerBodySchema, bankRefundVoidAnswerMessage, prepareBankRefundVoidAnswer, reconcileHandMadeNoteAfterCompletion } from "@/lib/bank-refund-void-answer";
import { requireRecentAuth } from "@/lib/require-recent-auth";

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
       * #3536 (`INV-PAY-116`): on a refund the club pays back by hand, the
       * officer's answer to how it went back - true for cash, false for a bank
       * transfer. Optional: no answer keeps the bank-transfer wording. It
       * changes the words on the Xero credit note and nothing else.
       */
      handedBackInCash: z.boolean().optional().nullable(),
      /** #4162 (`INV-ADDPAY-042`): a bank refund to re-confirm's answer; the writer refuses it on any other task. */
      bankRefundVoidAnswer: bankRefundVoidAnswerBodySchema.optional().nullable(),
    })
    .strict(),
  z
    .object({
      resolution: z.literal("dismissed"),
      note: noteField,
      confirmed: confirmedField,
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
 * `confirmedAmountCents` - today the total a group organiser's hand-back card
 * showed (#4042). On a legacy hand-back a differing figure is refused as a
 * stale screen rather than applied.
 *
 * #4344 (wave C1 of #4302): an `EDIT_FINANCIAL_REVIEW` task is refused at 409
 * before anything else happens. The officer review that priced and settled one
 * here - through a Stripe refund, a ledger mirror or account credit, with the
 * matching Xero document - is retired; wave B closed every open one. The
 * per-night prices a review settle could record went with it.
 *
 * The success message is per-route rather than one sentence: "Refund recorded
 * as paid back by hand" over a Stripe refund that FAILED is a false receipt.
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

  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;

  /*
    #4344 (wave C1 of #4302): the officer edit review is retired. Refused here,
    after the permission and recent-sign-in checks and BEFORE the body is read,
    so a stale settle screen posting the old review fields is told what happened
    rather than "invalid request" - and before any Xero read or resolution, so a
    refused request writes nothing and calls no provider. Wave B closed every
    open review; a row that is somehow still open stays where it is. A missing
    task falls through to the resolution, which answers it as it always has.
  */
  const retiring = await prisma.manualRefundTask.findUnique({
    where: { id },
    select: { kind: true },
  });
  if (retiring?.kind === ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW) {
    return NextResponse.json(
      { error: RETIRED_EDIT_REVIEW_REFUSAL },
      { status: 409 },
    );
  }
  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON.",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid refund task request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // The club's format (#3565), resolved once per request, before the
  // resolution's transaction.
  const format = await clubFormatValues();

  try {
    // #4162: the "already in Xero" answer reads Xero HERE, before the completion's transaction, so no lock is held across it.
    const voidAnswer = parsed.data.resolution === "completed" ? parsed.data.bankRefundVoidAnswer : null;
    const bankRefundVoidAnswer = voidAnswer ? await prepareBankRefundVoidAnswer({ taskId: id, answer: voidAnswer, format }) : null;
    const result = await resolveManualRefundTask(
      parsed.data.resolution === "completed"
        ? {
            taskId: id,
            resolution: "completed",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
            confirmedAmountCents: parsed.data.confirmedAmountCents ?? null,
            direction: parsed.data.direction ?? null,
            recordedNightPrices: null,
            handedBackInCash: parsed.data.handedBackInCash ?? null,
            bankRefundVoidAnswer,
          }
        : {
            taskId: id,
            resolution: "dismissed",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
            recordedNightPrices: null,
          },
      format,
    );
    await reconcileHandMadeNoteAfterCompletion(bankRefundVoidAnswer); // #4162: catch a void since the check
    revalidateAdminPage("payments");
    revalidatePath(BOOKING_DETAIL_ROUTE_PATTERN, "page");
    return NextResponse.json({
      success: true,
      task: result,
      message: bankRefundVoidAnswer
        ? bankRefundVoidAnswerMessage(bankRefundVoidAnswer)
        : parsed.data.resolution === "completed"
          ? completionMessage(result, format)
          : dismissalMessage(result.kind, result.partPaymentReview),
    });
  } catch (error) {
    if (error instanceof ManualBookingPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const contended = transactionContendedResponse(
      error,
      "Manual refund task resolution contended for the lock(1) budget",
      { context: { taskId: id } },
    );
    if (contended) return contended;
    logger.error({ err: error, taskId: id }, "Manual refund task resolution failed");
    return NextResponse.json(
      { error: "Could not close the refund task." },
      { status: 500 },
    );
  }
}
