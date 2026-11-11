import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { refreshAllMembershipStatuses } from "@/lib/xero-membership-sync";
import logger from "@/lib/logger";
import { z } from "zod";

const syncMembershipsQuerySchema = z.object({
  seasonYear: z
    .union([z.coerce.number().int().min(2020).max(2040), z.literal("")])
    .optional(),
  mode: z.enum(["incremental", "backfill"]).default("incremental"),
});

/**
 * POST /api/admin/xero/sync-memberships
 * Triggers a membership status refresh for all active members with Xero contacts.
 * Accepts optional `seasonYear` query parameter to sync a specific year.
 * Accepts optional `mode` query parameter:
 * - `incremental` (default): only changed invoices / retry members
 * - `backfill`: also rechecks locally stale linked members
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const parsed = syncMembershipsQuerySchema.safeParse({
    seasonYear: request.nextUrl.searchParams.get("seasonYear") ?? undefined,
    mode: request.nextUrl.searchParams.get("mode") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const seasonYear =
    parsed.data.seasonYear === "" ? undefined : parsed.data.seasonYear;
  const mode = parsed.data.mode;

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
