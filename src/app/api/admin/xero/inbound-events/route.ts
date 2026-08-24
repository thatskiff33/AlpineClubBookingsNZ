import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { buildXeroObjectUrl } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import { canReplayXeroInboundEvent } from "@/lib/xero-stale-operations";
import {
  endOfClubDayInclusive,
  requireCalendarDate,
  startOfClubDay,
  type ClubTimeZone,
} from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";

const querySchema = z.object({
  status: z.string().optional().default("all"),
  eventCategory: z.string().optional().default("all"),
  source: z.string().optional().default("all"),
  localModel: z.string().trim().optional().default("all"),
  localId: z.string().trim().optional().default(""),
  resourceId: z.string().trim().optional().default(""),
  eventType: z.string().trim().optional().default("all"),
  createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * An admin filter's `YYYY-MM-DD` bound as the instants that bracket that CLUB
 * day (CT-5, #2869).
 *
 * `XeroSyncOperation.createdAt` / `XeroInboundEvent.createdAt` are INSTANTS, and
 * the operator typing a date means the club's calendar day — so the window is
 * derived from the PERSISTED club timezone (`INV-CONFIG-002`), not from the
 * container's `TZ`. The zod schema has already pinned the shape to
 * `^\d{4}-\d{2}-\d{2}$`, so `requireCalendarDate` cannot throw on a bound that
 * reached here.
 */
function startOfInputDate(date: string, zone: ClubTimeZone) {
  return startOfClubDay(requireCalendarDate(date), zone);
}

/** The last instant of that club day, INCLUSIVE — the filter uses `lte`. */
function endOfInputDate(date: string, zone: ClubTimeZone) {
  return endOfClubDayInclusive(requireCalendarDate(date), zone);
}

function eventCategoryForXeroObjectType(xeroObjectType: string) {
  switch (xeroObjectType) {
    case "SUBSCRIPTION":
      return "INVOICE";
    case "CONTACT":
    case "INVOICE":
    case "PAYMENT":
    case "CREDIT_NOTE":
      return xeroObjectType;
    default:
      return null;
  }
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse({
    status: request.nextUrl.searchParams.get("status") ?? undefined,
    eventCategory: request.nextUrl.searchParams.get("eventCategory") ?? undefined,
    source: request.nextUrl.searchParams.get("source") ?? undefined,
    localModel: request.nextUrl.searchParams.get("localModel") ?? undefined,
    localId: request.nextUrl.searchParams.get("localId") ?? undefined,
    resourceId: request.nextUrl.searchParams.get("resourceId") ?? undefined,
    eventType: request.nextUrl.searchParams.get("eventType") ?? undefined,
    createdFrom: request.nextUrl.searchParams.get("createdFrom") ?? undefined,
    createdTo: request.nextUrl.searchParams.get("createdTo") ?? undefined,
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    page: request.nextUrl.searchParams.get("page") ?? undefined,
    pageSize: request.nextUrl.searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const {
    status,
    eventCategory,
    source,
    localModel,
    localId,
    resourceId,
    eventType,
    createdFrom,
    createdTo,
    limit,
    page,
  } = parsed.data;
  const pageSize = parsed.data.pageSize ?? limit;

  try {
    const zone = await clubTimeZone();
    const createdAt: Prisma.DateTimeFilter = {};
    if (createdFrom) createdAt.gte = startOfInputDate(createdFrom, zone);
    if (createdTo) createdAt.lte = endOfInputDate(createdTo, zone);

    const andFilters: Prisma.XeroInboundEventWhereInput[] = [{
      ...(status !== "all" ? { status } : {}),
      ...(eventCategory !== "all" ? { eventCategory } : {}),
      ...(source !== "all" ? { source } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(eventType !== "all" ? { eventType } : {}),
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    }];

    if (localModel && localModel !== "all" && localId) {
      const links = await prisma.xeroObjectLink.findMany({
        where: {
          localModel,
          localId,
          active: true,
        },
        select: {
          xeroObjectType: true,
          xeroObjectId: true,
        },
      });
      const linkTargets: Prisma.XeroInboundEventWhereInput[] = [];
      for (const link of links) {
        const linkedEventCategory = eventCategoryForXeroObjectType(link.xeroObjectType);
        if (!linkedEventCategory) continue;
        linkTargets.push({
          eventCategory: linkedEventCategory,
          resourceId: link.xeroObjectId,
        });
      }

      if (linkTargets.length === 0) {
        return NextResponse.json({ data: [], total: 0, page, pageSize });
      }

      andFilters.push({ OR: linkTargets });
    }

    const where: Prisma.XeroInboundEventWhereInput =
      andFilters.length === 1 ? andFilters[0] : { AND: andFilters };
    const [events, total] = await Promise.all([
      prisma.xeroInboundEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.xeroInboundEvent.count({ where }),
    ]);

    // #2314: the panel renders these hrefs verbatim, so the organisation short
    // code has to be applied HERE — server-side — or a multi-organisation Xero
    // login lands in whichever books the session last used. One cached read per
    // request (12-hour in-process TTL), null when unavailable, which degrades
    // every link to the generic go.xero.com form rather than hiding it.
    const shortCode = await getXeroOrgShortCode();

    return NextResponse.json({
      data: events.map((event) => ({
        ...event,
        xeroObjectUrl:
          event.eventCategory && event.resourceId
            ? buildXeroObjectUrl(event.eventCategory, event.resourceId, {
                shortCode,
              })
            : null,
        canReplay: canReplayXeroInboundEvent(event),
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    logger.error({ err }, "Failed to load Xero inbound events");
    return NextResponse.json(
      { error: "Failed to load Xero inbound events" },
      { status: 500 }
    );
  }
}
