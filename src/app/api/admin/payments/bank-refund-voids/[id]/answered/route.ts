import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";
import {
  BankRefundVoidAnswerRefusal,
  markUnmatchedBankRefundVoidAnswered,
} from "@/lib/bank-refund-void-follow-up";

const bodySchema = z
  .object({
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX),
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/bank-refund-voids/[id]/answered
 *
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): a person answers a
 * voided bank-transfer refund note the nightly follow-up could not match to
 * one refund (Stuck States). It moves no money and raises nothing in Xero: it
 * records who answered and their note on the voided note's link, so the item
 * leaves the list. `[id]` is the link id. Gated `finance:edit`, the permission
 * that completes a refund paid back by hand.
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
  const note = normaliseManualPaymentNote(parsed.data.note);
  if (!note) {
    return NextResponse.json({ error: "Say what you did - a note is required." }, { status: 400 });
  }

  try {
    const result = await markUnmatchedBankRefundVoidAnswered({
      linkId: id,
      note,
      actingMemberId: guard.session.user.id,
    });
    revalidatePath("/admin/stuck-states");
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof BankRefundVoidAnswerRefusal) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isPostgresLockNotAvailable(error)) {
      return NextResponse.json(
        { error: "This voided refund note is being updated right now. Try again in a minute." },
        { status: 409 },
      );
    }
    logger.error({ err: error, linkId: id }, "Answering a voided bank-transfer refund note failed");
    return NextResponse.json({ error: "Could not record the answer." }, { status: 500 });
  }
}
