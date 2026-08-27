import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  endOfClubDayExclusive,
  requireCalendarDate,
  startOfClubDay,
  type ClubTimeZone,
} from "@/lib/club-time";
import {
  buildAuditCategoryWhere,
  buildAuditMemberScopeWhere,
  isAuditTimelineCategory,
  type AuditMemberScope,
  type AuditTimelineCategory,
} from "@/lib/audit-query";

const adminAuditLogQuerySchema = z.object({
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

type AdminAuditLogFilters = {
  eventType: string;
  category: AuditTimelineCategory;
  memberId: string | null;
  memberScope: AuditMemberScope;
  from: string | null;
  to: string | null;
  outcome: string;
  severity: string;
  entityType: string;
  q: string | null;
};

type ParsedAdminAuditLogQuery = {
  page: number;
  pageSize: number;
  category: AuditTimelineCategory;
  eventType: string | undefined;
  where: Prisma.AuditLogWhereInput;
  filters: AdminAuditLogFilters;
};

export type AdminAuditLogQueryParseResult =
  | { success: true; data: ParsedAdminAuditLogQuery }
  | {
      success: false;
      details?: ReturnType<
        z.ZodError<z.infer<typeof adminAuditLogQuerySchema>>["flatten"]
      >;
    };

function getSearchParam(searchParams: URLSearchParams, name: string) {
  return searchParams.get(name) ?? undefined;
}

function optionalAuditFilter(value?: string): string | undefined {
  if (!value || value === "all") {
    return undefined;
  }
  return value;
}

/**
 * The `createdAt` window for an operator-supplied `from` / `to` day pair.
 *
 * `AuditLog.createdAt` is a bare `DateTime @default(now())` — a real INSTANT
 * column, NOT `@db.Date` (`prisma/schema.prisma`, model `AuditLog`). So the
 * bounds are genuine instant boundaries derived from a calendar day, which is
 * the one shape that legitimately requires a timezone, and a UTC-midnight
 * `@db.Date` encoding would be exactly wrong here.
 *
 * The zone is the CLUB's persisted one, threaded in (#3123, INV-CONFIG-002).
 * It used to come from `APP_TIME_ZONE` via the `date-only` adapters, so an
 * operator asking for "everything on 3 August" got the container's 3 August.
 *
 * The upper bound is HALF-OPEN (`lt` against the exclusive end) rather than
 * `lte` against the inclusive end. The two differ only below the millisecond,
 * and Postgres keeps microseconds — so the old inclusive bound could drop a row
 * written in the last millisecond of the day. It also removes the
 * `9999-12-31` rollover the inclusive form has to guard.
 */
function buildAuditDateWhere(params: {
  from?: string;
  to?: string;
  zone: ClubTimeZone;
}): Prisma.AuditLogWhereInput | null {
  if (!params.from && !params.to) {
    return null;
  }

  const createdAt: Prisma.DateTimeFilter = {};
  if (params.from) {
    createdAt.gte = startOfClubDay(requireCalendarDate(params.from), params.zone);
  }
  if (params.to) {
    createdAt.lt = endOfClubDayExclusive(
      requireCalendarDate(params.to),
      params.zone,
    );
  }
  return { createdAt };
}

function buildAuditTextSearchWhere(
  q?: string,
): Prisma.AuditLogWhereInput | null {
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
  /** The club's persisted timezone, resolved once by the caller (#3123). */
  zone: ClubTimeZone;
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

  const dateWhere = buildAuditDateWhere(params);
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

  const textSearchWhere = buildAuditTextSearchWhere(params.q);
  if (textSearchWhere) {
    clauses.push(textSearchWhere);
  }

  return clauses.length > 0 ? { AND: clauses } : {};
}

export function parseAdminAuditLogQuery(
  searchParams: URLSearchParams,
  /**
   * The club's persisted timezone. REQUIRED, and passed in rather than read
   * here (#3123): this function is pure and sync, and its one route caller
   * already sits in an async request where `await clubTimeZone()` is memoised.
   */
  zone: ClubTimeZone,
): AdminAuditLogQueryParseResult {
  const parsed = adminAuditLogQuerySchema.safeParse({
    eventType: getSearchParam(searchParams, "eventType"),
    action: getSearchParam(searchParams, "action"),
    category: getSearchParam(searchParams, "category"),
    memberId: getSearchParam(searchParams, "memberId"),
    memberScope: getSearchParam(searchParams, "memberScope"),
    from: getSearchParam(searchParams, "from"),
    to: getSearchParam(searchParams, "to"),
    outcome: getSearchParam(searchParams, "outcome"),
    severity: getSearchParam(searchParams, "severity"),
    entityType: getSearchParam(searchParams, "entityType"),
    q: getSearchParam(searchParams, "q"),
    page: getSearchParam(searchParams, "page"),
    pageSize: getSearchParam(searchParams, "pageSize"),
  });

  if (!parsed.success || !isAuditTimelineCategory(parsed.data.category)) {
    return {
      success: false,
      details: parsed.success ? undefined : parsed.error.flatten(),
    };
  }

  const category = parsed.data.category;
  const eventType = optionalAuditFilter(
    parsed.data.eventType ?? parsed.data.action,
  );
  const outcome = optionalAuditFilter(parsed.data.outcome);
  const severity = optionalAuditFilter(parsed.data.severity);
  const entityType = optionalAuditFilter(parsed.data.entityType);
  const memberId = optionalAuditFilter(parsed.data.memberId);
  const where = buildGlobalAuditWhere({
    eventType,
    category,
    memberId,
    memberScope: parsed.data.memberScope,
    from: parsed.data.from,
    to: parsed.data.to,
    outcome,
    severity,
    entityType,
    q: parsed.data.q,
    zone,
  });

  return {
    success: true,
    data: {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category,
      eventType,
      where,
      filters: {
        eventType: eventType ?? "all",
        category,
        memberId: memberId ?? null,
        memberScope: parsed.data.memberScope,
        from: parsed.data.from ?? null,
        to: parsed.data.to ?? null,
        outcome: outcome ?? "all",
        severity: severity ?? "all",
        entityType: entityType ?? "all",
        q: parsed.data.q?.trim() || null,
      },
    },
  };
}
