import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { logAudit } from "@/lib/audit";
import { sendAdminIssueReportAlert } from "@/lib/email";
import logger from "@/lib/logger";

const MAX_SCREENSHOT_BYTES = 900_000;

const issueReportSchema = z.object({
  pageUrl: z.string().url().max(2048),
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
): { dataUrl: string; filename: string; content: Buffer; contentType: string } | null {
  if (!screenshotDataUrl) {
    return null;
  }

  const match = screenshotDataUrl.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/
  );
  if (!match) {
    throw new ApiError("Screenshot format is invalid", 400);
  }

  const contentType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const content = Buffer.from(match[2], "base64");
  if (content.length > MAX_SCREENSHOT_BYTES) {
    throw new ApiError("Screenshot is too large to submit", 400);
  }

  const extension =
    contentType === "image/png"
      ? "png"
      : contentType === "image/webp"
        ? "webp"
        : "jpg";

  return {
    dataUrl: screenshotDataUrl,
    filename: `issue-report-screenshot.${extension}`,
    content,
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
    const pageTitle = parsed.data.pageTitle?.trim() || null;
    const description = parsed.data.description.trim();

    const issueReport = await prisma.issueReport.create({
      data: {
        memberId: member.id,
        pageUrl: parsed.data.pageUrl,
        pageTitle,
        description,
        screenshotDataUrl: screenshot?.dataUrl ?? null,
        browserInfo: request.headers.get("user-agent") ?? null,
      },
      select: { id: true },
    });

    logAudit({
      action: "issue.reported",
      memberId: member.id,
      targetId: issueReport.id,
      details: JSON.stringify({
        pageUrl: parsed.data.pageUrl,
        pageTitle,
        hasScreenshot: Boolean(screenshot),
      }),
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
    });

    sendAdminIssueReportAlert({
      memberName: `${member.firstName} ${member.lastName}`.trim(),
      memberEmail: member.email,
      pageUrl: parsed.data.pageUrl,
      pageTitle,
      description,
      screenshot: screenshot
        ? {
            filename: screenshot.filename,
            content: screenshot.content,
            contentType: screenshot.contentType,
          }
        : null,
    }).catch((err) =>
      logger.error({ err, issueReportId: issueReport.id }, "Failed to send admin issue report alert")
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
