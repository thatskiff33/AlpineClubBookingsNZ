import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import {
  finishedStayQuoteResponse,
  finishedStayQuoteSchema,
} from "@/lib/booking-change-request-admin-decision";
import { requireRecentAuth } from "@/lib/require-recent-auth";

/**
 * #3750 (P2 on #3955): what approving a locked-period change request on a
 * FINISHED stay would do — the change fee, the price difference, and the
 * refund, credit or amount due — computed by the approval's own executor in a
 * transaction that is rolled back. Nothing is written and no provider is
 * contacted. Same permission as the decision itself.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = finishedStayQuoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  return finishedStayQuoteResponse(req, {
    requestId: id,
    body: parsed.data,
    actorMemberId: guard.session.user.id,
  });
}
