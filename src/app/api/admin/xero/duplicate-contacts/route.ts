import { NextRequest, NextResponse } from "next/server";
import { XERO_DUPLICATE_CONTACTS_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-contacts";
import { connectionJson } from "@/lib/mcp-connection-request";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";
import { findDuplicateContacts } from "@/lib/xero-duplicate-contacts";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/duplicate-contacts
 * Scans Xero contacts for duplicate emails and returns grouped results
 * with invoice counts and deep links for manual merging in Xero UI.
 */
// One scan reads every Xero contact and the invoices of each duplicate, so a
// loop (an AI app's included, ALP-721) could spend the club's daily Xero
// allowance, which stops every other Xero call until the next day.
const limiter = { id: "xero-duplicate-contacts-scan", limit: 10, windowSeconds: 60 * 60 };

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const limit = await checkRateLimit(limiter, guard.session.user.id);
  if (!limit.success) return rateLimitedResponse(limit);
  try {
    const result = await findDuplicateContacts();
    return connectionJson(request, result, XERO_DUPLICATE_CONTACTS_CONNECTION_SHAPE);
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
