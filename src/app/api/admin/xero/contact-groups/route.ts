import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import {
  getXeroContactGroupCacheLastRefreshedAt,
  getXeroContactGroups,
} from "@/lib/xero-contact-groups";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/contact-groups
 * Returns cached Xero contact groups by default, along with `lastRefreshedAt`
 * (the ISO timestamp of the last successful cache refresh, or null when the
 * cache has never been populated).
 * Use `?refresh=1` for an operator-triggered refresh from Xero.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const refreshFromXero = request.nextUrl.searchParams.get("refresh") === "1";
    const repairMissingContactCache =
      request.nextUrl.searchParams.get("repairMissingContactCache") === "1";
    const groups = await getXeroContactGroups({
      refreshFromXero,
      repairMissingContactCache,
    });
    const lastRefreshedAt = await getXeroContactGroupCacheLastRefreshedAt();
    return NextResponse.json({
      groups,
      refreshed: refreshFromXero,
      lastRefreshedAt,
    });
  } catch (error) {
    const xeroError = getXeroApiErrorInfo(error, "Failed to fetch contact groups");
    if (!xeroError.handled) {
      logger.error(
        { err: error, xeroDiagnosticMessage: xeroError.diagnosticMessage },
        "Failed to fetch Xero contact groups"
      );
    }
    return NextResponse.json({ error: xeroError.clientMessage }, { status: xeroError.status });
  }
}
