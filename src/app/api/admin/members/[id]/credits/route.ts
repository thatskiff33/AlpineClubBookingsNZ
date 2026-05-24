import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import {
  getMemberCreditBalance,
  getAdminMemberCreditHistory,
  getPendingAdminAdjustmentRequests,
  createAdminAdjustmentRequest,
} from "@/lib/member-credit";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";

/**
 * GET /api/admin/members/[id]/credits
 * Returns credit balance and history for a member (admin only).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

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
      message: `Adjustment of ${parsed.data.amountCents > 0 ? "+" : ""}${(parsed.data.amountCents / 100).toFixed(2)} submitted for approval`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create adjustment";
    logger.error({ err: error }, "Error creating credit adjustment");

    if (
      message ===
      "This idempotency key was already used for a different adjustment request"
    ) {
      return NextResponse.json({ error: message }, { status: 409 });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
