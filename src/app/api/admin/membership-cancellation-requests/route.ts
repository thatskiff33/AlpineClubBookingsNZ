import { NextRequest, NextResponse } from "next/server";
import {
  getAdminMembershipCancellationRequests,
  type AdminCancellationStatusFilter,
} from "@/lib/membership-cancellation-admin";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import logger from "@/lib/logger";
import { membershipCancellationRequestListQuerySchema } from "@/lib/admin-membership-api/requests";
import { MEMBERSHIP_CANCELLATION_REQUEST_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = membershipCancellationRequestListQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // #2402: the queue's unpaid-invoice check is a live, metered Xero read, and
    // its only use is to warn somebody before they press Approve. This is the
    // SAME requirement the review endpoint enforces (`membership: edit`, see
    // `[requestId]/participants/[participantId]/route.ts`), read off the
    // DB-verified permission matrix `requireAdmin` just resolved rather than off
    // the JWT-carried snapshot — so "will the check run?" and "would the
    // approval be accepted?" cannot answer differently. Viewing the queue itself
    // still only needs admin access, so a view-only admin loses no page, only
    // the check.
    //
    // Inside the try so a throw here is logged and answered like any other
    // failure of this route, rather than escaping as a bare framework 500 with
    // nothing in the log to explain it.
    const viewerCanApprove = hasAdminAreaAccess(guard.session.user, {
      area: "membership",
      level: "edit",
    });

    const data = await getAdminMembershipCancellationRequests({
      status: parsed.data.status as AdminCancellationStatusFilter,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      viewerCanApprove,
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
      MEMBERSHIP_CANCELLATION_REQUEST_LIST_CONNECTION_SHAPE,
    );
  } catch (err) {
    logger.error({ err }, "Failed to load membership cancellation requests");
    return NextResponse.json(
      { error: "Failed to load membership cancellation requests" },
      { status: 500 },
    );
  }
}
