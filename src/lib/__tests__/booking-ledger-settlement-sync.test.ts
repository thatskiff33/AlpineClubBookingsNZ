/**
 * The store-facing half of the settlement sync (#3581): what it reads, what it
 * writes, and what it deliberately does not swallow.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";

function store(overrides: {
  payment?: unknown;
  posted?: unknown[];
  createMany?: ReturnType<typeof vi.fn>;
} = {}) {
  const createMany = overrides.createMany ?? vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  const order: string[] = [];
  const findMany = vi.fn(async () => {
    order.push("lines");
    return overrides.posted ?? [];
  });
  const findUnique = vi.fn(async (args: { select?: Record<string, unknown> }) => {
    const isRowsRead = Boolean(args?.select?.transactions);
    order.push(isRowsRead ? "rows" : "owner");
    if (!isRowsRead) {
      return overrides.payment === null ? null : { bookingId: "b1" };
    }
    return overrides.payment === undefined
      ? {
          bookingId: "b1",
          manuallyMarkedPaidAt: null,
          manuallyMarkedPaidByMemberId: null,
          booking: { lodgeId: "l1" },
          transactions: [{ id: "t1", source: "STRIPE", status: "SUCCEEDED", amountCents: 10_000 }],
          refunds: [],
        }
      : overrides.payment;
  });
  return {
    s: { payment: { findUnique }, bookingLedgerLine: { findMany, createMany } } as never,
    createMany,
    findMany,
    findUnique,
    order,
  };
}

describe("syncBookingLedgerSettlements", () => {
  it("posts what the rows imply, through the write door, skipping keys already there", async () => {
    const { s, createMany } = store();
    await syncBookingLedgerSettlements({ paymentId: "p1", store: s });
    const call = createMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>>; skipDuplicates: boolean };
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toHaveLength(1);
    expect(call.data[0]).toMatchObject({ kind: "CARD_CAPTURE", postingKey: "capture:t1", bookingId: "b1", lodgeId: "l1" });
  });

  it("reads only the booking's settlement lines — never its charge lines", async () => {
    const { s, findMany } = store();
    await syncBookingLedgerSettlements({ paymentId: "p1", store: s });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "b1", anchorKind: { in: ["PAYMENT_TRANSACTION", "PAYMENT_REFUND"] } },
      }),
    );
  });

  it("reads the posted lines BEFORE the payment's rows, so a mixed snapshot can never reverse wrongly", async () => {
    // Review of #3604: rows-then-lines let an older "not captured" row meet a
    // newer line and post a permanent wrong reversal. Lines-then-rows can only
    // re-plan a line already there, which the key turns into a skip.
    const { s, order } = store();
    await syncBookingLedgerSettlements({ paymentId: "p1", store: s });
    expect(order).toEqual(["owner", "lines", "rows"]);
  });

  it("does nothing for a payment that no longer exists", async () => {
    const { s, createMany, findMany } = store({ payment: null });
    await syncBookingLedgerSettlements({ paymentId: "gone", store: s });
    expect(findMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("swallows a plan that cannot be built — pure code, nothing sent — and writes nothing", async () => {
    // A projection missing its rows throws inside the pure half; the caller's
    // transaction is untouched, so the payment write it belongs to stands.
    const { s, createMany } = store({
      payment: { bookingId: "b1", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null, booking: { lodgeId: "l1" } },
    });
    await expect(syncBookingLedgerSettlements({ paymentId: "p1", store: s })).resolves.toBeUndefined();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("does NOT swallow a refused write — the transaction is already lost, and hiding it would only hide why", async () => {
    // #3590's lesson: a statement PostgreSQL refuses has aborted the caller's
    // transaction, so the sync lets it propagate rather than pretend.
    const createMany = vi.fn(async () => {
      throw new Error("refused by the database");
    });
    const { s } = store({ createMany });
    await expect(syncBookingLedgerSettlements({ paymentId: "p1", store: s })).rejects.toThrow(
      "refused by the database",
    );
  });

  it("reads a manually settled payment as cash, by the provenance column alone (INV-PAY-001)", async () => {
    const { s, createMany } = store({
      payment: {
        bookingId: "b1",
        manuallyMarkedPaidAt: new Date("2026-06-01T00:00:00.000Z"),
        manuallyMarkedPaidByMemberId: "officer-1",
        booking: { lodgeId: "l1" },
        transactions: [{ id: "t1", source: "INTERNET_BANKING", status: "SUCCEEDED", amountCents: 10_000 }],
        refunds: [],
      },
    });
    await syncBookingLedgerSettlements({ paymentId: "p1", store: s });
    const row = (createMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>> }).data[0];
    expect(row).toMatchObject({ kind: "CASH_RECORDED", settlementMethod: "CASH", postedByMemberId: "officer-1" });
  });
});
