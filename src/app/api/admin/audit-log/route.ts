import { NextRequest, NextResponse } from "next/server";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { auditCategoriesReadableWith } from "@/lib/audit-categories";
import {
  ADMIN_AUDIT_LOG_CONNECTION_SHAPE,
  type AdminAuditLogAnswer,
} from "@/lib/connection-shapes/support-records";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getAuditTimelinePage } from "@/lib/audit-query";
import { parseAdminAuditLogQuery } from "@/lib/audit-admin-query";
import { clubTimeZone } from "@/lib/club-time/server";
import logger from "@/lib/logger";
import { clubFormatValues } from "@/lib/club-format-server";

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

  // An officer's AI app reads only the categories its officer's areas may
  // correlate, as AI Diagnostics does (`audit-categories.ts`, ALP-724): the
  // screen is read by a person, the connection by a model. A row with no
  // category is in none of them.
  const viaConnection = arrivesAsMcpConnection(request);
  const where = viaConnection
    ? {
        AND: [
          parsed.data.where,
          {
            category: {
              in: auditCategoriesReadableWith((area) =>
                hasAdminAreaAccess(guard.session.user, { area, level: "view" }),
              ),
            },
          },
        ],
      }
    : parsed.data.where;

  try {
    const response = await getAuditTimelinePage({
      db: prisma,
      format: await clubFormatValues(),
      where,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category: parsed.data.category,
      audience: "admin",
    });
    // The filter lists are drawn from every entry, so a connection gets none.
    const facets = viaConnection ? null : await getAuditFacets();
    const answer: AdminAuditLogAnswer = {
      ...response,
      eventType: parsed.data.eventType ?? "all",
      filters: parsed.data.filters,
      ...(facets ? { facets, actions: facets.eventTypes } : {}),
    };
    return connectionJson(request, answer, ADMIN_AUDIT_LOG_CONNECTION_SHAPE);
  } catch (err) {
    logger.error({ err }, "Error fetching audit log");
    return NextResponse.json(
      { error: "Failed to fetch audit log" },
      { status: 500 }
    );
  }
}
