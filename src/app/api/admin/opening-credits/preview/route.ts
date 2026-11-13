import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import logger from "@/lib/logger";
import { buildOpeningCreditPreview } from "@/lib/opening-credit-batch";
import { OPENING_CREDIT_CSV_MAX_CHARS } from "@/lib/opening-credit-csv";
import { applyRateLimit } from "@/lib/rate-limit";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { requireAdmin } from "@/lib/session-guards";

const previewSchema = z.object({
  csvText: z.string().min(1).max(OPENING_CREDIT_CSV_MAX_CHARS),
});

/**
 * POST /api/admin/opening-credits/preview
 * Match an opening-credit CSV to members and total it (#4988). Writes nothing.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const limited = await applyRateLimit({ id: "opening-credit-preview", limit: 30, windowSeconds: 60 * 60 }, request);
  if (limited) return limited;

  const parsed = previewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Upload a CSV file to preview" }, { status: 400 });
  }
  try {
    const result = await buildOpeningCreditPreview(parsed.data.csvText, { postingAdminId: guard.session.user.id });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(result.preview);
  } catch (error) {
    logger.error({ err: error }, "Failed to preview an opening-credit batch");
    return NextResponse.json({ error: "Failed to preview the opening-credit file" }, { status: 500 });
  }
}
