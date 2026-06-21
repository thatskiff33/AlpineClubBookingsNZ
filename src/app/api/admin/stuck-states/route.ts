import { NextResponse } from "next/server";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { getStuckStateDashboard } from "@/lib/stuck-state-dashboard";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  try {
    return NextResponse.json(await getStuckStateDashboard());
  } catch (error) {
    logger.error({ err: error }, "Failed to load stuck-state dashboard");
    return NextResponse.json(
      { error: "Failed to load stuck-state dashboard" },
      { status: 500 },
    );
  }
}
