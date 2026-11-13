import { NextResponse } from "next/server";

import logger from "@/lib/logger";
import { listOpeningCreditBatches } from "@/lib/opening-credit-batch";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/opening-credits
 * The opening-credit batches posted so far (#4988), newest first.
 */
export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ batches: await listOpeningCreditBatches() });
  } catch (error) {
    logger.error({ err: error }, "Failed to list opening-credit batches");
    return NextResponse.json({ error: "Failed to load opening-credit batches" }, { status: 500 });
  }
}
