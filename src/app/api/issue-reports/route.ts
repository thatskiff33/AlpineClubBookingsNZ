import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { auth } from "@/lib/auth";
import { getAppBaseUrl, rebaseOntoAppOrigin } from "@/lib/app-url";
import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import { deriveIssueReportScreenshotOrigin } from "@/lib/issue-report-screenshot-access";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit-http";
import { sendAdminIssueReportAlert } from "@/lib/email";
import { getIssueReportSensitiveDataExpiresAt } from "@/lib/issue-report-retention";
import logger from "@/lib/logger";
import { adminHref } from "@/lib/admin-hubs";

const MAX_SCREENSHOT_BYTES = 900_000;

const issueReportSchema = z.object({
  pageUrl: z.string().trim().min(1).max(2048),
  pageTitle: z.string().trim().max(300).optional(),
  description: z.string().trim().min(10).max(2000),
  screenshotDataUrl: z.string().max(2_000_000).optional(),
});

class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

function parseScreenshot(
  screenshotDataUrl?: string
): { dataUrl: string; contentType: string } | null {
  if (!screenshotDataUrl) {
    return null;
  }

  // Both captures are mandatory in the pattern, so "the pattern matched" and
  // "both parts are here" are one condition — read out of the destructure and
  // answered by the one 400 that already existed (#2801).
  const [, matchedContentType, base64Payload] =
    screenshotDataUrl.match(
      /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/
    ) ?? [];
  if (matchedContentType === undefined || base64Payload === undefined) {
    throw new ApiError("Screenshot format is invalid", 400);
  }

  const contentType =
    matchedContentType === "image/jpg" ? "image/jpeg" : matchedContentType;
  const content = Buffer.from(base64Payload, "base64");
  if (content.length > MAX_SCREENSHOT_BYTES) {
    throw new ApiError("Screenshot is too large to submit", 400);
  }

  return {
    dataUrl: screenshotDataUrl,
    contentType,
  };
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = issueReportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const member = await prisma.member.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        // Joined role definitions, so the origin classification below resolves
        // definition-backed (custom or club-edited) access roles rather than
        // only the seeded enum ones (#2703), with `canLogin` (#3603).
        ...MEMBER_PRIVILEGE_CHECK_SELECT,
      },
    });

    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const screenshot = parseScreenshot(parsed.data.screenshotDataUrl);
    // #2703. Decided HERE, from the reporter's own server-side admin standing,
    // and written to the row — never from `parsed.data.pageUrl`, which the
    // widget posts and any reporter can forge. Set on every report, with or
    // without a screenshot, so a stored NULL means exactly one thing: a row
    // written before this release, which every reader treats as ADMIN.
    const screenshotOrigin = deriveIssueReportScreenshotOrigin({
      member,
      sessionUser: session.user,
    });
    // The widget posts `window.location.href`. Only its path, query and
    // fragment are kept, on the configured origin: no host from the body or
    // from a request header is stored, emailed or shown to an officer.
    const pageUrl = rebaseOntoAppOrigin(parsed.data.pageUrl);
    if (!pageUrl) {
      return NextResponse.json(
        { error: "Page URL must point to this site" },
        { status: 400 }
      );
    }

    const pageTitle = parsed.data.pageTitle?.trim() || null;
    const description = parsed.data.description.trim();
    const now = new Date();
    const browserInfo = request.headers.get("user-agent") ?? null;
    const sensitiveDataExpiresAt = getIssueReportSensitiveDataExpiresAt(now);

    const issueReport = await prisma.issueReport.create({
      data: {
        memberId: member.id,
        pageUrl,
        pageTitle,
        description,
        screenshotOrigin,
        screenshotDataUrl: screenshot?.dataUrl ?? null,
        screenshotCapturedAt: screenshot ? now : null,
        screenshotExpiresAt: screenshot ? sensitiveDataExpiresAt : null,
        browserInfo,
        browserInfoExpiresAt: browserInfo ? sensitiveDataExpiresAt : null,
      },
      select: { id: true },
    });

    logAudit({
      action: "issue.reported",
      // `privacy`, deliberately NOT `admin` (#2581 decision 5). `/admin/
      // issue-reports` is a `support` surface and the sibling admin
      // issue-report events are already `privacy`, so matching the SURFACE
      // would mean moving this to `admin` — which reads with `support:view`
      // alone and would widen a member's own report. The mismatch stays and is
      // disclosed: a support-only operator correlates issue reports in
      // Admin > Audit Log rather than in Diagnostics.
      //
      // `privacy` is member-visible, and this row is written with
      // `memberId: member.id`, so the REPORTER sees it on their own timeline.
      // What they read from it is now an explicit DECLARATION and nothing else
      // (#2695): this event declares none, so the member's timeline and their
      // data export both show them no free text from this row. The reasoning
      // that used to sit here — "`details` is a JSON object, so the member
      // projection returns null", caveated because a payload clipped past 1000
      // characters stopped parsing and was handed back whole — was the SHAPE
      // test, and it is gone. What the size still decides is what an AUTHORISED
      // officer sees, and #2704 made that whole fields rather than a broken
      // fragment; this payload can exceed 1000, because `pageUrl` is capped at
      // 2048 and `pageTitle` at 300 by the schema above and
      // `rebaseOntoAppOrigin` keeps the query string.
      category: "privacy",
      memberId: member.id,
      targetId: issueReport.id,
      entityType: "IssueReport",
      entityId: issueReport.id,
      details: JSON.stringify({
        pageUrl,
        pageTitle,
        hasScreenshot: Boolean(screenshot),
      }),
      ipAddress: getClientIp(request),
    });

    sendAdminIssueReportAlert({
      memberName: `${member.firstName} ${member.lastName}`.trim(),
      memberEmail: member.email,
      pageUrl,
      pageTitle,
      description,
      issueReportUrl: `${getAppBaseUrl()}${adminHref("issue-reports")}?report=${encodeURIComponent(
        issueReport.id
      )}`,
      hasScreenshot: Boolean(screenshot),
    }).catch((err) =>
      logger.error(
        { err, issueReportId: issueReport.id },
        "Failed to send admin issue report alert"
      )
    );

    return NextResponse.json({ id: issueReport.id }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.error({ err: error }, "Failed to submit issue report");
    return NextResponse.json({ error: "Failed to submit issue report" }, { status: 500 });
  }
}
