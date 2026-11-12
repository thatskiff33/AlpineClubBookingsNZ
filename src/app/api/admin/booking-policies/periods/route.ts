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

const createSchema = z.object({
  name: z.string().min(1).max(200),
  startDate: dateOnlyStringSchema,
  endDate: dateOnlyStringSchema,
  nonMemberHoldEnabled: z.boolean().optional(),
  nonMemberHoldDays: z.number().int().min(1).max(365),
  cancellationRules: z.array(cancellationRuleSchema).min(1),
  active: z.boolean().optional(),
  // Per-lodge override partition (ADR-001 resolved question 3). Omitted =
  // club-wide (null lodgeId). Any rows for a lodge REPLACE the club-wide
  // set at runtime for that lodge.
  lodgeId: z.string().min(1).optional(),
}).superRefine((data, ctx) => {
  if (hasDuplicateCancellationThresholds(data.cancellationRules)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cancellationRules"],
      message: "Cancellation rule day thresholds must be unique",
    });
  }
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  // Exact partition, not null-tolerant: null rows are the club-wide rules
  // and a lodge's rows are its override set (replace, never merge).
  const lodgeId = request.nextUrl.searchParams.get("lodgeId")
  const periods = await prisma.bookingPeriod.findMany({
    where: { lodgeId: lodgeId ?? null },
    orderBy: { startDate: "asc" },
  });

  return NextResponse.json(
    periods.map((period) => ({
      ...period,
      cancellationRules: normalizeStoredCancellationRules(period.cancellationRules),
    }))
  );
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  try {
    const body = await request.json();
    const data = createSchema.parse(body);

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
    return NextResponse.json(period, { status: 201 });
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
