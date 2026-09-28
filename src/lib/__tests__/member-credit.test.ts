import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

// ── Mock Prisma ─────────────────────────────────────────────────────────────

const prismaMock = {
  memberCredit: {
    aggregate: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
    update: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
  adminCreditAdjustmentRequest: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  payment: { findUnique: vi.fn() },
  cancellationPolicy: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  $executeRaw: vi.fn().mockResolvedValue(undefined),
  $transaction: vi.fn(),
};

prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) =>
  callback(prismaMock)
);

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

// #3599: every credit writer posts the booking's ledger lines through the one
// sync, inside its own client. The sync itself is proved in
// `booking-ledger-credit-sync.test.ts` and against Postgres; here it is a spy,
// so these suites keep testing the credit rows and can assert the handoff.
const mockSyncBookingLedgerCredits = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/booking-ledger-credit-sync", () => ({
  syncBookingLedgerCredits: mockSyncBookingLedgerCredits,
}));

const mockApplyLocalRefundAllocation = vi.fn();
const mockStartXeroSyncOperation = vi.fn();
const mockRepairLegacyAppliedCreditNoteAllocationsForBooking = vi.fn();

vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: mockApplyLocalRefundAllocation,
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  startXeroSyncOperation: mockStartXeroSyncOperation,
}));
vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking:
    mockRepairLegacyAppliedCreditNoteAllocationsForBooking,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

function aggregateResult(amountCents: number | null) {
  return {
    _sum: { amountCents },
    _count: null,
    _avg: null,
    _max: null,
    _min: null,
  } as any;
}

type PendingAdjustmentRequest = {
  id: string;
  memberId: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
  status: string;
  requestedById: string;
  reviewedById?: string;
  reviewedAt?: Date;
};

function pendingRequest(
  overrides: Record<string, unknown> = {}
): PendingAdjustmentRequest {
  return {
    id: "req-1",
    memberId: "member-1",
    amountCents: 2500,
    description: "Service recovery",
    idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
    status: "PENDING",
    requestedById: "admin-requester",
    ...overrides,
  };
}

// ── Tests: Credit Balance Helpers ───────────────────────────────────────────

describe("member-credit helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getMemberCreditBalance", () => {
    it("returns 0 when no credits exist", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue({
        _sum: { amountCents: null },
        _count: null, _avg: null, _max: null, _min: null,
      } as any);

      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1");

      expect(balance).toBe(0);
    });

    it("returns correct sum of mixed credits", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue({
        _sum: { amountCents: 3000 },
        _count: null, _avg: null, _max: null, _min: null,
      } as any);

      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1");

      expect(balance).toBe(3000);
    });

    it("accepts optional transaction client", async () => {
      const txClient = {
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 5000 },
          }),
        },
      };

      const { prisma } = await import("@/lib/prisma");
      const { getMemberCreditBalance } = await import("@/lib/member-credit");
      const balance = await getMemberCreditBalance("member-1", txClient as any);

      expect(balance).toBe(5000);
      expect(txClient.memberCredit.aggregate).toHaveBeenCalled();
      expect(prisma.memberCredit.aggregate).not.toHaveBeenCalled();
    });
  });

  describe("createCancellationCredit", () => {
    it("creates a CANCELLATION_REFUND record with correct fields", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createCancellationCredit } = await import("@/lib/member-credit");
      await createCancellationCredit("member-1", 5000, "booking-abc12345", "xero-cn-1");

      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 5000,
          type: "CANCELLATION_REFUND",
          sourceBookingId: "booking-abc12345",
          xeroCreditNoteId: "xero-cn-1",
        }),
      });
      expect(mockSyncBookingLedgerCredits).toHaveBeenCalledWith({
        bookingId: "booking-abc12345",
        store: prisma,
      });
    });

    it("handles missing Xero credit note ID", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createCancellationCredit } = await import("@/lib/member-credit");
      await createCancellationCredit("member-1", 3000, "booking-xyz");

      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          xeroCreditNoteId: null,
        }),
      });
    });
  });

  describe("createBookingModificationCredit", () => {
    it("creates a traceable BOOKING_MODIFICATION_REFUND record", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createBookingModificationCredit } = await import("@/lib/member-credit");
      await createBookingModificationCredit(
        "member-1",
        3750,
        "booking-abc12345",
        "mod-1"
      );

      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 3750,
          type: "BOOKING_MODIFICATION_REFUND",
          sourceBookingId: "booking-abc12345",
          sourceBookingModificationId: "mod-1",
          xeroCreditNoteId: null,
        }),
      });
      expect(mockSyncBookingLedgerCredits).toHaveBeenCalledWith({
        bookingId: "booking-abc12345",
        store: prisma,
      });
    });

    it("does not duplicate credit for the same booking modification", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findUnique).mockResolvedValue({
        id: "credit-1",
        memberId: "member-1",
        amountCents: 3750,
        type: "BOOKING_MODIFICATION_REFUND",
        sourceBookingId: "booking-abc12345",
        sourceBookingModificationId: "mod-1",
        xeroCreditNoteId: null,
      } as any);

      const { createBookingModificationCredit } = await import("@/lib/member-credit");
      await createBookingModificationCredit(
        "member-1",
        3750,
        "booking-abc12345",
        "mod-1"
      );

      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
    });

    it("allocates the credit against the payment when paymentId is provided (#1031)", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { createBookingModificationCredit } = await import("@/lib/member-credit");
      await createBookingModificationCredit(
        "member-1",
        3750,
        "booking-abc12345",
        "mod-1",
        undefined,
        undefined,
        "payment-1"
      );

      expect(mockApplyLocalRefundAllocation).toHaveBeenCalledWith({
        paymentId: "payment-1",
        amountCents: 3750,
        store: prisma,
      });
    });

    it("skips allocation on an idempotent replay (#1031)", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findUnique).mockResolvedValue({
        id: "credit-1",
        memberId: "member-1",
        amountCents: 3750,
        type: "BOOKING_MODIFICATION_REFUND",
        sourceBookingId: "booking-abc12345",
        sourceBookingModificationId: "mod-1",
        xeroCreditNoteId: null,
      } as any);

      const { createBookingModificationCredit } = await import("@/lib/member-credit");
      await createBookingModificationCredit(
        "member-1",
        3750,
        "booking-abc12345",
        "mod-1",
        undefined,
        undefined,
        "payment-1"
      );

      expect(mockApplyLocalRefundAllocation).not.toHaveBeenCalled();
    });

    it("replays safely after a unique conflict", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "credit-1",
          memberId: "member-1",
          amountCents: 3750,
          type: "BOOKING_MODIFICATION_REFUND",
          sourceBookingId: "booking-abc12345",
          sourceBookingModificationId: "mod-1",
          xeroCreditNoteId: null,
        } as any);
      vi.mocked(prisma.memberCredit.create).mockRejectedValueOnce({ code: "P2002" });

      const { createBookingModificationCredit } = await import("@/lib/member-credit");
      await createBookingModificationCredit(
        "member-1",
        3750,
        "booking-abc12345",
        "mod-1"
      );

      expect(prisma.memberCredit.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("applyCreditToBooking", () => {
    it("creates a negative BOOKING_APPLIED record", async () => {
      const txClient = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 10000 },
          }),
          create: vi.fn().mockResolvedValue({} as any),
        },
      };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await applyCreditToBooking("member-1", 5000, "booking-new", txClient as any, CLUB_FORMAT_TEST);

      expect(txClient.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: -5000,
          type: "BOOKING_APPLIED",
          appliedToBookingId: "booking-new",
        }),
      });
      expect(mockSyncBookingLedgerCredits).toHaveBeenCalledWith({
        bookingId: "booking-new",
        store: txClient,
      });
    });

    it("throws if insufficient balance", async () => {
      const txClient = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        memberCredit: {
          aggregate: vi.fn().mockResolvedValue({
            _sum: { amountCents: 2000 },
          }),
        },
      };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await expect(
        applyCreditToBooking("member-1", 5000, "booking-new", txClient as any, CLUB_FORMAT_TEST)
      ).rejects.toThrow("Insufficient credit balance");
    });

    it("throws if amount is zero or negative", async () => {
      const txClient = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        memberCredit: { aggregate: vi.fn() },
      };

      const { applyCreditToBooking } = await import("@/lib/member-credit");
      await expect(
        applyCreditToBooking("member-1", 0, "booking-new", txClient as any, CLUB_FORMAT_TEST)
      ).rejects.toThrow("Credit amount must be positive");
    });
  });

  describe("restoreCreditFromBooking", () => {
    it("restores the FULL applied total when no override is passed (guards the payment-reconciliation system void, #1164)", async () => {
      // The capacity_failed system void in payment-reconciliation.ts calls this
      // with no override and MUST still restore 100% — a system void never
      // penalises the member. This is an explicit assertion, not an assumption.
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -3000, type: "BOOKING_APPLIED" },
        { id: "c2", amountCents: -2000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.createMany).mockResolvedValue({ count: 1 });

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-cancelled");

      expect(restored).toBe(5000);
      // #1636: the restore now inserts via createMany + skipDuplicates (ON
      // CONFLICT DO NOTHING on the unique restoredFromBookingId key).
      expect(prisma.memberCredit.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            memberId: "member-1",
            amountCents: 5000,
            type: "CANCELLATION_REFUND",
            sourceBookingId: "booking-cancelled",
            restoredFromBookingId: "booking-cancelled",
          }),
        ],
        skipDuplicates: true,
      });
      expect(mockSyncBookingLedgerCredits).toHaveBeenCalledWith({
        bookingId: "booking-cancelled",
        store: prisma,
      });
    });

    it("restores the SIGNED net (not the abs-sum) when the ledger carries an F20 clamp offset (#1887 F2)", async () => {
      // A card booking applied 4000 then repriced down: the F20 clamp appended a
      // POSITIVE +1000 BOOKING_APPLIED offset, netting applied to 3000. The
      // DEFAULT (no-override) restore MUST return the net 3000, not Σ|amount|
      // (5000) — over-restoring by 2×excess would mint credit from nothing.
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -4000, type: "BOOKING_APPLIED" },
        { id: "c2", amountCents: 1000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.createMany).mockResolvedValue({ count: 1 });

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-clamped");

      expect(restored).toBe(3000);
      expect(prisma.memberCredit.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ amountCents: 3000 })],
        skipDuplicates: true,
      });
    });

    it("restores exactly the tiered override when one is passed (#1164)", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -3000, type: "BOOKING_APPLIED" },
        { id: "c2", amountCents: -2000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.createMany).mockResolvedValue({ count: 1 });

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      // Tiered override of 2500 against a 5000 applied total restores 2500.
      const restored = await restoreCreditFromBooking(
        "member-1",
        "booking-cancelled",
        undefined,
        2500
      );

      expect(restored).toBe(2500);
      expect(prisma.memberCredit.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            memberId: "member-1",
            amountCents: 2500,
            type: "CANCELLATION_REFUND",
            sourceBookingId: "booking-cancelled",
            restoredFromBookingId: "booking-cancelled",
          }),
        ],
        skipDuplicates: true,
      });
    });

    it("caps the override at the applied total in the safe (never over-restore) direction (#1164)", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -3000, type: "BOOKING_APPLIED" },
        { id: "c2", amountCents: -2000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.createMany).mockResolvedValue({ count: 1 });

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      // Override 9000 exceeds the 5000 applied total -> capped to 5000.
      const restored = await restoreCreditFromBooking(
        "member-1",
        "booking-cancelled",
        undefined,
        9000
      );

      expect(restored).toBe(5000);
      expect(prisma.memberCredit.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ amountCents: 5000 })],
        skipDuplicates: true,
      });
    });

    it("returns 0 and writes nothing when the override is 0 (#1164)", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -5000, type: "BOOKING_APPLIED" },
      ] as any);

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking(
        "member-1",
        "booking-cancelled",
        undefined,
        0
      );

      expect(restored).toBe(0);
      expect(prisma.memberCredit.createMany).not.toHaveBeenCalled();
    });

    it("returns 0 when no credit was applied", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([]);

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-new");

      expect(restored).toBe(0);
      expect(prisma.memberCredit.createMany).not.toHaveBeenCalled();
    });

    it("conserves the ledger: a never-captured cancel restore nets applied credit to 0 (#1547)", async () => {
      // Real restore math with no override: apply X (a −X BOOKING_APPLIED row),
      // then restore on cancel writes exactly +X as CANCELLATION_REFUND with the
      // booking as sourceBookingId, so Σ(applied) + restored === 0.
      const { prisma } = await import("@/lib/prisma");
      const appliedRows = [
        { id: "c1", amountCents: -8000, type: "BOOKING_APPLIED" },
        { id: "c2", amountCents: -4000, type: "BOOKING_APPLIED" },
      ];
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue(
        appliedRows as never
      );
      vi.mocked(prisma.memberCredit.createMany).mockResolvedValue({ count: 1 });

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-nc");

      const appliedSum = appliedRows.reduce((s, r) => s + r.amountCents, 0);
      expect(restored).toBe(12000);
      const createManyData = vi.mocked(prisma.memberCredit.createMany).mock
        .calls[0][0]!.data;
      const createdRow = Array.isArray(createManyData)
        ? createManyData[0]
        : createManyData;
      expect(createdRow).toMatchObject({
        amountCents: 12000,
        type: "CANCELLATION_REFUND",
        sourceBookingId: "booking-nc",
      });
      // Ledger conservation: the negative applied rows plus the positive restore
      // net exactly to zero.
      expect(appliedSum + restored).toBe(0);
    });

    // ── #1636: structural single-restore per booking ────────────────────────
    it("is a no-op returning 0 when a restore row for the booking already exists (idempotent re-call)", async () => {
      // The unique restoredFromBookingId makes the insert an ON CONFLICT DO
      // NOTHING; a second restore of the same booking inserts nothing (count 0)
      // and MUST return 0 — never a second credit — WITHOUT throwing or aborting
      // the caller's transaction. This is the defence the issue exists for: if a
      // future per-lodge lock split lets two credit-restoring paths race off the
      // shared lock(1), the DB — not the lock — guarantees single-restore.
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -5000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.createMany).mockResolvedValue({ count: 0 });

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const restored = await restoreCreditFromBooking("member-1", "booking-dup");

      expect(restored).toBe(0);
      // It still ATTEMPTED the insert (the conflict is resolved in-DB, not by a
      // pre-read) with skipDuplicates so the conflict does not raise.
      expect(prisma.memberCredit.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.memberCredit.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      );
    });

    it("simulates both restore callers: the first restores the amount, the second is a structural no-op", async () => {
      // Two callers (e.g. booking-cancel and the IB release cron) restore the
      // SAME booking. The first insert wins (count 1 -> amount); the second hits
      // the unique restoredFromBookingId and is skipped (count 0 -> 0). Net
      // ledger effect: exactly one restore row, never two.
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -4000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.createMany)
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const { restoreCreditFromBooking } = await import("@/lib/member-credit");
      const first = await restoreCreditFromBooking("member-1", "booking-race");
      const second = await restoreCreditFromBooking("member-1", "booking-race");

      expect(first).toBe(4000);
      expect(second).toBe(0);
      expect(prisma.memberCredit.createMany).toHaveBeenCalledTimes(2);
    });

    it("permits the legitimate multi-CANCELLATION_REFUND shape: restore carries the dedupe key, createCancellationCredit does not (they coexist for one booking)", async () => {
      // The dedupe key is restore-SPECIFIC on purpose. A booking can legitimately
      // hold BOTH a restore row (reversing applied credit) AND a held-as-credit
      // refund row (createCancellationCredit) — both type=CANCELLATION_REFUND with
      // the same sourceBookingId (booking-cancel.ts paid credit path). Only the
      // restore row sets restoredFromBookingId, so the unique constraint never
      // rejects the held-as-credit refund. This proves the design still permits
      // the multi-row shape a naive unique(sourceBookingId, type) would break.
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.memberCredit.findMany).mockResolvedValue([
        { id: "c1", amountCents: -3000, type: "BOOKING_APPLIED" },
      ] as any);
      vi.mocked(prisma.memberCredit.createMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({} as any);

      const { restoreCreditFromBooking, createCancellationCredit } = await import(
        "@/lib/member-credit"
      );

      await restoreCreditFromBooking("member-1", "booking-both", undefined, 3000);
      await createCancellationCredit("member-1", 2000, "booking-both");

      // Restore row: type=CANCELLATION_REFUND, sourceBookingId set, AND the
      // restore-specific dedupe key set.
      const restoreManyData = vi.mocked(prisma.memberCredit.createMany).mock
        .calls[0][0]!.data;
      const restoreRow = Array.isArray(restoreManyData)
        ? restoreManyData[0]
        : restoreManyData;
      expect(restoreRow).toMatchObject({
        type: "CANCELLATION_REFUND",
        sourceBookingId: "booking-both",
        restoredFromBookingId: "booking-both",
      });

      // Held-as-credit refund row: type=CANCELLATION_REFUND, SAME sourceBookingId,
      // but NO restoredFromBookingId — so the unique constraint cannot reject it.
      const cancellationRow = vi.mocked(prisma.memberCredit.create).mock.calls[0][0]
        .data;
      expect(cancellationRow).toMatchObject({
        type: "CANCELLATION_REFUND",
        sourceBookingId: "booking-both",
      });
      expect(cancellationRow).not.toHaveProperty("restoredFromBookingId");
    });
  });

  // F20 (#1887): a pre-payment reduction can drop finalPriceCents below the
  // credit applied at create; the clamp refunds the excess and nets the applied
  // credit down to the new price so the booking can never dead-end unpayable
  // with credit over-consumed.
  describe("clampAppliedCreditToBookingPrice", () => {
    function makeTx(appliedNetCents: number) {
      return {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        xeroSyncOperation: { findMany: vi.fn().mockResolvedValue([]) },
        booking: { findUnique: vi.fn().mockResolvedValue(null) },
        memberCreditNoteAllocation: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: null } }),
        },
        memberCredit: {
          // deriveBookingAppliedCreditCents reads Σ BOOKING_APPLIED (negative);
          // magnitude is the applied credit.
          aggregate: vi
            .fn()
            .mockResolvedValue({ _sum: { amountCents: appliedNetCents } }),
          create: vi.fn().mockResolvedValue({} as any),
        },
      };
    }

    it("refunds the over-consumed slice and clamps applied credit to the new price", async () => {
      // Applied 4000, reprice to 3000 -> return 1000, net applied 3000.
      const tx = makeTx(-4000);
      const { clampAppliedCreditToBookingPrice } = await import(
        "@/lib/member-credit"
      );

      const result = await clampAppliedCreditToBookingPrice(
        { memberId: "member-1", bookingId: "booking-x", newFinalPriceCents: 3000, format: CLUB_FORMAT_TEST },
        tx as any,
      );

      expect(result).toEqual({
        appliedCreditCents: 3000,
        refundedExcessCents: 1000,
      });
      // A positive BOOKING_APPLIED offset returns the excess to the member's
      // balance and nets the applied credit down to the new price.
      expect(tx.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 1000,
          type: "BOOKING_APPLIED",
          appliedToBookingId: "booking-x",
        }),
      });
      // It serialises on the member-credit ledger lock first.
      expect(tx.$executeRaw).toHaveBeenCalled();
    });

    it("atomically queues IB Xero deallocation for the clamped target", async () => {
      const tx = makeTx(-4000);
      tx.booking.findUnique.mockResolvedValue({
        payment: { id: "payment-1", source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" },
      });
      tx.memberCreditNoteAllocation.aggregate.mockResolvedValue({ _sum: { amountCents: 4000 } });
      const { clampAppliedCreditToBookingPrice } = await import("@/lib/member-credit");
      await clampAppliedCreditToBookingPrice(
        { memberId: "member-1", bookingId: "booking-ib", newFinalPriceCents: 3000, format: CLUB_FORMAT_TEST },
        tx as any
      );
      expect(
        mockRepairLegacyAppliedCreditNoteAllocationsForBooking,
      ).toHaveBeenCalledWith("booking-ib", "inv-1", tx, CLUB_FORMAT_TEST);
      expect(mockStartXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({
        operationType: "UPDATE",
        correlationKey: "booking:booking-ib:applied-credit-deallocation:3000:v1",
        requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION", bookingId: "booking-ib" },
        store: tx,
      }));
    });

    it("fences a competing clamp before its first ledger mutation", async () => {
      const tx = makeTx(-4000);
      tx.booking.findUnique.mockResolvedValue({
        payment: { id: "payment-1", source: "INTERNET_BANKING", xeroInvoiceId: "inv-1" },
      });
      tx.xeroSyncOperation.findMany.mockResolvedValue([{
        id: "dealloc-pending",
        status: "PENDING",
        requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION" },
      }]);
      const { clampAppliedCreditToBookingPrice } = await import("@/lib/member-credit");

      await expect(
        clampAppliedCreditToBookingPrice(
          { memberId: "member-1", bookingId: "booking-ib", newFinalPriceCents: 3000, format: CLUB_FORMAT_TEST },
          tx as any,
        ),
      ).rejects.toThrow("dealloc-pending is PENDING");
      expect(tx.memberCredit.create).not.toHaveBeenCalled();
      expect(mockStartXeroSyncOperation).not.toHaveBeenCalled();
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.xeroSyncOperation.findMany.mock.invocationCallOrder[0],
      );
    });

    it("is a no-op when applied credit still fits the new price", async () => {
      const tx = makeTx(-3000);
      const { clampAppliedCreditToBookingPrice } = await import(
        "@/lib/member-credit"
      );

      const result = await clampAppliedCreditToBookingPrice(
        { memberId: "member-1", bookingId: "booking-y", newFinalPriceCents: 5000, format: CLUB_FORMAT_TEST },
        tx as any,
      );

      expect(result).toEqual({
        appliedCreditCents: 3000,
        refundedExcessCents: 0,
      });
      expect(tx.memberCredit.create).not.toHaveBeenCalled();
    });

    it("is a no-op when applied credit exactly equals the new price (fully covered, nothing over-consumed)", async () => {
      const tx = makeTx(-3000);
      const { clampAppliedCreditToBookingPrice } = await import(
        "@/lib/member-credit"
      );

      const result = await clampAppliedCreditToBookingPrice(
        { memberId: "member-1", bookingId: "booking-z", newFinalPriceCents: 3000, format: CLUB_FORMAT_TEST },
        tx as any,
      );

      expect(result).toEqual({
        appliedCreditCents: 3000,
        refundedExcessCents: 0,
      });
      expect(tx.memberCredit.create).not.toHaveBeenCalled();
    });

    it("is idempotent under re-drive: a re-run over the already-clamped ledger writes nothing", async () => {
      // After the first clamp the net applied is exactly newFinalPriceCents, so a
      // retry (transaction re-drive) sees no excess.
      const tx = makeTx(-3000);
      const { clampAppliedCreditToBookingPrice } = await import(
        "@/lib/member-credit"
      );

      const result = await clampAppliedCreditToBookingPrice(
        { memberId: "member-1", bookingId: "booking-x", newFinalPriceCents: 3000, format: CLUB_FORMAT_TEST },
        tx as any,
      );

      expect(result.refundedExcessCents).toBe(0);
      expect(tx.memberCredit.create).not.toHaveBeenCalled();
    });
  });

  describe("createAdminAdjustment", () => {
    it("creates a pending admin adjustment request", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.adminCreditAdjustmentRequest.create).mockResolvedValue({
        ...pendingRequest({
          amountCents: 2000,
          description: "Goodwill credit",
          requestedById: "admin-1",
        }),
      } as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const result = await createAdminAdjustmentRequest(
        "member-1",
        2000,
        "Goodwill credit",
        "admin-1",
        "9a13b0af-7ffc-451b-a50b-81f6fb8630f4"
      );

      expect(prisma.adminCreditAdjustmentRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 2000,
          description: "Goodwill credit",
          idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
          requestedById: "admin-1",
        }),
        select: expect.any(Object),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
      expect(result.replayed).toBe(false);
      expect(result.request.status).toBe("PENDING");
    });

    it("replays a duplicate request with the same idempotency key", async () => {
      const { prisma } = await import("@/lib/prisma");
      const existingRequest = pendingRequest({
        amountCents: 2000,
        description: "Goodwill credit",
        requestedById: "admin-1",
      });

      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingRequest as any);
      vi.mocked(prisma.adminCreditAdjustmentRequest.create).mockResolvedValue(
        existingRequest as any
      );
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const first = await createAdminAdjustmentRequest(
        "member-1",
        2000,
        "Goodwill credit",
        "admin-1",
        existingRequest.idempotencyKey
      );
      const replay = await createAdminAdjustmentRequest(
        "member-1",
        2000,
        "Goodwill credit",
        "admin-1",
        existingRequest.idempotencyKey
      );

      expect(prisma.adminCreditAdjustmentRequest.create).toHaveBeenCalledTimes(1);
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.request).toEqual(first.request);
    });

    it("rolls back request creation when the audit write fails", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValueOnce(null);

      const committedRequestIds: string[] = [];
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedRequestIds: string[] = [];
        const tx = {
          adminCreditAdjustmentRequest: {
            create: vi.fn(async ({ data }: any) => {
              stagedRequestIds.push("req-audit-fail");
              return {
                ...pendingRequest({
                  id: "req-audit-fail",
                  amountCents: data.amountCents,
                  description: data.description,
                  idempotencyKey: data.idempotencyKey,
                  requestedById: data.requestedById,
                }),
              };
            }),
          },
          memberCredit: {
            aggregate: vi.fn().mockResolvedValue(aggregateResult(5000)),
          },
          auditLog: {
            create: vi.fn().mockRejectedValue(new Error("audit write failed")),
          },
        };

        try {
          const result = await callback(tx);
          committedRequestIds.push(...stagedRequestIds);
          return result;
        } catch (error) {
          return Promise.reject(error);
        }
      });

      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        createAdminAdjustmentRequest(
          "member-1",
          2000,
          "Goodwill credit",
          "admin-1",
          "9a13b0af-7ffc-451b-a50b-81f6fb8630f4"
        )
      ).rejects.toThrow("audit write failed");

      expect(committedRequestIds).toHaveLength(0);
    });

    it("validates negative adjustment doesn't exceed balance", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.adminCreditAdjustmentRequest.create).mockResolvedValue(
        pendingRequest({
          amountCents: -2000,
          description: "Correction",
          requestedById: "admin-1",
        }) as any
      );
      vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue(
        aggregateResult(1000)
      );

      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        createAdminAdjustmentRequest(
          "member-1",
          -2000,
          "Correction",
          "admin-1",
          "9a13b0af-7ffc-451b-a50b-81f6fb8630f4"
        )
      ).rejects.toThrow("Cannot deduct $20.00: only $10.00 available");

      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("rejects zero amount", async () => {
      const { createAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        createAdminAdjustmentRequest(
          "member-1",
          0,
          "Nothing",
          "admin-1",
          "9a13b0af-7ffc-451b-a50b-81f6fb8630f4"
        )
      ).rejects.toThrow("Adjustment amount cannot be zero");
    });
  });

  describe("reviewAdminAdjustmentRequest", () => {
    it("approves a pending request and stamps both admins on the credit row", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValue(
        pendingRequest() as any
      );
      vi.mocked(prisma.adminCreditAdjustmentRequest.updateMany).mockResolvedValue({
        count: 1,
      } as any);
      vi.mocked(prisma.memberCredit.create).mockResolvedValue({
        id: "credit-1",
      } as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const result = await reviewAdminAdjustmentRequest(
        "member-1",
        "req-1",
        "APPROVE",
        "admin-approver"
      );

      expect(prisma.adminCreditAdjustmentRequest.updateMany).toHaveBeenCalledWith({
        where: {
          id: "req-1",
          memberId: "member-1",
          status: "PENDING",
        },
        data: expect.objectContaining({
          status: "APPROVED",
          reviewedById: "admin-approver",
        }),
      });
      expect(prisma.memberCredit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: "member-1",
          amountCents: 2500,
          type: "ADMIN_ADJUSTMENT",
          description: "Service recovery",
          requestedById: "admin-requester",
          approvedById: "admin-approver",
          approvalRequestId: "req-1",
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(result.credit).toEqual({ id: "credit-1" });
    });

    it("rejects self-approval", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValue(
        pendingRequest({ requestedById: "admin-1" }) as any
      );

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        reviewAdminAdjustmentRequest("member-1", "req-1", "APPROVE", "admin-1")
      ).rejects.toThrow("A different admin must approve this adjustment");

      expect(prisma.adminCreditAdjustmentRequest.updateMany).not.toHaveBeenCalled();
      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
    });

    it("rejects a pending request without creating a credit row", async () => {
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.adminCreditAdjustmentRequest.findUnique).mockResolvedValue(
        pendingRequest() as any
      );
      vi.mocked(prisma.adminCreditAdjustmentRequest.updateMany).mockResolvedValue({
        count: 1,
      } as any);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const result = await reviewAdminAdjustmentRequest(
        "member-1",
        "req-1",
        "REJECT",
        "admin-approver"
      );

      expect(prisma.adminCreditAdjustmentRequest.updateMany).toHaveBeenCalledWith({
        where: {
          id: "req-1",
          memberId: "member-1",
          status: "PENDING",
        },
        data: expect.objectContaining({
          status: "REJECTED",
          reviewedById: "admin-approver",
        }),
      });
      expect(prisma.memberCredit.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(result.credit).toBeNull();
    });

    it("rolls back approval when the audit write fails", async () => {
      const { prisma } = await import("@/lib/prisma");

      const state = {
        credits: [] as Array<{ id: string; amountCents: number; memberId: string }>,
        request: pendingRequest(),
      };

      vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedCredits: typeof state.credits = [];
        const stagedRequest = {
          ...state.request,
        };
        const lockState: { release: (() => void) | null } = { release: null };
        const tx = {
          $executeRaw: vi.fn(async () => {
            lockState.release = () => undefined;
          }),
          adminCreditAdjustmentRequest: {
            findUnique: vi.fn(async () => ({ ...state.request })),
            updateMany: vi.fn(async () => {
              stagedRequest.status = "APPROVED";
              stagedRequest.reviewedById = "admin-approver";
              return { count: 1 };
            }),
          },
          memberCredit: {
            aggregate: vi.fn().mockResolvedValue(aggregateResult(5000)),
            create: vi.fn(async ({ data }: any) => {
              const credit = { id: "credit-audit-fail", ...data };
              stagedCredits.push(credit);
              return credit;
            }),
          },
          auditLog: {
            create: vi.fn().mockRejectedValue(new Error("audit write failed")),
          },
        };

        try {
          const result = await callback(tx);
          state.credits.push(...stagedCredits);
          state.request = stagedRequest as any;
          return result;
        } finally {
          lockState.release?.();
        }
      });

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        reviewAdminAdjustmentRequest(
          "member-1",
          "req-1",
          "APPROVE",
          "admin-approver"
        )
      ).rejects.toThrow("audit write failed");

      expect(state.credits).toHaveLength(0);
      expect(state.request.status).toBe("PENDING");
      expect((state.request as any).reviewedById).toBeUndefined();
    });

    it("rolls back rejection when the audit write fails", async () => {
      const { prisma } = await import("@/lib/prisma");

      const state = {
        request: pendingRequest(),
      };

      vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedRequest = {
          ...state.request,
        };
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          adminCreditAdjustmentRequest: {
            findUnique: vi.fn(async () => ({ ...state.request })),
            updateMany: vi.fn(async () => {
              stagedRequest.status = "REJECTED";
              stagedRequest.reviewedById = "admin-approver";
              return { count: 1 };
            }),
          },
          memberCredit: {
            create: vi.fn(),
          },
          auditLog: {
            create: vi.fn().mockRejectedValue(new Error("audit write failed")),
          },
        };

        try {
          const result = await callback(tx);
          state.request = stagedRequest as any;
          return result;
        } catch (error) {
          return Promise.reject(error);
        }
      });

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      await expect(
        reviewAdminAdjustmentRequest(
          "member-1",
          "req-1",
          "REJECT",
          "admin-approver"
        )
      ).rejects.toThrow("audit write failed");

      expect(state.request.status).toBe("PENDING");
      expect((state.request as any).reviewedById).toBeUndefined();
    });

    it("prevents concurrent negative approvals from overdrawing the balance", async () => {
      const { prisma } = await import("@/lib/prisma");

      const state = {
        credits: [
          {
            id: "credit-seed",
            memberId: "member-1",
            amountCents: 1000,
            type: "CANCELLATION_REFUND",
          },
        ],
        requests: {
          "req-1": pendingRequest({
            id: "req-1",
            amountCents: -700,
            description: "Manual deduction 1",
            requestedById: "admin-requester-1",
          }),
          "req-2": pendingRequest({
            id: "req-2",
            amountCents: -700,
            description: "Manual deduction 2",
            requestedById: "admin-requester-2",
            idempotencyKey: "26822a78-5929-4471-889f-b49f7c88914d",
          }),
        } as Record<string, any>,
        audits: [] as Array<{ action: string }>,
      };

      let lockTail: Promise<void> = Promise.resolve();

      vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedCredits: any[] = [];
        const stagedRequestUpdates: Array<() => void> = [];
        const stagedAudits: Array<{ action: string }> = [];
        const lockState: { release: (() => void) | null } = { release: null };

        const tx = {
          $executeRaw: vi.fn(async () => {
            const previousLock = lockTail;
            lockTail = new Promise<void>((resolve) => {
              lockState.release = resolve;
            });
            await previousLock;
          }),
          adminCreditAdjustmentRequest: {
            findUnique: vi.fn(async ({ where }: any) => {
              const request = state.requests[where.id];
              return request ? { ...request } : null;
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
              const request = state.requests[where.id];
              if (!request || request.memberId !== where.memberId || request.status !== where.status) {
                return { count: 0 };
              }

              stagedRequestUpdates.push(() => {
                request.status = data.status;
                request.reviewedById = data.reviewedById;
                request.reviewedAt = data.reviewedAt;
              });

              return { count: 1 };
            }),
          },
          memberCredit: {
            aggregate: vi.fn(async ({ where }: any) => {
              const committedBalance = state.credits
                .filter((credit) => credit.memberId === where.memberId)
                .reduce((sum, credit) => sum + credit.amountCents, 0);
              const stagedBalance = stagedCredits
                .filter((credit) => credit.memberId === where.memberId)
                .reduce((sum, credit) => sum + credit.amountCents, 0);

              return aggregateResult(committedBalance + stagedBalance);
            }),
            create: vi.fn(async ({ data }: any) => {
              const credit = {
                id: `credit-${state.credits.length + stagedCredits.length + 1}`,
                ...data,
              };
              stagedCredits.push(credit);
              return credit;
            }),
          },
          auditLog: {
            create: vi.fn(async ({ data }: any) => {
              stagedAudits.push(data);
              return data;
            }),
          },
        };

        try {
          const result = await callback(tx);
          stagedRequestUpdates.forEach((commit) => commit());
          state.credits.push(...stagedCredits);
          state.audits.push(...stagedAudits);
          return result;
        } finally {
          lockState.release?.();
        }
      });

      const { reviewAdminAdjustmentRequest } = await import("@/lib/member-credit");
      const [firstResult, secondResult] = await Promise.allSettled([
        reviewAdminAdjustmentRequest(
          "member-1",
          "req-1",
          "APPROVE",
          "admin-approver-1"
        ),
        reviewAdminAdjustmentRequest(
          "member-1",
          "req-2",
          "APPROVE",
          "admin-approver-2"
        ),
      ]);

      expect([firstResult.status, secondResult.status].sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);

      const rejectedResult = [firstResult, secondResult].find(
        (result) => result.status === "rejected"
      ) as PromiseRejectedResult;
      expect(rejectedResult.reason.message).toBe(
        "Cannot deduct $7.00: only $3.00 available"
      );

      const approvedRequests = Object.values(state.requests).filter(
        (request) => request.status === "APPROVED"
      );
      const pendingRequests = Object.values(state.requests).filter(
        (request) => request.status === "PENDING"
      );

      expect(
        state.credits.filter((credit) => credit.type === "ADMIN_ADJUSTMENT")
      ).toHaveLength(1);
      expect(approvedRequests).toHaveLength(1);
      expect(pendingRequests).toHaveLength(1);
    });
  });
});

// ── Tests: Dual Refund Percentages ──────────────────────────────────────────

describe("cancellation dual refund percentages", () => {
  describe("getRefundTier", () => {
    it("returns both card and credit percentages", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100, fixedFeeCents: 800, creditFixedFeeCents: 200 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const tier = getRefundTier(15, policy);
      expect(tier.refundPercentage).toBe(90);
      expect(tier.creditRefundPercentage).toBe(100);
      expect(tier.fixedFeeCents).toBe(800);
      expect(tier.creditFixedFeeCents).toBe(200);
    });

    it("returns correct tier for mid-range days", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const tier = getRefundTier(10, policy);
      expect(tier.refundPercentage).toBe(50);
      expect(tier.creditRefundPercentage).toBe(75);
    });

    it("returns 0/0 for empty policy", async () => {
      const { getRefundTier } = await import("@/lib/cancellation");
      const tier = getRefundTier(10, []);
      expect(tier.refundPercentage).toBe(0);
      expect(tier.creditRefundPercentage).toBe(0);
    });
  });

  describe("calculateRefundAmount", () => {
    it("uses card percentage by default", async () => {
      const { calculateRefundAmount } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100, fixedFeeCents: 1000, creditFixedFeeCents: 300 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateRefundAmount(10000, 15, policy);
      expect(result.refundAmountCents).toBe(8000);
      expect(result.refundPercentage).toBe(90);
    });

    it("uses credit percentage when refundMethod is credit", async () => {
      const { calculateRefundAmount } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100, fixedFeeCents: 1000, creditFixedFeeCents: 300 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateRefundAmount(10000, 15, policy, "credit");
      expect(result.refundAmountCents).toBe(9700);
      expect(result.refundPercentage).toBe(100);
    });
  });

  describe("calculateDualRefundAmounts", () => {
    it("returns both card and credit amounts", async () => {
      const { calculateDualRefundAmounts } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100, fixedFeeCents: 1000, creditFixedFeeCents: 250 },
        { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 75 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateDualRefundAmounts(10000, 15, policy);
      expect(result.cardRefundAmountCents).toBe(8000);
      expect(result.cardRefundPercentage).toBe(90);
      expect(result.creditRefundAmountCents).toBe(9750);
      expect(result.creditRefundPercentage).toBe(100);
    });

    it("rounds correctly for odd amounts", async () => {
      const { calculateDualRefundAmounts } = await import("@/lib/cancellation");

      const policy = [
        { daysBeforeStay: 7, refundPercentage: 33, creditRefundPercentage: 50 },
        { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ];

      const result = calculateDualRefundAmounts(999, 10, policy);
      expect(result.cardRefundAmountCents).toBe(330);
      expect(result.creditRefundAmountCents).toBe(500);
    });
  });
});

// ── Tests: Schema Contracts ─────────────────────────────────────────────────

describe("schema contracts", () => {
  it("adjustment schema requires description", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      amountCents: z.number().int().refine((v: number) => v !== 0, "Amount cannot be zero"),
      description: z.string().min(1, "Description is required").max(500),
      idempotencyKey: z.string().uuid("Idempotency key must be a UUID"),
    });

    expect(schema.safeParse({ amountCents: 100 }).success).toBe(false);
    expect(schema.safeParse({ amountCents: 100, description: "" }).success).toBe(false);
    expect(schema.safeParse({
      amountCents: 0,
      description: "test",
      idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
    }).success).toBe(false);
    expect(schema.safeParse({
      amountCents: 100,
      description: "test",
      idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
    }).success).toBe(true);
    expect(schema.safeParse({
      amountCents: -500,
      description: "deduct",
      idempotencyKey: "9a13b0af-7ffc-451b-a50b-81f6fb8630f4",
    }).success).toBe(true);
  });

  it("cancellation policy schema accepts creditRefundPercentage", async () => {
    const { z } = await import("zod");
    const policySchema = z.object({
      rules: z.array(
        z.object({
          daysBeforeStay: z.number().int().min(0),
          refundPercentage: z.number().int().min(0).max(100),
          creditRefundPercentage: z.number().int().min(0).max(100).optional(),
          fixedFeeCents: z.number().int().min(0).optional(),
          creditFixedFeeCents: z.number().int().min(0).optional(),
        })
      ).min(1),
    });

    expect(policySchema.safeParse({
      rules: [{ daysBeforeStay: 14, refundPercentage: 90 }],
    }).success).toBe(true);

    expect(policySchema.safeParse({
      rules: [{ daysBeforeStay: 14, refundPercentage: 90, creditRefundPercentage: 100 }],
    }).success).toBe(true);

    expect(policySchema.safeParse({
      rules: [{ daysBeforeStay: 14, refundPercentage: 90, fixedFeeCents: 500, creditFixedFeeCents: 250 }],
    }).success).toBe(true);
  });
});
