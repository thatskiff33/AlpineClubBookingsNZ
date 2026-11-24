/**
 * ALP-794 (`INV-MCP-006`): the requests an AI app connection may send a
 * booking officer, each held to the contract it exposes
 * (`expectActionContract`): a change to a stay already under way, and a
 * booking or edit outside the club's rules.
 *
 * The signed-in member is also a Full Admin (`officerMemberSession`). A
 * connection must still act as the member only: it may not ask on another
 * member's booking, and may not raise an officer's promo correction (#4533).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  checkRateLimit: vi.fn(),
  logAudit: vi.fn(),
  createNewBookingRequest: vi.fn(),
  createModificationRequest: vi.fn(),
  prisma: {
    lodge: { findFirst: vi.fn(async () => ({ id: "lodge-a" })) },
    // #1982: default lodge capacity is a self-healed DB override.
    lodgeSettings: { findUnique: vi.fn(async () => ({ capacity: 100 })) },
    booking: { findUnique: vi.fn() },
    bookingChangeRequest: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: h.checkRateLimit,
  getClientIp: vi.fn(() => "127.0.0.1"),
  rateLimiters: { bookingChangeRequest: { id: "booking-change-request", limit: 5, windowSeconds: 86_400 } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/email", () => ({ sendAdminBookingChangeRequestAlert: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/lodges", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodges")),
  getDefaultLodgeId: vi.fn(async () => "lodge-a"),
  resolveOptionalActiveLodgeId: vi.fn(async () => "lodge-a"),
}));
vi.mock("@/lib/booking-exception-request-service", () => ({
  createNewBookingExceptionRequest: h.createNewBookingRequest,
  createModificationExceptionRequest: h.createModificationRequest,
  buildModificationProposalParties: vi.fn(() => ({ base: [], proposed: [] })),
  readMemberExceptionRequests: vi.fn(),
}));

import { POST as requestChange } from "@/app/api/bookings/[id]/change-requests/route";
import { POST as requestChangeException } from "@/app/api/bookings/[id]/exception-requests/route";
import { POST as requestBookingException } from "@/app/api/bookings/exception-requests/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import { findMcpAction } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

/**
 * The owner's decision on #5305 (item 2): an action that notifies anyone but
 * the member is `destructive`, so the app confirms with the member first and
 * the call is logged as important. Each request here emails the officers.
 */
function expectOfficersAlertedSoDestructive(actionId: string): void {
  // `expectActionContract` calls the route as the connection, then as the
  // browser, and each call sends one alert: two proves the connection's own
  // call alerted the officers, not just the browser's.
  expect(sendAdminBookingChangeRequestAlert).toHaveBeenCalledTimes(2);
  expect(findMcpAction(actionId)?.kind).toBe("destructive");
}

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      allKeys(inner, keys);
    }
  }
  return keys;
}

/** One POST as a connection and as the officer's browser. */
async function statusesFor(
  handler: (request: never, context: never) => Promise<Response>,
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<{ connection: number; browser: number }> {
  const { NextRequest } = await import("next/server");
  const call = handler as unknown as (r: Request, c: unknown) => Promise<Response>;
  const run = async (viaConnection: boolean) => {
    const request = new NextRequest(new URL(path, "https://club.example.test"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(viaConnection ? { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" } : {}),
      },
      body: JSON.stringify(body),
    });
    return (await call(request, { params: Promise.resolve(params) })).status;
  };
  return { connection: await run(true), browser: await run(false) };
}

const PROPOSAL = {
  lodgeId: "lodge-a",
  checkIn: "2026-08-01",
  checkOut: "2026-08-02",
  guests: [{ firstName: "Olive", lastName: "Officer", ageTier: "ADULT", isMember: true, nights: ["2026-08-01"] }],
  guestNights: 1,
  baseCheckIn: null,
  baseCheckOut: null,
  baseGuestNights: null,
};

const CREATED = {
  id: "exc-1",
  status: "REQUESTED",
  proposalHash: "sha256:abc",
  reasonCodes: ["MINIMUM_STAY"],
  aggregateCapacityMode: "NO_HOLD",
  proposal: PROPOSAL,
  capacityHeld: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.checkRateLimit.mockResolvedValue({ success: true, limit: 5, remaining: 4, resetAt: Date.now() + 1000 });
});

describe("request_booking_change", () => {
  // A stay under way on the day the test runs, as `booking-change-requests.test.ts` sets it.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function stayUnderWay(memberId: string) {
    return {
      id: "booking-1",
      memberId,
      status: "COMPLETED",
      lodgeId: "lodge-a",
      checkIn: new Date("2026-05-23T00:00:00.000Z"),
      checkOut: new Date("2026-05-27T00:00:00.000Z"),
      guests: [
        {
          id: "guest-1",
          firstName: "Olive",
          lastName: "Officer",
          ageTier: "ADULT",
          isMember: true,
          memberId,
          stayStart: new Date("2026-05-23T00:00:00.000Z"),
          stayEnd: new Date("2026-05-27T00:00:00.000Z"),
          nights: [],
        },
      ],
      member: { id: memberId, firstName: "Olive", lastName: "Officer", email: "olive@example.org" },
      organisation: null,
      payment: {
        id: "payment-1",
        amountCents: 12000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        stripePaymentIntentId: "pi_123",
        xeroInvoiceId: "xero-inv-1",
        xeroInvoiceNumber: "INV-001",
      },
    };
  }

  const ROW = {
    id: "request-1",
    bookingId: "booking-1",
    requestedByMemberId: "officer-1",
    status: "REQUESTED",
    kind: "LOCKED_PERIOD",
    requestedChanges: {
      original: { checkOut: "2026-05-27" },
      requested: { checkOut: "2026-05-24", summary: "check-out to 2026-05-24", requestedEffectiveDate: null },
      payment: { id: "payment-1", stripePaymentIntentId: "pi_123", xeroInvoiceId: "xero-inv-1" },
    },
    reason: "Weather closed the road.",
    adminNotes: null,
    memberMessage: null,
    reviewedAt: null,
    cancelledAt: null,
    holdExpiresAt: null,
    proposalHash: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
  };

  it("files the member's request and answers without the payment snapshot", async () => {
    h.prisma.booking.findUnique.mockResolvedValue(stayUnderWay("officer-1"));
    h.prisma.bookingChangeRequest.findFirst.mockResolvedValue(null);
    h.prisma.bookingChangeRequest.create.mockResolvedValue(ROW);
    const { connection, browser } = await expectActionContract({
      actionId: "request_booking_change",
      handler: requestChange,
      args: { id: "booking-1", checkOut: "2026-05-24", reason: "Weather closed the road." },
    });
    expect(connection).toMatchObject({
      id: "request-1",
      requestedChanges: { requested: { summary: "check-out to 2026-05-24" } },
    });
    expect(allKeys(browser).has("stripePaymentIntentId")).toBe(true);
    expect(allKeys(connection).has("stripePaymentIntentId")).toBe(false);
    expect(allKeys(connection).has("requestedByMemberId")).toBe(false);
    expectOfficersAlertedSoDestructive("request_booking_change");
  });

  it("refuses the connection another member's booking, which the officer's browser may ask on", async () => {
    h.prisma.booking.findUnique.mockResolvedValue(stayUnderWay("someone-else"));
    h.prisma.bookingChangeRequest.findFirst.mockResolvedValue(null);
    h.prisma.bookingChangeRequest.create.mockResolvedValue(ROW);
    expect(
      await statusesFor(requestChange, "/api/bookings/booking-1/change-requests", { id: "booking-1" }, {
        checkOut: "2026-05-24",
        reason: "Weather closed the road.",
      }),
    ).toEqual({ connection: 403, browser: 201 });
  });

  it("refuses a connection's promo correction, an officer's alone (#4533)", async () => {
    h.prisma.booking.findUnique.mockResolvedValue(stayUnderWay("officer-1"));
    const { NextRequest } = await import("next/server");
    const response = await requestChange(
      new NextRequest("https://club.example.test/api/bookings/booking-1/change-requests", {
        method: "POST",
        headers: { "content-type": "application/json", [MCP_PRINCIPAL_HEADER]: "contract-test-principal" },
        body: JSON.stringify({ promoChange: { promoCode: "WINTER10" } }),
      }),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
    expect(response.status).toBe(403);
    expect(h.prisma.bookingChangeRequest.create).not.toHaveBeenCalled();
  });
});

describe("request_booking_exception", () => {
  it("files the member's own request and answers without the proposal hash", async () => {
    h.createNewBookingRequest.mockResolvedValue(CREATED);
    const { connection, browser } = await expectActionContract({
      actionId: "request_booking_exception",
      handler: requestBookingException,
      args: {
        lodgeId: "lodge-a",
        checkIn: "2026-08-01",
        checkOut: "2026-08-02",
        guests: [{ firstName: "Olive", lastName: "Officer", ageTier: "ADULT", isMember: true, memberId: "officer-1" }],
        memberMessage: "Only free that night",
      },
    });
    expect(connection).toMatchObject({ id: "exc-1", proposal: PROPOSAL });
    expect(browser).toMatchObject({ proposalHash: "sha256:abc" });
    expect(connection).not.toHaveProperty("proposalHash");
    expect(h.createNewBookingRequest.mock.calls[0]?.[0]).toMatchObject({ requestedByMemberId: "officer-1" });
    expectOfficersAlertedSoDestructive("request_booking_exception");
  });
});

describe("request_booking_change_exception", () => {
  function liveBooking(memberId: string) {
    return {
      id: "booking-1",
      memberId,
      status: "CONFIRMED",
      lodgeId: "lodge-a",
      adminCapacityHoldAt: null,
      originBookingRequest: null,
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      guests: [],
      member: { id: memberId, firstName: "Olive", lastName: "Officer", email: "olive@example.org" },
      organisation: null,
    };
  }

  it("files the member's own request on their booking", async () => {
    h.prisma.booking.findUnique.mockResolvedValue(liveBooking("officer-1"));
    h.createModificationRequest.mockResolvedValue(CREATED);
    const { connection } = await expectActionContract({
      actionId: "request_booking_change_exception",
      handler: requestChangeException,
      args: { id: "booking-1", checkOut: "2026-08-02", memberMessage: "Leaving a night early" },
    });
    expect(connection).not.toHaveProperty("proposalHash");
    expect(h.createModificationRequest.mock.calls[0]?.[0]).toMatchObject({
      requestedByMemberId: "officer-1",
      bookingOwnerMemberId: "officer-1",
    });
    expectOfficersAlertedSoDestructive("request_booking_change_exception");
  });

  it("refuses the connection another member's booking, which the officer's browser may ask on", async () => {
    h.prisma.booking.findUnique.mockResolvedValue(liveBooking("someone-else"));
    h.createModificationRequest.mockResolvedValue(CREATED);
    expect(
      await statusesFor(requestChangeException, "/api/bookings/booking-1/exception-requests", { id: "booking-1" }, {
        checkOut: "2026-08-02",
        memberMessage: "Leaving a night early",
      }),
    ).toEqual({ connection: 403, browser: 201 });
  });
});
