import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
// Real class from the unmocked types module — the route imports it from here for
// the same instanceof-through-mock reason, so this matches what the route sees.
import { RetroactiveCardPaymentError } from "@/lib/booking-create-types";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";

// Route-level gating test for retroactive create (#1695). The booking-create
// service is a spy so we can assert what the route threads and inject its
// structured errors; every pre-service helper is stubbed to pass through so the
// request reaches the past-date / lock-date guards deterministically.
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  managementRole: vi.fn(),
  hasAdminAccess: vi.fn(),
  hasAccessRole: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  createConfirmedBooking: vi.fn(),
  createDraftBooking: vi.fn(),
  createWaitlistedBooking: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
  getEffectiveXeroLockDate: vi.fn(),
  memberFindUnique: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { bookingCreate: {}, bookingQuery: {} },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: h.hasAdminAccess,
  hasAccessRole: h.hasAccessRole,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.managementRole,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: h.memberFindUnique },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
  },
}));
vi.mock("@/lib/booking-guests", () => ({
  resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
  assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
  normalizeBookingGuestInputs: (guests: unknown[]) => guests,
  BookingGuestValidationError: class extends Error {},
  getBookingGuestValidationErrorResponse: (e: { message: string }) => ({
    error: e.message,
  }),
}));
vi.mock("@/lib/booking-guest-stay-range-input", () => ({
  normalizeGuestStayRanges: (guests: unknown[]) => guests,
  BookingGuestStayRangeValidationError: class extends Error {},
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: vi.fn().mockResolvedValue([]),
  BookingMemberNightConflictError: class extends Error {
    conflicts: unknown[] = [];
  },
  getBookingMemberNightConflictResponse: () => ({ error: "conflict" }),
}));
vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: vi.fn().mockResolvedValue("lodge-1"),
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(30),
}));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  getMembershipTypeBookingPolicyErrorBody: (e: { message: string }) => ({
    error: e.message,
  }),
  MembershipTypeBookingPolicyError: class extends Error {
    status = 400;
  },
  requiresPaidSubscriptionForMemberForBooking: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuests: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: vi
    .fn()
    .mockResolvedValue({ enabled: false, holdDays: 0, source: "default" }),
}));
vi.mock("@/lib/policies/booking-route-decisions", () => ({
  calculateBookingHoldDecision: () => ({
    shouldBePending: false,
    status: "PAYMENT_PENDING",
  }),
  toGroupDiscountConfig: () => ({}),
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/utils", () => ({ getSeasonYear: () => 2026 }));
vi.mock("@/lib/internet-banking-settings", () => ({
  checkInternetBankingLeadTime: () => ({ allowed: true }),
  loadInternetBankingPaymentSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: h.isXeroConnected }));
vi.mock("@/lib/xero-organisation", () => ({
  getXeroLockDates: h.getXeroLockDates,
  getEffectiveXeroLockDate: h.getEffectiveXeroLockDate,
}));
vi.mock("@/lib/booking-create", () => ({
  createConfirmedBooking: h.createConfirmedBooking,
  createDraftBooking: h.createDraftBooking,
  createWaitlistedBooking: h.createWaitlistedBooking,
  RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS: 365,
  BookingLodgeError: class extends Error {},
  BookingPromoError: class extends Error {},
  BookingReviewJustificationRequiredError: class extends Error {},
}));

import { POST } from "@/app/api/bookings/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const ADMIN_SESSION = {
  user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};

function daysFromTodayStr(delta: number) {
  return formatDateOnly(addDaysDateOnly(getTodayDateOnly(), delta));
}

const guests = [
  { firstName: "Jane", lastName: "Doe", ageTier: "ADULT", isMember: true, memberId: "target-m1" },
];

function pastPayload(extra: Record<string, unknown> = {}) {
  const checkIn = daysFromTodayStr(-10);
  const checkOut = daysFromTodayStr(-8);
  return { checkIn, checkOut, guests, forMemberId: "target-m1", ...extra };
}

function futurePayload(extra: Record<string, unknown> = {}) {
  const checkIn = daysFromTodayStr(30);
  const checkOut = daysFromTodayStr(32);
  return { checkIn, checkOut, guests, forMemberId: "target-m1", ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(ADMIN_SESSION);
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.managementRole.mockReturnValue("ADMIN");
  h.hasAdminAccess.mockReturnValue(true);
  h.hasAccessRole.mockReturnValue(false); // admin-only account (no USER token)
  h.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: true,
    bedAllocation: false,
    internetBankingPayments: false,
  });
  h.memberFindUnique.mockResolvedValue({ active: true });
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.isXeroConnected.mockResolvedValue(false);
  h.getEffectiveXeroLockDate.mockReturnValue(null);
  h.createConfirmedBooking.mockResolvedValue({
    type: "created",
    booking: { id: "b-new", status: "PAID" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/bookings retroactive create gating (#1695)", () => {
  it("rejects override flags when the management role is not ADMIN (403), service not called", async () => {
    h.managementRole.mockReturnValue("USER");
    h.hasAdminAccess.mockReturnValue(false);
    h.hasAccessRole.mockReturnValue(true);

    const res = await POST(makeRequest(futurePayload({ allowPastDates: false })));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Admin override is not available");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects allowPastDates without forMemberId (400)", async () => {
    const checkIn = daysFromTodayStr(-10);
    const checkOut = daysFromTodayStr(-8);
    const res = await POST(
      makeRequest({ checkIn, checkOut, guests, allowPastDates: true }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("booking on behalf");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects confirmOverCapacity without allowPastDates (400)", async () => {
    const res = await POST(
      makeRequest(futurePayload({ confirmOverCapacity: true })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("confirmOverCapacity requires allowPastDates");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects a past check-in without the flag — 400 regression pin", async () => {
    const res = await POST(makeRequest(pastPayload()));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot book in the past");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects allowPastDates combined with draft (400)", async () => {
    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true, draft: true })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot be saved as a draft");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("passes a past on-behalf create with the flag, threading the three flags", async () => {
    const res = await POST(
      makeRequest(
        pastPayload({ allowPastDates: true, notifyMember: false }),
      ),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    expect(h.createConfirmedBooking.mock.calls[0][0]).toMatchObject({
      allowPastDates: true,
      notifyMember: false,
      isOnBehalf: true,
    });
  });

  it("rejects 366 days back but allows exactly 365", async () => {
    const tooFarIn = daysFromTodayStr(-366);
    const tooFarOut = daysFromTodayStr(-364);
    const resTooFar = await POST(
      makeRequest({
        checkIn: tooFarIn,
        checkOut: tooFarOut,
        guests,
        forMemberId: "target-m1",
        allowPastDates: true,
      }),
    );
    expect(resTooFar.status).toBe(400);
    expect((await resTooFar.json()).error).toContain("at most 365 days");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();

    const boundaryIn = daysFromTodayStr(-365);
    const boundaryOut = daysFromTodayStr(-363);
    const resBoundary = await POST(
      makeRequest({
        checkIn: boundaryIn,
        checkOut: boundaryOut,
        guests,
        forMemberId: "target-m1",
        allowPastDates: true,
      }),
    );
    expect(resBoundary.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });

  it("rejects with 409 XERO_PERIOD_LOCKED when the lock date is on/after the check-in", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    const checkIn = daysFromTodayStr(-10);
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: addDaysDateOnly(getTodayDateOnly(), -5),
      endOfYearLockDate: null,
    });
    h.getEffectiveXeroLockDate.mockReturnValue(
      addDaysDateOnly(getTodayDateOnly(), -5),
    );

    const res = await POST(
      makeRequest({
        checkIn,
        checkOut: daysFromTodayStr(-8),
        guests,
        forMemberId: "target-m1",
        allowPastDates: true,
      }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("XERO_PERIOD_LOCKED");
    expect(body.lockDate).toBe(formatDateOnly(addDaysDateOnly(getTodayDateOnly(), -5)));
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("proceeds when the lock date is before the check-in", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: addDaysDateOnly(getTodayDateOnly(), -30),
      endOfYearLockDate: null,
    });
    h.getEffectiveXeroLockDate.mockReturnValue(
      addDaysDateOnly(getTodayDateOnly(), -30),
    );

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });

  it("fails closed with 503 when the lock-date fetch throws", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    h.getXeroLockDates.mockRejectedValue(new Error("xero down"));

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("XERO_LOCK_DATE_CHECK_FAILED");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("skips the lock-date helper entirely when Xero is not connected", async () => {
    h.isXeroConnected.mockResolvedValue(false);

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(201);
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });

  it("maps RetroactiveCardPaymentError to a 400 with code RETROACTIVE_CARD_NOT_ALLOWED (#1709)", async () => {
    h.createConfirmedBooking.mockRejectedValue(new RetroactiveCardPaymentError());

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RETROACTIVE_CARD_NOT_ALLOWED");
    expect(body.error).toContain("can't be paid by card");
  });

  it("maps OverCapacityConfirmationRequiredError to a 409 with code + nightDetails", async () => {
    const nightDetails = [{ date: "2026-07-01", availableBeds: -2 }];
    h.createConfirmedBooking.mockRejectedValue(
      new OverCapacityConfirmationRequiredError(nightDetails),
    );

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("OVER_CAPACITY_CONFIRM_REQUIRED");
    expect(body.nightDetails).toEqual(nightDetails);
  });

  it("threads notifyMember on a plain (future-dated) on-behalf create without allowPastDates", async () => {
    const res = await POST(
      makeRequest(futurePayload({ notifyMember: false })),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    expect(h.createConfirmedBooking.mock.calls[0][0]).toMatchObject({
      allowPastDates: false,
      notifyMember: false,
    });
  });

  it("rejects allowPastDates with a today-or-future check-in (400) — the flag is strictly retroactive", async () => {
    const res = await POST(
      makeRequest(futurePayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("requires a check-in in the past");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("runs the lock-date guard on the RESOLVED envelope: a guest night before the lock is a 409 even when the requested check-in clears it", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    h.getXeroLockDates.mockResolvedValue({});
    // Lock at -15: the requested check-in (-10) clears it, but a guest night
    // expands the envelope back to -20 (#713), which must trip the guard.
    h.getEffectiveXeroLockDate.mockReturnValue(
      addDaysDateOnly(getTodayDateOnly(), -15),
    );

    const res = await POST(
      makeRequest(
        pastPayload({
          allowPastDates: true,
          guests: [{ ...guests[0], nights: [daysFromTodayStr(-20)] }],
        }),
      ),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("XERO_PERIOD_LOCKED");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("runs the 365-day lookback on the RESOLVED envelope: a guest night 370 days back is a 400", async () => {
    const res = await POST(
      makeRequest(
        pastPayload({
          allowPastDates: true,
          guests: [{ ...guests[0], nights: [daysFromTodayStr(-370)] }],
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("at most 365 days");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("threads notifyMember into the waitlist fallback so the choice covers the waitlist confirmation email too", async () => {
    h.createConfirmedBooking.mockResolvedValue({
      type: "capacityExceeded",
      fullNights: [daysFromTodayStr(31)],
    });
    h.createWaitlistedBooking.mockResolvedValue({
      booking: { id: "wl-1", status: "WAITLISTED" },
    });

    const res = await POST(
      makeRequest(
        futurePayload({ waitlist: true, notifyMember: false }),
      ),
    );

    expect(res.status).toBe(201);
    expect(h.createWaitlistedBooking).toHaveBeenCalledTimes(1);
    expect(h.createWaitlistedBooking.mock.calls[0][0]).toMatchObject({
      notifyMember: false,
    });
  });
});
