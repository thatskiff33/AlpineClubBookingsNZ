import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { revalidateAdminPage } from "@/lib/admin-page-revalidation";
import { parseJsonRequestBody } from "@/lib/api-json";
import { giveImportedRefundAsCredit } from "@/lib/booking-import/refund-credit";
import { clubFormatValues } from "@/lib/club-format-server";
import { formatCents } from "@/lib/utils";
import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { BOOKING_DETAIL_ROUTE_PATTERN } from "@/lib/page-route-patterns";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

/**
 * POST /api/admin/payments/manual-refund-tasks/[id]/account-credit
 *
 * #5005 child D (owner decision O1, 11 Nov 2026): settle a cancelled imported booking's refund task as account
 * credit instead of a bank transfer. Gated `finance:edit` and a recent sign-in, as Mark paid back is: it closes a
 * money task. Which tasks qualify, and everything it writes, is `booking-import/refund-credit.ts`.
 *
 * `expectedAmountCents` is the amount the officer's confirmation showed: a request naming any other is refused,
 * so a stale screen credits nothing unconfirmed, and a second click finds the task closed.
 */
const bodySchema = z
  .object({
    confirmed: z.literal(true),
    expectedAmountCents: z.number().int().positive(),
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).nullable().optional(),
  })
  .strict();

const ACCOUNT_CREDIT_FAILED = "Could not give this refund as account credit. Reload the queue to see whether it was given.";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;

  const jsonBody = await parseJsonRequestBody(request, { error: "Invalid JSON." });
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = bodySchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid account credit request.", details: parsed.error.flatten() }, { status: 400 });
  }

  const format = await clubFormatValues();
  try {
    const credit = await giveImportedRefundAsCredit({
      taskId: id,
      actingMemberId: guard.session.user.id,
      expectedAmountCents: parsed.data.expectedAmountCents,
      note: parsed.data.note ?? null,
    }, format);
    revalidateAdminPage("payments");
    revalidatePath(BOOKING_DETAIL_ROUTE_PATTERN, "page");
    return NextResponse.json({
      success: true,
      credit,
      message: `${formatCents(credit.amountCents, format)} given as account credit. The member has been emailed.`,
    });
  } catch (error) {
    if (error instanceof ManualBookingPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // `INV-LOCK-006`: everything is written in one transaction, so a contended one saved nothing.
    const contended = transactionContendedResponse(
      error,
      "Imported refund as account credit contended for the lock(1) budget",
      { context: { taskId: id } },
    );
    if (contended) return contended;
    logger.error({ err: error, taskId: id }, "Giving an imported refund as account credit failed");
    return NextResponse.json({ error: ACCOUNT_CREDIT_FAILED }, { status: 500 });
  }
}
