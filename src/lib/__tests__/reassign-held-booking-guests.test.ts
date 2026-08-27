import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgeTier } from "@prisma/client";

// booking-request.ts creates a PrismaClient at import time; stub it so importing
// the module under test never touches a real database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { requireClubTimeZone } from "@/lib/club-time";
import { reassignHeldBookingGuests } from "@/lib/booking-request";
import type { MemberGuestAddPolicy } from "@/lib/member-guest-add-policy";

/**
 * The transaction double.
 *
 * `familyGroupMember` and `member` are here because MG4 (#2309) computes the
 * family boundary inside this function: the held booking's owner is a non-login
 * contact in no family group, so both reads legitimately come back empty and
 * every linked member classifies BEYOND_FAMILY. Returning empty arrays is the
 * REAL production shape, not a shortcut — see `computeMemberGuestBoundary`.
 */
function makeTx() {
  let createdCount = 0;
  return {
    bookingGuest: {
      findMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      // #2739: the recreate fallback creates one row at a time, because its
      // night rows need the id each create hands back.
      create: vi.fn().mockImplementation(async () => {
        createdCount += 1;
        return { id: `new-${createdCount}`, memberId: null };
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    // #2739: night rows are written for the whole party in one batch, keyed by
    // the guest ids the branch above already holds.
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    member: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

/** The two nights of the default envelope, priced 2500 each of the 5000 total. */
const defaultNights = (priceCents = 5000) => [
  { stayDate: new Date("2026-08-01T00:00:00.000Z"), priceCents: Math.ceil(priceCents / 2) },
  { stayDate: new Date("2026-08-02T00:00:00.000Z"), priceCents: Math.floor(priceCents / 2) },
];

const guest = (overrides: Record<string, unknown> = {}) => ({
  firstName: "Tara",
  lastName: "Tester",
  ageTier: AgeTier.ADULT,
  isMember: false,
  memberId: undefined,
  stayStart: new Date("2026-08-01T00:00:00.000Z"),
  stayEnd: new Date("2026-08-03T00:00:00.000Z"),
  priceCents: 5000,
  nights: defaultNights(
    typeof overrides.priceCents === "number" ? overrides.priceCents : 5000,
  ),
  ...overrides,
});

const MODULE_ON: MemberGuestAddPolicy = {
  wideningEnabled: true,
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
  // A club behind Greenwich, so the fixture cannot pass by reading the
  // container's zone — which is `Pacific/Auckland` here (#3123).
  timeZone: requireClubTimeZone("America/Denver"),
};
const MODULE_OFF: MemberGuestAddPolicy = {
  wideningEnabled: false,
  approvalRequired: true,
  pendingHoldExpiryDays: 0,
};

const NOW = new Date("2026-07-01T09:00:00.000Z");

const memberGuest = (policy: MemberGuestAddPolicy = MODULE_ON) => ({
  bookingOwnerMemberId: "owner-1",
  actor: { kind: "BOOKING_REQUEST" as const, adminMemberId: "admin-1" },
  policy,
  bookingCheckIn: new Date("2026-08-01T00:00:00.000Z"),
  now: NOW,
});

describe("reassignHeldBookingGuests (issue #1254 bed preservation)", () => {
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
  });

  it("updates the existing rows in place (stable ids) when counts match", async () => {
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: null, consentStatus: null },
      { id: "g2", memberId: "m-1", consentStatus: "CONFIRMED" },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [
        guest({ priceCents: 3000 }),
        guest({ firstName: "Sam", isMember: true, memberId: "m-1", priceCents: 7000 }),
      ],
      memberGuest(),
    );

    expect(result.preservedInPlace).toBe(true);
    expect(result.displacedMemberIds).toEqual([]);
    // No destructive delete — that is what preserves BedAllocation / #713 nights /
    // promo targets / chores that cascade off bookingGuest ids.
    expect(tx.bookingGuest.deleteMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.createMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.update).toHaveBeenCalledTimes(2);
    expect(tx.bookingGuest.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({ priceCents: 3000, memberId: null }),
      })
    );
    expect(tx.bookingGuest.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "g2" },
        data: expect.objectContaining({ memberId: "m-1", isMember: true }),
      })
    );
  });

  it("falls back to delete+recreate when the row count diverges", async () => {
    tx.bookingGuest.findMany.mockResolvedValueOnce([
      { id: "g1", memberId: null, consentStatus: null },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest(), guest({ firstName: "Sam" })],
      memberGuest(),
    );

    expect(result.preservedInPlace).toBe(false);
    expect(tx.bookingGuest.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "held-1" },
    });
    // #2739: one create per guest, because each guest's night rows need the id
    // that create hands back — matching read-back rows to their inputs would
    // rest on an ordering `createMany` does not promise. The NIGHTS are then
    // written for the whole party in one batch, so the statement count stays
    // O(guests) inside the approval transaction.
    expect(tx.bookingGuest.createMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.create).toHaveBeenCalledTimes(2);
    expect(tx.bookingGuest.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ firstName: "Tara" }),
      }),
    );
    expect(tx.bookingGuestNight.createMany).toHaveBeenCalledTimes(1);
    expect(tx.bookingGuestNight.createMany).toHaveBeenCalledWith({
      data: [
        ...defaultNights().map((night) => ({ bookingGuestId: "new-1", ...night })),
        ...defaultNights().map((night) => ({ bookingGuestId: "new-2", ...night })),
      ],
    });
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("re-syncs the night set on the in-place path (#2739)", async () => {
    // The whole point of the delete-then-create: an officer may accept a
    // different quote option than the hold was taken at, so night rows left over
    // from the hold would price a stay nobody agreed to. Beds are untouched —
    // BedAllocation keys on bookingGuestId + stayDate, not on a night row's id.
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: null, consentStatus: null },
    ]);

    await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ priceCents: 9000 })],
      memberGuest(),
    );

    expect(tx.bookingGuestNight.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: { in: ["g1"] } },
    });
    expect(tx.bookingGuestNight.createMany).toHaveBeenCalledWith({
      data: defaultNights(9000).map((night) => ({
        bookingGuestId: "g1",
        ...night,
      })),
    });
    // The guest ROWS survive — that is what #1254's bed preservation rests on.
    expect(tx.bookingGuest.deleteMany).not.toHaveBeenCalled();
  });
});

describe("reassignHeldBookingGuests — MG4-D-b consent stamping (#2309)", () => {
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
  });

  it("stamps a cross-family member link CONFIRMED against the approving officer, and owes them a notice", async () => {
    // The row was created by the hold with no member on it, so nobody has been
    // told anything yet: this approval is the moment Sam is placed.
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: null, consentStatus: null },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sam", isMember: true, memberId: "m-sam" })],
      memberGuest(),
    );

    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({
          memberId: "m-sam",
          // ADMIN_ASSIGNED: consent-free, immediately CONFIRMED, naming the
          // officer who stood behind it. NOT a PENDING request — MG4-D-b.
          consentStatus: "CONFIRMED",
          consentRequestedAt: null,
          consentRespondedAt: NOW,
          consentRespondedByMemberId: "admin-1",
          consentExpiresAt: null,
        }),
      })
    );
    expect(result.memberGuestNotificationRows).toEqual([
      { bookingGuestId: "g1", targetMemberId: "m-sam", notification: "ADDED_NOTICE" },
    ]);
  });

  it("tells BOTH people when one member guest is substituted for another in place", async () => {
    // The subtle case: the row id is preserved, so nothing about the write
    // looks like a removal — but the person on it has changed.
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: "m-priya", consentStatus: "CONFIRMED" },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sione", isMember: true, memberId: "m-sione" })],
      memberGuest(),
    );

    expect(result.preservedInPlace).toBe(true);
    // The newcomer is told they are on it...
    expect(result.memberGuestNotificationRows).toEqual([
      { bookingGuestId: "g1", targetMemberId: "m-sione", notification: "ADDED_NOTICE" },
    ]);
    // ...and the person quietly swapped out is told they are not.
    expect(result.displacedMemberIds).toEqual(["m-priya"]);
  });

  it("does not tell a member twice when the swap leaves them exactly where they were", async () => {
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: "m-sam", consentStatus: "CONFIRMED" },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sam", isMember: true, memberId: "m-sam" })],
      memberGuest(),
    );

    // The columns are still re-stamped — the approval-time list is
    // authoritative — but Sam was told at hold time and is not told again.
    expect(result.memberGuestNotificationRows).toEqual([]);
    expect(result.displacedMemberIds).toEqual([]);
  });

  it("clears a stale consent record when a row is reused for somebody who was never asked", async () => {
    // Module OFF: no consent columns are planned for the incoming row. The row
    // being reused carries the previous occupant's CONFIRMED, and leaving it
    // there would claim consent for a person who was never asked and never told.
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: "m-priya", consentStatus: "CONFIRMED" },
    ]);

    await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sione", isMember: true, memberId: "m-sione" })],
      memberGuest(MODULE_OFF),
    );

    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: "m-sione",
          consentStatus: null,
          consentRequestedAt: null,
          consentRespondedAt: null,
          consentRespondedByMemberId: null,
          consentExpiresAt: null,
        }),
      })
    );
  });

  it("PRESERVES a notified member's consent record when the module is switched off mid-flight", async () => {
    // THE BUG THIS PINS, and it needs no unusual data to reach — just an
    // officer turning the module off between the hold and the approval.
    //
    // With the module off the planner returns every guest untouched, so it
    // plans no consent columns for ANY row. The clear used to be unconditional,
    // which meant an approval silently wiped the CONFIRMED record of a member
    // who had already been emailed at hold time to say they were on this
    // booking. The row then reads as an ordinary family guest: no trace of who
    // stood behind the add, and the badge, the audit and the withdrawal notice
    // all lose the one column they key on.
    //
    // Switching a feature off must stop it doing new things, not rewrite what
    // it already did. The occupant here is UNCHANGED, so the existing columns
    // still describe this person and are left exactly alone — not rewritten,
    // not cleared. (The substitution case directly above still clears, which is
    // the other half of the same rule.)
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: "m-sam", consentStatus: "CONFIRMED" },
    ]);

    await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sam", isMember: true, memberId: "m-sam" })],
      memberGuest(MODULE_OFF),
    );

    const data = tx.bookingGuest.update.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    // ABSENT, not null-valued: an explicit `consentStatus: null` in the update
    // is precisely the wipe this test exists to forbid.
    expect(data).not.toHaveProperty("consentStatus");
    expect(data).not.toHaveProperty("consentRequestedAt");
    expect(data).not.toHaveProperty("consentRespondedAt");
    expect(data).not.toHaveProperty("consentRespondedByMemberId");
    expect(data).not.toHaveProperty("consentExpiresAt");
    // The rest of the row is still re-stamped from the approval-time list.
    expect(data.memberId).toBe("m-sam");
    expect(data.firstName).toBe("Sam");
  });

  it("writes no consent columns and owes no notice while the module is off", async () => {
    tx.bookingGuest.findMany.mockResolvedValue([
      { id: "g1", memberId: null, consentStatus: null },
    ]);

    const result = await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest({ firstName: "Sam", isMember: true, memberId: "m-sam" })],
      memberGuest(MODULE_OFF),
    );

    expect(result.memberGuestNotificationRows).toEqual([]);
    expect(tx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ consentStatus: null }),
      })
    );
  });
});
