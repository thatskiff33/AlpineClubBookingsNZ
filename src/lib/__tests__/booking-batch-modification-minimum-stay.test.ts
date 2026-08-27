import { beforeEach, describe, expect, it, vi } from "vitest";

// #2363. `modifyBookingBatch` is the service behind PUT /api/bookings/[id]/modify
// — the ONLY edit path the member panel and the admin booking screen actually
// call. Until now it wrote the new dates with no minimum-stay check at all,
// while its protected sibling `modifyBookingDates` (whose route has no UI
// caller) carried the block. These tests pin the block on the live path: it
// fires for non-admins, carries the complete frozen review snapshot, runs
// BEFORE the guest plan / pricing / capacity check, and leaves admin and
// price-preserving edits alone.

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  validateMinimumStay: vi.fn(),
  formatViolationsDetail: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  isQuotePricedBooking: vi.fn(),
  prepareGuestPlan: vi.fn(),
  loadMemberGuestAddPolicy: vi.fn(),
  assertProposedDateEditClearsXeroLockDate: vi.fn(),
  assertProposedCheckInClearsXeroLockDate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: h.transaction },
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, acquireLodgeCapacityLock: h.acquireLodgeCapacityLock };
});

// Partial mock: `resolveTargetDates`, `assertBookingModifiable` and the edit
// policy stay REAL, so the dates the guard is handed are the ones the service
// would really write. Only the two collaborators that need a live database are
// stubbed.
vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
  return {
    ...actual,
    isQuotePricedBooking: h.isQuotePricedBooking,
    prepareGuestPlan: h.prepareGuestPlan,
  };
});

vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/member-guest-add-policy")>();
  return { ...actual, loadMemberGuestAddPolicy: h.loadMemberGuestAddPolicy };
});

vi.mock("@/lib/xero-period-lock-guard", () => ({
  assertProposedCheckInClearsXeroLockDate:
    h.assertProposedCheckInClearsXeroLockDate,
  assertProposedDateEditClearsXeroLockDate:
    h.assertProposedDateEditClearsXeroLockDate,
}));

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: h.formatViolationsDetail,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { MinimumStayPolicyViolationError } from "@/lib/booking-policy-exceptions";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");

/**
 * The club's zone, named rather than taken from a helper default (#3123).
 * `getBookingEditPolicy` compares these fixtures against the club's own
 * today, so they stay relative to it: a hardcoded calendar date would rot
 * out of the future-edit window.
 */
const CLUB_ZONE = "Pacific/Auckland";

const storedCheckIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 30);
const storedCheckOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 33);
const shortCheckIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 30);
const shortCheckOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 31);

/** Proves how far a call got: everything after the minimum-stay guard. */
const GUEST_PLAN_SENTINEL = new Error("reached-the-guest-plan");

const LODGE_B = "lodge-b";

const violation = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-lodge-b",
  policyVersion: 7,
  policyName: "Lodge B winter week",
  resolvedScope: {
    kind: "LODGE",
    lodgeId: LODGE_B,
    effectiveLodgeId: LODGE_B,
  },
  affectedNights: [formatDateOnly(shortCheckIn)],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Lodge B requires three nights.",
  triggerDay: "Thursday",
  minimumNights: 3,
  actualNights: 1,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 3,
    actualNights: 1,
    triggerDays: [4],
  },
} as const;

function loadedBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: LODGE_B,
    status: "CONFIRMED",
    checkIn: storedCheckIn,
    checkOut: storedCheckOut,
    finalPriceCents: 12_000,
    totalPriceCents: 12_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    creditElectionCents: null,
    organiserSettled: false,
    guests: [],
    payment: null,
    member: { id: "member-1" },
    promoRedemption: null,
  };
}

/** The exact client the service runs its transaction body on. */
let txClient: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  txClient = {
    $executeRaw: h.executeRaw,
    booking: { findUnique: h.bookingFindUnique },
    choreAssignment: { findMany: vi.fn().mockResolvedValue([]) },
  };
  h.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) => callback(txClient),
  );
  h.bookingFindUnique
    .mockResolvedValueOnce({ lodgeId: LODGE_B })
    .mockResolvedValueOnce(loadedBooking());
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.isQuotePricedBooking.mockResolvedValue(false);
  h.loadMemberGuestAddPolicy.mockResolvedValue({});
  h.assertProposedDateEditClearsXeroLockDate.mockResolvedValue(undefined);
  h.assertProposedCheckInClearsXeroLockDate.mockResolvedValue(undefined);
  h.formatViolationsDetail.mockReturnValue(
    "Lodge B winter week: minimum 3 nights",
  );
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  h.prepareGuestPlan.mockRejectedValue(GUEST_PLAN_SENTINEL);
});

describe("modifyBookingBatch minimum-stay enforcement (#2363)", () => {
  it("blocks a member's date edit with the exact frozen review, before the guest plan or any capacity work", async () => {
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const operation = modifyBookingBatch({
      todayAtClub: FIXTURE_CLUB_DAY,
      bookingId: "booking-1",
      actor: { id: "member-1", role: "USER" },
      input: {
        checkIn: formatDateOnly(shortCheckIn),
        checkOut: formatDateOnly(shortCheckOut),
      },
      ipAddress: "127.0.0.1",
    });

    await expect(operation).rejects.toBeInstanceOf(
      MinimumStayPolicyViolationError,
    );
    await expect(operation).rejects.toMatchObject({
      status: 400,
      code: "MINIMUM_STAY_VIOLATION",
      details: "Lodge B winter week: minimum 3 nights",
      message: "Lodge B winter week: minimum 3 nights",
      violations: [violation],
      exceptionReview: {
        violations: [violation],
        // The policy row's own mode is frozen into the aggregate.
        capacityMode: "HOLD",
      },
    });
    // Evaluated for the BOOKING'S lodge, on the dates the service would write.
    expect(h.validateMinimumStay).toHaveBeenCalledWith(
      shortCheckIn,
      shortCheckOut,
      LODGE_B,
      txClient,
    );
    // Nothing downstream ran: no guest plan, so no pricing and no capacity
    // check or claim for a stay the policy refuses.
    expect(h.prepareGuestPlan).not.toHaveBeenCalled();
  });

  it("lets a member's compliant date edit continue past the guard", async () => {
    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "member-1", role: "USER" },
        input: {
          checkIn: formatDateOnly(storedCheckIn),
          // A real move: one night longer than the stored envelope.
          checkOut: formatDateOnly(addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 34)),
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(GUEST_PLAN_SENTINEL);

    expect(h.validateMinimumStay).toHaveBeenCalledTimes(1);
    expect(h.prepareGuestPlan).toHaveBeenCalledTimes(1);
  });

  it("reads the policy set on the TRANSACTION'S OWN client, never the module pool", async () => {
    // This check runs while the transaction holds pg_advisory_xact_lock(1) AND
    // the per-lodge capacity lock. Letting `validateMinimumStay` fall back to
    // its module-level default would check out a second pool connection under
    // both of them — the pool-starvation shape the ordering rule at the top of
    // `member-guest-add-policy.ts` forbids, pinned for its own read by
    // `member-guest-boundary-gate.test.ts`. The composition rule lives in
    // docs/CONCURRENCY_AND_LOCKING.md.
    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "member-1", role: "USER" },
        input: {
          checkIn: formatDateOnly(storedCheckIn),
          checkOut: formatDateOnly(addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 34)),
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(GUEST_PLAN_SENTINEL);

    const [, , , db] = h.validateMinimumStay.mock.calls[0] ?? [];
    expect(db).toBe(txClient);
  });

  it("never blocks an ADMIN edit — including an admin editing on behalf of the member", async () => {
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        // A different actor id: the admin-on-behalf shape.
        actor: { id: "admin-9", role: "ADMIN" },
        input: {
          checkIn: formatDateOnly(shortCheckIn),
          checkOut: formatDateOnly(shortCheckOut),
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(GUEST_PLAN_SENTINEL);

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
  });

  it("leaves an admin date-shift override on its own path (dispatched at the route, never here)", async () => {
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "admin-9", role: "ADMIN" },
        input: {
          adminOverride: true,
          pricingMode: "shift",
          checkIn: formatDateOnly(shortCheckIn),
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(
      "Shift-mode admin overrides are applied through the date-shift path",
    );

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
  });

  it("exempts a guest name fix, exactly as the preview reports it", async () => {
    // The modify-quote preview answers `minimumStayValid: true` for an
    // identity-only request because a name fix cannot change a single night.
    // Enforcing here would only block an unrelated typo fix on a booking that
    // already sat outside the policy, and would make preview and apply
    // disagree.
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "member-1", role: "USER" },
        input: {
          guestUpdates: [{ guestId: "g1", firstName: "Ann", lastName: "Doe" }],
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(GUEST_PLAN_SENTINEL);

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
  });

  it("exempts a credit-election-only edit for the same reason", async () => {
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "member-1", role: "USER" },
        input: { applyCreditCents: 0 },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(GUEST_PLAN_SENTINEL);

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
  });

  it("exempts a guest ADD that leaves the nights alone — a grandfathered booking stays editable", async () => {
    // The exemption is "the nights did not move", not "the request was one of
    // two shapes". A booking that already sits outside a rule (grandfathered,
    // or the rule was added after it was made) must still accept a guest add:
    // the add cannot admit a NEW violation, and blocking it leaves the member
    // with no remedy at all — they cannot shorten a rule they did not set.
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "member-1", role: "USER" },
        input: {
          addGuests: [
            {
              firstName: "New",
              lastName: "Guest",
              ageTier: "ADULT",
              isMember: false,
            },
          ],
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(GUEST_PLAN_SENTINEL);

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
  });

  it("exempts a guest-stay-range payload that resolves to the SAME envelope", async () => {
    // The member panel sends `guestStayRanges` unconditionally in grid and
    // range modes, so this is the shape a plain guest edit actually arrives in.
    // What matters is the envelope those ranges resolve to, not the presence of
    // the field.
    h.bookingFindUnique.mockReset();
    h.bookingFindUnique.mockResolvedValueOnce({ lodgeId: LODGE_B }).mockResolvedValueOnce({
      ...loadedBooking(),
      guests: [
        {
          id: "g1",
          stayStart: storedCheckIn,
          stayEnd: storedCheckOut,
          nights: [],
          isMember: true,
          memberId: "member-1",
        },
      ],
    });
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "member-1", role: "USER" },
        input: {
          guestStayRanges: [
            {
              guestId: "g1",
              stayStart: formatDateOnly(storedCheckIn),
              stayEnd: formatDateOnly(storedCheckOut),
            },
          ],
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(GUEST_PLAN_SENTINEL);

    expect(h.validateMinimumStay).not.toHaveBeenCalled();
  });

  it("still blocks the moment a guest-stay-range payload WIDENS the envelope", async () => {
    // The mirror of the case above: the same field, but the resolved envelope
    // now covers a night the stored booking did not, so the policy applies.
    const widerCheckOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 34);
    h.bookingFindUnique.mockReset();
    h.bookingFindUnique.mockResolvedValueOnce({ lodgeId: LODGE_B }).mockResolvedValueOnce({
      ...loadedBooking(),
      guests: [
        {
          id: "g1",
          stayStart: storedCheckIn,
          stayEnd: storedCheckOut,
          nights: [],
          isMember: true,
          memberId: "member-1",
        },
      ],
    });
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "member-1", role: "USER" },
        input: {
          checkOut: formatDateOnly(widerCheckOut),
          guestStayRanges: [
            {
              guestId: "g1",
              stayStart: formatDateOnly(storedCheckIn),
              stayEnd: formatDateOnly(widerCheckOut),
            },
          ],
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toBeInstanceOf(MinimumStayPolicyViolationError);

    expect(h.validateMinimumStay).toHaveBeenCalledWith(
      storedCheckIn,
      widerCheckOut,
      LODGE_B,
      txClient,
    );
  });
});
