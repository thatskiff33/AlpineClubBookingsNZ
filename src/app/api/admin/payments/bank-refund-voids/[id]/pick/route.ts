import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";
import {
  BankRefundVoidAnswerRefusal,
  pickRefundForUnmatchedVoid,
} from "@/lib/bank-refund-void-follow-up";

const bodySchema = z.object({ lineId: z.string().min(1).max(64), confirmed: z.literal(true) }).strict();

/**
 * POST /api/admin/payments/bank-refund-voids/[id]/pick
 *
 * #4162 (owner decision 18 Oct 2026, comment 6247741127): a person picks the
 * bank refund an unmatched voided note recorded (`[id]` is the note's link,
 * `lineId` the refund's live `BANK_REFUND` line), and the nightly follow-up's
 * own undo runs (`pickRefundForUnmatchedVoid`). Gated `finance:edit`, the
 * permission that completes a refund paid back by hand. Refused (409) while
 * the follow-up is report-only, and when the note or line moved.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
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
    return NextResponse.json({ error: "Pick one refund.", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const result = await pickRefundForUnmatchedVoid({ linkId: id, lineId: parsed.data.lineId, actingMemberId: guard.session.user.id });
    revalidatePath("/admin/stuck-states");
    revalidatePath("/admin/payments");
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof BankRefundVoidAnswerRefusal) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isPostgresLockNotAvailable(error)) {
      return NextResponse.json({ error: "This payment is being updated right now. Try again in a minute." }, { status: 409 });
    }
    logger.error({ err: error, linkId: id }, "Picking the refund of a voided bank-transfer refund note failed");
    return NextResponse.json({ error: "Could not take the refund back." }, { status: 500 });
  }
}
