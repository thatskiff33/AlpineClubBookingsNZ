import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2700 surface 3 — `GET /api/bookings/[id]/change-requests` must refuse a
 * soft-deleted booking.
 *
 * WHAT WAS WRONG. This read loaded the booking on `{ memberId }` alone and,
 * once past its 403, listed every change request on it — POLICY_EXCEPTION rows
 * among them — to a member whom `bookings/[id]/page.tsx` refuses the booking
 * itself. One of the two reads `INV-ADDPAY-033` tracked. (The issue body named
 * three; a later correction on the thread established that `cancel-preview`
 * GET is not one, because its status gate already rejects every deleted
 * booking with a 400 before any payload is built — see `INV-ADDPAY-030`.)
 *
 * WHAT THE OWNER DECIDED (10 Aug 2026). Refuse, using the SAME sentence as the
 * consent write and the refund-appeal read rather than three variants that
 * drift apart, so a member following a stale link is told what happened rather
 * than hitting a dead end. It is a deliberate, documented departure from
 * `INV-ADDPAY-031`'s byte-identical-body half, and it is safe for the same
 * reason the consent one is: the guard sits AFTER the authorisation check.
 *
 * MUTATION PROOF. Delete the `if (booking.deletedAt)` block from the GET
 * handler and "refuses a deleted booking…" fails by name. Move it above the
 * 403 and "gives a caller with no claim the same 403…" fails.
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindUnique: vi.fn(),
  changeRequestFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    },
    bookingChangeRequest: {
      findMany: (...args: unknown[]) => mocks.changeRequestFindMany(...args),
    },
  },
}));

import { GET } from "@/app/api/bookings/[id]/change-requests/route";
import { DELETED_BOOKING_MESSAGE } from "@/lib/deleted-booking-refusal";

// `@/lib/admin-permissions` is left UN-mocked so the real role resolution
// decides who reaches the read: the owner, a Full Admin, or a Booking Officer
// holding `bookings:edit` (#1313 option A2).
const OWNER = {
  user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const FULL_ADMIN = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const STRANGER = {
  user: { id: "stranger-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

const DELETED_AT = new Date("2026-06-01T00:00:00.000Z");

/**
 * The only shape production can emit. `softDeleteCancelledBooking` is
 * `deletedAt`'s one writer and refuses anything not already CANCELLED, nothing
 * moves a booking back out of CANCELLED, and `deletedAt` is never cleared
 * (`INV-ADDPAY-030`) — so a deleted booking is always a CANCELLED one.
 */
function booking(deletedAt: Date | null) {
  return { memberId: "member-1", deletedAt };
}

function callRoute() {
  return GET(
    new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
    ),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  // Armed to EXPLODE: a refusal that leaked through would fail loudly on the
  // read itself rather than quietly returning the wrong status.
  mocks.changeRequestFindMany.mockImplementation(() => {
    throw new Error(
      "bookingChangeRequest.findMany must never run on a soft-deleted booking",
    );
  });
});

describe("GET /api/bookings/[id]/change-requests — soft-deleted booking (#2700)", () => {
  it.each([
    ["the booking's owner", OWNER],
    ["a Full Admin", FULL_ADMIN],
  ])(
    "refuses a deleted booking for %s, saying it was cancelled or removed",
    async (_who, session) => {
      mocks.auth.mockResolvedValue(session);
      mocks.bookingFindUnique.mockResolvedValue(booking(DELETED_AT));

      const res = await callRoute();

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: DELETED_BOOKING_MESSAGE,
      });
      expect(mocks.changeRequestFindMany).not.toHaveBeenCalled();
    },
  );

  it("selects deletedAt beside the authority field, so the guard has something to read", async () => {
    mocks.auth.mockResolvedValue(OWNER);
    mocks.bookingFindUnique.mockResolvedValue(booking(DELETED_AT));

    await callRoute();

    expect(mocks.bookingFindUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      select: { memberId: true, deletedAt: true },
    });
  });

  it("gives a caller with no claim the same 403, never the cancelled-or-removed message", async () => {
    // THE ORDERING. Placed before the 403 this guard would answer 404 on a
    // deleted booking and 403 on a live one, handing a stranger a
    // deleted-or-live oracle on a booking they have no claim to.
    mocks.auth.mockResolvedValue(STRANGER);
    mocks.bookingFindUnique.mockResolvedValue(booking(DELETED_AT));

    const res = await callRoute();

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.changeRequestFindMany).not.toHaveBeenCalled();
  });

  it("gives that same caller the identical 403 on a booking that is NOT deleted", async () => {
    mocks.auth.mockResolvedValue(STRANGER);
    mocks.bookingFindUnique.mockResolvedValue(booking(null));

    const res = await callRoute();

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("keeps the plain not-found answer distinct from the deleted one", async () => {
    // A booking id that never existed still answers "Booking not found". The
    // decision changed what a DELETED booking says, not what a missing one says.
    mocks.auth.mockResolvedValue(OWNER);
    mocks.bookingFindUnique.mockResolvedValue(null);

    const res = await callRoute();

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Booking not found" });
  });

  it("still serves the list on an identical booking that is NOT deleted", async () => {
    // The complement. Without it the suite would be satisfied by a route that
    // refused every read.
    mocks.auth.mockResolvedValue(OWNER);
    mocks.bookingFindUnique.mockResolvedValue(booking(null));
    mocks.changeRequestFindMany.mockResolvedValue([]);

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.changeRequestFindMany).toHaveBeenCalledTimes(1);
  });

  it("does not treat a missing deletedAt field as deleted", async () => {
    mocks.auth.mockResolvedValue(OWNER);
    mocks.bookingFindUnique.mockResolvedValue({ memberId: "member-1" });
    mocks.changeRequestFindMany.mockResolvedValue([]);

    const res = await callRoute();

    expect(res.status).toBe(200);
  });
});
