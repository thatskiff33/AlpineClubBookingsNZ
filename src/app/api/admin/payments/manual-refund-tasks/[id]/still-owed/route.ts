import { NextRequest, NextResponse } from "next/server";

import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { nonNegativeCentsSchema } from "@/lib/edit-financial-review-context";
import { previewEditReviewStillOwed } from "@/lib/edit-financial-review-still-owed";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/payments/manual-refund-tasks/[id]/still-owed?shareCents=5000
 *
 * #3835: before an officer completes a financial review on a CANCELLED
 * booking, what that share will actually give back - netted against the
 * cancellation by the completion's own rule (`previewEditReviewStillOwed`) -
 * so a bank transfer is made for that figure. Writes nothing. `preview` is
 * null where there is nothing to say. Gated finance:view, like the queue.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const shareCents = nonNegativeCentsSchema.safeParse(Number(request.nextUrl.searchParams.get("shareCents") ?? ""));
  if (!shareCents.success || shareCents.data <= 0) {
    return NextResponse.json({ error: "A positive share in whole cents is required." }, { status: 400 });
  }
  try {
    // `INV-LOCK-004`: the club's zone, outside any transaction.
    const clubZone = await readClubTimeZoneOutsideRequest();
    const preview = await previewEditReviewStillOwed({ taskId: id, shareCents: shareCents.data, clubZone });
    return NextResponse.json({ preview });
  } catch (error) {
    logger.error({ err: error, taskId: id }, "Could not work out what a financial review still owes");
    return NextResponse.json({ error: "Could not work out what is still owed." }, { status: 500 });
  }
}
