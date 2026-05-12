import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import logger from "@/lib/logger";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amountSchema = z.string().trim().regex(/^\d+(\.\d{1,2})?$/);
const sortBySchema = z
  .enum([
    "lastUpdated",
    "checkIn",
    "member",
    "booking",
    "amount",
    "status",
    "stripe",
    "xeroInvoice",
    "settlement",
  ])
  .optional()
  .default("lastUpdated");

const querySchema = z.object({
  status: z.enum(["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED", "all"]).optional().default("all"),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  lastUpdatedFrom: dateSchema.optional(),
  lastUpdatedTo: dateSchema.optional(),
  checkInFrom: dateSchema.optional(),
  checkInTo: dateSchema.optional(),
  search: z.string().trim().max(100).optional(),
  amountExact: amountSchema.optional(),
  amountMin: amountSchema.optional(),
  amountMax: amountSchema.optional(),
  sortBy: sortBySchema,
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
}).superRefine((value, ctx) => {
  if (
    value.amountExact === undefined &&
    value.amountMin !== undefined &&
    value.amountMax !== undefined &&
    moneyStringToCents(value.amountMin) > moneyStringToCents(value.amountMax)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["amountMax"],
      message: "Amount max must be greater than or equal to amount min",
    });
  }
});

type PaymentCandidate = {
  id: string;
  bookingId: string;
  amountCents: number;
  status: string;
  stripePaymentIntentId: string | null;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  refundedAmountCents: number;
  updatedAt: Date;
  transactions: Array<{ updatedAt: Date }>;
  refunds: Array<{ updatedAt: Date }>;
  booking: {
    id: string;
    status: string;
    checkIn: Date;
    member: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    };
    creditsFromCancellation: Array<{
      amountCents: number;
      description: string | null;
    }>;
  };
};

function moneyStringToCents(value: string) {
  const [dollars, cents = ""] = value.split(".");
  return Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
}

function startOfInputDate(date: string) {
  return new Date(`${date}T00:00:00`);
}

function endOfInputDate(date: string) {
  return new Date(`${date}T23:59:59`);
}

function latestPaymentActivityAt(payment: PaymentCandidate) {
  let latest = payment.updatedAt;

  for (const transaction of payment.transactions) {
    if (transaction.updatedAt > latest) {
      latest = transaction.updatedAt;
    }
  }

  for (const refund of payment.refunds) {
    if (refund.updatedAt > latest) {
      latest = refund.updatedAt;
    }
  }

  return latest;
}

function memberSortValue(payment: PaymentCandidate) {
  return `${payment.booking.member.lastName} ${payment.booking.member.firstName}`.toLowerCase();
}

function settlementSortValue(payment: PaymentCandidate) {
  return (
    payment.refundedAmountCents +
    payment.booking.creditsFromCancellation.reduce(
      (sum, credit) => sum + credit.amountCents,
      0
    )
  );
}

function compareValues(left: string | number | Date | null, right: string | number | Date | null) {
  const normalizedLeft = left instanceof Date ? left.getTime() : left ?? "";
  const normalizedRight = right instanceof Date ? right.getTime() : right ?? "";

  if (typeof normalizedLeft === "number" && typeof normalizedRight === "number") {
    return normalizedLeft - normalizedRight;
  }

  return String(normalizedLeft).localeCompare(String(normalizedRight));
}

function sortValue(payment: PaymentCandidate, sortBy: z.infer<typeof sortBySchema>) {
  switch (sortBy) {
    case "checkIn":
      return payment.booking.checkIn;
    case "member":
      return memberSortValue(payment);
    case "booking":
      return payment.bookingId;
    case "amount":
      return payment.amountCents;
    case "status":
      return payment.status;
    case "stripe":
      return payment.stripePaymentIntentId;
    case "xeroInvoice":
      return payment.xeroInvoiceNumber ?? payment.xeroInvoiceId;
    case "settlement":
      return settlementSortValue(payment);
    case "lastUpdated":
    default:
      return latestPaymentActivityAt(payment);
  }
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    lastUpdatedFrom: searchParams.get("lastUpdatedFrom") ?? undefined,
    lastUpdatedTo: searchParams.get("lastUpdatedTo") ?? undefined,
    checkInFrom: searchParams.get("checkInFrom") ?? undefined,
    checkInTo: searchParams.get("checkInTo") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    amountExact: searchParams.get("amountExact") ?? undefined,
    amountMin: searchParams.get("amountMin") ?? undefined,
    amountMax: searchParams.get("amountMax") ?? undefined,
    sortBy: searchParams.get("sortBy") ?? undefined,
    sortDir: searchParams.get("sortDir") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const {
    status,
    from,
    to,
    lastUpdatedFrom,
    lastUpdatedTo,
    checkInFrom,
    checkInTo,
    search,
    amountExact,
    amountMin,
    amountMax,
    sortBy,
    sortDir,
    page,
    pageSize,
  } = parsed.data;
  const activityFrom = lastUpdatedFrom ?? from;
  const activityTo = lastUpdatedTo ?? to;

  try {
    const where: Prisma.PaymentWhereInput = {};
    if (status !== "all") {
      where.status = status;
    }

    if (amountExact) {
      where.amountCents = moneyStringToCents(amountExact);
    } else if (amountMin || amountMax) {
      const amountFilter: Prisma.IntFilter = {};
      if (amountMin) {
        amountFilter.gte = moneyStringToCents(amountMin);
      }
      if (amountMax) {
        amountFilter.lte = moneyStringToCents(amountMax);
      }
      where.amountCents = amountFilter;
    }

    const bookingWhere: Prisma.BookingWhereInput = {};
    if (checkInFrom || checkInTo) {
      const checkInFilter: Prisma.DateTimeFilter = {};
      if (checkInFrom) {
        checkInFilter.gte = startOfInputDate(checkInFrom);
      }
      if (checkInTo) {
        checkInFilter.lte = endOfInputDate(checkInTo);
      }
      bookingWhere.checkIn = checkInFilter;
    }

    if (search) {
      const terms = search.split(/\s+/).filter(Boolean);
      bookingWhere.member = {
        is: {
          AND: terms.map((term) => ({
            OR: [
              { firstName: { contains: term, mode: "insensitive" } },
              { lastName: { contains: term, mode: "insensitive" } },
              { email: { contains: term, mode: "insensitive" } },
            ],
          })),
        },
      };
    }

    if (Object.keys(bookingWhere).length > 0) {
      where.booking = { is: bookingWhere };
    }

    const candidates = await prisma.payment.findMany({
      where,
      select: {
        id: true,
        bookingId: true,
        amountCents: true,
        status: true,
        stripePaymentIntentId: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        refundedAmountCents: true,
        updatedAt: true,
        transactions: { select: { updatedAt: true } },
        refunds: { select: { updatedAt: true } },
        booking: {
          select: {
            id: true,
            status: true,
            checkIn: true,
            creditsFromCancellation: {
              select: {
                amountCents: true,
                description: true,
              },
            },
            member: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
    });

    const filteredCandidates = candidates
      .map((payment) => ({
        ...payment,
        latestActivityAt: latestPaymentActivityAt(payment),
      }))
      .filter((payment) => {
        if (activityFrom && payment.latestActivityAt < startOfInputDate(activityFrom)) {
          return false;
        }
        if (activityTo && payment.latestActivityAt > endOfInputDate(activityTo)) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        const direction = sortDir === "asc" ? 1 : -1;
        const primary =
          compareValues(sortValue(left, sortBy), sortValue(right, sortBy)) * direction;
        if (primary !== 0) {
          return primary;
        }
        return left.id.localeCompare(right.id);
      });

    const total = filteredCandidates.length;
    const pageCandidates = filteredCandidates.slice((page - 1) * pageSize, page * pageSize);
    const pageIds = pageCandidates.map((payment) => payment.id);
    const activityByPaymentId = new Map(
      pageCandidates.map((payment) => [payment.id, payment.latestActivityAt])
    );

    const data = pageIds.length
      ? await prisma.payment.findMany({
          where: {
            id: { in: pageIds },
          },
          include: {
            booking: {
              select: {
                id: true,
                status: true,
                checkIn: true,
                checkOut: true,
                creditsFromCancellation: {
                  select: {
                    amountCents: true,
                    description: true,
                  },
                },
                member: {
                  select: { id: true, firstName: true, lastName: true, email: true },
                },
              },
            },
          },
        })
      : [];

    const dataById = new Map(data.map((payment) => [payment.id, payment]));
    const orderedData = pageIds
      .map((id) => dataById.get(id))
      .filter((payment): payment is (typeof data)[number] => Boolean(payment))
      .map((payment) => ({
        ...payment,
        lastUpdatedAt: activityByPaymentId.get(payment.id) ?? payment.updatedAt,
      }));

    const summary = filteredCandidates.reduce(
      (acc, payment) => {
        acc.totalRevenueCents += payment.amountCents;
        acc.refundedCents += payment.refundedAmountCents;
        acc.count += 1;
        return acc;
      },
      { totalRevenueCents: 0, refundedCents: 0, count: 0 }
    );

    return NextResponse.json({
      data: orderedData,
      total,
      page,
      pageSize,
      summary,
    });
  } catch (err) {
    logger.error({ err }, "Error fetching payments");
    return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 });
  }
}
