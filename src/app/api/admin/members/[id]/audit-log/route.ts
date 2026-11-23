import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { memberAuditLogQuerySchema } from "@/lib/member-audit-log-query";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_AUDIT_TIMELINE_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-members";
import {
  buildAuditCategoryWhere,
  buildMemberAuditLogWhere,
  getAuditTimelinePage,
  isAuditTimelineCategory,
  type AuditTimelineCategory,
} from "@/lib/audit-query";
import logger from "@/lib/logger";
import { clubFormatValues } from "@/lib/club-format-server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const parsed = memberAuditLogQuerySchema.safeParse({
    category: searchParams.get("category") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success || !isAuditTimelineCategory(parsed.data.category)) {
    return NextResponse.json(
      { error: "Invalid query parameters" },
      { status: 400 }
    );
  }

  const category = parsed.data.category as AuditTimelineCategory;
  const member = await prisma.member.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const categoryWhere = buildAuditCategoryWhere(category);
  const where = categoryWhere
    ? { AND: [buildMemberAuditLogWhere(id), categoryWhere] }
    : buildMemberAuditLogWhere(id);

  try {
    const response = await getAuditTimelinePage({
      db: prisma,
      format: await clubFormatValues(),
      where,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category,
      audience: "admin",
    });

    // ALP-720: an AI app connection is sent when, what kind, the outcome and
    // what happened for each entry; no request details, devices or metadata.
    return connectionJson(request, response, MEMBER_AUDIT_TIMELINE_CONNECTION_SHAPE);
  } catch (err) {
    logger.error({ err, memberId: id }, "Failed to fetch member audit log");
    return NextResponse.json(
      { error: "Failed to fetch audit log" },
      { status: 500 }
    );
  }
}
