import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import { checkCapacityForPartnerSharedAdmission } from "@/lib/capacity";
import { getLodgePartnerSharedCapacityStatus } from "@/lib/lodge-capacity";

// Everything runs through an explicit fake transaction client, so no module
// mock is needed: getLodgePartnerSharedCapacityStatus, mayShareDoubleBed and
// the occupancy/coverage queries all receive this db.
const LODGE = "lodge-a";
const SHARER = "member-sharer";
const PARTNER = "member-partner";

const CHECK_IN = parseDateOnly("2026-08-10");
const CHECK_OUT = parseDateOnly("2026-08-12"); // two nights: 10th + 11th

type FakeDbOptions = {
  beds?: number;
  doubles?: number;
  capacityOverride?: number | null;
  // Existing occupancy: bookings with per-guest envelopes.
  bookings?: Array<{
    checkIn: Date;
    checkOut: Date;
    guests: Array<{ stayStart: Date; stayEnd: Date }>;
  }>;
  // Partner coverage rows returned for the bookingGuest query.
  partnerGuestRows?: Array<{
    stayStart: Date;
    stayEnd: Date;
    nights: never[];
    booking: { checkIn: Date; checkOut: Date };
  }>;
  partnerLinkStatus?: string | null;
  membersActive?: boolean;
  // #2286: bed-holding hut-leader assignments (custodian occupancy) covering
  // the whole two-night window, given as a bed id per custodian.
  custodianBedIds?: string[];
};

function fakeDb(options: FakeDbOptions = {}) {
  const {
    beds = 4,
    doubles = 1,
    capacityOverride = null,
    bookings = [],
    partnerGuestRows = [],
    partnerLinkStatus = "CONFIRMED",
    membersActive = true,
    custodianBedIds = [],
  } = options;

  return {
    clubModuleSettings: {
      findUnique: vi.fn().mockResolvedValue({ bedAllocation: true }),
    },
    lodgeBed: {
      count: vi.fn(
        async (args: { where: { bedType?: string } }) =>
          args.where.bedType === "DOUBLE" ? doubles : beds,
      ),
    },
    ...(capacityOverride === null
      ? {}
      : {
          lodgeSettings: {
            findUnique: vi.fn(async (args: { where: { id: string } }) =>
              args.where.id === LODGE ? { capacity: capacityOverride } : null,
            ),
          },
        }),
    booking: {
      findMany: vi.fn().mockResolvedValue(bookings),
    },
    // #2286: custodian bed holds are base occupancy here too.
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue(
        custodianBedIds.map((bedId, index) => ({
          id: `custodian-${index}`,
          memberId: `custodian-member-${index}`,
          lodgeId: LODGE,
          bedId,
          // Inclusive endDate: CHECK_OUT is the morning after the last night,
          // so the last covered night is the day before it.
          startDate: CHECK_IN,
          endDate: new Date(CHECK_OUT.getTime() - 24 * 60 * 60 * 1000),
          member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
          bed: {
            id: bedId,
            name: bedId,
            roomId: "room-1",
            room: { id: "room-1", name: "Kea" },
          },
        })),
      ),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue(partnerGuestRows),
    },
    member: {
      // Query-faithful, not fixed rows: mayShareDoubleBed (#2679) now resolves
      // each queried id explicitly, which real Prisma's `id: { in: [...] }`
      // always satisfied — a double returning two unrelated ids no longer can.
      findMany: vi
        .fn()
        .mockImplementation(
          (args?: { where?: { id?: { in?: string[] } } }) => {
            const ids = args?.where?.id?.in ?? [SHARER, PARTNER];
            return Promise.resolve(
              [...new Set(ids)].map((id) => ({
                id,
                ageTier: "ADULT",
                active: membersActive,
              })),
            );
          },
        ),
    },
    memberPartnerLink: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          partnerLinkStatus ? { status: partnerLinkStatus } : null,
        ),
    },
  } as never;
}

function nightGuests(count: number) {
  return Array.from({ length: count }, () => ({
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
  }));
}

function fullStayBooking(guestCount: number) {
  return {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: nightGuests(guestCount),
  };
}

const sharerFullStay = {
  range: { stayStart: CHECK_IN, stayEnd: CHECK_OUT },
  memberId: SHARER,
  partnerMemberId: PARTNER,
};

const partnerCoverageFullStay = [
  {
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    nights: [] as never[],
    booking: { checkIn: CHECK_IN, checkOut: CHECK_OUT },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getLodgePartnerSharedCapacityStatus", () => {
  it("grants one slot per active DOUBLE with no explicit capacity", async () => {
    const db = fakeDb({ beds: 10, doubles: 2 });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status).toMatchObject({
      capacity: 10,
      source: "configured_beds",
      activeDoubleBedCount: 2,
      partnerSharedHeadroom: 2,
    });
  });

  it("bounds headroom by an explicit capacity between beds and beds+doubles", async () => {
    const db = fakeDb({ beds: 10, doubles: 2, capacityOverride: 11 });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status).toMatchObject({
      capacity: 10,
      source: "configured_beds",
      partnerSharedHeadroom: 1,
    });
  });

  it("grants no headroom when the explicit capacity equals the bed count", async () => {
    const db = fakeDb({ beds: 10, doubles: 2, capacityOverride: 10 });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status.partnerSharedHeadroom).toBe(0);
  });

  it("grants no headroom on a capped lodge (people ceiling binds, #1653)", async () => {
    const db = fakeDb({ beds: 10, doubles: 2, capacityOverride: 8 });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status).toMatchObject({
      capacity: 8,
      source: "capped_beds",
      activeDoubleBedCount: 0,
      partnerSharedHeadroom: 0,
    });
  });

  it("grants no headroom when the bed allocation module is off", async () => {
    const db = fakeDb({ beds: 10, doubles: 2, capacityOverride: 30 });
    (db as { clubModuleSettings: { findUnique: ReturnType<typeof vi.fn> } })
      .clubModuleSettings.findUnique.mockResolvedValue({ bedAllocation: false });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status).toMatchObject({
      source: "capacity_override",
      activeDoubleBedCount: 0,
      partnerSharedHeadroom: 0,
    });
  });
});

describe("checkCapacityForPartnerSharedAdmission", () => {
  it("admits a partner-sharer when the lodge is full by beds", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(4)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.partnerSharedHeadroom).toBe(1);
    expect(result.nightDetails.every((n) => n.sharedSlotsNeeded === 1)).toBe(
      true,
    );
  });

  it("rejects a partner-sharer once every shared slot is taken", async () => {
    // 5 existing guests over a base of 4: one shared slot already consumed.
    const db = fakeDb({
      bookings: [fullStayBooking(5)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/partner-shared double-bed slots are taken/i);
    expect(result.nightDetails[0]).toMatchObject({
      sharedSlotsUsed: 1,
      sharedSlotsNeeded: 1,
    });
  });

  it("rejects a pair without a confirmed partner link outright", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(3)],
      partnerGuestRows: partnerCoverageFullStay,
      partnerLinkStatus: "PENDING",
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/confirmed partner relationship/i);
  });

  it("never admits an ordinary guest into partner headroom", async () => {
    const db = fakeDb({ bookings: [fullStayBooking(4)] });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [{ stayStart: CHECK_IN, stayEnd: CHECK_OUT }],
      [],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/fully booked/i);
  });

  it("lets a sharer take a free base slot before consuming shared slots", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(3)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.every((n) => n.sharedSlotsNeeded === 0)).toBe(
      true,
    );
  });

  it("handles nights that are only partially full", async () => {
    // Night 1 full (4), night 2 has a free bed (3).
    const db = fakeDb({
      bookings: [
        fullStayBooking(3),
        {
          checkIn: CHECK_IN,
          checkOut: parseDateOnly("2026-08-11"),
          guests: [
            { stayStart: CHECK_IN, stayEnd: parseDateOnly("2026-08-11") },
          ],
        },
      ],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.map((n) => n.sharedSlotsNeeded)).toEqual([1, 0]);
  });

  it("rejects when the partner is not staying every requested night", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(4)],
      partnerGuestRows: [
        {
          stayStart: CHECK_IN,
          stayEnd: parseDateOnly("2026-08-11"),
          nights: [],
          booking: { checkIn: CHECK_IN, checkOut: parseDateOnly("2026-08-11") },
        },
      ],
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/not staying on every night/i);
  });

  it("anchors same-proposal coverage to a proposed guest carrying the partner's memberId", async () => {
    // The sharer joins the partner's own booking: the booking is excluded
    // from occupancy and its guests re-proposed, the partner row tagged with
    // their memberId. 3 occupied + the partner = base full; sharer shares.
    const db = fakeDb({ bookings: [fullStayBooking(3)] });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [{ stayStart: CHECK_IN, stayEnd: CHECK_OUT, memberId: PARTNER }],
      [sharerFullStay],
      "booking-being-modified",
      db,
    );

    expect(result.available).toBe(true);
    expect(
      (db as { bookingGuest: { findMany: ReturnType<typeof vi.fn> } })
        .bookingGuest.findMany,
    ).not.toHaveBeenCalled();
  });

  it("rejects a couple encoded as two mutual sharers (no base-backed anchor)", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(4)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [
        sharerFullStay,
        {
          range: { stayStart: CHECK_IN, stayEnd: CHECK_OUT },
          memberId: PARTNER,
          partnerMemberId: SHARER,
        },
      ],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/must hold an ordinary place/i);
  });

  it("rejects the same sharer proposed twice", async () => {
    const db = fakeDb({
      bookings: [],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay, { ...sharerFullStay }],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/more than once/i);
  });

  it("admits sharers up to the double count, then rejects the next", async () => {
    // 2 doubles → headroom 2. Base full at 4. Coverage rows satisfy every
    // partner (the coverage mock is per-query, not per-member).
    const makeSharer = (index: number) => ({
      range: { stayStart: CHECK_IN, stayEnd: CHECK_OUT },
      memberId: `sharer-${index}`,
      partnerMemberId: `partner-${index}`,
    });

    const two = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [makeSharer(1), makeSharer(2)],
      undefined,
      fakeDb({
        doubles: 2,
        bookings: [fullStayBooking(4)],
        partnerGuestRows: partnerCoverageFullStay,
      }),
    );
    expect(two.available).toBe(true);
    expect(two.nightDetails.every((n) => n.sharedSlotsNeeded === 2)).toBe(true);

    const three = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [makeSharer(1), makeSharer(2), makeSharer(3)],
      undefined,
      fakeDb({
        doubles: 2,
        bookings: [fullStayBooking(4)],
        partnerGuestRows: partnerCoverageFullStay,
      }),
    );
    expect(three.available).toBe(false);
    expect(three.reason).toMatch(/slots are taken/i);
  });

  it("keeps reserved-slot accounting correct after a #1756 stale-pair sweep", async () => {
    // The sweep deletes the pair's BedAllocation placement but deliberately
    // NOT the second occupant's BookingGuest row, and shared-slot accounting
    // is occupancy-derived (guest-nights above base) — never allocation-
    // derived. So post-sweep, while the swept guest still sits on their
    // booking in the awaiting-allocation queue, the slot they mis-held stays
    // visibly consumed: a NEW couple must be refused (no phantom double-grant
    // of the reserved slot), exactly the conservative #1668-style treatment.
    // Base 4 + 1 double; 5 guest-nights = base full + the swept guest still
    // occupying the lodge's only shared slot.
    const occupiedPostSweep = fakeDb({
      bookings: [fullStayBooking(5)],
      partnerGuestRows: partnerCoverageFullStay,
    });
    const refused = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      occupiedPostSweep,
    );
    expect(refused.available).toBe(false);
    expect(refused.nightDetails[0]).toMatchObject({ sharedSlotsUsed: 1 });
    // The headroom resolver reads bed inventory + ceiling only — untouched by
    // any BedAllocation delete, so the sweep cannot corrupt it.
    expect(refused.partnerSharedHeadroom).toBe(1);

    // Once the admin resolves the queue entry (removes the swept guest from
    // the booking), the occupancy drops back to base and the reserved slot
    // frees for the next couple.
    const resolvedPostSweep = fakeDb({
      bookings: [fullStayBooking(4)],
      partnerGuestRows: partnerCoverageFullStay,
    });
    const admitted = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      resolvedPostSweep,
    );
    expect(admitted.available).toBe(true);
    expect(
      admitted.nightDetails.every(
        (night) => night.sharedSlotsUsed === 0 && night.sharedSlotsNeeded === 1,
      ),
    ).toBe(true);
  });

  it("rejects a sharer when the lodge has no shareable doubles", async () => {
    const db = fakeDb({
      doubles: 0,
      bookings: [fullStayBooking(4)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no shareable double beds/i);
  });
});

// ---------------------------------------------------------------------------
// Custodian occupancy (#2286)
// ---------------------------------------------------------------------------
describe("custodian bed holds and partner-shared admission (#2286)", () => {
  it("counts the custodian in base occupancy, so the last base slot is gone", async () => {
    // 3 beds, 0 doubles (no shared headroom at all), 2 guests already booked.
    // Without a custodian one more ordinary guest fits; with one, none does.
    const withoutCustodian = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      nightGuests(1),
      [],
      undefined,
      fakeDb({ beds: 3, doubles: 0, bookings: [fullStayBooking(2)] }),
    );
    expect(withoutCustodian.available).toBe(true);

    const withCustodian = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      nightGuests(1),
      [],
      undefined,
      fakeDb({
        beds: 3,
        doubles: 0,
        bookings: [fullStayBooking(2)],
        custodianBedIds: ["bed-custodian"],
      }),
    );
    expect(withCustodian.available).toBe(false);
    expect(withCustodian.reason).toMatch(/fully booked/i);
  });

  it("counts a handover night's TWO custodians as two occupants, not one", async () => {
    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      nightGuests(1),
      [],
      undefined,
      fakeDb({
        beds: 3,
        doubles: 0,
        bookings: [fullStayBooking(1)],
        custodianBedIds: ["bed-out", "bed-in"],
      }),
    );
    // 1 booked + 2 custodians = 3 of 3 beds, so the proposed guest cannot fit.
    expect(result.available).toBe(false);
  });

  it("PINS THE ACCEPTED OVERSHOOT: a custodian-held DOUBLE still counts toward partnerSharedHeadroom", async () => {
    // The lodge has exactly one DOUBLE and the custodian is sleeping in it, so
    // physically there is no shareable double left. `partnerSharedHeadroom` comes
    // from the UNDATED getLodgePartnerSharedCapacityStatus, which cannot know
    // that — so the sharer is still admitted.
    //
    // This is a DELIBERATE, documented imprecision (docs/CAPACITY_MODEL.md), not
    // an oversight: it is admin-only, it cannot produce a bad PLACEMENT (a
    // custodian bed has no primary allocation row to share, and the allocation
    // guard refuses it outright), and it is analogous to the accepted #1668
    // over-capacity override. This test exists so that closing the gap later is
    // a deliberate decision rather than an accident.
    const db = fakeDb({
      beds: 4,
      doubles: 1,
      custodianBedIds: ["the-only-double"],
    });

    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status.partnerSharedHeadroom).toBe(1);

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [{ stayStart: CHECK_IN, stayEnd: CHECK_OUT, memberId: PARTNER }],
      [sharerFullStay],
      undefined,
      db,
    );

    // Admitted: base 4 - 1 custodian - 1 partner leaves room, and the shared
    // slot the (held) double contributes is still counted as free.
    expect(result.available).toBe(true);
    expect(result.partnerSharedHeadroom).toBe(1);
  });
});


// ============================================================================
// FREEZE TEST (#2307): the partner-shared admission check still counts a
// PENDING member guest
// ============================================================================
//
// Owner decision D-4: a PENDING member guest holds a bed. Owner decision D-12
// keeps that guest off every operational surface — and this is not one, it is a
// capacity gate. The two directions are easy to conflate because the same guest
// rows feed both, so this pins the capacity side.
//
// The specific damage a filter here would do: partner-shared admission is the
// path that lets a couple onto ONE double bed when the lodge is otherwise full.
// Undercount the existing occupants by the pending member guests and the check
// grants a slot the lodge does not have, on the fullest nights of the year.
describe("#2307 partner-shared admission freeze: a PENDING guest still occupies (D-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The occupancy rows this check loads are per-guest stay envelopes. Consent
  // columns ride along on the same rows in production; they are set here so the
  // fixture is honest about what the query returns, and so a future filter has
  // something to (wrongly) act on.
  function pendingOccupant() {
    return {
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      consentStatus: "PENDING",
      consentRequestedAt: new Date("2026-08-01T00:00:00.000Z"),
      consentExpiresAt: new Date("2026-08-09T12:00:00.000Z"),
    };
  }

  it("refuses the share when the last free bed is held by a PENDING guest", async () => {
    // 4 beds, 1 double. Three ordinary occupants plus one pending member guest
    // fills all four beds, so the couple can only be admitted on the double
    // sharing slot, and one slot is exactly what a single double grants.
    const db = fakeDb({
      beds: 4,
      doubles: 1,
      bookings: [
        {
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          guests: [...nightGuests(3), pendingOccupant()],
        },
      ],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      // One ordinary (non-sharing) guest alongside the sharer: with the pending
      // guest counted the lodge is over its base ceiling and the ordinary guest
      // cannot be seated, which is the honest answer.
      [{ stayStart: CHECK_IN, stayEnd: CHECK_OUT }],
      [sharerFullStay],
      undefined,
      db,
    );

    // If the pending guest were filtered out of occupancy, a bed would appear
    // free and this would read available.
    expect(result.available).toBe(false);
  });

  it("sends no consent filter in the occupancy or coverage queries", async () => {
    const db = fakeDb({
      beds: 4,
      doubles: 1,
      partnerGuestRows: partnerCoverageFullStay,
    });

    await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    const bookingArgs = (
      db as unknown as { booking: { findMany: { mock: { calls: unknown[][] } } } }
    ).booking.findMany.mock.calls[0][0];
    expect(JSON.stringify(bookingArgs)).not.toContain("consentStatus");

    const guestArgs = (
      db as unknown as {
        bookingGuest: { findMany: { mock: { calls: unknown[][] } } };
      }
    ).bookingGuest.findMany.mock.calls[0][0];
    expect(JSON.stringify(guestArgs)).not.toContain("consentStatus");
  });
});
