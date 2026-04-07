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
import { sendBookingPendingEmail, sendBookingConfirmedEmail, sendAdminNewBookingAlert } from "@/lib/email";
import { isXeroConnected, createXeroInvoiceForBooking } from "@/lib/xero";
import logger from "@/lib/logger";
import { getSeasonYear } from "@/lib/utils";

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
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingCreate, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Verify member is still active (session JWT may outlive deactivation)
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { active: true, emailVerified: true },
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

  const body = await request.json();
  const parsed = createBookingSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut, guests, notes, promoCode: promoCodeStr, draft } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (checkIn < today) {
    return NextResponse.json({ error: "Cannot book in the past" }, { status: 400 });
  }

  // Issue 10: Subscription check — non-admins must have a PAID subscription for the check-in season
  if (session.user.role !== "ADMIN") {
    const seasonYear = getSeasonYear(checkIn);
    const paidSub = await prisma.memberSubscription.findFirst({
      where: {
        memberId: session.user.id,
        seasonYear,
        status: "PAID",
      },
    });
    if (!paidSub) {
      const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;
      return NextResponse.json(
        {
          error: `Your membership subscription for the ${seasonDisplay} season is not paid. Please contact the club to arrange payment before booking.`,
        },
        { status: 403 }
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
          where: { promoCodeId: promoCode.id, memberId: session.user.id },
        });
      }
      const validationError = validatePromoCodeRules(
        promoCode,
        { memberId: session.user.id },
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
        memberId: session.user.id,
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
        session.user.id,
        discountCents
      );
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
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(1)`
      );

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

      // Calculate current max occupancy across all nights
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

        if (occupiedBeds + guests.length > LODGE_CAPACITY) {
          capacityExceeded = true;
          break;
        }
      }

      if (capacityExceeded) {
        // If this is a member-only booking (CONFIRMED), try bumping PENDING non-member bookings
        if (allMembers || daysUntilCheckIn <= 7) {
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
            throw new Error(
              "Not enough beds available even after checking pending bookings. The lodge is fully booked by members for your selected dates."
            );
          }

          bumpedBookingIds = bumpResult.bumpedBookingIds;
        } else {
          // This is a PENDING (non-member) booking and capacity is full
          throw new Error(
            "Not enough beds available for your dates."
          );
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

        // Check single-use
        let memberRedemptionCount = 0;
        if (promoCode?.singleUse) {
          memberRedemptionCount = await tx.promoRedemption.count({
            where: {
              promoCodeId: promoCode.id,
              memberId: session.user.id,
            },
          });
        }

        const validationError = validatePromoCodeRules(
          promoCode,
          { memberId: session.user.id },
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

      const nonMemberHoldUntil = shouldBePending
        ? new Date(checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000)
        : null;

      const newBooking = await tx.booking.create({
        data: {
          memberId: session.user.id,
          checkIn,
          checkOut,
          status,
          totalPriceCents: price.totalPriceCents,
          discountCents,
          finalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil,
          notes: notes || null,
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
          session.user.id,
          discountCents
        );
      }

      // Zero-dollar CONFIRMED booking: create a SUCCEEDED Payment and set status to PAID.
      // Only applies when the booking would normally be CONFIRMED (all-members or check-in
      // within hold window). PENDING $0 bookings (non-member, far-future) are handled by the
      // cron job so the non-member bumping system remains intact.
      if (finalPriceCents === 0 && status === BookingStatus.CONFIRMED) {
        isZeroDollarConfirmed = true;
        await tx.payment.create({
          data: {
            bookingId: newBooking.id,
            amountCents: 0,
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

    // Send bumped notification emails AFTER transaction commits
    if (bumpedBookingIds.length > 0) {
      const triggeringMember = await prisma.member.findUnique({ where: { id: session.user.id } });
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
      const member = await prisma.member.findUnique({ where: { id: session.user.id } });
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
    const bookingMember = await prisma.member.findUnique({ where: { id: session.user.id } });
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create booking";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
