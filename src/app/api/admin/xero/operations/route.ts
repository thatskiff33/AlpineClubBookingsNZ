import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveFailedXeroOperationStates } from "@/lib/xero-admin-failures";
import logger from "@/lib/logger";
import { applyXeroOrgShortCode, buildXeroObjectUrl } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import { buildLocalAdminUrl } from "@/lib/xero-record-links";
import {
  endOfClubDayInclusive,
  requireCalendarDate,
  startOfClubDay,
  type ClubTimeZone,
} from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";

const querySchema = z.object({
  status: z.string().optional().default("all"),
  entityType: z.string().optional().default("all"),
  direction: z.string().optional().default("all"),
  localModel: z.string().trim().optional().default("all"),
  localId: z.string().trim().optional().default(""),
  operationType: z.string().trim().optional().default("all"),
  resourceId: z.string().trim().optional().default(""),
  createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  failureState: z.enum(["all", "ACTIVE", "REPAIRED", "SUPERSEDED"]).optional().default("all"),
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

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse({
    status: request.nextUrl.searchParams.get("status") ?? undefined,
    entityType: request.nextUrl.searchParams.get("entityType") ?? undefined,
    direction: request.nextUrl.searchParams.get("direction") ?? undefined,
    localModel: request.nextUrl.searchParams.get("localModel") ?? undefined,
    localId: request.nextUrl.searchParams.get("localId") ?? undefined,
    operationType: request.nextUrl.searchParams.get("operationType") ?? undefined,
    resourceId: request.nextUrl.searchParams.get("resourceId") ?? undefined,
    createdFrom: request.nextUrl.searchParams.get("createdFrom") ?? undefined,
    createdTo: request.nextUrl.searchParams.get("createdTo") ?? undefined,
    failureState: request.nextUrl.searchParams.get("failureState") ?? undefined,
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
    entityType,
    direction,
    localModel,
    localId,
    operationType,
    resourceId,
    createdFrom,
    createdTo,
    failureState,
    limit,
    page,
  } = parsed.data;
  const pageSize = parsed.data.pageSize ?? limit;

  try {
    const zone = await clubTimeZone();
    const createdAt: Prisma.DateTimeFilter = {};
    if (createdFrom) createdAt.gte = startOfInputDate(createdFrom, zone);
    if (createdTo) createdAt.lte = endOfInputDate(createdTo, zone);

    const where: Prisma.XeroSyncOperationWhereInput = {
      ...(status !== "all" ? { status } : {}),
      ...(entityType !== "all" ? { entityType } : {}),
      ...(direction !== "all" ? { direction } : {}),
      ...(localModel && localModel !== "all" ? { localModel } : {}),
      ...(localId ? { localId } : {}),
      ...(operationType !== "all" ? { operationType } : {}),
      ...(resourceId ? { xeroObjectId: resourceId } : {}),
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    };

    let operations;
    let total: number;

    if (failureState !== "all") {
      const failureCandidates = await prisma.xeroSyncOperation.findMany({
        where: {
          ...where,
          status: "FAILED",
          // Manually-resolved operations are no longer active/repaired/superseded
          // failures, so keep them out of the failure-state filters entirely.
          manuallyResolvedAt: null,
        },
        orderBy: { createdAt: "desc" },
      });
      const failureResolutions = await resolveFailedXeroOperationStates(failureCandidates);
      const filteredFailures = failureCandidates.filter(
        (operation) => failureResolutions.get(operation.id)?.state === failureState
      );
      total = filteredFailures.length;
      operations = filteredFailures.slice((page - 1) * pageSize, page * pageSize);
    } else {
      [operations, total] = await Promise.all([
        prisma.xeroSyncOperation.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.xeroSyncOperation.count({ where }),
      ]);
    }
    const failedOperations = operations.filter((operation) => operation.status === "FAILED");
    const failureResolutions = await resolveFailedXeroOperationStates(failedOperations);

    // #2314: `XeroSyncOperation.xeroObjectUrl` is stored organisation-AGNOSTIC
    // on purpose (a short code baked into a row is wrong the moment the club
    // reconnects to a different Xero organisation), so the short code is applied
    // here at render time — to the stored URL and the rebuilt fallback alike.
    // Null degrades every link to the generic go.xero.com form; it never hides
    // one.
    const shortCode = await getXeroOrgShortCode();

    return NextResponse.json({
      data: operations.map((operation) => ({
        ...operation,
        ...getXeroOperationRetryMeta(operation),
        failureState: failureResolutions.get(operation.id)?.state ?? null,
        failureStateReason: failureResolutions.get(operation.id)?.reason ?? null,
        failureRootKey: failureResolutions.get(operation.id)?.rootKey ?? null,
        xeroObjectUrl: applyXeroOrgShortCode(
          operation.xeroObjectUrl ??
            (operation.xeroObjectType && operation.xeroObjectId
              ? buildXeroObjectUrl(
                  operation.xeroObjectType,
                  operation.xeroObjectId,
                )
              : null),
          { shortCode },
        ),
        localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    logger.error({ err }, "Failed to load Xero sync operations");
    return NextResponse.json(
      { error: "Failed to load Xero sync operations" },
      { status: 500 }
    );
  }
}
