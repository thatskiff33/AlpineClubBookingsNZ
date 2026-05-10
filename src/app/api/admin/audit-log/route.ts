import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildAuditCategoryWhere,
  buildAuditMemberScopeWhere,
  getAuditTimelinePage,
  isAuditTimelineCategory,
  type AuditMemberScope,
  type AuditTimelineCategory,
} from "@/lib/audit-query";
import logger from "@/lib/logger";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  eventType: z.string().max(160).optional(),
  action: z.string().max(160).optional(),
  category: z.string().optional().default("all"),
  memberId: z.string().optional(),
  memberScope: z
    .enum(["involves", "actor", "subject"])
    .optional()
    .default("involves"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  outcome: z.string().max(40).optional(),
  severity: z.string().max(40).optional(),
  entityType: z.string().max(80).optional(),
  q: z.string().max(160).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

function optionalFilter(value?: string): string | undefined {
  if (!value || value === "all") {
    return undefined;
  }
  return value;
}

function buildDateWhere(params: {
  from?: string;
  to?: string;
}): Prisma.AuditLogWhereInput | null {
  if (!params.from && !params.to) {
    return null;
  }

  const createdAt: Prisma.DateTimeFilter = {};
  if (params.from) {
    createdAt.gte = new Date(`${params.from}T00:00:00`);
  }
  if (params.to) {
    createdAt.lte = new Date(`${params.to}T23:59:59`);
  }
  return { createdAt };
}

function buildTextSearchWhere(q?: string): Prisma.AuditLogWhereInput | null {
  const search = q?.trim();
  if (!search) {
    return null;
  }

  return {
    OR: [
      { action: { contains: search, mode: "insensitive" } },
      { summary: { contains: search, mode: "insensitive" } },
      { details: { contains: search, mode: "insensitive" } },
      { requestId: { contains: search, mode: "insensitive" } },
      { entityId: { contains: search, mode: "insensitive" } },
      { targetId: { contains: search, mode: "insensitive" } },
    ],
  };
}

function buildGlobalAuditWhere(params: {
  eventType?: string;
  category: AuditTimelineCategory;
  memberId?: string;
  memberScope: AuditMemberScope;
  from?: string;
  to?: string;
  outcome?: string;
  severity?: string;
  entityType?: string;
  q?: string;
}): Prisma.AuditLogWhereInput {
  const clauses: Prisma.AuditLogWhereInput[] = [];

  if (params.eventType) {
    clauses.push({ action: params.eventType });
  }

  const categoryWhere = buildAuditCategoryWhere(params.category);
  if (categoryWhere) {
    clauses.push(categoryWhere);
  }

  if (params.memberId) {
    clauses.push(buildAuditMemberScopeWhere(params.memberId, params.memberScope));
  }

  const dateWhere = buildDateWhere(params);
  if (dateWhere) {
    clauses.push(dateWhere);
  }

  if (params.outcome) {
    clauses.push({ outcome: params.outcome });
  }
  if (params.severity) {
    clauses.push({ severity: params.severity });
  }
  if (params.entityType) {
    clauses.push({ entityType: params.entityType });
  }

  const textSearchWhere = buildTextSearchWhere(params.q);
  if (textSearchWhere) {
    clauses.push(textSearchWhere);
  }

  return clauses.length > 0 ? { AND: clauses } : {};
}

async function getAuditFacets() {
  const [
    eventTypes,
    categories,
    entityTypes,
    outcomes,
    severities,
  ] = await Promise.all([
    prisma.auditLog.findMany({
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { category: { not: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { entityType: { not: null } },
      select: { entityType: true },
      distinct: ["entityType"],
      orderBy: { entityType: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { outcome: { not: null } },
      select: { outcome: true },
      distinct: ["outcome"],
      orderBy: { outcome: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { severity: { not: null } },
      select: { severity: true },
      distinct: ["severity"],
      orderBy: { severity: "asc" },
    }),
  ]);

  return {
    eventTypes: eventTypes.map((row) => row.action),
    categories: categories
      .map((row) => row.category)
      .filter((value): value is string => Boolean(value)),
    entityTypes: entityTypes
      .map((row) => row.entityType)
      .filter((value): value is string => Boolean(value)),
    outcomes: outcomes
      .map((row) => row.outcome)
      .filter((value): value is string => Boolean(value)),
    severities: severities
      .map((row) => row.severity)
      .filter((value): value is string => Boolean(value)),
  };
}

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
    eventType: searchParams.get("eventType") ?? undefined,
    action: searchParams.get("action") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    memberId: searchParams.get("memberId") ?? undefined,
    memberScope: searchParams.get("memberScope") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    outcome: searchParams.get("outcome") ?? undefined,
    severity: searchParams.get("severity") ?? undefined,
    entityType: searchParams.get("entityType") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success || !isAuditTimelineCategory(parsed.data.category)) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.success ? undefined : parsed.error.flatten() },
      { status: 400 }
    );
  }

  const category = parsed.data.category as AuditTimelineCategory;
  const eventType = optionalFilter(
    parsed.data.eventType ?? parsed.data.action
  );
  const outcome = optionalFilter(parsed.data.outcome);
  const severity = optionalFilter(parsed.data.severity);
  const entityType = optionalFilter(parsed.data.entityType);
  const where = buildGlobalAuditWhere({
    eventType,
    category,
    memberId: optionalFilter(parsed.data.memberId),
    memberScope: parsed.data.memberScope,
    from: parsed.data.from,
    to: parsed.data.to,
    outcome,
    severity,
    entityType,
    q: parsed.data.q,
  });

  try {
    const response = await getAuditTimelinePage({
      db: prisma,
      where,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category,
      audience: "admin",
    });
    const facets = await getAuditFacets();

    return NextResponse.json({
      ...response,
      eventType: eventType ?? "all",
      filters: {
        eventType: eventType ?? "all",
        category,
        memberId: optionalFilter(parsed.data.memberId) ?? null,
        memberScope: parsed.data.memberScope,
        from: parsed.data.from ?? null,
        to: parsed.data.to ?? null,
        outcome: outcome ?? "all",
        severity: severity ?? "all",
        entityType: entityType ?? "all",
        q: parsed.data.q?.trim() || null,
      },
      facets,
      actions: facets.eventTypes,
    });
  } catch (err) {
    logger.error({ err }, "Error fetching audit log");
    return NextResponse.json(
      { error: "Failed to fetch audit log" },
      { status: 500 }
    );
  }
}
