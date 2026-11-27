import { NextResponse } from "next/server";
import type { z } from "zod";
import { xeroSyncContactsBodySchema } from "@/lib/admin-xero-sync-schemas";
import { parseJsonRequestBody } from "@/lib/api-json";
import { XERO_SYNC_CONTACTS_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-sync";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { syncContactsFromXero, xeroContactChangedFields } from "@/lib/xero-bulk-contact-sync";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

/**
 * POST /api/admin/xero/sync-contacts
 * Triggers an incremental contact sync from Xero by default.
 * Accepts optional JSON repair flags for explicit full rescans/backfills.
 * Matches Xero contacts to local members by email and links xeroContactId.
 * Returns a detailed SyncReport with categorized results.
 */
export async function POST(request?: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let options: z.infer<typeof xeroSyncContactsBodySchema> = {};
  const contentType = request?.headers.get("content-type") ?? "";
  // `request` is optional only for callers that invoke POST() bare; with none the
  // content type is empty and this branch never ran, so the `request &&` changes nothing.
  if (request && contentType.includes("application/json")) {
    const jsonBody = await parseJsonRequestBody(request, {
      error: "Invalid JSON",
    });
    if (!jsonBody.ok) return jsonBody.response;
    const body = jsonBody.body;

    const parsed = xeroSyncContactsBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 422 }
      );
    }
    options = parsed.data;
  }

  try {
    const report = await syncContactsFromXero({
      ...options,
      auditActorMemberId: session.user.id,
      auditSource: "admin-xero-sync-contacts",
    });
    // A bare `POST()` (a caller with no request) is never a connection.
    if (!request || !arrivesAsMcpConnection(request)) return NextResponse.json({ syncReport: report });
    // An AI app is told each update's changed fields, never the screen's
    // "Phone set to …" lines, which carry the member's new details (ALP-721).
    const updated = report.updated.map((row) => ({ ...row, changedFields: xeroContactChangedFields(row.changes) }));
    return connectionJson(request, { syncReport: { ...report, updated } }, XERO_SYNC_CONTACTS_CONNECTION_SHAPE);
  } catch (error) {
    const xeroError = getXeroApiErrorInfo(error, "Contact sync failed");
    if (!xeroError.handled) {
      logger.error(
        { err: error, xeroDiagnosticMessage: xeroError.diagnosticMessage },
        "Failed to sync contacts from Xero"
      );
    }
    return NextResponse.json({ error: xeroError.clientMessage }, { status: xeroError.status });
  }
}
