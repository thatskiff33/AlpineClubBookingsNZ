import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
} from "@prisma/client";

/*
 * #3672 (`INV-PAY-109`, orchestrator decision 3): the group-settlement
 * reaper's self-heal. A paid organiser-pays group still holding an
 * organiser-settled joiner its bill did not cover (one left before the rule
 * existed) has that joiner switched to paying for themselves, under `lock(1)`
 * with the group re-read inside it — started stay or not. A joiner who can pay
 * before their stay is emailed; for a started stay the treasurer is alerted
 * once per group, re-driven from the payer-switch events until an admin has
 * it or has a copy queued for the email retry cron.
 */

const mocks = vi.hoisted(() => ({
  groupFindMany: vi.fn(),
  groupFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingSwitch: vi.fn(),
  eventCreateMany: vi.fn(),
  eventFindMany: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  sendPaySelf: vi.fn(),
  sendStartedAlert: vi.fn(),
  claimAlertCooldown: vi.fn(),
  releaseAlertCooldown: vi.fn(),
  deferAlertCooldown: vi.fn(),
  loggerError: vi.fn(),
}));

const tx = {
  $executeRaw: mocks.executeRaw,
  groupBooking: { findUnique: mocks.groupFindUnique },
  booking: { updateManyAndReturn: mocks.bookingSwitch },
  bookingEvent: { createMany: mocks.eventCreateMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findMany: mocks.groupFindMany },
    booking: { findMany: mocks.bookingFindMany },
    bookingEvent: { findMany: mocks.eventFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/email", () => ({
  sendGroupJoinPaySelfEmail: mocks.sendPaySelf,
  sendAdminGroupJoinerStartedStayAlert: mocks.sendStartedAlert,
}));
vi.mock("@/lib/alert-cooldown", () => ({
  ALERT_ONCE_EVER_WINDOW_MS: 36_500 * 86_400_000,
  ALERT_NOBODY_ELIGIBLE_RETRY_MS: 86_400_000,
  claimAlertCooldown: mocks.claimAlertCooldown,
  releaseAlertCooldown: mocks.releaseAlertCooldown,
  deferAlertCooldown: mocks.deferAlertCooldown,
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland"),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() },
}));

/** 1 Oct 2026, 13:00 in Auckland: the club's today is 2026-10-01. */
const NOW = new Date("2026-10-01T00:00:00.000Z");
const PAST = new Date("2026-09-30T00:00:00.000Z");
const TODAY = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-10-02T00:00:00.000Z");

import { releaseJoinersLeftBehindPaidSettlements } from "@/lib/group-late-joiner";
import {
  GROUP_JOINER_PAYS_OWN_EVENT_KIND,
  GROUP_JOINER_PAYS_OWN_EVENT_REASON,
} from "@/lib/manual-settlement-reversal-event";

function liveGroup(id: string) {
  return {
    id,
    organiserBookingId: `org-${id}`,
    organiserMember: { firstName: "Olive", lastName: "Organiser" },
  };
}

/** The group as the mid-stay alert pass loads it. */
function alertGroup(id: string) {
  return { ...liveGroup(id), organiserBooking: { checkIn: PAST } };
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
  checkIn: FUTURE,
  checkOut: new Date("2026-10-03T00:00:00.000Z"),
  member: { email: "late@example.com", firstName: "Lee" },
  organisation: null,
};

/** A payer-switch marker for a started stay, as the alert pass reads it. */
function startedMarker(bookingId: string, groupBookingId = "g1") {
  return {
    bookingId,
    snapshot: {
      kind: GROUP_JOINER_PAYS_OWN_EVENT_KIND,
      groupBookingId,
      organiserBookingId: `org-${groupBookingId}`,
      bookingStatus: BookingStatus.PAYMENT_PENDING,
      stayStarted: true,
    },
  };
}

const namedJoiners = [
  { id: "past-1", memberId: "m1", member: { firstName: "Pat", lastName: "Past" }, organisation: null },
];

/** `sendToAdmins`' result for one opted-in admin. */
function sendResult(overrides: Record<string, unknown> = {}) {
  return { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, ...overrides };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.transaction.mockImplementation(async (cb: (store: typeof tx) => unknown) => cb(tx));
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.eventCreateMany.mockResolvedValue({ count: 1 });
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.sendPaySelf.mockResolvedValue(undefined);
  mocks.sendStartedAlert.mockResolvedValue(sendResult());
  mocks.claimAlertCooldown.mockResolvedValue(true);
  mocks.releaseAlertCooldown.mockResolvedValue(undefined);
  mocks.deferAlertCooldown.mockResolvedValue(undefined);
});

describe("releaseJoinersLeftBehindPaidSettlements (#3672)", () => {
  it("switches a paid group's left-behind joiner under lock(1), records it, and emails them", async () => {
    mocks.groupFindMany.mockResolvedValueOnce([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(lockedRow());
    mocks.bookingSwitch.mockResolvedValue([
      { id: "late-1", status: BookingStatus.PAYMENT_PENDING, checkIn: FUTURE },
    ]);
    mocks.bookingFindMany.mockResolvedValueOnce([released]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 1,
      startedStayAlerts: 0,
    });

    // Only live, paid organiser-pays groups that still hold an
    // organiser-settled, unpaid, live child are candidates, so a switched
    // joiner is never selected again.
    expect(mocks.groupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
          status: { not: GroupBookingStatus.CANCELLED },
          settlement: {
            is: { status: { in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED] } },
          },
          organiserBooking: {
            deletedAt: null,
            status: { not: BookingStatus.CANCELLED },
            linkedBookings: {
              some: {
                organiserSettled: true,
                deletedAt: null,
                status: {
                  in: [
                    BookingStatus.PENDING,
                    BookingStatus.PAYMENT_PENDING,
                    BookingStatus.CONFIRMED,
                    BookingStatus.AWAITING_REVIEW,
                  ],
                },
              },
            },
          },
        },
      })
    );
    // lock(1), then the re-read, then the switch and its record — one transaction.
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.groupFindUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.groupFindUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bookingSwitch.mock.invocationCallOrder[0]
    );
    expect(mocks.bookingSwitch).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ parentBookingId: "org-g1", organiserSettled: true }),
        data: { organiserSettled: false },
      })
    );
    expect(mocks.eventCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          bookingId: "late-1",
          type: BookingEventType.CANCELLED,
          reason: GROUP_JOINER_PAYS_OWN_EVENT_REASON,
          snapshot: expect.objectContaining({ groupBookingId: "g1", stayStarted: false }),
        }),
      ],
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

  // Decision 3: a started stay is switched too, never emailed mid-stay, and
  // the treasurer is told once for the group.
  it("switches joiners whose stay started yesterday or today without emailing them, and alerts the treasurer once", async () => {
    mocks.groupFindMany
      .mockResolvedValueOnce([liveGroup("g1")])
      .mockResolvedValueOnce([alertGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(lockedRow());
    mocks.bookingSwitch.mockResolvedValue([
      { id: "past-1", status: BookingStatus.PAYMENT_PENDING, checkIn: PAST },
      { id: "today-1", status: BookingStatus.PAYMENT_PENDING, checkIn: TODAY },
      { id: "late-1", status: BookingStatus.PAYMENT_PENDING, checkIn: FUTURE },
    ]);
    mocks.bookingFindMany
      .mockResolvedValueOnce([released])
      .mockResolvedValueOnce([
        ...namedJoiners,
        { id: "today-1", memberId: "m2", member: { firstName: "Tia", lastName: "Today" }, organisation: null },
      ]);
    mocks.eventFindMany.mockResolvedValue([startedMarker("past-1"), startedMarker("today-1")]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 3,
      startedStayAlerts: 1,
    });

    const snapshots = mocks.eventCreateMany.mock.calls[0][0].data.map(
      (e: { snapshot: { stayStarted: boolean } }) => e.snapshot.stayStarted
    );
    expect(snapshots).toEqual([true, true, false]);
    expect(mocks.sendPaySelf).toHaveBeenCalledTimes(1);
    expect(mocks.bookingFindMany.mock.calls[0][0].where.id).toEqual({ in: ["late-1"] });
    // The alert pass reads started-stay switches whose joiner is still
    // unpaid and live, and whose stay has not ended: pinned whole, so dropping
    // the status or check-out bound fails here.
    expect(mocks.eventFindMany).toHaveBeenCalledWith({
      where: {
        type: BookingEventType.CANCELLED,
        AND: [
          { snapshot: { path: ["kind"], equals: GROUP_JOINER_PAYS_OWN_EVENT_KIND } },
          { snapshot: { path: ["stayStarted"], equals: true } },
        ],
        booking: {
          deletedAt: null,
          organiserSettled: false,
          status: {
            in: [
              BookingStatus.PENDING,
              BookingStatus.PAYMENT_PENDING,
              BookingStatus.CONFIRMED,
              BookingStatus.AWAITING_REVIEW,
            ],
          },
          checkOut: { gte: TODAY },
        },
      },
      select: { bookingId: true, snapshot: true },
    });
    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "group-joiner-started-stay:g1" })
    );
    expect(mocks.sendStartedAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendStartedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organiserBookingId: "org-g1",
        joiners: [
          { name: "Pat Past", bookingId: "past-1" },
          { name: "Tia Today", bookingId: "today-1" },
        ],
      })
    );
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
  });

  // The club's day, not UTC's: at 01:00 on 1 Oct in Auckland it is still
  // 30 Sep in UTC, and a 1 Oct check-in has already started.
  it("judges the check-in against the club's today, not UTC's", async () => {
    mocks.groupFindMany.mockResolvedValueOnce([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(lockedRow());
    mocks.bookingSwitch.mockResolvedValue([
      { id: "today-1", status: BookingStatus.PAYMENT_PENDING, checkIn: TODAY },
    ]);

    await releaseJoinersLeftBehindPaidSettlements(new Date("2026-09-30T12:00:00.000Z"));

    expect(mocks.eventCreateMany.mock.calls[0][0].data[0].snapshot.stayStarted).toBe(true);
    expect(mocks.sendPaySelf).not.toHaveBeenCalled();
  });

  it("switches a joiner under review without emailing them to pay", async () => {
    mocks.groupFindMany.mockResolvedValueOnce([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(lockedRow());
    mocks.bookingSwitch.mockResolvedValue([
      { id: "review-1", status: BookingStatus.AWAITING_REVIEW, checkIn: FUTURE },
    ]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 1,
      startedStayAlerts: 0,
    });
    expect(mocks.eventCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.sendPaySelf).not.toHaveBeenCalled();
  });

  it("does not alert the treasurer again once the group's alert is claimed", async () => {
    mocks.groupFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([alertGroup("g1")]);
    mocks.eventFindMany.mockResolvedValue([startedMarker("past-1")]);
    // The joiner the alert would name, so only the claim can stop it.
    mocks.bookingFindMany.mockResolvedValue(namedJoiners);
    mocks.claimAlertCooldown.mockResolvedValue(false);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 0,
      startedStayAlerts: 0,
    });
    expect(mocks.sendStartedAlert).not.toHaveBeenCalled();
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });

  /** Two reaper cycles over one started-stay group, the alert not yet sent. */
  function twoAlertCycles() {
    mocks.groupFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([alertGroup("g1")])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([alertGroup("g1")]);
    mocks.eventFindMany.mockResolvedValue([startedMarker("past-1")]);
    mocks.bookingFindMany.mockResolvedValue(namedJoiners);
  }

  // Concurrency review F1: a claim spent on a send that threw before reaching
  // anyone would silence the alert for good. It is given back, and the next
  // run sends it.
  it("gives the claim back when the send throws before reaching anyone, so the next run retries it", async () => {
    twoAlertCycles();
    mocks.sendStartedAlert.mockRejectedValueOnce(new Error("admin list unreadable"));

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 0,
      startedStayAlerts: 0,
    });
    const firstClaim = mocks.claimAlertCooldown.mock.calls[0][0];
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({
      key: "group-joiner-started-stay:g1",
      claimedAt: firstClaim.now,
    });
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 0,
      startedStayAlerts: 1,
    });
    expect(mocks.sendStartedAlert).toHaveBeenCalledTimes(2);
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledTimes(1);
  });

  // Delta review D1: every admin's copy failed into the email retry cron.
  // Giving the claim back would send a fresh copy on every run of an outage,
  // each one queued too, and all of them delivered at once on recovery.
  it("keeps the claim when an admin's copy is queued for the email retry cron", async () => {
    twoAlertCycles();
    mocks.sendStartedAlert.mockResolvedValueOnce(
      sendResult({ recipients: 2, sent: 0, queuedForRetry: 2 })
    );

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 0,
      startedStayAlerts: 1,
    });
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
  });

  // Delta review D2: nobody can receive it, so it is tried again daily, not on
  // every run.
  it.each([
    ["the template is switched off", sendResult({ deliveryAllowed: false, recipients: 0, sent: 0 })],
    ["no admin is opted in", sendResult({ recipients: 0, sent: 0 })],
    ["every admin is suppressed", sendResult({ recipients: 2, sent: 0, notDelivered: 2 })],
  ])("holds the claim for a day when %s", async (_label, result) => {
    twoAlertCycles();
    mocks.sendStartedAlert.mockResolvedValueOnce(result);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 0,
      startedStayAlerts: 0,
    });
    const firstClaim = mocks.claimAlertCooldown.mock.calls[0][0];
    expect(mocks.deferAlertCooldown).toHaveBeenCalledWith({
      key: "group-joiner-started-stay:g1",
      claimedAt: firstClaim.now,
      windowMs: 36_500 * 86_400_000,
      retryAfterMs: 86_400_000,
    });
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });

  it.each([
    ["the group was cancelled", lockedRow({ status: GroupBookingStatus.CANCELLED })],
    ["the settlement is no longer paid", lockedRow({ settlement: { status: PaymentStatus.REFUNDED } })],
    ["the settlement is gone", lockedRow({ settlement: null })],
    [
      "the organiser booking was cancelled",
      lockedRow({ organiserBooking: { status: BookingStatus.CANCELLED, deletedAt: null } }),
    ],
    ["the group is gone", null],
  ])("switches nobody and emails nobody when, under the lock, %s", async (_label, row) => {
    mocks.groupFindMany.mockResolvedValueOnce([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(row);
    // A left-behind joiner is there to switch, so only the re-read can stop it.
    mocks.bookingSwitch.mockResolvedValue([
      { id: "late-1", status: BookingStatus.PAYMENT_PENDING, checkIn: FUTURE },
    ]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 0,
      startedStayAlerts: 0,
    });

    expect(mocks.bookingSwitch).not.toHaveBeenCalled();
    expect(mocks.eventCreateMany).not.toHaveBeenCalled();
    expect(mocks.sendPaySelf).not.toHaveBeenCalled();
  });

  it("carries on with the next group when one fails", async () => {
    mocks.groupFindMany.mockResolvedValueOnce([liveGroup("g1"), liveGroup("g2")]);
    mocks.groupFindUnique
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(lockedRow());
    mocks.bookingSwitch.mockResolvedValue([
      { id: "late-1", status: BookingStatus.PAYMENT_PENDING, checkIn: FUTURE },
    ]);
    mocks.bookingFindMany.mockResolvedValueOnce([released]);

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 1,
      startedStayAlerts: 0,
    });
    expect(mocks.sendPaySelf).toHaveBeenCalledTimes(1);
  });

  // Concurrency review F2: the switch committed, so a failure reading the
  // joiners for their email is not "failed to move", and is counted as moved.
  it("reports a committed switch as moved when loading its email fails", async () => {
    mocks.groupFindMany.mockResolvedValueOnce([liveGroup("g1")]);
    mocks.groupFindUnique.mockResolvedValue(lockedRow());
    mocks.bookingSwitch.mockResolvedValue([
      { id: "late-1", status: BookingStatus.PAYMENT_PENDING, checkIn: FUTURE },
    ]);
    mocks.bookingFindMany.mockRejectedValueOnce(new Error("db blip"));

    await expect(releaseJoinersLeftBehindPaidSettlements(NOW)).resolves.toEqual({
      released: 1,
      startedStayAlerts: 0,
    });
    const messages = mocks.loggerError.mock.calls.map((call) => call[1]);
    expect(messages).not.toContain("Failed to move a paid group's left-behind joiners to member-pays");
    expect(messages).toContain(
      "Failed to load switched group joiners to tell them to pay; the switch stands"
    );
  });
});
