import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

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
  validFrom: dateOnlyStringSchema.optional().nullable(),
  validUntil: dateOnlyStringSchema.optional().nullable(),
  bookingStartFrom: dateOnlyStringSchema.optional().nullable(),
  bookingStartUntil: dateOnlyStringSchema.optional().nullable(),
  membersOnly: z.boolean().optional(),
  memberGuestsOnly: z.boolean().optional(),
  assignedMembersOnlyOwnNights: z.boolean().optional(),
  xeroItemCode: z.string().trim().min(1).max(30).optional().nullable(),
  xeroAccountCode: z.string().trim().min(1).max(10).optional().nullable(),
  active: z.boolean().optional(),
  assignedMemberIds: z.array(z.string()).optional(),
  // Optional per-lodge restriction (multi-lodge phase 6, ADR-001 resolved
  // question 4). Empty/omitted clears the restriction (redeemable at every
  // lodge); a non-empty list restricts redemption to those lodges.
  lodgeIds: z.array(z.string()).max(20).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
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
      lodges: { select: { lodgeId: true } },
    },
  });

  // Internal promos (work party events) are managed from the Work Parties
  // admin page; hide them from the promo-code admin entirely.
  if (!promoCode || promoCode.internal) {
    return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  }

  const { allocations, lodges, ...promoCodeResponse } = promoCode;
  return NextResponse.json({
    ...promoCodeResponse,
    redemptions: allocations,
    lodgeIds: lodges.map((row) => row.lodgeId),
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing || existing.internal) {
    return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  }

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = updatePromoCodeSchema.safeParse(json.body);

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

  const requestedLodgeIds = data.lodgeIds !== undefined
    ? [...new Set(data.lodgeIds)]
    : undefined;
  if (requestedLodgeIds && requestedLodgeIds.length > 0) {
    const foundLodges = await prisma.lodge.findMany({
      where: { id: { in: requestedLodgeIds } },
      select: { id: true },
    });
    if (foundLodges.length !== requestedLodgeIds.length) {
      return NextResponse.json(
        { error: "One or more lodgeIds do not exist" },
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

  const effectiveValidFrom =
    data.validFrom !== undefined
      ? data.validFrom
      : existing.validFrom ? formatDateOnly(existing.validFrom) : null;
  const effectiveValidUntil =
    data.validUntil !== undefined
      ? data.validUntil
      : existing.validUntil ? formatDateOnly(existing.validUntil) : null;

  if (effectiveValidFrom && effectiveValidUntil && effectiveValidUntil < effectiveValidFrom) {
    return NextResponse.json(
      { error: "Valid until must be on or after valid from" },
      { status: 400 }
    );
  }

  const effectiveBookingStartFrom =
    data.bookingStartFrom !== undefined
      ? data.bookingStartFrom
      : existing.bookingStartFrom ? formatDateOnly(existing.bookingStartFrom) : null;
  const effectiveBookingStartUntil =
    data.bookingStartUntil !== undefined
      ? data.bookingStartUntil
      : existing.bookingStartUntil ? formatDateOnly(existing.bookingStartUntil) : null;

  if (
    effectiveBookingStartFrom &&
    effectiveBookingStartUntil &&
    effectiveBookingStartUntil <= effectiveBookingStartFrom
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
          validFrom: data.validFrom ? parseDateOnly(data.validFrom) : null,
        }),
        ...(data.validUntil !== undefined && {
          validUntil: data.validUntil ? parseDateOnly(data.validUntil) : null,
        }),
        ...(data.bookingStartFrom !== undefined && {
          bookingStartFrom: data.bookingStartFrom ? parseDateOnly(data.bookingStartFrom) : null,
        }),
        ...(data.bookingStartUntil !== undefined && {
          bookingStartUntil: data.bookingStartUntil ? parseDateOnly(data.bookingStartUntil) : null,
        }),
        ...(data.membersOnly !== undefined && { membersOnly: data.membersOnly }),
        ...(data.memberGuestsOnly !== undefined && { memberGuestsOnly: data.memberGuestsOnly }),
        ...(data.assignedMembersOnlyOwnNights !== undefined && {
          assignedMembersOnlyOwnNights: data.assignedMembersOnlyOwnNights,
        }),
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

    if (requestedLodgeIds !== undefined) {
      await tx.promoCodeLodge.deleteMany({ where: { promoCodeId: id } });
      if (requestedLodgeIds.length > 0) {
        await tx.promoCodeLodge.createMany({
          data: requestedLodgeIds.map((lodgeId) => ({
            promoCodeId: id,
            lodgeId,
          })),
        });
      }
    }

    const withRelations = await tx.promoCode.findUnique({
      where: { id },
      include: {
        assignments: {
          include: {
            member: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
        lodges: { select: { lodgeId: true } },
      },
    });
    if (!withRelations) return null;
    const { lodges, ...rest } = withRelations;
    return { ...rest, lodgeIds: lodges.map((row) => row.lodgeId) };
  });

  logAudit({
    action: "promo.update",
    category: "booking",
    memberId: session.user.id,
    targetId: id,
    entityType: "PromoCode",
    entityId: id,
    details: `Updated promo code: ${existing.code}${requestedLodgeIds !== undefined ? ` (lodge restriction: ${requestedLodgeIds.length ? `${requestedLodgeIds.length} lodge(s)` : "cleared"})` : ""}`,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  // Archive-or-delete is decided on REDEMPTION rows, not allocation rows
  // (#2299). `PromoRedemption.promoCodeId` is an onDelete: Restrict foreign
  // key, so a code that was applied to a booking cannot be hard-deleted even
  // when the application delivered no benefit and therefore wrote no
  // allocation row — counting allocations here would offer a delete that the
  // database then refuses.
  const existing = await prisma.promoCode.findUnique({
    where: { id },
    include: { _count: { select: { redemptions: true } } },
  });

  if (!existing || existing.internal) {
    return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  }

  if (existing._count.redemptions > 0) {
    await prisma.promoCode.update({
      where: { id },
      data: { archivedAt: new Date(), active: false },
    });

    logAudit({
      action: "promo.archive",
      category: "booking",
      memberId: session.user.id,
      targetId: id,
      entityType: "PromoCode",
      entityId: id,
      details: `Archived promo code: ${existing.code} (${existing._count.redemptions} redemption(s))`,
    });

    return NextResponse.json({ success: true, archived: true });
  }

  await prisma.promoCode.delete({ where: { id } });

  logAudit({
    action: "promo.delete",
    category: "booking",
    memberId: session.user.id,
    targetId: id,
    entityType: "PromoCode",
    entityId: id,
    details: `Deleted promo code: ${existing.code}`,
  });

  return NextResponse.json({ success: true, archived: false });
}

export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing || existing.internal) {
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
    category: "booking",
    memberId: session.user.id,
    targetId: id,
    entityType: "PromoCode",
    entityId: id,
    details: `Restored archived promo code: ${existing.code}`,
  });

  return NextResponse.json({ success: true });
}
