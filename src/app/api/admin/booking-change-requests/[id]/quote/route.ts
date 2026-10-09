import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import {
  finishedStayQuoteResponse,
  finishedStayQuoteSchema,
} from "@/lib/booking-change-request-admin-decision";

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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
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
