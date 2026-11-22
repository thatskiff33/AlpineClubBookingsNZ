import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import logger from "@/lib/logger";
import {
  MAINTENANCE_REPORT_LIST_SELECT,
  mapMaintenanceReportForList,
} from "@/lib/maintenance-report-admin";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  adminListPage,
  adminListPageQueryFields,
  adminQueueCreatedOrder,
} from "@/lib/admin-list-page";

/**
 * The maintenance queue's list read (#2780). Lodge Operations `view`.
 *
 * Deliberately no audit row on this GET. The comparable issue-report DETAIL read
 * writes one because it discloses a member's screenshot and browser string; a
 * page of maintenance summaries discloses a fault list, which is the operational
 * information the officer is employed to look at. Writing an audit row per list
 * render would bury the events that matter (a photo opened, a photo deleted) under
 * one row per page refresh. The detail read, which does hand over the photo, does
 * write one.
 */

const querySchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "ALL"]).optional().default("OPEN"),
  lodgeId: z.string().trim().max(64).optional(),
  source: z.enum(["MEMBER_PORTAL", "LODGE_QR", "ALL"]).optional().default("ALL"),
  ...adminListPageQueryFields,
});

export async function GET(request: NextRequest) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!admin.ok) return admin.response;

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }

  const { status, lodgeId, source, page, pageSize } = parsed.data;

  const where = {
    ...(status === "ALL" ? {} : { status }),
    ...(source === "ALL" ? {} : { source }),
    ...(lodgeId ? { lodgeId } : {}),
  };

  // INV-OPS-020: the Open filter is the work still waiting, so it reads oldest
  // first and the longest-waiting fault is on page 1; the other filters stay
  // newest first. `id` breaks createdAt ties so a row never repeats or vanishes
  // between pages.
  const direction = adminQueueCreatedOrder(status === "OPEN");

  try {
    const [total, rows, lodges, openCount] = await Promise.all([
      prisma.maintenanceReport.count({ where }),
      prisma.maintenanceReport.findMany({
        where,
        orderBy: [{ createdAt: direction }, { id: direction }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: MAINTENANCE_REPORT_LIST_SELECT,
      }),
      prisma.lodge.findMany({
        where: { active: true },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        select: { id: true, name: true },
      }),
      prisma.maintenanceReport.count({ where: { status: { not: "RESOLVED" } } }),
    ]);

    const now = new Date();
    return NextResponse.json({
      reports: rows.map((row) => mapMaintenanceReportForList(row, now)),
      lodges,
      ...adminListPage({ page, pageSize, total }),
      outstandingCount: openCount,
    });
  } catch (err) {
    logger.error({ err }, "Failed to list maintenance reports");
    return NextResponse.json(
      { error: "Failed to load maintenance reports" },
      { status: 500 },
    );
  }
}
