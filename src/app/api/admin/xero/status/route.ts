import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getXeroConnectionStatus } from "@/lib/xero";
import { getXeroFeatureFlags } from "@/lib/xero-feature-flags";

/**
 * GET /api/admin/xero/status
 * Returns the current Xero connection status.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const status = await getXeroConnectionStatus();
    return NextResponse.json({
      ...status,
      features: getXeroFeatureFlags(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check Xero status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
