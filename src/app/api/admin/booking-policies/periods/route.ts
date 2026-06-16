import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import {
  normalizeCancellationRules,
  normalizeStoredCancellationRules,
} from "@/lib/cancellation-rules";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const cancellationRuleSchema = z.object({
  daysBeforeStay: z.number().int().min(0),
  refundPercentage: z.number().int().min(0).max(100),
  creditRefundPercentage: z.number().int().min(0).max(100).optional(),
  fixedFeeCents: z.number().int().min(0).optional(),
  creditFixedFeeCents: z.number().int().min(0).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  startDate: dateOnlyString,
  endDate: dateOnlyString,
  nonMemberHoldDays: z.number().int().min(1).max(365),
  cancellationRules: z.array(cancellationRuleSchema).min(1),
  active: z.boolean().optional(),
});

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const periods = await prisma.bookingPeriod.findMany({
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
  const guard = await requireAdmin();
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

    const period = await prisma.bookingPeriod.create({
      data: {
        name: data.name,
        startDate,
        endDate,
        nonMemberHoldDays: data.nonMemberHoldDays,
        cancellationRules: normalizeCancellationRules(
          data.cancellationRules
        ) as unknown as Prisma.InputJsonValue,
        active: data.active ?? true,
      },
    });

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
