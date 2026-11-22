import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
} from "@/config/club-settings-defaults";
import { logAudit } from "@/lib/audit";
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

const putSchema = z
  .object({
    anonymousReportsEnabled: z.boolean(),
    photosEnabled: z.boolean(),
    anonymousPhotosEnabled: z.boolean(),
    photoRetentionDays: z
      .number()
      .int()
      .min(MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN)
      .max(MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX),
    anonymousContactPrompt: z.boolean(),
  })
  .strict();

export async function GET() {
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!admin.ok) return admin.response;

  const settings = await loadMaintenanceReportSettings();
  return NextResponse.json({
    settings,
    limits: {
      photoRetentionDaysMin: MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
      photoRetentionDaysMax: MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
    },
  });
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

  const parsed = putSchema.safeParse(body);
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

    return NextResponse.json({
      settings: normalizeMaintenanceReportSettings(saved),
    });
  } catch (err) {
    logger.error({ err }, "Failed to save maintenance report settings");
    return NextResponse.json(
      { error: "Failed to save these settings" },
      { status: 500 },
    );
  }
}
