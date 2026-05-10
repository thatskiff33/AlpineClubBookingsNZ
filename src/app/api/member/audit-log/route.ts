import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  buildAuditCategoryWhere,
  buildMemberVisibleAuditLogWhere,
  getAuditTimelinePage,
  isMemberVisibleAuditCategory,
  MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS,
  type AuditTimelineCategory,
} from "@/lib/audit-query";
import logger from "@/lib/logger";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  category: z.string().optional().default("all"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(10),
});

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
  const parsed = querySchema.safeParse({
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
      where,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category,
      audience: "member",
      currentMemberId: session.user.id,
    });

    return NextResponse.json({
      ...response,
      categories: MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS,
    });
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
