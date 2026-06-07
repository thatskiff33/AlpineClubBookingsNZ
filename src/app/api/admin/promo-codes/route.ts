import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";

const promoCodeSchema = z.object({
  code: z.string().min(1, "Code is required").transform((s) => s.toUpperCase().trim()),
  description: z.string().optional().nullable(),
  type: z.enum(["PERCENTAGE", "FIXED_AMOUNT", "FREE_NIGHTS", "FIXED_NIGHTLY_PRICE"]),
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
  membersOnly: z.boolean().default(false),
  memberGuestsOnly: z.boolean().default(false),
  xeroItemCode: z.string().trim().min(1).max(30).optional().nullable(),
  xeroAccountCode: z.string().trim().min(1).max(10).optional().nullable(),
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
      allocations: {
        select: {
          id: true,
          discountCents: true,
          priceAdjustmentCents: true,
          memberId: true,
          createdAt: true,
        },
      },
      assignments: {
        include: {
          member: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    promoCodes.map(({ allocations, ...promoCode }) => ({
      ...promoCode,
      redemptions: allocations,
    }))
  );
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
  if (data.type === "FREE_NIGHTS" && (data.freeNightsPerIndividual == null || data.freeNightsPerIndividual <= 0)) {
    return NextResponse.json(
      { error: "Free nights discount requires a freeNightsPerIndividual value greater than 0" },
      { status: 400 }
    );
  }
  if (data.type === "FIXED_NIGHTLY_PRICE" && (data.fixedNightlyPriceCents == null || data.fixedNightlyPriceCents <= 0)) {
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

  if (
    data.bookingStartFrom &&
    data.bookingStartUntil &&
    new Date(data.bookingStartUntil) <= new Date(data.bookingStartFrom)
  ) {
    return NextResponse.json(
      { error: "Booking check-in until must be after booking check-in from" },
      { status: 400 }
    );
  }

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
        freeNightsPerIndividual: data.type === "FREE_NIGHTS" ? data.freeNightsPerIndividual : null,
        lifetimeFreeNightsCap: data.type === "FREE_NIGHTS" ? (data.lifetimeFreeNightsCap ?? null) : null,
        fixedNightlyPriceCents:
          data.type === "FIXED_NIGHTLY_PRICE" ? data.fixedNightlyPriceCents : null,
        fixedNightlyMode:
          data.type === "FIXED_NIGHTLY_PRICE" ? (data.fixedNightlyMode ?? "CAP_ONLY") : null,
        // Nightly value cap only meaningful for PERCENTAGE and FREE_NIGHTS.
        maxNightlyValueCents:
          data.type === "FIXED_AMOUNT" || data.type === "FIXED_NIGHTLY_PRICE"
            ? null
            : (data.maxNightlyValueCents ?? null),
        maxGuestsPerBooking: data.maxGuestsPerBooking ?? null,
        maxRedemptionsTotal: data.maxRedemptionsTotal ?? null,
        maxUniqueMembersTotal: data.maxUniqueMembersTotal ?? null,
        maxUsesPerMember: data.maxUsesPerMember ?? null,
        validFrom: data.validFrom ? new Date(data.validFrom) : null,
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
        bookingStartFrom: data.bookingStartFrom ? new Date(data.bookingStartFrom) : null,
        bookingStartUntil: data.bookingStartUntil ? new Date(data.bookingStartUntil) : null,
        membersOnly: data.membersOnly,
        memberGuestsOnly: data.memberGuestsOnly,
        xeroItemCode: data.xeroItemCode ?? null,
        xeroAccountCode: data.xeroAccountCode ?? null,
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
