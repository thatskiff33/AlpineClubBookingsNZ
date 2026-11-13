import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";
import { reverseOpeningCreditBatch } from "@/lib/opening-credit-batch";
import { OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH } from "@/lib/opening-credit-csv";
import { applyRateLimit } from "@/lib/rate-limit";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { requireAdmin } from "@/lib/session-guards";

const reverseSchema = z.object({
  reason: z.string().trim().min(1).max(OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH),
});

/**
 * POST /api/admin/opening-credits/[id]/reverse
 * Reverse a whole opening-credit batch while every credit in it is unspent
 * (#4988); refuses otherwise and writes nothing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const limited = await applyRateLimit({ id: "opening-credit-reverse", limit: 10, windowSeconds: 60 * 60 }, request);
  if (limited) return limited;

  const { id } = await params;
  const parsed = reverseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A reason is required to reverse a batch" }, { status: 400 });
  }
  try {
    const reversed = await reverseOpeningCreditBatch({
      batchId: id,
      reason: parsed.data.reason,
      adminId: guard.session.user.id,
      request: getAuditRequestContext(request),
    });
    return NextResponse.json(reversed);
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error({ err: error, batchId: id }, "Failed to reverse an opening-credit batch");
    return NextResponse.json({ error: "Failed to reverse the opening-credit batch" }, { status: 500 });
  }
}
