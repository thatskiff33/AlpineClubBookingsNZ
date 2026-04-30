import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { getSeasonYear } from "@/lib/utils";
import logger from "@/lib/logger";
import {
  getXeroContactGroupMemberships,
  getXeroContactIdsForGroup,
} from "@/lib/xero";

const querySchema = z.object({
  seasonYear: z.coerce.number().int().min(2020).max(2040).optional(),
  status: z.enum(["PAID", "UNPAID", "OVERDUE", "NOT_INVOICED", "all"]).optional().default("all"),
  ageTier: z.enum(["INFANT", "CHILD", "YOUTH", "ADULT", "all"]).optional().default("all"),
  xeroContactGroup: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(request: NextRequest) {
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

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    seasonYear: searchParams.get("seasonYear") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    ageTier: searchParams.get("ageTier") ?? undefined,
    xeroContactGroup: searchParams.get("xeroContactGroup") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, ageTier, xeroContactGroup, page, pageSize } = parsed.data;
  const seasonYear = parsed.data.seasonYear ?? getSeasonYear(new Date());

  try {
    const memberWhere: Prisma.MemberWhereInput = {};

    if (ageTier !== "all") {
      memberWhere.ageTier = ageTier;
    }

    if (xeroContactGroup && xeroContactGroup !== "all") {
      const groupContactIds = await getXeroContactIdsForGroup(xeroContactGroup);
      memberWhere.xeroContactId = { in: groupContactIds };
    }

    const summaryWhere: Prisma.MemberSubscriptionWhereInput = { seasonYear };
    if (Object.keys(memberWhere).length > 0) {
      summaryWhere.member = memberWhere;
    }

    const where: Prisma.MemberSubscriptionWhereInput = { ...summaryWhere };
    if (status !== "all") {
      where.status = status;
    }

    const [data, total, summary] = await Promise.all([
      prisma.memberSubscription.findMany({
        where,
        include: {
          member: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
              ageTier: true,
              xeroContactId: true,
            },
          },
        },
        orderBy: { member: { lastName: "asc" } },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.memberSubscription.count({ where }),
      prisma.memberSubscription.groupBy({
        by: ["status"],
        where: summaryWhere,
        _count: true,
      }),
    ]);

    const linkedContactIds = data
      .map((subscription) => subscription.member.xeroContactId)
      .filter((contactId): contactId is string => Boolean(contactId));
    const xeroContactGroupsByContactId =
      linkedContactIds.length > 0
        ? await getXeroContactGroupMemberships(linkedContactIds)
        : {};
    const xeroContactGroupsLoaded =
      linkedContactIds.length === 0 ||
      linkedContactIds.every((contactId) =>
        Object.prototype.hasOwnProperty.call(xeroContactGroupsByContactId, contactId)
      );

    const dataWithXeroGroups = data.map((subscription) => ({
      ...subscription,
      xeroContactGroupsLoaded,
      xeroContactGroups: subscription.member.xeroContactId
        ? xeroContactGroupsByContactId[subscription.member.xeroContactId] ?? []
        : [],
    }));

    const counts = { total: 0, paid: 0, unpaid: 0, overdue: 0, notInvoiced: 0 };
    for (const row of summary) {
      counts.total += row._count;
      if (row.status === "PAID") counts.paid = row._count;
      else if (row.status === "UNPAID") counts.unpaid = row._count;
      else if (row.status === "OVERDUE") counts.overdue = row._count;
      else if (row.status === "NOT_INVOICED") counts.notInvoiced = row._count;
    }

    return NextResponse.json({
      data: dataWithXeroGroups,
      total,
      page,
      pageSize,
      summary: counts,
      xeroContactGroupsLoaded,
    });
  } catch (err) {
    logger.error({ err }, "Error fetching subscriptions");
    return NextResponse.json({ error: "Failed to fetch subscriptions" }, { status: 500 });
  }
}
