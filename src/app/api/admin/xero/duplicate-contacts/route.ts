import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { findDuplicateContacts } from "@/lib/xero-duplicate-contacts";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/duplicate-contacts
 * Scans Xero contacts for duplicate emails and returns grouped results
 * with invoice counts and deep links for manual merging in Xero UI.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const result = await findDuplicateContacts();
    return NextResponse.json(result);
  } catch (error) {
    const xeroError = getXeroApiErrorInfo(error, "Duplicate scan failed");
    if (!xeroError.handled) {
      logger.error(
        { err: error, xeroDiagnosticMessage: xeroError.diagnosticMessage },
        "Failed to scan Xero contacts for duplicates"
      );
    }
    return NextResponse.json({ error: xeroError.clientMessage }, { status: xeroError.status });
  }
}
