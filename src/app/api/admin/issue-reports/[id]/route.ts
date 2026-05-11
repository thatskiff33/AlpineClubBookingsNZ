import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("resolve"),
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({
    action: z.literal("reopen"),
  }),
  z.object({
    action: z.literal("deleteScreenshot"),
    reason: z.string().trim().max(300).optional(),
  }),
]);

async function requireAdmin() {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      session: null,
    };
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return { response: inactiveResponse, session: null };
  }

  if (session.user.role !== "ADMIN") {
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      session: null,
    };
  }

  return { response: null, session };
}

function mapReport(report: {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  description: string;
  screenshotDataUrl: string | null;
  screenshotCapturedAt: Date | null;
  screenshotExpiresAt: Date | null;
  screenshotDeletedAt: Date | null;
  screenshotDeletedById: string | null;
  screenshotDeleteReason: string | null;
  browserInfo: string | null;
  browserInfoExpiresAt: Date | null;
  browserInfoDeletedAt: Date | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}) {
  const now = new Date();
  const screenshotRetained = Boolean(
    report.screenshotDataUrl &&
      !report.screenshotDeletedAt &&
      (!report.screenshotExpiresAt || report.screenshotExpiresAt > now)
  );
  const browserInfoRetained = Boolean(
    report.browserInfo &&
      !report.browserInfoDeletedAt &&
      (!report.browserInfoExpiresAt || report.browserInfoExpiresAt > now)
  );

  return {
    id: report.id,
    pageUrl: report.pageUrl,
    pageTitle: report.pageTitle,
    description: report.description,
    screenshot: {
      dataUrl: screenshotRetained ? report.screenshotDataUrl : null,
      capturedAt: report.screenshotCapturedAt,
      expiresAt: report.screenshotExpiresAt,
      deletedAt: report.screenshotDeletedAt,
      deletedById: report.screenshotDeletedById,
      deleteReason: report.screenshotDeleteReason,
      retained: screenshotRetained,
    },
    browserInfo: {
      value: browserInfoRetained ? report.browserInfo : null,
      expiresAt: report.browserInfoExpiresAt,
      deletedAt: report.browserInfoDeletedAt,
      retained: browserInfoRetained,
    },
    resolvedAt: report.resolvedAt,
    resolvedById: report.resolvedById,
    resolutionNote: report.resolutionNote,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    member: report.member,
  };
}

async function loadReport(id: string) {
  return prisma.issueReport.findUnique({
    where: { id },
    select: {
      id: true,
      pageUrl: true,
      pageTitle: true,
      description: true,
      screenshotDataUrl: true,
      screenshotCapturedAt: true,
      screenshotExpiresAt: true,
      screenshotDeletedAt: true,
      screenshotDeletedById: true,
      screenshotDeleteReason: true,
      browserInfo: true,
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
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (admin.response) {
    return admin.response;
  }

  const { id } = await params;
  const report = await loadReport(id);
  if (!report) {
    return NextResponse.json({ error: "Issue report not found" }, { status: 404 });
  }

  logAudit({
    action: "issue_report.admin_viewed",
    memberId: admin.session!.user.id,
    targetId: id,
    details: JSON.stringify({
      hasScreenshot: Boolean(report.screenshotDataUrl && !report.screenshotDeletedAt),
    }),
    ipAddress:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
    category: "privacy",
    outcome: "success",
  });

  return NextResponse.json({ report: mapReport(report) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (admin.response) {
    return admin.response;
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const existing = await prisma.issueReport.findUnique({
      where: { id },
      select: { id: true, screenshotDataUrl: true, screenshotDeletedAt: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Issue report not found" }, { status: 404 });
    }

    const now = new Date();
    if (parsed.data.action === "resolve") {
      await prisma.issueReport.update({
        where: { id },
        data: {
          resolvedAt: now,
          resolvedById: admin.session!.user.id,
          resolutionNote: parsed.data.note || null,
        },
      });
      logAudit({
        action: "issue_report.resolved",
        memberId: admin.session!.user.id,
        targetId: id,
        details: parsed.data.note || "No note",
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
        category: "privacy",
        outcome: "success",
      });
    } else if (parsed.data.action === "reopen") {
      await prisma.issueReport.update({
        where: { id },
        data: {
          resolvedAt: null,
          resolvedById: null,
          resolutionNote: null,
        },
      });
      logAudit({
        action: "issue_report.reopened",
        memberId: admin.session!.user.id,
        targetId: id,
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
        category: "privacy",
        outcome: "success",
      });
    } else {
      await prisma.issueReport.update({
        where: { id },
        data: {
          screenshotDataUrl: null,
          screenshotDeletedAt: now,
          screenshotDeletedById: admin.session!.user.id,
          screenshotDeleteReason: parsed.data.reason || "Deleted by admin",
        },
      });
      logAudit({
        action: "issue_report.screenshot_deleted",
        memberId: admin.session!.user.id,
        targetId: id,
        details: parsed.data.reason || "Deleted by admin",
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
        category: "privacy",
        severity: "important",
        outcome: "success",
      });
    }

    const report = await loadReport(id);
    return NextResponse.json({ report: report ? mapReport(report) : null });
  } catch (err) {
    logger.error({ err, issueReportId: id }, "Failed to update issue report");
    return NextResponse.json({ error: "Failed to update issue report" }, { status: 500 });
  }
}
