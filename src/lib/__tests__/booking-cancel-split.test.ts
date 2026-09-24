/**
 * Split-booking cancellation cascade (issue #738).
 *
 * Cancelling the member (parent) booking also cancels its linked provisional
 * non-member child (PENDING, holds nothing, no payment). Cancelling the child
 * on its own leaves the member booking intact.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  txBookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  txExecuteRaw: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  prismaTransaction: vi.fn(),
  promoRedemptionFindUnique: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  logAudit: vi.fn(),
  processWaitlistForDates: vi.fn(),
  revokePaymentLinksForBooking: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      findMany: mocks.bookingFindMany,
      update: mocks.bookingUpdate,
      updateMany: mocks.bookingUpdateMany,
    },
    promoRedemption: { findUnique: mocks.promoRedemptionFindUnique },
    promoCode: { update: vi.fn() },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock("@/lib/cancellation", () => ({
  calculateRefundAmount: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
}));
vi.mock("@/lib/email", () => ({ sendBookingCancelledEmail: mocks.sendBookingCancelledEmail }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/member-credit", () => ({
  createCancellationCredit: vi.fn(),
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
}));
vi.mock("@/lib/waitlist", () => ({ processWaitlistForDates: mocks.processWaitlistForDates }));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroAccountCreditNoteOperation: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  cancelSetupIntentIfCancellable: vi.fn(),
}));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: vi.fn(),
  markPaymentIntentTransactionFailed: vi.fn(),
  refundPaymentTransactions: vi.fn(),
}));
vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: mocks.revokePaymentLinksForBooking,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld:
    mocks.reconcileBedAllocationsForBooking,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";
import { cancelBooking } from "@/lib/booking-cancel";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("cancelBooking split cascade (#738)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Callback-form $transaction with a tx that supports the no-payment path.
    mocks.prismaTransaction.mockImplementation(
      async (fnOrActions: unknown) => {
        if (typeof fnOrActions === "function") {
          // #2619: model the participant fence's under-lock re-reads.
          const fenceBooking = recordingBookingDouble((args) =>
            mocks.txBookingFindUnique(args),
          );
          return (fnOrActions as (tx: unknown) => Promise<unknown>)({
            $executeRaw: mocks.txExecuteRaw,
            member: { findMany: fenceMemberFindMany() },
            // #2623 T5: the seam reads the lodge's hosting mode before the fence, so
            // the double answers with an ACTIVE one and the fence above stays on the
            // path. See `fenceHostingPolicyFindMany`.
            adultMemberHostingPolicy: { findMany: fenceHostingPolicyFindMany() },
            booking: {
              findUnique: fenceBooking.findUnique,
              findMany: fenceBooking.findMany,
              update: mocks.bookingUpdate,
              updateMany: mocks.bookingUpdateMany,
            },
            payment: { update: vi.fn() },
          });
        }
        return Promise.all(fnOrActions as Array<Promise<unknown>>);
      }
    );
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.revokePaymentLinksForBooking.mockResolvedValue(0);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
  });

  const child = {
    id: "child_1",
    memberId: "member_1",
    parentBookingId: "parent_1",
    status: "PENDING",
    lodgeId: "lodge_1",
    deletedAt: null,
    checkIn: new Date("2026-07-10"),
    checkOut: new Date("2026-07-12"),
    member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
  };

  it("cancels the linked provisional child when the member booking is cancelled", async () => {
    // Parent member booking: a simple PENDING member booking (no payment).
    const parent = {
      id: "parent_1",
      memberId: "member_1",
      parentBookingId: null,
      status: "PENDING",
      lodgeId: "lodge_1",
      deletedAt: null,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
      payment: null,
    };
    mocks.bookingFindUnique.mockResolvedValue(parent);
    mocks.txBookingFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === child.id ? child : parent
    );
    mocks.bookingFindMany.mockResolvedValue([child]);

    const result = await cancelBooking("parent_1", "member_1", "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST);

    expect(result.status).toBe(200);
    // The cascade queried for children of the cancelled parent...
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ parentBookingId: "parent_1", status: "PENDING" }),
      })
    );
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      "lodge_1"
    );
    // Both the parent and linked-child transactions take their own global
    // lock(1) before their own per-lodge lock. Filter out later member-tier
    // advisory locks so this cannot accidentally prove only the parent pair.
    const globalLockOrders = mocks.txExecuteRaw.mock.calls.flatMap(
      (call, index) =>
        String(call[0]?.[0]).includes("pg_advisory_xact_lock(1)")
          ? [mocks.txExecuteRaw.mock.invocationCallOrder[index]]
          : [],
    );
    expect(globalLockOrders).toHaveLength(2);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledTimes(2);
    expect(globalLockOrders[0]).toBeLessThan(
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0],
    );
    expect(globalLockOrders[1]).toBeLessThan(
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[1],
    );
    // ...and conditionally claims only a still-provisional child.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "child_1",
        parentBookingId: "parent_1",
        status: "PENDING",
        deletedAt: null,
      },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    expect(mocks.reconcileBedAllocationsForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "child_1" })
    );
    // #1967: any outstanding guest-portion payment link is revoked inside the
    // same claim transaction, so a link minted between the parent's cancel
    // and the member clicking /pay is dead — a cancelled child can never be
    // paid through a stale token.
    expect(mocks.revokePaymentLinksForBooking).toHaveBeenCalledWith(
      "child_1",
      expect.anything()
    );
  });

  it("does not overwrite or emit cancellation side effects when cron already confirmed the child", async () => {
    const parent = {
      id: "parent_1",
      memberId: "member_1",
      parentBookingId: null,
      status: "PENDING",
      lodgeId: "lodge_1",
      deletedAt: null,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
      payment: null,
    };
    const confirmedChild = { ...child, status: "CONFIRMED" };
    mocks.bookingFindUnique.mockResolvedValue(parent);
    mocks.txBookingFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === child.id ? confirmedChild : parent
    );
    // The outer sweep saw PENDING before waiting for the locks.
    mocks.bookingFindMany.mockResolvedValue([child]);

    const result = await cancelBooking("parent_1", "member_1", "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST);

    expect(result.status).toBe(200);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      expect.anything(),
      "lodge_1"
    );
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "child_1" }),
      })
    );
    expect(mocks.reconcileBedAllocationsForBooking).not.toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "child_1" })
    );
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalledWith(
      "member_1",
      "child_1",
      expect.anything()
    );
    expect(mocks.recordBookingEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "child_1" })
    );
  });

  it("runs no child side effects when the guarded PENDING claim loses", async () => {
    const parent = {
      id: "parent_1",
      memberId: "member_1",
      parentBookingId: null,
      status: "PENDING",
      lodgeId: "lodge_1",
      deletedAt: null,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
      payment: null,
    };
    mocks.bookingFindUnique.mockResolvedValue(parent);
    mocks.txBookingFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === child.id ? child : parent
    );
    mocks.bookingFindMany.mockResolvedValue([child]);
    // Parent cancel claims; the child's defense-in-depth CAS loses.
    mocks.bookingUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await cancelBooking("parent_1", "member_1", "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST);

    expect(result.status).toBe(200);
    expect(mocks.reconcileBedAllocationsForBooking).not.toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "child_1" })
    );
    expect(mocks.recordBookingEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "child_1" })
    );
  });

  it("does not cancel a parent when only the non-member child is cancelled", async () => {
    // Cancelling the child directly: it has no children of its own.
    const directChild = {
      id: "child_1",
      memberId: "member_1",
      parentBookingId: "parent_1",
      status: "PENDING",
      lodgeId: "lodge_1",
      deletedAt: null,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
      payment: null,
    };
    mocks.bookingFindUnique.mockResolvedValue(directChild);
    mocks.txBookingFindUnique.mockResolvedValue(directChild);
    mocks.bookingFindMany.mockResolvedValue([]);

    const result = await cancelBooking("child_1", "member_1", "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST);

    expect(result.status).toBe(200);
    // The cascade looks for children of child_1 (there are none); the parent is
    // never updated.
    expect(mocks.bookingUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "parent_1" } })
    );
  });
});
