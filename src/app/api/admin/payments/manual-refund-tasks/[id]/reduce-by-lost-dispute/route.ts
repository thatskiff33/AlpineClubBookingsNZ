import { revalidatePath } from "next/cache";
import { revalidateAdminPage } from "@/lib/admin-page-revalidation";
import { parseJsonRequestBody } from "@/lib/api-json";
import { BOOKING_DETAIL_ROUTE_PATTERN } from "@/lib/page-route-patterns";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clubFormatValues } from "@/lib/club-format-server";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { disputedHandBackReductionMessage, reduceDisputedHandBack } from "@/lib/manual-refund-task-dispute-reduction";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { DISPUTED_HAND_BACK_REDUCTION_FAILED } from "@/lib/manual-refund-task-copy";

/**
 * POST /api/admin/payments/manual-refund-tasks/[id]/reduce-by-lost-dispute
 *
 * #4516 (owner decision, 15 Nov 2026, comment 6893252570): reduce a disputed card payment's hand-back by the card
 * disputes lost for part of it, the rest staying owed. Gated `finance:edit` and a recent sign-in, as closing a task
 * is: it changes what the club owes. Every rule about when it may run, and by how much, lives in
 * `manual-refund-task-dispute-reduction.ts` and the one dismissal rule it shares.
 *
 * `expectedAmountCents` and `expectedReducedByCents` are what the officer's confirmation showed: a request naming
 * any other figures is refused, so a second click, a replay or a dispute recorded since reduces nothing unconfirmed.
 */
const bodySchema = z
  .object({
    confirmed: z.literal(true),
    expectedAmountCents: z.number().int().nonnegative(),
    expectedReducedByCents: z.number().int().positive(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON.",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid reduce request.", details: parsed.error.flatten() }, { status: 400 });
  }

  const format = await clubFormatValues();
  try {
    const reduction = await reduceDisputedHandBack({
      taskId: id,
      actingMemberId: guard.session.user.id,
      expectedAmountCents: parsed.data.expectedAmountCents,
      expectedReducedByCents: parsed.data.expectedReducedByCents,
    });
    revalidateAdminPage("payments");
    revalidatePath(BOOKING_DETAIL_ROUTE_PATTERN, "page");
    return NextResponse.json({ success: true, reduction, message: disputedHandBackReductionMessage(reduction, format) });
  } catch (error) {
    if (error instanceof ManualBookingPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // `INV-LOCK-006`: one transaction is all the reduction writes, so a contended
    // one saved nothing and the same confirmed figures can be sent again.
    const contended = transactionContendedResponse(
      error,
      "Disputed hand-back reduction contended for the lock(1) budget",
      { context: { taskId: id } },
    );
    if (contended) return contended;
    logger.error({ err: error, taskId: id }, "Disputed hand-back reduction failed");
    return NextResponse.json({ error: DISPUTED_HAND_BACK_REDUCTION_FAILED }, { status: 500 });
  }
}
