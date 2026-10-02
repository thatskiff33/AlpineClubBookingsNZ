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

import {
  evaluateBookingLedgerIdentities,
  summarizeBookingLedgerCensus,
  type BookingLedgerCensusReport,
  type LedgerTableStatistics,
} from "@/lib/booking-ledger-projection-census";
import type { BookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-classes";
import { BOOKING_ISSUED_CREDIT_TYPES } from "@/lib/member-credit-booking-rows";
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
      transactions: {
        orderBy: ASC,
        select: {
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
  modifications: { orderBy: ASC, select: { id: true, priceDiffCents: true, changeFeeCents: true, createdAt: true } },
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
});

function cancellationOf(booking: StoredCensusBooking): BookingLedgerCensusRow["cancellation"] {
  const snapshot = booking.events[0]?.snapshot;
  if (snapshot === undefined || snapshot === null) return null;
  const parsed = CANCELLATION_SNAPSHOT.safeParse(snapshot);
  if (!parsed.success) return null;
  return { refundMethod: parsed.data.refundMethod ?? null, settledAmountCents: parsed.data.settledAmountCents ?? null };
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
        }
      : null,
    transactions: payment?.transactions ?? [],
    refunds: payment?.refunds ?? [],
    credits,
    tasks: booking.manualRefundTasks,
    modifications: booking.modifications,
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
    WHERE "relname" = 'BookingLedgerLine'
  `;
  const [row] = decodeRawRows(rows, TABLE_STATISTICS_ROW, "booking ledger table statistics");
  return row ?? null;
}

/**
 * Judge every booking, from one read-only snapshot. Returns the report; writes
 * nothing, repairs nothing, and calls no provider.
 */
export async function censusBookingLedgerProjection(
  client: Pick<PrismaClient, "$transaction">,
): Promise<BookingLedgerCensusReport> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const bookings = await tx.booking.findMany({ orderBy: ASC, select: CENSUS_SELECT });
      // Which rows are a booking's is `member-credit-booking-rows.ts`'s: applied
      // TO it by `appliedToBookingId`, issued FROM it by `sourceBookingId`.
      const credits = await tx.memberCredit.findMany({
        where: {
          OR: [
            { type: "BOOKING_APPLIED", appliedToBookingId: { not: null } },
            { type: { in: [...BOOKING_ISSUED_CREDIT_TYPES] }, sourceBookingId: { not: null } },
          ],
        },
        orderBy: ASC,
        select: CREDIT_SELECT,
      });
      const tableStatistics = await readLedgerTableStatistics(tx);
      const creditsByBooking = new Map<string, BookingLedgerCensusRow["credits"][number][]>();
      for (const credit of credits) {
        const bookingId = credit.type === "BOOKING_APPLIED" ? credit.appliedToBookingId : credit.sourceBookingId;
        if (bookingId) creditsByBooking.set(bookingId, [...(creditsByBooking.get(bookingId) ?? []), credit]);
      }
      return summarizeBookingLedgerCensus(
        bookings.map((booking) => evaluateBookingLedgerIdentities(toCensusRow(booking, creditsByBooking.get(booking.id) ?? []))),
        tableStatistics,
      );
    },
    // A whole-history read: give it room, and fail rather than queue forever.
    { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 600_000 },
  );
}
