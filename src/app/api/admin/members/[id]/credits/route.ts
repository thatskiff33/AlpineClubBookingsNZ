import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";
import {
  getMemberCreditBalance,
  getAdminMemberCreditHistory,
  getPendingAdminAdjustmentRequests,
  createAdminAdjustmentRequest,
} from "@/lib/member-credit";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { formatCentsPlain } from "@/lib/utils";
import {
  ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT,
  MemberCreditValidationError,
} from "@/lib/policies/member-credit";

/**
 * GET /api/admin/members/[id]/credits
 * Returns credit balance and history for a member (admin only).
 */
export async function GET(
  _request: NextRequest,
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

    return NextResponse.json({ balanceCents, history, pendingRequests });
  } catch (error) {
    logger.error({ err: error }, "Error fetching member credit history");
    return NextResponse.json(
      { error: "Failed to fetch credit history" },
      { status: 500 }
    );
  }
}

const adjustmentSchema = z.object({
  amountCents: z.number().int().refine((v) => v !== 0, "Amount cannot be zero"),
  description: z.string().min(1, "Description is required").max(500),
  idempotencyKey: z.string().uuid("Idempotency key must be a UUID"),
});

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
    const parsed = adjustmentSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await createAdminAdjustmentRequest(
      id,
      parsed.data.amountCents,
      parsed.data.description,
      session.user.id,
      parsed.data.idempotencyKey,
      getClientIp(request)
    );

    return NextResponse.json({
      success: true,
      requestId: result.request.id,
      requestStatus: result.request.status,
      replayed: result.replayed,
      message: `Adjustment of ${parsed.data.amountCents > 0 ? "+" : ""}${formatCentsPlain(parsed.data.amountCents)} submitted for approval`,
    });
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
