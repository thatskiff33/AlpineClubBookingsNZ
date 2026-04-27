import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { refreshAllMembershipStatuses } from "@/lib/xero";
import logger from "@/lib/logger";

/**
 * POST /api/admin/xero/sync-memberships
 * Triggers a membership status refresh for all active members with Xero contacts.
 * Accepts optional `seasonYear` query parameter to sync a specific year.
 * Accepts optional `mode` query parameter:
 * - `incremental` (default): only changed invoices / retry members
 * - `backfill`: also rechecks locally stale linked members
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const seasonYearParam = request.nextUrl.searchParams.get("seasonYear");
  const seasonYear = seasonYearParam ? parseInt(seasonYearParam, 10) : undefined;
  if (seasonYear !== undefined && (isNaN(seasonYear) || seasonYear < 2020 || seasonYear > 2040)) {
    return NextResponse.json({ error: "Invalid seasonYear" }, { status: 400 });
  }
  const modeParam = request.nextUrl.searchParams.get("mode");
  const mode = modeParam ?? "incremental";
  if (mode !== "incremental" && mode !== "backfill") {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  try {
    const result = await refreshAllMembershipStatuses(seasonYear, {
      includeBackfillCandidates: mode === "backfill",
    });
    return NextResponse.json({
      ...result,
      mode,
    });
  } catch (error) {
    logger.error({ err: error }, "Membership sync failed");
    return NextResponse.json({ error: "Membership sync failed" }, { status: 500 });
  }
}
