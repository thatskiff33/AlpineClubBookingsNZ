import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getAiUsageSummary } from "@/lib/ai-assistant-usage";
import { HELP_ASSISTANT_USAGE_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-ai";
import { connectionJson } from "@/lib/mcp-connection-request";
import logger from "@/lib/logger";

// GET /api/admin/ai-assistant/usage — AI help assistant usage + spend summary
// for the admin panel (#2211, C3). Matches the Xero usage route's permission
// shape: an admin guard (resolves to support/view via the route-area header).
// The response NEVER contains question text.
export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const summary = await getAiUsageSummary();
    return connectionJson(request, summary, HELP_ASSISTANT_USAGE_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "Failed to load AI assistant usage");
    return NextResponse.json(
      { error: "Failed to load AI assistant usage" },
      { status: 500 },
    );
  }
}
