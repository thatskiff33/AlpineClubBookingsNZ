import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { XERO_INBOUND_EVENT_REPLAYED_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-sync";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import {
  replayStoredXeroInboundEvent,
  XeroInboundReplayError,
} from "@/lib/xero-inbound-reconciliation";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  try {
    const replay = await replayStoredXeroInboundEvent(id);

    await logAudit({
      action: "XERO_INBOUND_EVENT_REPLAY",
      category: "xero",
      memberId: session.user.id,
      targetId: id,
      entityType: "XeroInboundEvent",
      entityId: id,
      details: `status=${replay.event.status}`,
    });

    return connectionJson(request, {
      ok: true,
      message: "Xero inbound event replayed.",
      replay,
    }, XERO_INBOUND_EVENT_REPLAYED_CONNECTION_SHAPE);
  } catch (error) {
    if (error instanceof XeroInboundReplayError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const xeroError = getXeroApiErrorInfo(
      error,
      "Failed to replay Xero inbound event"
    );
    logger.error(
      { err: error, inboundEventId: id, xeroDiagnosticMessage: xeroError.diagnosticMessage },
      "Failed to replay Xero inbound event"
    );

    return NextResponse.json(
      { error: xeroError.clientMessage },
      { status: xeroError.handled ? xeroError.status : 500 }
    );
  }
}
