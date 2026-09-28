import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
} from "@prisma/client";

/*
 * #3672 (`INV-PAY-108`): the group-settlement reaper's self-heal. A paid
 * organiser-pays group still holding an organiser-settled joiner its bill did
 * not cover (one left before the rule existed) has that joiner moved to paying
 * for themselves, under `lock(1)` with the group re-read inside it, and emailed
 * once.
 */

const mocks = vi.hoisted(() => ({
  groupFindMany: vi.fn(),
  groupFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdateMany: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  sendPaySelf: vi.fn(),
  sendStartedAlert: vi.fn(),
  claimAlertCooldown: vi.fn(),
}));

const tx = {
  $executeRaw: mocks.executeRaw,
  groupBooking: { findUnique: mocks.groupFindUnique },
  booking: { findMany: mocks.bookingFindMany, updateMany: mocks.bookingUpdateMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findMany: mocks.groupFindMany },
    booking: { findMany: mocks.bookingFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/email", () => ({
  sendGroupJoinPaySelfEmail: mocks.sendPaySelf,
  sendAdminGroupJoinerStartedStayAlert: mocks.sendStartedAlert,
}));
vi.mock("@/lib/alert-cooldown", () => ({ claimAlertCooldown: mocks.claimAlertCooldown }));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland"),
}));

/** 1 Oct 2026, 13:00 in Auckland: the club's today is 2026-10-01. */
const NOW = new Date("2026-10-01T00:00:00.000Z");
const PAST = new Date("2026-09-30T00:00:00.000Z");
const TODAY = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-10-02T00:00:00.000Z");

import { releaseJoinersLeftBehindPaidSettlements } from "@/lib/group-late-joiner";

function liveGroup(id: string) {
  return {
    id,
    organiserBookingId: `org-${id}`,
    organiserMember: { firstName: "Olive", lastName: "Organiser" },
    organiserBooking: { checkIn: FUTURE },
  };
}

function lockedRow(overrides: Record<string, unknown> = {}) {
  return {
    status: GroupBookingStatus.OPEN,
    settlement: { status: PaymentStatus.SUCCEEDED },
    organiserBooking: { status: BookingStatus.PAID, deletedAt: null },
    ...overrides,
  };
}

const released = {
  id: "late-1",
  memberId: "m-late",
  checkIn: new Date("2026-10-01T00:00:00.000Z"),
  checkOut: new Date("2026-10-03T00:00:00.000Z"),
  member: { email: "late@example.com", firstName: "Lee" },
  organisation: null,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.transaction.mockImplementation(async (cb: (store: typeof tx) => unknown) => cb(tx));
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.sendPaySelf.mockResolvedValue(undefined);
  mocks.sendStartedAlert.mockResolvedValue(undefined);
  mocks.claimAlertCooldown.mockResolvedValue(true);
});

describe("releaseJoinersLeftBehindPaidSettlements (#3672)", () => {
  it("moves a paid group's left-behind joiner to member-pays under lock(1) and emails them once", async () => {
    mocks.groupFindMany.mockResolvedValue([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(lockedRow());
    mocks.bookingFindMany
      .mockResolvedValueOnce([{ id: "late-1", checkIn: FUTURE }])
      .mockResolvedValueOnce([released]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 1,
      skippedStarted: 0,
    });

    // Only live, paid organiser-pays groups that still hold an
    // organiser-settled, unpaid, live child are candidates, so a joiner moved
    // once is never selected again.
    expect(mocks.groupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
          status: { not: GroupBookingStatus.CANCELLED },
          settlement: { is: { status: PaymentStatus.SUCCEEDED } },
          organiserBooking: {
            deletedAt: null,
            status: { not: BookingStatus.CANCELLED },
            linkedBookings: {
              some: {
                organiserSettled: true,
                deletedAt: null,
                status: {
                  notIn: [
                    BookingStatus.PAID,
                    BookingStatus.CANCELLED,
                    BookingStatus.BUMPED,
                    BookingStatus.COMPLETED,
                  ],
                },
              },
            },
          },
        },
      })
    );
    // lock(1), then the re-read, then the move — all in one transaction.
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.groupFindUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.groupFindUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bookingUpdateMany.mock.invocationCallOrder[0]
    );
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: ["late-1"] },
        parentBookingId: "org-g1",
        organiserSettled: true,
      }),
      data: { organiserSettled: false },
    });
    expect(mocks.sendPaySelf).toHaveBeenCalledTimes(1);
    expect(mocks.sendPaySelf).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingContext: { bookingId: "late-1", recipientMemberId: "m-late" },
        organiserName: "Olive Organiser",
      })
    );
    expect(mocks.sendStartedAlert).not.toHaveBeenCalled();
  });

  // The `INV-PAY-016` started-stay rule, in the club's zone: check-in before
  // or on the club's today is a stay that has started.
  it("leaves joiners whose stay started yesterday or today, and tells the treasurer once for the group", async () => {
    mocks.groupFindMany.mockResolvedValue([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(lockedRow());
    mocks.bookingFindMany
      .mockResolvedValueOnce([
        { id: "past-1", checkIn: PAST },
        { id: "today-1", checkIn: TODAY },
        { id: "late-1", checkIn: FUTURE },
      ])
      // The moved joiner, for their email.
      .mockResolvedValueOnce([released])
      // The skipped joiners, named in the treasurer's alert.
      .mockResolvedValueOnce([
        { memberId: "m1", member: { firstName: "Pat", lastName: "Past" }, organisation: null },
        { memberId: "m2", member: { firstName: "Tia", lastName: "Today" }, organisation: null },
      ]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 1,
      skippedStarted: 2,
    });

    expect(mocks.bookingUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["late-1"] });
    expect(mocks.sendPaySelf).toHaveBeenCalledTimes(1);
    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "group-joiner-started-stay:g1" })
    );
    expect(mocks.sendStartedAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendStartedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organiserBookingId: "org-g1",
        joinerNames: "Pat Past, Tia Today",
      })
    );
  });

  it("does not alert the treasurer again once the group's alert is claimed", async () => {
    mocks.groupFindMany.mockResolvedValue([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(lockedRow());
    mocks.bookingFindMany.mockResolvedValueOnce([{ id: "past-1", checkIn: PAST }]);
    mocks.claimAlertCooldown.mockResolvedValue(false);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 0,
      skippedStarted: 1,
    });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendStartedAlert).not.toHaveBeenCalled();
    expect(mocks.sendPaySelf).not.toHaveBeenCalled();
  });

  it.each([
    ["the group was cancelled", lockedRow({ status: GroupBookingStatus.CANCELLED })],
    ["the settlement is no longer paid", lockedRow({ settlement: { status: PaymentStatus.REFUNDED } })],
    [
      "the organiser booking was cancelled",
      lockedRow({ organiserBooking: { status: BookingStatus.CANCELLED, deletedAt: null } }),
    ],
    ["the group is gone", null],
  ])("moves nobody and emails nobody when, under the lock, %s", async (_label, row) => {
    mocks.groupFindMany.mockResolvedValue([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(row);
    // A left-behind joiner is there to move, so only the re-read can stop it.
    mocks.bookingFindMany.mockResolvedValue([{ id: "late-1", checkIn: FUTURE }]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 0,
      skippedStarted: 0,
    });

    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendPaySelf).not.toHaveBeenCalled();
  });

  it("carries on with the next group when one fails", async () => {
    mocks.groupFindMany.mockResolvedValue([liveGroup("g1"), liveGroup("g2")]);
    mocks.groupFindUnique
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(lockedRow());
    mocks.bookingFindMany
      .mockResolvedValueOnce([{ id: "late-1", checkIn: FUTURE }])
      .mockResolvedValueOnce([released]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 1,
      skippedStarted: 0,
    });
    expect(mocks.sendPaySelf).toHaveBeenCalledTimes(1);
  });
});
