/**
 * ALP-794 (`INV-MCP-006`): the small booking changes an AI app connection may
 * make, each held to the contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields;
 * - it acts as the signed-in member only, though that member is also a Full
 *   Admin (`officerMemberSession`): another member's booking is refused to
 *   the connection, and the services are told the actor is no officer;
 * - the browser's answer is unchanged.
 *
 * The dispatcher writes the one audit row per change (`mcp-dispatch.test.ts`);
 * these tests hold the route's side of the contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  modules: vi.fn(),
  logAudit: vi.fn(),
  writeRequestedRoom: vi.fn(),
  cancelNewBookingRequest: vi.fn(),
  cancelModificationRequest: vi.fn(),
  deleteBooking: vi.fn(),
  confirmWaitlistOffer: vi.fn(),
  prisma: {
    booking: { findUnique: vi.fn(), update: vi.fn() },
    refundRequest: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
// The original's pure helpers stay: other modules read them at module scope.
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: h.modules,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit, createAuditLog: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
// Today, on the club's frame, is the frozen test day.
vi.mock("@/lib/club-time/server", async () => {
  const { calendarDateOfDateOnlyInstant } = await import("@/lib/club-time");
  const today = new Date("2026-07-01T00:00:00.000Z");
  return {
    clubTime: async () => ({ today: () => calendarDateOfDateOnlyInstant(today) }),
    clubTodayDateOnlyInstant: async () => today,
  };
});
vi.mock("@/lib/requested-room-write", () => ({
  writeRequestedRoom: h.writeRequestedRoom,
  requestedRoomWriteErrorResponse: vi.fn(() => ({ error: "refused", status: 400 })),
}));
vi.mock("@/lib/booking-exception-request-service", () => ({
  cancelNewBookingExceptionRequest: h.cancelNewBookingRequest,
  cancelModificationExceptionRequest: h.cancelModificationRequest,
}));
vi.mock("@/lib/booking-delete", () => ({ deleteBooking: h.deleteBooking }));
vi.mock("@/lib/waitlist", () => ({ confirmWaitlistOffer: h.confirmWaitlistOffer }));
vi.mock("@/lib/club-format-server", () => ({
  clubFormat: vi.fn(async () => ({ format: {}, cents: (value: number) => `$${(value / 100).toFixed(2)}` })),
  clubFormatValues: vi.fn(async () => ({ dateFormat: "DMY", currency: "NZD", locale: "en-NZ" })),
}));
vi.mock("@/lib/email", () => ({
  sendAdminRefundRequestAlert: vi.fn(async () => undefined),
  sendBookingConfirmedEmail: vi.fn(async () => undefined),
  sendBookingPendingEmail: vi.fn(async () => undefined),
}));
// The refund ceiling's reads beyond the payment row: nothing held back.
vi.mock("@/lib/edit-refund-hand-back", () => ({ refundAppealHandedBackCents: vi.fn(async () => 0) }));
vi.mock("@/lib/organiser-child-refund", () => ({ organiserCardAppealCeilingFor: vi.fn(async () => null) }));
vi.mock("@/lib/superseded-capture-hold-back", () => ({
  readSupersededCaptureHeldBack: vi.fn(async () => ({ byTransaction: new Map(), totalCents: 0 })),
}));

import { DELETE as deleteDraft } from "@/app/api/bookings/[id]/route";
import { DELETE as clearArrival, PUT as setArrival } from "@/app/api/bookings/[id]/arrival-time/route";
import { PATCH as withdrawChangeException } from "@/app/api/bookings/[id]/exception-requests/[requestId]/route";
import { PUT as setNote } from "@/app/api/bookings/[id]/notes/route";
import { POST as requestRefundReview } from "@/app/api/bookings/[id]/refund-request/route";
import { DELETE as clearRoom, PUT as setRoom } from "@/app/api/bookings/[id]/requested-room/route";
import { POST as acceptOffer } from "@/app/api/bookings/[id]/waitlist-confirm/route";
import { PATCH as withdrawBookingException } from "@/app/api/bookings/exception-requests/[id]/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { sendAdminRefundRequestAlert } from "@/lib/email";
import { findMcpAction } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";
import { WAITLIST_CROSS_LODGE_WEBSITE_ONLY_CODE } from "@/lib/waitlist-confirm-recovery-contract";

/** The same write as a connection and as the officer's browser, for a booking that is not the member's. */
async function statusesFor(
  handler: (request: never, context: never) => Promise<Response>,
  method: string,
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<{ connection: number; browser: number }> {
  const { NextRequest } = await import("next/server");
  const call = handler as unknown as (r: Request, c: unknown) => Promise<Response>;
  const run = async (viaConnection: boolean) => {
    const request = new NextRequest(new URL(path, "https://club.example.test"), {
      method,
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

const SOMEONE_ELSES = { memberId: "someone-else", status: "CONFIRMED", checkIn: new Date("2026-08-01T00:00:00.000Z"), deletedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.modules.mockResolvedValue({ bedAllocation: true, mcpServer: true });
  h.prisma.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation(h.prisma));
});

describe("set_my_booking_note", () => {
  it("saves the member's note and answers with it alone", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ memberId: "officer-1", status: "CONFIRMED" });
    h.prisma.booking.update.mockResolvedValue({ id: "booking-1", notes: "Arriving late" });
    const { connection, browser } = await expectActionContract({
      actionId: "set_my_booking_note",
      handler: setNote,
      args: { id: "booking-1", notes: "<b>Arriving late</b>" },
    });
    expect(connection).toEqual(browser);
    // The shared schema strips the markup before it is saved.
    expect(h.prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notes: "Arriving late" } }),
    );
  });

  it("refuses the connection another member's booking, which the officer's browser may edit", async () => {
    h.prisma.booking.findUnique.mockResolvedValue(SOMEONE_ELSES);
    h.prisma.booking.update.mockResolvedValue({ id: "booking-2", notes: "x" });
    expect(
      await statusesFor(setNote, "PUT", "/api/bookings/booking-2/notes", { id: "booking-2" }, { notes: "x" }),
    ).toEqual({ connection: 403, browser: 200 });
  });
});

describe("set_my_arrival_time and clear_my_arrival_time", () => {
  const OWN = { memberId: "officer-1", status: "CONFIRMED", checkIn: new Date("2026-08-01T00:00:00.000Z"), deletedAt: null };
  /** The guard read gets the booking; the read inside the write gets the time it replaces. */
  const reads = (previous: string | null) => async (args: { select: Record<string, unknown> }) =>
    "checkIn" in args.select ? OWN : { expectedArrivalTime: previous };

  it("sets the time and answers with it alone", async () => {
    h.prisma.booking.findUnique.mockImplementation(reads(null));
    h.prisma.booking.update.mockResolvedValue({ id: "booking-1", expectedArrivalTime: "17:30" });
    const { connection } = await expectActionContract({
      actionId: "set_my_arrival_time",
      handler: setArrival,
      args: { id: "booking-1", expectedArrivalTime: "17:30" },
    });
    expect(connection).toEqual({ id: "booking-1", expectedArrivalTime: "17:30" });
  });

  it("clears the time", async () => {
    h.prisma.booking.findUnique.mockImplementation(reads("17:30"));
    h.prisma.booking.update.mockResolvedValue({ id: "booking-1", expectedArrivalTime: null });
    const { connection } = await expectActionContract({
      actionId: "clear_my_arrival_time",
      handler: clearArrival,
      args: { id: "booking-1" },
    });
    expect(connection).toEqual({ id: "booking-1", expectedArrivalTime: null });
  });

  it("refuses the connection another member's booking, which the officer's browser may edit", async () => {
    h.prisma.booking.findUnique.mockResolvedValue(SOMEONE_ELSES);
    h.prisma.booking.update.mockResolvedValue({ id: "booking-2", expectedArrivalTime: "17:30" });
    expect(
      await statusesFor(setArrival, "PUT", "/api/bookings/booking-2/arrival-time", { id: "booking-2" }, {
        expectedArrivalTime: "17:30",
      }),
    ).toEqual({ connection: 403, browser: 200 });
  });
});

describe("set_my_requested_room and clear_my_requested_room", () => {
  const SET = { id: "booking-1", requestedRoomId: "room-1", requestedRoom: { id: "room-1", name: "Bunk room", active: true } };

  it("asks for the room as the member, never as a Full Admin", async () => {
    h.writeRequestedRoom.mockResolvedValue(SET);
    const { connection, browser } = await expectActionContract({
      actionId: "set_my_requested_room",
      handler: setRoom,
      args: { id: "booking-1", requestedRoomId: "room-1" },
    });
    expect(connection).toEqual(browser);
    // The connection first, then the officer's own browser.
    expect(h.writeRequestedRoom.mock.calls.map(([input]) => input.actorIsAdmin)).toEqual([false, true]);
  });

  it("withdraws the request as the member", async () => {
    h.writeRequestedRoom.mockResolvedValue({ id: "booking-1", requestedRoomId: null, requestedRoom: null });
    // The clear's answer has no room; the set's above fills the nested shape.
    await expectActionContract({
      actionId: "clear_my_requested_room",
      handler: clearRoom,
      args: { id: "booking-1" },
      oneOfSeveralAnswers: true,
    });
    expect(h.writeRequestedRoom.mock.calls.map(([input]) => input.actorIsAdmin)).toEqual([false, true]);
  });
});

describe("withdrawing an exception request", () => {
  it("withdraws the member's own new-booking request", async () => {
    h.cancelNewBookingRequest.mockResolvedValue({ id: "nb-1" });
    const { connection, browser } = await expectActionContract({
      actionId: "withdraw_booking_exception_request",
      handler: withdrawBookingException,
      args: { id: "nb-1" },
    });
    expect(connection).toEqual(browser);
    expect(connection).toEqual({ id: "nb-1", status: "CANCELLED" });
    expect(h.cancelNewBookingRequest).toHaveBeenCalledWith({ id: "nb-1", requestedByMemberId: "officer-1" });
  });

  it("withdraws the member's own request on a booking", async () => {
    h.cancelModificationRequest.mockResolvedValue({ id: "cr-1" });
    const { connection } = await expectActionContract({
      actionId: "withdraw_booking_change_exception_request",
      handler: withdrawChangeException,
      args: { id: "booking-1", requestId: "cr-1" },
    });
    expect(connection).toEqual({ id: "cr-1", status: "CANCELLED" });
    expect(h.cancelModificationRequest).toHaveBeenCalledWith({
      id: "cr-1",
      bookingId: "booking-1",
      requestedByMemberId: "officer-1",
    });
  });
});

describe("request_refund_review", () => {
  const CANCELLED = {
    id: "booking-1",
    memberId: "officer-1",
    status: "CANCELLED",
    deletedAt: null,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    payment: { id: "pay-1", amountCents: 9000, refundedAmountCents: 4500, status: "PARTIALLY_REFUNDED" },
    member: { firstName: "Olive", lastName: "Officer" },
    organisation: null,
  };
  const CREATED = {
    id: "rr-1",
    bookingId: "booking-1",
    memberId: "officer-1",
    reason: "The road was closed all weekend",
    requestedAmountCents: 4500,
    status: "PENDING",
    adminNotes: null,
    approvedAmountCents: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  };

  it("asks for the review and answers without the member's or officer's ids", async () => {
    h.prisma.booking.findUnique.mockResolvedValue(CANCELLED);
    h.prisma.refundRequest.findFirst.mockResolvedValue(null);
    h.prisma.refundRequest.create.mockResolvedValue(CREATED);
    const { connection, browser } = await expectActionContract({
      actionId: "request_refund_review",
      handler: requestRefundReview,
      args: { id: "booking-1", reason: "The road was closed all weekend", requestedAmountCents: 4500 },
      // A new review is undecided, so its outcome fields are still null.
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({ id: "rr-1", status: "PENDING", requestedAmountCents: 4500 });
    expect(browser).toMatchObject({ memberId: "officer-1" });
    expect(connection).not.toHaveProperty("memberId");
    expect(connection).not.toHaveProperty("reviewedBy");
    // It emails the club's officers, so it is `destructive` (owner decision on
    // #5305, item 2): the app confirms with the member first. One alert per
    // call, connection then browser: two proves the connection's call alerted.
    expect(sendAdminRefundRequestAlert).toHaveBeenCalledTimes(2);
    expect(findMcpAction("request_refund_review")?.kind).toBe("destructive");
  });

  it("refuses the connection another member's booking, which the officer's browser may appeal", async () => {
    h.prisma.booking.findUnique.mockResolvedValue({ ...CANCELLED, memberId: "someone-else" });
    h.prisma.refundRequest.findFirst.mockResolvedValue(null);
    h.prisma.refundRequest.create.mockResolvedValue(CREATED);
    expect(
      await statusesFor(requestRefundReview, "POST", "/api/bookings/booking-1/refund-request", { id: "booking-1" }, {
        reason: "The road was closed all weekend",
      }),
    ).toEqual({ connection: 403, browser: 201 });
  });
});

describe("accept_waitlist_offer", () => {
  it("answers a same-lodge accept with the booking's id to pay for", async () => {
    h.confirmWaitlistOffer.mockResolvedValue({ success: true, newStatus: "PAYMENT_PENDING" });
    h.prisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "officer-1",
      finalPriceCents: 12000,
      nonMemberHoldUntil: null,
      member: { email: "olive@example.org", firstName: "Olive" },
      organisation: null,
      guests: [],
      promoRedemptions: [],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "accept_waitlist_offer",
      handler: acceptOffer,
      args: { id: "booking-1" },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toEqual({ id: "booking-1", ...(browser as object) });
    expect(connection).toMatchObject({ requiresPayment: true });
    expect(h.confirmWaitlistOffer).toHaveBeenCalledWith("booking-1", "officer-1", expect.anything(), { crossLodgeOnWebsiteOnly: true });
    // A confirmed offer runs the hosting-coverage settlement, which can email
    // other members on a group trip (`settleHostingCoverageAfterCommit`), so
    // the action is `destructive` (owner decision on #5305, item 2).
    expect(findMcpAction("accept_waitlist_offer")?.kind).toBe("destructive");
  });

  it("refuses a connection a cross-lodge offer with 409; the browser may still accept it", async () => {
    // The service refuses a connection (`waitlist-confirm-minimum-stay.test.ts`
    // proves nothing is written); the route asks it to, and only for a connection.
    h.confirmWaitlistOffer.mockImplementation(async (_id, _member, _format, options) =>
      options?.crossLodgeOnWebsiteOnly
        ? { success: false, error: "Accept this offer at another lodge on the club website.", code: WAITLIST_CROSS_LODGE_WEBSITE_ONLY_CODE }
        : { success: true, newStatus: "PAYMENT_PENDING", newBookingId: "booking-9" });
    h.prisma.booking.findUnique.mockResolvedValue({ finalPriceCents: 15000, status: "PAYMENT_PENDING" });
    expect(
      await statusesFor(acceptOffer, "POST", "/api/bookings/booking-1/waitlist-confirm", { id: "booking-1" }, {}),
    ).toEqual({ connection: 409, browser: 200 });
    expect(h.confirmWaitlistOffer.mock.calls.map((call) => call[3])).toEqual([
      { crossLodgeOnWebsiteOnly: true },
      { crossLodgeOnWebsiteOnly: false },
    ]);
  });
});

describe("delete_my_draft_booking", () => {
  it("deletes as the member, never as an admin, and answers with the result", async () => {
    h.deleteBooking.mockResolvedValue({
      status: 200,
      data: { success: true, mode: "hard-delete", bookingId: "booking-1", message: "Draft booking deleted" },
    });
    const { connection, browser } = await expectActionContract({
      actionId: "delete_my_draft_booking",
      handler: deleteDraft,
      args: { id: "booking-1" },
    });
    expect(connection).toEqual(browser);
    // The connection first, then the officer's own browser: only an admin
    // may soft-delete a cancelled booking (`deleteBooking`).
    expect(h.deleteBooking.mock.calls.map(([input]) => input.actor.role)).toEqual(["USER", "ADMIN"]);
  });
});
