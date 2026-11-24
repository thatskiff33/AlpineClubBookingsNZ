/**
 * ALP-719 (`INV-MCP-006`): the Bookings & Beds review-queue actions an
 * officer's AI app connection may run: occupancy, the change and exception
 * request queues, booking reviews and the waitlist. Each route answers the
 * browser as before; the connection gets exactly the action's `returns`
 * fields (`expectActionContract`). Promo codes are in
 * `mcp-bookings-officer-promo-codes.test.ts`.
 *
 * One answer carries keys the strict helper cannot see at once: an exception
 * request fills `booking` for a change and `lodge` for a new booking, never
 * both. It runs through `runAsConnectionAndBrowser`, which builds the request
 * from the catalogue entry the same way (`buildActionRequest`) and checks the
 * connection got exactly the projection, once per kind, with the dropped
 * fields named.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  readExceptionQueue: vi.fn(),
  memberGuestBoundary: vi.fn(),
  offerEmailDeliveries: vi.fn(),
  waitlistPositions: vi.fn(),
  prisma: {
    lodge: { findUnique: vi.fn() },
    booking: { findMany: vi.fn(), count: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
    bookingChangeRequest: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    newBookingPolicyExceptionRequest: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/club-time/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-time/server")),
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));
vi.mock("@/lib/booking-exception-request-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-exception-request-service")),
  readUnifiedExceptionQueue: h.readExceptionQueue,
}));
vi.mock("@/lib/booking-guests", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-guests")),
  computeMemberGuestBoundary: h.memberGuestBoundary,
}));
vi.mock("@/lib/waitlist-offer-email-visibility", () => ({
  getWaitlistOfferEmailDeliveries: h.offerEmailDeliveries,
}));
vi.mock("@/lib/waitlist-queue", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/waitlist-queue")),
  getDisplayedWaitlistPositions: h.waitlistPositions,
}));

import { GET as getChangeRequest } from "@/app/api/admin/booking-change-requests/[id]/route";
import { GET as listChangeRequests } from "@/app/api/admin/booking-change-requests/route";
import { GET as getExceptionRequest } from "@/app/api/admin/booking-exception-requests/[id]/route";
import { GET as listExceptionRequests } from "@/app/api/admin/booking-exception-requests/route";
import { GET as listBookingReviews } from "@/app/api/admin/booking-reviews/route";
import { GET as getOccupancy } from "@/app/api/admin/occupancy/route";
import { GET as listWaitlist } from "@/app/api/admin/waitlist/route";
import {
  buildActionRequest,
  expectActionContract,
  officerMemberSession,
} from "@/lib/__tests__/helpers/mcp-action-contract";
import { projectForConnection } from "@/lib/connection-projection";
import { findMcpAction, type McpAction } from "@/lib/mcp/catalogue";

const VIEW = { permission: { area: "bookings", level: "view" } };

function day(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

type Handler = (request: never, context: never) => Promise<Response>;

/**
 * Runs an action's route as a connection and as a browser, the request built
 * from the catalogue entry (`buildActionRequest`), and checks the connection
 * got exactly the projection of the browser's answer onto the action's
 * `returns`.
 */
async function runAsConnectionAndBrowser(actionId: string, handler: Handler, args: Record<string, unknown>) {
  const action = findMcpAction(actionId) as McpAction;
  expect(action, `${actionId} is in the catalogue`).toBeDefined();
  const run = async (viaConnection: boolean) => {
    const { request, context } = buildActionRequest(action, args, viaConnection);
    const call = handler as unknown as (r: Request, c: unknown) => Promise<Response>;
    const response = await call(request, context);
    expect(response.status, `${actionId} succeeds`).toBeLessThan(300);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const connection = await run(true);
  const browser = await run(false);
  expect(connection).toEqual(projectForConnection(browser, action.returns));
  return { connection, browser };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
});

describe("get_lodge_occupancy", () => {
  it("answers with each night's guest count and the bookings behind it", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
    // One stay across the whole month, so every night carries a booking.
    h.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        status: "PAID",
        checkIn: day("2026-07-01"),
        checkOut: day("2026-08-01"),
        member: { firstName: "Ana", lastName: "Reid" },
        organisation: null,
        guests: [{ id: "guest-1", stayStart: day("2026-07-01"), stayEnd: day("2026-08-01"), nights: [] }],
      },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "get_lodge_occupancy",
      handler: getOccupancy,
      args: { month: "2026-07", lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith({ permission: { area: "bookings", level: "view" } });
    // Every field of this answer is already the officer's view, so both match.
    expect(connection).toEqual(browser);
    expect(connection).toMatchObject({
      month: "2026-07",
      bookings: [{ id: "booking-1", ownerName: "Ana Reid", guestCount: 1, status: "PAID" }],
    });
  });
});

// ── Locked-period change requests ───────────────────────────────────────────

/** A decided request on a finished stay that adds a guest and carries a promo correction. */
function changeRequestRow() {
  return {
    id: "bcr-1",
    bookingId: "booking-1",
    requestedByMemberId: "member-1",
    status: "APPROVED",
    kind: "LOCKED_PERIOD",
    requestedChanges: {
      original: {
        checkIn: "2026-06-20",
        checkOut: "2026-06-25",
        guests: [{ id: "guest-1", stayStart: "2026-06-20", stayEnd: "2026-06-25", firstName: "Ana", lastName: "Reid" }],
        promoCodes: [],
      },
      requested: {
        summary: "Add my brother for the whole stay",
        checkIn: null,
        checkOut: null,
        addGuests: [
          {
            firstName: "Tom",
            lastName: "Reid",
            ageTier: "ADULT",
            isMember: true,
            memberId: "member-2",
            stayStart: "2026-06-20",
            stayEnd: "2026-06-25",
            nights: null,
          },
        ],
        removeGuests: [],
        guestStayRanges: [],
        promoChange: {
          promoCode: "FAMILY10",
          enteredBy: {
            onMemberBehalf: true,
            officerMemberId: "officer-9",
            enteredAt: "2026-06-26T00:00:00.000Z",
            enteredOn: "request",
          },
        },
      },
    },
    reason: "My brother is joining us.",
    adminNotes: "Added as asked.",
    internalNotes: "Second request this season.",
    reviewedByMemberId: "officer-9",
    reviewedAt: day("2026-06-27"),
    linkedModificationId: "mod-1",
    proposalSnapshot: null,
    proposalHash: null,
    frozenEvidence: null,
    aggregateCapacityMode: null,
    memberMessage: null,
    attemptCount: 1,
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    cancelledAt: null,
    holdExpiresAt: null,
    version: 2,
    openStateKey: null,
    createdAt: day("2026-06-26"),
    updatedAt: day("2026-06-27"),
    requestedBy: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
    reviewedBy: { id: "officer-9", firstName: "Olive", lastName: "Officer" },
    linkedModification: {
      id: "mod-1",
      createdAt: day("2026-06-27"),
      modificationType: "GUEST_ADD",
      priceDiffCents: 12000,
      changeFeeCents: 0,
    },
  };
}

function changeRequestBooking() {
  return {
    id: "booking-1",
    checkIn: day("2026-06-20"),
    checkOut: day("2026-06-25"),
    status: "PAID",
    finalPriceCents: 48000,
    member: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
    organisation: { name: "Reid Family Trust", email: "trust@example.test" },
    payment: {
      id: "pay-1",
      amountCents: 48000,
      refundedAmountCents: 0,
      status: "SUCCEEDED",
      xeroInvoiceId: "xero-inv-1",
      xeroInvoiceNumber: "INV-0042",
    },
  };
}

/** The request's fields a connection is sent, before the queue's own additions. */
const CONNECTION_CHANGE_REQUEST = {
  id: "bcr-1",
  bookingId: "booking-1",
  kind: "LOCKED_PERIOD",
  status: "APPROVED",
  requestedChanges: {
    requested: {
      summary: "Add my brother for the whole stay",
      checkIn: null,
      checkOut: null,
      addGuests: [
        {
          firstName: "Tom",
          lastName: "Reid",
          ageTier: "ADULT",
          isMember: true,
          stayStart: "2026-06-20",
          stayEnd: "2026-06-25",
          nights: null,
        },
      ],
    },
  },
  reason: "My brother is joining us.",
  adminNotes: "Added as asked.",
  internalNotes: "Second request this season.",
  createdAt: "2026-06-26T00:00:00.000Z",
  reviewedAt: "2026-06-27T00:00:00.000Z",
  requestedBy: { firstName: "Ana", lastName: "Reid" },
  reviewedBy: { firstName: "Olive", lastName: "Officer" },
  linkedModification: { id: "mod-1", modificationType: "GUEST_ADD", priceDiffCents: 12000, changeFeeCents: 0 },
  booking: {
    id: "booking-1",
    checkIn: "2026-06-20T00:00:00.000Z",
    checkOut: "2026-06-25T00:00:00.000Z",
    status: "PAID",
    finalPriceCents: 48000,
    member: { id: "member-1", firstName: "Ana", lastName: "Reid" },
    organisation: { name: "Reid Family Trust" },
    payment: { status: "SUCCEEDED", amountCents: 48000, refundedAmountCents: 0, xeroInvoiceNumber: "INV-0042" },
  },
};

describe("list_booking_change_request_queue", () => {
  it("answers each request with what it asks and its booking, without emails or approval controls", async () => {
    h.prisma.bookingChangeRequest.findMany.mockResolvedValue([
      {
        ...changeRequestRow(),
        booking: {
          ...changeRequestBooking(),
          noEmails: false,
          promoRedemptions: [],
          guests: [{ memberId: "member-1" }],
        },
      },
    ]);
    h.prisma.bookingChangeRequest.count.mockResolvedValue(1);

    const { connection, browser } = await expectActionContract({
      actionId: "list_booking_change_request_queue",
      handler: listChangeRequests,
      args: { status: "ALL" },
    });

    // The queue's guard infers the bookings area from the path (`admin-permissions.ts`).
    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(connection).toEqual({
      data: [
        {
          ...CONNECTION_CHANGE_REQUEST,
          executesOnApproval: true,
          promoCorrection: { codes: ["FAMILY10"], onlyChange: false },
          requestedGuestNights: [
            {
              name: "Tom Reid",
              runs: [{ firstNight: "2026-06-20", lastNight: "2026-06-24" }],
              nightCount: 5,
              added: true,
              unchanged: false,
              fillsGaps: false,
            },
          ],
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
    // The browser's answer is unchanged: emails, the approval controls and the
    // member-guest finder are still there.
    expect(browser).toMatchObject({
      memberGuestFind: null,
      data: [
        {
          version: 2,
          acceptsOfficerGuests: false,
          acceptsOfficerPromo: false,
          officerPromoBase: null,
          requestedBy: { id: "member-1", email: "ana@example.test" },
          booking: { member: { email: "ana@example.test" }, payment: { id: "pay-1", xeroInvoiceId: "xero-inv-1" } },
        },
      ],
    });
  });
});

describe("get_booking_change_request", () => {
  it("answers the one request with its people and booking", async () => {
    h.prisma.bookingChangeRequest.findUnique.mockResolvedValue({
      ...changeRequestRow(),
      booking: { ...changeRequestBooking(), memberId: "member-1" },
    });

    const { connection, browser } = await expectActionContract({
      actionId: "get_booking_change_request",
      handler: getChangeRequest,
      args: { id: "bcr-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(h.prisma.bookingChangeRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bcr-1" } }),
    );
    expect(connection).toEqual(CONNECTION_CHANGE_REQUEST);
    expect(browser).toMatchObject({ version: 2, booking: { memberId: "member-1" } });
  });
});

// ── Booking-policy exception requests ───────────────────────────────────────

describe("list_booking_exception_requests", () => {
  it("answers each request's rules, nights and party, without emails or the proposal hash", async () => {
    h.readExceptionQueue.mockResolvedValue({
      data: [
        {
          source: "MODIFICATION",
          id: "pe-1",
          status: "REQUESTED",
          createdAt: day("2026-06-28"),
          updatedAt: day("2026-06-28"),
          version: 1,
          bookingId: "booking-1",
          lodgeId: "lodge-1",
          requestedBy: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
          reviewedBy: { id: "officer-9", firstName: "Olive", lastName: "Officer", email: "olive@example.test" },
          reviewedAt: null,
          memberMessage: "Only two nights free this weekend.",
          proposalHash: "f".repeat(64),
          aggregateCapacityMode: "HOLD",
          reasonCodes: ["MINIMUM_STAY"],
          policyRefs: [{ reasonCode: "MINIMUM_STAY", policyId: "msp-1", policyVersion: 3, capacityMode: "HOLD" }],
          hostingConsequence: null,
          affectedNights: ["2026-07-10", "2026-07-11"],
          proposedCheckIn: "2026-07-10",
          proposedCheckOut: "2026-07-12",
          proposedGuestCount: 2,
          adminNotes: null,
          internalNotes: "Check the weekend rule.",
          createdBookingId: null,
          attemptCount: 1,
          conflictCount: 0,
          lastConflictAt: null,
          lastConflictReason: null,
          supersededByRequestId: null,
          summary: "Shorten to two nights",
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "list_booking_exception_requests",
      handler: listExceptionRequests,
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(h.readExceptionQueue).toHaveBeenCalledWith({ status: "REQUESTED", page: 1, pageSize: 25 });
    const [row] = (connection as { data: Array<Record<string, unknown>> }).data;
    expect(row).toMatchObject({
      id: "pe-1",
      requestedBy: { firstName: "Ana", lastName: "Reid" },
      reviewedBy: { firstName: "Olive", lastName: "Officer" },
      reasonCodes: ["MINIMUM_STAY"],
      internalNotes: "Check the weekend rule.",
    });
    expect(row).not.toHaveProperty("proposalHash");
    expect(row).not.toHaveProperty("version");
    expect(row?.requestedBy).not.toHaveProperty("email");
    expect(browser).toMatchObject({ data: [{ version: 1, proposalHash: "f".repeat(64) }] });
  });
});

describe("get_booking_exception_request", () => {
  const proposedParty = {
    checkIn: "2026-07-10",
    checkOut: "2026-07-12",
    guests: [
      { firstName: "Ana", lastName: "Reid", ageTier: "ADULT", isMember: true, memberId: "member-1", nights: ["2026-07-10", "2026-07-11"] },
      { firstName: "Kim", lastName: "Hale", ageTier: "ADULT", isMember: true, memberId: "member-3", nights: ["2026-07-10", "2026-07-11"] },
    ],
  };
  const evidence = {
    violations: [
      {
        reasonCode: "MINIMUM_STAY",
        policyId: "msp-1",
        policyVersion: 3,
        resolvedScope: { kind: "CLUB" },
        affectedNights: ["2026-07-10", "2026-07-11"],
        exceptionEligible: true,
        capacityMode: "HOLD",
        message: "Weekend stays are at least three nights.",
        triggerDay: "2026-07-10",
        minimumNights: 3,
        actualNights: 2,
        requirements: { kind: "MINIMUM_STAY", minimumNights: 3, actualNights: 2, triggerDays: [5] },
      },
    ],
    capacityMode: "HOLD",
    reasonCodes: ["MINIMUM_STAY"],
    policyRefs: [{ reasonCode: "MINIMUM_STAY", policyId: "msp-1", policyVersion: 3, capacityMode: "HOLD" }],
    affectedNights: ["2026-07-10", "2026-07-11"],
  };
  const commonRow = {
    id: "pe-1",
    requestedByMemberId: "member-1",
    status: "REQUESTED",
    version: 1,
    createdAt: day("2026-06-28"),
    reviewedAt: day("2026-06-29"),
    reviewedBy: { id: "officer-9", firstName: "Olive", lastName: "Officer" },
    requestedBy: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
    memberMessage: "Only two nights free this weekend.",
    adminNotes: null,
    internalNotes: "Check the weekend rule.",
    proposalHash: "f".repeat(64),
    frozenEvidence: evidence,
    aggregateCapacityMode: "HOLD",
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
  };
  /** What a connection is sent of either kind, before `booking` and `lodge`. */
  const connectionCommon = {
    id: "pe-1",
    status: "REQUESTED",
    createdAt: "2026-06-28T00:00:00.000Z",
    reviewedAt: "2026-06-29T00:00:00.000Z",
    reviewedBy: { firstName: "Olive", lastName: "Officer" },
    requestedBy: { firstName: "Ana", lastName: "Reid" },
    memberMessage: "Only two nights free this weekend.",
    adminNotes: null,
    internalNotes: "Check the weekend rule.",
    aggregateCapacityMode: "HOLD",
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    proposedGuests: [
      { firstName: "Ana", lastName: "Reid", ageTier: "ADULT", isMember: true, nights: ["2026-07-10", "2026-07-11"], isMemberGuest: true, beyondFamily: false },
      { firstName: "Kim", lastName: "Hale", ageTier: "ADULT", isMember: true, nights: ["2026-07-10", "2026-07-11"], isMemberGuest: true, beyondFamily: true },
    ],
    evidence: {
      capacityMode: "HOLD",
      reasonCodes: ["MINIMUM_STAY"],
      affectedNights: ["2026-07-10", "2026-07-11"],
      violations: [
        {
          reasonCode: "MINIMUM_STAY",
          message: "Weekend stays are at least three nights.",
          affectedNights: ["2026-07-10", "2026-07-11"],
          capacityMode: "HOLD",
        },
      ],
    },
  };

  beforeEach(() => {
    h.memberGuestBoundary.mockResolvedValue({ beyondFamilyMemberIds: ["member-3"] });
  });

  it("answers a change request with its booking, without emails, member ids or the proposal hash", async () => {
    h.prisma.bookingChangeRequest.findFirst.mockResolvedValue({
      ...commonRow,
      bookingId: "booking-1",
      proposalSnapshot: { kind: "MODIFICATION", lodgeId: "lodge-1", bookingId: "booking-1", base: proposedParty, proposed: proposedParty },
      booking: {
        id: "booking-1",
        checkIn: day("2026-07-10"),
        checkOut: day("2026-07-13"),
        status: "PAID",
        finalPriceCents: 36000,
        lodgeId: "lodge-1",
        member: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
      },
    });

    const { connection, browser } = await runAsConnectionAndBrowser("get_booking_exception_request", getExceptionRequest, {
      id: "pe-1",
    });

    expect(h.requireAdmin).toHaveBeenCalledWith(VIEW);
    expect(connection).toEqual({
      ...connectionCommon,
      source: "MODIFICATION",
      proposal: { kind: "MODIFICATION", lodgeId: "lodge-1", proposed: { checkIn: "2026-07-10", checkOut: "2026-07-12" } },
      booking: {
        id: "booking-1",
        checkIn: "2026-07-10T00:00:00.000Z",
        checkOut: "2026-07-13T00:00:00.000Z",
        status: "PAID",
        finalPriceCents: 36000,
        lodgeId: "lodge-1",
        member: { firstName: "Ana", lastName: "Reid" },
      },
      lodge: null,
      createdBookingId: null,
    });
    expect(browser).toMatchObject({
      version: 1,
      proposalHash: "f".repeat(64),
      requestedBy: { email: "ana@example.test" },
      proposal: { base: proposedParty, proposed: proposedParty },
      booking: { member: { id: "member-1", email: "ana@example.test" } },
    });
  });

  it("answers a new-booking request with its lodge", async () => {
    h.prisma.bookingChangeRequest.findFirst.mockResolvedValue(null);
    h.prisma.newBookingPolicyExceptionRequest.findUnique.mockResolvedValue({
      ...commonRow,
      lodgeId: "lodge-1",
      createdBookingId: null,
      proposalSnapshot: { kind: "NEW_BOOKING", lodgeId: "lodge-1", proposed: proposedParty },
      lodge: { id: "lodge-1", name: "Ruapehu Lodge" },
    });

    const { connection } = await runAsConnectionAndBrowser("get_booking_exception_request", getExceptionRequest, {
      id: "pe-1",
    });

    expect(connection).toEqual({
      ...connectionCommon,
      source: "NEW_BOOKING",
      proposal: { kind: "NEW_BOOKING", lodgeId: "lodge-1", proposed: { checkIn: "2026-07-10", checkOut: "2026-07-12" } },
      booking: null,
      lodge: { id: "lodge-1", name: "Ruapehu Lodge" },
      createdBookingId: null,
    });
  });
});

// ── Booking reviews and the waitlist ────────────────────────────────────────

describe("list_booking_reviews", () => {
  it("answers each booking's review facts and party, without emails", async () => {
    h.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-2",
        memberId: "member-1",
        organisationId: null,
        lodgeId: "lodge-1",
        checkIn: day("2026-07-10"),
        checkOut: day("2026-07-12"),
        status: "PAYMENT_PENDING",
        finalPriceCents: 24000,
        createdAt: day("2026-06-30"),
        requiresAdminReview: true,
        adminReviewStatus: "PENDING",
        adminReviewReason: "No adult on the booking.",
        adminReviewNotes: "Asked the owner who supervises.",
        adminReviewedById: "officer-9",
        adminReviewedAt: day("2026-06-30"),
        adultMemberHostingReview: { uncovered: [] },
        adultMemberHostingReviewStatus: "PENDING",
        adultMemberHostingReviewReason: "No adult member host.",
        stripeSessionId: "cs_test_secret",
        member: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
        adminReviewedBy: { id: "officer-9", firstName: "Olive", lastName: "Officer" },
        guests: [{ id: "guest-2", firstName: "Mia", lastName: "Reid", ageTier: "YOUTH", isMember: true }],
      },
    ]);
    h.prisma.booking.count.mockResolvedValue(1);

    const { connection, browser } = await expectActionContract({
      actionId: "list_booking_reviews",
      handler: listBookingReviews,
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(connection).toEqual({
      data: [
        {
          id: "booking-2",
          lodgeId: "lodge-1",
          checkIn: "2026-07-10T00:00:00.000Z",
          checkOut: "2026-07-12T00:00:00.000Z",
          status: "PAYMENT_PENDING",
          finalPriceCents: 24000,
          createdAt: "2026-06-30T00:00:00.000Z",
          requiresAdminReview: true,
          adminReviewStatus: "PENDING",
          adminReviewReason: "No adult on the booking.",
          adminReviewNotes: "Asked the owner who supervises.",
          adminReviewedAt: "2026-06-30T00:00:00.000Z",
          adultMemberHostingReviewStatus: "PENDING",
          adultMemberHostingReviewReason: "No adult member host.",
          member: { id: "member-1", firstName: "Ana", lastName: "Reid" },
          adminReviewedBy: { firstName: "Olive", lastName: "Officer" },
          guests: [{ firstName: "Mia", lastName: "Reid", ageTier: "YOUTH", isMember: true }],
          reviewReasonCodes: ["ADULT_SUPERVISION", "ADULT_MEMBER_HOSTING_REQUIRED"],
          reviewReasons: expect.arrayContaining([expect.any(String)]),
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
    expect(browser).toMatchObject({
      data: [{ stripeSessionId: "cs_test_secret", member: { email: "ana@example.test" } }],
    });
  });
});

describe("list_waitlist", () => {
  it("answers each entry in queue order without the owner's email or the delivery internals", async () => {
    h.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-3",
        memberId: "member-1",
        organisationId: null,
        lodgeId: "lodge-1",
        checkIn: day("2026-07-20"),
        checkOut: day("2026-07-22"),
        status: "WAITLIST_OFFERED",
        waitlistOfferedAt: day("2026-06-30"),
        waitlistOfferExpiresAt: day("2026-07-02"),
        requiresAdminReview: false,
        adminReviewReason: null,
        adminReviewStatus: null,
        noEmails: false,
        finalPriceCents: 30000,
        createdAt: day("2026-06-01"),
        member: { id: "member-1", firstName: "Ana", lastName: "Reid", email: "ana@example.test" },
        organisation: null,
        guests: [{ id: "guest-3", firstName: "Ana", lastName: "Reid", ageTier: "ADULT", isMember: true }],
      },
    ]);
    h.prisma.booking.count.mockResolvedValue(1);
    h.offerEmailDeliveries.mockResolvedValue(
      new Map([
        [
          "booking-3",
          {
            status: "FAILED",
            emailLogId: "email-log-1",
            attempts: 2,
            lastAttemptAt: "2026-06-30T01:00:00.000Z",
            errorMessage: "Mailbox ana@example.test is full",
            retryState: "retrying",
            needsOperatorAction: false,
          },
        ],
      ]),
    );
    h.waitlistPositions.mockResolvedValue(new Map([["booking-3", 2]]));

    const { connection, browser } = await expectActionContract({
      actionId: "list_waitlist",
      handler: listWaitlist,
      args: { from: "2026-07-01", to: "2026-07-31" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith();
    expect(connection).toEqual({
      data: [
        {
          id: "booking-3",
          memberName: "Ana Reid",
          memberId: "member-1",
          checkIn: "2026-07-20",
          checkOut: "2026-07-22",
          guestCount: 1,
          guests: [{ firstName: "Ana", lastName: "Reid", ageTier: "ADULT", isMember: true }],
          status: "WAITLIST_OFFERED",
          waitlistPosition: 2,
          waitlistOfferedAt: "2026-06-30T00:00:00.000Z",
          waitlistOfferExpiresAt: "2026-07-02T00:00:00.000Z",
          requiresAdminReview: false,
          adminReviewReason: null,
          adminReviewStatus: null,
          noEmails: false,
          finalPriceCents: 30000,
          createdAt: "2026-06-01T00:00:00.000Z",
          offerEmailDelivery: {
            status: "FAILED",
            attempts: 2,
            lastAttemptAt: "2026-06-30T01:00:00.000Z",
            retryState: "retrying",
            needsOperatorAction: false,
          },
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
    });
    // The browser still reads `entries`, the owner's email and the delivery internals.
    expect(browser).toMatchObject({
      entries: [
        {
          memberEmail: "ana@example.test",
          offerEmailDelivery: { emailLogId: "email-log-1", errorMessage: "Mailbox ana@example.test is full" },
        },
      ],
    });
  });

  it("still refuses a window the route's own rule refuses", async () => {
    const action = findMcpAction("list_waitlist") as McpAction;
    const { request } = buildActionRequest(action, { from: "2026-01-01", to: "2027-06-30" }, true);
    const response = await listWaitlist(request as never);
    expect(response.status).toBe(400);
    expect(h.prisma.booking.findMany).not.toHaveBeenCalled();
  });
});
