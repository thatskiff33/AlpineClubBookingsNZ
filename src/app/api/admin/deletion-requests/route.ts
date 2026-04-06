/**
 * F-COMP-04: Admin — List Deletion Requests
 * GET /api/admin/deletion-requests
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") || "PENDING";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = 20;

  try {
    const where =
      status === "ALL"
        ? {}
        : { status: status as "PENDING" | "APPROVED" | "REJECTED" };

    const [requests, total] = await Promise.all([
      prisma.deletionRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
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

    return NextResponse.json({
      requests: requests.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        adminNote: r.adminNote,
        reviewedBy: r.reviewedBy,
        reviewedAt: r.reviewedAt,
        createdAt: r.createdAt,
        member: r.member,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    logger.error({ err }, "Failed to list deletion requests");
    return NextResponse.json({ error: "Failed to load deletion requests" }, { status: 500 });
  }
}
