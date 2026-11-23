import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { parseDateOnly } from "@/lib/date-only";
import {
  normalizeCancellationRules,
  normalizeStoredCancellationRules,
} from "@/lib/cancellation-rules";
import { logAudit } from "@/lib/audit";
import {
  adminPolicyLodgeQuerySchema,
  bookingPeriodCreateBodySchema,
} from "@/lib/admin-bookings-schemas/setup";
import {
  ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE,
  ADMIN_BOOKING_PERIOD_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-setup";
import { connectionJson, connectionListJson } from "@/lib/mcp-connection-request";

// The schemas live in admin-bookings-schemas/setup.ts so the AI app actions
// `list_booking_periods` and `create_booking_period` offer the same fields
// (ALP-719).

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  // Exact partition, not null-tolerant: null rows are the club-wide rules
  // and a lodge's rows are its override set (replace, never merge).
  // A string or nothing always parses; the 400 is only a backstop.
  const query = adminPolicyLodgeQuerySchema.safeParse({
    lodgeId: request.nextUrl.searchParams.get("lodgeId") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: query.error.issues[0]?.message }, { status: 400 });
  }
  const periods = await prisma.bookingPeriod.findMany({
    where: { lodgeId: query.data.lodgeId ?? null },
    orderBy: { startDate: "asc" },
  });

  const answer = periods.map((period) => ({
    ...period,
    cancellationRules: normalizeStoredCancellationRules(period.cancellationRules),
  }));
  // The browser keeps the bare array; a connection gets it under `periods`.
  return connectionListJson(request, answer, "periods", ADMIN_BOOKING_PERIOD_LIST_CONNECTION_SHAPE);
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    const body = jsonBody.body;
    const data = bookingPeriodCreateBodySchema.parse(body);

    const startDate = parseDateOnly(data.startDate);
    const endDate = parseDateOnly(data.endDate);

    if (endDate <= startDate) {
      return NextResponse.json(
        { error: "End date must be after start date" },
        { status: 400 }
      );
    }

    if (data.lodgeId) {
      const lodge = await prisma.lodge.findUnique({
        where: { id: data.lodgeId },
        select: { id: true, active: true },
      });
      if (!lodge || !lodge.active) {
        return NextResponse.json(
          { error: "Lodge not found or not active" },
          { status: 400 }
        );
      }
    }

    const period = await prisma.bookingPeriod.create({
      data: {
        name: data.name,
        startDate,
        endDate,
        nonMemberHoldEnabled: data.nonMemberHoldEnabled ?? true,
        nonMemberHoldDays: data.nonMemberHoldDays,
        cancellationRules: normalizeCancellationRules(
          data.cancellationRules
        ) as unknown as Prisma.InputJsonValue,
        active: data.active ?? true,
        lodgeId: data.lodgeId ?? null,
      },
    });

    logAudit({ action: "booking-period.create", category: "booking", memberId: guard.session.user.id, targetId: period.id, entityType: "BookingPeriod", entityId: period.id, details: JSON.stringify({ lodgeId: period.lodgeId, after: period }) });

    revalidatePublicPageContent();
    return connectionJson(request, period, ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create booking period" },
      { status: 500 }
    );
  }
}
