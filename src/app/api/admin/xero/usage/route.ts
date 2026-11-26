import { NextResponse } from "next/server";
import { XERO_USAGE_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-sync";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { getTodaysXeroUsageSummary } from "@/lib/xero-api-usage";
import logger from "@/lib/logger";

export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const summary = await getTodaysXeroUsageSummary();
    return connectionJson(request, summary, XERO_USAGE_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero API usage");
    return NextResponse.json({ error: "Failed to load Xero API usage" }, { status: 500 });
  }
}
