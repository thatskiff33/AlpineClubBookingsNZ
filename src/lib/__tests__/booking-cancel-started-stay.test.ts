/**
 * #2029: self-service (member / Booking Officer) cancellation of a stay that has
 * already started (NZ check-in on or before today) is blocked, restoring the
 * invariant the widened PAID completion window removed. A Full Admin keeps full
 * cancellation capability, and only the member-facing route opts in
 * (`enforceStartedStayBlock`). Every path here returns at the started-stay guard
 * or the status gate BEFORE any transaction / provider work, so the mock surface
 * is intentionally minimal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bookingFindUnique } = vi.hoisted(() => ({ bookingFindUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: bookingFindUnique } },
}));

// Lightweight stubs so the module imports; none of these are reached by the
// early-return paths under test.
vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellable: vi.fn(),
  cancelSetupIntentIfCancellable: vi.fn(),
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: vi.fn() }));
vi.mock("@/lib/cancellation", () => ({
  calculateAppliedCreditRestore: vi.fn(),
  calculateRefundAmount: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
}));
vi.mock("@/lib/email", () => ({ sendBookingCancelledEmail: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/booking-events", () => ({ recordBookingEvent: vi.fn() }));
vi.mock("@/lib/member-credit", () => ({
  createCancellationCredit: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));
vi.mock("@/lib/waitlist", () => ({ processWaitlistForDates: vi.fn() }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroAccountCreditNoteOperation: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/payment-transactions", () => ({
  PartialRefundError: class extends Error {},
  applyLocalRefundAllocation: vi.fn(),
  markPaymentIntentTransactionFailed: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  refundPaymentTransactions: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({
  buildBookingCancellationRefundMetadata: vi.fn(),
  enqueueBookingCancellationRefundRecovery: vi.fn(),
  enqueuePaymentIntentCancellationRecovery: vi.fn(),
  markBookingCancellationRefundRecoverySucceeded: vi.fn(),
  recordBookingCancellationRefundRecoveryInlineError: vi.fn(),
}));
vi.mock("@/lib/promo", () => ({ deletePromoRedemptionAndAdjustCount: vi.fn() }));
vi.mock("@/lib/booking-status", () => ({
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE: {},
  RELEASE_WHOLE_LODGE_HOLD_UPDATE: {},
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn(),
}));
vi.mock("@/lib/payment-link", () => ({ revokePaymentLinksForBooking: vi.fn() }));
vi.mock("@/lib/group-cancel", () => ({ settleGroupBookingOnOrganiserCancel: vi.fn() }));
vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking: vi.fn(),
}));
vi.mock("@/lib/xero-applied-credit-operation-serialization", () => ({
  findUnconvergedAppliedCreditDeallocation: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({ acquireLodgeCapacityLock: vi.fn() }));

// booking-edit-policy (the bookingStayHasStarted source) is intentionally NOT
// mocked so the real NZ date logic runs against the faked clock.

import { cancelBooking } from "@/lib/booking-cancel";
import {
  CANCELLABLE_BOOKING_STATUSES,
  cancellableStatusRefusal,
} from "@/lib/booking-cancel-eligibility";

const STARTED_MSG =
  "This stay has already started, so it can no longer be cancelled online. To leave early, edit the booking to shorten your remaining nights, or contact the club for help.";
// #3497: the status refusal is DERIVED from the set the guard reads, so the pin
// is the derivation plus a shape check — it must name every cancellable status,
// in the set's order, as the "A, B, or C" sentence the service has always used.
const STATUS_MSG = cancellableStatusRefusal();
describe("the service's status refusal names exactly the set it guards", () => {
  it("is the cancellable set in prose", () => {
    expect(STATUS_MSG).toBe(
      `Only ${CANCELLABLE_BOOKING_STATUSES.slice(0, -1).join(", ")}, or ${
        CANCELLABLE_BOOKING_STATUSES[CANCELLABLE_BOOKING_STATUSES.length - 1]
      } bookings can be cancelled`,
    );
    for (const status of CANCELLABLE_BOOKING_STATUSES) expect(STATUS_MSG).toContain(status);
  });
});

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const OWNER = "member-1";

function errorOf(r: Awaited<ReturnType<typeof cancelBooking>>): string | undefined {
  return "error" in r ? r.error : undefined;
}

function setBooking(opts: { status: string; checkIn: string; memberId?: string }) {
  bookingFindUnique.mockResolvedValue({
    id: "b1",
    status: opts.status,
    checkIn: D(opts.checkIn),
    checkOut: D("2026-08-25"),
    memberId: opts.memberId ?? OWNER,
    payment: null,
    member: { id: OWNER, email: "m@example.com", firstName: "Mem" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // 2026-08-23T18:00Z = 2026-08-24 06:00 NZ, so NZ today = 2026-08-24.
  vi.setSystemTime(new Date("2026-08-23T18:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cancelBooking — #2029 started-stay self-service block", () => {
  it("(a) blocks a member cancelling a mid-stay PAID booking", async () => {
    setBooking({ status: "PAID", checkIn: "2026-08-20" }); // started
    const result = await cancelBooking("b1", OWNER, "USER", "127.0.0.1", "card", {
      enforceStartedStayBlock: true,
    });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe(STARTED_MSG);
  });

  it("(b) blocks a member cancelling on the check-out day (check-in == today)", async () => {
    setBooking({ status: "PAID", checkIn: "2026-08-24" }); // starts today
    const result = await cancelBooking("b1", OWNER, "USER", "127.0.0.1", "card", {
      enforceStartedStayBlock: true,
    });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe(STARTED_MSG);
  });

  it("blocks a Booking Officer (non-owner, bookings:edit) cancelling a started stay", async () => {
    setBooking({ status: "PAID", checkIn: "2026-08-20", memberId: OWNER });
    const result = await cancelBooking("b1", "officer-9", "USER", "127.0.0.1", "card", {
      enforceStartedStayBlock: true,
      hasBookingsEditAccess: true,
    });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe(STARTED_MSG);
  });

  it("(c) does NOT block a future (not-started) booking — falls through to the normal flow", async () => {
    // Non-cancellable status so we observe the STATUS gate (not the started
    // gate) without driving the full refund machinery — proving the started
    // guard was skipped for a future stay.
    setBooking({ status: "DRAFT", checkIn: "2026-08-30" }); // future
    const result = await cancelBooking("b1", OWNER, "USER", "127.0.0.1", "card", {
      enforceStartedStayBlock: true,
    });
    expect(errorOf(result)).not.toBe(STARTED_MSG);
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe(STATUS_MSG);
  });

  it("(d) does NOT block a Full Admin cancelling a started stay", async () => {
    // Admin is exempt from the started guard. Use a non-cancellable status so we
    // land on the STATUS gate rather than the full admin paid-cancel flow (that
    // path is covered by the existing booking-cancel suite).
    setBooking({ status: "COMPLETED", checkIn: "2026-08-20" }); // started
    const result = await cancelBooking("b1", "admin-1", "ADMIN", "127.0.0.1", "card", {
      enforceStartedStayBlock: true,
    });
    expect(errorOf(result)).not.toBe(STARTED_MSG);
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe(STATUS_MSG);
  });

  it("does NOT block when the caller does not opt in (internal/admin cancel paths)", async () => {
    setBooking({ status: "DRAFT", checkIn: "2026-08-20" }); // started, but no flag
    const result = await cancelBooking("b1", OWNER, "USER", "127.0.0.1", "card", {
      // enforceStartedStayBlock omitted (defaults false)
    });
    expect(errorOf(result)).not.toBe(STARTED_MSG);
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe(STATUS_MSG);
  });
});

describe("cancelBooking — #3497 member-door status guard (enforceMemberCancelDoor)", () => {
  const REVIEW_MSG =
    "This booking is with the club for review, so it cannot be cancelled from here. If you no longer want it, contact the club and the reviewing officer will withdraw it.";

  it("refuses a member cancelling a booking under review, with the sentence that says what to do instead", async () => {
    setBooking({ status: "AWAITING_REVIEW", checkIn: "2026-08-30" }); // future
    const result = await cancelBooking("b1", OWNER, "USER", "127.0.0.1", "card", {
      enforceStartedStayBlock: true,
      enforceMemberCancelDoor: true,
    });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe(REVIEW_MSG);
  });

  it("does not exempt a Full Admin on the member route — their door is the review Reject", async () => {
    setBooking({ status: "AWAITING_REVIEW", checkIn: "2026-08-30" });
    const result = await cancelBooking("b1", "admin-1", "ADMIN", "127.0.0.1", "card", {
      enforceStartedStayBlock: true,
      enforceMemberCancelDoor: true,
    });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe(REVIEW_MSG);
  });

  it("runs AFTER authorization, so a stranger learns nothing about the booking's status", async () => {
    setBooking({ status: "AWAITING_REVIEW", checkIn: "2026-08-30", memberId: OWNER });
    const result = await cancelBooking("b1", "stranger-7", "USER", "127.0.0.1", "card", {
      enforceMemberCancelDoor: true,
    });
    expect(result.status).toBe(403);
    expect(errorOf(result)).not.toBe(REVIEW_MSG);
  });

  it("leaves every internal/officer caller on the service's full set when the flag is off", async () => {
    setBooking({ status: "AWAITING_REVIEW", checkIn: "2026-08-30" });
    // Only the guard is under test: whatever the no-payment cancel path does
    // with this mocked tx, it must not have been the member-door refusal.
    const result = await cancelBooking("b1", OWNER, "USER", "127.0.0.1", "card").catch(
      (error: unknown) => ({ status: -1, error: String(error) }),
    );
    expect(result.status === 400 && errorOf(result as never) === REVIEW_MSG).toBe(false);
  });
});
