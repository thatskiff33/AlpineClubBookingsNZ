import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Issue #1313 (owner-approved option A2): the member-facing booking write routes
// — admin notes and modify — were widened from owner-or-Full-Admin to ALSO
// authorize a Booking Officer (bookings:edit). A plain member and a read-only
// admin (bookings:view only) must still 403; the owner and a Full Admin are
// unchanged. (Cancel is proven in booking-cancel*.test.ts.)
//
// #2621 retired the third route this suite used to cover, PUT/DELETE
// /api/bookings/[id]/arrival-time, along with the expected-arrival-time entry
// itself. Its A2 coverage retires with it; the identical widening is still
// proven here for notes and modify, in `assertBookingModifiable` below, and for
// cancel in booking-cancel*.test.ts, so no authorization class loses its test.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  bookingFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  modifyBookingBatch: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
    mocks.requireActiveSessionUser(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
      update: (...args: unknown[]) => mocks.bookingUpdate(...args),
    },
  },
}));

vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: (...args: unknown[]) => mocks.modifyBookingBatch(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { PUT as putNotes } from "@/app/api/bookings/[id]/notes/route";
import { PUT as putModify } from "@/app/api/bookings/[id]/modify/route";
import { assertBookingModifiable } from "@/lib/booking-modify-validation";
import { ApiError } from "@/lib/api-error";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import type { AppAccessRole } from "@/lib/access-roles";

const OWNER_ID = "owner-1";

// Non-owner sessions across the identity classes the widening cares about.
const OFFICER = {
  user: { id: "officer-1", role: "MEMBER", accessRoles: [{ role: "ADMIN_BOOKINGS" }] },
};
const NON_OWNER_MEMBER = {
  user: { id: "intruder-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const READ_ONLY_ADMIN = {
  user: { id: "readonly-1", role: "MEMBER", accessRoles: [{ role: "ADMIN_READONLY" }] },
};
const FULL_ADMIN = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const OWNER = {
  user: { id: OWNER_ID, role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

function setSession(session: unknown) {
  mocks.auth.mockResolvedValue(session as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
});

describe("PUT /api/bookings/[id]/notes — Booking Officer widening (#1313 A2)", () => {
  beforeEach(() => {
    mocks.bookingFindUnique.mockResolvedValue({
      memberId: OWNER_ID,
      status: "CONFIRMED",
    });
    mocks.bookingUpdate.mockResolvedValue({ id: "booking-1", notes: "Late arrival" });
  });

  function callNotes() {
    return putNotes(
      new NextRequest("http://localhost/api/bookings/booking-1/notes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: "Late arrival" }),
      }),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
  }

  it("authorizes a non-owner Booking Officer (no 403)", async () => {
    setSession(OFFICER);
    const res = await callNotes();
    expect(res.status).toBe(200);
    expect(mocks.bookingUpdate).toHaveBeenCalled();
  });

  it("still forbids a non-owner plain member", async () => {
    setSession(NON_OWNER_MEMBER);
    const res = await callNotes();
    expect(res.status).toBe(403);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("still forbids a read-only admin (bookings:view only)", async () => {
    setSession(READ_ONLY_ADMIN);
    const res = await callNotes();
    expect(res.status).toBe(403);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("leaves the owner and Full Admin unchanged", async () => {
    setSession(OWNER);
    expect((await callNotes()).status).toBe(200);
    setSession(FULL_ADMIN);
    expect((await callNotes()).status).toBe(200);
  });
});

describe("PUT /api/bookings/[id]/modify — role mapping (#1313 A2)", () => {
  beforeEach(() => {
    // The service is mocked: we assert the authorization role the route hands it.
    // (The real authorization happens inside modifyBookingBatch via
    // assertBookingModifiable, covered by the assertBookingModifiable block below.)
    mocks.modifyBookingBatch.mockResolvedValue({
      booking: { id: "booking-1", guests: [], payment: null },
      priceDiffCents: 0,
      changeFeeCents: 0,
      refundAmountCents: 0,
      accountCreditAmountCents: 0,
      additionalAmountCents: 0,
      settlementMethod: null,
      additionalPaymentClientSecret: null,
      stripeRefundId: null,
      promoRemoved: false,
      promoChanged: false,
      choreWarnings: [],
    });
  });

  function callModify() {
    return putModify(
      new NextRequest("http://localhost/api/bookings/booking-1/modify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
  }

  async function actorRoleFor(session: unknown): Promise<string> {
    setSession(session);
    await callModify();
    const call = mocks.modifyBookingBatch.mock.calls.at(-1)?.[0] as {
      actor: { id: string; role: string };
    };
    return call.actor.role;
  }

  it("maps a Booking Officer onto the admin-on-behalf ADMIN role", async () => {
    expect(await actorRoleFor(OFFICER)).toBe("ADMIN");
  });

  it("maps a Full Admin onto ADMIN (unchanged)", async () => {
    expect(await actorRoleFor(FULL_ADMIN)).toBe("ADMIN");
  });

  it("keeps a plain member and a read-only admin at USER (which the service then 403s for a non-owner)", async () => {
    expect(await actorRoleFor(NON_OWNER_MEMBER)).toBe("USER");
    expect(await actorRoleFor(READ_ONLY_ADMIN)).toBe("USER");
  });

  it("keeps the owner at USER (owner authz is by id, not role)", async () => {
    expect(await actorRoleFor(OWNER)).toBe("USER");
  });
});

// The modify route delegates authorization to modifyBookingBatch ->
// assertBookingModifiable, keyed on the role above. Confirm that mapping's
// outcome: an ADMIN actor (a Full Admin OR a bookings:edit officer) modifies a
// booking they do not own; a USER actor (plain member / read-only admin) is
// refused with 403.
describe("assertBookingModifiable authorization outcome (#1313 A2)", () => {
  const nonOwned = { memberId: OWNER_ID, status: "CONFIRMED" } as never;

  // Derive the role exactly as the widened routes do, so this proves the full
  // composition: accessRoles -> bookingManagementAuthorizationRole -> gate.
  const roleFor = (accessRoles: AppAccessRole[]) =>
    bookingManagementAuthorizationRole({ accessRoles });

  it("allows a non-owner actor resolved to ADMIN (Full Admin or Booking Officer)", () => {
    for (const roles of [["ADMIN"], ["ADMIN_BOOKINGS"]] as AppAccessRole[][]) {
      expect(() =>
        assertBookingModifiable(nonOwned, {
          role: roleFor(roles),
          actorId: "someone-else",
        }),
      ).not.toThrow();
    }
  });

  it("forbids a non-owner actor resolved to USER (plain member or read-only admin)", () => {
    for (const roles of [["USER"], ["ADMIN_READONLY"]] as AppAccessRole[][]) {
      let thrown: unknown;
      try {
        assertBookingModifiable(nonOwned, {
          role: roleFor(roles),
          actorId: "someone-else",
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).status).toBe(403);
    }
  });
});
