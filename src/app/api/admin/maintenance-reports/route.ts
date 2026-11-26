import { NextRequest, NextResponse } from "next/server";

import { maintenanceReportListQuerySchema } from "@/lib/admin-lodge-schemas/maintenance";
import { ADMIN_MAINTENANCE_REPORT_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/lodge-maintenance";
import logger from "@/lib/logger";
import {
  MAINTENANCE_REPORT_LIST_SELECT,
  mapMaintenanceReportForList,
} from "@/lib/maintenance-report-admin";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { adminListPage, adminQueueCreatedOrder } from "@/lib/admin-list-page";
import { connectionJson } from "@/lib/mcp-connection-request";

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

// The query schema lives in admin-lodge-schemas/maintenance.ts so the AI app
// action `list_maintenance_reports` offers the same filters (ALP-722).

export async function GET(request: NextRequest) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!admin.ok) return admin.response;

  const parsed = maintenanceReportListQuerySchema.safeParse(
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
    // A connection is sent no reporter contact or member email (ALP-722).
    return connectionJson(
      request,
      {
        reports: rows.map((row) => mapMaintenanceReportForList(row, now)),
        lodges,
        ...adminListPage({ page, pageSize, total }),
        outstandingCount: openCount,
      },
      ADMIN_MAINTENANCE_REPORT_LIST_CONNECTION_SHAPE,
    );
  } catch (err) {
    logger.error({ err }, "Failed to list maintenance reports");
    return NextResponse.json(
      { error: "Failed to load maintenance reports" },
      { status: 500 },
    );
  }
}
