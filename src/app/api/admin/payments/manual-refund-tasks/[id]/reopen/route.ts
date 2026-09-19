import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  MANUAL_PAYMENT_NOTE_MAX,
  reopenManualRefundTask,
} from "@/lib/manual-refund-task-reopen";

/**
 * POST /api/admin/payments/manual-refund-tasks/[id]/reopen
 *
 * #3498 (owner decision D2): put a DISMISSED money task back on the finance
 * queue. Gated `finance:edit`, the same permission as closing one — undoing a
 * decision is not a lesser act than taking it — and audited either way.
 *
 * It moves no money and calls no provider. Every rule about WHICH closures may
 * be reopened, and why a completion may never be, lives in
 * `manual-refund-task-reopen.ts` rather than here.
 *
 * The note is REQUIRED and is validated there, not by this schema, so the
 * officer is answered with the sentence that names what to do rather than with
 * a field dump — the same correction #3195 made to the sibling route's $0.00
 * refusal.
 */
const bodySchema = z
  .object({
    // Explicit confirmation so putting a money question back in front of the
    // club is never a single-click accident, matching the settle route.
    confirmed: z.literal(true),
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional().nullable(),
  })
  .strict();

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
      { error: "Invalid reopen request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const task = await reopenManualRefundTask({
      taskId: id,
      actingMemberId: guard.session.user.id,
      note: parsed.data.note ?? null,
    });
    revalidatePath("/admin/payments");
    revalidatePath("/admin/bookings/[id]", "page");
    return NextResponse.json({
      success: true,
      task,
      message:
        "Put back on the queue. It is an open money question again, so a further price change to this booking is held until it is settled.",
    });
  } catch (error) {
    if (error instanceof ManualBookingPaymentError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    logger.error({ err: error, taskId: id }, "Manual refund task reopen failed");
    return NextResponse.json(
      { error: "Could not put this item back on the queue." },
      { status: 500 },
    );
  }
}
