import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GroupBookingPaymentMode, GroupBookingStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  applyRateLimit: vi.fn().mockReturnValue(null),
  createGroupBooking: vi.fn(),
  resolveGroupBookingByCode: vi.fn(),
  closeGroupBooking: vi.fn(),
  reopenGroupBooking: vi.fn(),
  joinGroupBookingAsMember: vi.fn(),
  createNonMemberJoinRequest: vi.fn(),
  verifyAndCreateNonMemberJoin: vi.fn(),
  createGroupSettlementIntent: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  GroupBookingError: class GroupBookingError extends Error {
    status: number;
    code?: string;
    details?: unknown;
    violations?: unknown[];
    exceptionReview?: unknown;

    constructor(
      message: string,
      status = 400,
      options?: {
        code?: string;
        details?: unknown;
        violations?: unknown[];
        exceptionReview?: unknown;
      },
    ) {
      super(message);
      this.name = "GroupBookingError";
      this.status = status;
      this.code = options?.code;
      this.details = options?.details;
      this.violations = options?.violations;
      this.exceptionReview = options?.exceptionReview;
    }
  },
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  rateLimiters: {
    groupBookingCreate: {},
    groupBookingLookup: {},
    groupBookingJoin: {},
    groupBookingJoinRequest: {},
    groupBookingToken: {},
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/member-guest-probe-guard", () => ({
  handleMemberGuestAddRefusal: vi.fn().mockResolvedValue(undefined),
  startMemberGuestRefusalClock: vi.fn().mockReturnValue(0),
}));
vi.mock("@/lib/booking-create", () => ({
  BookingPromoError: class BookingPromoError extends Error {},
  BookingReviewJustificationRequiredError:
    class BookingReviewJustificationRequiredError extends Error {},
}));
vi.mock("@/lib/booking-guests", () => ({
  BookingGuestValidationError: class BookingGuestValidationError extends Error {},
  getBookingGuestValidationErrorResponse: (error: Error) => ({
    error: error.message,
  }),
}));
vi.mock("@/lib/membership-type-policy", () => ({
  MembershipTypeBookingPolicyError:
    class MembershipTypeBookingPolicyError extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (error: Error) => ({
    error: error.message,
  }),
}));

// The route imports the service; mock it so these are pure wiring tests.
vi.mock("@/lib/group-booking", () => {
  return {
    GroupBookingError: mocks.GroupBookingError,
    createGroupBooking: mocks.createGroupBooking,
    resolveGroupBookingByCode: mocks.resolveGroupBookingByCode,
    closeGroupBooking: mocks.closeGroupBooking,
    reopenGroupBooking: mocks.reopenGroupBooking,
    joinGroupBookingAsMember: mocks.joinGroupBookingAsMember,
    createNonMemberJoinRequest: mocks.createNonMemberJoinRequest,
    verifyAndCreateNonMemberJoin: mocks.verifyAndCreateNonMemberJoin,
  };
});

// The settle route imports its own service module.
vi.mock("@/lib/group-settlement", () => ({
  createGroupSettlementIntent: mocks.createGroupSettlementIntent,
}));

// Internet Banking module gate (join route).
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

import { POST } from "@/app/api/group-bookings/route";
import { GET, PATCH } from "@/app/api/group-bookings/[code]/route";
import { POST as joinPOST } from "@/app/api/group-bookings/[code]/join/route";
import { POST as joinRequestPOST } from "@/app/api/group-bookings/[code]/join-request/route";
import { POST as verifyPOST } from "@/app/api/group-bookings/join/verify/[token]/route";
import { POST as settlePOST } from "@/app/api/group-bookings/[code]/settle/route";
import { GroupBookingError } from "@/lib/group-booking";
// The REAL constant, from the unmocked leaf module that owns it — so this suite
// fails if the sentence the public routes answer with ever changes shape.
import { PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE } from "@/lib/policies/minimum-stay";
import type { MinimumStayPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";

/** A correctly-formatted (64 hex char) action token. */
const VALID_TOKEN = "a".repeat(64);

/**
 * A REALISTIC `formatViolationsDetail` output — byte-for-byte the shape
 * `getMinimumStayViolations` builds. The earlier version of the minimum-stay
 * route test stubbed a short stylised string ("Lodge B weekends: minimum 2
 * nights"), which is why it passed while the verification route was in fact
 * returning the rule's name, its required nights and its trigger weekday to an
 * unauthenticated caller. Assertions below use this, so nothing about the
 * detailed sentence can slip through unnoticed again.
 */
const DETAILED_MINIMUM_STAY_SENTENCE =
  "Bookings including a Saturday night require a minimum stay of 3 nights " +
  "(Lodge B weekends). Your booking is 2 nights.";

function verifyRequest() {
  return new NextRequest("http://localhost/api/group-bookings/join/verify/x", {
    method: "POST",
  });
}

function callVerify(token: string) {
  return verifyPOST(verifyRequest(), { params: Promise.resolve({ token }) });
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/group-bookings", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyRateLimit.mockReturnValue(null);
  mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: true,
    internetBankingPayments: true,
  });
});

describe("POST /api/group-bookings", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const res = await POST(
      postRequest({
        organiserBookingId: "booking-1",
        paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      })
    );
    expect(res.status).toBe(401);
    expect(mocks.createGroupBooking).not.toHaveBeenCalled();
  });

  it("rejects an invalid payment mode with 422", async () => {
    const res = await POST(
      postRequest({ organiserBookingId: "booking-1", paymentMode: "NOPE" })
    );
    expect(res.status).toBe(422);
    expect(mocks.createGroupBooking).not.toHaveBeenCalled();
  });

  it("creates a group and returns the join code", async () => {
    mocks.createGroupBooking.mockResolvedValueOnce({
      id: "group-1",
      joinCode: "ABCD2345",
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      status: GroupBookingStatus.OPEN,
      joinDeadline: null,
      maxJoiners: null,
    });
    const res = await POST(
      postRequest({
        organiserBookingId: "booking-1",
        paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      })
    );
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      id: "group-1",
      joinCode: "ABCD2345",
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
    });
    expect(mocks.createGroupBooking).toHaveBeenCalledWith(
      expect.objectContaining({ organiserBookingId: "booking-1" }),
      "member-1"
    );
  });

  it("maps a GroupBookingError to its status code", async () => {
    mocks.createGroupBooking.mockRejectedValueOnce(
      new GroupBookingError("This booking already has a group", 409)
    );
    const res = await POST(
      postRequest({
        organiserBookingId: "booking-1",
        paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      })
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "This booking already has a group",
    });
  });
});

describe("GET /api/group-bookings/[code]", () => {
  it("returns 404 for an unknown code", async () => {
    mocks.resolveGroupBookingByCode.mockResolvedValueOnce(null);
    const res = await GET(
      new NextRequest("http://localhost/api/group-bookings/ZZZZ9999"),
      { params: Promise.resolve({ code: "ZZZZ9999" }) }
    );
    expect(res.status).toBe(404);
  });

  const base = {
    code: "ABCD2345",
    status: GroupBookingStatus.OPEN,
    organiserFirstName: "Andy",
    lodgeName: "West Ridge Hut",
    checkIn: new Date("2026-07-01T00:00:00Z"),
    checkOut: new Date("2026-07-03T00:00:00Z"),
    joinDeadline: null,
    isJoinable: true,
  };

  // #3672 review (SSOT F1): the route dropped `joinerPaymentMode`, so the join
  // page called an unpaid organiser-pays group paid and hid Internet Banking
  // from every each-pays joiner. The whole body is pinned for each state, so a
  // dropped or leaked field fails here.
  it.each([
    ["each pays their own", GroupBookingPaymentMode.EACH_PAYS_OWN, GroupBookingPaymentMode.EACH_PAYS_OWN],
    ["organiser pays, not yet paid", GroupBookingPaymentMode.ORGANISER_PAYS, GroupBookingPaymentMode.ORGANISER_PAYS],
    ["organiser pays, already paid", GroupBookingPaymentMode.ORGANISER_PAYS, GroupBookingPaymentMode.EACH_PAYS_OWN],
  ])("returns the public-safe summary, with how a joiner pays, for a group where %s", async (_label, paymentMode, joinerPaymentMode) => {
    mocks.resolveGroupBookingByCode.mockResolvedValueOnce({
      ...base,
      paymentMode,
      joinerPaymentMode,
    });
    const res = await GET(
      new NextRequest("http://localhost/api/group-bookings/ABCD2345"),
      { params: Promise.resolve({ code: "ABCD2345" }) }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      code: "ABCD2345",
      status: GroupBookingStatus.OPEN,
      paymentMode,
      joinerPaymentMode,
      organiserFirstName: "Andy",
      lodgeName: "West Ridge Hut",
      checkIn: "2026-07-01T00:00:00.000Z",
      checkOut: "2026-07-03T00:00:00.000Z",
      joinDeadline: null,
      isJoinable: true,
    });
  });
});

describe("PATCH /api/group-bookings/[code]", () => {
  function patchRequest(body: unknown) {
    return new NextRequest("http://localhost/api/group-bookings/ABCD2345", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("closes a group for its owner", async () => {
    mocks.closeGroupBooking.mockResolvedValueOnce({
      status: GroupBookingStatus.CLOSED,
    });
    const res = await PATCH(patchRequest({ action: "close" }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: GroupBookingStatus.CLOSED,
    });
    expect(mocks.closeGroupBooking).toHaveBeenCalledWith("ABCD2345", "member-1");
  });

  it("returns 403 when a non-owner tries to manage", async () => {
    mocks.reopenGroupBooking.mockRejectedValueOnce(
      new GroupBookingError("This is not your group booking", 403)
    );
    const res = await PATCH(patchRequest({ action: "reopen" }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid action with 422", async () => {
    const res = await PATCH(patchRequest({ action: "delete" }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(422);
    expect(mocks.closeGroupBooking).not.toHaveBeenCalled();
    expect(mocks.reopenGroupBooking).not.toHaveBeenCalled();
  });
});

describe("POST /api/group-bookings/[code]/join", () => {
  function joinRequest(body: unknown) {
    return new NextRequest("http://localhost/api/group-bookings/ABCD2345/join", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }
  const validBody = {
    guests: [
      { firstName: "Jo", lastName: "Member", ageTier: "ADULT", isMember: true },
    ],
  };

  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(401);
    expect(mocks.joinGroupBookingAsMember).not.toHaveBeenCalled();
  });

  it("rejects an empty guest list with 422", async () => {
    const res = await joinPOST(joinRequest({ guests: [] }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(422);
    expect(mocks.joinGroupBookingAsMember).not.toHaveBeenCalled();
  });

  it("joins and returns the created booking", async () => {
    mocks.joinGroupBookingAsMember.mockResolvedValueOnce({
      bookingId: "booking-9",
      status: "PAYMENT_PENDING",
      isZeroDollarConfirmed: false,
      finalPriceCents: 4500,
      requiresPayment: true,
      organiserSettled: false,
    });
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      bookingId: "booking-9",
      requiresPayment: true,
    });
    expect(mocks.joinGroupBookingAsMember).toHaveBeenCalledWith(
      { code: "ABCD2345", guests: validBody.guests, paymentMethod: "stripe" },
      "member-1",
      "USER"
    );
  });

  it("forwards an internet_banking choice when the module is on", async () => {
    mocks.joinGroupBookingAsMember.mockResolvedValueOnce({
      bookingId: "booking-ib",
      status: "PAYMENT_PENDING",
      isZeroDollarConfirmed: false,
      finalPriceCents: 4500,
      requiresPayment: true,
      organiserSettled: false,
    });
    const res = await joinPOST(
      joinRequest({ ...validBody, paymentMethod: "internet_banking" }),
      { params: Promise.resolve({ code: "ABCD2345" }) }
    );
    expect(res.status).toBe(201);
    expect(mocks.joinGroupBookingAsMember).toHaveBeenCalledWith(
      { code: "ABCD2345", guests: validBody.guests, paymentMethod: "internet_banking" },
      "member-1",
      "USER"
    );
  });

  it("rejects internet_banking with 400 when the module is off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValueOnce({
      xeroIntegration: false,
      internetBankingPayments: false,
    });
    const res = await joinPOST(
      joinRequest({ ...validBody, paymentMethod: "internet_banking" }),
      { params: Promise.resolve({ code: "ABCD2345" }) }
    );
    expect(res.status).toBe(400);
    expect(mocks.joinGroupBookingAsMember).not.toHaveBeenCalled();
  });

  it("maps a capacity-exceeded error to 409 with its code and details", async () => {
    mocks.joinGroupBookingAsMember.mockRejectedValueOnce(
      new GroupBookingError("The lodge is full for these dates", 409, {
        code: "CAPACITY_EXCEEDED",
        details: { fullNights: ["2026-07-01"] },
      })
    );
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "CAPACITY_EXCEEDED",
      details: { fullNights: ["2026-07-01"] },
    });
  });

  it("preserves the frozen minimum-stay review while keeping the join blocked", async () => {
    const violation: MinimumStayPolicyExceptionViolation = {
      reasonCode: "MINIMUM_STAY",
      policyId: "policy-lodge-b",
      policyVersion: 5,
      policyName: "Lodge B weekends",
      resolvedScope: {
        kind: "LODGE",
        lodgeId: "lodge-b",
        effectiveLodgeId: "lodge-b",
      },
      affectedNights: ["2026-07-03"],
      exceptionEligible: true,
      capacityMode: "HOLD",
      message: "Lodge B requires two nights.",
      triggerDay: "Friday",
      minimumNights: 2,
      actualNights: 1,
      requirements: {
        kind: "MINIMUM_STAY",
        minimumNights: 2,
        actualNights: 1,
        triggerDays: [5],
      },
    };
    mocks.joinGroupBookingAsMember.mockRejectedValueOnce(
      new GroupBookingError(
        "Booking does not meet the minimum stay requirement",
        400,
        {
          code: "MINIMUM_STAY_VIOLATION",
          details: "Lodge B weekends: minimum 2 nights",
          violations: [violation],
          exceptionReview: { violations: [violation], capacityMode: "HOLD" },
        },
      ),
    );

    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Booking does not meet the minimum stay requirement",
      code: "MINIMUM_STAY_VIOLATION",
      details: "Lodge B weekends: minimum 2 nights",
      violations: [violation],
      exceptionReview: { violations: [violation], capacityMode: "HOLD" },
    });
  });

  it("maps an ended-stay refusal to 409 (#1723 path 3)", async () => {
    mocks.joinGroupBookingAsMember.mockRejectedValueOnce(
      new GroupBookingError("This group's stay has ended", 409)
    );
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "This group's stay has ended",
    });
  });

  it("joins an organiser-pays group with the joiner billed nothing", async () => {
    mocks.joinGroupBookingAsMember.mockResolvedValueOnce({
      bookingId: "booking-10",
      status: "PAYMENT_PENDING",
      isZeroDollarConfirmed: false,
      finalPriceCents: 4500,
      requiresPayment: false,
      organiserSettled: true,
    });
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      bookingId: "booking-10",
      requiresPayment: false,
      organiserSettled: true,
    });
  });
});

describe("POST /api/group-bookings/[code]/join-request (non-member)", () => {
  function reqBody(overrides: Record<string, unknown> = {}) {
    return new NextRequest(
      "http://localhost/api/group-bookings/ABCD2345/join-request",
      {
        method: "POST",
        body: JSON.stringify({
          contactFirstName: "Sam",
          contactLastName: "Guest",
          contactEmail: "sam@example.com",
          guests: [
            { firstName: "Sam", lastName: "Guest", ageTier: "ADULT" },
          ],
          ...overrides,
        }),
        headers: { "content-type": "application/json" },
      }
    );
  }

  it("rejects a missing email with 422", async () => {
    const res = await joinRequestPOST(reqBody({ contactEmail: undefined }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(422);
    expect(mocks.createNonMemberJoinRequest).not.toHaveBeenCalled();
  });

  it("stages the request and returns a neutral success", async () => {
    mocks.createNonMemberJoinRequest.mockResolvedValueOnce({ id: "join-1" });
    const res = await joinRequestPOST(reqBody(), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(mocks.createNonMemberJoinRequest).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ABCD2345", contactEmail: "sam@example.com" })
    );
  });

  it("keeps existing member emails neutral so the public route cannot enumerate accounts", async () => {
    mocks.createNonMemberJoinRequest.mockRejectedValueOnce(
      new GroupBookingError(
        "This email belongs to a member account. Please log in and join from your account.",
        409,
        { code: "USE_MEMBER_LOGIN" }
      )
    );
    const res = await joinRequestPOST(reqBody(), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ success: true });
  });

  it("keeps unknown group codes neutral on the mutation endpoint", async () => {
    mocks.createNonMemberJoinRequest.mockRejectedValueOnce(
      new GroupBookingError("Group booking not found", 404, {
        code: "GROUP_NOT_FOUND",
      })
    );
    const res = await joinRequestPOST(reqBody(), {
      params: Promise.resolve({ code: "ZZZZ9999" }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ success: true });
  });

  it("keeps non-joinable group state neutral on the mutation endpoint", async () => {
    mocks.createNonMemberJoinRequest.mockRejectedValueOnce(
      new GroupBookingError("This group is not accepting joins", 409, {
        code: "GROUP_NOT_JOINABLE",
      })
    );
    const res = await joinRequestPOST(reqBody(), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ success: true });
  });

  it("surfaces an ended stay as 409 GROUP_STAY_ENDED (#1723 path 3)", async () => {
    // Deliberately NOT in the neutral set: the public GET summary already
    // exposes the stay dates and joinability for a valid code, so a plain
    // refusal reveals nothing new — while a neutral fake-success would leave
    // the joiner waiting for a verification email that never comes.
    mocks.createNonMemberJoinRequest.mockRejectedValueOnce(
      new GroupBookingError("This group's stay has ended", 409, {
        code: "GROUP_STAY_ENDED",
      })
    );
    const res = await joinRequestPOST(reqBody(), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "This group's stay has ended",
      code: "GROUP_STAY_ENDED",
    });
  });

  it("surfaces a minimum-stay refusal plainly, without the frozen snapshot (#2363)", async () => {
    // Same reasoning as the ended-stay refusal above: the public GET summary
    // already shows this code's stay dates, so naming the reason discloses
    // nothing new — and a neutral fake-success would leave the joiner waiting
    // for a verification email that is never coming. The frozen review stays
    // server-side: this endpoint is unauthenticated and must not become a way
    // to read the club's policy ids and versions.
    mocks.createNonMemberJoinRequest.mockRejectedValueOnce(
      new GroupBookingError(
        "This group's stay is shorter than the minimum stay required for those nights, so it cannot accept sign-ups. Please contact the organiser.",
        400,
        {
          code: "MINIMUM_STAY_VIOLATION",
          details: "Lodge B weekends: minimum 2 nights",
          violations: [],
          exceptionReview: { violations: [], capacityMode: null },
        }
      )
    );
    const res = await joinRequestPOST(reqBody(), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error:
        "This group's stay is shorter than the minimum stay required for those nights, so it cannot accept sign-ups. Please contact the organiser.",
      code: "MINIMUM_STAY_VIOLATION",
    });
  });
});

describe("POST /api/group-bookings/join/verify/[token] (non-member confirm)", () => {
  it("rejects a malformed token with 404 without calling the service", async () => {
    const res = await callVerify("not-a-valid-token");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ outcome: "invalid" });
    expect(mocks.verifyAndCreateNonMemberJoin).not.toHaveBeenCalled();
  });

  it("returns 201 and the pay token when the booking is created", async () => {
    const checkIn = new Date("2026-07-01T00:00:00Z");
    const checkOut = new Date("2026-07-03T00:00:00Z");
    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({
      outcome: "created",
      bookingId: "booking-9",
      payToken: "pay-token-9",
      priceCents: 9000,
      checkIn,
      checkOut,
      guestCount: 1,
    });
    const res = await callVerify(VALID_TOKEN);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({
      outcome: "created",
      bookingId: "booking-9",
      payToken: "pay-token-9",
      priceCents: 9000,
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: 1,
    });
    expect(mocks.verifyAndCreateNonMemberJoin).toHaveBeenCalledWith(VALID_TOKEN);
  });

  it("returns 200 already_done for a consumed token (idempotent)", async () => {
    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({
      outcome: "already_done",
      bookingId: "booking-9",
    });
    const res = await callVerify(VALID_TOKEN);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      outcome: "already_done",
      bookingId: "booking-9",
    });
  });

  it("maps invalid/expired/not_joinable/capacity outcomes to their status codes", async () => {
    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({ outcome: "invalid" });
    expect((await callVerify(VALID_TOKEN)).status).toBe(404);

    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({ outcome: "expired" });
    expect((await callVerify(VALID_TOKEN)).status).toBe(410);

    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({
      outcome: "not_joinable",
      message: "This group is no longer accepting joins",
    });
    expect((await callVerify(VALID_TOKEN)).status).toBe(409);

    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({
      outcome: "capacity_full",
      fullNights: ["2026-07-01"],
    });
    const capacityRes = await callVerify(VALID_TOKEN);
    expect(capacityRes.status).toBe(409);
    await expect(capacityRes.json()).resolves.toMatchObject({
      outcome: "capacity_full",
      fullNights: ["2026-07-01"],
    });
  });

  it("maps an ended-stay outcome to 409 with its message (#1723 path 3)", async () => {
    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({
      outcome: "not_joinable",
      message: "This group's stay has ended",
    });
    const res = await callVerify(VALID_TOKEN);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      outcome: "not_joinable",
      message: "This group's stay has ended",
    });
  });

  it("maps a minimum_stay outcome to 409 with the generic sentence only (#2363)", async () => {
    // The policy set moved under a staged request, so this is a conflict with
    // the club's current state, exactly like capacity_full. The service carries
    // the frozen review for #2365, but this unauthenticated response must not:
    // only the sentence the joiner reads crosses the wire.
    //
    // The service's `message` is REALISTIC here — the actual generic sentence
    // the service returns — and the assertion below proves the detailed
    // formatter output cannot appear in the serialized body. The earlier
    // version of this test stubbed a short stylised string, which is why it
    // passed while the service was in fact returning the rule's name, required
    // nights and trigger weekdays to an unauthenticated caller.
    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({
      outcome: "minimum_stay",
      message: PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE,
      violations: [
        {
          policyId: "policy-lodge-b",
          policyVersion: 4,
          policyName: "Lodge B weekends",
          message: DETAILED_MINIMUM_STAY_SENTENCE,
          minimumNights: 3,
          actualNights: 2,
          requirements: {
            kind: "MINIMUM_STAY",
            minimumNights: 3,
            actualNights: 2,
            triggerDays: [6],
          },
        },
      ],
      exceptionReview: { violations: [], capacityMode: "HOLD" },
    });
    const res = await callVerify(VALID_TOKEN);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      outcome: "minimum_stay",
      message: PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE,
    });

    const wire = JSON.stringify(body);
    expect(wire).not.toContain(DETAILED_MINIMUM_STAY_SENTENCE);
    expect(wire).not.toContain("Lodge B weekends");
    expect(wire).not.toContain("minimum stay of 3 nights");
    expect(wire).not.toContain("Saturday");
    expect(wire).not.toContain("policy-lodge-b");
  });

  it("answers the SAME sentence at both public stages, so neither can drift (#2363)", async () => {
    // Staging and verification are the same unauthenticated audience; the bug
    // was verification quietly answering with the detailed sentence while
    // staging answered generically.
    mocks.createNonMemberJoinRequest.mockRejectedValueOnce(
      new GroupBookingError(PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE, 400, {
        code: "MINIMUM_STAY_VIOLATION",
        details: DETAILED_MINIMUM_STAY_SENTENCE,
        violations: [],
        exceptionReview: { violations: [], capacityMode: null },
      }),
    );
    const stagingRequest = new NextRequest(
      "http://localhost/api/group-bookings/ABCD2345/join-request",
      {
        method: "POST",
        body: JSON.stringify({
          contactFirstName: "Sam",
          contactLastName: "Guest",
          contactEmail: "sam@example.com",
          guests: [{ firstName: "Sam", lastName: "Guest", ageTier: "ADULT" }],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const staging = await joinRequestPOST(stagingRequest, {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    const stagingBody = await staging.json();

    mocks.verifyAndCreateNonMemberJoin.mockResolvedValueOnce({
      outcome: "minimum_stay",
      message: PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE,
      violations: [],
      exceptionReview: { violations: [], capacityMode: null },
    });
    const verify = await callVerify(VALID_TOKEN);
    const verifyBody = await verify.json();

    expect(stagingBody.error).toBe(PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE);
    expect(verifyBody.message).toBe(stagingBody.error);
    expect(JSON.stringify(stagingBody)).not.toContain(
      DETAILED_MINIMUM_STAY_SENTENCE,
    );
  });

  it("returns 500 if the service throws unexpectedly", async () => {
    mocks.verifyAndCreateNonMemberJoin.mockRejectedValueOnce(new Error("boom"));
    const res = await callVerify(VALID_TOKEN);
    expect(res.status).toBe(500);
  });
});

describe("POST /api/group-bookings/[code]/settle", () => {
  function settleRequest(body?: unknown) {
    return new NextRequest("http://localhost/api/group-bookings/ABCD2345/settle", {
      method: "POST",
      ...(body !== undefined
        ? {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }
        : {}),
    });
  }
  function callSettle(body?: unknown) {
    return settlePOST(settleRequest(body), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
  }

  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const res = await callSettle();
    expect(res.status).toBe(401);
    expect(mocks.createGroupSettlementIntent).not.toHaveBeenCalled();
  });

  it("returns the combined client secret when settlement is ready", async () => {
    mocks.createGroupSettlementIntent.mockResolvedValueOnce({
      outcome: "ready",
      amountCents: 9000,
      childCount: 2,
      clientSecret: "cs_settle_1",
      paymentIntentId: "pi_settle_1",
    });
    const res = await callSettle();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      outcome: "ready",
      amountCents: 9000,
      childCount: 2,
      clientSecret: "cs_settle_1",
    });
    expect(mocks.createGroupSettlementIntent).toHaveBeenCalledWith(
      "ABCD2345",
      "member-1",
      "stripe"
    );
  });

  it("forwards an internet_banking choice and returns the invoice reference", async () => {
    mocks.createGroupSettlementIntent.mockResolvedValueOnce({
      outcome: "invoice_sent",
      amountCents: 9000,
      childCount: 2,
      reference: "GROUP-ABCD1234",
    });
    const res = await callSettle({ paymentMethod: "internet_banking" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      outcome: "invoice_sent",
      reference: "GROUP-ABCD1234",
    });
    expect(mocks.createGroupSettlementIntent).toHaveBeenCalledWith(
      "ABCD2345",
      "member-1",
      "internet_banking"
    );
  });

  it("rejects internet_banking with 400 when the module is off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValueOnce({
      xeroIntegration: false,
      internetBankingPayments: false,
    });
    const res = await callSettle({ paymentMethod: "internet_banking" });
    expect(res.status).toBe(400);
    expect(mocks.createGroupSettlementIntent).not.toHaveBeenCalled();
  });

  it("maps a GroupBookingError to its status (403 for a non-organiser)", async () => {
    mocks.createGroupSettlementIntent.mockRejectedValueOnce(
      new GroupBookingError("This is not your group booking", 403)
    );
    const res = await callSettle();
    expect(res.status).toBe(403);
  });

  it("returns 500 if the service throws unexpectedly", async () => {
    mocks.createGroupSettlementIntent.mockRejectedValueOnce(new Error("boom"));
    const res = await callSettle();
    expect(res.status).toBe(500);
  });
});
