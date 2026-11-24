/**
 * ALP-797 (`INV-MCP-006`): the group-booking and whole-lodge actions an AI
 * app connection may run, each held to the contract it exposes
 * (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields;
 * - it acts as the signed-in member only, though that member is also an
 *   officer (`officerMemberSession`): none of these routes has an officer
 *   branch, so each test pins the member id the service was called with;
 * - the browser's answer is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  createMemberWholeLodgeRequest: vi.fn(),
  withdrawMemberWholeLodgeRequest: vi.fn(),
  createGroupBooking: vi.fn(),
  closeGroupBooking: vi.fn(),
  reopenGroupBooking: vi.fn(),
  resolveGroupBookingByCode: vi.fn(),
  prisma: { bookingRequest: { findMany: vi.fn() } },
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: h.user })) }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
  requireActiveSession: vi.fn(async () => ({ ok: true, session: { user: h.user } })),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitedResponse: vi.fn(),
  rateLimiters: {
    bookingQuery: { id: "booking-query" },
    memberWholeLodgeRequest: { id: "member-whole-lodge-request" },
    memberWholeLodgeWithdraw: { id: "member-whole-lodge-withdraw" },
    groupBookingCreate: { id: "group-booking-create" },
    groupBookingLookup: { id: "group-booking-lookup" },
  },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: vi.fn(async () => new Date("2026-07-01T00:00:00.000Z")),
}));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: vi.fn(async () => ({})) }));
vi.mock("@/lib/booking-payment-flow", () => ({ memberWholeLodgeChoosesPaymentMethod: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/booking-request", async () => {
  class BookingRequestError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return {
    BookingRequestError,
    assertRequestedLodgeActive: vi.fn(async (lodgeId: string) => lodgeId),
    createMemberWholeLodgeRequest: h.createMemberWholeLodgeRequest,
    withdrawMemberWholeLodgeRequest: h.withdrawMemberWholeLodgeRequest,
  };
});
vi.mock("@/lib/group-booking", () => {
  class GroupBookingError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return {
    GroupBookingError,
    createGroupBooking: h.createGroupBooking,
    closeGroupBooking: h.closeGroupBooking,
    reopenGroupBooking: h.reopenGroupBooking,
    resolveGroupBookingByCode: h.resolveGroupBookingByCode,
  };
});

import { GET as listWholeLodgeRequests, POST as requestWholeLodge } from "@/app/api/booking-requests/whole-lodge/route";
import { POST as withdrawWholeLodgeRequest } from "@/app/api/booking-requests/whole-lodge/[id]/withdraw/route";
import { POST as openGroupBooking } from "@/app/api/group-bookings/route";
import { GET as getGroupBooking, PATCH as setGroupBookingJoining } from "@/app/api/group-bookings/[code]/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";

const MEMBER_ID = "officer-1";

beforeEach(() => {
  vi.clearAllMocks();
  h.user = officerMemberSession(MEMBER_ID).user as unknown as Record<string, unknown>;
});

describe("list_my_whole_lodge_requests", () => {
  it("answers the member's own requests in the member-visible words, read through the My bookings loader", async () => {
    h.prisma.bookingRequest.findMany.mockResolvedValue([
      {
        id: "request-1",
        // A pipeline status an officer works in: the member sees only "pending".
        status: "QUOTE_SENT",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        createdAt: new Date("2026-06-20T01:00:00.000Z"),
        convertedBookingId: null,
        heldBookingId: null,
        guests: [{}, {}, {}],
        declineReason: "officer-only note",
      },
    ]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_my_whole_lodge_requests",
      handler: listWholeLodgeRequests,
    });
    expect(connection).toEqual({
      requests: [
        {
          id: "request-1",
          checkIn: "2026-08-01",
          checkOut: "2026-08-03",
          headcount: 3,
          status: "pending",
          createdAt: "2026-06-20T01:00:00.000Z",
          bookingId: null,
          canWithdraw: true,
        },
      ],
    });
    expect(browser).toEqual(connection);
    expect(h.prisma.bookingRequest.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { requestedByMemberId: MEMBER_ID, exclusivityRequested: true },
    });
  });
});

describe("request_whole_lodge", () => {
  it("sends the request for the signed-in member and answers with the fixed acknowledgement only", async () => {
    h.createMemberWholeLodgeRequest.mockResolvedValue({ id: "request-new", status: "VERIFIED" });
    const { connection, browser } = await expectActionContract({
      actionId: "request_whole_lodge",
      handler: requestWholeLodge,
      args: {
        checkIn: "2026-08-01",
        checkOut: "2026-08-03",
        headcount: 18,
        groupDescription: "Ski club reunion",
        lodgeId: "lodge-1",
      },
    });
    expect(connection).toEqual({ success: true, message: expect.any(String) });
    // Echoes nothing the member sent, nor the new request's id.
    expect(JSON.stringify(connection)).not.toContain("request-new");
    expect(browser).toEqual(connection);
    expect(h.createMemberWholeLodgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: MEMBER_ID, headcount: 18, lodgeId: "lodge-1" }),
    );
  });
});

describe("withdraw_whole_lodge_request", () => {
  it("withdraws the request as the signed-in member, whose ownership the service's claim checks", async () => {
    h.withdrawMemberWholeLodgeRequest.mockResolvedValue(undefined);
    const { connection, browser } = await expectActionContract({
      actionId: "withdraw_whole_lodge_request",
      handler: withdrawWholeLodgeRequest,
      args: { id: "request-1" },
    });
    expect(connection).toEqual({ success: true, message: expect.any(String) });
    expect(browser).toEqual(connection);
    expect(h.withdrawMemberWholeLodgeRequest).toHaveBeenCalledWith({ requestId: "request-1", memberId: MEMBER_ID });
  });
});

describe("open_group_booking", () => {
  it("opens the group as the signed-in member and answers with the join code, not the group's internal id", async () => {
    h.createGroupBooking.mockResolvedValue({
      id: "group-internal-id",
      organiserBookingId: "booking-1",
      organiserMemberId: MEMBER_ID,
      joinCode: "ABCD2345",
      paymentMode: "EACH_PAYS_OWN",
      status: "OPEN",
      joinDeadline: new Date("2026-07-20T00:00:00.000Z"),
      maxJoiners: 10,
    });
    const { connection, browser } = await expectActionContract({
      actionId: "open_group_booking",
      handler: openGroupBooking,
      args: { organiserBookingId: "booking-1", paymentMode: "EACH_PAYS_OWN", joinDeadline: "2026-07-20", maxJoiners: 10 },
    });
    expect(connection).toEqual({
      joinCode: "ABCD2345",
      paymentMode: "EACH_PAYS_OWN",
      status: "OPEN",
      joinDeadline: "2026-07-20T00:00:00.000Z",
      maxJoiners: 10,
    });
    expect(browser).toEqual({ ...(connection as object), id: "group-internal-id" });
    expect(h.createGroupBooking.mock.calls[0]?.[1]).toBe(MEMBER_ID);
  });
});

describe("get_group_booking", () => {
  it("answers the public join-page summary for a code", async () => {
    h.resolveGroupBookingByCode.mockResolvedValue({
      code: "ABCD2345",
      status: "OPEN",
      paymentMode: "ORGANISER_PAYS",
      joinerPaymentMode: "ORGANISER_PAYS",
      organiserFirstName: "Olive",
      lodgeName: "Main lodge",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      joinDeadline: null,
      isJoinable: true,
    });
    const { connection, browser } = await expectActionContract({
      actionId: "get_group_booking",
      handler: getGroupBooking,
      args: { code: "ABCD2345" },
    });
    expect(connection).toMatchObject({ code: "ABCD2345", organiserFirstName: "Olive", checkIn: "2026-08-01T00:00:00.000Z" });
    expect(browser).toEqual(connection);
  });
});

describe("set_group_booking_joining", () => {
  it.each([
    ["close", "CLOSED"],
    ["reopen", "OPEN"],
  ] as const)("%ss the member's own group and answers with its status", async (action, status) => {
    const service = action === "close" ? h.closeGroupBooking : h.reopenGroupBooking;
    service.mockResolvedValue({ id: "group-internal-id", status });
    const { connection, browser } = await expectActionContract({
      actionId: "set_group_booking_joining",
      handler: setGroupBookingJoining,
      args: { code: "ABCD2345", action },
    });
    expect(connection).toEqual({ status });
    expect(browser).toEqual(connection);
    expect(service).toHaveBeenCalledWith("ABCD2345", MEMBER_ID);
  });
});
