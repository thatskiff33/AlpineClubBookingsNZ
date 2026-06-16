import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildXeroActivityByRecord,
  deriveSettlementKind,
  deriveXeroState,
  matchesSettlementFilter,
  matchesXeroStateFilter,
  paymentApiSourceFilters,
  settlementFilters,
  xeroStateFilters,
  type SettlementKind,
  type XeroActivitySummary,
  type XeroState,
} from "@/lib/admin-operational-state";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  endOfDateOnlyForTimeZone,
  parseDateOnly,
  startOfDateOnlyForTimeZone,
} from "@/lib/date-only";

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

export const adminPaymentsQuerySchema = z.object({
  status: z.enum(["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED", "all"]).optional().default("all"),
  source: z.enum(paymentApiSourceFilters).optional().default("all"),
  xeroState: z.enum(xeroStateFilters).optional().default("all"),
  settlement: z.enum(settlementFilters).optional().default("all"),
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

export type AdminPaymentsQuery = z.infer<typeof adminPaymentsQuerySchema>;

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

type PaymentCandidate = {
  id: string;
  bookingId: string;
  amountCents: number;
  source: string;
  reference: string | null;
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

type EnrichedPaymentCandidate = PaymentCandidate & {
  latestActivityAt: Date;
  xeroActivity: XeroActivitySummary;
  xeroState: XeroState;
  settlementKind: SettlementKind;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

function moneyStringToCents(value: string) {
  const [dollars, cents = ""] = value.split(".");
  return Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
}

function startOfInputDateTime(date: string) {
  return startOfDateOnlyForTimeZone(date);
}

function endOfInputDateTime(date: string) {
  return endOfDateOnlyForTimeZone(date);
}

function inputDateOnly(date: string) {
  return parseDateOnly(date);
}

function insensitiveContains(term: string) {
  return { contains: term, mode: "insensitive" as const };
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

function sortValue(payment: EnrichedPaymentCandidate, sortBy: z.infer<typeof sortBySchema>) {
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

export async function listAdminPayments(query: AdminPaymentsQuery): Promise<JsonRouteResult> {
  const {
    status,
    source,
    xeroState,
    settlement,
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
  } = query;
  const activityFrom = lastUpdatedFrom ?? from;
  const activityTo = lastUpdatedTo ?? to;

  try {
    const where: Prisma.PaymentWhereInput = {};
    if (status !== "all") {
      where.status = status;
    }
    if (source !== "all") {
      where.source = source;
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
        checkInFilter.gte = inputDateOnly(checkInFrom);
      }
      if (checkInTo) {
        checkInFilter.lte = inputDateOnly(checkInTo);
      }
      bookingWhere.checkIn = checkInFilter;
    }

    const andFilters: Prisma.PaymentWhereInput[] = [];
    if (search) {
      const terms = search.split(/\s+/).filter(Boolean);
      andFilters.push(
        ...terms.map((term) => ({
          OR: [
            { reference: insensitiveContains(term) },
            { bookingId: insensitiveContains(term) },
            { stripePaymentIntentId: insensitiveContains(term) },
            { xeroInvoiceId: insensitiveContains(term) },
            { xeroInvoiceNumber: insensitiveContains(term) },
            {
              booking: {
                is: {
                  member: {
                    is: {
                      OR: [
                        { firstName: insensitiveContains(term) },
                        { lastName: insensitiveContains(term) },
                        { email: insensitiveContains(term) },
                      ],
                    },
                  },
                },
              },
            },
          ],
        }))
      );
    }

    if (Object.keys(bookingWhere).length > 0) {
      where.booking = { is: bookingWhere };
    }
    if (andFilters.length > 0) {
      where.AND = andFilters;
    }

    const candidates = await prisma.payment.findMany({
      where,
      select: {
        id: true,
        bookingId: true,
        amountCents: true,
        source: true,
        reference: true,
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

    const candidatePaymentIds = candidates.map((payment) => payment.id);
    const [activityOperations, primaryInvoiceLinks] = await Promise.all([
      candidatePaymentIds.length
        ? prisma.xeroSyncOperation.findMany({
            where: {
              localModel: "Payment",
              localId: { in: candidatePaymentIds },
            },
            select: {
              id: true,
              status: true,
              localModel: true,
              localId: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      candidatePaymentIds.length
        ? prisma.xeroObjectLink.findMany({
            where: {
              localModel: "Payment",
              localId: { in: candidatePaymentIds },
              xeroObjectType: "INVOICE",
              role: "PRIMARY_INVOICE",
              active: true,
            },
            select: {
              localId: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const activityByRecord = buildXeroActivityByRecord(activityOperations);
    const invoiceLinkedPaymentIds = new Set(primaryInvoiceLinks.map((link) => link.localId));

    const filteredCandidates = candidates
      .map((payment): EnrichedPaymentCandidate => {
        const xeroActivity =
          activityByRecord.get(`Payment:${payment.id}`) ?? {
            failed: 0,
            partial: 0,
            pending: 0,
            latestOperationId: null,
            latestOperationStatus: null,
            latestOperationAt: null,
          };
        const invoiceLinked =
          Boolean(payment.xeroInvoiceId) || invoiceLinkedPaymentIds.has(payment.id);

        return {
          ...payment,
          latestActivityAt: latestPaymentActivityAt(payment),
          xeroActivity,
          xeroState: deriveXeroState({
            invoiceExpected: ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(payment.status),
            invoiceLinked,
            activity: xeroActivity,
          }),
          settlementKind: deriveSettlementKind({
            refundedAmountCents: payment.refundedAmountCents,
            credits: payment.booking.creditsFromCancellation,
          }),
        };
      })
      .filter((payment) => {
        if (activityFrom && payment.latestActivityAt < startOfInputDateTime(activityFrom)) {
          return false;
        }
        if (activityTo && payment.latestActivityAt > endOfInputDateTime(activityTo)) {
          return false;
        }
        if (!matchesXeroStateFilter(payment.xeroState, xeroState)) {
          return false;
        }
        if (!matchesSettlementFilter(payment.settlementKind, settlement)) {
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
    const filteredCandidateById = new Map(
      filteredCandidates.map((payment) => [payment.id, payment])
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
        xeroActivity:
          filteredCandidateById.get(payment.id)?.xeroActivity ??
          {
            failed: 0,
            partial: 0,
            pending: 0,
            latestOperationId: null,
            latestOperationStatus: null,
            latestOperationAt: null,
          },
        xeroState:
          filteredCandidateById.get(payment.id)?.xeroState ??
          "none",
        settlementKind:
          filteredCandidateById.get(payment.id)?.settlementKind ??
          "none",
      }));

    const summary = filteredCandidates.reduce(
      (acc, payment) => {
        // Total Revenue should reflect retained revenue only. A cancelled
        // booking's payment must not count toward it (issue #773), even though
        // the row still appears in the list and its refund is tracked below.
        if (payment.booking.status !== "CANCELLED") {
          acc.totalRevenueCents += payment.amountCents;
        }
        acc.refundedCents += payment.refundedAmountCents;
        acc.count += 1;
        return acc;
      },
      { totalRevenueCents: 0, refundedCents: 0, count: 0 }
    );

    return jsonResult({
      data: orderedData,
      total,
      page,
      pageSize,
      summary,
    });
  } catch (err) {
    logger.error({ err }, "Error fetching payments");
    return jsonResult({ error: "Failed to fetch payments" }, { status: 500 });
  }
}
