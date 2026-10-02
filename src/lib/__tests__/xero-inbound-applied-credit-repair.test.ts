import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const h = vi.hoisted(() => {
  const memberCreditFindMany = vi.fn();
  const memberCreditCreate = vi.fn();
  const memberCreditUpdate = vi.fn();
  const memberCreditUpdateMany = vi.fn();
  const memberCreditAggregate = vi.fn();
  // #3792: the restore-row read of the sync guard.
  const memberCreditFindUnique = vi.fn();
  const allocationAggregate = vi.fn();
  const paymentFindUnique = vi.fn();
  const paymentUpdate = vi.fn();
  const operationFindMany = vi.fn();
  const linkFindMany = vi.fn();
  const sliceFindMany = vi.fn();
  const paymentFindMany = vi.fn();
  const repairPrecise = vi.fn();
  const lockLedger = vi.fn();
  const notifyXeroSyncError = vi.fn();
  // #3792: the durable record of a refused change.
  const auditLogFindFirst = vi.fn();
  const createAuditLog = vi.fn();
  const tx = {
    memberCredit: {
      findMany: memberCreditFindMany,
      create: memberCreditCreate,
      update: memberCreditUpdate,
      updateMany: memberCreditUpdateMany,
      aggregate: memberCreditAggregate,
      findUnique: memberCreditFindUnique,
    },
    memberCreditNoteAllocation: { aggregate: allocationAggregate },
    payment: { findUnique: paymentFindUnique, update: paymentUpdate },
    xeroSyncOperation: { findMany: operationFindMany },
  };
  const prisma = {
    payment: { findMany: paymentFindMany },
    xeroObjectLink: { findMany: linkFindMany },
    memberCreditNoteAllocation: { findMany: sliceFindMany },
    auditLog: { findFirst: auditLogFindFirst },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return {
    prisma,
    tx,
    memberCreditFindMany,
    memberCreditCreate,
    memberCreditUpdate,
    memberCreditUpdateMany,
    memberCreditAggregate,
    memberCreditFindUnique,
    allocationAggregate,
    paymentFindUnique,
    paymentUpdate,
    operationFindMany,
    linkFindMany,
    sliceFindMany,
    paymentFindMany,
    repairPrecise,
    lockLedger,
    notifyXeroSyncError,
    auditLogFindFirst,
    createAuditLog,
  };
});

// #3599: the credit rows' ledger lines are posted by one sync, proved in its own
// suites and against Postgres; this suite tests what it always tested.
const syncCredits = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/booking-ledger-credit-sync", () => ({
  syncBookingLedgerCredits: syncCredits,
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/member-credit", () => ({ lockMemberCreditLedger: h.lockLedger }));
vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking: h.repairPrecise,
}));
vi.mock("@/lib/xero-inbound/object-links", () => ({
  findActiveXeroObjectLinks: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: h.notifyXeroSyncError }));
vi.mock("@/lib/audit", () => ({ createAuditLog: h.createAuditLog }));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  repairAccountCreditAllocationBusinessState,
  resolveAppliedCreditPaymentsFromLocalProvenance,
} from "@/lib/xero-inbound/credit-note-repairs";

describe("provider-aware inbound applied-credit repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.operationFindMany.mockResolvedValue([]);
    h.linkFindMany.mockResolvedValue([]);
    h.prisma.payment.findMany.mockResolvedValue([{
      id: "payment-1",
      bookingId: "booking-1",
      amountCents: 10000,
      creditAppliedCents: 3000,
      booking: { memberId: "member-1" },
    }]);
    h.memberCreditFindMany.mockResolvedValue([{
      id: "historical-negative",
      amountCents: -3000,
      description: "Applied to booking booking-",
      xeroCreditNoteId: "cn-1",
    }]);
    h.paymentFindUnique.mockResolvedValue({ creditAppliedCents: 3000 });
    h.memberCreditCreate.mockResolvedValue({});
    h.repairPrecise.mockResolvedValue(0);
    h.memberCreditFindUnique.mockResolvedValue(null);
    h.auditLogFindFirst.mockResolvedValue(null);
    h.createAuditLog.mockResolvedValue(undefined);
  });

  it.each([
    ["decrease", 2000, 1000],
    ["increase", 4000, -1000],
  ])(
    "preserves historical rows and appends the provider manual %s delta",
    async (_label, targetCents, expectedOffsetCents) => {
      h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: targetCents } });
      h.memberCreditAggregate
        .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
        .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
        .mockResolvedValue({ _sum: { amountCents: -targetCents } });

      await repairAccountCreditAllocationBusinessState("cn-1", [{
        invoiceId: "invoice-1",
        amountCents: targetCents,
      }]);

      expect(h.repairPrecise).toHaveBeenCalledWith(
        "booking-1",
        "invoice-1",
        h.tx,
        CLUB_FORMAT_TEST,
        {
          providerTarget: { xeroCreditNoteId: "cn-1", amountCents: targetCents },
        },
      );
      expect(h.memberCreditUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amountCents: expect.anything() }) }),
      );
      expect(h.memberCreditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amountCents: expectedOffsetCents,
          xeroCreditNoteId: "cn-1",
        }),
      });
      // #3599: the appended row reaches the ledger, for ITS booking, in this transaction.
      expect(syncCredits).toHaveBeenCalledWith({ bookingId: "booking-1", store: h.tx });
      expect(h.paymentUpdate).toHaveBeenCalledWith({
        where: { id: "payment-1" },
        data: { creditAppliedCents: targetCents },
      });
      expect(h.lockLedger.mock.invocationCallOrder[0]).toBeLessThan(
        h.operationFindMany.mock.invocationCallOrder[0],
      );
      expect(h.operationFindMany.mock.invocationCallOrder[0]).toBeLessThan(
        h.repairPrecise.mock.invocationCallOrder[0],
      );
    },
  );

  it("defers stale inbound provider truth while a fresh clamp deallocation is pending", async () => {
    h.operationFindMany.mockResolvedValue([{
      id: "dealloc-pending",
      status: "PENDING",
      requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION" },
    }]);

    await expect(
      repairAccountCreditAllocationBusinessState("cn-1", [{
        invoiceId: "invoice-1",
        amountCents: 3000,
      }]),
    ).rejects.toThrow("dealloc-pending is PENDING");
    expect(h.repairPrecise).not.toHaveBeenCalled();
    expect(h.memberCreditCreate).not.toHaveBeenCalled();
  });

  it("reconciles a manually deleted final provider allocation to zero from its active link", async () => {
    h.linkFindMany.mockResolvedValue([{
      metadata: { creditNoteId: "cn-1", invoiceId: "invoice-1", amountCents: 3000 },
    }]);
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
      .mockResolvedValue({ _sum: { amountCents: 0 } });

    await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.linkFindMany).toHaveBeenCalledWith({
      where: {
        xeroObjectType: "ALLOCATION",
        role: {
          in: [
            "APPLIED_CREDIT_ALLOCATION",
            "APPLIED_CREDIT_REMAINDER_ALLOCATION",
          ],
        },
        active: true,
        metadata: { path: ["creditNoteId"], equals: "cn-1" },
      },
      select: { metadata: true },
    });
    expect(h.repairPrecise).toHaveBeenCalledWith(
      "booking-1",
      "invoice-1",
      h.tx,
      CLUB_FORMAT_TEST,
      {
        providerTarget: { xeroCreditNoteId: "cn-1", amountCents: 0 },
      },
    );
    expect(h.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountCents: 3000,
        xeroCreditNoteId: "cn-1",
      }),
    });
    expect(syncCredits).toHaveBeenCalledWith({ bookingId: "booking-1", store: h.tx });
    expect(h.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-1" },
      data: { creditAppliedCents: 0 },
    });
    // #3792: a live booking has no restore row, so the de-allocation still
    // credits the member and nothing is alerted.
    expect(h.memberCreditFindUnique).toHaveBeenCalledWith({
      where: { restoredFromBookingId: "booking-1" },
      select: { amountCents: true },
    });
    expect(h.notifyXeroSyncError).not.toHaveBeenCalled();
  });

  // #3792: the booking was cancelled and its applied $30 already given back by
  // restoreCreditFromBooking (the late capacity cancel, the never-captured
  // cancel, the hold release or the settle's capacity void). Xero later loses
  // the allocation: crediting the $30 again would pay the member twice.
  it("refuses to credit a de-allocation on a cancelled booking whose applied credit was already restored, and alerts an operator (#3792)", async () => {
    h.linkFindMany.mockResolvedValue([{
      metadata: { creditNoteId: "cn-1", invoiceId: "invoice-1", amountCents: 3000 },
    }]);
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
      .mockResolvedValue({ _sum: { amountCents: -3000 } });
    h.memberCreditFindUnique.mockResolvedValue({ amountCents: 3000 });

    const result = await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.memberCreditCreate).not.toHaveBeenCalled();
    expect(syncCredits).not.toHaveBeenCalled();
    expect(h.paymentUpdate).not.toHaveBeenCalled();
    expect(result.skippedAllocations).toBe(1);
    expect(h.notifyXeroSyncError).toHaveBeenCalledTimes(1);
    expect(h.notifyXeroSyncError).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "applied-credit-restored-booking-allocation-change",
      operation: "inbound-applied-credit-repair:cn-1",
      errorMessage: expect.stringContaining("was reduced in Xero by $30.00, but booking booking-1 is cancelled"),
    }));
    // The durable record an officer can always find, whatever the email throttle did.
    expect(h.createAuditLog).toHaveBeenCalledTimes(1);
    expect(h.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "xero.allocation.restored-booking-change-refused",
      entityType: "Booking",
      entityId: "booking-1",
      category: "xero",
      severity: "critical",
      metadata: expect.objectContaining({ xeroCreditNoteId: "cn-1", direction: "reduced", refusedCents: 3000, restoredCents: 3000 }),
    }));
    expect(h.createAuditLog.mock.calls[0][0]).not.toHaveProperty("subjectMemberId");
    // A full restore: nothing beyond it to flag.
    expect(h.notifyXeroSyncError.mock.calls[0][0].errorMessage).not.toContain("beyond what was restored");
    expect(h.notifyXeroSyncError.mock.calls[0][0].errorMessage).toContain("its applied credit ($30.00) was already restored to the member");
  });

  it("names the part of a refused de-allocation beyond a TIERED restore: the cancellation fee, for an officer to grant if intended (#3792)", async () => {
    h.linkFindMany.mockResolvedValue([{
      metadata: { creditNoteId: "cn-1", invoiceId: "invoice-1", amountCents: 3000 },
    }]);
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
      .mockResolvedValue({ _sum: { amountCents: -3000 } });
    // A 50% cancellation tier restored $15 of the $30 applied.
    h.memberCreditFindUnique.mockResolvedValue({ amountCents: 1500 });

    await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.memberCreditCreate).not.toHaveBeenCalled();
    expect(h.notifyXeroSyncError).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining(
        "$15.00 of this is beyond what was restored (the cancellation fee); grant it by hand if the waiver was intended.",
      ),
    }));
    const tieredMessage = h.notifyXeroSyncError.mock.calls[0][0].errorMessage as string;
    expect(tieredMessage).toContain("is cancelled and the credit restored to the member was $15.00.");
    expect(tieredMessage).not.toContain("its applied credit");
    // The alert goes out after the ledger transaction, not inside it.
    expect(h.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      h.notifyXeroSyncError.mock.invocationCallOrder[0],
    );
  });

  it("refuses to debit an allocation INCREASE on a cancelled booking whose applied credit was already restored (#3792)", async () => {
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 4000 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
      .mockResolvedValue({ _sum: { amountCents: -3000 } });
    h.memberCreditFindUnique.mockResolvedValue({ amountCents: 3000 });

    const result = await repairAccountCreditAllocationBusinessState("cn-1", [{ invoiceId: "invoice-1", amountCents: 4000 }]);

    expect(h.memberCreditCreate).not.toHaveBeenCalled();
    expect(h.paymentUpdate).not.toHaveBeenCalled();
    expect(result.skippedAllocations).toBe(1);
    expect(h.notifyXeroSyncError).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "applied-credit-restored-booking-allocation-change",
      errorMessage: expect.stringContaining("was increased in Xero by $10.00"),
    }));
    expect(h.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ direction: "increased", refusedCents: 1000 }),
    }));
  });

  it("creates no fresh applied-credit row on a restored booking either: the create branch is refused too (#3792)", async () => {
    // No applied row linked to the note and none unlinked at the amount: the
    // repair would otherwise create a fresh BOOKING_APPLIED debit.
    h.memberCreditFindMany.mockResolvedValue([]);
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 3000 } });
    h.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: -3000 } });
    h.memberCreditFindUnique.mockResolvedValue({ amountCents: 3000 });

    await repairAccountCreditAllocationBusinessState("cn-1", [{ invoiceId: "invoice-1", amountCents: 3000 }]);

    expect(h.memberCreditCreate).not.toHaveBeenCalled();
  });

  it("records a refused change once: a replayed sync finds its audit row and writes no second (#3792)", async () => {
    h.linkFindMany.mockResolvedValue([{
      metadata: { creditNoteId: "cn-1", invoiceId: "invoice-1", amountCents: 3000 },
    }]);
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
      .mockResolvedValue({ _sum: { amountCents: -3000 } });
    h.memberCreditFindUnique.mockResolvedValue({ amountCents: 3000 });
    h.auditLogFindFirst.mockResolvedValue({ id: "audit-1" });

    await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.createAuditLog).not.toHaveBeenCalled();
    expect(h.notifyXeroSyncError).toHaveBeenCalledTimes(1);
  });

  it("still debits an allocation increase on a booking with no restore row", async () => {
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 4000 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } })
      .mockResolvedValue({ _sum: { amountCents: -4000 } });

    await repairAccountCreditAllocationBusinessState("cn-1", [{ invoiceId: "invoice-1", amountCents: 4000 }]);

    expect(h.memberCreditFindUnique).toHaveBeenCalledWith({
      where: { restoredFromBookingId: "booking-1" },
      select: { amountCents: true },
    });
    expect(h.notifyXeroSyncError).not.toHaveBeenCalled();
    expect(h.createAuditLog).not.toHaveBeenCalled();
    expect(h.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: -1000 }),
    });
  });

  it("is a no-op on replay: deleted-final-allocation reconciliation run twice appends no second offset row (#1887)", async () => {
    h.linkFindMany.mockResolvedValue([{
      metadata: { creditNoteId: "cn-1", invoiceId: "invoice-1", amountCents: 3000 },
    }]);

    // Run 1: the provider allocation was deleted (target 0) while a historical
    // -3000 applied row remains, so the reconciler appends a single +3000
    // offset to bring the signed ledger to provider truth (0).
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } })     // unstamped (null cn)
      .mockResolvedValueOnce({ _sum: { amountCents: -3000 } }) // current ledger (pre-offset)
      .mockResolvedValue({ _sum: { amountCents: 0 } });        // post-offset total

    await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.memberCreditCreate).toHaveBeenCalledTimes(1);
    expect(h.memberCreditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 3000, xeroCreditNoteId: "cn-1" }),
    });

    // Run 2 (replay): identical provider state, but the +3000 offset from run 1
    // now nets the signed ledger to zero. currentAppliedCents equals the
    // provider-aware applied total (0), so ledgerDeltaCents is 0 and NO new
    // MemberCredit offset row is appended — the reconciliation is idempotent.
    h.memberCreditCreate.mockClear();
    h.memberCreditUpdate.mockClear();
    h.memberCreditUpdateMany.mockClear();
    h.allocationAggregate.mockReset();
    h.memberCreditAggregate.mockReset();
    h.allocationAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
    h.memberCreditAggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } }) // unstamped (offset is cn-1-stamped)
      .mockResolvedValueOnce({ _sum: { amountCents: 0 } }) // current ledger already reconciled to 0
      .mockResolvedValue({ _sum: { amountCents: 0 } });    // post total
    // The replay now sees both the historical and reconciliation-offset rows.
    h.memberCreditFindMany.mockResolvedValue([
      { id: "historical-negative", amountCents: -3000, description: "Applied to booking booking-", xeroCreditNoteId: "cn-1" },
      { id: "reconciliation-offset", amountCents: 3000, description: "Applied to booking booking-", xeroCreditNoteId: "cn-1" },
    ]);

    await repairAccountCreditAllocationBusinessState("cn-1", []);

    expect(h.memberCreditCreate).not.toHaveBeenCalled();
  });
});

describe("resolveAppliedCreditPaymentsFromLocalProvenance (#1925)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sliceFindMany.mockResolvedValue([]);
    h.linkFindMany.mockResolvedValue([]);
    h.paymentFindMany.mockResolvedValue([]);
  });

  it("resolves an admin-adjustment-minted note from precise slice + active link", async () => {
    // No CANCELLATION_REFUND provenance exists; the note is proven by a precise
    // slice stamped with it plus an ACTIVE allocation link (localModel Payment,
    // the minted-remainder shape).
    h.sliceFindMany.mockResolvedValue([
      {
        id: "slice-1",
        appliedToBookingId: "booking-1",
        memberCredit: { memberId: "member-1" },
      },
    ]);
    h.linkFindMany.mockResolvedValue([
      { localModel: "Payment", localId: "payment-1" },
    ]);
    h.paymentFindMany.mockResolvedValue([
      { id: "payment-1", bookingId: "booking-1" },
    ]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([{ id: "payment-1", bookingId: "booking-1" }]);
    // Slice query runs before any link read so the no-provenance path stays cheap.
    expect(h.sliceFindMany).toHaveBeenCalledWith({
      where: { xeroCreditNoteId: "cn-1" },
      select: {
        id: true,
        appliedToBookingId: true,
        memberCredit: { select: { memberId: true } },
      },
    });
    expect(h.linkFindMany).toHaveBeenCalledWith({
      where: {
        xeroObjectType: "ALLOCATION",
        role: {
          in: [
            "APPLIED_CREDIT_ALLOCATION",
            "APPLIED_CREDIT_REMAINDER_ALLOCATION",
          ],
        },
        active: true,
        metadata: { path: ["creditNoteId"], equals: "cn-1" },
      },
      select: { localModel: true, localId: true },
    });
    expect(h.paymentFindMany).toHaveBeenCalledWith({
      where: {
        bookingId: { in: ["booking-1"] },
        booking: { memberId: "member-1" },
      },
      select: { id: true, bookingId: true },
    });
  });

  it("returns [] and does not read links when no slice is stamped with the note", async () => {
    h.sliceFindMany.mockResolvedValue([]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([]);
    expect(h.linkFindMany).not.toHaveBeenCalled();
    expect(h.paymentFindMany).not.toHaveBeenCalled();
    // Benign "nothing to do" short-circuit: no operator alert.
    expect(h.notifyXeroSyncError).not.toHaveBeenCalled();
  });

  it("fails closed (no resurrection) when only a tombstoned inactive link exists", async () => {
    h.sliceFindMany.mockResolvedValue([
      {
        id: "slice-1",
        appliedToBookingId: "booking-1",
        memberCredit: { memberId: "member-1" },
      },
    ]);
    // The active-only link query returns nothing (the sole link is inactive).
    h.linkFindMany.mockResolvedValue([]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([]);
    expect(h.paymentFindMany).not.toHaveBeenCalled();
    // Benign "no active link proves the allocation" short-circuit: no alert.
    expect(h.notifyXeroSyncError).not.toHaveBeenCalled();
  });

  it("fails closed when slices resolve to two candidate members", async () => {
    h.sliceFindMany.mockResolvedValue([
      {
        id: "slice-1",
        appliedToBookingId: "booking-1",
        memberCredit: { memberId: "member-1" },
      },
      {
        id: "slice-2",
        appliedToBookingId: "booking-2",
        memberCredit: { memberId: "member-2" },
      },
    ]);
    h.linkFindMany.mockResolvedValue([
      { localModel: "MemberCreditNoteAllocation", localId: "slice-1" },
    ]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([]);
    expect(h.paymentFindMany).not.toHaveBeenCalled();
    // Ambiguous local evidence: emit the deduped operator alert.
    expect(h.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "applied-credit-repair-ambiguous",
        operation: "inbound-applied-credit-repair:cn-1",
      }),
    );
  });

  it("fails closed when a stamped slice is missing its funding lot", async () => {
    h.sliceFindMany.mockResolvedValue([
      {
        id: "slice-1",
        appliedToBookingId: "booking-1",
        memberCredit: null,
      },
    ]);
    h.linkFindMany.mockResolvedValue([
      { localModel: "MemberCreditNoteAllocation", localId: "slice-1" },
    ]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([]);
    expect(h.paymentFindMany).not.toHaveBeenCalled();
    expect(h.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "applied-credit-repair-ambiguous" }),
    );
  });

  it("fails closed when an active link references a slice not stamped for this note", async () => {
    h.sliceFindMany.mockResolvedValue([
      {
        id: "slice-1",
        appliedToBookingId: "booking-1",
        memberCredit: { memberId: "member-1" },
      },
    ]);
    // Conflicting slice-vs-link evidence: the link points at a foreign slice.
    h.linkFindMany.mockResolvedValue([
      { localModel: "MemberCreditNoteAllocation", localId: "slice-foreign" },
    ]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([]);
    expect(h.paymentFindMany).not.toHaveBeenCalled();
    expect(h.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "applied-credit-repair-ambiguous" }),
    );
  });

  it("fails closed when an active remainder link points outside the stamped member/booking set", async () => {
    h.sliceFindMany.mockResolvedValue([
      {
        id: "slice-1",
        appliedToBookingId: "booking-1",
        memberCredit: { memberId: "member-1" },
      },
    ]);
    h.linkFindMany.mockResolvedValue([
      { localModel: "Payment", localId: "payment-foreign" },
    ]);
    // Only the in-set payment resolves; the foreign remainder link has no match.
    h.paymentFindMany.mockResolvedValue([
      { id: "payment-1", bookingId: "booking-1" },
    ]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([]);
    expect(h.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "applied-credit-repair-ambiguous" }),
    );
  });

  it("fails closed when the stamped booking resolves to no local payment", async () => {
    h.sliceFindMany.mockResolvedValue([
      {
        id: "slice-1",
        appliedToBookingId: "booking-1",
        memberCredit: { memberId: "member-1" },
      },
    ]);
    h.linkFindMany.mockResolvedValue([
      { localModel: "MemberCreditNoteAllocation", localId: "slice-1" },
    ]);
    h.paymentFindMany.mockResolvedValue([]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([]);
    expect(h.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "applied-credit-repair-ambiguous" }),
    );
  });

  it("does not alert on the happy path when local provenance is unambiguous", async () => {
    h.sliceFindMany.mockResolvedValue([
      {
        id: "slice-1",
        appliedToBookingId: "booking-1",
        memberCredit: { memberId: "member-1" },
      },
    ]);
    h.linkFindMany.mockResolvedValue([
      { localModel: "Payment", localId: "payment-1" },
    ]);
    h.paymentFindMany.mockResolvedValue([
      { id: "payment-1", bookingId: "booking-1" },
    ]);

    const result = await resolveAppliedCreditPaymentsFromLocalProvenance("cn-1");

    expect(result).toEqual([{ id: "payment-1", bookingId: "booking-1" }]);
    expect(h.notifyXeroSyncError).not.toHaveBeenCalled();
  });
});
