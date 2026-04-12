import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";

const promoCodeSchema = z.object({
  code: z.string().min(1, "Code is required").transform((s) => s.toUpperCase().trim()),
  description: z.string().optional().nullable(),
  type: z.enum(["PERCENTAGE", "FIXED_AMOUNT", "FREE_NIGHTS"]),
  valueCents: z.number().int().min(0).optional().nullable(),
  percentOff: z.number().int().min(0).max(100).optional().nullable(),
  freeNights: z.number().int().min(0).optional().nullable(),
  maxRedemptions: z.number().int().min(1).optional().nullable(),
  validFrom: z.string().optional().nullable(),
  validUntil: z.string().optional().nullable(),
  bookingStartFrom: z.string().optional().nullable(),
  bookingStartUntil: z.string().optional().nullable(),
  membersOnly: z.boolean().default(false),
  singleUse: z.boolean().default(false),
  active: z.boolean().default(true),
  assignedMemberIds: z.array(z.string()).optional(),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { searchParams } = new URL(req.url);
  const showArchived = searchParams.get("archived") === "true";

  const promoCodes = await prisma.promoCode.findMany({
    where: showArchived ? { archivedAt: { not: null } } : { archivedAt: null },
    include: {
      redemptions: {
        select: { id: true, discountCents: true, createdAt: true },
      },
      assignments: {
        include: {
          member: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(promoCodes);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await req.json();
  const parsed = promoCodeSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;

  // Validate type-specific fields
  if (data.type === "PERCENTAGE" && (data.percentOff == null || data.percentOff <= 0)) {
    return NextResponse.json(
      { error: "Percentage discount requires a percentOff value greater than 0" },
      { status: 400 }
    );
  }
  if (data.type === "FIXED_AMOUNT" && (data.valueCents == null || data.valueCents <= 0)) {
    return NextResponse.json(
      { error: "Fixed amount discount requires a valueCents value greater than 0" },
      { status: 400 }
    );
  }
  if (data.type === "FREE_NIGHTS" && (data.freeNights == null || data.freeNights <= 0)) {
    return NextResponse.json(
      { error: "Free nights discount requires a freeNights value greater than 0" },
      { status: 400 }
    );
  }

  if (data.validFrom && data.validUntil && new Date(data.validUntil) <= new Date(data.validFrom)) {
    return NextResponse.json(
      { error: "Valid until must be after valid from" },
      { status: 400 }
    );
  }

  // Check for duplicate code
  const existing = await prisma.promoCode.findUnique({
    where: { code: data.code },
  });
  if (existing) {
    return NextResponse.json(
      { error: `A promo code with code "${data.code}" already exists` },
      { status: 400 }
    );
  }

  const promoCode = await prisma.$transaction(async (tx) => {
    const created = await tx.promoCode.create({
      data: {
        code: data.code,
        description: data.description || null,
        type: data.type,
        valueCents: data.type === "FIXED_AMOUNT" ? data.valueCents : null,
        percentOff: data.type === "PERCENTAGE" ? data.percentOff : null,
        freeNights: data.type === "FREE_NIGHTS" ? data.freeNights : null,
        maxRedemptions: data.maxRedemptions || null,
        validFrom: data.validFrom ? new Date(data.validFrom) : null,
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
        bookingStartFrom: data.bookingStartFrom ? new Date(data.bookingStartFrom) : null,
        bookingStartUntil: data.bookingStartUntil ? new Date(data.bookingStartUntil) : null,
        membersOnly: data.membersOnly,
        singleUse: data.singleUse,
        active: data.active,
      },
    });

    if (data.assignedMemberIds && data.assignedMemberIds.length > 0) {
      await tx.promoCodeAssignment.createMany({
        data: data.assignedMemberIds.map((memberId) => ({
          promoCodeId: created.id,
          memberId,
        })),
      });
    }

    return tx.promoCode.findUnique({
      where: { id: created.id },
      include: {
        assignments: {
          include: {
            member: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    });
  });

  logAudit({
    action: "promo.create",
    memberId: session.user.id,
    targetId: promoCode!.id,
    details: `Created promo code: ${data.code}${data.assignedMemberIds?.length ? ` (assigned to ${data.assignedMemberIds.length} member(s))` : ""}`,
  });

  return NextResponse.json(promoCode, { status: 201 });
}
