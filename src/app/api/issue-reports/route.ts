import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { normalizeInternalAppUrl } from "@/lib/app-url";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { logAudit } from "@/lib/audit";
import { sendAdminIssueReportAlert } from "@/lib/email";
import { getIssueReportSensitiveDataExpiresAt } from "@/lib/issue-report-retention";
import logger from "@/lib/logger";

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

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

function httpOrigin(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

function forwardedOrigin(request: NextRequest) {
  const forwardedHost =
    firstHeaderValue(request.headers.get("x-forwarded-host")) ||
    request.headers.get("host");
  if (!forwardedHost) {
    return null;
  }

  const forwardedProto = firstHeaderValue(
    request.headers.get("x-forwarded-proto")
  );
  const protocol = forwardedProto === "http" ? "http" : "https";
  return httpOrigin(`${protocol}://${forwardedHost}`);
}

function uniqueOrigins(origins: Array<string | null>) {
  return Array.from(
    new Set(origins.filter((origin): origin is string => Boolean(origin)))
  );
}

function normalizeIssueReportPageUrl(input: string, request: NextRequest) {
  const configuredOrigin = httpOrigin(process.env.NEXTAUTH_URL);
  const requestOrigin = httpOrigin(request.nextUrl.origin);
  const trustedOrigins = uniqueOrigins([
    configuredOrigin,
    forwardedOrigin(request),
    requestOrigin,
  ]);

  for (const baseUrl of trustedOrigins) {
    const pageUrl = normalizeInternalAppUrl(input, { baseUrl });
    if (pageUrl) {
      return { pageUrl, appOrigin: baseUrl };
    }
  }

  return null;
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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
      },
    });

    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const screenshot = parseScreenshot(parsed.data.screenshotDataUrl);
    const pageUrlContext = normalizeIssueReportPageUrl(
      parsed.data.pageUrl,
      request
    );
    if (!pageUrlContext) {
      return NextResponse.json(
        { error: "Page URL must point to this site" },
        { status: 400 }
      );
    }

    const { pageUrl, appOrigin } = pageUrlContext;
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
      // The usual reassurance — "`details` is a JSON object, so the member
      // projection returns `null`" — is true by SHAPE but not by SIZE here.
      // `sanitizeAuditDetails` clips anything over 1000 characters to
      // `<first 1000>...[TRUNCATED]`; a clipped object no longer parses, so
      // `parseJsonObject` returns null and `serializeAuditTimelineLog` hands
      // the clipped string back as `details`/`description`. This payload CAN
      // exceed 1000: `pageUrl` is capped at 2048 and `pageTitle` at 300 by the
      // schema above, and `normalizeInternalAppUrl` keeps the query string. The
      // exposure is nil — it is the reporter's own page URL and title on their
      // own report — but the shape argument alone would be wrong here, so both
      // halves are stated, in `docs/guides/audit-log.md` as well.
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
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
    });

    sendAdminIssueReportAlert({
      memberName: `${member.firstName} ${member.lastName}`.trim(),
      memberEmail: member.email,
      pageUrl,
      pageTitle,
      description,
      issueReportUrl: `${appOrigin}/admin/issue-reports?report=${encodeURIComponent(
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
