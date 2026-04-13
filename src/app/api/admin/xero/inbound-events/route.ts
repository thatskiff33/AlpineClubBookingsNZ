import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { buildXeroObjectUrl } from "@/lib/xero-links";

const querySchema = z.object({
  status: z.string().optional().default("all"),
  eventCategory: z.string().optional().default("all"),
  source: z.string().optional().default("all"),
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
    eventCategory: request.nextUrl.searchParams.get("eventCategory") ?? undefined,
    source: request.nextUrl.searchParams.get("source") ?? undefined,
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, eventCategory, source, limit } = parsed.data;

  try {
    const events = await prisma.xeroInboundEvent.findMany({
      where: {
        ...(status !== "all" ? { status } : {}),
        ...(eventCategory !== "all" ? { eventCategory } : {}),
        ...(source !== "all" ? { source } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json({
      data: events.map((event) => ({
        ...event,
        xeroObjectUrl:
          event.eventCategory && event.resourceId
            ? buildXeroObjectUrl(event.eventCategory, event.resourceId)
            : null,
        canReplay: event.status !== "PROCESSING",
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to load Xero inbound events");
    return NextResponse.json(
      { error: "Failed to load Xero inbound events" },
      { status: 500 }
    );
  }
}
