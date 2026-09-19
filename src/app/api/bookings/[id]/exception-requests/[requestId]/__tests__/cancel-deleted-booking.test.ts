import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

/**
 * #2674 — cancelling a policy-exception request must not be writable on a
 * SOFT-DELETED booking.
 *
 * Why this path was genuinely reachable, unlike the arrival-time write the issue
 * was filed against: that handler already refuses a deleted booking as a side
 * effect of a status gate it has for another reason (`deletedAt` has one writer,
 * `softDeleteCancelledBooking`, which only ever fires on an already-CANCELLED
 * booking and never clears the column, so soft-deleted implies CANCELLED
 * permanently). This path had no such accident to inherit: the route never loads
 * the Booking at all, and the guarded claim in
 * `cancelModificationExceptionRequest` named only the REQUEST's own columns.
 *
 * The state is producible: booking cancellation never resolves change requests
 * (booking-cancel.ts does not mention `bookingChangeRequest` once) and
 * `getCancelledBookingDeleteBlockers` does not count them, so
 * `CANCELLED + deletedAt + an open REQUESTED policy-exception request` is a
 * perfectly ordinary row set. The fixtures below use exactly that shape.
 *
 * THE SERVICE IS NOT MOCKED. The route is driven end-to-end against a simulated
 * `bookingChangeRequest.updateMany` that really EVALUATES the `where` it is
 * handed — including the relation filter — against a fixture row. Asserting on
 * the argument alone would pass for a service that built a correct filter and
 * then ignored it; this way "the cancel did not land" is a statement about the
 * row and the response, not about a call shape.
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  getClientIp: vi.fn(),
  logAudit: vi.fn(),
  execRaw: vi.fn(),
  bcrFindUnique: vi.fn(),
  reservationDeleteMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  getClientIp: (...a: unknown[]) => mocks.getClientIp(...a),
  rateLimiters: {
    bookingChangeRequest: { id: "bcr", limit: 5, windowSeconds: 86400 },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: (...a: unknown[]) => mocks.logAudit(...a),
}));

/** The one open request in the simulated database, and the booking behind it. */
interface ChangeRequestRow {
  id: string;
  bookingId: string;
  requestedByMemberId: string;
  kind: string;
  status: string;
  openStateKey: string | null;
  cancelledAt: Date | null;
  version: number;
  booking: { deletedAt: Date | null };
}

let row: ChangeRequestRow;

function freshRow(deletedAt: Date | null): ChangeRequestRow {
  return {
    id: "bcr-1",
    bookingId: "booking-1",
    requestedByMemberId: "m1",
    kind: "POLICY_EXCEPTION",
    status: "REQUESTED",
    openStateKey: "pe:booking-1:m1",
    cancelledAt: null,
    version: 1,
    booking: { deletedAt },
  };
}

const updateManyCalls: { where: Record<string, unknown> }[] = [];

function updateMany(args: {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}) {
  updateManyCalls.push({ where: args.where });
  // The shared evaluator (#3434) accepts `booking` in either the shorthand
  // (`{ deletedAt: null }`) or the explicit (`{ is: { deletedAt: null } }`)
  // spelling, so the test pins the BEHAVIOUR rather than one syntax.
  if (!matchesWhere(row, args.where)) return Promise.resolve({ count: 0 });
  // The claim landed: apply it, exactly as the real statement would.
  row.status = args.data.status as string;
  row.openStateKey = args.data.openStateKey as string | null;
  row.cancelledAt = args.data.cancelledAt as Date;
  row.version += 1;
  return Promise.resolve({ count: 1 });
}

const tx = {
  $executeRaw: (...a: unknown[]) => mocks.execRaw(...a),
  bookingChangeRequest: {
    findUnique: (...a: unknown[]) => mocks.bcrFindUnique(...a),
    updateMany,
  },
  policyExceptionReservationNight: {
    deleteMany: (...a: unknown[]) => mocks.reservationDeleteMany(...a),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
  },
}));

import { PATCH } from "@/app/api/bookings/[id]/exception-requests/[requestId]/route";

// The requester. The ONLY principal who can reach this write: the claim is
// scoped to `requestedByMemberId`, and there is no admin path on this route.
const REQUESTER = {
  user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const FULL_ADMIN = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const OTHER_MEMBER = {
  user: { id: "m2", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

const DELETED_AT = new Date("2026-06-01T00:00:00.000Z");

function callRoute(bookingId = "booking-1", requestId = "bcr-1") {
  const req = new NextRequest(
    `http://localhost/api/bookings/${bookingId}/exception-requests/${requestId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    },
  );
  return PATCH(req, { params: Promise.resolve({ id: bookingId, requestId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateManyCalls.length = 0;
  row = freshRow(null);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.getClientIp.mockReturnValue("127.0.0.1");
  mocks.bcrFindUnique.mockResolvedValue({
    kind: "POLICY_EXCEPTION",
    proposalSnapshot: { lodgeId: "lodge_1" },
  });
  // Armed to EXPLODE. A refusal that leaked through would not quietly return
  // the wrong status, it would fail loudly on the reservation release that only
  // a landed claim performs.
  mocks.reservationDeleteMany.mockImplementation(() => {
    throw new Error(
      "the provisional reservation must not be released by a lost claim",
    );
  });
});

describe("PATCH /api/bookings/[id]/exception-requests/[requestId] — soft-deleted booking (#2674)", () => {
  it("refuses the requester's own cancel on a soft-deleted booking, and writes nothing", async () => {
    // The requester is the only role that can otherwise reach this write, so it
    // is the case that matters. `CANCELLED + deletedAt` is the only shape
    // production emits; the request itself is still open.
    row = freshRow(DELETED_AT);
    mocks.auth.mockResolvedValue(REQUESTER);

    const res = await callRoute();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "This request is no longer open and cannot be cancelled",
    });
    // The row is untouched: no CANCELLED, no cancelledAt, no version bump, and
    // the open-slot key is still held.
    expect(row).toMatchObject({
      status: "REQUESTED",
      cancelledAt: null,
      version: 1,
      openStateKey: "pe:booking-1:m1",
    });
    // No reservation release, and no success audit row.
    expect(mocks.reservationDeleteMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    // The guard really is a predicate ON THE CLAIM, not a separate read.
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].where).toHaveProperty("booking");
  });

  it("answers 409 to the requester on a soft-deleted booking, with the release disarmed", async () => {
    // The same case as above with the booby trap removed, so the refusal is
    // asserted through the RESPONSE and the row rather than through a thrown
    // side effect. Two independent signals for one property: strip the guard and
    // this one reports a 200 where a 409 belongs, while its sibling reports the
    // release firing.
    row = freshRow(DELETED_AT);
    mocks.auth.mockResolvedValue(REQUESTER);
    mocks.reservationDeleteMany.mockResolvedValue({ count: 2 });

    const res = await callRoute();

    expect(res.status).toBe(409);
    expect(row.status).toBe("REQUESTED");
    expect(row.openStateKey).toBe("pe:booking-1:m1");
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("refuses a Full Admin the same way — this route has no admin path to exempt", async () => {
    // Asserted explicitly so the fix cannot be read as having introduced one.
    // A Full Admin is not the requester, so they lose the claim on a deleted
    // booking exactly as they already do on a live one.
    row = freshRow(DELETED_AT);
    mocks.auth.mockResolvedValue(FULL_ADMIN);

    const res = await callRoute();

    expect(res.status).toBe(409);
    expect(row.status).toBe("REQUESTED");
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("gives a member with no claim the identical 409 whether the booking is deleted or live", async () => {
    // The ordering/oracle property, in the form this route can express it. There
    // is no 403 here — the guarded claim IS the authorisation — so the deletion
    // guard had to be indistinguishable from a lost claim. If it had been a
    // pre-read answering 404, any signed-in member could probe any booking id in
    // the URL and learn whether that booking had been deleted.
    mocks.auth.mockResolvedValue(OTHER_MEMBER);

    row = freshRow(null);
    const live = await callRoute();
    const liveBody = await live.json();

    row = freshRow(DELETED_AT);
    const deleted = await callRoute();
    const deletedBody = await deleted.json();

    expect(live.status).toBe(409);
    expect(deleted.status).toBe(409);
    expect(deletedBody).toEqual(liveBody);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("still cancels an open request on an identical booking that is NOT deleted", async () => {
    // The complement. Without it the suite would be satisfied by a service that
    // refused every cancel, which is not the fix.
    row = freshRow(null);
    mocks.auth.mockResolvedValue(REQUESTER);
    mocks.reservationDeleteMany.mockResolvedValue({ count: 2 });

    const res = await callRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: "bcr-1",
      status: "CANCELLED",
    });
    expect(row).toMatchObject({
      status: "CANCELLED",
      openStateKey: null,
      version: 2,
    });
    expect(row.cancelledAt).toBeInstanceOf(Date);
    // #2525: a landed cancel releases the provisional reservation, in the same
    // transaction, under the global lock taken first.
    expect(mocks.execRaw).toHaveBeenCalled();
    expect(mocks.reservationDeleteMany).toHaveBeenCalledWith({
      where: { changeRequestId: "bcr-1" },
    });
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({
      action: "booking-policy-exception-request.cancel",
      outcome: "success",
    });
  });

  it("keeps the pre-existing claim scopes intact alongside the new one", async () => {
    // Regression fence: the deletion guard is an ADDITION. Reaching a request
    // via the wrong booking URL must still lose the claim even though that
    // booking is live.
    row = freshRow(null);
    mocks.auth.mockResolvedValue(REQUESTER);

    const res = await callRoute("booking-2");

    expect(res.status).toBe(409);
    expect(row.status).toBe("REQUESTED");
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(updateManyCalls[0].where).toMatchObject({
      id: "bcr-1",
      bookingId: "booking-2",
      requestedByMemberId: "m1",
      kind: "POLICY_EXCEPTION",
      status: "REQUESTED",
    });
  });
});
