import type { Prisma } from "@prisma/client";

import { bookingIdsNamedByJournal } from "@/lib/member-money";

/**
 * FINANCIAL HISTORY OUTLIVES ITS BOOKING (#4514, Ledger M2; owner decision D1 on
 * #4482, 28 Oct 2026; `INV-MONEY-043`).
 *
 * These are the rows that make a booking's financial history, each keyed by the
 * relation that names the booking. Every one is a RESTRICT foreign key, so the
 * database itself refuses to delete a booking any of them names — whoever asks,
 * through any route. A booking with money is soft-deleted or left as it is;
 * never hard-deleted.
 *
 * `bookingsWithFinancialHistory` lets the paths that do hard-delete (draft
 * bookings only) skip such a booking instead of meeting that refusal, which
 * would abort the whole transaction: a single anomalous draft must never wedge
 * the nightly draft cleanup. The database stays the guard; this read only keeps
 * its refusal from becoming an outage.
 *
 * ONE LIST. `booking-financial-history-census.test.ts` reads `schema.prisma`
 * and fails when a relation into `Booking` or `BookingModification` is neither
 * here (and RESTRICT) nor classified as operational there, so a new money table
 * cannot join with a cascade, and a key named here cannot drift off RESTRICT.
 */
type FinancialHistoryStore = Pick<
  Prisma.TransactionClient,
  | "bookingLedgerLine"
  | "memberMoneyLine"
  | "memberCredit"
  | "payment"
  | "refundRequest"
  | "manualRefundTask"
  | "paymentRecoveryOperation"
>;

type BookingIdsNamed = (db: FinancialHistoryStore, bookingIds: string[]) => Promise<ReadonlyArray<string | null>>;

const FINANCIAL_HISTORY_READERS = {
  // The append-only money lines: the legacy booking ledger and the member journal.
  "BookingLedgerLine.bookingId": async (db, ids) =>
    (await db.bookingLedgerLine.findMany({
      where: { bookingId: { in: ids } },
      select: { bookingId: true },
      distinct: ["bookingId"],
    })).map((row) => row.bookingId),
  "MemberMoneyLine.bookingId": (db, ids) => bookingIdsNamedByJournal(db, ids),
  // Insert-only credit rows (INV-MONEY-035): their booking links never blank.
  "MemberCredit.sourceBookingId": async (db, ids) =>
    (await db.memberCredit.findMany({
      where: { sourceBookingId: { in: ids } },
      select: { sourceBookingId: true },
      distinct: ["sourceBookingId"],
    })).map((row) => row.sourceBookingId),
  "MemberCredit.appliedToBookingId": async (db, ids) =>
    (await db.memberCredit.findMany({
      where: { appliedToBookingId: { in: ids } },
      select: { appliedToBookingId: true },
      distinct: ["appliedToBookingId"],
    })).map((row) => row.appliedToBookingId),
  // Through the modification that minted the credit, which a draft's cleanup deletes.
  "MemberCredit.sourceBookingModificationId": async (db, ids) =>
    (await db.memberCredit.findMany({
      where: { sourceBookingModification: { bookingId: { in: ids } } },
      select: { sourceBookingModification: { select: { bookingId: true } } },
    })).map((row) => row.sourceBookingModification?.bookingId ?? null),
  // The payment and its refund and recovery work: RESTRICT before M2 already.
  "Payment.bookingId": async (db, ids) =>
    (await db.payment.findMany({ where: { bookingId: { in: ids } }, select: { bookingId: true } })).map(
      (row) => row.bookingId,
    ),
  "RefundRequest.bookingId": async (db, ids) =>
    (await db.refundRequest.findMany({
      where: { bookingId: { in: ids } },
      select: { bookingId: true },
      distinct: ["bookingId"],
    })).map((row) => row.bookingId),
  "ManualRefundTask.bookingId": async (db, ids) =>
    (await db.manualRefundTask.findMany({
      where: { bookingId: { in: ids } },
      select: { bookingId: true },
      distinct: ["bookingId"],
    })).map((row) => row.bookingId),
  "PaymentRecoveryOperation.bookingId": async (db, ids) =>
    (await db.paymentRecoveryOperation.findMany({
      where: { bookingId: { in: ids } },
      select: { bookingId: true },
      distinct: ["bookingId"],
    })).map((row) => row.bookingId),
} satisfies Record<string, BookingIdsNamed>;

export type BookingFinancialHistoryRelation = keyof typeof FINANCIAL_HISTORY_READERS;

/** Every `Model.field` relation that names a booking as financial history. */
export const BOOKING_FINANCIAL_HISTORY_RELATIONS = Object.keys(
  FINANCIAL_HISTORY_READERS,
) as ReadonlyArray<BookingFinancialHistoryRelation>;

/** The ids among `bookingIds` that any financial-history row names. */
export async function bookingsWithFinancialHistory(
  db: FinancialHistoryStore,
  bookingIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(bookingIds)];
  if (ids.length === 0) return new Set();
  const named = await Promise.all(
    BOOKING_FINANCIAL_HISTORY_RELATIONS.map((relation) => FINANCIAL_HISTORY_READERS[relation](db, ids)),
  );
  return new Set(named.flat().filter((id): id is string => id !== null));
}
