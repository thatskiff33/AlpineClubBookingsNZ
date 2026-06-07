import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";

const updatePromoCodeSchema = z.object({
  code: z.string().min(1).transform((s) => s.toUpperCase().trim()).optional(),
  description: z.string().optional().nullable(),
  type: z.enum(["PERCENTAGE", "FIXED_AMOUNT", "FREE_NIGHTS", "FIXED_NIGHTLY_PRICE"]).optional(),
  valueCents: z.number().int().min(0).optional().nullable(),
  percentOff: z.number().int().min(0).max(100).optional().nullable(),
  freeNightsPerIndividual: z.number().int().min(0).optional().nullable(),
  lifetimeFreeNightsCap: z.number().int().min(1).optional().nullable(),
  fixedNightlyPriceCents: z.number().int().min(0).optional().nullable(),
  fixedNightlyMode: z.enum(["SET_PRICE", "CAP_ONLY"]).optional().nullable(),
  maxNightlyValueCents: z.number().int().min(0).optional().nullable(),
  maxGuestsPerBooking: z.number().int().min(1).optional().nullable(),
  maxRedemptionsTotal: z.number().int().min(1).optional().nullable(),
  maxUniqueMembersTotal: z.number().int().min(1).optional().nullable(),
  maxUsesPerMember: z.number().int().min(1).optional().nullable(),
  validFrom: z.string().optional().nullable(),
  validUntil: z.string().optional().nullable(),
  bookingStartFrom: z.string().optional().nullable(),
  bookingStartUntil: z.string().optional().nullable(),
  membersOnly: z.boolean().optional(),
  memberGuestsOnly: z.boolean().optional(),
  xeroItemCode: z.string().trim().min(1).max(30).optional().nullable(),
  xeroAccountCode: z.string().trim().min(1).max(10).optional().nullable(),
  active: z.boolean().optional(),
  assignedMemberIds: z.array(z.string()).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const promoCode = await prisma.promoCode.findUnique({
    where: { id },
    include: {
      allocations: {
        include: {
          booking: { select: { id: true, checkIn: true, checkOut: true } },
          member: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
      assignments: {
        include: {
          member: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
    },
  });

  if (!promoCode) {
    return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  }

  const { allocations, ...promoCodeResponse } = promoCode;
  return NextResponse.json({
    ...promoCodeResponse,
    redemptions: allocations,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = updatePromoCodeSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;

  if (data.code && data.code !== existing.code) {
    const duplicate = await prisma.promoCode.findUnique({
      where: { code: data.code },
    });
    if (duplicate) {
      return NextResponse.json(
        { error: `A promo code with code "${data.code}" already exists` },
        { status: 400 }
      );
    }
  }

  const type = data.type || existing.type;

  const effectivePercentOff = data.percentOff !== undefined ? data.percentOff : existing.percentOff;
  const effectiveValueCents = data.valueCents !== undefined ? data.valueCents : existing.valueCents;
  const effectiveFreeNights =
    data.freeNightsPerIndividual !== undefined
      ? data.freeNightsPerIndividual
      : existing.freeNightsPerIndividual;
  const effectiveFixedNightlyPriceCents =
    data.fixedNightlyPriceCents !== undefined
      ? data.fixedNightlyPriceCents
      : existing.fixedNightlyPriceCents;

  if (type === "PERCENTAGE" && (effectivePercentOff == null || effectivePercentOff <= 0)) {
    return NextResponse.json(
      { error: "Percentage discount requires a percentOff value greater than 0" },
      { status: 400 }
    );
  }
  if (type === "FIXED_AMOUNT" && (effectiveValueCents == null || effectiveValueCents <= 0)) {
    return NextResponse.json(
      { error: "Fixed amount discount requires a valueCents value greater than 0" },
      { status: 400 }
    );
  }
  if (type === "FREE_NIGHTS" && (effectiveFreeNights == null || effectiveFreeNights <= 0)) {
    return NextResponse.json(
      { error: "Free nights discount requires a freeNightsPerIndividual value greater than 0" },
      { status: 400 }
    );
  }
  if (type === "FIXED_NIGHTLY_PRICE" && (effectiveFixedNightlyPriceCents == null || effectiveFixedNightlyPriceCents <= 0)) {
    return NextResponse.json(
      { error: "Fixed nightly price requires a fixedNightlyPriceCents value greater than 0" },
      { status: 400 }
    );
  }

  if (data.validFrom && data.validUntil && new Date(data.validUntil) <= new Date(data.validFrom)) {
    return NextResponse.json(
      { error: "Valid until must be after valid from" },
      { status: 400 }
    );
  }

  const effectiveBookingStartFrom =
    data.bookingStartFrom !== undefined
      ? data.bookingStartFrom
      : existing.bookingStartFrom?.toISOString() ?? null;
  const effectiveBookingStartUntil =
    data.bookingStartUntil !== undefined
      ? data.bookingStartUntil
      : existing.bookingStartUntil?.toISOString() ?? null;

  if (
    effectiveBookingStartFrom &&
    effectiveBookingStartUntil &&
    new Date(effectiveBookingStartUntil) <= new Date(effectiveBookingStartFrom)
  ) {
    return NextResponse.json(
      { error: "Booking check-in until must be after booking check-in from" },
      { status: 400 }
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.promoCode.update({
      where: { id },
      data: {
        ...(data.code !== undefined && { code: data.code }),
        ...(data.description !== undefined && { description: data.description || null }),
        ...(data.type !== undefined && { type: data.type }),
        ...(data.type !== undefined || data.valueCents !== undefined
          ? { valueCents: type === "FIXED_AMOUNT" ? (data.valueCents ?? existing.valueCents) : null }
          : {}),
        ...(data.type !== undefined || data.percentOff !== undefined
          ? { percentOff: type === "PERCENTAGE" ? (data.percentOff ?? existing.percentOff) : null }
          : {}),
        ...(data.type !== undefined || data.freeNightsPerIndividual !== undefined
          ? {
              freeNightsPerIndividual:
                type === "FREE_NIGHTS"
                  ? (data.freeNightsPerIndividual ?? existing.freeNightsPerIndividual)
                  : null,
            }
          : {}),
        ...(data.type !== undefined || data.lifetimeFreeNightsCap !== undefined
          ? {
              lifetimeFreeNightsCap:
                type === "FREE_NIGHTS"
                  ? (data.lifetimeFreeNightsCap !== undefined
                      ? data.lifetimeFreeNightsCap
                      : existing.lifetimeFreeNightsCap)
                  : null,
            }
          : {}),
        ...(data.type !== undefined || data.fixedNightlyPriceCents !== undefined
          ? {
              fixedNightlyPriceCents:
                type === "FIXED_NIGHTLY_PRICE"
                  ? (data.fixedNightlyPriceCents ?? existing.fixedNightlyPriceCents)
                  : null,
            }
          : {}),
        ...(data.type !== undefined || data.fixedNightlyMode !== undefined
          ? {
              fixedNightlyMode:
                type === "FIXED_NIGHTLY_PRICE"
                  ? (data.fixedNightlyMode ?? existing.fixedNightlyMode ?? "CAP_ONLY")
                  : null,
            }
          : {}),
        ...(data.type !== undefined || data.maxNightlyValueCents !== undefined ? {
          // Nightly cap is meaningful only for PERCENTAGE and FREE_NIGHTS.
          maxNightlyValueCents:
            type === "FIXED_AMOUNT" || type === "FIXED_NIGHTLY_PRICE"
              ? null
              : (data.maxNightlyValueCents !== undefined
                  ? data.maxNightlyValueCents
                  : existing.maxNightlyValueCents),
        } : {}),
        ...(data.maxGuestsPerBooking !== undefined && { maxGuestsPerBooking: data.maxGuestsPerBooking }),
        ...(data.maxRedemptionsTotal !== undefined && { maxRedemptionsTotal: data.maxRedemptionsTotal }),
        ...(data.maxUniqueMembersTotal !== undefined && { maxUniqueMembersTotal: data.maxUniqueMembersTotal }),
        ...(data.maxUsesPerMember !== undefined && { maxUsesPerMember: data.maxUsesPerMember }),
        ...(data.validFrom !== undefined && {
          validFrom: data.validFrom ? new Date(data.validFrom) : null,
        }),
        ...(data.validUntil !== undefined && {
          validUntil: data.validUntil ? new Date(data.validUntil) : null,
        }),
        ...(data.bookingStartFrom !== undefined && {
          bookingStartFrom: data.bookingStartFrom ? new Date(data.bookingStartFrom) : null,
        }),
        ...(data.bookingStartUntil !== undefined && {
          bookingStartUntil: data.bookingStartUntil ? new Date(data.bookingStartUntil) : null,
        }),
        ...(data.membersOnly !== undefined && { membersOnly: data.membersOnly }),
        ...(data.memberGuestsOnly !== undefined && { memberGuestsOnly: data.memberGuestsOnly }),
        ...(data.xeroItemCode !== undefined && { xeroItemCode: data.xeroItemCode }),
        ...(data.xeroAccountCode !== undefined && { xeroAccountCode: data.xeroAccountCode }),
        ...(data.active !== undefined && { active: data.active }),
      },
    });

    if (data.assignedMemberIds !== undefined) {
      await tx.promoCodeAssignment.deleteMany({ where: { promoCodeId: id } });
      if (data.assignedMemberIds.length > 0) {
        await tx.promoCodeAssignment.createMany({
          data: data.assignedMemberIds.map((memberId) => ({
            promoCodeId: id,
            memberId,
          })),
        });
      }
    }

    return tx.promoCode.findUnique({
      where: { id },
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
    action: "promo.update",
    memberId: session.user.id,
    targetId: id,
    details: `Updated promo code: ${existing.code}`,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const existing = await prisma.promoCode.findUnique({
    where: { id },
    include: { allocations: { select: { id: true } } },
  });

  if (!existing) {
    return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  }

  if (existing.allocations.length > 0) {
    await prisma.promoCode.update({
      where: { id },
      data: { archivedAt: new Date(), active: false },
    });

    logAudit({
      action: "promo.archive",
      memberId: session.user.id,
      targetId: id,
      details: `Archived promo code: ${existing.code} (${existing.allocations.length} redemption(s))`,
    });

    return NextResponse.json({ success: true, archived: true });
  }

  await prisma.promoCode.delete({ where: { id } });

  logAudit({
    action: "promo.delete",
    memberId: session.user.id,
    targetId: id,
    details: `Deleted promo code: ${existing.code}`,
  });

  return NextResponse.json({ success: true, archived: false });
}

export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  }

  if (!existing.archivedAt) {
    return NextResponse.json({ error: "Promo code is not archived" }, { status: 400 });
  }

  await prisma.promoCode.update({
    where: { id },
    data: { archivedAt: null },
  });

  logAudit({
    action: "promo.restore",
    memberId: session.user.id,
    targetId: id,
    details: `Restored archived promo code: ${existing.code}`,
  });

  return NextResponse.json({ success: true });
}
