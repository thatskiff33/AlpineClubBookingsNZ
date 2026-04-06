import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { getSeasonYear } from "@/lib/utils";
import logger from "@/lib/logger";

const querySchema = z.object({
  seasonYear: z.coerce.number().int().min(2020).max(2040).optional(),
  status: z.enum(["PAID", "UNPAID", "OVERDUE", "NOT_INVOICED", "all"]).optional().default("all"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    seasonYear: searchParams.get("seasonYear") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  const seasonYear = parsed.data.seasonYear ?? getSeasonYear(new Date());

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { seasonYear };
    if (status !== "all") {
      where.status = status;
    }

    const [data, total, summary] = await Promise.all([
      prisma.memberSubscription.findMany({
        where,
        include: {
          member: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
        orderBy: { member: { lastName: "asc" } },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.memberSubscription.count({ where }),
      prisma.memberSubscription.groupBy({
        by: ["status"],
        where: { seasonYear },
        _count: true,
      }),
    ]);

    const counts = { total: 0, paid: 0, unpaid: 0, overdue: 0, notInvoiced: 0 };
    for (const row of summary) {
      counts.total += row._count;
      if (row.status === "PAID") counts.paid = row._count;
      else if (row.status === "UNPAID") counts.unpaid = row._count;
      else if (row.status === "OVERDUE") counts.overdue = row._count;
      else if (row.status === "NOT_INVOICED") counts.notInvoiced = row._count;
    }

    return NextResponse.json({ data, total, page, pageSize, summary: counts });
  } catch (err) {
    logger.error({ err }, "Error fetching subscriptions");
    return NextResponse.json({ error: "Failed to fetch subscriptions" }, { status: 500 });
  }
}
