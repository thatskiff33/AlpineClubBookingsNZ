import {
  MemberLifecycleAction,
  MemberLifecycleActionRequestStatus,
} from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getAdminMemberLifecycleRequests,
  type AdminMemberLifecycleActionStatusFilter,
} from "@/lib/member-lifecycle-actions";
import logger from "@/lib/logger";
import {
  adminListPageQueryFields,
} from "@/lib/admin-list-page";
import { requireAdmin } from "@/lib/session-guards";

const querySchema = z.object({
  // ARCHIVE feeds the membership-cancellations page; DELETE feeds the
  // admin-initiated section on /admin/deletion-requests (#1938). Default stays
  // ARCHIVE for back-compat (pinned by test).
  action: z
    .enum([MemberLifecycleAction.ARCHIVE, MemberLifecycleAction.DELETE])
    .optional()
    .default(MemberLifecycleAction.ARCHIVE),
  // The deletion-requests page filter speaks the self-service vocabulary
  // (PENDING|APPROVED|REJECTED); lifecycle requests use REQUESTED for the
  // pending state. Accept PENDING here and map it to REQUESTED at the boundary
  // (#1938) so `?action=DELETE&status=PENDING` does not 400.
  status: z
    .enum([
      "PENDING",
      MemberLifecycleActionRequestStatus.REQUESTED,
      MemberLifecycleActionRequestStatus.APPROVED,
      MemberLifecycleActionRequestStatus.REJECTED,
      "ALL",
    ])
    .optional()
    .default(MemberLifecycleActionRequestStatus.REQUESTED),
  ...adminListPageQueryFields,
});

function mapStatusFilter(
  status: z.infer<typeof querySchema>["status"],
): AdminMemberLifecycleActionStatusFilter {
  return status === "PENDING"
    ? MemberLifecycleActionRequestStatus.REQUESTED
    : status;
}

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
    const data = await getAdminMemberLifecycleRequests({
      action: parsed.data.action,
      status: mapStatusFilter(parsed.data.status),
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });

    // The list envelope (page, pageSize, total, totalPages) is spread as the
    // service built it, so a key added to AdminListPage reaches the client.
    const { requests, pendingCount, ...envelope } = data;
    return NextResponse.json({
      data: requests,
      requests,
      pendingCount,
      ...envelope,
    });
  } catch (err) {
    logger.error({ err }, "Failed to load member lifecycle action requests");
    return NextResponse.json(
      { error: "Failed to load member lifecycle action requests" },
      { status: 500 },
    );
  }
}
