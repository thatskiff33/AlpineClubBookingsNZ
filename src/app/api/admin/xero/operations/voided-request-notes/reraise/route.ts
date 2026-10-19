import { scheduleAfterResponse } from "@/lib/schedule-after-response";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import { RefundRequestNoteReraiseError, reraiseVoidedRefundRequestNote } from "@/lib/xero-refund-request-note-reraise";

const reraiseSchema = z.object({
  paymentId: z.string().trim().min(1).max(200),
  refundRequestId: z.string().trim().min(1).max(200),
});

/**
 * #4214 (owner decision): "Raise a fresh credit note" - the officer's one path
 * to a fresh note for a refund request whose own note Xero voided. The guard,
 * the queued row and its audit entry live in `reraiseVoidedRefundRequestNote`,
 * in one transaction; the outbox raises the note after the response.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const parsed = reraiseSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid re-raise payload", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await reraiseVoidedRefundRequestNote({ ...parsed.data, actingMemberId: guard.session.user.id });
    scheduleAfterResponse(async () => {
      try {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      } catch (error) {
        logger.error({ err: error, operationId: result.operationId }, "Failed to kick the Xero outbox after a re-raise");
      }
    });
    return NextResponse.json(
      { ok: true, message: "A fresh credit note for this refund request is queued for Xero.", queueOperationId: result.operationId },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof RefundRequestNoteReraiseError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, ...parsed.data }, "Failed to re-raise a voided refund request note");
    return NextResponse.json({ error: "Failed to queue a fresh credit note" }, { status: 500 });
  }
}
