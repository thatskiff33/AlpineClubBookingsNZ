import { MembershipCancellationRequestStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getAdminMembershipCancellationRequests,
  type AdminCancellationStatusFilter,
} from "@/lib/membership-cancellation-admin";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import logger from "@/lib/logger";
import {
  adminListPageQueryFields,
} from "@/lib/admin-list-page";
import { requireAdmin } from "@/lib/session-guards";

const querySchema = z.object({
  status: z
    .enum([
      MembershipCancellationRequestStatus.REQUESTED,
      MembershipCancellationRequestStatus.APPROVED,
      MembershipCancellationRequestStatus.REJECTED,
      MembershipCancellationRequestStatus.WITHDRAWN,
      MembershipCancellationRequestStatus.COMPLETED,
      "ALL",
    ])
    .optional()
    .default(MembershipCancellationRequestStatus.REQUESTED),
  ...adminListPageQueryFields,
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(
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

    return NextResponse.json({
      data: data.requests,
      requests: data.requests,
      pendingCount: data.pendingCount,
      total: data.total,
      page: data.page,
      pageSize: data.pageSize,
      totalPages: data.totalPages,
    });
  } catch (err) {
    logger.error({ err }, "Failed to load membership cancellation requests");
    return NextResponse.json(
      { error: "Failed to load membership cancellation requests" },
      { status: 500 },
    );
  }
}
