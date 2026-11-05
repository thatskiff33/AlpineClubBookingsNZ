import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { appliedCreditSettledByCancel, bookingsAppliedCreditSettledByCancel } from "@/lib/xero-applied-credit-ledger-state";
import { writtenDownCentsByCreditNote, writtenDownCentsByMemberAndNote } from "@/lib/xero-credit-note-write-down";

/**
 * #4220: the batched forms the early warning reads give exactly what the engine's
 * one-at-a-time forms give (`INV-SSOT`: one rule, two shapes of read).
 */

const payment = (captured: boolean) => ({
  id: "p",
  bookingId: "b",
  source: "STRIPE",
  status: captured ? "SUCCEEDED" : "PENDING",
  amountCents: 10_000,
  refundedAmountCents: 0,
  transactions: captured ? [{ status: "SUCCEEDED" }] : [],
  booking: { organiserSettled: false, parentBookingId: null },
});

describe("bookingsAppliedCreditSettledByCancel agrees with appliedCreditSettledByCancel", () => {
  const bookings: Record<string, { status: string; payment: ReturnType<typeof payment> | null }> = {
    live: { status: "CONFIRMED", payment: payment(false) },
    cancelledUncaptured: { status: "CANCELLED", payment: payment(false) },
    cancelledCaptured: { status: "CANCELLED", payment: payment(true) },
    cancelledNoPayment: { status: "CANCELLED", payment: null },
    restoredLive: { status: "CONFIRMED", payment: payment(false) },
    restoredCaptured: { status: "CONFIRMED", payment: payment(true) },
  };
  const restored = new Set(["restoredLive", "restoredCaptured", "missing"]);
  const db = {
    booking: {
      findUnique: async ({ where }: { where: { id: string } }) => bookings[where.id] ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => (bookings[id] ? [{ id, ...bookings[id] }] : [])),
    },
    memberCredit: {
      findUnique: async ({ where }: { where: { restoredFromBookingId: string } }) => (restored.has(where.restoredFromBookingId) ? { id: "r" } : null),
      findMany: async ({ where }: { where: { restoredFromBookingId: { in: string[] } } }) =>
        where.restoredFromBookingId.in.filter((id) => restored.has(id)).map((id) => ({ restoredFromBookingId: id })),
    },
  } as never;

  it("for every shape of booking, and a booking that no longer exists", async () => {
    const ids = [...Object.keys(bookings), "missing", "unknown"];
    const single = new Set<string>();
    for (const id of ids) if (await appliedCreditSettledByCancel(id, db)) single.add(id);
    expect(await bookingsAppliedCreditSettledByCancel(ids, db)).toEqual(single);
    expect([...single].sort()).toEqual(["cancelledNoPayment", "cancelledUncaptured", "missing", "restoredLive"]);
    expect(await bookingsAppliedCreditSettledByCancel([], db)).toEqual(new Set());
  });
});

describe("writtenDownCentsByMemberAndNote agrees with writtenDownCentsByCreditNote", () => {
  const rows = [
    { memberId: "m1", xeroCreditNoteId: "N1", amountCents: -3_000 },
    { memberId: "m1", xeroCreditNoteId: "N1", amountCents: 1_000 },
    { memberId: "m1", xeroCreditNoteId: "N2", amountCents: 500 },
    { memberId: "m2", xeroCreditNoteId: "N1", amountCents: -700 },
  ];
  const memberMatches = (filter: string | { in: string[] }, memberId: string) => (typeof filter === "string" ? filter === memberId : filter.in.includes(memberId));
  const groupBy = vi.fn(async ({ by, where }: { by: string[]; where: { memberId: string | { in: string[] }; xeroCreditNoteId: { in: string[] }; type: string; outsideSpendConvergedAt: unknown } }) => {
    expect(where).toMatchObject({ type: "ADMIN_ADJUSTMENT", outsideSpendConvergedAt: { not: null } });
    const groups = new Map<string, { memberId: string; xeroCreditNoteId: string; _sum: { amountCents: number } }>();
    for (const row of rows.filter((r) => memberMatches(where.memberId, r.memberId) && where.xeroCreditNoteId.in.includes(r.xeroCreditNoteId))) {
      const key = by.map((k) => row[k as keyof typeof row]).join("|");
      const group = groups.get(key) ?? { memberId: row.memberId, xeroCreditNoteId: row.xeroCreditNoteId, _sum: { amountCents: 0 } };
      group._sum.amountCents += row.amountCents;
      groups.set(key, group);
    }
    return [...groups.values()];
  });
  const db = { memberCredit: { groupBy } } as never;

  it("per member, per note, never below zero, in one read", async () => {
    groupBy.mockClear();
    const batched = await writtenDownCentsByMemberAndNote(db, ["m1", "m2"], ["N1", "N2"]);
    expect(groupBy).toHaveBeenCalledTimes(1);
    for (const memberId of ["m1", "m2"]) {
      expect(batched.get(memberId) ?? new Map()).toEqual(await writtenDownCentsByCreditNote(db, memberId, ["N1", "N2"]));
    }
    expect(batched.get("m1")).toEqual(new Map([["N1", 2_000], ["N2", 0]]));
    expect(await writtenDownCentsByMemberAndNote(db, [], ["N1"])).toEqual(new Map());
  });
});
