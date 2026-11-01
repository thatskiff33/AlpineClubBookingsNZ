import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import type { Prisma } from "@prisma/client";

import {
  APPEND_ONLY_FINANCIAL_HISTORY_RELATIONS,
  BOOKING_FINANCIAL_HISTORY_RELATIONS,
  bookingsWithFinancialHistory,
} from "@/lib/booking-financial-history";
import { deleteDraftBookingDependents } from "@/lib/draft-booking-cleanup";

/**
 * #4514 (Ledger M2; D1 on #4482): a draft that financial history names is never
 * hard-deleted, and the cleanup writes nothing for it. The database's RESTRICT
 * keys are the guard (`database-roles.realdb.test.ts`); this read only keeps one
 * anomalous draft from aborting the whole nightly batch.
 */

/** The ids a reader's `where` asks about: its single `{ in: [...] }` list, wherever it nests. */
function askedIds(where: unknown): string[] {
  if (!where || typeof where !== "object") return [];
  if (Array.isArray((where as { in?: unknown }).in)) return (where as { in: string[] }).in;
  return Object.values(where).flatMap(askedIds);
}

/**
 * A store whose financial delegates name exactly `named`, per relation, and only
 * among the bookings each query asks about, so a reader that asked the wrong
 * delegate or the wrong ids finds nothing.
 */
function storeNaming(named: Partial<Record<string, string[]>> = {}) {
  const hits = (key: string, where: unknown) => (named[key] ?? []).filter((id) => askedIds(where).includes(id));
  const rows = (key: string, field: string) =>
    vi.fn(async ({ where }: { where: unknown }) => hits(key, where).map((bookingId) => ({ [field]: bookingId })));
  return {
    bookingLedgerLine: { findMany: rows("BookingLedgerLine.bookingId", "bookingId") },
    memberMoneyLine: { findMany: rows("MemberMoneyLine.bookingId", "bookingId") },
    memberCredit: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("sourceBookingId" in where) {
          return hits("MemberCredit.sourceBookingId", where).map((id) => ({ sourceBookingId: id }));
        }
        if ("appliedToBookingId" in where) {
          return hits("MemberCredit.appliedToBookingId", where).map((id) => ({ appliedToBookingId: id }));
        }
        return hits("MemberCredit.sourceBookingModificationId", where).map((id) => ({
          sourceBookingModification: { bookingId: id },
        }));
      }),
    },
    payment: { findMany: rows("Payment.bookingId", "bookingId") },
    refundRequest: { findMany: rows("RefundRequest.bookingId", "bookingId") },
    manualRefundTask: { findMany: rows("ManualRefundTask.bookingId", "bookingId") },
    paymentRecoveryOperation: { findMany: rows("PaymentRecoveryOperation.bookingId", "bookingId") },
    groupBookingSettlement: {
      findMany: vi.fn(async ({ where }: { where: unknown }) =>
        hits("GroupBookingSettlement.groupBookingId", where).map((id) => ({ groupBooking: { organiserBookingId: id } }))),
    },
  };
}

describe("bookingsWithFinancialHistory (#4514)", () => {
  it("asks nothing for no bookings", async () => {
    const store = storeNaming();
    expect(await bookingsWithFinancialHistory(store as never, [])).toEqual(new Set());
    expect(store.bookingLedgerLine.findMany).not.toHaveBeenCalled();
  });

  it.each(BOOKING_FINANCIAL_HISTORY_RELATIONS.map((relation) => [relation]))(
    "finds a booking that %s names, and only that booking",
    async (relation) => {
      const store = storeNaming({ [relation]: ["named"] });
      expect(await bookingsWithFinancialHistory(store as never, ["named", "clean", "named"])).toEqual(
        new Set(["named"]),
      );
    },
  );

  it("asks each relation for exactly the given bookings, by the key that names them", async () => {
    const store = storeNaming();
    await bookingsWithFinancialHistory(store as never, ["a", "b", "a"]);
    const ids = { in: ["a", "b"] };
    const distinctBooking = { select: { bookingId: true }, distinct: ["bookingId"] };
    expect(store.bookingLedgerLine.findMany).toHaveBeenCalledWith({ where: { bookingId: ids }, ...distinctBooking });
    expect(store.memberMoneyLine.findMany).toHaveBeenCalledWith({ where: { bookingId: ids }, ...distinctBooking });
    expect(store.refundRequest.findMany).toHaveBeenCalledWith({ where: { bookingId: ids }, ...distinctBooking });
    expect(store.manualRefundTask.findMany).toHaveBeenCalledWith({ where: { bookingId: ids }, ...distinctBooking });
    expect(store.paymentRecoveryOperation.findMany).toHaveBeenCalledWith({ where: { bookingId: ids }, ...distinctBooking });
    expect(store.payment.findMany).toHaveBeenCalledWith({ where: { bookingId: ids }, select: { bookingId: true } });
    expect(store.memberCredit.findMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { sourceBookingId: ids }, select: { sourceBookingId: true }, distinct: ["sourceBookingId"] },
      { where: { appliedToBookingId: ids }, select: { appliedToBookingId: true }, distinct: ["appliedToBookingId"] },
      { where: { sourceBookingModification: { bookingId: ids } }, select: { sourceBookingModification: { select: { bookingId: true } } } },
    ]);
    expect(store.groupBookingSettlement.findMany).toHaveBeenCalledWith({
      where: { groupBooking: { organiserBookingId: ids } },
      select: { groupBooking: { select: { organiserBookingId: true } } },
    });
  });

  it("can be limited to the append-only money lines, asking nothing else", async () => {
    const store = storeNaming({ "BookingLedgerLine.bookingId": ["a"], "Payment.bookingId": ["b"] });
    expect(APPEND_ONLY_FINANCIAL_HISTORY_RELATIONS).toEqual(["BookingLedgerLine.bookingId", "MemberMoneyLine.bookingId"]);
    expect(await bookingsWithFinancialHistory(store as never, ["a", "b"], APPEND_ONLY_FINANCIAL_HISTORY_RELATIONS))
      .toEqual(new Set(["a"]));
    expect(store.payment.findMany).not.toHaveBeenCalled();
  });

  it("drops a credit row whose modification has no booking id", async () => {
    const store = storeNaming();
    store.memberCredit.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      ("sourceBookingModification" in where ? [{ sourceBookingModification: null }] : []) as never);
    expect(await bookingsWithFinancialHistory(store as never, ["a"])).toEqual(new Set());
  });
});

describe("deleteDraftBookingDependents withholds drafts with financial history (#4514)", () => {
  function cleanupTx(named: Partial<Record<string, string[]>>) {
    return {
      ...storeNaming(named),
      promoRedemption: { delete: vi.fn(async () => ({})) },
      promoRedemptionAllocation: { count: vi.fn(async () => 1) },
      promoCode: { update: vi.fn(async () => ({})) },
      bookingChangeRequest: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      bookingModification: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      bookingEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    };
  }

  it("clears only the money-free drafts and touches none of the withheld one's dependents", async () => {
    const tx = cleanupTx({ "BookingLedgerLine.bookingId": ["paid-draft"] });
    const summary = await deleteDraftBookingDependents(tx as unknown as Prisma.TransactionClient, [
      { id: "paid-draft", promoRedemptions: [{ id: "r-paid", promoCodeId: "code-a" }] },
      { id: "plain-draft", promoRedemptions: [{ id: "r-plain", promoCodeId: "code-b" }] },
    ]);

    expect(summary.bookingIds).toEqual(["plain-draft"]);
    expect(summary.withheldBookingIds).toEqual(["paid-draft"]);
    expect(tx.promoRedemption.delete).toHaveBeenCalledTimes(1);
    expect(tx.promoRedemption.delete).toHaveBeenCalledWith({ where: { id: "r-plain" } });
    for (const deleteMany of [tx.bookingChangeRequest, tx.bookingModification, tx.bookingEvent]) {
      expect(deleteMany.deleteMany).toHaveBeenCalledWith({ where: { bookingId: { in: ["plain-draft"] } } });
    }
  });

  it("writes nothing at all when every draft is withheld", async () => {
    const tx = cleanupTx({ "MemberCredit.appliedToBookingId": ["only-draft"] });
    const summary = await deleteDraftBookingDependents(tx as unknown as Prisma.TransactionClient, [
      { id: "only-draft", promoRedemptions: [{ id: "r-1", promoCodeId: "code-a" }] },
    ]);

    expect(summary).toEqual({
      bookingIds: [],
      withheldBookingIds: ["only-draft"],
      promoRedemptions: 0,
      changeRequests: 0,
      modifications: 0,
      events: 0,
    });
    expect(tx.promoRedemption.delete).not.toHaveBeenCalled();
    expect(tx.bookingModification.deleteMany).not.toHaveBeenCalled();
  });
});
