/**
 * F-COMP-04: Admin — List Deletion Requests
 * GET /api/admin/deletion-requests
 */
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { OPEN_DELETION_REQUEST_STATUSES } from "@/lib/deletion-request-decision";
import {
  adminListPage,
  adminListPageQueryFields,
  adminQueueCreatedOrder,
} from "@/lib/admin-list-page";
import { z } from "zod";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  ...adminListPageQueryFields,
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;

  try {
    // The PENDING filter is the admin's "needs a decision" queue. A request
    // that is mid-approval must stay in it: its cleanup has already begun and
    // an admin who cannot see it cannot resume it.
    const where: Prisma.DeletionRequestWhereInput =
      status === "ALL"
        ? {}
        : status === "PENDING"
          ? { status: { in: OPEN_DELETION_REQUEST_STATUSES } }
          : { status };

    const [requests, total] = await Promise.all([
      prisma.deletionRequest.findMany({
        where,
        // INV-OPS-017: the pending queue reads oldest first, so the request
        // that has waited longest is on page 1; id breaks createdAt ties.
        orderBy: [
          { createdAt: adminQueueCreatedOrder(status === "PENDING") },
          { id: adminQueueCreatedOrder(status === "PENDING") },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
              active: true,
            },
          },
        },
      }),
      prisma.deletionRequest.count({ where }),
    ]);

    const data = requests.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      adminNote: r.adminNote,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt,
      createdAt: r.createdAt,
      member: r.member,
    }));

    return NextResponse.json({
      data,
      requests: data,
      ...adminListPage({ page, pageSize, total }),
    });
  } catch (err) {
    logger.error({ err }, "Failed to list deletion requests");
    return NextResponse.json({ error: "Failed to load deletion requests" }, { status: 500 });
  }
}
