import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getAuditTimelinePage } from "@/lib/audit-query";
import { parseAdminAuditLogQuery } from "@/lib/audit-admin-query";
import { clubTimeZone } from "@/lib/club-time/server";
import logger from "@/lib/logger";

export const dynamic = "force-dynamic";

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
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  // The date filters bound `AuditLog.createdAt`, a real instant column, so the
  // day boundaries are the CLUB's — read once for this request (#3123).
  const parsed = parseAdminAuditLogQuery(searchParams, await clubTimeZone());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.details },
      { status: 400 }
    );
  }

  try {
    const response = await getAuditTimelinePage({
      db: prisma,
      where: parsed.data.where,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category: parsed.data.category,
      audience: "admin",
    });
    const facets = await getAuditFacets();

    return NextResponse.json({
      ...response,
      eventType: parsed.data.eventType ?? "all",
      filters: parsed.data.filters,
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
