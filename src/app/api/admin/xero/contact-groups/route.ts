import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getXeroContactGroups } from "@/lib/xero";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/contact-groups
 * Returns cached Xero contact groups by default.
 * Use `?refresh=1` for an operator-triggered refresh from Xero.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const refreshFromXero = request.nextUrl.searchParams.get("refresh") === "1";
    const repairMissingContactCache =
      request.nextUrl.searchParams.get("repairMissingContactCache") === "1";
    const groups = await getXeroContactGroups({
      refreshFromXero,
      repairMissingContactCache,
    });
    return NextResponse.json({ groups, refreshed: refreshFromXero });
  } catch (error) {
    const xeroError = getXeroApiErrorInfo(error, "Failed to fetch contact groups");
    if (!xeroError.handled) {
      logger.error({ err: error }, "Failed to fetch Xero contact groups");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
