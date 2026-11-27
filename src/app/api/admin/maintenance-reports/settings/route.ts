import { NextRequest, NextResponse } from "next/server";

import {
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
} from "@/config/club-settings-defaults";
import { maintenanceReportSettingsBodySchema } from "@/lib/admin-lodge-schemas/maintenance";
import { logAudit } from "@/lib/audit";
import {
  ADMIN_MAINTENANCE_SETTINGS_CONNECTION_SHAPE,
  ADMIN_MAINTENANCE_SETTINGS_SAVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/lodge-maintenance";
import { connectionJson } from "@/lib/mcp-connection-request";
import { getClientIp } from "@/lib/rate-limit-http";
import logger from "@/lib/logger";
import {
  MAINTENANCE_REPORT_SETTINGS_ID,
  loadMaintenanceReportSettings,
  normalizeMaintenanceReportSettings,
} from "@/lib/maintenance-report-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

/**
 * The club-wide maintenance-report policy section (#2780). Lodge Operations
 * `view`/`edit`.
 *
 * `anonymousReportsEnabled` IS THE SWITCH THAT OPENS AN UNAUTHENTICATED ENDPOINT,
 * so writing it is audited at `severity: "important"` with the old and new value,
 * separately from the rest of the section. An operator asking "when did the public
 * form go live, and who turned it on" gets an answer; an operator asking the same
 * about the photo retention window gets it from the ordinary settings row.
 *
 * The retention window is VALIDATED here and CLAMPED on the read path — the two
 * are deliberately different. A write is a person typing a number and can be
 * refused with a message; a read is a submit in progress and must not throw.
 */

// The body schema (every field, each time; the retention window validated
// here and clamped on the read path) lives in
// admin-lodge-schemas/maintenance.ts so the AI app action
// `update_maintenance_report_settings` offers the same fields (ALP-722).

export async function GET(request: Request) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!admin.ok) return admin.response;

  const settings = await loadMaintenanceReportSettings();
  return connectionJson(
    request,
    {
      settings,
      limits: {
        photoRetentionDaysMin: MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
        photoRetentionDaysMax: MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
      },
    },
    ADMIN_MAINTENANCE_SETTINGS_CONNECTION_SHAPE,
  );
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!admin.ok) return admin.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = maintenanceReportSettingsBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Keep the photo retention window between ${MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN} and ${MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX} days.`,
      },
      { status: 400 },
    );
  }

  try {
    const before = await loadMaintenanceReportSettings();

    const saved = await prisma.maintenanceReportSettings.upsert({
      where: { id: MAINTENANCE_REPORT_SETTINGS_ID },
      // Lazily created, like every other settings singleton here: a club that has
      // never opened this section has no row and reads the schema defaults.
      create: {
        id: MAINTENANCE_REPORT_SETTINGS_ID,
        ...parsed.data,
        updatedByMemberId: admin.session.user.id,
      },
      update: { ...parsed.data, updatedByMemberId: admin.session.user.id },
    });

    const ipAddress = getClientIp(request);

    if (before.anonymousReportsEnabled !== parsed.data.anonymousReportsEnabled) {
      logAudit({
        action: parsed.data.anonymousReportsEnabled
          ? "maintenance.anonymous_reports.enabled"
          : "maintenance.anonymous_reports.disabled",
        category: "lodge",
        memberId: admin.session.user.id,
        entityType: "MaintenanceReportSettings",
        entityId: MAINTENANCE_REPORT_SETTINGS_ID,
        details: JSON.stringify({
          from: before.anonymousReportsEnabled,
          to: parsed.data.anonymousReportsEnabled,
        }),
        ipAddress,
        // This is the one line in the section that changes who can reach the
        // application, so it is not an ordinary settings edit.
        severity: "important",
        outcome: "success",
      });
    }

    logAudit({
      action: "maintenance.settings.updated",
      category: "lodge",
      memberId: admin.session.user.id,
      entityType: "MaintenanceReportSettings",
      entityId: MAINTENANCE_REPORT_SETTINGS_ID,
      details: JSON.stringify({
        photosEnabled: parsed.data.photosEnabled,
        anonymousPhotosEnabled: parsed.data.anonymousPhotosEnabled,
        photoRetentionDays: parsed.data.photoRetentionDays,
        anonymousContactPrompt: parsed.data.anonymousContactPrompt,
      }),
      ipAddress,
      outcome: "success",
    });

    return connectionJson(
      request,
      { settings: normalizeMaintenanceReportSettings(saved) },
      ADMIN_MAINTENANCE_SETTINGS_SAVED_CONNECTION_SHAPE,
    );
  } catch (err) {
    logger.error({ err }, "Failed to save maintenance report settings");
    return NextResponse.json(
      { error: "Failed to save these settings" },
      { status: 500 },
    );
  }
}
