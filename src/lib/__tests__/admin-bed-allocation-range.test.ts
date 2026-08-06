import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #2286: assignBedRange resolves the bed's lodge OUTSIDE its transaction so
    // the per-lodge advisory lock can be the first statement inside it.
    lodgeBed: {
      findUnique: vi.fn().mockResolvedValue({ room: { lodgeId: "lodge-1" } }),
    },
  },
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));
// Wrapped, not replaced: the real implementations run, but the range path's
// promise never to ENUMERATE a range it is about to refuse can be asserted.
vi.mock("@/lib/date-only", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/date-only")>("@/lib/date-only");
  return { ...actual, eachDateOnlyInRange: vi.fn(actual.eachDateOnlyInRange) };
});

import { Prisma } from "@prisma/client";
import {
  BedAllocationAdminError,
  MAX_AUDITED_RANGE_PARTNER_PROMOTIONS,
  MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS,
  assignBedRange as assignBedRangePublic,
  assignBedRangeWithLocksHeld as assignBedRange,
  manuallyAllocateBedWithLocksHeld as manuallyAllocateBed,
  summariseNightRuns,
} from "@/lib/admin-bed-allocation";
import { eachDateOnlyInRange, formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

/*
 * Range assignment (#2251). The board's own 31-night window is irrelevant here:
 * these exercise the WRITE path, which is atomic across a range of any length,
 * refuses in four distinct categories (CUSTODIAN_HOLD joined them in #2286),
 * records itself inside its own
 * transaction, and only ever writes a subset the admin explicitly listed.
 */

function buildGuest(
  overrides: Partial<{
    id: string;
    bookingId: string;
    stayStart: string;
    stayEnd: string;
    nights: string[];
    memberId: string | null;
    bookingStatus: string;
    wholeLodgeHold: boolean;
    lodgeId: string | null;
  }> = {},
) {
  return {
    id: overrides.id ?? "guest-1",
    bookingId: overrides.bookingId ?? "booking-1",
    firstName: "Range",
    lastName: "Guest",
    stayStart: parseDateOnly(overrides.stayStart ?? "2026-06-01"),
    stayEnd: parseDateOnly(overrides.stayEnd ?? "2026-06-06"),
    // #713: a non-contiguous stay carries an explicit night set that is NOT the
    // whole stayStart..stayEnd envelope. Absent here means "no night rows", the
    // pre-#713 shape.
    nights: (overrides.nights ?? []).map((stayDate) => ({
      stayDate: parseDateOnly(stayDate),
    })),
    memberId: overrides.memberId ?? null,
    booking: {
      id: overrides.bookingId ?? "booking-1",
      status: overrides.bookingStatus ?? "CONFIRMED",
      deletedAt: null,
      lodgeId: overrides.lodgeId ?? "lodge-1",
      wholeLodgeHold: overrides.wholeLodgeHold ?? false,
    },
  };
}

function buildBed(
  overrides: Partial<{ id: string; bedType: string; lodgeId: string | null }> = {},
) {
  return {
    id: overrides.id ?? "bed-1",
    roomId: "room-1",
    name: "Bed One",
    active: true,
    bedType: overrides.bedType ?? "SINGLE",
    room: {
      id: "room-1",
      name: "Room One",
      active: true,
      lodgeId: overrides.lodgeId ?? "lodge-1",
    },
  };
}

function occupant(
  stayDate: string,
  overrides: Partial<{
    status: string;
    isSecondOccupant: boolean;
    memberId: string | null;
  }> = {},
) {
  return {
    stayDate: parseDateOnly(stayDate),
    isSecondOccupant: overrides.isSecondOccupant ?? false,
    bookingGuest: {
      memberId: overrides.memberId ?? null,
      firstName: "Other",
      lastName: "Guest",
      booking: {
        id: "booking-other",
        status: overrides.status ?? "CONFIRMED",
        originBookingRequest: null,
        adminCapacityHoldAt: null,
        member: {
          firstName: "Other",
          lastName: "Member",
          email: "other@example.com",
        },
      },
    },
  };
}

function buildDb(input: {
  guest?: ReturnType<typeof buildGuest> | null;
  bed?: ReturnType<typeof buildBed> | null;
  occupants?: ReturnType<typeof occupant>[];
  existingRows?: Array<{
    id: string;
    bedId: string;
    stayDate: Date;
    isSecondOccupant: boolean;
  }>;
  ownBookingMemberName?: string;
  // #2286: bed-holding hut-leader assignment rows, as the custodian read
  // returns them. Absent means no hold, which is the pre-#2286 shape.
  holds?: Array<Record<string, unknown>>;
}) {
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const auditCreate = vi.fn().mockResolvedValue({ id: "audit-1" });
  const bookingFindMany = vi.fn().mockResolvedValue([]);
  // findMany is used for the occupant scan (has a bedId filter), the guest's own
  // existing rows (filtered by bookingGuestId), and the batched partner
  // promotion (filtered by isSecondOccupant).
  const bedAllocationFindMany = vi.fn(
    async (args: { where: Record<string, unknown> }) => {
      if ("bedId" in args.where) return input.occupants ?? [];
      if ("isSecondOccupant" in args.where) return [];
      return input.existingRows ?? [];
    },
  );

  const db = {
    bookingGuest: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          input.guest === undefined ? buildGuest() : input.guest,
        ),
    },
    lodgeBed: {
      findUnique: vi
        .fn()
        .mockResolvedValue(input.bed === undefined ? buildBed() : input.bed),
    },
    booking: {
      findMany: bookingFindMany,
      findUnique: vi.fn().mockResolvedValue({
        member: {
          firstName: input.ownBookingMemberName ?? "Own",
          lastName: "Member",
          email: "own@example.com",
        },
      }),
    },
    bedAllocation: {
      findMany: bedAllocationFindMany,
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      createMany,
      updateMany,
    },
    // #2286: the range path classifies custodian-held nights as their own
    // CUSTODIAN_HOLD refusal category. No holds by default, so every refusal
    // below is still the category the test names.
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue(input.holds ?? []),
    },
    // #2286: the range transaction takes the per-lodge advisory lock first.
    $executeRaw: vi.fn().mockResolvedValue(1),
    auditLog: { create: auditCreate },
  };

  return { db, createMany, updateMany, auditCreate, bookingFindMany };
}

function auditEntry(auditCreate: ReturnType<typeof vi.fn>, index = 0) {
  return auditCreate.mock.calls[index][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(eachDateOnlyInRange).mockClear();
});

describe("assignBedRange", () => {
  it("writes every night of a long range in one pass, auto-approved", async () => {
    const { db, createMany, updateMany } = buildDb({
      guest: buildGuest({ stayStart: "2026-06-01", stayEnd: "2026-09-01" }),
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-09-01",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.refusals).toEqual([]);
    // 92 nights — nearly three times the board's read window, written at once.
    expect(result.writtenNights).toHaveLength(92);
    expect(result.writtenNights[0]).toBe("2026-06-01");
    expect(result.writtenNights.at(-1)).toBe("2026-08-31");
    // Batched: one createMany for the whole range, not one write per night.
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();

    const rows = createMany.mock.calls[0][0].data as Array<{
      approvedAt: Date | null;
      approvedByMemberId: string | null;
      source: string;
    }>;
    expect(rows).toHaveLength(92);
    // AUTO-APPROVE (owner decision, 28 Jul 2026).
    expect(rows.every((row) => row.approvedAt instanceof Date)).toBe(true);
    expect(rows.every((row) => row.approvedByMemberId === "admin-1")).toBe(true);
    expect(rows.every((row) => row.source === "MANUAL")).toBe(true);
  });

  it("refuses the WHOLE range and writes nothing when one night's bed is taken", async () => {
    const { db, createMany, updateMany } = buildDb({
      occupants: [occupant("2026-06-03")],
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(result.writtenNights).toEqual([]);
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(result.refusals).toEqual([
      {
        stayDate: "2026-06-03",
        category: "BED_TAKEN",
        occupiedBy: {
          guestName: "Other Guest",
          memberName: "Other Member",
          bookingId: "booking-other",
          holdsCapacity: true,
        },
      },
    ]);
    // The four other nights are free and can be offered as the second action.
    expect(result.freeNights).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-04",
      "2026-06-05",
    ]);
  });

  it("counts a provisional occupant as a conflict, flagged as not holding", async () => {
    const { db } = buildDb({
      occupants: [occupant("2026-06-02", { status: "PAYMENT_PENDING" })],
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(result.refusals[0].category).toBe("BED_TAKEN");
    // Provisional: it does not hold the night, but nothing is overwritten.
    expect(result.refusals[0].occupiedBy?.holdsCapacity).toBe(false);
  });

  it("reports nights the guest is not booked as their own category, never skipped", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({ stayStart: "2026-06-01", stayEnd: "2026-06-04" }),
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
    expect(result.refusals).toEqual([
      { stayDate: "2026-06-04", category: "GUEST_NOT_BOOKED" },
      { stayDate: "2026-06-05", category: "GUEST_NOT_BOOKED" },
    ]);
  });

  // #713: stayStart..stayEnd is only an ENVELOPE. A guest booked 1-5 and 8-10
  // is not booked on the 6th or 7th, and the lifecycle prunes any row placed
  // there — so the range path must refuse those nights rather than write rows
  // that quietly vanish at the next reconcile.
  it("refuses the gap nights of a non-contiguous stay", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({
        stayStart: "2026-06-01",
        stayEnd: "2026-06-11",
        nights: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
          "2026-06-08",
          "2026-06-09",
          "2026-06-10",
        ],
      }),
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-11",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
    expect(result.refusals).toEqual([
      { stayDate: "2026-06-06", category: "GUEST_NOT_BOOKED" },
      { stayDate: "2026-06-07", category: "GUEST_NOT_BOOKED" },
    ]);
    expect(result.freeNights).not.toContain("2026-06-06");
    expect(result.freeNights).not.toContain("2026-06-07");
  });

  it("refuses every night when the guest's OWN booking holds the whole lodge", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({ wholeLodgeHold: true }),
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
    expect(result.refusals).toHaveLength(5);
    expect(
      result.refusals.every(
        (refusal) =>
          refusal.category === "EXCLUSIVE_HOLD" &&
          refusal.hold?.ownBooking === true,
      ),
    ).toBe(true);
    // Nothing is free, so the "assign the free nights" action has nothing to do.
    expect(result.freeNights).toEqual([]);
  });

  /*
   * ADR-001's bed-allocation short-circuit is scoped to the HELD booking's own
   * guests. The planner, the auto-allocator and the single-night/bulk manual
   * paths all still place an ORDINARY booking on a bed across someone else's
   * hold, and the hold-set flow surfaces such bookings as conflicts rather than
   * refusing them. This endpoint must not be the only place in the domain where
   * that is a hard block (#2251 review) — the board's overlapsExclusiveHold
   * badge remains how another booking's hold is surfaced.
   */
  it("does not refuse, or even look for, ANOTHER booking's overlapping hold", async () => {
    const { db, createMany, bookingFindMany } = buildDb({});

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(createMany).toHaveBeenCalledTimes(1);
    // No overlapping-hold scan is issued at all.
    expect(bookingFindMany).not.toHaveBeenCalled();
  });

  // One category per night, resolved in a fixed precedence so the report can
  // never be ambiguous: a held booking's night says EXCLUSIVE_HOLD even when
  // the guest is also not booked and the bed is also taken.
  it("resolves one category per night: EXCLUSIVE_HOLD > GUEST_NOT_BOOKED > BED_TAKEN", async () => {
    const held = buildDb({
      guest: buildGuest({
        wholeLodgeHold: true,
        stayStart: "2026-06-01",
        stayEnd: "2026-06-03",
      }),
      occupants: [occupant("2026-06-01"), occupant("2026-06-04")],
    });

    const heldResult = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: held.db as never,
    });

    expect(
      heldResult.refusals.map((refusal) => refusal.category),
    ).toEqual([
      "EXCLUSIVE_HOLD",
      "EXCLUSIVE_HOLD",
      "EXCLUSIVE_HOLD",
      "EXCLUSIVE_HOLD",
      "EXCLUSIVE_HOLD",
    ]);

    // Without a hold, a night that is BOTH unbooked and taken reports as the bad
    // request, because that is the mistake worth telling the admin about.
    const ordinary = buildDb({
      guest: buildGuest({ stayStart: "2026-06-01", stayEnd: "2026-06-03" }),
      occupants: [occupant("2026-06-02"), occupant("2026-06-04")],
    });

    const ordinaryResult = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: ordinary.db as never,
    });

    expect(ordinaryResult.refusals).toEqual([
      {
        stayDate: "2026-06-02",
        category: "BED_TAKEN",
        occupiedBy: expect.objectContaining({ bookingId: "booking-other" }),
      },
      { stayDate: "2026-06-03", category: "GUEST_NOT_BOOKED" },
      { stayDate: "2026-06-04", category: "GUEST_NOT_BOOKED" },
      { stayDate: "2026-06-05", category: "GUEST_NOT_BOOKED" },
    ]);
  });

  it("writes exactly the nights the admin listed, and still reports the refusals", async () => {
    const { db, createMany } = buildDb({
      occupants: [occupant("2026-06-03")],
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      nights: ["2026-06-01", "2026-06-02", "2026-06-04", "2026-06-05"],
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.partialByConsent).toBe(true);
    expect(result.writtenNights).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-04",
      "2026-06-05",
    ]);
    // The refusal is still carried, so one audit entry records both halves.
    expect(result.refusals).toHaveLength(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(4);
  });

  /*
   * The consent contract (#2251 review A6/B5). The admin approved a specific
   * list of nights; between the report and the click the world can move. The
   * server must not quietly write a smaller set, and must not write a night the
   * admin never saw — it refuses with a fresh report instead.
   */
  it("refuses the listed nights outright, writing nothing, when one has since been taken", async () => {
    const { db, createMany, updateMany } = buildDb({
      occupants: [occupant("2026-06-02")],
    });

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      // The admin was shown 06-02 as free; it is not any more.
      nights: ["2026-06-01", "2026-06-02"],
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(result.writtenNights).toEqual([]);
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    // A FRESH report over the whole range, not the stale one they clicked from.
    expect(result.refusals).toEqual([
      {
        stayDate: "2026-06-02",
        category: "BED_TAKEN",
        occupiedBy: expect.objectContaining({ bookingId: "booking-other" }),
      },
    ]);
  });

  it("never writes a night outside the list, even when the rest of the range is free", async () => {
    const { db, createMany } = buildDb({});

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      nights: ["2026-06-02"],
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.writtenNights).toEqual(["2026-06-02"]);
    expect(createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("rejects a listed night that is not inside the requested range", async () => {
    const { db, createMany } = buildDb({});

    await expect(
      assignBedRange({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-06-01",
        to: "2026-06-06",
        approvedByMemberId: "admin-1",
        nights: ["2026-06-02", "2026-07-14"],
        db: db as never,
      }),
    ).rejects.toThrow("not all inside the requested range");
    expect(createMany).not.toHaveBeenCalled();
  });

  it("moves the guest off an old bed and promotes the partner stranded there", async () => {
    const { db, updateMany, createMany } = buildDb({
      existingRows: [
        {
          id: "allocation-1",
          bedId: "bed-old",
          stayDate: parseDateOnly("2026-06-02"),
          isSecondOccupant: false,
        },
      ],
    });
    // The batched promoter: ONE findMany over every vacated bed-night, then one
    // updateMany — never a lookup per night.
    db.bedAllocation.findMany = vi.fn(
      async (args: { where: Record<string, unknown> }) => {
        if ("bedId" in args.where) return [];
        if ("isSecondOccupant" in args.where) {
          return [
            {
              id: "partner-1",
              isSecondOccupant: true,
              bedId: "bed-old",
              bookingId: "booking-other",
              stayDate: parseDateOnly("2026-06-02"),
            },
          ];
        }
        return [
          {
            id: "allocation-1",
            bedId: "bed-old",
            stayDate: parseDateOnly("2026-06-02"),
            isSecondOccupant: false,
          },
        ];
      },
    ) as never;

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(true);
    // One night already existed (moved via updateMany), four are new.
    expect(updateMany.mock.calls[0][0].where.id.in).toEqual(["allocation-1"]);
    expect(createMany.mock.calls[0][0].data).toHaveLength(4);
    expect(result.promotedPartners).toEqual([
      expect.objectContaining({ id: "partner-1", isSecondOccupant: false }),
    ]);
    // The promotion flip is one updateMany, alongside the write batch.
    expect(
      updateMany.mock.calls.some(
        (call) => call[0].data?.isSecondOccupant === false && !call[0].data?.bedId,
      ),
    ).toBe(true);
  });

  it("refuses a range over the assignment cap rather than truncating it", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({ stayStart: "2026-01-01", stayEnd: "2028-01-01" }),
    });

    await expect(
      assignBedRange({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-01-01",
        to: "2027-06-01",
        approvedByMemberId: "admin-1",
        db: db as never,
      }),
    ).rejects.toThrow(
      `A range assignment covers at most ${MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS} nights`,
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  /*
   * An absurd span must be refused ARITHMETICALLY (#2251 review C2). Building
   * the night list first to discover it is too long means ~2.9 million Date
   * objects per request — a denial of service any admin can trigger with a
   * slipped keystroke in a date field.
   */
  it("refuses an absurd span WITHOUT enumerating it, and before touching the database", async () => {
    const { db } = buildDb({});

    await expect(
      assignBedRange({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-01-01",
        to: "9999-12-31",
        approvedByMemberId: "admin-1",
        db: db as never,
      }),
    ).rejects.toThrow(
      `A range assignment covers at most ${MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS} nights`,
    );

    expect(eachDateOnlyInRange).not.toHaveBeenCalled();
    // Validation happens before the guest/bed lookups, so no connection is held
    // while a nonsense range is being refused.
    expect(db.bookingGuest.findUnique).not.toHaveBeenCalled();
    expect(db.lodgeBed.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a range whose date out is not after its date in", async () => {
    const { db } = buildDb({});

    await expect(
      assignBedRange({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-06-06",
        to: "2026-06-06",
        approvedByMemberId: "admin-1",
        db: db as never,
      }),
    ).rejects.toThrow(BedAllocationAdminError);
  });

  it("allows a partner to share a double across the range as a second occupant", async () => {
    const { db, createMany } = buildDb({
      guest: buildGuest({ memberId: "member-b" }),
      bed: buildBed({ bedType: "DOUBLE" }),
      occupants: [
        occupant("2026-06-01", { memberId: "member-a" }),
        occupant("2026-06-02", { memberId: "member-a" }),
      ],
    });
    // Partner eligibility is asked ONCE for every distinct occupant, batched, so
    // the statement count does not grow with the range length.
    const memberFindMany = vi.fn().mockResolvedValue([
      { id: "member-a", ageTier: "ADULT", active: true },
      { id: "member-b", ageTier: "ADULT", active: true },
    ]);
    const linkFindMany = vi
      .fn()
      .mockResolvedValue([{ memberAId: "member-a", memberBId: "member-b" }]);
    (db as unknown as Record<string, unknown>).member = {
      findMany: memberFindMany,
    };
    (db as unknown as Record<string, unknown>).memberPartnerLink = {
      findMany: linkFindMany,
    };

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(memberFindMany).toHaveBeenCalledTimes(1);
    expect(linkFindMany).toHaveBeenCalledTimes(1);
    // Two batches: the shared nights as second occupant, the rest as primary.
    const written = createMany.mock.calls.flatMap(
      (call) =>
        call[0].data as Array<{ stayDate: Date; isSecondOccupant: boolean }>,
    );
    const shared = written
      .filter((row) => row.isSecondOccupant)
      .map((row) => formatDateOnly(row.stayDate))
      .sort();
    expect(shared).toEqual(["2026-06-01", "2026-06-02"]);
    expect(written).toHaveLength(5);
  });
});

/*
 * The audit row is written on the SAME client as the allocation rows (#2251
 * review A4/C5): a committed range can never surface as an unrecorded 500, and a
 * rolled-back one can never leave a record claiming it happened.
 */
describe("assignBedRange audit record", () => {
  it("records ONE entry against the booking, on the same client as the writes", async () => {
    const { db, auditCreate } = buildDb({});

    await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const entry = auditEntry(auditCreate);
    expect(entry.action).toBe("BED_ALLOCATION_RANGE_SET");
    // The booking page's audit deep link matches targetId, never metadata.
    expect(entry.targetId).toBe("booking-1");
    expect(entry.outcome).toBe("success");
    expect(entry.metadata).toMatchObject({
      requestedNightCount: 5,
      writtenNightCount: 5,
      writtenNightRuns: ["2026-06-01 → 2026-06-05"],
      refusedNightCount: 0,
      autoApproved: true,
      partialByConsent: false,
    });
  });

  it("records the refusal too, as a failure, with counts and runs but NO names", async () => {
    const { db, auditCreate } = buildDb({
      occupants: [occupant("2026-06-02"), occupant("2026-06-03")],
    });

    await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const entry = auditEntry(auditCreate);
    expect(entry.outcome).toBe("failure");
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      refusedNightCount: 2,
      refusedNightCountsByCategory: {
        EXCLUSIVE_HOLD: 0,
        GUEST_NOT_BOOKED: 0,
        BED_TAKEN: 2,
      },
      refusedNightRunsByCategory: {
        EXCLUSIVE_HOLD: [],
        GUEST_NOT_BOOKED: [],
        BED_TAKEN: ["2026-06-02 → 2026-06-03"],
      },
      involvedBookingIds: ["booking-other"],
    });
    // Data minimisation (#2251 review C6): up to 366 refusals could otherwise
    // file a roster of unrelated members' names into an admin audit row. The
    // names travel in the API response to the admin who asked, not into storage.
    const serialised = JSON.stringify(metadata);
    expect(serialised).not.toContain("Other Guest");
    expect(serialised).not.toContain("Other Member");
    expect(serialised).not.toContain("Range Guest");
  });

  /*
   * #2251 residual R4. Partner promotions used to be audited one row per
   * promotion, which is the one thing in this transaction that still grew with
   * the range length: a 366-night move off shared doubles would write 366 audit
   * rows inside it. One batched entry replaces them, following the #2285 prune's
   * shape — a compact list capped at the audit sanitiser's array limit, the exact
   * count, and a flag saying the list is partial.
   */
  it("records ONE batched partner-promotion entry, never one per promotion", async () => {
    const { db, auditCreate } = buildDb({
      existingRows: [
        {
          id: "allocation-1",
          bedId: "bed-old",
          stayDate: parseDateOnly("2026-06-02"),
          isSecondOccupant: false,
        },
      ],
    });
    db.bedAllocation.findMany = vi.fn(
      async (args: { where: Record<string, unknown> }) => {
        if ("bedId" in args.where) return [];
        if ("isSecondOccupant" in args.where) {
          return [
            {
              id: "partner-1",
              isSecondOccupant: true,
              bedId: "bed-old",
              bookingId: "booking-other",
              bookingGuestId: "guest-other",
              stayDate: parseDateOnly("2026-06-02"),
            },
          ];
        }
        return [
          {
            id: "allocation-1",
            bedId: "bed-old",
            stayDate: parseDateOnly("2026-06-02"),
            isSecondOccupant: false,
          },
        ];
      },
    ) as never;

    await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    // The range entry plus ONE promotion entry — the whole transaction's audit
    // row count, whatever the night count.
    expect(auditCreate).toHaveBeenCalledTimes(2);
    expect(auditEntry(auditCreate, 0).action).toBe("BED_ALLOCATION_RANGE_SET");
    const entry = auditEntry(auditCreate, 1);
    expect(entry.action).toBe("BED_ALLOCATION_PARTNERS_PROMOTED");
    // Targeted at the booking whose assignment caused it; the promoted partner's
    // own booking is named inside the list, because it may be a different one.
    expect(entry.targetId).toBe("booking-1");
    expect(entry.outcome).toBe("success");
    // The promoted partner's OWN booking must still be able to find this entry:
    // the admin audit search reads details/targetId, never metadata.
    expect(entry.details).toBe("Promoted partner bookings: booking-other");
    expect(entry.metadata).toMatchObject({
      // Named distinctly from each promotion's own bookingGuestId: the guest who
      // moved is not the partner who was promoted.
      movedBookingGuestId: "guest-1",
      movedToBedId: "bed-1",
      promotedCount: 1,
      promotionsTruncated: false,
      promotions: [
        {
          allocationId: "partner-1",
          bookingId: "booking-other",
          bookingGuestId: "guest-other",
          bedId: "bed-old",
          stayDate: "2026-06-02",
        },
      ],
    });
    // The per-promotion action stays the single-night/bulk board paths' shape.
    for (const call of auditCreate.mock.calls) {
      expect(call[0].data.action).not.toBe("BED_ALLOCATION_PARTNER_PROMOTED");
    }
  });

  it("caps the batched promotion list and says the list is partial", async () => {
    const nights = eachDateOnlyInRange(
      parseDateOnly("2026-06-01"),
      parseDateOnly("2026-07-31"),
    ).map(formatDateOnly);
    expect(nights).toHaveLength(60);

    const existingRows = nights.map((stayDate, index) => ({
      id: `allocation-${index}`,
      bedId: "bed-old",
      stayDate: parseDateOnly(stayDate),
      isSecondOccupant: false,
    }));
    const partners = nights.map((stayDate, index) => ({
      id: `partner-${index}`,
      isSecondOccupant: true,
      bedId: "bed-old",
      bookingId: `booking-partner-${index}`,
      bookingGuestId: `guest-partner-${index}`,
      stayDate: parseDateOnly(stayDate),
    }));

    const { db, auditCreate } = buildDb({
      guest: buildGuest({ stayStart: "2026-06-01", stayEnd: "2026-09-01" }),
      existingRows,
    });
    db.bedAllocation.findMany = vi.fn(
      async (args: { where: Record<string, unknown> }) => {
        if ("bedId" in args.where) return [];
        if ("isSecondOccupant" in args.where) return partners;
        return existingRows;
      },
    ) as never;

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-07-31",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.promotedPartners).toHaveLength(60);
    // Sixty promotions, still exactly two audit rows.
    expect(auditCreate).toHaveBeenCalledTimes(2);
    const metadata = auditEntry(auditCreate, 1).metadata as Record<
      string,
      unknown
    >;
    expect(metadata.promotedCount).toBe(60);
    expect(metadata.promotionsTruncated).toBe(true);
    // The searchable details string is capped too, and says how many bookings it
    // could not repeat rather than dropping them silently.
    const details = auditEntry(auditCreate, 1).details as string;
    expect(details).toContain("booking-partner-0");
    expect(details).toContain("(+30 more in metadata.promotions)");
    expect(details.length).toBeLessThanOrEqual(1000);
    const promotions = metadata.promotions as Record<string, unknown>[];
    // Capped at the audit sanitiser's array limit: listing more would not be
    // preserved and could cost the entries that DO fit.
    expect(promotions).toHaveLength(MAX_AUDITED_RANGE_PARTNER_PROMOTIONS);
    expect(promotions[0]).toEqual({
      allocationId: "partner-0",
      bookingId: "booking-partner-0",
      bookingGuestId: "guest-partner-0",
      bedId: "bed-old",
      stayDate: "2026-06-01",
    });
    // Shape, not people — the same minimisation the range entry follows.
    expect(JSON.stringify(metadata)).not.toContain("Range Guest");
  });
});

/*
 * A lost write race must not surface as a 500. Both codes mean "nothing was
 * written, the database made us stop": retry once against fresh state, then
 * answer with a plain-English 409 (#2251 review A3).
 */
describe("assignBedRange write-conflict handling", () => {
  const prismaMock = prisma as unknown as Record<string, unknown>;

  function knownError(code: string) {
    return new Prisma.PrismaClientKnownRequestError("conflict", {
      code,
      clientVersion: "test",
    });
  }

  // The module-level prisma stub is shared; each case installs its own
  // $transaction and clears it again so no other test sees one.
  beforeEach(() => {
    delete prismaMock.$transaction;
  });

  it.each(["P2002", "P2034"])(
    "retries a %s once, then refuses with a 409 rather than a 500",
    async (code) => {
      const transaction = vi.fn().mockRejectedValue(knownError(code));
      prismaMock.$transaction = transaction;

      const error = await assignBedRangePublic({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-06-01",
        to: "2026-06-06",
        approvedByMemberId: "admin-1",
      }).catch((thrown: unknown) => thrown);

      expect(transaction).toHaveBeenCalledTimes(2);
      expect(error).toBeInstanceOf(BedAllocationAdminError);
      expect((error as BedAllocationAdminError).status).toBe(409);
      expect((error as BedAllocationAdminError).message).toContain(
        "Nothing was written",
      );
    },
  );

  it("returns the retry's result when the second attempt succeeds", async () => {
    const { db } = buildDb({});
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(knownError("P2034"))
      .mockImplementationOnce(
        async (run: (tx: unknown) => Promise<unknown>) => run(db),
      );
    prismaMock.$transaction = transaction;

    const result = await assignBedRangePublic({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(result.applied).toBe(true);
  });

  it("does not retry an error that is not a write conflict", async () => {
    const transaction = vi.fn().mockRejectedValue(knownError("P2025"));
    prismaMock.$transaction = transaction;

    await expect(
      assignBedRangePublic({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        from: "2026-06-01",
        to: "2026-06-06",
        approvedByMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({ code: "P2025" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe("whole-lodge holds at the manual write chokepoint", () => {
  it("refuses a single-night manual allocation on a held booking (ADR-001, #2285)", async () => {
    const { db } = buildDb({ guest: buildGuest({ wholeLodgeHold: true }) });

    await expect(
      manuallyAllocateBed({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDate: "2026-06-02",
        db: db as never,
      }),
    ).rejects.toThrow("holds the whole lodge");
  });

  it("refuses a single-night manual allocation on a gap night (#713)", async () => {
    const { db } = buildDb({
      guest: buildGuest({
        stayStart: "2026-06-01",
        stayEnd: "2026-06-11",
        nights: ["2026-06-01", "2026-06-02", "2026-06-09", "2026-06-10"],
      }),
    });

    await expect(
      manuallyAllocateBed({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDate: "2026-06-05",
        db: db as never,
      }),
    ).rejects.toThrow("not staying on the selected date");
  });
});

describe("assignBedRange vs a custodian bed hold (#2286)", () => {
  // A hold over PART of the range: the middle two nights. The custodian
  // exclusion has no database constraint behind it, so this behavioural test is
  // the thing that proves the chokepoint — the refusal category, the atomic
  // "nothing written", and (the one that matters) that no createMany row ever
  // targets a held bed-night even on the consented-nights path.
  function heldMiddleNights() {
    return buildDb({
      guest: buildGuest({ stayStart: "2026-06-01", stayEnd: "2026-06-06" }),
      // The hold covers 06-03 and 06-04 on this exact bed.
      holds: [
        {
          id: "assignment-1",
          memberId: "member-1",
          lodgeId: "lodge-1",
          bedId: "bed-1",
          startDate: parseDateOnly("2026-06-03"),
          endDate: parseDateOnly("2026-06-04"),
          member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
          bed: {
            id: "bed-1",
            name: "Bed One",
            roomId: "room-1",
            room: { id: "room-1", name: "Room One" },
          },
        },
      ],
    });
  }

  it("refuses the held nights as CUSTODIAN_HOLD, never as BED_TAKEN, and writes nothing", async () => {
    const { db, createMany, updateMany } = heldMiddleNights();

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(result.writtenNights).toEqual([]);
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    // Its own category: there is no occupying booking to name, and the fix is
    // on the Hut Leaders page rather than on this board.
    expect(result.refusals).toEqual([
      { stayDate: "2026-06-03", category: "CUSTODIAN_HOLD" },
      { stayDate: "2026-06-04", category: "CUSTODIAN_HOLD" },
    ]);
    expect(result.freeNights).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-05",
    ]);
  });

  it("writes ONLY the free nights when the admin consents to them — no row on a held bed-night", async () => {
    const { db, createMany } = heldMiddleNights();

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      nights: ["2026-06-01", "2026-06-02", "2026-06-05"],
      db: db as never,
    });

    expect(result.applied).toBe(true);
    expect(result.partialByConsent).toBe(true);
    expect(result.writtenNights).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-05",
    ]);
    const rows = createMany.mock.calls[0][0].data as Array<{
      bedId: string;
      stayDate: Date;
    }>;
    // THE assertion: not one written row lands on a night the custodian holds.
    const held = new Set(["2026-06-03", "2026-06-04"]);
    expect(
      rows.some(
        (row) => row.bedId === "bed-1" && held.has(formatDateOnly(row.stayDate)),
      ),
    ).toBe(false);
    expect(rows.map((row) => formatDateOnly(row.stayDate))).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-05",
    ]);
  });

  it("refuses a consented list that includes a held night, with a fresh report and no write", async () => {
    const { db, createMany } = heldMiddleNights();

    const result = await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      // The admin (or a stale client) asks for a night the hold covers.
      nights: ["2026-06-01", "2026-06-03"],
      db: db as never,
    });

    expect(result.applied).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
    expect(
      result.refusals.map((refusal) => refusal.category),
    ).toEqual(["CUSTODIAN_HOLD", "CUSTODIAN_HOLD"]);
  });

  it("reads the holds with the bedId gate — a role-only assignment is not an occupancy", async () => {
    const { db } = heldMiddleNights();

    await assignBedRange({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      approvedByMemberId: "admin-1",
      db: db as never,
    });

    // A role-only assignment is not an occupancy: the read is scoped to this
    // bed, which is what makes `bedId: { in: [...] }` the gate here.
    const where = db.hutLeaderAssignment.findMany.mock.calls[0][0].where;
    expect(where.bedId).toEqual({ in: ["bed-1"] });
    // The lock that makes this read and the write serialise against the hold
    // writer belongs to the transaction assignBedRange opens for ITSELF; these
    // cases pass their own client, so its owner holds it. That the self-wrapped
    // path takes it is pinned in custodian-write-path-contract.test.ts.
  });
});

describe("summariseNightRuns", () => {
  it("collapses contiguous nights into readable runs", () => {
    expect(
      summariseNightRuns([
        "2026-06-01",
        "2026-06-02",
        "2026-06-03",
        "2026-06-05",
        "2026-06-30",
        "2026-07-01",
      ]),
    ).toEqual(["2026-06-01 → 2026-06-03", "2026-06-05", "2026-06-30 → 2026-07-01"]);
  });

  it("returns nothing for an empty night list", () => {
    expect(summariseNightRuns([])).toEqual([]);
  });
});
