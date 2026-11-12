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
  ADMIN_LIST_DEFAULT_PAGE_SIZE,
  ADMIN_LIST_MAX_PAGE_SIZE,
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
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_LIST_MAX_PAGE_SIZE)
    .optional()
    .default(ADMIN_LIST_DEFAULT_PAGE_SIZE),
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
    logger.error({ err }, "Failed to load member lifecycle action requests");
    return NextResponse.json(
      { error: "Failed to load member lifecycle action requests" },
      { status: 500 },
    );
  }
}
