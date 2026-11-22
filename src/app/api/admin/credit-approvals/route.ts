import { NextRequest, NextResponse } from "next/server";
import { adminCreditApprovalsQuerySchema } from "@/lib/admin-credit-adjustment-schemas";
import { CREDIT_APPROVALS_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-payments";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { getAdminAdjustmentRequests } from "@/lib/member-credit";

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  // Never refuses: an unknown or missing status lists the pending requests.
  const { status } = adminCreditApprovalsQuerySchema.parse({
    status: searchParams.get("status") ?? undefined,
  });

  const requests = await getAdminAdjustmentRequests(status);

  // A connection's answer is an object the projection can read; the browser
  // keeps the bare list it has always had.
  if (arrivesAsMcpConnection(request)) {
    return connectionJson(request, { requests }, CREDIT_APPROVALS_CONNECTION_SHAPE);
  }
  return NextResponse.json(requests);
}
