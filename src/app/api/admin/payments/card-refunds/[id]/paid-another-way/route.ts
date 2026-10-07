import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { nonNegativeCentsSchema } from "@/lib/edit-financial-review-context";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import {
  CardRefundPaidAnotherWayError,
  closeCardRefundPaidAnotherWay,
} from "@/lib/card-refund-paid-another-way";

/**
 * Explicit confirmation, as the hand-back completion asks, so closing a money
 * obligation is never a single-click accident; and a note saying how the member
 * was paid back.
 */
const bodySchema = z
  .object({
    amountCents: nonNegativeCentsSchema,
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX),
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/card-refunds/[id]/paid-another-way
 *
 * #3372 (owner, 7 Oct 2026: "Count + add close action"): close a card refund
 * Stripe gave up on (`PaymentRecoveryOperation`, retries spent) because the
 * treasurer paid the member back another way. Gated `finance:edit`, the
 * permission that completes a refund paid back by hand
 * (`/api/admin/payments/manual-refund-tasks/[id]`). Records the money on the
 * payment, closes the refund so it leaves "Refunds owed" and Net Collected, and
 * audits it; no Stripe call. The rules are `closeCardRefundPaidAnotherWay`'s.
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
      { error: "Invalid request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await closeCardRefundPaidAnotherWay({
      operationId: id,
      amountCents: parsed.data.amountCents,
      note: parsed.data.note,
      actingMemberId: guard.session.user.id,
    });
    revalidatePath("/admin/stuck-states");
    revalidatePath("/admin/payments");
    revalidatePath("/admin/dashboard");
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof CardRefundPaidAnotherWayError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, operationId: id }, "Closing a card refund as paid another way failed");
    return NextResponse.json(
      { error: "Could not close the card refund." },
      { status: 500 },
    );
  }
}
