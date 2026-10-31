import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import type { Prisma } from "@prisma/client";

import {
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

/** A store whose financial delegates name exactly `named`, per delegate. */
function storeNaming(named: Partial<Record<string, string[]>> = {}) {
  const rows = (key: string, field: string) =>
    vi.fn(async () => (named[key] ?? []).map((bookingId) => ({ [field]: bookingId })));
  return {
    bookingLedgerLine: { findMany: rows("BookingLedgerLine.bookingId", "bookingId") },
    memberMoneyLine: { findMany: rows("MemberMoneyLine.bookingId", "bookingId") },
    memberCredit: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("sourceBookingId" in where) {
          return (named["MemberCredit.sourceBookingId"] ?? []).map((id) => ({ sourceBookingId: id }));
        }
        if ("appliedToBookingId" in where) {
          return (named["MemberCredit.appliedToBookingId"] ?? []).map((id) => ({ appliedToBookingId: id }));
        }
        return (named["MemberCredit.sourceBookingModificationId"] ?? []).map((id) => ({
          sourceBookingModification: { bookingId: id },
        }));
      }),
    },
    payment: { findMany: rows("Payment.bookingId", "bookingId") },
    refundRequest: { findMany: rows("RefundRequest.bookingId", "bookingId") },
    manualRefundTask: { findMany: rows("ManualRefundTask.bookingId", "bookingId") },
    paymentRecoveryOperation: { findMany: rows("PaymentRecoveryOperation.bookingId", "bookingId") },
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
