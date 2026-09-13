import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory Prisma stub shared across the handler tests. Its `groupBy`
// faithfully honors the `appliedToBookingId: { not }` filter, so the retry test
// below only passes when the engine excludes THIS booking's own committed join
// rows when re-planning (the #1620 re-plan-poison fix).
const h = vi.hoisted(() => {
  interface JoinRow {
    id: string;
    memberCreditId: string;
    xeroCreditNoteId: string | null;
    appliedToBookingId: string;
    amountCents: number;
  }
  interface AppliedRow {
    appliedToBookingId: string;
    type: string;
    amountCents: number;
    xeroCreditNoteId: string | null;
  }
  interface Lot {
    id: string;
    memberId: string;
    amountCents: number;
    xeroCreditNoteId: string | null;
  }
  interface Link {
    localModel: string;
    localId: string;
    xeroObjectType: string;
    role: string;
    active: boolean;
  }

  const state = {
    joinRows: [] as JoinRow[],
    appliedRows: [] as AppliedRow[],
    lots: [] as Lot[],
    links: [] as Link[],
    allocCalls: 0,
    deallocationFence: null as { id: string; status: string } | null,
  };

  const matchesApplied = (
    r: AppliedRow,
    where: { appliedToBookingId: string; type: string; xeroCreditNoteId: null },
  ) =>
    r.appliedToBookingId === where.appliedToBookingId &&
    r.type === where.type &&
    (where.xeroCreditNoteId === null ? r.xeroCreditNoteId === null : true);

  const prismaStub = {
    xeroSyncOperation: {
      findMany: async () => state.deallocationFence
        ? [{ ...state.deallocationFence, requestPayload: { ledgerSnapshot: {} } }]
        : [],
    },
    booking: {
      findUnique: async () => ({
        id: "b1",
        memberId: "m1",
        payment: { id: "p1", xeroInvoiceId: "inv1" },
      }),
    },
    memberCredit: {
      aggregate: async ({
        where,
      }: {
        where: { appliedToBookingId: string; type: string; xeroCreditNoteId: null };
      }) => {
        const rows = state.appliedRows.filter((r) => matchesApplied(r, where));
        const sum = rows.reduce((s, r) => s + r.amountCents, 0);
        return { _sum: { amountCents: rows.length ? sum : null } };
      },
      findMany: async ({ where }: { where: { memberId: string } }) =>
        state.lots
          .filter((l) => l.memberId === where.memberId && l.amountCents > 0)
          .map((l) => ({
            id: l.id,
            amountCents: l.amountCents,
            xeroCreditNoteId: l.xeroCreditNoteId,
          })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { appliedToBookingId: string; type: string; xeroCreditNoteId: null };
        data: { xeroCreditNoteId: string };
      }) => {
        let count = 0;
        for (const r of state.appliedRows) {
          if (matchesApplied(r, where)) {
            r.xeroCreditNoteId = data.xeroCreditNoteId;
            count += 1;
          }
        }
        return { count };
      },
    },
    memberCreditNoteAllocation: {
      groupBy: async ({
        where,
      }: {
        where: {
          memberCreditId: { in: string[] };
          appliedToBookingId?: { not: string };
        };
      }) => {
        const inIds = where.memberCreditId.in;
        const notBooking = where.appliedToBookingId?.not;
        const filtered = state.joinRows.filter(
          (j) =>
            inIds.includes(j.memberCreditId) &&
            (notBooking === undefined ? true : j.appliedToBookingId !== notBooking),
        );
        const byId = new Map<string, number>();
        for (const j of filtered) {
          byId.set(j.memberCreditId, (byId.get(j.memberCreditId) ?? 0) + j.amountCents);
        }
        return [...byId.entries()].map(([memberCreditId, amt]) => ({
          memberCreditId,
          _sum: { amountCents: amt },
        }));
      },
      upsert: async ({
        where,
        create,
      }: {
        where: {
          memberCreditId_appliedToBookingId: {
            memberCreditId: string;
            appliedToBookingId: string;
          };
        };
        create: {
          memberCreditId: string;
          xeroCreditNoteId: string | null;
          appliedToBookingId: string;
          amountCents: number;
        };
      }) => {
        const key = where.memberCreditId_appliedToBookingId;
        const existing = state.joinRows.find(
          (j) =>
            j.memberCreditId === key.memberCreditId &&
            j.appliedToBookingId === key.appliedToBookingId,
        );
        if (existing) {
          return existing;
        }
        const row = { id: `jr${state.joinRows.length + 1}`, ...create };
        state.joinRows.push(row);
        return row;
      },
      findUnique: async ({
        where,
      }: {
        where: {
          memberCreditId_appliedToBookingId: {
            memberCreditId: string;
            appliedToBookingId: string;
          };
        };
      }) => {
        const key = where.memberCreditId_appliedToBookingId;
        const row = state.joinRows.find(
          (j) =>
            j.memberCreditId === key.memberCreditId &&
            j.appliedToBookingId === key.appliedToBookingId,
        );
        return row ? { id: row.id } : null;
      },
    },
    xeroObjectLink: {
      findFirst: async ({ where }: { where: Link }) => {
        const row = state.links.find(
          (l) =>
            l.localModel === where.localModel &&
            l.localId === where.localId &&
            l.xeroObjectType === where.xeroObjectType &&
            l.role === where.role &&
            l.active === where.active,
        );
        return row ? { id: "link" } : null;
      },
    },
    $transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      cb(prismaStub),
  };

  return { state, prismaStub };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prismaStub }));
vi.mock("@/lib/member-credit", () => ({ lockMemberCreditLedger: vi.fn() }));
vi.mock("@/lib/xero-credit-notes", () => ({ allocateCreditNoteToInvoice: vi.fn() }));
vi.mock("@/lib/xero-sync", () => ({
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  buildXeroIdempotencyKey: vi.fn(() => "idem-key"),
}));

import { CreditType } from "@prisma/client";
import {
  allocateAppliedCreditForBooking,
  planAppliedCreditAllocation,
  type AppliedCreditLot,
} from "@/lib/xero-applied-credit-allocation";
import {
  mintSliceMappingKey,
  planMintGroups,
} from "@/lib/xero-applied-credit-mint-accounts";
import { allocateCreditNoteToInvoice } from "@/lib/xero-credit-notes";
import { completeXeroSyncOperation } from "@/lib/xero-sync";

function noteLot(
  id: string,
  xeroCreditNoteId: string,
  remainingCents: number,
): AppliedCreditLot {
  return {
    memberCreditId: id,
    creditType: CreditType.CANCELLATION_REFUND,
    xeroCreditNoteId,
    remainingCents,
  };
}

function adminLot(id: string, remainingCents: number): AppliedCreditLot {
  return {
    memberCreditId: id,
    creditType: CreditType.ADMIN_ADJUSTMENT,
    xeroCreditNoteId: null,
    remainingCents,
  };
}

/** A noteless lot that is NOT goodwill: #1547-restored cancellation credit. */
function restoredLot(id: string, remainingCents: number): AppliedCreditLot {
  return {
    memberCreditId: id,
    creditType: CreditType.CANCELLATION_REFUND,
    xeroCreditNoteId: null,
    remainingCents,
  };
}

describe("planAppliedCreditAllocation (#1620 allocate-existing)", () => {
  it("allocates a single floating note that fully covers the applied amount", () => {
    const plan = planAppliedCreditAllocation([noteLot("c1", "cn1", 5000)], 3000);
    expect(plan.noteAllocations).toEqual([
      { memberCreditId: "c1", xeroCreditNoteId: "cn1", amountCents: 3000 },
    ]);
    expect(plan.mintSlices).toEqual([]);
    expect(plan.mintTotalCents).toBe(0);
    expect(plan.coveredCents).toBe(3000);
  });

  it("consumes floating notes oldest-first across multiple lots", () => {
    const plan = planAppliedCreditAllocation(
      [noteLot("c1", "cn1", 2000), noteLot("c2", "cn2", 5000)],
      3000,
    );
    expect(plan.noteAllocations).toEqual([
      { memberCreditId: "c1", xeroCreditNoteId: "cn1", amountCents: 2000 },
      { memberCreditId: "c2", xeroCreditNoteId: "cn2", amountCents: 1000 },
    ]);
    expect(plan.mintTotalCents).toBe(0);
  });

  it("mints a fresh note for the admin-adjustment (noteless) remainder", () => {
    const plan = planAppliedCreditAllocation(
      [noteLot("c1", "cn1", 2000), adminLot("c2", 5000)],
      3000,
    );
    expect(plan.noteAllocations).toEqual([
      { memberCreditId: "c1", xeroCreditNoteId: "cn1", amountCents: 2000 },
    ]);
    expect(plan.mintSlices).toEqual([
      {
        memberCreditId: "c2",
        creditType: CreditType.ADMIN_ADJUSTMENT,
        amountCents: 1000,
      },
    ]);
    expect(plan.mintTotalCents).toBe(1000);
    expect(plan.coveredCents).toBe(3000);
  });

  it("mints the whole amount when the member has only noteless credit", () => {
    const plan = planAppliedCreditAllocation([adminLot("c1", 5000)], 4000);
    expect(plan.noteAllocations).toEqual([]);
    expect(plan.mintSlices).toEqual([
      {
        memberCreditId: "c1",
        creditType: CreditType.ADMIN_ADJUSTMENT,
        amountCents: 4000,
      },
    ]);
    expect(plan.mintTotalCents).toBe(4000);
  });

  it("skips fully-consumed lots (zero remaining)", () => {
    const plan = planAppliedCreditAllocation(
      [noteLot("c1", "cn1", 0), noteLot("c2", "cn2", 3000)],
      3000,
    );
    expect(plan.noteAllocations).toEqual([
      { memberCreditId: "c2", xeroCreditNoteId: "cn2", amountCents: 3000 },
    ]);
  });

  it("throws when the lots cannot cover the applied amount (ledger inconsistency)", () => {
    expect(() =>
      planAppliedCreditAllocation([noteLot("c1", "cn1", 1000)], 3000),
    ).toThrow(/ledger inconsistency/);
  });

  it("stops at the applied amount without touching later lots", () => {
    const plan = planAppliedCreditAllocation(
      [noteLot("c1", "cn1", 5000), adminLot("c2", 5000)],
      4000,
    );
    expect(plan.noteAllocations).toEqual([
      { memberCreditId: "c1", xeroCreditNoteId: "cn1", amountCents: 4000 },
    ]);
    expect(plan.mintSlices).toEqual([]);
    expect(plan.mintTotalCents).toBe(0);
  });
});

/**
 * #2717 — which Xero mapping a minted slice posts to is decided by the lot's
 * CREDIT TYPE, never by whether it happens to have a note yet.
 *
 * Three noteless populations reach this mint, and only the first is goodwill.
 * Restored cancellation credit is permanently noteless — nothing ever backfills
 * a note onto it — so a note-based test would book a member's own prepaid money
 * as a discretionary club expense for ever. An ordinary refund read before its
 * note arrives from the outbox worker would land wherever worker latency put it.
 */
describe("mintSliceMappingKey (#2717): goodwill is the admin adjustment", () => {
  it("sends an admin adjustment to the goodwill expense mapping", () => {
    expect(mintSliceMappingKey(CreditType.ADMIN_ADJUSTMENT)).toBe(
      "goodwillWriteOffs",
    );
  });

  it("leaves restored cancellation credit on the refund mapping", () => {
    // The member's own prepaid money coming back, not generosity by the club.
    expect(mintSliceMappingKey(CreditType.CANCELLATION_REFUND)).toBe(
      "hutFeeRefunds",
    );
  });

  it("leaves a downward-reprice refund on the refund mapping", () => {
    expect(mintSliceMappingKey(CreditType.BOOKING_MODIFICATION_REFUND)).toBe(
      "hutFeeRefunds",
    );
  });

  it("leaves a clamp offset row on the refund mapping", () => {
    // A POSITIVE BOOKING_APPLIED row is the #1887 clamp's offset: it reverses
    // an application, it does not grant anything.
    expect(mintSliceMappingKey(CreditType.BOOKING_APPLIED)).toBe(
      "hutFeeRefunds",
    );
  });
});

describe("planMintGroups (#2717)", () => {
  it("splits a mixed remainder and conserves every cent", () => {
    const plan = planAppliedCreditAllocation(
      [restoredLot("c1", 2000), adminLot("c2", 1500)],
      3500,
    );
    const groups = planMintGroups(plan.mintSlices);
    expect(groups).toEqual([
      { mappingKey: "hutFeeRefunds", amountCents: 2000 },
      { mappingKey: "goodwillWriteOffs", amountCents: 1500 },
    ]);
    expect(groups.reduce((sum, g) => sum + g.amountCents, 0)).toBe(
      plan.mintTotalCents,
    );
  });

  it("emits ONE group when every slice shares a destination", () => {
    const plan = planAppliedCreditAllocation(
      [restoredLot("c1", 2000), restoredLot("c2", 1000)],
      3000,
    );
    expect(planMintGroups(plan.mintSlices)).toEqual([
      { mappingKey: "hutFeeRefunds", amountCents: 3000 },
    ]);
  });

  it("emits the groups in a fixed order, independent of ledger order", () => {
    // The recorded request payload and every replay of it must agree, so the
    // order cannot come from which lot happened to be created first.
    const goodwillFirst = planMintGroups([
      { creditType: CreditType.ADMIN_ADJUSTMENT, amountCents: 100 },
      { creditType: CreditType.CANCELLATION_REFUND, amountCents: 200 },
    ]);
    const refundFirst = planMintGroups([
      { creditType: CreditType.CANCELLATION_REFUND, amountCents: 200 },
      { creditType: CreditType.ADMIN_ADJUSTMENT, amountCents: 100 },
    ]);
    expect(goodwillFirst).toEqual(refundFirst);
    expect(goodwillFirst.map((g) => g.mappingKey)).toEqual([
      "hutFeeRefunds",
      "goodwillWriteOffs",
    ]);
  });

  it("has no groups at all when there is nothing to mint", () => {
    expect(planMintGroups([])).toEqual([]);
  });
});

describe("allocateAppliedCreditForBooking (#1620 handler retry idempotency)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Scenario: booking b1 (member m1) applied 3000c of credit funded by one
    // floating note lot c1/cn1 (remaining 3000); invoice inv1 raised.
    h.state.joinRows = [];
    h.state.links = [];
    h.state.allocCalls = 0;
    h.state.deallocationFence = null;
    h.state.appliedRows = [
      {
        appliedToBookingId: "b1",
        type: "BOOKING_APPLIED",
        amountCents: -3000,
        xeroCreditNoteId: null,
      },
    ];
    h.state.lots = [
      { id: "c1", memberId: "m1", amountCents: 3000, xeroCreditNoteId: "cn1" },
    ];
  });

  it("recovers after a mid-flight Xero failure without re-plan poisoning or double allocation", async () => {
    // First allocation attempt: Xero throws (transient). The plan-phase join row
    // has already committed at this point — the classic re-plan-poison trigger.
    vi.mocked(allocateCreditNoteToInvoice).mockImplementation(
      async (
        _creditNoteId: string,
        _invoiceId: string,
        _amountCents: number,
        opts?: { localModel?: string; localId?: string; role?: string },
      ) => {
        h.state.allocCalls += 1;
        if (h.state.allocCalls === 1) {
          throw new Error("Xero rate limit (transient)");
        }
        h.state.links.push({
          localModel: opts?.localModel ?? "",
          localId: opts?.localId ?? "",
          xeroObjectType: "ALLOCATION",
          role: opts?.role ?? "",
          active: true,
        });
      },
    );

    // Attempt 1 fails.
    await expect(
      allocateAppliedCreditForBooking("b1", { syncOperationId: "op1" }),
    ).rejects.toThrow(/transient/);
    // The join row committed on attempt 1.
    expect(h.state.joinRows).toHaveLength(1);
    // The stamp did NOT run (credit still unallocated in the ledger).
    expect(h.state.appliedRows[0].xeroCreditNoteId).toBeNull();

    // Attempt 2 (the outbox/operator replay) must reproduce the same plan — the
    // re-plan must exclude b1's own committed join row, or it would read the lot
    // as consumed and throw a spurious ledger inconsistency (bricking the op).
    await expect(
      allocateAppliedCreditForBooking("b1", { syncOperationId: "op1" }),
    ).resolves.toBeUndefined();

    // Allocated exactly once more (2 calls total: 1 failed + 1 success) — no
    // duplicate allocation, no plan explosion.
    expect(allocateCreditNoteToInvoice).toHaveBeenCalledTimes(2);
    expect(allocateCreditNoteToInvoice).toHaveBeenLastCalledWith(
      "cn1",
      "inv1",
      3000,
      expect.objectContaining({
        appliedCreditContext: {
          parentOperationId: "op1",
          bookingId: "b1",
          paymentId: "p1",
        },
      }),
    );
    // Still a single join row (upsert stayed a no-op on replay).
    expect(h.state.joinRows).toHaveLength(1);
    // The BOOKING_APPLIED row is now stamped (invoice reduced, #1597-fed).
    expect(h.state.appliedRows[0].xeroCreditNoteId).toBe("cn1");
    // The op completed exactly once (attempt 1 threw before completion).
    expect(completeXeroSyncOperation).toHaveBeenCalledTimes(1);
  });

  it("fences allocation planning under the member lock before any local/provider mutation", async () => {
    h.state.deallocationFence = { id: "dealloc-1", status: "RUNNING" };

    await expect(
      allocateAppliedCreditForBooking("b1", { syncOperationId: "allocation-1" }),
    ).rejects.toThrow("dealloc-1 is RUNNING");
    expect(h.state.joinRows).toHaveLength(0);
    expect(allocateCreditNoteToInvoice).not.toHaveBeenCalled();
  });

  it("is a no-op skip when replayed after a fully-completed allocation", async () => {
    vi.mocked(allocateCreditNoteToInvoice).mockImplementation(
      async (
        _creditNoteId: string,
        _invoiceId: string,
        _amountCents: number,
        opts?: { localModel?: string; localId?: string; role?: string },
      ) => {
        h.state.allocCalls += 1;
        h.state.links.push({
          localModel: opts?.localModel ?? "",
          localId: opts?.localId ?? "",
          xeroObjectType: "ALLOCATION",
          role: opts?.role ?? "",
          active: true,
        });
      },
    );

    await allocateAppliedCreditForBooking("b1", { syncOperationId: "op1" });
    expect(allocateCreditNoteToInvoice).toHaveBeenCalledTimes(1);
    expect(h.state.appliedRows[0].xeroCreditNoteId).toBe("cn1");

    // Replay after full success: the credit is already stamped, so the handler
    // short-circuits (skip) and performs no further allocation.
    await allocateAppliedCreditForBooking("b1", { syncOperationId: "op1" });
    expect(allocateCreditNoteToInvoice).toHaveBeenCalledTimes(1);
    expect(h.state.joinRows).toHaveLength(1);
    // Both runs resolved the op (first: complete, second: skip-complete).
    expect(completeXeroSyncOperation).toHaveBeenCalledTimes(2);
  });
});
