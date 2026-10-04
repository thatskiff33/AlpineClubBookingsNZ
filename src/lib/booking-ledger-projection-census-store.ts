import "server-only";

/**
 * THE ONE SNAPSHOT THE BOOKING-LEDGER PROJECTION CENSUS READS (#3583,
 * `INV-MONEY-037`).
 *
 * One `RepeatableRead` transaction, made `READ ONLY` as its first statement so
 * PostgreSQL itself refuses a write inside it, holding only ordered reads —
 * the `censusBookingMoneyReconciliation` shape (`INV-MONEY-031`). It takes no
 * lock: a snapshot is the whole point, and a lock would make an operator's
 * read wait behind, or hold up, a settle. Every collection is read in `id`
 * order so two runs over the same data produce the same report.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { evaluateBookingLedgerIdentities, type BookingLedgerEvaluation } from "@/lib/booking-ledger-projection-census";
import {
  summarizeBookingLedgerCensus,
  type BookingLedgerAcknowledgement,
  type BookingLedgerCensusReport,
  type LedgerTableStatistics,
} from "@/lib/booking-ledger-projection-census-report";
import type { BookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-row";
import { INTERNET_BANKING_SETTLEMENT_EVIDENCE_SELECT } from "@/lib/internet-banking-settlement-evidence";
import { bookingIdOfCreditRow, bookingsCreditRowsWhere } from "@/lib/member-credit-booking-rows";
import { decodeRawRows } from "@/lib/raw-sql-rows";

const ASC = { id: "asc" } as const;

const CENSUS_SELECT = {
  id: true,
  status: true,
  deletedAt: true,
  organiserSettled: true,
  finalPriceCents: true,
  payment: {
    select: {
      id: true,
      source: true,
      status: true,
      amountCents: true,
      creditAppliedCents: true,
      refundedAmountCents: true,
      changeFeeCents: true,
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      // #3632: whether an internet-banking payment is proven paid.
      ...INTERNET_BANKING_SETTLEMENT_EVIDENCE_SELECT,
      transactions: {
        orderBy: ASC,
        select: {
          ...INTERNET_BANKING_SETTLEMENT_EVIDENCE_SELECT.transactions.select,
          id: true,
          kind: true,
          status: true,
          amountCents: true,
          refundedAmountCents: true,
          reason: true,
          withdrawnAt: true,
          createdAt: true,
        },
      },
      refunds: { orderBy: ASC, select: { id: true, status: true, amountCents: true, paymentTransactionId: true } },
    },
  },
  manualRefundTasks: {
    orderBy: ASC,
    select: {
      id: true,
      kind: true,
      status: true,
      amountCents: true,
      settlementDirection: true,
      paymentId: true,
      lateCaptureApprovalIntentId: true,
    },
  },
  modifications: {
    orderBy: ASC,
    select: { id: true, modificationType: true, priceDiffCents: true, changeFeeCents: true, createdAt: true, newData: true },
  },
  paymentRecoveryOperations: {
    orderBy: ASC,
    select: { type: true, status: true, amountCents: true, idempotencyKey: true },
  },
  events: {
    where: { type: "CANCELLED" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { snapshot: true },
  },
  ledgerLines: {
    orderBy: ASC,
    select: {
      id: true,
      side: true,
      kind: true,
      sign: true,
      quantity: true,
      unitCents: true,
      amountCents: true,
      bookingGuestId: true,
      nightStart: true,
      nightEndExclusive: true,
      anchorKind: true,
      anchorId: true,
      settlementMethod: true,
      reversesLineId: true,
      postingKey: true,
      postedAt: true,
    },
  },
} as const satisfies Prisma.BookingSelect;

type StoredCensusBooking = Prisma.BookingGetPayload<{ select: typeof CENSUS_SELECT }>;

/** What the census reads of the paid path's CANCELLED snapshot; anything else is ignored. */
const CANCELLATION_SNAPSHOT = z.object({
  refundMethod: z.string().nullable().optional(),
  settledAmountCents: z.number().int().nullable().optional(),
  // #3611's frozen ledger figures; absent on a snapshot written before it.
  ledger: z.object({ keptCents: z.number().int() }).nullable().optional(),
});

function cancellationOf(booking: StoredCensusBooking): BookingLedgerCensusRow["cancellation"] {
  const snapshot = booking.events[0]?.snapshot;
  if (snapshot === undefined || snapshot === null) return null;
  const parsed = CANCELLATION_SNAPSHOT.safeParse(snapshot);
  if (!parsed.success) return null;
  return {
    refundMethod: parsed.data.refundMethod ?? null,
    settledAmountCents: parsed.data.settledAmountCents ?? null,
    keptCents: parsed.data.ledger?.keptCents ?? null,
  };
}

/** What the census reads of a review closure's `PRICE_REBASE` row (`recordBookingPriceRebaseHistory`). */
const REVIEW_REBASE_DATA = z.object({
  financialReviewTaskId: z.string(),
  rebasedPriceMovementCents: z.number().int(),
});

function reviewRebaseOf(
  modification: StoredCensusBooking["modifications"][number],
): BookingLedgerCensusRow["modifications"][number]["reviewRebase"] {
  if (modification.modificationType !== "PRICE_REBASE") return null;
  const parsed = REVIEW_REBASE_DATA.safeParse(modification.newData);
  return parsed.success ? { taskId: parsed.data.financialReviewTaskId, movementCents: parsed.data.rebasedPriceMovementCents } : null;
}

const CREDIT_SELECT = {
  id: true,
  type: true,
  amountCents: true,
  sourceBookingId: true,
  appliedToBookingId: true,
  restoredFromBookingId: true,
  description: true,
  xeroCreditNoteId: true,
} as const satisfies Prisma.MemberCreditSelect;

/** The snapshot row one booking is judged from; exported for the real-database proof. */
export function toCensusRow(
  booking: StoredCensusBooking,
  credits: BookingLedgerCensusRow["credits"],
): BookingLedgerCensusRow {
  const { payment } = booking;
  return {
    booking: {
      id: booking.id,
      status: booking.status,
      deletedAt: booking.deletedAt,
      organiserSettled: booking.organiserSettled,
      finalPriceCents: booking.finalPriceCents,
    },
    payment: payment
      ? {
          id: payment.id,
          source: payment.source,
          status: payment.status,
          amountCents: payment.amountCents,
          creditAppliedCents: payment.creditAppliedCents,
          refundedAmountCents: payment.refundedAmountCents,
          changeFeeCents: payment.changeFeeCents,
          additionalAmountCents: payment.additionalAmountCents,
          additionalPaymentStatus: payment.additionalPaymentStatus,
          xeroInvoiceId: payment.xeroInvoiceId,
          manuallyMarkedPaidAt: payment.manuallyMarkedPaidAt,
        }
      : null,
    transactions: payment?.transactions ?? [],
    refunds: payment?.refunds ?? [],
    credits,
    tasks: booking.manualRefundTasks,
    modifications: booking.modifications.map((modification) => ({
      id: modification.id,
      modificationType: modification.modificationType,
      priceDiffCents: modification.priceDiffCents,
      changeFeeCents: modification.changeFeeCents,
      createdAt: modification.createdAt,
      reviewRebase: reviewRebaseOf(modification),
    })),
    recoveryOperations: booking.paymentRecoveryOperations,
    cancellation: cancellationOf(booking),
    lines: booking.ledgerLines,
  };
}

const TABLE_STATISTICS_ROW = z.object({
  inserts: z.coerce.number(),
  updates: z.coerce.number(),
  deletes: z.coerce.number(),
});

/**
 * How many rows of the ledger table PostgreSQL has ever seen updated or
 * deleted, since its statistics were last reset. INFORMATION ONLY: test
 * fixtures delete lines, and statistics can be reset, so it never decides the
 * gate — the append-only rule's proof is `booking-ledger-append-only-census.test.ts`.
 */
async function readLedgerTableStatistics(tx: Prisma.TransactionClient): Promise<LedgerTableStatistics> {
  const rows = await tx.$queryRaw`
    SELECT "n_tup_ins" AS "inserts", "n_tup_upd" AS "updates", "n_tup_del" AS "deletes"
    FROM "pg_catalog"."pg_stat_user_tables"
    WHERE "relname" = 'BookingLedgerLine' AND "schemaname" = current_schema()
  `;
  const [row] = decodeRawRows(rows, TABLE_STATISTICS_ROW, "booking ledger table statistics");
  return row ?? null;
}

/**
 * One booking's snapshot row, read through the caller's client: the back-post
 * (#3583 PR 2, `booking-ledger-back-post.ts`) judges the lines it has just
 * written, inside its own transaction and under its locks, by the same row and
 * the same evaluation the census uses. Null where the booking does not exist.
 */
export async function readBookingLedgerCensusRow(
  tx: CensusReadStore,
  bookingId: string,
): Promise<BookingLedgerCensusRow | null> {
  const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: CENSUS_SELECT });
  if (!booking) return null;
  const credits = await tx.memberCredit.findMany({ where: bookingsCreditRowsWhere([bookingId]), orderBy: ASC, select: CREDIT_SELECT });
  return toCensusRow(
    booking,
    credits.filter((credit) => bookingIdOfCreditRow(credit) === bookingId),
  );
}

/** Bookings read per page inside the snapshot: bounds memory on a whole history. */
export const CENSUS_PAGE_SIZE = 500;

type CensusReadStore = Pick<Prisma.TransactionClient, "booking" | "memberCredit">;

/**
 * Every booking's evaluation, read in pages of `pageSize` by id inside the
 * caller's snapshot. Each page's credit rows are fetched by that page's
 * booking ids and filed by the rule the credit sync uses — applied TO a
 * booking by `appliedToBookingId`, issued FROM it by `sourceBookingId` — so a
 * row is judged with exactly one booking whichever page the other id falls on.
 * Only the evaluations are kept; the rows go with their page.
 */
export async function evaluateBookingLedgerPages(
  tx: CensusReadStore,
  pageSize: number = CENSUS_PAGE_SIZE,
  evaluate: (row: BookingLedgerCensusRow) => BookingLedgerEvaluation = evaluateBookingLedgerIdentities,
): Promise<BookingLedgerEvaluation[]> {
  const evaluations: BookingLedgerEvaluation[] = [];
  let after: string | null = null;
  for (;;) {
    const page: StoredCensusBooking[] = await tx.booking.findMany({
      where: after === null ? {} : { id: { gt: after } },
      orderBy: ASC,
      take: pageSize,
      select: CENSUS_SELECT,
    });
    if (page.length === 0) break;
    const ids = page.map((booking) => booking.id);
    const credits = await tx.memberCredit.findMany({ where: bookingsCreditRowsWhere(ids), orderBy: ASC, select: CREDIT_SELECT });
    const creditsByBooking = new Map<string, BookingLedgerCensusRow["credits"][number][]>();
    for (const credit of credits) {
      const bookingId = bookingIdOfCreditRow(credit);
      if (bookingId) creditsByBooking.set(bookingId, [...(creditsByBooking.get(bookingId) ?? []), credit]);
    }
    for (const booking of page) evaluations.push(evaluate(toCensusRow(booking, creditsByBooking.get(booking.id) ?? [])));
    after = page[page.length - 1]!.id;
    if (page.length < pageSize) break;
  }
  return evaluations;
}

/**
 * Judge every booking, from one read-only snapshot, and report. The snapshot
 * holds only the paged reads; the report is summarised after it closes. Writes
 * nothing, repairs nothing, and calls no provider.
 */
export async function censusBookingLedgerProjection(
  client: Pick<PrismaClient, "$transaction">,
  options: { acknowledgements?: readonly BookingLedgerAcknowledgement[]; pageSize?: number } = {},
): Promise<BookingLedgerCensusReport> {
  const { evaluations, tableStatistics } = await client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const evaluations = await evaluateBookingLedgerPages(tx, options.pageSize);
      return { evaluations, tableStatistics: await readLedgerTableStatistics(tx) };
    },
    // A whole-history read: give it room, and fail rather than queue forever.
    { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 600_000 },
  );
  return summarizeBookingLedgerCensus(evaluations, tableStatistics, options.acknowledgements ?? []);
}
