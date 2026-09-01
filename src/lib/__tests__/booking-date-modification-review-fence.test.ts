/**
 * #3032 (epic #2797): the pending-review fence on the DATE-EDIT paths.
 *
 * `booking-date-modification-service.ts` holds both of them, and they answer the
 * fence differently ON PURPOSE:
 *
 *  - `modifyBookingDates` reprices every time it runs, so it is fenced
 *    unconditionally. It is the path the fence exists for.
 *  - `adminShiftBookingDates` is the price-preserving shift (`priceDiffCents: 0`,
 *    no refund, no credit, no Xero delta), so it is deliberately NOT fenced -
 *    fencing it would trap an officer moving a booking's dates behind a pricing
 *    question that has nothing to do with the move.
 *
 * The pair matters more than either half. A fence that refused everything and a
 * fence that refused nothing each satisfy one of these cases; only the two
 * together say the split is where the issue asks for it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  validateMinimumStay: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacity: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  assertBookingNotQuotePriced: vi.fn(),
  assertProposedDateEditClearsXeroLockDate: vi.fn(),
  manualRefundTaskFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: h.transaction },
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
    checkCapacity: h.checkCapacity,
    checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
  };
});

vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
  return {
    ...actual,
    assertBookingNotQuotePriced: h.assertBookingNotQuotePriced,
  };
});

vi.mock("@/lib/xero-period-lock-guard", () => ({
  assertProposedCheckInClearsXeroLockDate: vi.fn(),
  assertProposedDateEditClearsXeroLockDate:
    h.assertProposedDateEditClearsXeroLockDate,
}));

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: () => "minimum stay",
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  adminShiftBookingDates,
  modifyBookingDates,
} from "@/lib/booking-date-modification-service";

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);

const OPEN_REVIEW = {
  id: "task-open",
  occurrenceKey: "edit-financial-review:v1:abc",
  amountCents: null,
  raisedAmountCents: null,
  reviewContext: null,
};

function capacityCallCount() {
  return (
    h.checkCapacity.mock.calls.length +
    h.checkCapacityForGuestRanges.mock.calls.length
  );
}

describe("#3032 pending financial review fences a date edit", () => {
  let txClient: Record<string, unknown>;
  let bookingUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    bookingUpdate = vi.fn();
    txClient = {
      $executeRaw: h.executeRaw,
      booking: { findUnique: h.bookingFindUnique, update: bookingUpdate },
      choreAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      manualRefundTask: { findFirst: h.manualRefundTaskFindFirst },
    };
    h.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(txClient),
    );
    h.bookingFindUnique
      .mockResolvedValueOnce({ lodgeId: "lodge-b" })
      .mockResolvedValueOnce({
        id: "booking-1",
        memberId: "member-1",
        lodgeId: "lodge-b",
        status: "PAID",
        checkIn: D("2027-09-01"),
        checkOut: D("2027-09-03"),
        guests: [],
        payment: null,
        member: { id: "member-1" },
        promoRedemption: null,
      });
    h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
    h.assertBookingNotQuotePriced.mockResolvedValue(undefined);
    h.assertProposedDateEditClearsXeroLockDate.mockResolvedValue(undefined);
    h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
    h.checkCapacity.mockResolvedValue({ available: true, fullNights: [] });
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      fullNights: [],
    });
    h.manualRefundTaskFindFirst.mockResolvedValue(null);
  });

  it("refuses a date change while the booking's money is under review", async () => {
    h.manualRefundTaskFindFirst.mockResolvedValue(OPEN_REVIEW);

    await expect(
      modifyBookingDates({
        bookingId: "booking-1",
        actor: { id: "member-1", role: "USER" },
        input: { checkIn: "2027-09-02", checkOut: "2027-09-04" },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "EDIT_FINANCIAL_REVIEW_PENDING",
    });

    // Refused before capacity is claimed and before anything is written, so a
    // refused edit leaves the booking and the calendar exactly as they were.
    expect(capacityCallCount()).toBe(0);
    expect(bookingUpdate).not.toHaveBeenCalled();
  });

  it("refuses an ADMIN date change on the same terms - the fence is about the money", async () => {
    h.manualRefundTaskFindFirst.mockResolvedValue(OPEN_REVIEW);

    await expect(
      modifyBookingDates({
        bookingId: "booking-1",
        actor: { id: "officer-1", role: "ADMIN" },
        input: { checkIn: "2027-09-02", checkOut: "2027-09-04" },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("CONTROL: the same date change is not refused when no review is open", async () => {
    // Without this the two cases above would pass equally against a fence that
    // refused every date edit. The run is allowed to fail LATER - this harness
    // stubs only as far as the fence - so the assertion is that it got past the
    // fence and reached the capacity claim, which sits below it.
    await modifyBookingDates({
      bookingId: "booking-1",
      actor: { id: "member-1", role: "USER" },
      input: { checkIn: "2027-09-02", checkOut: "2027-09-04" },
      ipAddress: "127.0.0.1",
    }).catch(() => undefined);

    expect(h.manualRefundTaskFindFirst).toHaveBeenCalledTimes(1);
    expect(capacityCallCount()).toBeGreaterThan(0);
  });

  it("reads the fence on the transaction's own client, never the module pool", async () => {
    // Same rule as every other read on this path: it runs while the transaction
    // holds pg_advisory_xact_lock(1) and the per-lodge capacity lock, so a
    // fallback to the module client would take a second pooled connection under
    // both (`INV-LOCK-004`). The service calls `store.manualRefundTask.findFirst`,
    // and only the tx client above carries this spy.
    h.manualRefundTaskFindFirst.mockResolvedValue(OPEN_REVIEW);

    await modifyBookingDates({
      bookingId: "booking-1",
      actor: { id: "member-1", role: "USER" },
      input: { checkIn: "2027-09-02", checkOut: "2027-09-04" },
      ipAddress: "127.0.0.1",
    }).catch(() => undefined);

    expect(h.manualRefundTaskFindFirst).toHaveBeenCalledTimes(1);
  });

  it("the price-preserving admin shift is NOT fenced, and never even asks", async () => {
    // `adminShiftBookingDates` moves the dates and freezes the cents. Fencing it
    // would trap an officer behind a pricing question about a change that moves
    // no money at all.
    h.manualRefundTaskFindFirst.mockResolvedValue(OPEN_REVIEW);

    await adminShiftBookingDates({
      bookingId: "booking-1",
      actor: { id: "officer-1", role: "ADMIN" },
      input: { checkIn: "2027-09-02", checkOut: "2027-09-04" },
      ipAddress: "127.0.0.1",
    }).catch(() => undefined);

    // It got at least as far as the capacity claim, which is BELOW where the
    // fence sits on the sibling path - so the absence of the read below is the
    // shift genuinely not asking, not the run stopping early.
    expect(capacityCallCount()).toBeGreaterThan(0);
    expect(h.manualRefundTaskFindFirst).not.toHaveBeenCalled();
  });
});
