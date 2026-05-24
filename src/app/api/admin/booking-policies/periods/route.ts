import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  normalizeCancellationRules,
  normalizeStoredCancellationRules,
} from "@/lib/cancellation-rules";

const cancellationRuleSchema = z.object({
  daysBeforeStay: z.number().int().min(0),
  refundPercentage: z.number().int().min(0).max(100),
  creditRefundPercentage: z.number().int().min(0).max(100).optional(),
  fixedFeeCents: z.number().int().min(0).optional(),
  creditFixedFeeCents: z.number().int().min(0).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  startDate: z.string(),
  endDate: z.string(),
  nonMemberHoldDays: z.number().int().min(1).max(30),
  cancellationRules: z.array(cancellationRuleSchema).min(1),
  active: z.boolean().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

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
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const body = await request.json();
    const data = createSchema.parse(body);

    const startDate = new Date(data.startDate);
    const endDate = new Date(data.endDate);

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
