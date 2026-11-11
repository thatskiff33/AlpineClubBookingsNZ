import { revalidateAdminPage } from "@/lib/admin-page-revalidation";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { closeCardRefundNothingLeftOwed, DeadCardRefundActionError } from "@/lib/card-refund-dead-row-actions";
import { requireRecentAuth } from "@/lib/require-recent-auth";

/** Explicit confirmation, and the later Stripe refunds the dialog named (a different set is a 409). */
const bodySchema = z
  .object({
    expectedStripeRefundIds: z.array(z.string().min(1).max(255)).min(1).max(50),
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/card-refunds/[id]/nothing-left-owed
 *
 * #4368 (owner decision, 25 Oct 2026): close a card refund Stripe gave up on
 * whose owed figure reads $0, naming the later Stripe refund that covers it.
 * Gated `finance:edit`, exactly as "Paid another way" is
 * (`/api/admin/payments/card-refunds/[id]/paid-another-way`). Moves no money,
 * makes no Stripe call and no Xero change; audited. The rules are
 * `closeCardRefundNothingLeftOwed`'s.
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
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
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
    const result = await closeCardRefundNothingLeftOwed({
      operationId: id,
      expectedStripeRefundIds: parsed.data.expectedStripeRefundIds,
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
    logger.error({ err: error, operationId: id }, "Closing a card refund with nothing left owed failed");
    return NextResponse.json({ error: "Could not close the card refund." }, { status: 500 });
  }
}
