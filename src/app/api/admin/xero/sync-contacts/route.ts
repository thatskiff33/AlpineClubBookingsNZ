import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { syncContactsFromXero } from "@/lib/xero";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

/**
 * POST /api/admin/xero/sync-contacts
 * Triggers a bulk contact sync from Xero.
 * Matches Xero contacts to local members by email and links xeroContactId.
 * Returns a detailed SyncReport with categorized results.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const report = await syncContactsFromXero();
    return NextResponse.json({ syncReport: report });
  } catch (error) {
    const xeroError = getXeroApiErrorInfo(error, "Contact sync failed");
    if (!xeroError.handled) {
      logger.error({ err: error }, "Failed to sync contacts from Xero");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
