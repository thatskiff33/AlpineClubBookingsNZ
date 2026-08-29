import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
// `INV-SSOT` (#3030): the one non-negative-integer-cents rule, not a fourth
// inline `.number().int().nonnegative()`.
import { nonNegativeCentsSchema } from "@/lib/edit-financial-review-context";
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
 * ZERO IS REFUSED (`INV-PAY-051`). "Reviewed, nothing is due" is DISMISSED, not a
 * completion at $0.00 — a $0 completion records a refund the club did not make.
 * The rule is enforced in `resolveManualRefundTask` too, which is the real
 * boundary; this refuses it a step earlier so the operator gets a validation
 * message rather than a thrown one, and so the two layers cannot drift into
 * disagreeing about what an amount may be.
 */
const bodySchema = z.discriminatedUnion("resolution", [
  z
    .object({
      resolution: z.literal("completed"),
      note: noteField,
      confirmed: confirmedField,
      confirmedAmountCents: nonNegativeCentsSchema
        .positive()
        .optional()
        .nullable(),
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
 * declined or settled another way and requires a note.
 * Gated finance:edit; audited either way; never calls Stripe or Xero.
 *
 * #3030 (epic #2797, owner decision D2): a completion may also carry
 * `confirmedAmountCents`, which is how an `EDIT_FINANCIAL_REVIEW` task raised
 * with an unknown amount gets priced — and, where it differs from a figure the
 * task already held, how that amount is amended at completion with the change
 * recorded in the audit entry. On a legacy hand-back a differing figure is
 * refused as a stale screen rather than applied.
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
          }
        : {
            taskId: id,
            resolution: "dismissed",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
          },
    );
    revalidatePath("/admin/payments");
    revalidatePath("/admin/bookings/[id]", "page");
    return NextResponse.json({
      success: true,
      task: result,
      message:
        parsed.data.resolution === "completed"
          ? result.amountAmended
            ? "Refund recorded as paid back by hand at the confirmed amount."
            : "Refund recorded as paid back by hand."
          : "Refund task dismissed.",
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
