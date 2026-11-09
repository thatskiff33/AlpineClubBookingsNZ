import { revalidateAdminPage } from "@/lib/admin-page-revalidation";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { nonNegativeCentsSchema } from "@/lib/edit-financial-review-context";
import { DeadCardRefundActionError, tryDeadCardRefundAgain } from "@/lib/card-refund-dead-row-actions";

/** The confirm dialog's yes, and the owed figure it showed (a moved one is a 409). */
const bodySchema = z
  .object({
    expectedOwedCents: nonNegativeCentsSchema,
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/card-refunds/[id]/try-card-again
 *
 * #4368 (owner decision 5 on #4361, 25 Oct 2026): put a card refund Stripe
 * gave up on back to run, so the recovery runner asks the card again. Gated
 * `finance:edit`, exactly as "Paid another way" is
 * (`/api/admin/payments/card-refunds/[id]/paid-another-way`). Sends nothing
 * itself: the runner's Stripe check (`INV-PAY-145`) runs before any send.
 * Audited. The rules are `tryDeadCardRefundAgain`'s.
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
    const result = await tryDeadCardRefundAgain({
      operationId: id,
      expectedOwedCents: parsed.data.expectedOwedCents,
      actingMemberId: guard.session.user.id,
    });
    revalidateAdminPage("stuck-states");
    revalidateAdminPage("payments");
    revalidateAdminPage("dashboard");
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof DeadCardRefundActionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, operationId: id }, "Trying a card refund Stripe gave up on again failed");
    return NextResponse.json({ error: "Could not try the card again." }, { status: 500 });
  }
}
