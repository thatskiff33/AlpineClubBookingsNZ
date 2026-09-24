import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  PaymentStatus,
} from "@prisma/client";

const mocks = vi.hoisted(() => ({
  settlementFindMany: vi.fn(),
  settlementFindUnique: vi.fn(),
  settlementUpdate: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  settlementUpdateMany: vi.fn(),
  groupBookingFindMany: vi.fn(),
  txExecuteRaw: vi.fn(),
  transaction: vi.fn(),
  cancelPaymentIntent: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  recordBookingEvent: vi.fn(),
  processWaitlistForDates: vi.fn(),
  sendSettlementExpired: vi.fn(),
  sendJoinReleased: vi.fn(),
  sendJoinCancelled: vi.fn(),
  settleGroupBookingOnOrganiserCancel: vi.fn(),
  // #2576 §8: the revert de-confirms a coverage SOURCE, so each released child
  // records a bounded hosting re-evaluation inside the reap transaction and the
  // reaper drains it after commit.
  enqueueOwnHostingCoverage: vi.fn(),
  settleHostingCoverage: vi.fn(),
}));

const txClient = {
  $executeRaw: mocks.txExecuteRaw,
  booking: {
    findMany: mocks.bookingFindMany,
    update: mocks.bookingUpdate,
    updateMany: mocks.bookingUpdateMany,
  },
  groupBookingSettlement: {
    findUnique: mocks.settlementFindUnique,
    update: mocks.settlementUpdate,
    updateMany: mocks.settlementUpdateMany,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBookingSettlement: { findMany: mocks.settlementFindMany },
    groupBooking: { findMany: mocks.groupBookingFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntent,
}));
vi.mock("@/lib/group-cancel", () => ({
  settleGroupBookingOnOrganiserCancel:
    mocks.settleGroupBookingOnOrganiserCancel,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld:
    mocks.reconcileBedAllocations,
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));
vi.mock("@/lib/email", () => ({
  sendGroupSettlementExpiredEmail: mocks.sendSettlementExpired,
  sendGroupJoinReleasedEmail: mocks.sendJoinReleased,
  sendGroupJoinCancelledEmail: mocks.sendJoinCancelled,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
// #2576 §8. Mocked at the module boundary, the same way every other collaborator in
// this suite is: the reaper's job is to reap, and whether an uncovered booking becomes
// an incident is the hosting suites' subject. What belongs HERE is that the revert
// records the obligation at all — `releaseSettlementChildren` reverts CONFIRMED to
// PAYMENT_PENDING, which takes the child out of
// `HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES`, so a joiner attending as the qualifying
// adult stops counting for every other booking on their account the moment this runs.
// Without the mocks the real seam reads through this suite's narrow fake `tx`, which
// carries no `booking.findUnique` and no policy delegate, and the whole reap
// transaction throws — which is how this suite caught the change in the first place.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: mocks.enqueueOwnHostingCoverage,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHostingCoverage,
}));

import {
  groupSettlementReapDeadline,
  reapStaleGroupSettlements,
} from "@/lib/cron-group-settlement-reaper";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function staleSettlement(overrides: Record<string, unknown> = {}) {
  return {
    id: "settle-1",
    status: PaymentStatus.PENDING,
    amountCents: 30000,
    // 49 hours old: past the default 48h window.
    updatedAt: new Date(NOW.getTime() - 49 * HOUR),
    stripePaymentIntentId: "pi_stale",
    groupBookingId: "group-1",
    groupBooking: {
      organiserBookingId: "org-booking-1",
      organiserMember: {
        email: "org@example.com",
        firstName: "Olive",
        lastName: "Organiser",
      },
      organiserBooking: {
        // Check-in well in the future so the clamp does not bind.
        checkIn: new Date(NOW.getTime() + 14 * 24 * HOUR),
        checkOut: new Date(NOW.getTime() + 16 * 24 * HOUR),
      },
    },
    ...overrides,
  };
}

function confirmedChild(id: string) {
  return {
    id,
    checkIn: new Date(NOW.getTime() + 14 * 24 * HOUR),
    checkOut: new Date(NOW.getTime() + 16 * 24 * HOUR),
    // A non-default lodge, so the waitlist pass must use this lodge's queue.
    lodgeId: "lodge-remote",
    member: { email: `${id}@example.com`, firstName: "Jo" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (cb: (tx: typeof txClient) => unknown) =>
    cb(txClient)
  );
  mocks.txExecuteRaw.mockResolvedValue(undefined);
  mocks.settlementFindUnique.mockResolvedValue({ status: PaymentStatus.PENDING });
  mocks.settlementUpdate.mockResolvedValue({});
  mocks.bookingUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.settlementUpdateMany.mockResolvedValue({ count: 1 });
  mocks.reconcileBedAllocations.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.processWaitlistForDates.mockResolvedValue(undefined);
  mocks.sendSettlementExpired.mockResolvedValue(undefined);
  mocks.sendJoinReleased.mockResolvedValue(undefined);
  mocks.sendJoinCancelled.mockResolvedValue(undefined);
  mocks.cancelPaymentIntent.mockResolvedValue(null);
  // Resume phase (#1236): default to no interrupted organiser-cancel cleanups.
  mocks.groupBookingFindMany.mockResolvedValue([]);
  mocks.settleGroupBookingOnOrganiserCancel.mockResolvedValue(undefined);
});

describe("groupSettlementReapDeadline", () => {
  const updatedAt = new Date("2026-08-01T00:00:00.000Z");

  it("defaults to updatedAt + window", () => {
    const checkIn = new Date(updatedAt.getTime() + 30 * 24 * HOUR);
    expect(groupSettlementReapDeadline(updatedAt, checkIn, 48)).toEqual(
      new Date(updatedAt.getTime() + 48 * HOUR)
    );
  });

  it("never extends past check-in", () => {
    const checkIn = new Date(updatedAt.getTime() + 6 * HOUR);
    expect(groupSettlementReapDeadline(updatedAt, checkIn, 48)).toEqual(checkIn);
  });

  it("keeps a two-hour floor for arrival-day settlements", () => {
    // Check-in is one hour away: the organiser settling on arrival day still
    // gets two hours before the reaper may touch the settlement.
    const checkIn = new Date(updatedAt.getTime() + 1 * HOUR);
    expect(groupSettlementReapDeadline(updatedAt, checkIn, 48)).toEqual(
      new Date(updatedAt.getTime() + 2 * HOUR)
    );
  });
});

describe("reapStaleGroupSettlements", () => {
  it("releases the children of a settlement unpaid past the window (Stripe)", async () => {
    mocks.settlementFindMany.mockResolvedValue([staleSettlement()]);
    mocks.bookingFindMany.mockResolvedValue([
      confirmedChild("child-1"),
      confirmedChild("child-2"),
    ]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result).toEqual({
      scanned: 1,
      reaped: 1,
      releasedChildBookings: 2,
      expiredSettlements: 0,
      cancelledChildBookings: 0,
      scannedInterruptedCancels: 0,
      resumedInterruptedCancels: 0,
    });
    // Children revert to their pre-commit, non-capacity-holding state.
    // #1881 — status-guarded updateMany (CONFIRMED -> PAYMENT_PENDING).
    expect(mocks.bookingUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "child-1", status: BookingStatus.CONFIRMED },
      data: { status: BookingStatus.PAYMENT_PENDING },
    });
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(2);
    expect(mocks.settlementUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "settle-1",
        status: {
          notIn: [
            PaymentStatus.SUCCEEDED,
            PaymentStatus.REFUNDED,
            PaymentStatus.PARTIALLY_REFUNDED,
          ],
        },
      },
      data: { status: PaymentStatus.FAILED },
    });
    // The abandoned intent is voided so a stale tab cannot capture.
    expect(mocks.cancelPaymentIntent).toHaveBeenCalledWith("pi_stale");
    // Durable events, waitlist processing, and notifications.
    expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(2);
    expect(mocks.processWaitlistForDates).toHaveBeenCalledTimes(2);
    expect(mocks.sendSettlementExpired).toHaveBeenCalledTimes(1);
    expect(mocks.sendJoinReleased).toHaveBeenCalledTimes(2);

    // #2576 §8. THE ASYMMETRIC HALF OF THE SETTLEMENT PAIR: `group-settlement.ts`
    // records a hosting re-evaluation when a settlement CREATES cover, and nothing
    // recorded it when this automated failure TAKES cover away. CONFIRMED is an
    // eligible coverage source and PAYMENT_PENDING is not, so a joiner attending as
    // the qualifying adult on a released child silently stops covering every other
    // booking on their account — no incident, no owner email, no officer-queue entry,
    // on a booking whose own review snapshot still read "compliant".
    //
    // One item per released child, recorded INSIDE the reap transaction (the fake `tx`,
    // not the module client) so the revert and the obligation commit together, and
    // never refused — §8 names both "payment or booking lifecycle failure" and
    // "automated status transitions".
    expect(mocks.enqueueOwnHostingCoverage).toHaveBeenCalledTimes(2);
    for (const call of mocks.enqueueOwnHostingCoverage.mock.calls) {
      expect(call[1]).toBe(txClient);
      expect(call[2]).toMatchObject({ cause: "SYSTEM_CHANGE" });
    }
    // ...and drained after the commit, so a joiner's other booking reaches the officer
    // queue on this pass rather than waiting for the next general sweep.
    expect(mocks.settleHostingCoverage).toHaveBeenCalledTimes(1);
  });

  it("re-processes the freed child's own lodge queue, not the default lodge (M1)", async () => {
    mocks.settlementFindMany.mockResolvedValue([staleSettlement()]);
    mocks.bookingFindMany.mockResolvedValue([confirmedChild("child-1")]);

    await reapStaleGroupSettlements(NOW);

    // The waitlist pass for freed beds must target the child booking's own
    // lodge; omitting lodgeId would run it against the default lodge.
    expect(mocks.processWaitlistForDates).toHaveBeenCalledWith(
      expect.objectContaining({
        checkIn: new Date(NOW.getTime() + 14 * 24 * HOUR),
        checkOut: new Date(NOW.getTime() + 16 * 24 * HOUR),
        lodgeId: "lodge-remote",
      }),
      CLUB_FORMAT_TEST,
    );
  });

  it("releases an Internet Banking settlement without touching Stripe", async () => {
    mocks.settlementFindMany.mockResolvedValue([
      staleSettlement({ stripePaymentIntentId: null }),
    ]);
    mocks.bookingFindMany.mockResolvedValue([confirmedChild("child-1")]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.reaped).toBe(1);
    expect(mocks.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.settlementUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "settle-1",
        status: {
          notIn: [
            PaymentStatus.SUCCEEDED,
            PaymentStatus.REFUNDED,
            PaymentStatus.PARTIALLY_REFUNDED,
          ],
        },
      },
      data: { status: PaymentStatus.FAILED },
    });
    expect(mocks.sendSettlementExpired).toHaveBeenCalledTimes(1);
  });

  it("does not reap a settlement still inside the window", async () => {
    mocks.settlementFindMany.mockResolvedValue([
      staleSettlement({ updatedAt: new Date(NOW.getTime() - 47 * HOUR) }),
    ]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result).toEqual({
      scanned: 1,
      reaped: 0,
      releasedChildBookings: 0,
      expiredSettlements: 0,
      cancelledChildBookings: 0,
      scannedInterruptedCancels: 0,
      resumedInterruptedCancels: 0,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.sendSettlementExpired).not.toHaveBeenCalled();
  });

  it("reaps a within-window settlement whose check-in has arrived", async () => {
    mocks.settlementFindMany.mockResolvedValue([
      staleSettlement({
        // Only 5 hours old, but check-in was 1 hour ago: the clamp binds.
        updatedAt: new Date(NOW.getTime() - 5 * HOUR),
        groupBooking: {
          organiserBookingId: "org-booking-1",
          organiserMember: {
            email: "org@example.com",
            firstName: "Olive",
            lastName: "Organiser",
          },
          organiserBooking: {
            checkIn: new Date(NOW.getTime() - 1 * HOUR),
            checkOut: new Date(NOW.getTime() + 2 * 24 * HOUR),
          },
        },
      }),
    ]);
    mocks.bookingFindMany.mockResolvedValue([confirmedChild("child-1")]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.reaped).toBe(1);
  });

  it("skips a settlement that succeeded just before the reaper ran (payment wins)", async () => {
    mocks.settlementFindMany.mockResolvedValue([staleSettlement()]);
    // Inside the lock the settlement is already SUCCEEDED: the webhook won.
    mocks.settlementFindUnique.mockResolvedValue({
      status: PaymentStatus.SUCCEEDED,
    });

    const result = await reapStaleGroupSettlements(NOW);

    expect(result).toEqual({
      scanned: 1,
      reaped: 0,
      releasedChildBookings: 0,
      expiredSettlements: 0,
      cancelledChildBookings: 0,
      scannedInterruptedCancels: 0,
      resumedInterruptedCancels: 0,
    });
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.sendSettlementExpired).not.toHaveBeenCalled();
  });

  it("is idempotent across reruns: no CONFIRMED children means nothing to do", async () => {
    // A previous run already reverted the children (settlement now FAILED),
    // and a run before this one already expired them (no PAYMENT_PENDING
    // children left either).
    mocks.settlementFindMany.mockResolvedValue([
      staleSettlement({ status: PaymentStatus.FAILED }),
    ]);
    mocks.settlementFindUnique.mockResolvedValue({
      status: PaymentStatus.FAILED,
      updatedAt: new Date(NOW.getTime() - 49 * HOUR),
    });
    mocks.bookingFindMany.mockResolvedValue([]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result).toEqual({
      scanned: 1,
      reaped: 0,
      releasedChildBookings: 0,
      expiredSettlements: 0,
      cancelledChildBookings: 0,
      scannedInterruptedCancels: 0,
      resumedInterruptedCancels: 0,
    });
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    // No-op passes must not rewrite the settlement: that would bump
    // updatedAt and hold the expiry window open forever.
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.sendSettlementExpired).not.toHaveBeenCalled();
    expect(mocks.sendJoinReleased).not.toHaveBeenCalled();
    expect(mocks.sendJoinCancelled).not.toHaveBeenCalled();
  });

  it("does not emit release side effects for a child whose status CAS lost (#1881)", async () => {
    mocks.settlementFindMany.mockResolvedValue([staleSettlement()]);
    mocks.settlementFindUnique.mockResolvedValue({
      status: PaymentStatus.PENDING,
      updatedAt: new Date(NOW.getTime() - 49 * HOUR),
    });
    mocks.bookingFindMany.mockResolvedValue([confirmedChild("child-1")]);
    mocks.bookingUpdateMany.mockResolvedValueOnce({ count: 0 });

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.releasedChildBookings).toBe(0);
    expect(result.reaped).toBe(0);
    expect(mocks.reconcileBedAllocations).not.toHaveBeenCalled();
    expect(mocks.sendJoinReleased).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("keeps reaping the rest when one settlement fails", async () => {
    mocks.settlementFindMany.mockResolvedValue([
      staleSettlement({ id: "settle-bad" }),
      staleSettlement({ id: "settle-good" }),
    ]);
    mocks.bookingFindMany.mockResolvedValue([confirmedChild("child-1")]);
    mocks.transaction
      .mockImplementationOnce(async () => {
        throw new Error("deadlock");
      })
      .mockImplementation(async (cb: (tx: typeof txClient) => unknown) =>
        cb(txClient)
      );

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.scanned).toBe(2);
    expect(result.reaped).toBe(1);
  });
});

describe("expiry of reaped organiser-pays children (#1094)", () => {
  function paymentPendingChild(id: string) {
    return confirmedChild(id);
  }

  function failedSettlement(overrides: Record<string, unknown> = {}) {
    return staleSettlement({ status: PaymentStatus.FAILED, ...overrides });
  }

  it("cancels reverted children once a FAILED settlement sits unretried through a second window", async () => {
    // Phase 1 has nothing to reap; phase 2's fresh scan finds the FAILED
    // settlement whose reap happened a full window ago.
    mocks.settlementFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedSettlement()]);
    mocks.settlementFindUnique.mockResolvedValue({
      status: PaymentStatus.FAILED,
      updatedAt: new Date(NOW.getTime() - 49 * HOUR),
    });
    mocks.bookingFindMany.mockResolvedValue([
      paymentPendingChild("child-1"),
      paymentPendingChild("child-2"),
    ]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.expiredSettlements).toBe(1);
    expect(result.cancelledChildBookings).toBe(2);
    // #1881 — status-guarded child cancel (PAYMENT_PENDING -> CANCELLED).
    expect(mocks.bookingUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "child-1", status: BookingStatus.PAYMENT_PENDING },
      data: {
        status: BookingStatus.CANCELLED,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    // Terminal event and joiner notification, exactly once per child.
    expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(2);
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "child-1",
        type: BookingEventType.CANCELLED,
      })
    );
    expect(mocks.sendJoinCancelled).toHaveBeenCalledTimes(2);
    expect(mocks.sendJoinCancelled).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "child-1@example.com",
        organiserName: "Olive Organiser",
      })
    );
    // PAYMENT_PENDING held no beds: no bed or waitlist churn, no settlement
    // rewrite (FAILED is already terminal for an expired settlement).
    expect(mocks.reconcileBedAllocations).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.sendJoinReleased).not.toHaveBeenCalled();
  });

  it("keeps children alive when the organiser retried before expiry (fresh read wins)", async () => {
    mocks.settlementFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedSettlement()]);
    // Inside the advisory lock the settlement is PENDING again: a retry won.
    mocks.settlementFindUnique.mockResolvedValue({
      status: PaymentStatus.PENDING,
      updatedAt: NOW,
    });

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.expiredSettlements).toBe(0);
    expect(result.cancelledChildBookings).toBe(0);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.sendJoinCancelled).not.toHaveBeenCalled();
  });

  it("restarts the clock when a retry failed again recently (deadline re-checked in the lock)", async () => {
    mocks.settlementFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedSettlement()]);
    // Fresh row shows a failed retry one hour ago: a new window is running.
    mocks.settlementFindUnique.mockResolvedValue({
      status: PaymentStatus.FAILED,
      updatedAt: new Date(NOW.getTime() - 1 * HOUR),
    });
    mocks.bookingFindMany.mockResolvedValue([paymentPendingChild("child-1")]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.expiredSettlements).toBe(0);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.sendJoinCancelled).not.toHaveBeenCalled();
  });

  it("never expires a settlement in the same run that reaped it (fresh scan, fresh clock)", async () => {
    // Phase 2's own scan sees the updatedAt the reap just refreshed.
    mocks.settlementFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedSettlement({ updatedAt: NOW })]);
    mocks.bookingFindMany.mockResolvedValue([paymentPendingChild("child-1")]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.expiredSettlements).toBe(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.sendJoinCancelled).not.toHaveBeenCalled();
  });

  it("is idempotent across reruns: cancelled children are not re-cancelled or re-notified", async () => {
    mocks.settlementFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedSettlement()]);
    mocks.settlementFindUnique.mockResolvedValue({
      status: PaymentStatus.FAILED,
      updatedAt: new Date(NOW.getTime() - 49 * HOUR),
    });
    // A previous run already cancelled them: no PAYMENT_PENDING children left.
    mocks.bookingFindMany.mockResolvedValue([]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(result.expiredSettlements).toBe(0);
    expect(result.cancelledChildBookings).toBe(0);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.sendJoinCancelled).not.toHaveBeenCalled();
  });
});

describe("resume of interrupted organiser-cancel cleanups (#1236)", () => {
  it("re-drives an interrupted cleanup with the organiser member as actor", async () => {
    mocks.settlementFindMany.mockResolvedValue([]);
    mocks.groupBookingFindMany.mockResolvedValue([
      { organiserBookingId: "org-booking-9", organiserMemberId: "member-9" },
    ]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(mocks.settleGroupBookingOnOrganiserCancel).toHaveBeenCalledTimes(1);
    // Actor is the real organiser Member FK; the cron tag stands in for an IP.
    expect(mocks.settleGroupBookingOnOrganiserCancel).toHaveBeenCalledWith(
      "org-booking-9",
      "member-9",
      "cron:group-cancel-resume",
      CLUB_FORMAT_TEST,
    );
    expect(result.scannedInterruptedCancels).toBe(1);
    expect(result.resumedInterruptedCancels).toBe(1);
  });

  it("scans fenced ORGANISER_PAYS groups only when active cleanup children remain past grace", async () => {
    mocks.settlementFindMany.mockResolvedValue([]);

    await reapStaleGroupSettlements(NOW);

    // Group status is deliberately not a filter: CANCELLED is now the durable
    // fence written first. Remaining active children identify interrupted work.
    expect(mocks.groupBookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
          organiserBooking: {
            status: BookingStatus.CANCELLED,
            deletedAt: null,
            updatedAt: { lt: new Date(NOW.getTime() - 15 * 60 * 1000) },
            linkedBookings: {
              some: {
                organiserSettled: true,
                deletedAt: null,
                status: {
                  in: [
                    BookingStatus.PAYMENT_PENDING,
                    BookingStatus.CONFIRMED,
                    BookingStatus.PAID,
                  ],
                },
              },
            },
          },
        },
        select: { organiserBookingId: true, organiserMemberId: true },
      })
    );
  });

  it("keeps re-driving the rest when one resume throws", async () => {
    mocks.settlementFindMany.mockResolvedValue([]);
    mocks.groupBookingFindMany.mockResolvedValue([
      { organiserBookingId: "org-bad", organiserMemberId: "member-bad" },
      { organiserBookingId: "org-good", organiserMemberId: "member-good" },
    ]);
    mocks.settleGroupBookingOnOrganiserCancel
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const result = await reapStaleGroupSettlements(NOW);

    expect(mocks.settleGroupBookingOnOrganiserCancel).toHaveBeenCalledTimes(2);
    expect(result.scannedInterruptedCancels).toBe(2);
    // Only the successful re-drive increments the resumed counter.
    expect(result.resumedInterruptedCancels).toBe(1);
  });

  it("does nothing when there are no interrupted cleanups", async () => {
    mocks.settlementFindMany.mockResolvedValue([]);
    mocks.groupBookingFindMany.mockResolvedValue([]);

    const result = await reapStaleGroupSettlements(NOW);

    expect(mocks.settleGroupBookingOnOrganiserCancel).not.toHaveBeenCalled();
    expect(result.scannedInterruptedCancels).toBe(0);
    expect(result.resumedInterruptedCancels).toBe(0);
  });
});
