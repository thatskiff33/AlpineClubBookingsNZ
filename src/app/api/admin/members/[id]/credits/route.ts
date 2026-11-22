import { NextRequest, NextResponse } from "next/server";
import {
  CREDIT_ADJUSTMENT_REQUESTED_CONNECTION_SHAPE,
  MEMBER_CREDITS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-payments";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { adminCreditAdjustmentRequestSchema } from "@/lib/admin-credit-adjustment-schemas";
import {
  getMemberCreditBalance,
  getAdminMemberCreditHistory,
  getPendingAdminAdjustmentRequests,
  createAdminAdjustmentRequest,
} from "@/lib/member-credit";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { formatCentsPlain } from "@/lib/utils";
import { isAdminCreditGrantAccount } from "@/lib/admin-credit-grant-account";
import {
  ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT,
  MemberCreditValidationError,
} from "@/lib/policies/member-credit";

/**
 * GET /api/admin/members/[id]/credits
 * Returns credit balance and history for a member (admin only).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireAdmin({
      permission: { area: "finance", level: "view" },
    });
    if (!guard.ok) return guard.response;
    const { id } = await params;

    const [balanceCents, history, pendingRequests] = await Promise.all([
      getMemberCreditBalance(id),
      getAdminMemberCreditHistory(id),
      getPendingAdminAdjustmentRequests(id),
    ]);

    return connectionJson(
      request,
      { balanceCents, history, pendingRequests },
      MEMBER_CREDITS_CONNECTION_SHAPE,
    );
  } catch (error) {
    logger.error({ err: error }, "Error fetching member credit history");
    return NextResponse.json(
      { error: "Failed to fetch credit history" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/members/[id]/credits
 * Submit a manual credit adjustment for second-admin approval.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireAdmin({
      permission: { area: "finance", level: "edit" },
    });
    if (!guard.ok) return guard.response;
    const session = guard.session;
    const { id } = await params;
    const body = await request.json();
    const parsed = adminCreditAdjustmentRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const grantAccount = parsed.data.grantAccount ?? null;
    const result = await createAdminAdjustmentRequest(
      id,
      parsed.data.amountCents,
      parsed.data.description,
      session.user.id,
      parsed.data.idempotencyKey,
      grantAccount && isAdminCreditGrantAccount(grantAccount) ? grantAccount : null,
      getClientIp(request)
    );

    return connectionJson(
      request,
      {
        success: true,
        requestId: result.request.id,
        requestStatus: result.request.status,
        replayed: result.replayed,
        message: `Adjustment of ${parsed.data.amountCents > 0 ? "+" : ""}${formatCentsPlain(parsed.data.amountCents)} submitted for approval`,
      },
      CREDIT_ADJUSTMENT_REQUESTED_CONNECTION_SHAPE,
    );
  } catch (error) {
    logger.error({ err: error }, "Error creating credit adjustment");

    if (error instanceof MemberCreditValidationError) {
      return NextResponse.json(
        { error: error.message },
        {
          status:
            error.message === ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT ? 409 : 400,
        }
      );
    }

    return NextResponse.json(
      { error: "Failed to create adjustment" },
      { status: 500 }
    );
  }
}
