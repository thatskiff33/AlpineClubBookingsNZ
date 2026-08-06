import { describe, expect, it, vi } from "vitest";

// #2307, owner decision D-12 — the WRITE half, at the manual chokepoint.
//
// Every READ surface already filters unconsented member guests out with
// OPERATIONALLY_PRESENT_GUEST_WHERE, so an officer is never OFFERED one to
// place. The manual write paths, though, take a bookingGuestId straight from
// the request: a pending guest's id typed by hand, replayed from a stale
// browser tab, or carried in a bookmarked range request would have written
// BedAllocation rows that `pruneAllocationsForBooking` sweeps on the very next
// reconcile. The officer's work would vanish and the bed would look free again,
// with nothing anywhere saying why.
//
// `assertGuestAndBedForAllocation` is the one function all three manual paths
// pass through — single night, bulk nights, and the #2251 range path — so these
// pin the refusal at that chokepoint from all three entry points.
//
// Harness mirrors admin-bed-allocation-range.test.ts (#2251/#2286), which pins
// the sibling whole-lodge-hold refusal at the same chokepoint.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodgeBed: {
      findUnique: vi.fn().mockResolvedValue({ room: { lodgeId: "lodge-1" } }),
    },
  },
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

import type { MemberGuestConsentStatus } from "@prisma/client";
import {
  BedAllocationAdminError,
  assignBedRangeWithLocksHeld as assignBedRange,
  manuallyAllocateBedForNightsWithLocksHeld as manuallyAllocateBedForNights,
  manuallyAllocateBedWithLocksHeld as manuallyAllocateBed,
} from "@/lib/admin-bed-allocation";
import { parseDateOnly } from "@/lib/date-only";

function buildGuest(consentStatus: MemberGuestConsentStatus | null) {
  return {
    id: "guest-1",
    bookingId: "booking-1",
    firstName: "Priya",
    lastName: "Kaur",
    stayStart: parseDateOnly("2026-06-01"),
    stayEnd: parseDateOnly("2026-06-06"),
    nights: [],
    memberId: "member-9",
    consentStatus,
    booking: {
      id: "booking-1",
      status: "CONFIRMED",
      deletedAt: null,
      lodgeId: "lodge-1",
      wholeLodgeHold: false,
    },
  };
}

function buildDb(consentStatus: MemberGuestConsentStatus | null) {
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const upsert = vi.fn().mockResolvedValue({ id: "alloc-1" });

  const db = {
    bookingGuest: {
      findUnique: vi.fn().mockResolvedValue(buildGuest(consentStatus)),
    },
    lodgeBed: {
      findUnique: vi.fn().mockResolvedValue({
        id: "bed-1",
        roomId: "room-1",
        name: "Bed One",
        active: true,
        bedType: "SINGLE",
        room: { id: "room-1", name: "Room One", active: true, lodgeId: "lodge-1" },
      }),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({
        member: { firstName: "Own", lastName: "Member", email: "own@example.com" },
      }),
    },
    bedAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      upsert,
      createMany,
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
  };

  return { db, createMany, upsert };
}

const UNCONSENTED: MemberGuestConsentStatus[] = ["PENDING", "DECLINED", "EXPIRED"];

describe("manual bed writes refuse an unconsented member guest (D-12, #2307)", () => {
  for (const consentStatus of UNCONSENTED) {
    it(`refuses a single-night placement for a ${consentStatus} guest, writing nothing`, async () => {
      const { db, upsert } = buildDb(consentStatus);

      await expect(
        manuallyAllocateBed({
          bookingGuestId: "guest-1",
          bedId: "bed-1",
          stayDate: "2026-06-02",
          db: db as never,
        }),
      ).rejects.toThrow(BedAllocationAdminError);

      expect(upsert).not.toHaveBeenCalled();
    });
  }

  it("refuses the bulk-nights path too", async () => {
    const { db, upsert } = buildDb("PENDING");

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: ["2026-06-02", "2026-06-03"],
        db: db as never,
      }),
    ).rejects.toThrow(BedAllocationAdminError);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses the #2251 range path, which is the site the review found unguarded", async () => {
    // The range path opts OUT of the whole-lodge-hold throw so it can report
    // that as its own per-night category. It must not thereby opt out of this
    // one: an unconsented guest is not placeable on ANY night, so the whole
    // range is refused rather than enumerated.
    const { db, createMany } = buildDb("PENDING");

    await expect(
      assignBedRange({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-06-01",
        to: "2026-06-06",
        approvedByMemberId: "admin-1",
        db: db as never,
      }),
    ).rejects.toThrow(BedAllocationAdminError);

    expect(createMany).not.toHaveBeenCalled();
  });

  it("says plainly why, with a state-conflict status", async () => {
    const { db } = buildDb("PENDING");

    await expect(
      manuallyAllocateBed({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDate: "2026-06-02",
        db: db as never,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("has not consented"),
    });
  });

  it("still allows an ordinary guest and a CONFIRMED member guest through", async () => {
    // The trap D-12 warns about: consentStatus is NULL for every non-member
    // guest, every family-scope guest and every row written before this feature
    // existed. A guard written as "not PENDING" would be a no-op in SQL and a
    // wrong answer here, so both allowed values are asserted explicitly.
    for (const consentStatus of [null, "CONFIRMED" as MemberGuestConsentStatus]) {
      const { db, upsert } = buildDb(consentStatus);

      await manuallyAllocateBed({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDate: "2026-06-02",
        db: db as never,
      });

      expect(upsert).toHaveBeenCalledTimes(1);
    }
  });
});
