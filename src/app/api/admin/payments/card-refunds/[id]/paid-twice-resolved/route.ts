import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { nonNegativeCentsSchema } from "@/lib/edit-financial-review-context";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { CardRefundPaidTwiceError, resolveCardRefundPaidTwice } from "@/lib/card-refund-paid-twice";

/** A confirmed body with the treasurer's note on how it was sorted out, and the card figure they saw. */
const bodySchema = z
  .object({
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX),
    // #3924 round 8: the card figure the dialog showed; a moved one is a 409.
    expectedRefundedByCardCents: nonNegativeCentsSchema,
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/card-refunds/[id]/paid-twice-resolved
 *
 * #3372 (owner, 9 Oct 2026: "Add a 'Resolved' button"): mark a card refund
 * the treasurer closed as paid another way, and Stripe also paid, as sorted
 * out with the member. `[id]` is the card refund operation, as on the list.
 * Gated `finance:edit`, as the close itself is
 * (`/api/admin/payments/card-refunds/[id]/paid-another-way`). Writes a note,
 * audited, and the row leaves the list; it moves no money and touches no Xero.
 * The rules are `resolveCardRefundPaidTwice`'s.
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
    const result = await resolveCardRefundPaidTwice({
      operationId: id,
      note: parsed.data.note,
      expectedRefundedByCardCents: parsed.data.expectedRefundedByCardCents,
      actingMemberId: guard.session.user.id,
    });
    revalidatePath("/admin/stuck-states");
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof CardRefundPaidTwiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, operationId: id }, "Marking a card refund paid back twice as resolved failed");
    return NextResponse.json(
      { error: "Could not mark it resolved." },
      { status: 500 },
    );
  }
}
