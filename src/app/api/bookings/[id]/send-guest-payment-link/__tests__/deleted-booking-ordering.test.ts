import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2674 — the ONE write in this family that already consulted `deletedAt` was
 * consulting it in the WRONG ORDER.
 *
 * `INV-ADDPAY-031` (`docs/invariants/additional-payment-chasing.md`) states the
 * house shape: select `deletedAt` beside the authority fields, answer `404`
 * uniformly for every role, and place the check **after** the authorisation
 * check so an unauthorised caller gets `403` either way rather than a
 * deleted-or-live oracle. This route was folding the deletion test into the
 * not-found branch (`if (!booking || booking.deletedAt)`) ABOVE its 403 — so a
 * caller with no claim on the booking got `403` while it was live and `404` the
 * moment an admin deleted it. That is exactly the discrimination the ordering
 * exists to prevent, and this route was cited as the model to copy.
 *
 * The fixtures use the only shape production can emit: a soft-deleted booking is
 * always `CANCELLED` (`INV-ADDPAY-030`) and `deletedAt` is never cleared.
 *
 * `@/lib/access-roles` is deliberately UN-mocked so real role resolution decides
 * who reaches the write: the booking's owner and a Full Admin (`hasAdminAccess`).
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindUnique: vi.fn(),
  issueSplitGuestPaymentLink: vi.fn(),
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
  },
}));
vi.mock("@/lib/payment-link-split-guest", () => ({
  issueSplitGuestPaymentLink: (...args: unknown[]) =>
    mocks.issueSplitGuestPaymentLink(...args),
}));

import { POST } from "@/app/api/bookings/[id]/send-guest-payment-link/route";

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
 * The parent booking as this route selects it, with one genuine split child so
 * a leaked-through request would actually try to mint and email a live token.
 */
function parentBooking(deletedAt: Date | null) {
  return {
    memberId: "member-1",
    deletedAt,
    linkedBookings: [{ id: "child-1" }],
  };
}

function callRoute() {
  return POST(
    new NextRequest(
      "http://localhost/api/bookings/booking-1/send-guest-payment-link",
      { method: "POST" },
    ),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  // The send is armed to EXPLODE, so a refusal that leaked through fails loudly
  // on the write rather than quietly returning the wrong status.
  mocks.issueSplitGuestPaymentLink.mockImplementation(() => {
    throw new Error(
      "issueSplitGuestPaymentLink must never run on a soft-deleted booking",
    );
  });
});

describe("POST /api/bookings/[id]/send-guest-payment-link — deletion guard ordering (#2674)", () => {
  it("still answers 403, not 404, to a caller with no claim on a DELETED booking", async () => {
    mocks.auth.mockResolvedValue(STRANGER);
    mocks.bookingFindUnique.mockResolvedValue(parentBooking(DELETED_AT));

    const res = await callRoute();

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.issueSplitGuestPaymentLink).not.toHaveBeenCalled();
  });

  it("gives that same stranger the same 403 on a booking that is NOT deleted", async () => {
    // The other half of the oracle argument: the unauthorised answer must not
    // move with the booking's deletion state. Together with the case above,
    // restoring `if (!booking || booking.deletedAt)` fails this pair.
    mocks.auth.mockResolvedValue(STRANGER);
    mocks.bookingFindUnique.mockResolvedValue(parentBooking(null));

    const res = await callRoute();

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.issueSplitGuestPaymentLink).not.toHaveBeenCalled();
  });

  it.each([
    ["the booking's owner", OWNER],
    ["a Full Admin", FULL_ADMIN],
  ])(
    "refuses with 404 for %s once the caller IS authorised",
    async (_who, session) => {
      mocks.auth.mockResolvedValue(session);
      mocks.bookingFindUnique.mockResolvedValue(parentBooking(DELETED_AT));

      const res = await callRoute();

      expect(res.status).toBe(404);
      // Byte-identical to the not-found body below, so an authorised caller
      // cannot tell a deleted booking from one that never existed.
      await expect(res.json()).resolves.toEqual({ error: "Booking not found" });
      expect(mocks.issueSplitGuestPaymentLink).not.toHaveBeenCalled();
    },
  );

  it("answers the same 404 body when the booking does not exist at all", async () => {
    mocks.auth.mockResolvedValue(OWNER);
    mocks.bookingFindUnique.mockResolvedValue(null);

    const res = await callRoute();

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Booking not found" });
  });

  // The complement. Without it the suite would be satisfied by a route that
  // refused everything, which is not the fix.
  it.each([
    ["the booking's owner", OWNER],
    ["a Full Admin", FULL_ADMIN],
  ])("still sends on an identical booking that is NOT deleted, for %s", async (
    _who,
    session,
  ) => {
    mocks.auth.mockResolvedValue(session);
    mocks.bookingFindUnique.mockResolvedValue(parentBooking(null));
    mocks.issueSplitGuestPaymentLink.mockResolvedValue({ outcome: "sent" });

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.issueSplitGuestPaymentLink).toHaveBeenCalledWith("child-1");
  });
});
