import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroConnectionStatus } from "@/lib/xero-token-store";
import { getXeroFeatureFlags } from "@/lib/xero-feature-flags";
import { probeXeroConnectionHealth } from "@/lib/xero-connection-probe";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/status
 * Returns the current Xero connection status.
 *
 * With `?probe=1` it additionally runs a live, click-only connection-health
 * probe (#2105) — cached server-side 30–60s — and returns the result under
 * `probe`. The probe is only ever triggered by the admin "Check connection"
 * button, never on mount or a poll, so it cannot silently burn the Xero budget.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const probe = new URL(request.url).searchParams.get("probe") === "1";
  try {
    const status = await getXeroConnectionStatus();
    const body: Record<string, unknown> = {
      ...status,
      features: getXeroFeatureFlags(),
    };
    if (probe && status.connected) {
      body.probe = await probeXeroConnectionHealth();
    }
    return NextResponse.json(body);
  } catch (error) {
    logger.error({ err: error }, "Failed to check Xero status");
    return NextResponse.json({ error: "Failed to check Xero status" }, { status: 500 });
  }
}
