import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import {
  retryXeroSyncOperation,
  XeroOperationRetryError,
} from "@/lib/xero-operation-retry";

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
    const result = await retryXeroSyncOperation(id, {
      createdByMemberId: session.user.id,
    });

    await logAudit({
      action: "XERO_OPERATION_RETRY",
      memberId: session.user.id,
      targetId: id,
      details: result.message,
    });

    return NextResponse.json({ ok: true, message: result.message });
  } catch (error) {
    if (error instanceof XeroOperationRetryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const xeroError = getXeroApiErrorInfo(error, "Failed to retry Xero operation");
    logger.error({ err: error, operationId: id }, "Failed to retry Xero operation");

    return NextResponse.json(
      { error: xeroError.message },
      { status: xeroError.handled ? xeroError.status : 500 }
    );
  }
}
