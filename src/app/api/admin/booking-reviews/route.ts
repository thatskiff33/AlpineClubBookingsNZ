import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { buildBookingReviewListWhere } from "@/lib/booking-request-queue-where";
import {
  bookingReviewReasonCodes,
  bookingReviewReasonSentences,
} from "@/lib/booking-review";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { status, page, pageSize } = parsed.data;
  // Shared with the Approvals tab's pending badge (#4969).
  const where = buildBookingReviewListWhere(status);

  const [rows, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        member: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        adminReviewedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        guests: {
          select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true },
        },
      },
      orderBy: [{ adminReviewStatus: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.booking.count({ where }),
  ]);

  /*
    #2364: a booking can carry two review hazards at once — the minors-only rule
    and the adult-member hosting policy — and they are stored separately on
    purpose, because several booking paths wipe the minors columns the moment
    that rule stops applying. An admin deciding one of them needs to see the
    other, so each row is answered with both, as structured CODES plus their
    sentences rather than one overloaded prose field.

    The QUERY is deliberately unchanged: it still selects on `adminReviewStatus`,
    so this endpoint lists exactly the bookings it always did. Listing a
    hosting-only booking here would put a row in front of an admin that the
    decision route (`PATCH .../review`) cannot action — a dead end. #2365 owns
    broadening the queue together with the decision path that makes it usable.
  */
  const data = rows.map((booking) => {
    const codes = bookingReviewReasonCodes(booking);
    return {
      ...booking,
      reviewReasonCodes: codes,
      reviewReasons: bookingReviewReasonSentences(codes),
    };
  });

  return NextResponse.json({
    data,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
