/**
 * #3232's linked-move offer on the wire, on BOTH date-capable member surfaces.
 *
 * Two things only a route test can show, and both of them have bitten this
 * handler's neighbours before:
 *
 *  - THE 409 REACHES THE MEMBER WHOLE. `SameOwnerCoverageLinkedMoveRequiredError`
 *    extends `ApiError`, so a branch placed below the generic one flattens it to a
 *    bare sentence and drops the code, both state keys, the affected bookings and
 *    the money — leaving the member looking at a refusal with no offer in it. That
 *    is the same positional trap `AdultMemberHostingRequiredError` and the
 *    minimum-stay refusal each carry a comment about on these files.
 *  - THE ANSWER IS ACCEPTED FROM A MEMBER. Every other optional field on the
 *    `modify-dates` schema is an officer's authority over somebody else's booking
 *    and raises the caller to the booking-management role, 403ing a plain member.
 *    This one is the owner deciding about their own two bookings, so gating it the
 *    same way would 403 the only person entitled to answer — and would do it
 *    silently, because the route would look like it had gained the feature.
 *
 * The service is a double here: what the three arms DO is
 * `booking-linked-date-move-service.test.ts`, and what the body CONTAINS is
 * `adult-member-hosting-linked-move.test.ts`. This file is about the seam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  legacyRole: vi.fn(),
  managementRole: vi.fn(),
  modifyBookingWithLinkedMoveSupport: vi.fn(),
  modifyBookingDatesWithLinkedMoveSupport: vi.fn(),
  adminShiftBookingDates: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/access-roles", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  authorizationRoleFromAccessRoles: h.legacyRole,
}));
vi.mock("@/lib/admin-permissions", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  bookingManagementAuthorizationRole: h.managementRole,
}));
// The two entry points the routes dispatch through. Mocked TOGETHER, from one
// factory, because both routes import this module and a factory that named only
// one would leave the other undefined at import.
vi.mock("@/lib/booking-linked-date-move-arms", () => ({
  modifyBookingWithLinkedMoveSupport: h.modifyBookingWithLinkedMoveSupport,
  modifyBookingDatesWithLinkedMoveSupport:
    h.modifyBookingDatesWithLinkedMoveSupport,
}));
vi.mock("@/lib/booking-date-modification-service", () => ({
  adminShiftBookingDates: h.adminShiftBookingDates,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { PUT as PUT_MODIFY } from "@/app/api/bookings/[id]/modify/route";
import { PUT as PUT_MODIFY_DATES } from "@/app/api/bookings/[id]/modify-dates/route";
import {
  SameOwnerCoverageLinkedMoveRequiredError,
  type LinkedMoveQuote,
} from "@/lib/adult-member-hosting-linked-move";

const PRIMARY = "bk-primary-0001";
const DEPENDENT = "bk-dependent-01";
const ACCEPT_KEY = `v1:${"a".repeat(64)}`;
const DECLINE_KEY = `v1:${"b".repeat(64)}`;

function quote(
  overrides: Partial<LinkedMoveQuote> = {},
): LinkedMoveQuote {
  return {
    primary: {
      bookingId: PRIMARY,
      reference: "BK-PRIMA",
      proposedCheckIn: "2026-08-20",
      proposedCheckOut: "2026-08-22",
      priceDiffCents: 2_500,
      changeFeeCents: 1_000,
    },
    linked: [
      {
        bookingId: DEPENDENT,
        reference: "BK-DEPEN",
        lodgeName: "Alpine Lodge",
        uncoveredNights: ["2026-08-10", "2026-08-11"],
        currentCheckIn: "2026-08-10",
        currentCheckOut: "2026-08-12",
        proposedCheckIn: "2026-08-20",
        proposedCheckOut: "2026-08-22",
        priceDiffCents: -1_200,
        changeFeeCents: 1_000,
      },
    ],
    combinedPriceDiffCents: 1_300,
    combinedChangeFeeCents: 2_000,
    combinedAmountDueCents: 3_500,
    combinedRefundCents: 200,
    settlementMethodRequired: true,
    bothChangeFeesCharged: true,
    feasibility: "AVAILABLE",
    ...overrides,
  };
}

function offer(overrides: Partial<LinkedMoveQuote> = {}) {
  return new SameOwnerCoverageLinkedMoveRequiredError(quote(overrides), {
    acceptStateKey: ACCEPT_KEY,
    declineStateKey: DECLINE_KEY,
  });
}

const ANSWER = {
  choice: "MOVE_BOTH" as const,
  acknowledged: true as const,
  stateKey: ACCEPT_KEY,
};

const params = Promise.resolve({ id: PRIMARY });

function req(path: "modify" | "modify-dates", body: unknown) {
  return new NextRequest(`http://localhost/api/bookings/${PRIMARY}/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const DATE_MOVE = { checkIn: "2026-08-20", checkOut: "2026-08-22" };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "member-owner" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  // A plain member on both doors: this offer is only ever raised for the
  // booking's own owner, so that is the case worth testing.
  h.legacyRole.mockReturnValue("USER");
  h.managementRole.mockReturnValue("USER");
  h.modifyBookingWithLinkedMoveSupport.mockResolvedValue({
    booking: { id: PRIMARY },
  });
  h.modifyBookingDatesWithLinkedMoveSupport.mockResolvedValue({
    booking: { id: PRIMARY },
  });
  h.adminShiftBookingDates.mockResolvedValue({ booking: { id: PRIMARY } });
});

const DOORS = [
  {
    name: "PUT /api/bookings/[id]/modify",
    path: "modify" as const,
    handler: PUT_MODIFY,
    service: () => h.modifyBookingWithLinkedMoveSupport,
  },
  {
    name: "PUT /api/bookings/[id]/modify-dates",
    path: "modify-dates" as const,
    handler: PUT_MODIFY_DATES,
    service: () => h.modifyBookingDatesWithLinkedMoveSupport,
  },
];

for (const door of DOORS) {
  describe(`${door.name} — the linked-move offer (#3232)`, () => {
    it("answers the offer whole, with both keys and every figure", async () => {
      door.service().mockRejectedValue(offer());

      const res = await door.handler(req(door.path, DATE_MOVE), { params });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe("SAME_OWNER_COVERAGE_LINKED_MOVE_REQUIRED");
      // The flag a client keys on, rather than matching prose.
      expect(body.requiresLinkedMoveChoice).toBe(true);
      expect(body.acceptStateKey).toBe(ACCEPT_KEY);
      expect(body.declineStateKey).toBe(DECLINE_KEY);
      expect(body.linkedMoveAvailable).toBe(true);
      expect(body.linkedBookings).toHaveLength(1);
      expect(body.linkedBookings[0].bookingId).toBe(DEPENDENT);
      expect(body.linkedBookings[0].uncoveredNights).toEqual([
        "2026-08-10",
        "2026-08-11",
      ]);
      expect(body.combinedAmountDueCents).toBe(3_500);
      expect(body.combinedRefundCents).toBe(200);
      expect(body.combinedChangeFeeCents).toBe(2_000);
      expect(body.settlementMethodRequired).toBe(true);
      expect(body.bothChangeFeesCharged).toBe(true);
      // And it is the OFFER, not a flattened refusal: the generic ApiError branch
      // would have answered `{ error }` alone.
      expect(Object.keys(body)).toContain("primary");
    });

    it("says plainly when there are not beds for both, and still names the booking", async () => {
      door.service().mockRejectedValue(
        offer({
          feasibility: "NO_CAPACITY",
          combinedChangeFeeCents: 1_000,
        }),
      );

      const res = await door.handler(req(door.path, DATE_MOVE), { params });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.feasibility).toBe("NO_CAPACITY");
      expect(body.linkedMoveAvailable).toBe(false);
      // A body with no bookings in it is discarded by the browser's fail-closed
      // reader, which is how this arm became unreachable once already.
      expect(body.linkedBookings).toHaveLength(1);
      expect(body.error).toContain("not enough beds free on the new nights");
    });

    it("dispatches a MOVE_BOTH answer to the shared arms", async () => {
      const res = await door.handler(
        req(door.path, { ...DATE_MOVE, hostingCoverageLinkedMove: ANSWER }),
        { params },
      );

      expect(res.status).toBe(200);
      const call = door.service().mock.calls[0]?.[0] as {
        linkedMove?: typeof ANSWER;
        bookingId: string;
      };
      expect(call.bookingId).toBe(PRIMARY);
      expect(call.linkedMove).toEqual(ANSWER);
    });

    it("dispatches a LEAVE_UNCOVERED answer with the DECLINE key it belongs to", async () => {
      const decline = {
        choice: "LEAVE_UNCOVERED" as const,
        acknowledged: true as const,
        stateKey: DECLINE_KEY,
      };

      const res = await door.handler(
        req(door.path, { ...DATE_MOVE, hostingCoverageLinkedMove: decline }),
        { params },
      );

      expect(res.status).toBe(200);
      const call = door.service().mock.calls[0]?.[0] as {
        linkedMove?: typeof decline;
      };
      expect(call.linkedMove).toEqual(decline);
    });

    it("omits the answer entirely on a first submission", async () => {
      // The absent key must not become `linkedMove: undefined`, which is what the
      // conditional spread is for: the service branches on the field's presence.
      await door.handler(req(door.path, DATE_MOVE), { params });
      const call = door.service().mock.calls[0]?.[0] as Record<string, unknown>;
      expect("linkedMove" in call).toBe(false);
    });

    it("accepts the answer from a PLAIN MEMBER rather than 403ing it", async () => {
      // The whole point: this is the owner's decision about their own two
      // bookings, so it cannot ride the officer-authority gate the other optional
      // fields ride.
      h.managementRole.mockReturnValue("USER");
      h.legacyRole.mockReturnValue("USER");

      const res = await door.handler(
        req(door.path, { ...DATE_MOVE, hostingCoverageLinkedMove: ANSWER }),
        { params },
      );

      expect(res.status).toBe(200);
      expect(door.service()).toHaveBeenCalledTimes(1);
      // And it did not quietly promote them to officer authority either.
      const call = door.service().mock.calls[0]?.[0] as {
        actor: { role: string };
      };
      expect(call.actor.role).toBe("USER");
    });

    for (const [label, answer] of [
      ["an unknown arm", { choice: "MOVE_NEITHER", acknowledged: true, stateKey: ACCEPT_KEY }],
      ["a refused acknowledgement", { choice: "MOVE_BOTH", acknowledged: false, stateKey: ACCEPT_KEY }],
      ["a malformed state key", { choice: "MOVE_BOTH", acknowledged: true, stateKey: "not-a-key" }],
      ["a missing state key", { choice: "MOVE_BOTH", acknowledged: true }],
      ["an unknown extra field", { choice: "MOVE_BOTH", acknowledged: true, stateKey: ACCEPT_KEY, reason: "because" }],
    ] as const) {
      it(`rejects ${label} at the schema, without calling the service`, async () => {
        const res = await door.handler(
          req(door.path, { ...DATE_MOVE, hostingCoverageLinkedMove: answer }),
          { params },
        );

        expect(res.status).toBe(400);
        expect(door.service()).not.toHaveBeenCalled();
      });
    }

    it("resolves the club's day and hands it to the service", async () => {
      // `INV-LOCK-004`: the accepted move drives the transaction-AWARE batch
      // service inside one transaction, so the day has to arrive as a value.
      await door.handler(req(door.path, DATE_MOVE), { params });
      const call = door.service().mock.calls[0]?.[0] as {
        todayAtClub?: unknown;
      };
      expect(call.todayAtClub).toBeDefined();
    });
  });
}

describe("PUT /api/bookings/[id]/modify-dates — the admin flags are unaffected (#3232)", () => {
  it("still 403s an officer-authority flag from a plain member", async () => {
    const res = await PUT_MODIFY_DATES(
      req("modify-dates", { ...DATE_MOVE, notifyMember: false }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(h.modifyBookingDatesWithLinkedMoveSupport).not.toHaveBeenCalled();
  });

  it("still sends a shift override to the shift writer, which raises no offer", async () => {
    // An officer's change is never refused for stranding — it escalates through
    // `REQUIRE_OVERRIDE` — so the shift path is deliberately outside the arms.
    h.managementRole.mockReturnValue("ADMIN");

    const res = await PUT_MODIFY_DATES(
      req("modify-dates", {
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-08-20",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.adminShiftBookingDates).toHaveBeenCalledTimes(1);
    expect(h.modifyBookingDatesWithLinkedMoveSupport).not.toHaveBeenCalled();
  });
});
