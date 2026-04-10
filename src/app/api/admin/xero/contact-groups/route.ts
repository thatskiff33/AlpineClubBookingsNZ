import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getXeroContactGroups } from "@/lib/xero";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/contact-groups
 * Returns available Xero contact groups for the import UI.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const groups = await getXeroContactGroups();
    return NextResponse.json({ groups });
  } catch (error) {
    const xeroError = getXeroApiErrorInfo(error, "Failed to fetch contact groups");
    if (!xeroError.handled) {
      logger.error({ err: error }, "Failed to fetch Xero contact groups");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
