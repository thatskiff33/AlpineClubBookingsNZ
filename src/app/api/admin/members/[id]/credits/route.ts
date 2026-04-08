import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import {
  getMemberCreditBalance,
  getMemberCreditHistory,
  createAdminAdjustment,
} from "@/lib/member-credit";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";

/**
 * GET /api/admin/members/[id]/credits
 * Returns credit balance and history for a member (admin only).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const { id } = await params;

    const [balanceCents, history] = await Promise.all([
      getMemberCreditBalance(id),
      getMemberCreditHistory(id),
    ]);

    return NextResponse.json({ balanceCents, history });
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
});

/**
 * POST /api/admin/members/[id]/credits
 * Create a manual credit adjustment (admin only).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
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

    await createAdminAdjustment(
      id,
      parsed.data.amountCents,
      parsed.data.description,
      session.user.id,
      getClientIp(request)
    );

    const balanceCents = await getMemberCreditBalance(id);

    return NextResponse.json({
      success: true,
      balanceCents,
      message: `Adjustment of ${parsed.data.amountCents > 0 ? "+" : ""}${(parsed.data.amountCents / 100).toFixed(2)} applied`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create adjustment";
    logger.error({ err: error }, "Error creating credit adjustment");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
