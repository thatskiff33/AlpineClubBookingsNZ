import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { buildXeroObjectUrl } from "@/lib/xero-links";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import { buildLocalAdminUrl } from "@/lib/xero-record-links";

const querySchema = z.object({
  status: z.string().optional().default("all"),
  entityType: z.string().optional().default("all"),
  direction: z.string().optional().default("all"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const parsed = querySchema.safeParse({
    status: request.nextUrl.searchParams.get("status") ?? undefined,
    entityType: request.nextUrl.searchParams.get("entityType") ?? undefined,
    direction: request.nextUrl.searchParams.get("direction") ?? undefined,
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, entityType, direction, limit } = parsed.data;

  try {
    const operations = await prisma.xeroSyncOperation.findMany({
      where: {
        ...(status !== "all" ? { status } : {}),
        ...(entityType !== "all" ? { entityType } : {}),
        ...(direction !== "all" ? { direction } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json({
      data: operations.map((operation) => ({
        ...operation,
        ...getXeroOperationRetryMeta(operation),
        xeroObjectUrl:
          operation.xeroObjectUrl ??
          (operation.xeroObjectType && operation.xeroObjectId
            ? buildXeroObjectUrl(operation.xeroObjectType, operation.xeroObjectId)
            : null),
        localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to load Xero sync operations");
    return NextResponse.json(
      { error: "Failed to load Xero sync operations" },
      { status: 500 }
    );
  }
}
