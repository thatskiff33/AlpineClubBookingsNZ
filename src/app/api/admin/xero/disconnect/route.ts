import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { disconnectXero } from "@/lib/xero";
import { getAuditRequestContext } from "@/lib/audit";

/**
 * POST /api/admin/xero/disconnect
 * Disconnects the Xero integration by revoking and removing tokens.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    // Destroying the grant is this administrator's act, recorded as theirs (#3454).
    await disconnectXero({
      actor: { kind: "admin", memberId: guard.session.user.id },
      request: getAuditRequestContext(request),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to disconnect Xero");
    return NextResponse.json({ error: "Failed to disconnect Xero" }, { status: 500 });
  }
}
