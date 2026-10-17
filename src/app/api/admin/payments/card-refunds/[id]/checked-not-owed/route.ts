import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { CardRefundCheckNotOwedError, closeCardRefundCheckNotOwed } from "@/lib/card-refund-check-not-owed";

/** Explicit confirmation, as every close of a money obligation asks, and a note saying why it is not owed. */
const bodySchema = z
  .object({
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX),
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/card-refunds/[id]/checked-not-owed
 *
 * #4210 round 3 (`INV-PAY-136`): close a card refund the app raised for an
 * officer to check - after Stripe failed a refund a "Paid another way" close
 * may not have paid back - because the member is not owed it. Gated
 * `finance:edit`, as the "Paid another way" close is. Moves no money; the row
 * leaves "Refunds owed" and Net Collected, and the note is audited. The rules
 * are `closeCardRefundCheckNotOwed`'s.
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
    const result = await closeCardRefundCheckNotOwed({
      operationId: id,
      note: parsed.data.note,
      actingMemberId: guard.session.user.id,
    });
    revalidatePath("/admin/stuck-states");
    revalidatePath("/admin/payments");
    revalidatePath("/admin/dashboard");
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof CardRefundCheckNotOwedError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, operationId: id }, "Closing a card refund check as not owed failed");
    return NextResponse.json(
      { error: "Could not close the card refund." },
      { status: 500 },
    );
  }
}
