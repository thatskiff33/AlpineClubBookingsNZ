import type { Prisma } from "@prisma/client";

import { bookingIdsNamedByJournal } from "@/lib/member-money";

/**
 * FINANCIAL HISTORY OUTLIVES ITS BOOKING (#4514, Ledger M2; owner decision D1 on
 * #4482, 28 Oct 2026; `INV-MONEY-043`).
 *
 * These are the rows that make a booking's financial history, each keyed by the
 * relation that names the booking (directly, through a modification, or through
 * the group it organises). Every one is a RESTRICT foreign key, so the database
 * itself refuses to delete a booking any of them names — whoever asks, through
 * any route. A booking with money is soft-deleted or left as it is; never
 * hard-deleted.
 *
 * `bookingsWithFinancialHistory` lets the paths that do hard-delete (draft
 * bookings only) leave such a booking out instead of meeting that refusal, which
 * aborts the whole transaction. The read and the delete share one transaction
 * under the caller's locks, so only money reaching a draft in between — no
 * writer does that — could still meet the refusal, which then rolls the batch
 * back with nothing deleted. The database stays the guard.
 *
 * The append-only money lines are marked: no code deletes one, so a tool that
 * deletes other financial rows itself (the local demo seed) must refuse up front
 * where one exists (`APPEND_ONLY_FINANCIAL_HISTORY_RELATIONS`).
 *
 * ONE LIST. `booking-financial-history-census.test.ts` reads `schema.prisma`
 * and fails when a relation into `Booking`, `BookingModification` or
 * `GroupBooking` is neither here (and RESTRICT) nor classified as operational
 * there, so a new money table cannot join with a cascade, and a key named here
 * cannot drift off RESTRICT.
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
  | "groupBookingSettlement"
>;

type BookingIdsNamed = (db: FinancialHistoryStore, bookingIds: string[]) => Promise<ReadonlyArray<string | null>>;
type FinancialHistoryReader = { appendOnly: boolean; read: BookingIdsNamed };

const FINANCIAL_HISTORY_READERS = {
  // The append-only money lines: the legacy booking ledger and the member journal.
  "BookingLedgerLine.bookingId": {
    appendOnly: true,
    read: async (db, ids) =>
      (await db.bookingLedgerLine.findMany({
        where: { bookingId: { in: ids } },
        select: { bookingId: true },
        distinct: ["bookingId"],
      })).map((row) => row.bookingId),
  },
  "MemberMoneyLine.bookingId": { appendOnly: true, read: (db, ids) => bookingIdsNamedByJournal(db, ids) },
  // Insert-only credit rows (INV-MONEY-035): their booking links never blank.
  "MemberCredit.sourceBookingId": {
    appendOnly: false,
    read: async (db, ids) =>
      (await db.memberCredit.findMany({
        where: { sourceBookingId: { in: ids } },
        select: { sourceBookingId: true },
        distinct: ["sourceBookingId"],
      })).map((row) => row.sourceBookingId),
  },
  "MemberCredit.appliedToBookingId": {
    appendOnly: false,
    read: async (db, ids) =>
      (await db.memberCredit.findMany({
        where: { appliedToBookingId: { in: ids } },
        select: { appliedToBookingId: true },
        distinct: ["appliedToBookingId"],
      })).map((row) => row.appliedToBookingId),
  },
  // Through the modification that minted the credit, which a draft's cleanup deletes.
  "MemberCredit.sourceBookingModificationId": {
    appendOnly: false,
    read: async (db, ids) =>
      (await db.memberCredit.findMany({
        where: { sourceBookingModification: { bookingId: { in: ids } } },
        select: { sourceBookingModification: { select: { bookingId: true } } },
      })).map((row) => row.sourceBookingModification?.bookingId ?? null),
  },
  // The payment and its refund and recovery work: RESTRICT before M2 already.
  "Payment.bookingId": {
    appendOnly: false,
    read: async (db, ids) =>
      (await db.payment.findMany({ where: { bookingId: { in: ids } }, select: { bookingId: true } })).map(
        (row) => row.bookingId,
      ),
  },
  "RefundRequest.bookingId": {
    appendOnly: false,
    read: async (db, ids) =>
      (await db.refundRequest.findMany({
        where: { bookingId: { in: ids } },
        select: { bookingId: true },
        distinct: ["bookingId"],
      })).map((row) => row.bookingId),
  },
  "ManualRefundTask.bookingId": {
    appendOnly: false,
    read: async (db, ids) =>
      (await db.manualRefundTask.findMany({
        where: { bookingId: { in: ids } },
        select: { bookingId: true },
        distinct: ["bookingId"],
      })).map((row) => row.bookingId),
  },
  "PaymentRecoveryOperation.bookingId": {
    appendOnly: false,
    read: async (db, ids) =>
      (await db.paymentRecoveryOperation.findMany({
        where: { bookingId: { in: ids } },
        select: { bookingId: true },
        distinct: ["bookingId"],
      })).map((row) => row.bookingId),
  },
  // An organiser's group settlement: its Stripe payment, Xero invoice and amount.
  // The group cascades with its organiser's booking; the settlement refuses.
  "GroupBookingSettlement.groupBookingId": {
    appendOnly: false,
    read: async (db, ids) =>
      (await db.groupBookingSettlement.findMany({
        where: { groupBooking: { organiserBookingId: { in: ids } } },
        select: { groupBooking: { select: { organiserBookingId: true } } },
      })).map((row) => row.groupBooking.organiserBookingId),
  },
} satisfies Record<string, FinancialHistoryReader>;

export type BookingFinancialHistoryRelation = keyof typeof FINANCIAL_HISTORY_READERS;

/** Every `Model.field` relation that names a booking as financial history. */
export const BOOKING_FINANCIAL_HISTORY_RELATIONS = Object.keys(
  FINANCIAL_HISTORY_READERS,
) as ReadonlyArray<BookingFinancialHistoryRelation>;

/** The append-only money lines among them: rows no code deletes. */
export const APPEND_ONLY_FINANCIAL_HISTORY_RELATIONS = BOOKING_FINANCIAL_HISTORY_RELATIONS.filter(
  (relation) => FINANCIAL_HISTORY_READERS[relation].appendOnly,
);

/** The ids among `bookingIds` that a row of any of `relations` (all, by default) names. */
export async function bookingsWithFinancialHistory(
  db: FinancialHistoryStore,
  bookingIds: readonly string[],
  relations: ReadonlyArray<BookingFinancialHistoryRelation> = BOOKING_FINANCIAL_HISTORY_RELATIONS,
): Promise<Set<string>> {
  const ids = [...new Set(bookingIds)];
  if (ids.length === 0) return new Set();
  const named = await Promise.all(relations.map((relation) => FINANCIAL_HISTORY_READERS[relation].read(db, ids)));
  return new Set(named.flat().filter((id): id is string => id !== null));
}
