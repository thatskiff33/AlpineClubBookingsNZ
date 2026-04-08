import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import { calculateBookingPrice, type SeasonRateData } from "@/lib/pricing";
import { LODGE_CAPACITY } from "@/lib/capacity";
import { BookingStatus } from "@prisma/client";
import { eachDayOfInterval, subDays } from "date-fns";
import { z } from "zod";
import { PromoCodeType } from "@prisma/client";
import {
  bumpPendingBookings,
  sendBumpedNotifications,
} from "@/lib/bumping";
import {
  validatePromoCodeRules,
  redeemPromoCode,
} from "@/lib/promo";
import { calculatePromoDiscount } from "@/lib/pricing";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { sendBookingPendingEmail, sendBookingConfirmedEmail, sendAdminNewBookingAlert, sendWaitlistConfirmationEmail } from "@/lib/email";
import { getWaitlistPosition, updateWaitlistPositions } from "@/lib/waitlist";
import { isXeroConnected, createXeroInvoiceForBooking } from "@/lib/xero";
import { getMemberCreditBalance, applyCreditToBooking } from "@/lib/member-credit";
import logger from "@/lib/logger";
import { getSeasonYear } from "@/lib/utils";
import { logAudit } from "@/lib/audit";

const createBookingSchema = z.object({
  checkIn: z.string().transform((s) => new Date(s)),
  checkOut: z.string().transform((s) => new Date(s)),
  guests: z
    .array(
      z.object({
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]),
        isMember: z.boolean(),
        memberId: z.string().optional(),
      })
    )
    .min(1)
    .max(29),
  notes: z.string().max(500).optional(),
  promoCode: z.string().max(50).optional(),
  draft: z.boolean().optional(),
  waitlist: z.boolean().optional(),
  expectedArrivalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]0$/).optional(),
  applyCreditCents: z.number().int().min(0).optional(),
  forMemberId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingCreate, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = createBookingSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Resolve effective member: admin booking on behalf of another member
  let effectiveMemberId = session.user.id;
  let isOnBehalf = false;

  // Admins must always use forMemberId to book on behalf — they cannot book for themselves
  if (session.user.role === "ADMIN" && !parsed.data.forMemberId) {
    return NextResponse.json(
      { error: "Admins must book on behalf of a member. Use the admin booking page.", code: "ADMIN_MUST_BOOK_ON_BEHALF" },
      { status: 403 }
    );
  }

  if (parsed.data.forMemberId) {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Only admins can book on behalf of another member" }, { status: 403 });
    }
    if (parsed.data.forMemberId === session.user.id) {
      return NextResponse.json({ error: "Admins cannot book for themselves — use the admin booking page to book on behalf of a member" }, { status: 400 });
    }
    const targetMember = await prisma.member.findUnique({
      where: { id: parsed.data.forMemberId },
      select: { active: true },
    });
    if (!targetMember?.active) {
      return NextResponse.json({ error: "Target member not found or inactive" }, { status: 400 });
    }
    effectiveMemberId = parsed.data.forMemberId;
    isOnBehalf = true;
  }

  // Verify the effective member (booking owner) is still active
  if (!isOnBehalf) {
    const member = await prisma.member.findUnique({
      where: { id: session.user.id },
      select: { active: true, emailVerified: true, xeroContactId: true },
    });
    if (!member?.active) {
      return NextResponse.json(
        { error: "Account is deactivated" },
        { status: 403 }
      );
    }

    // Gate: email must be verified before booking
    if (!member?.emailVerified) {
      return NextResponse.json({ error: "Email not verified" }, { status: 403 });
    }

    // Gate: member must be linked to a Xero contact
    if (!member?.xeroContactId && session.user.role !== "ADMIN") {
      return NextResponse.json(
        {
          error: "Your account is not yet linked to Xero. Please contact the club administrator to link your membership before booking.",
          code: "XERO_CONTACT_REQUIRED",
        },
        { status: 403 }
      );
    }
  }

  const { checkIn, checkOut, guests, notes, promoCode: promoCodeStr, draft, waitlist, expectedArrivalTime } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  // Validate and verify guest memberIds and pricing attributes
  const guestMemberIds = guests.map((g) => g.memberId).filter(Boolean) as string[];
  if (guestMemberIds.length > 0) {
    // Authorization: memberIds must be self or family group members
    // Admin booking on-behalf skips this restriction — admin can add any member as guest
    if (!isOnBehalf) {
      const allowedIds = new Set<string>([session.user.id]);
      const familyLinks = await prisma.familyGroupMember.findMany({
        where: { memberId: session.user.id },
        select: { familyGroupId: true },
      });
      if (familyLinks.length > 0) {
        const groupIds = familyLinks.map((l) => l.familyGroupId);
        const familyMembers = await prisma.familyGroupMember.findMany({
          where: { familyGroupId: { in: groupIds } },
          select: { memberId: true },
        });
        for (const fm of familyMembers) allowedIds.add(fm.memberId);
      }
      for (const id of guestMemberIds) {
        if (!allowedIds.has(id)) {
          return NextResponse.json({ error: "Invalid guest member reference" }, { status: 403 });
        }
      }
    }

    // Verify isMember and ageTier from DB for linked members (don't trust client)
    const linkedMembers = await prisma.member.findMany({
      where: { id: { in: guestMemberIds }, active: true },
      select: { id: true, ageTier: true },
    });
    const memberMap = new Map(linkedMembers.map((m) => [m.id, m]));
    for (const g of guests) {
      if (g.memberId) {
        const dbMember = memberMap.get(g.memberId);
        if (!dbMember) {
          return NextResponse.json({ error: "Linked member is inactive or not found" }, { status: 400 });
        }
        g.isMember = true;
        g.ageTier = dbMember.ageTier;
      } else {
        // Guests without a memberId cannot claim member pricing
        g.isMember = false;
      }
    }
  } else {
    // No linked members — enforce isMember=false for all guests
    for (const g of guests) {
      g.isMember = false;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (checkIn < today) {
    return NextResponse.json({ error: "Cannot book in the past" }, { status: 400 });
  }

  // Issue 10: Subscription check — non-admins must have a PAID subscription for the check-in season
  // Admin booking on-behalf skips this (admin is trusted to make this decision)
  if (session.user.role !== "ADMIN") {
    const seasonYear = getSeasonYear(checkIn);
    const paidSub = await prisma.memberSubscription.findFirst({
      where: {
        memberId: effectiveMemberId,
        seasonYear,
        status: "PAID",
      },
    });
    if (!paidSub) {
      // Fetch subscription to get invoice URL for member payment
      const subscription = await prisma.memberSubscription.findFirst({
        where: { memberId: effectiveMemberId, seasonYear },
        orderBy: { updatedAt: "desc" },
      });
      const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;
      return NextResponse.json(
        {
          error: `Your membership subscription for the ${seasonDisplay} season is not paid. Please contact the club to arrange payment before booking.`,
          code: "SUBSCRIPTION_REQUIRED",
          invoiceUrl: subscription?.xeroOnlineInvoiceUrl ?? null,
          invoiceNumber: subscription?.xeroInvoiceNumber ?? null,
        },
        { status: 403 }
      );
    }
  }

  // Minimum stay policy validation (skip for admins)
  if (session.user.role !== "ADMIN") {
    const { validateMinimumStay, formatViolationsDetail } = await import("@/lib/booking-policies");
    const stayResult = await validateMinimumStay(checkIn, checkOut);
    if (!stayResult.valid) {
      return NextResponse.json(
        {
          error: "Booking does not meet minimum stay requirement",
          details: formatViolationsDetail(stayResult.violations),
          code: "MINIMUM_STAY_VIOLATION",
          violations: stayResult.violations,
        },
        { status: 400 }
      );
    }
  }

  // Issue 7: Draft booking — skip capacity, payment, Xero, emails
  if (draft) {
    const draftExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    // Fetch seasons for pricing
    const seasons = await prisma.season.findMany({
      where: {
        active: true,
        startDate: { lte: checkOut },
        endDate: { gte: checkIn },
      },
      include: { rates: true },
    });

    const seasonData: SeasonRateData[] = seasons.map((s) => ({
      seasonId: s.id,
      startDate: s.startDate,
      endDate: s.endDate,
      rates: s.rates.map((r) => ({
        ageTier: r.ageTier,
        isMember: r.isMember,
        pricePerNightCents: r.pricePerNightCents,
      })),
    }));

    const guestInputs = guests.map((g) => ({
      ageTier: g.ageTier,
      isMember: g.isMember,
    }));

    const price = calculateBookingPrice(checkIn, checkOut, guestInputs, seasonData);

    let discountCents = 0;
    let promoCodeRecord: { id: string; type: string; valueCents: number | null; percentOff: number | null; freeNights: number | null } | null = null;

    if (promoCodeStr) {
      const normalizedCode = promoCodeStr.toUpperCase().trim();
      const promoCode = await prisma.promoCode.findUnique({ where: { code: normalizedCode } });
      let memberRedemptionCount = 0;
      if (promoCode?.singleUse) {
        memberRedemptionCount = await prisma.promoRedemption.count({
          where: { promoCodeId: promoCode.id, memberId: effectiveMemberId },
        });
      }
      const validationError = validatePromoCodeRules(
        promoCode,
        { memberId: effectiveMemberId },
        new Date(),
        memberRedemptionCount
      );
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      const allPerNightRates = price.guests.flatMap((g) => g.perNightCents);
      discountCents = calculatePromoDiscount(
        {
          type: promoCode!.type,
          valueCents: promoCode!.valueCents,
          percentOff: promoCode!.percentOff,
          freeNights: promoCode!.freeNights,
        },
        price.totalPriceCents,
        allPerNightRates
      );
      promoCodeRecord = promoCode!;
    }

    const finalPriceCents = price.totalPriceCents - discountCents;
    const hasNonMembers = guests.some((g) => !g.isMember);

    const newBooking = await prisma.booking.create({
      data: {
        memberId: effectiveMemberId,
        checkIn,
        checkOut,
        status: BookingStatus.DRAFT,
        totalPriceCents: price.totalPriceCents,
        discountCents,
        finalPriceCents,
        hasNonMembers,
        nonMemberHoldUntil: null,
        draftExpiresAt,
        notes: notes || null,
        expectedArrivalTime: expectedArrivalTime || null,
        createdById: isOnBehalf ? session.user.id : null,
        guests: {
          create: guests.map((g, i) => ({
            firstName: g.firstName,
            lastName: g.lastName,
            ageTier: g.ageTier,
            isMember: g.isMember,
            memberId: g.memberId || null,
            priceCents: price.guests[i].priceCents,
          })),
        },
      },
      include: { guests: true },
    });

    if (promoCodeRecord && discountCents > 0) {
      await redeemPromoCode(
        prisma,
        promoCodeRecord.id,
        newBooking.id,
        effectiveMemberId,
        discountCents
      );
    }

    if (isOnBehalf) {
      logAudit({
        action: "booking.created_on_behalf",
        memberId: session.user.id,
        targetId: newBooking.id,
        details: `Admin created draft booking on behalf of member ${effectiveMemberId}`,
      });
    }

    return NextResponse.json(newBooking, { status: 201 });
  }

  const hasNonMembers = guests.some((g) => !g.isMember);
  const allMembers = !hasNonMembers;
  const holdDays = hasNonMembers ? await getNonMemberHoldDays(checkIn) : 7;
  const daysUntilCheckIn = Math.ceil(
    (checkIn.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  const shouldBePending = hasNonMembers && daysUntilCheckIn > holdDays;
  const status = shouldBePending ? BookingStatus.PENDING : BookingStatus.CONFIRMED;

  let bumpedBookingIds: string[] = [];
  let isZeroDollarConfirmed = false;

  try {
    const booking = await prisma.$transaction(async (tx) => {
      // Advisory lock to serialize all booking creation and prevent double-booking.
      // Uses a fixed key so overlapping date ranges are protected.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      // Check capacity
      const nights = eachDayOfInterval({
        start: checkIn,
        end: subDays(checkOut, 1),
      });

      const overlappingBookings = await tx.booking.findMany({
        where: {
          checkIn: { lt: checkOut },
          checkOut: { gt: checkIn },
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID, BookingStatus.PENDING] },
        },
        include: { guests: true },
      });

      // Calculate per-night occupancy
      const nightDetails: Array<{ date: string; occupiedBeds: number; availableBeds: number }> = [];
      let capacityExceeded = false;
      for (const night of nights) {
        const nightTime = night.getTime();
        let occupiedBeds = 0;

        for (const b of overlappingBookings) {
          const bCheckIn = new Date(b.checkIn).getTime();
          const bCheckOut = new Date(b.checkOut).getTime();
          if (nightTime >= bCheckIn && nightTime < bCheckOut) {
            occupiedBeds += b.guests.length;
          }
        }

        nightDetails.push({
          date: night.toISOString().split("T")[0],
          occupiedBeds,
          availableBeds: LODGE_CAPACITY - occupiedBeds,
        });

        if (occupiedBeds + guests.length > LODGE_CAPACITY) {
          capacityExceeded = true;
        }
      }

      if (capacityExceeded) {
        // If this is a member-only booking (CONFIRMED), try bumping PENDING non-member bookings
        if (allMembers || daysUntilCheckIn <= holdDays) {
          // Only member-only bookings can trigger bumping
          if (!allMembers) {
            // Non-member booking within 7 days can't bump anyone
            throw new Error(
              "Not enough beds available for your dates. Non-member bookings cannot bump other bookings."
            );
          }

          const bumpResult = await bumpPendingBookings(
            checkIn,
            checkOut,
            guests.length,
            tx
          );

          if (!bumpResult.capacityRestored) {
            // Even bumping couldn't free enough space — offer waitlist
            const fullNights = nightDetails.filter((n) => n.availableBeds < guests.length);
            throw Object.assign(new Error("CAPACITY_EXCEEDED"), {
              code: "CAPACITY_EXCEEDED",
              fullNights: fullNights.map((n) => n.date),
              canWaitlist: true,
            });
          }

          bumpedBookingIds = bumpResult.bumpedBookingIds;
        } else {
          // Capacity is full — offer waitlist
          const fullNights = nightDetails.filter((n) => n.availableBeds < guests.length);
          throw Object.assign(new Error("CAPACITY_EXCEEDED"), {
            code: "CAPACITY_EXCEEDED",
            fullNights: fullNights.map((n) => n.date),
            canWaitlist: true,
          });
        }
      }

      // Fetch seasons for pricing
      const seasons = await tx.season.findMany({
        where: {
          active: true,
          startDate: { lte: checkOut },
          endDate: { gte: checkIn },
        },
        include: { rates: true },
      });

      const seasonData: SeasonRateData[] = seasons.map((s) => ({
        seasonId: s.id,
        startDate: s.startDate,
        endDate: s.endDate,
        rates: s.rates.map((r) => ({
          ageTier: r.ageTier,
          isMember: r.isMember,
          pricePerNightCents: r.pricePerNightCents,
        })),
      }));

      const guestInputs = guests.map((g) => ({
        ageTier: g.ageTier,
        isMember: g.isMember,
      }));

      const price = calculateBookingPrice(checkIn, checkOut, guestInputs, seasonData);

      // Handle promo code if provided
      let discountCents = 0;
      let promoCodeRecord: { id: string; type: string; valueCents: number | null; percentOff: number | null; freeNights: number | null } | null = null;

      if (promoCodeStr) {
        const normalizedCode = promoCodeStr.toUpperCase().trim();
        // Lock the promo code row to prevent concurrent over-redemption
        const lockedRows = await tx.$queryRaw<Array<{ id: string; active: boolean; validFrom: Date | null; validUntil: Date | null; maxRedemptions: number | null; currentRedemptions: number; membersOnly: boolean; singleUse: boolean; type: PromoCodeType; valueCents: number | null; percentOff: number | null; freeNights: number | null; code: string }>>`
          SELECT * FROM "PromoCode" WHERE "code" = ${normalizedCode} FOR UPDATE
        `;
        const promoCode = lockedRows.length > 0 ? lockedRows[0] : null;

        // Check single-use (against effective member, not admin)
        let memberRedemptionCount = 0;
        if (promoCode?.singleUse) {
          memberRedemptionCount = await tx.promoRedemption.count({
            where: {
              promoCodeId: promoCode.id,
              memberId: effectiveMemberId,
            },
          });
        }

        const validationError = validatePromoCodeRules(
          promoCode,
          { memberId: effectiveMemberId },
          new Date(),
          memberRedemptionCount
        );

        if (validationError) {
          throw new Error(validationError);
        }

        // Collect all per-night rates for FREE_NIGHTS calculation
        const allPerNightRates = price.guests.flatMap((g) => g.perNightCents);

        discountCents = calculatePromoDiscount(
          {
            type: promoCode!.type,
            valueCents: promoCode!.valueCents,
            percentOff: promoCode!.percentOff,
            freeNights: promoCode!.freeNights,
          },
          price.totalPriceCents,
          allPerNightRates
        );

        promoCodeRecord = promoCode!;
      }

      const finalPriceCents = price.totalPriceCents - discountCents;

      // Apply account credit if requested
      let creditAppliedCents = 0;
      const requestedCredit = parsed.data.applyCreditCents || 0;
      if (requestedCredit > 0 && status === BookingStatus.CONFIRMED) {
        const creditBalance = await getMemberCreditBalance(effectiveMemberId, tx);
        if (requestedCredit > creditBalance) {
          throw new Error(`Insufficient credit: ${creditBalance} cents available, ${requestedCredit} requested`);
        }
        if (requestedCredit > finalPriceCents) {
          throw new Error(`Credit amount (${requestedCredit}) exceeds booking price (${finalPriceCents})`);
        }
        creditAppliedCents = requestedCredit;
      }

      const effectivePriceCents = finalPriceCents - creditAppliedCents;

      const nonMemberHoldUntil = shouldBePending
        ? new Date(checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000)
        : null;

      const newBooking = await tx.booking.create({
        data: {
          memberId: effectiveMemberId,
          checkIn,
          checkOut,
          status,
          totalPriceCents: price.totalPriceCents,
          discountCents,
          finalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil,
          notes: notes || null,
          expectedArrivalTime: expectedArrivalTime || null,
          createdById: isOnBehalf ? session.user.id : null,
          guests: {
            create: guests.map((g, i) => ({
              firstName: g.firstName,
              lastName: g.lastName,
              ageTier: g.ageTier,
              isMember: g.isMember,
              memberId: g.memberId || null,
              priceCents: price.guests[i].priceCents,
            })),
          },
        },
        include: { guests: true },
      });

      // Create promo redemption record
      if (promoCodeRecord && discountCents > 0) {
        await redeemPromoCode(
          tx,
          promoCodeRecord.id,
          newBooking.id,
          effectiveMemberId,
          discountCents
        );
      }

      // Apply credit deduction within the transaction
      if (creditAppliedCents > 0) {
        await applyCreditToBooking(
          effectiveMemberId,
          creditAppliedCents,
          newBooking.id,
          tx
        );
      }

      // Zero-dollar or credit-covered CONFIRMED booking: create a SUCCEEDED Payment and set status to PAID.
      // Only applies when the booking would normally be CONFIRMED (all-members or check-in
      // within hold window). PENDING $0 bookings (non-member, far-future) are handled by the
      // cron job so the non-member bumping system remains intact.
      if (effectivePriceCents === 0 && status === BookingStatus.CONFIRMED) {
        isZeroDollarConfirmed = true;
        await tx.payment.create({
          data: {
            bookingId: newBooking.id,
            amountCents: 0,
            creditAppliedCents,
            status: "SUCCEEDED",
          },
        });
        await tx.booking.update({
          where: { id: newBooking.id },
          data: { status: BookingStatus.PAID },
        });
        newBooking.status = BookingStatus.PAID;
      }

      return newBooking;
    });

    // Audit log for on-behalf bookings
    if (isOnBehalf) {
      logAudit({
        action: "booking.created_on_behalf",
        memberId: session.user.id,
        targetId: booking.id,
        details: `Admin created booking on behalf of member ${effectiveMemberId}`,
      });
    }

    // Send bumped notification emails AFTER transaction commits
    if (bumpedBookingIds.length > 0) {
      const triggeringMember = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
      const triggeringName = triggeringMember
        ? `${triggeringMember.firstName} ${triggeringMember.lastName}`
        : "Unknown";
      sendBumpedNotifications(bumpedBookingIds, triggeringName).catch((err) =>
        logger.error({ err }, "Failed to send bump notifications")
      );
    }

    // Send confirmation email + create Xero invoice for zero-dollar CONFIRMED bookings
    if (isZeroDollarConfirmed) {
      try {
        const fullBooking = await prisma.booking.findUnique({
          where: { id: booking.id },
          include: { member: true, guests: true, promoRedemption: { include: { promoCode: true } } },
        });
        if (fullBooking) {
          sendBookingConfirmedEmail(
            fullBooking.member.email,
            fullBooking.member.firstName,
            fullBooking.checkIn,
            fullBooking.checkOut,
            fullBooking.guests.length,
            fullBooking.finalPriceCents,
            fullBooking.discountCents > 0
              ? { discountCents: fullBooking.discountCents, promoCode: fullBooking.promoRedemption?.promoCode?.code }
              : undefined
          ).catch((err) => logger.error({ err, bookingId: booking.id }, "Failed to send confirmation email for $0 booking"));

          isXeroConnected().then((connected) => {
            if (connected) {
              createXeroInvoiceForBooking(booking.id).catch((err) =>
                logger.error({ err, bookingId: booking.id }, "Failed to create Xero invoice for $0 booking")
              );
            }
          }).catch((err) => logger.error({ err }, "Failed to check Xero connection for $0 booking"));
        }
      } catch (err) {
        logger.error({ err, bookingId: booking.id }, "Error in post-creation handling for $0 booking");
      }
    }

    // Send pending booking email if applicable
    if (booking.status === BookingStatus.PENDING && booking.nonMemberHoldUntil) {
      const member = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
      if (member) {
        sendBookingPendingEmail(
          member.email,
          member.firstName,
          booking.checkIn,
          booking.checkOut,
          booking.guests.length,
          booking.nonMemberHoldUntil
        ).catch((err) => logger.error({ err }, "Failed to send pending booking email"));
      }
    }

    // N-02: Send admin alert for new booking (fire-and-forget)
    const bookingMember = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
    if (bookingMember) {
      sendAdminNewBookingAlert({
        memberName: `${bookingMember.firstName} ${bookingMember.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guestCount: booking.guests.length,
        totalCents: booking.finalPriceCents,
        status: booking.status,
      }).catch((err) => logger.error({ err }, "Failed to send admin new booking alert"));
    }

    return NextResponse.json(booking, { status: 201 });
  } catch (err: unknown) {
    // Handle capacity exceeded — offer waitlist or create waitlisted booking
    const capErr = err as { code?: string; fullNights?: string[]; canWaitlist?: boolean };
    if (capErr.code === "CAPACITY_EXCEEDED" && capErr.canWaitlist) {
      if (!waitlist) {
        // Return 409 so the UI can offer the waitlist option
        return NextResponse.json(
          {
            error: "The lodge is fully booked on some of your requested dates.",
            code: "CAPACITY_EXCEEDED",
            fullNights: capErr.fullNights,
            canWaitlist: true,
          },
          { status: 409 }
        );
      }

      // Create a WAITLISTED booking
      try {
        return await createWaitlistedBooking({
          effectiveMemberId,
          checkIn,
          checkOut,
          guests,
          notes,
          promoCodeStr,
          expectedArrivalTime,
          isOnBehalf,
          sessionUserId: session!.user.id,
        });
      } catch (waitlistErr) {
        logger.error({ err: waitlistErr }, "Failed to create waitlisted booking");
        return NextResponse.json({ error: "Failed to create waitlisted booking" }, { status: 500 });
      }
    }

    const message = err instanceof Error ? err.message : "Failed to create booking";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Create a WAITLISTED booking when capacity is full and the user opts in.
 */
async function createWaitlistedBooking(params: {
  effectiveMemberId: string;
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ firstName: string; lastName: string; ageTier: string; isMember: boolean; memberId?: string }>;
  notes?: string;
  promoCodeStr?: string;
  expectedArrivalTime?: string;
  isOnBehalf: boolean;
  sessionUserId: string;
}) {
  const { effectiveMemberId, checkIn, checkOut, guests, notes, promoCodeStr, expectedArrivalTime, isOnBehalf, sessionUserId } = params;

  // Calculate pricing (locked in at waitlist time)
  const seasons = await prisma.season.findMany({
    where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
    include: { rates: true },
  });

  const seasonData: SeasonRateData[] = seasons.map((s) => ({
    seasonId: s.id,
    startDate: s.startDate,
    endDate: s.endDate,
    rates: s.rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));

  const guestInputs = guests.map((g) => ({
    ageTier: g.ageTier as "ADULT" | "YOUTH" | "CHILD",
    isMember: g.isMember,
  }));

  const price = calculateBookingPrice(checkIn, checkOut, guestInputs, seasonData);

  let discountCents = 0;
  let promoCodeRecord: { id: string; type: string; valueCents: number | null; percentOff: number | null; freeNights: number | null } | null = null;

  if (promoCodeStr) {
    const normalizedCode = promoCodeStr.toUpperCase().trim();
    const promoCode = await prisma.promoCode.findUnique({ where: { code: normalizedCode } });
    let memberRedemptionCount = 0;
    if (promoCode?.singleUse) {
      memberRedemptionCount = await prisma.promoRedemption.count({
        where: { promoCodeId: promoCode.id, memberId: effectiveMemberId },
      });
    }
    const validationError = validatePromoCodeRules(
      promoCode,
      { memberId: effectiveMemberId },
      new Date(),
      memberRedemptionCount
    );
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    const allPerNightRates = price.guests.flatMap((g) => g.perNightCents);
    discountCents = calculatePromoDiscount(
      {
        type: promoCode!.type,
        valueCents: promoCode!.valueCents,
        percentOff: promoCode!.percentOff,
        freeNights: promoCode!.freeNights,
      },
      price.totalPriceCents,
      allPerNightRates
    );
    promoCodeRecord = promoCode!;
  }

  const finalPriceCents = price.totalPriceCents - discountCents;
  const hasNonMembers = guests.some((g) => !g.isMember);

  const newBooking = await prisma.booking.create({
    data: {
      memberId: effectiveMemberId,
      checkIn,
      checkOut,
      status: BookingStatus.WAITLISTED,
      totalPriceCents: price.totalPriceCents,
      discountCents,
      finalPriceCents,
      hasNonMembers,
      nonMemberHoldUntil: null,
      notes: notes || null,
      expectedArrivalTime: expectedArrivalTime || null,
      createdById: isOnBehalf ? sessionUserId : null,
      guests: {
        create: guests.map((g, i) => ({
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier as "ADULT" | "YOUTH" | "CHILD",
          isMember: g.isMember,
          memberId: g.memberId || null,
          priceCents: price.guests[i].priceCents,
        })),
      },
    },
    include: { guests: true },
  });

  if (promoCodeRecord && discountCents > 0) {
    await redeemPromoCode(
      prisma,
      promoCodeRecord.id,
      newBooking.id,
      effectiveMemberId,
      discountCents
    );
  }

  // Calculate and save waitlist position
  const position = await getWaitlistPosition(newBooking.id);
  await prisma.booking.update({
    where: { id: newBooking.id },
    data: { waitlistPosition: position },
  });
  newBooking.waitlistPosition = position;

  // Send emails (fire-and-forget)
  const member = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
  if (member) {
    sendWaitlistConfirmationEmail(
      member.email,
      member.firstName,
      checkIn,
      checkOut,
      newBooking.guests.length,
      position
    ).catch((err) => logger.error({ err }, "Failed to send waitlist confirmation email"));

    sendAdminNewBookingAlert({
      memberName: `${member.firstName} ${member.lastName}`,
      checkIn: newBooking.checkIn,
      checkOut: newBooking.checkOut,
      guestCount: newBooking.guests.length,
      totalCents: newBooking.finalPriceCents,
      status: newBooking.status,
    }).catch((err) => logger.error({ err }, "Failed to send admin alert for waitlisted booking"));
  }

  logAudit({
    action: "booking.waitlisted",
    memberId: effectiveMemberId,
    targetId: newBooking.id,
    details: `Booking added to waitlist at position #${position}`,
  });

  return NextResponse.json(newBooking, { status: 201 });
}
