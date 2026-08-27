import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { BENEFICIAL_PROMO_ALLOCATION_FILTER } from "@/lib/promo-usage-counts";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

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
  validFrom: dateOnlyString.optional().nullable(),
  validUntil: dateOnlyString.optional().nullable(),
  bookingStartFrom: dateOnlyString.optional().nullable(),
  bookingStartUntil: dateOnlyString.optional().nullable(),
  membersOnly: z.boolean().default(false),
  memberGuestsOnly: z.boolean().default(false),
  // Omitted: defaults per type below (group fixed-nightly codes default to
  // false so they price the whole booking; everything else defaults to true).
  assignedMembersOnlyOwnNights: z.boolean().optional(),
  xeroItemCode: z.string().trim().min(1).max(30).optional().nullable(),
  xeroAccountCode: z.string().trim().min(1).max(10).optional().nullable(),
  active: z.boolean().default(true),
  assignedMemberIds: z.array(z.string()).optional(),
  // Optional per-lodge restriction (multi-lodge phase 6, ADR-001 resolved
  // question 4). Empty/omitted clears the restriction (redeemable at every
  // lodge); a non-empty list restricts redemption to those lodges.
  lodgeIds: z.array(z.string()).max(20).optional(),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(req.url);
  const showArchived = searchParams.get("archived") === "true";

  const promoCodes = await prisma.promoCode.findMany({
    // Internal promos (work party events) are managed from the Work
    // Parties admin page, never the promo code listings.
    where: showArchived
      ? { archivedAt: { not: null }, internal: false }
      : { archivedAt: null, internal: false },
    include: {
      // Beneficial allocations only (#2299): this list is what the card's
      // "Unique members" figure is measured against the maxUniqueMembersTotal
      // cap with, and the cap itself only counts members who actually got
      // something. `_count.redemptions` below carries the unfiltered total for
      // reporting and for the archive-or-delete decision.
      allocations: {
        where: BENEFICIAL_PROMO_ALLOCATION_FILTER,
        select: {
          id: true,
          discountCents: true,
          priceAdjustmentCents: true,
          memberId: true,
          createdAt: true,
        },
      },
      _count: { select: { redemptions: true } },
      assignments: {
        include: {
          member: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
      lodges: { select: { lodgeId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Applications that gave NOBODY a benefit, counted directly (#2299). It
  // cannot be derived by subtracting `currentRedemptions` from the application
  // count: those are different units. `currentRedemptions` counts BENEFICIARY
  // rows, so one application benefiting two members contributes 2 — on a
  // multi-beneficiary code the subtraction can under-report, or go negative and
  // hide the line exactly when there is something to report.
  const benefitFreeGroups = promoCodes.length
    ? await prisma.promoRedemption.groupBy({
        by: ["promoCodeId"],
        where: {
          promoCodeId: { in: promoCodes.map((promoCode) => promoCode.id) },
          allocations: { none: BENEFICIAL_PROMO_ALLOCATION_FILTER },
        },
        _count: { _all: true },
      })
    : [];
  const benefitFreeByPromoCodeId = new Map(
    benefitFreeGroups.map((group) => [group.promoCodeId, group._count._all])
  );

  return NextResponse.json(
    promoCodes.map(({ allocations, lodges, _count, ...promoCode }) => ({
      ...promoCode,
      redemptions: allocations,
      // Every recorded application of the code, including the ones that
      // delivered no benefit and so consume no cap (#2299).
      totalRedemptionCount: _count.redemptions,
      // How many of those applications gave nobody anything.
      benefitFreeRedemptionCount: benefitFreeByPromoCodeId.get(promoCode.id) ?? 0,
      lodgeIds: lodges.map((row) => row.lodgeId),
    }))
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = promoCodeSchema.safeParse(json.body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;

  // Group fixed-nightly codes (not member-guests-only) price the whole booking,
  // so when assigned to members they should default to group scope rather than
  // own-night scoping. Any explicit value from the admin form still wins.
  const isFixedNightlyGroup =
    data.type === "FIXED_NIGHTLY_PRICE" && !data.memberGuestsOnly;
  const assignedMembersOnlyOwnNights =
    data.assignedMembersOnlyOwnNights ?? !isFixedNightlyGroup;

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

  if (data.validFrom && data.validUntil && data.validUntil < data.validFrom) {
    return NextResponse.json(
      { error: "Valid until must be on or after valid from" },
      { status: 400 }
    );
  }

  if (
    data.bookingStartFrom &&
    data.bookingStartUntil &&
    data.bookingStartUntil <= data.bookingStartFrom
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

  const requestedLodgeIds = [...new Set(data.lodgeIds ?? [])];
  if (requestedLodgeIds.length > 0) {
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
        validFrom: data.validFrom ? parseDateOnly(data.validFrom) : null,
        validUntil: data.validUntil ? parseDateOnly(data.validUntil) : null,
        bookingStartFrom: data.bookingStartFrom ? parseDateOnly(data.bookingStartFrom) : null,
        bookingStartUntil: data.bookingStartUntil ? parseDateOnly(data.bookingStartUntil) : null,
        membersOnly: data.membersOnly,
        memberGuestsOnly: data.memberGuestsOnly,
        assignedMembersOnlyOwnNights,
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

    if (requestedLodgeIds.length > 0) {
      await tx.promoCodeLodge.createMany({
        data: requestedLodgeIds.map((lodgeId) => ({
          promoCodeId: created.id,
          lodgeId,
        })),
      });
    }

    const withRelations = await tx.promoCode.findUnique({
      where: { id: created.id },
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
    action: "promo.create",
    category: "booking",
    memberId: session.user.id,
    targetId: promoCode!.id,
    entityType: "PromoCode",
    entityId: promoCode!.id,
    details: `Created promo code: ${data.code}${data.assignedMemberIds?.length ? ` (assigned to ${data.assignedMemberIds.length} member(s))` : ""}${requestedLodgeIds.length ? ` (restricted to ${requestedLodgeIds.length} lodge(s))` : ""}`,
  });

  return NextResponse.json(promoCode, { status: 201 });
}
