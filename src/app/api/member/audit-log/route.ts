import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { memberAuditLogQuerySchema } from "@/lib/member-audit-log-query";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import {
  buildAuditCategoryWhere,
  buildMemberVisibleAuditLogWhere,
  getAuditTimelinePage,
  isMemberVisibleAuditCategory,
  MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS,
  type AuditTimelineCategory,
} from "@/lib/audit-query";
import logger from "@/lib/logger";
import { clubFormatValues } from "@/lib/club-format-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { searchParams } = new URL(request.url);
  const parsed = memberAuditLogQuerySchema.safeParse({
    category: searchParams.get("category") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success || !isMemberVisibleAuditCategory(parsed.data.category)) {
    return NextResponse.json(
      { error: "Invalid query parameters" },
      { status: 400 }
    );
  }

  const category = parsed.data.category as AuditTimelineCategory;
  const categoryWhere = buildAuditCategoryWhere(category);
  const where = categoryWhere
    ? {
        AND: [
          buildMemberVisibleAuditLogWhere(session.user.id),
          categoryWhere,
        ],
      }
    : buildMemberVisibleAuditLogWhere(session.user.id);

  try {
    const response = await getAuditTimelinePage({
      db: prisma,
      format: await clubFormatValues(),
      where,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category,
      audience: "member",
      currentMemberId: session.user.id,
    });

    // ALP-718: an AI app connection is sent when, what kind and what
    // happened for each entry; no request details, links or metadata.
    return connectionJson(
      request,
      { ...response, categories: MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS },
      MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE,
    );
  } catch (err) {
    logger.error(
      { err, memberId: session.user.id },
      "Failed to fetch member self audit log"
    );
    return NextResponse.json(
      { error: "Failed to fetch audit log" },
      { status: 500 }
    );
  }
}
