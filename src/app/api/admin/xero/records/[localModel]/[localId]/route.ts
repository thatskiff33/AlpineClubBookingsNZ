import { NextRequest, NextResponse } from "next/server";
import { xeroRecordActivityParamsSchema } from "@/lib/admin-xero-sync-schemas";
import { XERO_RECORD_ACTIVITY_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-sync";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { getXeroRecordActivity } from "@/lib/xero-record-activity";
import { clubFormatValues } from "@/lib/club-format-server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ localModel: string; localId: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsedParams = xeroRecordActivityParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid Xero activity scope" }, { status: 400 });
  }
  const { localModel, localId } = parsedParams.data;

  // The club's format (#3565), resolved once per request.
  const format = await clubFormatValues();

  try {
    const data = await getXeroRecordActivity(localModel, localId, format, 25);
    if (!data) {
      return NextResponse.json({ error: "Record not found" }, { status: 404 });
    }

    return connectionJson(request, { data }, XERO_RECORD_ACTIVITY_CONNECTION_SHAPE);
  } catch (err) {
    logger.error({ err, localModel, localId }, "Failed to load record-scoped Xero activity");
    return NextResponse.json(
      { error: "Failed to load record-scoped Xero activity" },
      { status: 500 }
    );
  }
}
