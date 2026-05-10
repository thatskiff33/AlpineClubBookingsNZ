import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  buildAuditCategoryWhere,
  buildMemberAuditLogWhere,
  getAuditTimelinePage,
  isAuditTimelineCategory,
  type AuditTimelineCategory,
} from "@/lib/audit-query";
import logger from "@/lib/logger";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  category: z.string().optional().default("all"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(10),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
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
      where,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category,
      audience: "admin",
    });

    return NextResponse.json(response);
  } catch (err) {
    logger.error({ err, memberId: id }, "Failed to fetch member audit log");
    return NextResponse.json(
      { error: "Failed to fetch audit log" },
      { status: 500 }
    );
  }
}
