import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit-http";
import logger from "@/lib/logger";
import {
  MAINTENANCE_REPORT_DETAIL_SELECT,
  mapMaintenanceReportForDetail,
} from "@/lib/maintenance-report-admin";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

/**
 * One maintenance report: read it (including the photo), move its status, or
 * delete its photo early (#2780). Lodge Operations — `view` for GET, `edit` for
 * PATCH, resolved from the path by `getAdminRouteRequirement`.
 */

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("setStatus"),
    status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]),
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({
    action: z.literal("deletePhoto"),
    reason: z.string().trim().max(300).optional(),
  }),
]);

async function loadDetail(id: string) {
  return prisma.maintenanceReport.findUnique({
    where: { id },
    select: MAINTENANCE_REPORT_DETAIL_SELECT,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!admin.ok) return admin.response;

  const { id } = await params;
  const report = await loadDetail(id);
  if (!report) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  const mapped = mapMaintenanceReportForDetail(report);

  // THIS read is audited, and the list read is not, because this is the one that
  // hands over the photograph. `photoOpened` records whether bytes actually left
  // the server, so an expired-but-not-yet-swept row reads as false rather than
  // implying an officer saw something they did not.
  logAudit({
    action: "maintenance.report.viewed",
    category: "lodge",
    memberId: admin.session.user.id,
    targetId: id,
    entityType: "MaintenanceReport",
    entityId: id,
    details: JSON.stringify({ photoOpened: Boolean(mapped.photo.dataUrl) }),
    ipAddress: getClientIp(request),
    outcome: "success",
  });

  return NextResponse.json({ report: mapped });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!admin.ok) return admin.response;

  const { id } = await params;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  try {
    const existing = await prisma.maintenanceReport.findUnique({
      where: { id },
      select: { id: true, status: true, photoDataUrl: true, photoDeletedAt: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    const now = new Date();

    if (parsed.data.action === "setStatus") {
      const resolving = parsed.data.status === "RESOLVED";
      await prisma.maintenanceReport.update({
        where: { id },
        data: {
          status: parsed.data.status,
          // resolvedAt/resolvedById are cleared when a report is reopened, so a
          // reopened row never keeps a resolution date that no longer holds.
          resolvedAt: resolving ? now : null,
          resolvedById: resolving ? admin.session.user.id : null,
          // The note is kept only while the report IS resolved, for the same
          // reason: a note saying "fixed the pump" on an OPEN report is a lie the
          // queue would then display.
          resolutionNote: resolving ? parsed.data.note || null : null,
        },
      });

      logAudit({
        action: "maintenance.report.status_changed",
        category: "lodge",
        memberId: admin.session.user.id,
        targetId: id,
        entityType: "MaintenanceReport",
        entityId: id,
        details: JSON.stringify({
          from: existing.status,
          to: parsed.data.status,
          hasNote: Boolean(parsed.data.note),
        }),
        ipAddress: getClientIp(request),
        outcome: "success",
      });
    } else {
      // Early deletion, ahead of the retention sweep. `updateMany` with the
      // photo-still-present guard so two officers pressing Delete at once produce
      // one deletion event and one no-op rather than two events claiming to have
      // deleted the same bytes.
      const claimed = await prisma.maintenanceReport.updateMany({
        where: { id, photoDataUrl: { not: null } },
        data: {
          photoDataUrl: null,
          photoContentType: null,
          photoDeletedAt: now,
          photoDeletedById: admin.session.user.id,
          photoDeleteReason: parsed.data.reason || "Deleted by admin",
        },
      });

      if (claimed.count > 0) {
        logAudit({
          action: "maintenance.report.photo_deleted",
          category: "lodge",
          memberId: admin.session.user.id,
          targetId: id,
          entityType: "MaintenanceReport",
          entityId: id,
          details: parsed.data.reason || "Deleted by admin",
          ipAddress: getClientIp(request),
          severity: "important",
          outcome: "success",
        });
      }
    }

    const report = await loadDetail(id);
    return NextResponse.json({
      report: report ? mapMaintenanceReportForDetail(report) : null,
    });
  } catch (err) {
    logger.error({ err, reportId: id }, "Failed to update maintenance report");
    return NextResponse.json({ error: "Failed to update report" }, { status: 500 });
  }
}
