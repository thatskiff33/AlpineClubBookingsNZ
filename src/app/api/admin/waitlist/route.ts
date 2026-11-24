import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { z } from "zod";
import {
  getFinanceBookingMetricsWindowDayCount,
  MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS,
} from "@/lib/finance-booking-metrics";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { adminWaitlistQuerySchema } from "@/lib/admin-bookings-schemas/review-queues";
import {
  ADMIN_WAITLIST_CONNECTION_SHAPE,
  type AdminWaitlistAnswer,
  type AdminWaitlistEntry,
} from "@/lib/connection-shapes/bookings-review-queues";
import { connectionJson } from "@/lib/mcp-connection-request";
import { getWaitlistOfferEmailDeliveries } from "@/lib/waitlist-offer-email-visibility";
import {
  WAITLIST_QUEUE_ORDER_BY,
  getDisplayedWaitlistPositions,
} from "@/lib/waitlist-queue";

// The fields are the catalogue's (`adminWaitlistQuerySchema`); the window rule
// reads the finance metrics module, a server one, so it is added here.
const querySchema = adminWaitlistQuerySchema
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

/**
 * GET /api/admin/waitlist — waitlisted and offered bookings, in queue order.
 * Also the AI app action `list_waitlist` (ALP-719).
 */
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
        // #3369: the owner may be an Organisation; bookingOwner() reads both.
        organisation: { select: { name: true, email: true } },
        guests: { select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true } },
      },
      // The queue's own join order (#5402).
      orderBy: WAITLIST_QUEUE_ORDER_BY,
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.booking.count({ where }),
  ]);

  const offerEmailDeliveries = await getWaitlistOfferEmailDeliveries(bookings);
  // #5402: each row's true place in its lodge's queue, read now from the whole
  // queue (not this page or the date filter), in one batch. Null for an offered
  // or silenced entry.
  const positions = await getDisplayedWaitlistPositions(prisma, bookings);

  const entries = bookings.map((b): AdminWaitlistEntry => ({
    id: b.id,
    memberName: `${bookingOwner(b).member.firstName} ${bookingOwner(b).member.lastName}`,
    memberEmail: bookingOwner(b).member.email,
    // #3480: the owner's member id, `null` for an organisation. `member.id` is
    // `undefined` there, which JSON drops, so the page could not tell "no member
    // page" from a shape it did not expect; `memberId` says it in so many words.
    memberId: bookingOwner(b).memberId,
    checkIn: formatDateOnly(b.checkIn),
    checkOut: formatDateOnly(b.checkOut),
    guestCount: b.guests.length,
    guests: b.guests,
    status: b.status,
    waitlistPosition: positions.get(b.id) ?? null,
    waitlistOfferedAt: b.waitlistOfferedAt?.toISOString() || null,
    waitlistOfferExpiresAt: b.waitlistOfferExpiresAt?.toISOString() || null,
    requiresAdminReview: b.requiresAdminReview,
    adminReviewReason: b.adminReviewReason,
    // #1769b: the client needs the review outcome to know whether a force-confirm
    // will land PAID (and email the member). A no-adult booking that is already
    // APPROVED force-confirms to PAID despite requiresAdminReview still being set.
    adminReviewStatus: b.adminReviewStatus,
    // #2258: a silenced WAITLISTED entry never gets an offer, and no send is
    // attempted so there is no EmailLog row to infer it from. The board needs
    // the flag itself, or such an entry looks like an ordinary one that is
    // simply waiting its turn.
    noEmails: b.noEmails,
    finalPriceCents: b.finalPriceCents,
    createdAt: b.createdAt.toISOString(),
    offerEmailDelivery: offerEmailDeliveries.get(b.id) ?? null,
  }));

  const answer: AdminWaitlistAnswer = { data: entries, entries, page, pageSize, total };
  return connectionJson(request, answer, ADMIN_WAITLIST_CONNECTION_SHAPE);
}
