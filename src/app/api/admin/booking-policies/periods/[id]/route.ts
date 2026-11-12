import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { parseDateOnly } from "@/lib/date-only";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";
import {
  hasDuplicateCancellationThresholds,
  normalizeCancellationRules,
  normalizeStoredCancellationRules,
} from "@/lib/cancellation-rules";
import { logAudit } from "@/lib/audit";

const cancellationRuleSchema = z.object({
  daysBeforeStay: z.number().int().min(0),
  refundPercentage: z.number().int().min(0).max(100),
  creditRefundPercentage: z.number().int().min(0).max(100).optional(),
  fixedFeeCents: z.number().int().min(0).optional(),
  creditFixedFeeCents: z.number().int().min(0).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  startDate: dateOnlyStringSchema.optional(),
  endDate: dateOnlyStringSchema.optional(),
  nonMemberHoldEnabled: z.boolean().optional(),
  nonMemberHoldDays: z.number().int().min(1).max(365).optional(),
  cancellationRules: z.array(cancellationRuleSchema).min(1).optional(),
  active: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.cancellationRules && hasDuplicateCancellationThresholds(data.cancellationRules)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cancellationRules"],
      message: "Cancellation rule day thresholds must be unique",
    });
  }
});

export async function GET(
  _request: NextRequest,
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

  return NextResponse.json({
    ...period,
    cancellationRules: normalizeStoredCancellationRules(period.cancellationRules),
  });
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

  try {
    const body = await request.json();
    const data = updateSchema.parse(body);

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
    return NextResponse.json(period);
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
  _request: NextRequest,
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
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete booking period" },
      { status: 500 }
    );
  }
}
