import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";
import { postOpeningCreditBatch } from "@/lib/opening-credit-batch";
import { OPENING_CREDIT_CSV_MAX_CHARS } from "@/lib/opening-credit-csv";
import { applyRateLimit } from "@/lib/rate-limit";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { requireAdmin } from "@/lib/session-guards";

const confirmSchema = z.object({
  csvText: z.string().min(1).max(OPENING_CREDIT_CSV_MAX_CHARS),
  batchKey: z.string().regex(/^[0-9a-f]{64}$/),
  totalCents: z.number().int().positive(),
});

/**
 * POST /api/admin/opening-credits/confirm
 * Post a previewed opening-credit CSV as one audited batch (#4988,
 * `INV-PAY-151`). The same file posts once.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const limited = await applyRateLimit({ id: "opening-credit-confirm", limit: 10, windowSeconds: 60 * 60 }, request);
  if (limited) return limited;

  const parsed = confirmSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Preview the file before confirming it" }, { status: 400 });
  }
  try {
    const posted = await postOpeningCreditBatch({
      csvText: parsed.data.csvText,
      expectedBatchKey: parsed.data.batchKey,
      expectedTotalCents: parsed.data.totalCents,
      adminId: guard.session.user.id,
      request: getAuditRequestContext(request),
    });
    return NextResponse.json(posted, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error({ err: error }, "Failed to post an opening-credit batch");
    return NextResponse.json({ error: "Failed to post the opening-credit batch" }, { status: 500 });
  }
}
