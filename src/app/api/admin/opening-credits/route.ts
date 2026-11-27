import { NextRequest, NextResponse } from "next/server";

import { OPENING_CREDIT_BATCHES_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-payments";
import logger from "@/lib/logger";
import { connectionJson } from "@/lib/mcp-connection-request";
import { listOpeningCreditBatches } from "@/lib/opening-credit-batch";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/opening-credits
 * The opening-credit batches posted so far (#4988), newest first.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  try {
    return connectionJson(
      request,
      { batches: await listOpeningCreditBatches() },
      OPENING_CREDIT_BATCHES_CONNECTION_SHAPE,
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to list opening-credit batches");
    return NextResponse.json({ error: "Failed to load opening-credit batches" }, { status: 500 });
  }
}
