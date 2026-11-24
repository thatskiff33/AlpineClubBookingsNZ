/**
 * ALP-794 (`INV-MCP-006`): the booking reads an AI app connection may run,
 * each held to the contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields;
 * - it acts as the signed-in member only, though that member is also a Full
 *   Admin (`officerMemberSession`), so a booking that is someone else's is
 *   refused to the connection and still shown to the officer's browser;
 * - the browser's answer is unchanged.
 *
 * Each withheld-field assertion names the bug it catches: a field the
 * website's answer carries reaching the AI provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  modules: vi.fn(),
  checkCapacity: vi.fn(),
  getLodgeCapacity: vi.fn(),
  eligible: vi.fn(),
  eligibleLodges: vi.fn(),
  validateMinimumStay: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  promoCodes: vi.fn(),
  exceptionRequests: vi.fn(),
  prisma: {
    lodge: { findUnique: vi.fn() },
    lodgeRoom: { findMany: vi.fn() },
    booking: { findUnique: vi.fn() },
    bookingChangeRequest: { findMany: vi.fn() },
    refundRequest: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
  requireActiveSession: vi.fn(async () => ({ ok: true, session: await h.auth() })),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: h.modules }));
vi.mock("@/lib/capacity", () => ({ checkCapacity: h.checkCapacity, getLodgeCapacity: h.getLodgeCapacity }));
vi.mock("@/lib/lodge-access", () => ({
  isMemberEligibleToBookLodge: h.eligible,
  getEligibleLodgeIdsForMember: h.eligibleLodges,
}));
vi.mock("@/lib/lodges", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodges")),
  getDefaultLodgeId: vi.fn(async () => "lodge-a"),
  resolveOptionalActiveLodgeId: vi.fn(async () => "lodge-a"),
}));
// The real aggregation and wording; only the rule lookup is a fixture.
vi.mock("@/lib/booking-policies", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-policies")),
  validateMinimumStay: h.validateMinimumStay,
}));
vi.mock("@/lib/cancellation", () => ({ loadCancellationPolicy: h.loadCancellationPolicy }));
vi.mock("@/lib/club-format-server", () => ({
  clubFormat: vi.fn(async () => ({ format: { cents: (value: number) => `$${(value / 100).toFixed(2)}` } })),
}));
vi.mock("@/lib/cancellation-schedule", () => ({
  describeCancellationSchedule: vi.fn(() => [{ description: "Full refund up to 14 days before check-in" }]),
}));
vi.mock("@/lib/promo", () => ({ getAvailablePromoCodesForMember: h.promoCodes }));
vi.mock("@/lib/booking-exception-request-service", () => ({ readMemberExceptionRequests: h.exceptionRequests }));

import { GET as checkAvailability } from "@/app/api/availability/check/route";
import { GET as checkRules } from "@/app/api/booking-policies/check/route";
import { GET as listChangeRequests } from "@/app/api/bookings/[id]/change-requests/route";
import { GET as listRefundReviews } from "@/app/api/bookings/[id]/refund-request/route";
import { GET as listRequestableRooms } from "@/app/api/bookings/[id]/requested-room/options/route";
import { GET as listExceptionRequests } from "@/app/api/bookings/exception-requests/route";
import { GET as listRooms } from "@/app/api/bookings/rooms/route";
import { GET as listPromoCodes } from "@/app/api/promo-codes/available/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

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

/** The same GET as a connection and as the officer's browser, for a record that is not the member's. */
async function statusesFor(
  handler: (request: never, context: never) => Promise<Response>,
  path: string,
  params: Record<string, string>,
): Promise<{ connection: number; browser: number }> {
  const call = handler as unknown as (r: Request, c: unknown) => Promise<Response>;
  const run = async (viaConnection: boolean) => {
    const { NextRequest } = await import("next/server");
    const request = new NextRequest(new URL(path, "https://club.example.test"), {
      headers: viaConnection ? { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" } : {},
    });
    return (await call(request, { params: Promise.resolve(params) })).status;
  };
  return { connection: await run(true), browser: await run(false) };
}

const ROOMS = [
  {
    id: "room-1",
    name: "Bunk room",
    sortOrder: 1,
    active: true,
    lodgeId: "lodge-a",
    internalNote: "Leaky window",
    beds: [{ id: "bed-1" }, { id: "bed-2" }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.modules.mockResolvedValue({ bedAllocation: true, promoCodes: true, mcpServer: true });
  h.eligible.mockResolvedValue(true);
  h.eligibleLodges.mockResolvedValue({ allLodges: true, lodgeIds: [] });
  h.prisma.lodgeRoom.findMany.mockResolvedValue(ROOMS);
});

describe("check_stay_availability", () => {
  it("answers with each night's beds, counting the member as the party", async () => {
    h.getLodgeCapacity.mockResolvedValue(20);
    h.checkCapacity.mockResolvedValue({
      minAvailable: 4,
      wholeLodgeHeld: false,
      nightDetails: [{ date: new Date("2026-08-01T00:00:00.000Z"), occupiedBeds: 16, availableBeds: 4 }],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "check_stay_availability",
      handler: checkAvailability,
      args: { checkIn: "2026-08-01", checkOut: "2026-08-02" },
    });
    expect(connection).toEqual(browser);
    expect(connection).toMatchObject({ minAvailable: 4, nightDetails: [{ date: "2026-08-01", availableBeds: 4 }] });
    expect(h.checkCapacity.mock.calls[0]?.[6]).toEqual(["officer-1"]);
  });
});

describe("check_booking_rules", () => {
  it("names each broken rule in words, without the officer's evidence", async () => {
    h.loadCancellationPolicy.mockResolvedValue([]);
    h.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [
        {
          reasonCode: "MINIMUM_STAY",
          policyId: "policy-1",
          policyVersion: 3,
          resolvedScope: { kind: "LODGE", lodgeId: "lodge-a" },
          affectedNights: ["2026-08-01"],
          exceptionEligible: true,
          capacityMode: "NO_HOLD",
          message: "Saturday nights need a two-night stay",
          triggerDay: "2026-08-01",
          minimumNights: 2,
          actualNights: 1,
          requirements: { kind: "MINIMUM_STAY", minimumNights: 2, actualNights: 1, triggerDays: [6] },
        },
      ],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "check_booking_rules",
      handler: checkRules,
      args: { checkIn: "2026-08-01", checkOut: "2026-08-02" },
    });
    expect(connection).toMatchObject({
      valid: false,
      violations: [{ reasonCode: "MINIMUM_STAY", message: "Saturday nights need a two-night stay" }],
      cancellationSchedule: ["Full refund up to 14 days before check-in"],
    });
    // The website keeps the policy identity and the review aggregate.
    expect(allKeys(browser).has("resolvedScope")).toBe(true);
    expect(allKeys(connection).has("resolvedScope")).toBe(false);
    expect(allKeys(connection).has("exceptionReview")).toBe(false);
  });
});

describe("list_lodge_rooms", () => {
  it("answers with the rooms and their bed counts", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "list_lodge_rooms",
      handler: listRooms,
      args: { lodgeId: "lodge-a" },
    });
    expect(connection).toEqual(browser);
    expect(connection).toEqual({ enabled: true, rooms: [{ id: "room-1", name: "Bunk room", bedCount: 2 }] });
  });

  it("always names a lodge: the cross-lodge listing is for callers outside this repository (INV-INT-016)", () => {
    const action = findMcpAction("list_lodge_rooms");
    if (!action) throw new Error("list_lodge_rooms is not in the catalogue");
    expect(mcpActionInputSchema(action).safeParse({}).success).toBe(false);
    expect(mcpActionInputSchema(action).safeParse({ lodgeId: "lodge-a" }).success).toBe(true);
  });
});

describe("list_requestable_rooms", () => {
  it("answers for the member's own booking", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ memberId: "officer-1", lodgeId: "lodge-a", deletedAt: null });
    const { connection, browser } = await expectActionContract({
      actionId: "list_requestable_rooms",
      handler: listRequestableRooms,
      args: { id: "booking-1" },
    });
    expect(connection).toEqual(browser);
  });

  it("refuses the connection another member's booking, which the officer's browser may read", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ memberId: "someone-else", lodgeId: "lodge-a", deletedAt: null });
    expect(
      await statusesFor(listRequestableRooms, "/api/bookings/booking-2/requested-room/options", { id: "booking-2" }),
    ).toEqual({ connection: 403, browser: 200 });
  });
});

describe("list_my_promo_codes", () => {
  it("answers the member's own codes as an object; the website keeps its bare list", async () => {
    const codes = [
      {
        code: "WINTER10",
        description: "Ten percent off",
        type: "PERCENT",
        percentOff: 10,
        valueCents: null,
        freeNightsPerIndividual: null,
        lifetimeFreeNightsCap: null,
        fixedNightlyPriceCents: null,
        fixedNightlyMode: null,
      },
    ];
    h.promoCodes.mockResolvedValue(codes);
    const { connection, browser } = await expectActionContract({
      actionId: "list_my_promo_codes",
      handler: listPromoCodes,
    });
    expect(connection).toEqual({ promoCodes: codes });
    expect(browser).toEqual(codes);
    expect(h.promoCodes).toHaveBeenCalledWith("officer-1");
  });
});

describe("list_booking_change_requests", () => {
  const ROW = {
    id: "cr-1",
    bookingId: "booking-1",
    requestedByMemberId: "officer-1",
    status: "REQUESTED",
    kind: "LOCKED_PERIOD",
    requestedChanges: {
      original: { checkIn: "2026-08-01" },
      requested: { summary: "check-out to 2026-08-04", requestedEffectiveDate: null, addGuests: [] },
      payment: { id: "pay-1", stripePaymentIntentId: "pi_123", xeroInvoiceId: "inv-1" },
    },
    reason: "Staying an extra night",
    adminNotes: null,
    reviewedByMemberId: null,
    reviewedAt: null,
    linkedModificationId: null,
    proposalSnapshot: null,
    proposalHash: "hash",
    frozenEvidence: null,
    aggregateCapacityMode: null,
    memberMessage: null,
    attemptCount: 0,
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    cancelledAt: null,
    holdExpiresAt: null,
    version: 1,
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
    requestedBy: { id: "officer-1", firstName: "Olive", lastName: "Officer", email: "olive@example.org" },
    reviewedBy: null,
  };

  it("answers with what was asked and the decision, never the payment snapshot", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ memberId: "officer-1", deletedAt: null });
    h.prisma.bookingChangeRequest.findMany.mockResolvedValue([ROW]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_booking_change_requests",
      handler: listChangeRequests,
      args: { id: "booking-1" },
    });
    expect(connection).toMatchObject({
      changeRequests: [{ id: "cr-1", requestedChanges: { requested: { summary: "check-out to 2026-08-04" } } }],
    });
    expect(allKeys(browser).has("stripePaymentIntentId")).toBe(true);
    for (const withheld of ["stripePaymentIntentId", "proposalHash", "requestedBy", "requestedByMemberId"]) {
      expect(allKeys(connection).has(withheld), withheld).toBe(false);
    }
  });

  it("refuses the connection another member's booking, which the officer's browser may read", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ memberId: "someone-else", deletedAt: null });
    h.prisma.bookingChangeRequest.findMany.mockResolvedValue([]);
    expect(
      await statusesFor(listChangeRequests, "/api/bookings/booking-2/change-requests", { id: "booking-2" }),
    ).toEqual({ connection: 403, browser: 200 });
  });
});

describe("list_my_exception_requests", () => {
  it("answers the member's own requests as an object; the website keeps its bare list", async () => {
    const item = {
      id: "nb-1",
      source: "NEW_BOOKING",
      status: "UNDER_REVIEW",
      createdAt: "2026-06-30T00:00:00.000Z",
      reviewedAt: null,
      proposal: {
        lodgeId: "lodge-a",
        checkIn: "2026-08-01",
        checkOut: "2026-08-02",
        guests: [{ firstName: "Ana", lastName: "Member", ageTier: "ADULT", isMember: true, nights: ["2026-08-01"] }],
        guestNights: 1,
        baseCheckIn: null,
        baseCheckOut: null,
        baseGuestNights: null,
      },
      rules: [{ reasonCode: "MINIMUM_STAY", message: "Two nights minimum", affectedNights: ["2026-08-01"] }],
      memberMessage: "Only free that night",
      decisionExplanation: null,
      capacityHeld: false,
      capacityMode: "NO_HOLD",
      lastConflictReason: null,
      lastConflictAt: null,
      bookingId: null,
      createdBookingId: null,
      createdBookingHoldsCapacity: null,
      createdBookingAwaitsPayment: null,
      supersededByRequestId: null,
      canWithdraw: true,
      canReplace: true,
    };
    h.exceptionRequests.mockResolvedValue([item]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_my_exception_requests",
      handler: listExceptionRequests,
    });
    expect(connection).toEqual({ exceptionRequests: [item] });
    expect(browser).toEqual([item]);
    expect(h.exceptionRequests).toHaveBeenCalledWith("officer-1");
  });
});

describe("list_my_refund_reviews", () => {
  const REVIEW = {
    id: "rr-1",
    bookingId: "booking-1",
    memberId: "officer-1",
    reason: "Cancelled because of a road closure",
    requestedAmountCents: 5000,
    status: "APPROVED",
    adminNotes: "Refunded in full",
    approvedAmountCents: 5000,
    reviewedBy: "treasurer-1",
    reviewedAt: new Date("2026-06-30T00:00:00.000Z"),
    createdAt: new Date("2026-06-29T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
  };

  it("answers with each review and its outcome, never the officer's or member's ids", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ memberId: "officer-1", deletedAt: null });
    h.prisma.refundRequest.findMany.mockResolvedValue([REVIEW]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_my_refund_reviews",
      handler: listRefundReviews,
      args: { id: "booking-1" },
    });
    expect(connection).toMatchObject({ refundReviews: [{ id: "rr-1", status: "APPROVED", approvedAmountCents: 5000 }] });
    expect(browser).toEqual([JSON.parse(JSON.stringify(REVIEW))]);
    expect(allKeys(connection).has("reviewedBy")).toBe(false);
    expect(allKeys(connection).has("memberId")).toBe(false);
  });

  it("refuses the connection another member's booking, which the officer's browser may read", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ memberId: "someone-else", deletedAt: null });
    h.prisma.refundRequest.findMany.mockResolvedValue([]);
    expect(
      await statusesFor(listRefundReviews, "/api/bookings/booking-2/refund-request", { id: "booking-2" }),
    ).toEqual({ connection: 403, browser: 200 });
  });
});
