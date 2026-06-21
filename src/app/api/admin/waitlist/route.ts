import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { z } from "zod";
import {
  getFinanceBookingMetricsWindowDayCount,
  MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS,
} from "@/lib/finance-booking-metrics";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { getWaitlistOfferEmailDeliveries } from "@/lib/waitlist-offer-email-visibility";

const isoDateParam = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const querySchema = z
  .object({
    from: isoDateParam.optional(),
    to: isoDateParam.optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .superRefine((value, context) => {
    for (const field of ["from", "to"] as const) {
      if (!value[field]) continue;
      try {
        getFinanceBookingMetricsWindowDayCount(value[field], value[field]);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: error instanceof Error ? error.message : "Invalid date",
        });
      }
    }

    if (!value.from || !value.to) {
      return;
    }

    try {
      const dayCount = getFinanceBookingMetricsWindowDayCount(value.from, value.to);
      if (dayCount > MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["to"],
          message: `Date window cannot exceed ${MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS} days`,
        });
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: error instanceof Error ? error.message : "Invalid date window",
      });
    }
  });

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { from, to, page, pageSize } = parsed.data;

  const where: Record<string, unknown> = {
    status: { in: [BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED] },
  };

  if (from || to) {
    if (from) {
      where.checkIn = { ...((where.checkIn as object) || {}), gte: parseDateOnly(from) };
    }
    if (to) {
      where.checkOut = { ...((where.checkOut as object) || {}), lte: parseDateOnly(to) };
    }
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        member: { select: { id: true, firstName: true, lastName: true, email: true } },
        guests: { select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true } },
      },
      orderBy: { createdAt: "asc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.booking.count({ where }),
  ]);

  const offerEmailDeliveries = await getWaitlistOfferEmailDeliveries(bookings);

  const entries = bookings.map((b) => ({
    id: b.id,
    memberName: `${b.member.firstName} ${b.member.lastName}`,
    memberEmail: b.member.email,
    memberId: b.member.id,
    checkIn: formatDateOnly(b.checkIn),
    checkOut: formatDateOnly(b.checkOut),
    guestCount: b.guests.length,
    guests: b.guests,
    status: b.status,
    waitlistPosition: b.waitlistPosition,
    waitlistOfferedAt: b.waitlistOfferedAt?.toISOString() || null,
    waitlistOfferExpiresAt: b.waitlistOfferExpiresAt?.toISOString() || null,
    requiresAdminReview: b.requiresAdminReview,
    adminReviewReason: b.adminReviewReason,
    finalPriceCents: b.finalPriceCents,
    createdAt: b.createdAt.toISOString(),
    offerEmailDelivery: offerEmailDeliveries.get(b.id) ?? null,
  }));

  return NextResponse.json({ data: entries, entries, page, pageSize, total });
}
