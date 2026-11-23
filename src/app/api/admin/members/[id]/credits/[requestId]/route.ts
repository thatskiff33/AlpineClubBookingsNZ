import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";
import {
  getMemberCreditBalance,
  reviewAdminAdjustmentRequest,
} from "@/lib/member-credit";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";

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
    const guard = await requireAdmin({
      permission: { area: "finance", level: "edit" },
    });
    if (!guard.ok) return guard.response;
    const session = guard.session;
    const { id, requestId } = await params;
    const jsonBody = await parseJsonRequestBody(request);
    if (!jsonBody.ok) return jsonBody.response;
    const body = jsonBody.body;
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
    logger.error({ err: error }, "Error reviewing credit adjustment");

    if (error instanceof MemberCreditValidationError) {
      const status =
        error.message === "Adjustment request not found"
          ? 404
          : error.message === "This adjustment request has already been reviewed"
            ? 409
            : error.message === "A different admin must approve this adjustment"
              ? 403
              : 400;
      return NextResponse.json({ error: error.message }, { status });
    }

    return NextResponse.json(
      { error: "Failed to review adjustment request" },
      { status: 500 }
    );
  }
}
