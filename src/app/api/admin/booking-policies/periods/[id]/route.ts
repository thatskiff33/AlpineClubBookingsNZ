import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const cancellationRuleSchema = z.object({
  daysBeforeStay: z.number().int().min(0),
  refundPercentage: z.number().int().min(0).max(100),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  nonMemberHoldDays: z.number().int().min(1).max(30).optional(),
  cancellationRules: z.array(cancellationRuleSchema).min(1).optional(),
  active: z.boolean().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;
  const period = await prisma.bookingPeriod.findUnique({ where: { id } });

  if (!period) {
    return NextResponse.json({ error: "Period not found" }, { status: 404 });
  }

  return NextResponse.json(period);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const data = updateSchema.parse(body);

    const existing = await prisma.bookingPeriod.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Period not found" }, { status: 404 });
    }

    const startDate = data.startDate ? new Date(data.startDate) : existing.startDate;
    const endDate = data.endDate ? new Date(data.endDate) : existing.endDate;

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
        ...(data.nonMemberHoldDays !== undefined && {
          nonMemberHoldDays: data.nonMemberHoldDays,
        }),
        ...(data.cancellationRules && {
          cancellationRules: data.cancellationRules,
        }),
        ...(data.active !== undefined && { active: data.active }),
      },
    });

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
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id } = await params;

  try {
    await prisma.bookingPeriod.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete booking period" },
      { status: 500 }
    );
  }
}
