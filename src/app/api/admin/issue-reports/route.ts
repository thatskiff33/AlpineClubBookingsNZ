import { NextRequest, NextResponse } from "next/server";
import type { IssueReportOrigin } from "@prisma/client";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  classifyIssueReportScreenshot,
  viewerIsFullAdmin,
} from "@/lib/issue-report-screenshot-access";

const querySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "ALL"]).optional().default("OPEN"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

/**
 * `viewerFullAdmin` is REQUIRED. The list is a read path like any other, so it
 * takes #2703's gate too: it must never announce pixels the caller cannot open,
 * and it must announce a withheld screenshot the same way the detail route
 * does, or the two disagree about what the officer is looking at.
 *
 * This route selects no blob and never has, so there are no pixels here to
 * leak. What it decides is the FLAG.
 */
function summarizeReport(report: {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  description: string;
  screenshotCapturedAt: Date | null;
  screenshotExpiresAt: Date | null;
  screenshotDeletedAt: Date | null;
  browserInfoExpiresAt: Date | null;
  browserInfoDeletedAt: Date | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  resolutionNote: string | null;
  screenshotOrigin: IssueReportOrigin | null;
  createdAt: Date;
  updatedAt: Date;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}, viewerFullAdmin: boolean) {
  const access = classifyIssueReportScreenshot({
    // The list's own long-standing reading of "retained": it never selects the
    // blob, so it works from the capture and deletion stamps.
    retained: Boolean(report.screenshotCapturedAt && !report.screenshotDeletedAt),
    screenshotOrigin: report.screenshotOrigin,
    screenshotCapturedAt: report.screenshotCapturedAt,
    screenshotDeletedAt: report.screenshotDeletedAt,
    screenshotDeleteReason: null,
    viewerIsFullAdmin: viewerFullAdmin,
  });

  return {
    id: report.id,
    pageUrl: report.pageUrl,
    pageTitle: report.pageTitle,
    description: report.description,
    screenshot: {
      capturedAt: report.screenshotCapturedAt,
      expiresAt: report.screenshotExpiresAt,
      deletedAt: report.screenshotDeletedAt,
      retained: access.retained,
      withheld: access.withheld,
    },
    browserInfo: {
      expiresAt: report.browserInfoExpiresAt,
      deletedAt: report.browserInfoDeletedAt,
      retained: Boolean(report.browserInfoExpiresAt && !report.browserInfoDeletedAt),
    },
    resolvedAt: report.resolvedAt,
    resolvedById: report.resolvedById,
    resolutionNote: report.resolutionNote,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    member: report.member,
  };
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return admin.response;
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  const where =
    status === "ALL"
      ? {}
      : status === "RESOLVED"
        ? { resolvedAt: { not: null } }
        : { resolvedAt: null };

  try {
    const [reports, total] = await Promise.all([
      prisma.issueReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          pageUrl: true,
          pageTitle: true,
          description: true,
          screenshotOrigin: true,
          screenshotCapturedAt: true,
          screenshotExpiresAt: true,
          screenshotDeletedAt: true,
          browserInfoExpiresAt: true,
          browserInfoDeletedAt: true,
          resolvedAt: true,
          resolvedById: true,
          resolutionNote: true,
          createdAt: true,
          updatedAt: true,
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      }),
      prisma.issueReport.count({ where }),
    ]);

    logAudit({
      action: "issue_report.admin_listed",
      memberId: admin.session.user.id,
      details: JSON.stringify({ status, page, pageSize }),
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
      category: "privacy",
      outcome: "success",
    });

    return NextResponse.json({
      reports: reports.map((report) =>
        summarizeReport(report, viewerIsFullAdmin(admin.session.user))
      ),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    logger.error({ err }, "Failed to list issue reports");
    return NextResponse.json({ error: "Failed to load issue reports" }, { status: 500 });
  }
}
