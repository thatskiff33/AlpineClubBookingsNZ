import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  bookingReviewReasonCodes,
  bookingReviewReasonSentences,
} from "@/lib/booking-review";
import {
  adminListPage,
  adminQueueCreatedOrder,
  adminListPageQueryFields,
  adminQueueFocusIdField,
} from "@/lib/admin-list-page";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  ...adminListPageQueryFields,
  // A focused deep link (`?bookingId=`) reads its one booking, inside the same
  // review scope, so the panel can pin it when it is not on the page
  // (INV-OPS-017).
  bookingId: adminQueueFocusIdField,
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

  const { status, page, pageSize, bookingId } = parsed.data;
  const skip = (page - 1) * pageSize;
  const include = {
    member: {
      select: { id: true, firstName: true, lastName: true, email: true },
    },
    adminReviewedBy: {
      select: { id: true, firstName: true, lastName: true },
    },
    guests: {
      select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true },
    },
  } as const;
  const idFilter = bookingId ? { id: bookingId } : {};

  /*
    INV-OPS-017: PENDING reads oldest first so the longest wait is on page 1.
    ALL keeps every PENDING row ahead of the decided ones — PENDING oldest
    first, then APPROVED/REJECTED newest first — by reading the two groups
    separately and slicing the one page across them.
  */
  let rows;
  let total: number;
  if (status === "ALL") {
    const pendingWhere: Prisma.BookingWhereInput = {
      deletedAt: null,
      adminReviewStatus: "PENDING",
      ...idFilter,
    };
    const decidedWhere: Prisma.BookingWhereInput = {
      deletedAt: null,
      adminReviewStatus: { in: ["APPROVED", "REJECTED"] },
      ...idFilter,
    };
    const [pendingTotal, decidedTotal] = await Promise.all([
      prisma.booking.count({ where: pendingWhere }),
      prisma.booking.count({ where: decidedWhere }),
    ]);
    total = pendingTotal + decidedTotal;
    const pendingTake = Math.max(0, Math.min(pageSize, pendingTotal - skip));
    const decidedTake = pageSize - pendingTake;
    const [pendingRows, decidedRows] = await Promise.all([
      pendingTake > 0
        ? prisma.booking.findMany({
            where: pendingWhere,
            include,
            orderBy: [{ createdAt: adminQueueCreatedOrder(true) }, { id: adminQueueCreatedOrder(true) }],
            skip,
            take: pendingTake,
          })
        : Promise.resolve([]),
      decidedTake > 0 && skip + pendingTake < total
        ? prisma.booking.findMany({
            where: decidedWhere,
            include,
            orderBy: [{ createdAt: adminQueueCreatedOrder(false) }, { id: adminQueueCreatedOrder(false) }],
            skip: Math.max(0, skip - pendingTotal),
            take: decidedTake,
          })
        : Promise.resolve([]),
    ]);
    rows = [...pendingRows, ...decidedRows];
  } else {
    const where = { deletedAt: null, adminReviewStatus: status, ...idFilter } as const;
    const direction = adminQueueCreatedOrder(status === "PENDING");
    [rows, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        include,
        orderBy: [{ createdAt: direction }, { id: direction }],
        skip,
        take: pageSize,
      }),
      prisma.booking.count({ where }),
    ]);
  }

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

  return NextResponse.json({ data, ...adminListPage({ page, pageSize, total }) });
}
