import { NextResponse } from "next/server";
import { XERO_HEALTH_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-sync";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroAdminHealthSnapshot } from "@/lib/xero-admin-health";
import logger from "@/lib/logger";

export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const snapshot = await getXeroAdminHealthSnapshot();
    return connectionJson(request, snapshot, XERO_HEALTH_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero admin health snapshot");
    return NextResponse.json(
      { error: "Failed to load Xero admin health snapshot" },
      { status: 500 }
    );
  }
}
