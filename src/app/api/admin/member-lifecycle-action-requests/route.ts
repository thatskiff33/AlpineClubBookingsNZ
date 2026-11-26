import { MemberLifecycleActionRequestStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import {
  getAdminMemberLifecycleRequests,
  type AdminMemberLifecycleActionStatusFilter,
} from "@/lib/member-lifecycle-actions";
import logger from "@/lib/logger";
import { memberLifecycleRequestListQuerySchema } from "@/lib/admin-membership-api/requests";
import { MEMBER_LIFECYCLE_REQUEST_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";

// PENDING is the deletion-requests page's word for REQUESTED (#1938).
function mapStatusFilter(
  status: z.infer<typeof memberLifecycleRequestListQuerySchema>["status"],
): AdminMemberLifecycleActionStatusFilter {
  return status === "PENDING"
    ? MemberLifecycleActionRequestStatus.REQUESTED
    : status;
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = memberLifecycleRequestListQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const data = await getAdminMemberLifecycleRequests({
      action: parsed.data.action,
      status: mapStatusFilter(parsed.data.status),
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });

    // The list envelope (page, pageSize, total, totalPages) is spread as the
    // service built it, so a key added to AdminListPage reaches the client.
    const { requests, pendingCount, ...envelope } = data;
    return connectionJson(
      request,
      {
        data: requests,
        requests,
        pendingCount,
        ...envelope,
      },
      MEMBER_LIFECYCLE_REQUEST_LIST_CONNECTION_SHAPE,
    );
  } catch (err) {
    logger.error({ err }, "Failed to load member lifecycle action requests");
    return NextResponse.json(
      { error: "Failed to load member lifecycle action requests" },
      { status: 500 },
    );
  }
}
