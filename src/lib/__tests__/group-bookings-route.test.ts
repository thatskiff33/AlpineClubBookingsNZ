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

// The route imports the service; mock it so these are pure wiring tests.
vi.mock("@/lib/group-booking", async () => {
  const actual = await vi.importActual<typeof import("@/lib/group-booking")>(
    "@/lib/group-booking"
  );
  return {
    ...actual,
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

// Internet Banking module gate (join route). Partial-mock so the module's other
// exports (used transitively by admin-modules etc.) stay intact.
vi.mock("@/lib/module-settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/module-settings")>(
    "@/lib/module-settings"
  );
  return { ...actual, loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags };
});

import { POST } from "@/app/api/group-bookings/route";
import { GET, PATCH } from "@/app/api/group-bookings/[code]/route";
import { POST as joinPOST } from "@/app/api/group-bookings/[code]/join/route";
import { POST as joinRequestPOST } from "@/app/api/group-bookings/[code]/join-request/route";
import { POST as verifyPOST } from "@/app/api/group-bookings/join/verify/[token]/route";
import { POST as settlePOST } from "@/app/api/group-bookings/[code]/settle/route";
import { GroupBookingError } from "@/lib/group-booking";

/** A correctly-formatted (64 hex char) action token. */
const VALID_TOKEN = "a".repeat(64);

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
  mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
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

  it("returns the public-safe summary for a known code", async () => {
    mocks.resolveGroupBookingByCode.mockResolvedValueOnce({
      code: "ABCD2345",
      status: GroupBookingStatus.OPEN,
      paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      organiserFirstName: "Andy",
      checkIn: new Date("2026-07-01T00:00:00Z"),
      checkOut: new Date("2026-07-03T00:00:00Z"),
      joinDeadline: null,
      isJoinable: true,
    });
    const res = await GET(
      new NextRequest("http://localhost/api/group-bookings/ABCD2345"),
      { params: Promise.resolve({ code: "ABCD2345" }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "ABCD2345",
      organiserFirstName: "Andy",
      isJoinable: true,
    });
    // No internal ids leaked.
    expect(body).not.toHaveProperty("organiserMemberId");
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
      "MEMBER"
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
      "MEMBER"
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
