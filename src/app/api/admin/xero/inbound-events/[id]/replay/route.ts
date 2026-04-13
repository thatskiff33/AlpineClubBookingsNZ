import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import {
  replayStoredXeroInboundEvent,
  XeroInboundReplayError,
} from "@/lib/xero-inbound-reconciliation";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  try {
    const replay = await replayStoredXeroInboundEvent(id);

    await logAudit({
      action: "XERO_INBOUND_EVENT_REPLAY",
      memberId: session.user.id,
      targetId: id,
      details: `status=${replay.event.status}`,
    });

    return NextResponse.json({
      ok: true,
      message: "Xero inbound event replayed.",
      replay,
    });
  } catch (error) {
    if (error instanceof XeroInboundReplayError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const xeroError = getXeroApiErrorInfo(
      error,
      "Failed to replay Xero inbound event"
    );
    logger.error({ err: error, inboundEventId: id }, "Failed to replay Xero inbound event");

    return NextResponse.json(
      { error: xeroError.message },
      { status: xeroError.handled ? xeroError.status : 500 }
    );
  }
}
