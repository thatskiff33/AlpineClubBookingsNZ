import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import {
  getMemberCreditBalance,
  reviewAdminAdjustmentRequest,
} from "@/lib/member-credit";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});

/**
 * PATCH /api/admin/members/[id]/credits/[requestId]
 * Review a pending manual credit adjustment request.
 */
export async function PATCH(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string; requestId: string }>;
  }
) {
  try {
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    const { id, requestId } = await params;
    const body = await request.json();
    const parsed = reviewSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await reviewAdminAdjustmentRequest(
      id,
      requestId,
      parsed.data.decision,
      session.user.id,
      getClientIp(request)
    );

    const balanceCents = await getMemberCreditBalance(id);
    const message =
      result.decision === "APPROVE"
        ? "Adjustment approved and applied"
        : "Adjustment rejected";

    return NextResponse.json({
      success: true,
      balanceCents,
      message,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to review adjustment request";

    logger.error({ err: error }, "Error reviewing credit adjustment");

    if (message === "Adjustment request not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }

    if (message === "This adjustment request has already been reviewed") {
      return NextResponse.json({ error: message }, { status: 409 });
    }

    if (message === "A different admin must approve this adjustment") {
      return NextResponse.json({ error: message }, { status: 403 });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
