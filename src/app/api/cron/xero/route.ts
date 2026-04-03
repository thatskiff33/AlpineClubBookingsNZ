import { NextRequest, NextResponse } from "next/server";
import { refreshAllMembershipStatuses, isXeroConnected } from "@/lib/xero";

/**
 * POST /api/cron/xero
 * Daily cron endpoint for refreshing membership statuses from Xero.
 * Secured with CRON_SECRET to prevent unauthorized access.
 */
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Skip if Xero is not connected
  const connected = await isXeroConnected();
  if (!connected) {
    return NextResponse.json({ message: "Xero not connected, skipping" });
  }

  try {
    const result = await refreshAllMembershipStatuses();
    return NextResponse.json({
      message: "Membership status refresh completed",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cron job failed";
    console.error("[Xero Cron] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
