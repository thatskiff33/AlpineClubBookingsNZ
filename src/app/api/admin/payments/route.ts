import { NextRequest, NextResponse } from "next/server";
import {
  adminPaymentsQuerySchema,
  listAdminPayments,
} from "@/lib/admin-payments-service";
import { ADMIN_PAYMENTS_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-money";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/payments
 * List payments with filtering, sorting, pagination, and summary totals.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const parsed = adminPaymentsQuerySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    source: searchParams.get("source") ?? undefined,
    xeroState: searchParams.get("xeroState") ?? undefined,
    settlement: searchParams.get("settlement") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    lastUpdatedFrom: searchParams.get("lastUpdatedFrom") ?? undefined,
    lastUpdatedTo: searchParams.get("lastUpdatedTo") ?? undefined,
    checkInFrom: searchParams.get("checkInFrom") ?? undefined,
    checkInTo: searchParams.get("checkInTo") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    amountExact: searchParams.get("amountExact") ?? undefined,
    amountMin: searchParams.get("amountMin") ?? undefined,
    amountMax: searchParams.get("amountMax") ?? undefined,
    sortBy: searchParams.get("sortBy") ?? undefined,
    sortDir: searchParams.get("sortDir") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await listAdminPayments(parsed.data);
  return connectionJson(request, result.body, ADMIN_PAYMENTS_CONNECTION_SHAPE, result.init);
}
