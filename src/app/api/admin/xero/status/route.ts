import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getXeroConnectionStatus } from "@/lib/xero";

/**
 * GET /api/admin/xero/status
 * Returns the current Xero connection status.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const status = await getXeroConnectionStatus();
    return NextResponse.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check Xero status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
