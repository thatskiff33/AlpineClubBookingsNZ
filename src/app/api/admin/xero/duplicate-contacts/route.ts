import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { findDuplicateContacts } from "@/lib/xero";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/duplicate-contacts
 * Scans Xero contacts for duplicate emails and returns grouped results
 * with invoice counts and deep links for manual merging in Xero UI.
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
    const result = await findDuplicateContacts();
    return NextResponse.json(result);
  } catch (error) {
    const xeroError = getXeroApiErrorInfo(error, "Duplicate scan failed");
    if (!xeroError.handled) {
      logger.error({ err: error }, "Failed to scan Xero contacts for duplicates");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
