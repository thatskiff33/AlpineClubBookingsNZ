import { NextRequest, NextResponse } from "next/server";

import { logAudit } from "@/lib/audit";
import { clubFormatValues } from "@/lib/club-format-server";
import logger from "@/lib/logger";
import { findLatestOrganisationContactDetailsOperation } from "@/lib/organisation-xero-contact-details";
import { requireAdmin } from "@/lib/session-guards";
import { kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import { retryXeroSyncOperation, XeroOperationRetryError } from "@/lib/xero-operation-retry";

/**
 * POST /api/admin/organisations/[id]/contact/retry — #5245.
 *
 * Sends a school's contact details to Xero again after the last send failed.
 * Only this school's LATEST contact-details row, and only when it FAILED: an
 * older failure has been superseded by a later correction, which is the one
 * that speaks for the school. The requeue itself is the Xero operations
 * screen's (`retryXeroSyncOperation`), so its refusals — resolved in Xero,
 * marked not replayable, already queued — answer here too.
 *
 * Same gate as the edit: the bookings area at edit, inferred from the path.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  const latest = await findLatestOrganisationContactDetailsOperation(id);
  if (!latest || latest.status !== "FAILED") {
    return NextResponse.json(
      { error: "There is no failed Xero update for this school to retry." },
      { status: 409 },
    );
  }

  try {
    const result = await retryXeroSyncOperation(latest.id, await clubFormatValues(), {
      createdByMemberId: session.user.id,
    });
    logAudit({
      action: "XERO_OPERATION_RETRY",
      category: "xero",
      memberId: session.user.id,
      targetId: latest.id,
      entityType: "XeroSyncOperation",
      entityId: latest.id,
      details: result.message,
    });
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((error) => {
      logger.error(
        { err: error, organisationId: id, operationId: latest.id },
        "Failed to kick the retried Xero update for a school's contact details",
      );
    });
    return NextResponse.json({ ok: true, message: result.message }, { status: 202 });
  } catch (error) {
    if (error instanceof XeroOperationRetryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
