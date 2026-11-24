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
import { bookingPeriodUpdateBodySchema } from "@/lib/admin-bookings-schemas/setup";
import {
  ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE,
  ADMIN_SETUP_DELETED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-setup";
import { connectionJson } from "@/lib/mcp-connection-request";

// The body schema lives in admin-bookings-schemas/setup.ts so the AI app
// action `update_booking_period` offers the same fields (ALP-719).

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const period = await prisma.bookingPeriod.findUnique({ where: { id } });

  if (!period) {
    return NextResponse.json({ error: "Period not found" }, { status: 404 });
  }

  return connectionJson(
    request,
    {
      ...period,
      cancellationRules: normalizeStoredCancellationRules(period.cancellationRules),
    },
    ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE,
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    const body = jsonBody.body;
    const data = bookingPeriodUpdateBodySchema.parse(body);

    const existing = await prisma.bookingPeriod.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Period not found" }, { status: 404 });
    }

    const startDate = data.startDate ? parseDateOnly(data.startDate) : existing.startDate;
    const endDate = data.endDate ? parseDateOnly(data.endDate) : existing.endDate;

    if (endDate <= startDate) {
      return NextResponse.json(
        { error: "End date must be after start date" },
        { status: 400 }
      );
    }

    const period = await prisma.bookingPeriod.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.startDate && { startDate }),
        ...(data.endDate && { endDate }),
        ...(data.nonMemberHoldEnabled !== undefined && {
          nonMemberHoldEnabled: data.nonMemberHoldEnabled,
        }),
        ...(data.nonMemberHoldDays !== undefined && {
          nonMemberHoldDays: data.nonMemberHoldDays,
        }),
        ...(data.cancellationRules && {
          cancellationRules: normalizeCancellationRules(
            data.cancellationRules
          ) as unknown as Prisma.InputJsonValue,
        }),
        ...(data.active !== undefined && { active: data.active }),
      },
    });

    logAudit({ action: "booking-period.update", category: "booking", memberId: guard.session.user.id, targetId: id, entityType: "BookingPeriod", entityId: id, details: JSON.stringify({ lodgeId: existing.lodgeId, before: existing, after: period }) });

    revalidatePublicPageContent();
    return connectionJson(request, period, ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update booking period" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  try {
    const existing = await prisma.bookingPeriod.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Period not found" }, { status: 404 });
    await prisma.bookingPeriod.delete({ where: { id } });
    logAudit({ action: "booking-period.delete", category: "booking", memberId: guard.session.user.id, targetId: id, entityType: "BookingPeriod", entityId: id, details: JSON.stringify({ lodgeId: existing.lodgeId, before: existing }) });
    revalidatePublicPageContent();
    return connectionJson(request, { success: true }, ADMIN_SETUP_DELETED_CONNECTION_SHAPE);
  } catch {
    return NextResponse.json(
      { error: "Failed to delete booking period" },
      { status: 500 }
    );
  }
}
