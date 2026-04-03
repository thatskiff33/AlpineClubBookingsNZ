import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateBookingPrice, type SeasonRateData } from "@/lib/pricing";
import { LODGE_CAPACITY } from "@/lib/capacity";
import { BookingStatus } from "@prisma/client";
import { eachDayOfInterval, subDays } from "date-fns";
import { z } from "zod";
import {
  bumpPendingBookings,
  sendBumpedNotifications,
} from "@/lib/bumping";

const createBookingSchema = z.object({
  checkIn: z.string().transform((s) => new Date(s)),
  checkOut: z.string().transform((s) => new Date(s)),
  guests: z
    .array(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]),
        isMember: z.boolean(),
      })
    )
    .min(1),
  notes: z.string().optional(),
});

export async function POST(request: NextRequest) {
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

  const { checkIn, checkOut, guests, notes } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (checkIn < today) {
    return NextResponse.json({ error: "Cannot book in the past" }, { status: 400 });
  }

  const hasNonMembers = guests.some((g) => !g.isMember);
  const allMembers = !hasNonMembers;
  const daysUntilCheckIn = Math.ceil(
    (checkIn.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  const shouldBePending = hasNonMembers && daysUntilCheckIn > 7;
  const status = shouldBePending ? BookingStatus.PENDING : BookingStatus.CONFIRMED;

  let bumpedBookingIds: string[] = [];

  try {
    const booking = await prisma.$transaction(async (tx) => {
      // Advisory lock based on date range to prevent double-booking
      const lockKey =
        checkIn.getFullYear() * 10000 +
        (checkIn.getMonth() + 1) * 100 +
        checkIn.getDate();
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(${lockKey})`
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
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] },
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

      const nonMemberHoldUntil = shouldBePending
        ? new Date(checkIn.getTime() - 7 * 24 * 60 * 60 * 1000)
        : null;

      const newBooking = await tx.booking.create({
        data: {
          memberId: session.user.id,
          checkIn,
          checkOut,
          status,
          totalPriceCents: price.totalPriceCents,
          discountCents: 0,
          finalPriceCents: price.totalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil,
          notes: notes || null,
          guests: {
            create: guests.map((g, i) => ({
              firstName: g.firstName,
              lastName: g.lastName,
              ageTier: g.ageTier,
              isMember: g.isMember,
              priceCents: price.guests[i].priceCents,
            })),
          },
        },
        include: { guests: true },
      });

      return newBooking;
    });

    // Send bumped notification emails AFTER transaction commits
    if (bumpedBookingIds.length > 0) {
      sendBumpedNotifications(bumpedBookingIds).catch((err) =>
        console.error("Failed to send bump notifications:", err)
      );
    }

    return NextResponse.json(booking, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create booking";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
