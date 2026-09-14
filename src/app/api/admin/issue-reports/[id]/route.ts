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
  type IssueReportScreenshotAccess,
} from "@/lib/issue-report-screenshot-access";

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

type LoadedReport = {
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
  screenshotOrigin: IssueReportOrigin | null;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
};

/**
 * Whether this route still HOLDS the pixels. Deliberately stricter than the
 * list route's answer: this one has the blob and also honours
 * `screenshotExpiresAt`, so an expiry the nightly sweep has not yet reached
 * stops serving immediately rather than at the next cron run.
 *
 * Separate from "may this caller see them", which is #2703's question and is
 * answered by `classifyIssueReportScreenshot`.
 */
function screenshotIsRetained(report: LoadedReport, now: Date) {
  return Boolean(
    report.screenshotDataUrl &&
      !report.screenshotDeletedAt &&
      (!report.screenshotExpiresAt || report.screenshotExpiresAt > now)
  );
}

/**
 * `access` is REQUIRED, not defaulted, and that is the whole #2703 gate on this
 * route. Every payload this file returns — the detail read and the reply to
 * each PATCH action — goes through here, so a new caller cannot forget to
 * decide who it is serving: it has to produce an access decision first, and the
 * type system will not let it skip one.
 */
function mapReport(report: LoadedReport, access: IssueReportScreenshotAccess) {
  const now = new Date();
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
      // The ONLY place this route emits pixels, and it emits them on exactly
      // one disposition (#2703). A withheld screenshot returns `retained: true`
      // with a null `dataUrl` and nothing describing the image — the authorised
      // -withheld state the owner rule allows a support officer to see.
      dataUrl: access.releasePixels ? report.screenshotDataUrl : null,
      capturedAt: report.screenshotCapturedAt,
      expiresAt: report.screenshotExpiresAt,
      deletedAt: report.screenshotDeletedAt,
      deletedById: report.screenshotDeletedById,
      deleteReason: report.screenshotDeleteReason,
      retained: access.retained,
      withheld: access.withheld,
      disposition: access.disposition,
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
      screenshotOrigin: true,
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
  const admin = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!admin.ok) {
    return admin.response;
  }

  const { id } = await params;
  const report = await loadReport(id);
  if (!report) {
    return NextResponse.json({ error: "Issue report not found" }, { status: 404 });
  }

  const access = classifyIssueReportScreenshot({
    retained: screenshotIsRetained(report, new Date()),
    screenshotOrigin: report.screenshotOrigin,
    screenshotCapturedAt: report.screenshotCapturedAt,
    screenshotDeletedAt: report.screenshotDeletedAt,
    screenshotDeleteReason: report.screenshotDeleteReason,
    viewerIsFullAdmin: viewerIsFullAdmin(admin.session.user),
  });

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  logAudit({
    action: "issue_report.admin_viewed",
    memberId: admin.session.user.id,
    targetId: id,
    // `screenshotDisposition` is what makes this row answer #2703's "audit
    // distinguishes viewed, withheld, expired and manually deleted". It is a
    // closed vocabulary describing the ACCESS DECISION and never the picture:
    // no pixels, no size, no page content, nothing captured.
    details: JSON.stringify({
      hasScreenshot: Boolean(report.screenshotDataUrl && !report.screenshotDeletedAt),
      screenshotDisposition: access.disposition,
    }),
    ipAddress,
    category: "privacy",
    outcome: "success",
  });

  if (access.withheld) {
    // A SECOND row, deliberately, and only on a refusal. The view row above
    // records that somebody opened the report; this one is the access-control
    // event — a support officer was refused admin-origin pixels — and it earns
    // its own action so it is findable in Admin > Audit Log by action name
    // rather than by parsing every view row's payload.
    //
    // `privacy` to match every sibling issue-report event (INV-PRIV-012: the
    // category is the permission decision, and moving this one to `admin` would
    // hand it to `support:view` alone). `important` because a refusal is worth
    // noticing; it is not `critical`, because nothing leaked.
    logAudit({
      action: "issue_report.screenshot_withheld",
      memberId: admin.session.user.id,
      targetId: id,
      details: JSON.stringify({ reason: "admin_origin_requires_full_admin" }),
      ipAddress,
      category: "privacy",
      severity: "important",
      outcome: "success",
    });
  }

  return NextResponse.json({ report: mapReport(report, access) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!admin.ok) {
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
          resolvedById: admin.session.user.id,
          resolutionNote: parsed.data.note || null,
        },
      });
      logAudit({
        action: "issue_report.resolved",
        memberId: admin.session.user.id,
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
        memberId: admin.session.user.id,
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
          screenshotDeletedById: admin.session.user.id,
          screenshotDeleteReason: parsed.data.reason || "Deleted by admin",
        },
      });
      logAudit({
        action: "issue_report.screenshot_deleted",
        memberId: admin.session.user.id,
        targetId: id,
        details: parsed.data.reason || "Deleted by admin",
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
        category: "privacy",
        severity: "important",
        outcome: "success",
      });
    }

    // The PATCH reply carries the same payload the detail read does, so it is
    // the same boundary and takes the same gate (#2703). Without this a
    // support-EDIT officer could have resolved a report and been handed the
    // admin-origin pixels the GET beside it refuses them.
    const report = await loadReport(id);
    if (!report) {
      return NextResponse.json({ report: null });
    }
    return NextResponse.json({
      report: mapReport(
        report,
        classifyIssueReportScreenshot({
          retained: screenshotIsRetained(report, new Date()),
          screenshotOrigin: report.screenshotOrigin,
          screenshotCapturedAt: report.screenshotCapturedAt,
          screenshotDeletedAt: report.screenshotDeletedAt,
          screenshotDeleteReason: report.screenshotDeleteReason,
          viewerIsFullAdmin: viewerIsFullAdmin(admin.session.user),
        })
      ),
    });
  } catch (err) {
    logger.error({ err, issueReportId: id }, "Failed to update issue report");
    return NextResponse.json({ error: "Failed to update issue report" }, { status: 500 });
  }
}
