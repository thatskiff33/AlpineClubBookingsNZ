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
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
  },
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
  formatViolationsDetail: () => "Lodge B winter week: minimum 3 nights",
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { modifyBookingDates } from "@/lib/booking-date-modification-service";
import { MinimumStayPolicyViolationError } from "@/lib/booking-policy-exceptions";

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe("modifyBookingDates minimum-stay transport (#2363)", () => {
  /** The exact client the service runs its transaction body on. */
  let txClient: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    txClient = {
      $executeRaw: h.executeRaw,
      booking: { findUnique: h.bookingFindUnique },
      choreAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      // #3032: the pending-review fence reads this under the booking-edit locks.
      // Empty by default - no financial review is open - so this suite asserts
      // exactly what it asserted before.
      manualRefundTask: { findFirst: vi.fn().mockResolvedValue(null) },
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
  });

  it("throws the exact frozen non-default-lodge review before capacity or writes", async () => {
    const violation = {
      reasonCode: "MINIMUM_STAY",
      policyId: "policy-lodge-b",
      policyVersion: 9,
      policyName: "Lodge B winter week",
      resolvedScope: {
        kind: "LODGE",
        lodgeId: "lodge-b",
        effectiveLodgeId: "lodge-b",
      },
      affectedNights: ["2027-09-02", "2027-09-03"],
      exceptionEligible: true,
      capacityMode: "NO_HOLD",
      message: "Lodge B requires three nights.",
      triggerDay: "Thursday",
      minimumNights: 3,
      actualNights: 2,
      requirements: {
        kind: "MINIMUM_STAY",
        minimumNights: 3,
        actualNights: 2,
        triggerDays: [4],
      },
    } as const;
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const operation = modifyBookingDates({
      bookingId: "booking-1",
      actor: { id: "member-1", role: "USER" },
      input: { checkIn: "2027-09-02", checkOut: "2027-09-04" },
      ipAddress: "127.0.0.1",
    });

    await expect(operation).rejects.toBeInstanceOf(
      MinimumStayPolicyViolationError,
    );
    await expect(operation).rejects.toMatchObject({
      status: 400,
      code: "MINIMUM_STAY_VIOLATION",
      details: "Lodge B winter week: minimum 3 nights",
      violations: [violation],
      exceptionReview: {
        violations: [violation],
        capacityMode: "NO_HOLD",
      },
    });
    expect(h.validateMinimumStay).toHaveBeenCalledWith(
      D("2027-09-02"),
      D("2027-09-04"),
      "lodge-b",
      txClient,
    );
    expect(h.checkCapacity).not.toHaveBeenCalled();
    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
  });

  it("reads the policy set on the TRANSACTION'S OWN client, never the module pool", async () => {
    // Same rule as the live `modifyBookingBatch` sibling: this check runs while
    // the transaction holds pg_advisory_xact_lock(1) and the per-lodge capacity
    // lock, so falling back to the module-level default would take a second pool
    // connection under both. See docs/CONCURRENCY_AND_LOCKING.md → minimum-stay
    // composition, and `member-guest-add-policy.ts` for the ordering rule.
    h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      fullNights: [],
    });
    h.checkCapacity.mockResolvedValue({ available: true, fullNights: [] });

    await modifyBookingDates({
      bookingId: "booking-1",
      actor: { id: "member-1", role: "USER" },
      input: { checkIn: "2027-09-02", checkOut: "2027-09-04" },
      ipAddress: "127.0.0.1",
    }).catch(() => undefined);

    expect(h.validateMinimumStay).toHaveBeenCalledTimes(1);
    const [, , , db] = h.validateMinimumStay.mock.calls[0] ?? [];
    expect(db).toBe(txClient);
  });
});
