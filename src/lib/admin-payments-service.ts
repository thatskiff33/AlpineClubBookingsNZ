import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildXeroActivityByRecord,
  deriveSettlementKind,
  deriveXeroState,
  isXeroInvoiceExpectedPaymentStatus,
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
import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { prisma } from "@/lib/prisma";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  endOfDateOnlyForTimeZone,
  parseDateOnly,
  startOfDateOnlyForTimeZone,
} from "@/lib/date-only";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/**
 * An amount filter typed into the payments search box, in integer cents.
 *
 * The string is parsed by the canonical exact parser (#2685) rather than by
 * `parseFloat` arithmetic, and an amount the parser refuses — including one
 * above the int32 cent range the `amountCents` column holds, which used to reach
 * Prisma and fail the whole request with a 500 — becomes an ordinary 400 with a
 * message. Parsing here, in the schema, is what makes the null case impossible
 * downstream: `amountExact`/`amountMin`/`amountMax` are already cents by the
 * time any query is built.
 */
/**
 * What an amount filter must look like, said in the operator's words.
 *
 * Exported because the payments screen renders it beside the amount boxes when
 * the API refuses the query — the operator should not have to open a network
 * panel to find out why the table stopped changing (#2685 review).
 */
export const AMOUNT_FILTER_GRAMMAR_MESSAGE =
  "Enter an amount in dollars and cents, for example 125.00 — no currency symbol, thousands separator, or leading zero.";

/** The only refusal a well-formed amount can still earn. */
export const AMOUNT_FILTER_RANGE_MESSAGE =
  "That amount is larger than any payment this system can hold.";

const amountSchema = z
  .string()
  .trim()
  // THE SAME GRAMMAR THE CANONICAL PARSER ENFORCES, not a looser one.
  //
  // `\d+` admitted `"007.50"`, which `parseDecimalDollarsToCents` then refused —
  // so a leading zero fell through to the range message below and told the
  // operator their amount was "outside the supported range", which was not what
  // was wrong with it (#2685 review). Leading zeros stay rejected (owner
  // decision, 14 Aug 2026); what changes is that the refusal now says so.
  .regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/, AMOUNT_FILTER_GRAMMAR_MESSAGE)
  .transform((value, ctx) => {
    const cents = parseDecimalDollarsToCents(value);
    if (cents === null) {
      // Reachable only for a well-formed amount above the int32 cent range the
      // `amountCents` column holds — which used to reach Prisma and fail the
      // whole request with a 500. Every other refusal is the grammar's, above.
      ctx.addIssue({
        code: "custom",
        message: AMOUNT_FILTER_RANGE_MESSAGE,
      });
      return z.NEVER;
    }
    return cents;
  });
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
    value.amountMin > value.amountMax
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

/**
 * The activity window's bounds, in the CLUB's civil day (CT-4, #2870;
 * `INV-CONFIG-002`).
 *
 * NARROW, DECLARED `src/lib` EXCEPTION, and the reason is that this is one half
 * of a value whose other half moved. `admin/payments/page.tsx` seeds the default
 * "last updated to" from `clubTime.today()` — the club's PERSISTED zone — and
 * these two functions closed the same window at midnight/23:59:59.999 in
 * `APP_TIME_ZONE`, which is the build's `TZ` and not the club's setting. For a
 * club six hours behind an Auckland-defaulted build, every payment updated after
 * about 06:00 club time fell out of the officer's DEFAULT view while the date
 * box still read the correct date — an invisible truncation of roughly eighteen
 * hours. Both bounds are affected, not only the upper one.
 *
 * The zone is resolved ONCE per request, in {@link listAdminPayments}, and so
 * are the two bounds: reading the zone per row would issue a database query
 * inside a filter callback, and re-projecting the bound per row would rebuild an
 * `Intl` formatter for every payment in the page.
 *
 * WHICH READER, AND THE HONEST REASON. It is `club-time-zone-runtime`, not
 * `club-time/server`. The latter carries `import "server-only"`, which throws at
 * import time under anything but the `react-server` condition — including a
 * `tsx` operator script, which cannot be told apart from a client component.
 * `listAdminPayments` has two consumers: the admin payments route, and
 * `diagnostics/tools/packs/finance-evidence.ts`. The diagnostics tree IS already
 * reached from a CLI (`scripts/diagnostics/generate-knowledge-bundle.ts` imports
 * `src/lib/diagnostics/knowledge/**` under `tsx`), but that pack file is not on
 * that script's graph today.
 *
 * MEASURED rather than asserted, because an earlier revision of this comment
 * claimed the reachability as a current fact and it is not one: swapping this
 * import for `club-time/server` leaves `cli-server-only-reach-census.test.ts`
 * green on all four of its tests. So this is a cheap hedge against an import
 * edge that does not exist yet, not a live constraint — and the cost of the
 * hedge is one un-memoised settings read per request, against the one read a
 * request already makes here.
 *
 * The INCLUSIVE upper-bound shape is unchanged (`endOfDateOnlyForTimeZone` is
 * the millisecond before the next day): the comparison below is `>`, so
 * narrowing it to the kernel's half-open boundary here would silently drop the
 * final millisecond of the window.
 *
 * `null` FOR "NO BOUND", and never for "a bound we could not resolve a zone
 * for". The two are one decision here — the zone is read exactly when a bound is
 * present — which is why the window is built in one place rather than as a pair
 * of conditions in the filter that a later edit could drift apart. A
 * `Date(NaN)`, which an unparseable day still produces, compares false against
 * everything and so keeps the row: the long-standing behaviour of these bounds,
 * unchanged.
 */
function activityWindowBounds(
  activityFrom: string | undefined,
  activityTo: string | undefined,
  timeZone: string | null,
): { readonly from: Date | null; readonly to: Date | null } {
  if (timeZone === null) return { from: null, to: null };
  return {
    from: activityFrom ? startOfDateOnlyForTimeZone(activityFrom, timeZone) : null,
    to: activityTo ? endOfDateOnlyForTimeZone(activityTo, timeZone) : null,
  };
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
  // Read once, outside the row loop, and only when a bound is actually in play —
  // see the note on `activityWindowBounds`.
  const activityZone =
    activityFrom || activityTo ? await readClubTimeZoneOutsideRequest() : null;
  const activityWindow = activityWindowBounds(activityFrom, activityTo, activityZone);

  try {
    const where: Prisma.PaymentWhereInput = {};
    if (status !== "all") {
      where.status = status;
    }
    if (source !== "all") {
      where.source = source;
    }

    // `!== undefined`, not truthiness: these are cents now, and a deliberate
    // "$0.00" filter is the falsy value 0 (#2685).
    if (amountExact !== undefined) {
      where.amountCents = amountExact;
    } else if (amountMin !== undefined || amountMax !== undefined) {
      const amountFilter: Prisma.IntFilter = {};
      if (amountMin !== undefined) {
        amountFilter.gte = amountMin;
      }
      if (amountMax !== undefined) {
        amountFilter.lte = amountMax;
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
            invoiceExpected: isXeroInvoiceExpectedPaymentStatus(payment.status),
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
        if (
          activityWindow.from !== null &&
          payment.latestActivityAt < activityWindow.from
        ) {
          return false;
        }
        if (
          activityWindow.to !== null &&
          payment.latestActivityAt > activityWindow.to
        ) {
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
