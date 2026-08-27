import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly, formatDateOnly, getTodayDateOnly } from "@/lib/date-only";

/**
 * The capacity-warnings cron and the admission engines must agree about how
 * many beds are occupied on a night (#2681).
 *
 * Until #2681 they did not. The cron computed occupancy itself and was three
 * terms behind `capacity.ts`:
 *
 *  1. **Policy-exception reservations (#2525)** — never counted, so beds a HELD
 *     exception request had provisionally reserved were invisible and the cron
 *     UNDER-reported occupancy on those nights.
 *  2. **Whole-lodge holds (ADR-001, #118)** — no pin, so a lodge under an
 *     exclusive hold reported only the holding group's own headcount. A large
 *     holding party still crossed the threshold on its own numbers; what never
 *     happened is the HOLD itself causing the warning, so a small group holding
 *     a big lodge exclusively produced no alert at all.
 *  3. **Explicit guest nights (#713)** — the cron loaded `guests: true` rather
 *     than `guests: { include: { nights: true } }`, so a sparse, non-contiguous
 *     stay fell back to its `stayStart`/`stayEnd` envelope and was counted on
 *     the gap nights the guest is not there. (This one goes the other way: the
 *     cron OVER-reported on a gap night.)
 *
 * Each `it` below drives BOTH surfaces over the SAME fixture. Parity alone
 * would be tautological — both surfaces now read the same function, so a term
 * deleted from `computeNightOccupancy` would drop out of both and the two would
 * still agree — so every case ALSO pins an absolute expected number. That
 * absolute is what bites when a term is dropped; the parity is what bites when
 * a surface grows its own copy again.
 *
 * The three cases for the terms the cron was missing (#2525, ADR-001, #713) all
 * fail against the pre-#2681 cron. The custodian case (#2286) does not: that
 * term already reached every surface, and it is here as a regression guard so
 * the refactor cannot quietly drop the one term that was never broken.
 *
 * The lodge capacity is 5 and the warn threshold is 5 beds remaining, so every
 * night in the cron's 14-day window is reported and the alert payload can be
 * read as a per-night occupancy table.
 */

/**
 * The club's zone, named rather than left to `getTodayDateOnly`'s `APP_TIME_ZONE`
 * default, which #3123 deletes. `checkCapacityWarnings` resolves its own "today"
 * through `readClubTimeZoneOutsideRequest()`; prisma is mocked below with no
 * `clubTimeSettings` delegate, so that read fails soft to the environment seed
 * and then to `Pacific/Auckland`. The clock guard has to name the same zone the
 * cron resolves, or it would report a clock shift that had not happened.
 */
const CLUB_ZONE = "Pacific/Auckland";

const LODGE = "lodge-a";
const LODGE_CAPACITY = 5;

type FixtureGuest = {
  stayStart: Date;
  stayEnd: Date;
  nights: Array<{ stayDate: Date }>;
};
type FixtureBooking = {
  id: string;
  checkIn: Date;
  checkOut: Date;
  wholeLodgeHold: boolean;
  guests: FixtureGuest[];
};

/**
 * The booking fixture for a run. Read through a `findMany` double that HONOURS
 * `include`, so a query that does not ask for `guests.nights` does not receive
 * them — which is exactly how the pre-#2681 cron (`include: { guests: true }`)
 * lost the #713 night sets and fell back to the stay envelope.
 */
let bookingFixture: FixtureBooking[] = [];

function bookingFindManyDouble(args: {
  where?: {
    checkIn?: { lt?: Date };
    checkOut?: { gt?: Date };
    lodgeId?: string;
    id?: { not?: string };
  };
  include?: { guests?: boolean | { include?: { nights?: boolean } } };
}) {
  const wantsNights =
    typeof args?.include?.guests === "object" &&
    args.include.guests?.include?.nights === true;
  // The half-open overlap window, the per-lodge scope and `excludeBookingId`
  // are honoured, so a fixture booking outside the queried window is NOT
  // returned. Without that the single-night `checkCapacity` probes below would
  // see every booking in the fixture and the composite case could not
  // distinguish one night from another.
  const where = args?.where ?? {};
  return bookingFixture
    .filter((booking) => {
      if (where.checkIn?.lt && !(booking.checkIn < where.checkIn.lt)) return false;
      if (where.checkOut?.gt && !(booking.checkOut > where.checkOut.gt)) return false;
      if (where.lodgeId !== undefined && where.lodgeId !== LODGE) return false;
      if (where.id?.not !== undefined && booking.id === where.id.not) return false;
      return true;
    })
    .map((booking) => ({
      ...booking,
      guests: booking.guests.map((guest) =>
        wantsNights ? guest : { stayStart: guest.stayStart, stayEnd: guest.stayEnd },
      ),
    }));
}

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  lodgeFindMany: vi.fn(),
  hutLeaderAssignmentFindMany: vi.fn(),
  reservationFindMany: vi.fn(),
  getLodgeCapacity: vi.fn(),
  sendAdminCapacityWarningAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany },
    lodge: { findMany: mocks.lodgeFindMany },
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    policyExceptionReservationNight: { findMany: mocks.reservationFindMany },
  },
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: mocks.getLodgeCapacity,
}));

vi.mock("@/lib/email", () => ({
  sendAdminCapacityWarningAlert: mocks.sendAdminCapacityWarningAlert,
}));

import { checkCapacity } from "@/lib/capacity";
import { checkCapacityWarnings } from "@/lib/cron-capacity-warnings";

/** The cron's own per-night occupancy table, keyed `YYYY-MM-DD`. */
async function cronOccupancyByNight(): Promise<Map<string, number>> {
  mocks.sendAdminCapacityWarningAlert.mockClear();
  await checkCapacityWarnings();

  const table = new Map<string, number>();
  for (const call of mocks.sendAdminCapacityWarningAlert.mock.calls) {
    const days = call[0] as Array<{ date: Date; occupiedBeds: number }>;
    for (const day of days) {
      table.set(formatDateOnly(day.date), day.occupiedBeds);
    }
  }
  return table;
}

/** `checkCapacity`'s occupancy for the single night starting `night`. */
async function engineOccupancyForNight(night: string): Promise<number> {
  const result = await checkCapacity(
    LODGE,
    parseDateOnly(night),
    parseDateOnly(formatDateOnly(new Date(parseDateOnly(night).getTime() + 86_400_000))),
    1,
  );
  return result.nightDetails[0].occupiedBeds;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The frozen test clock is 2026-07-01T00:00:00.000Z, which is midday on
  // 2026-07-01 in New Zealand, so the cron's window is the nights of
  // 2026-07-01 .. 2026-07-14 inclusive.
  mocks.lodgeFindMany.mockResolvedValue([{ id: LODGE, name: "Main Lodge" }]);
  mocks.getLodgeCapacity.mockResolvedValue(LODGE_CAPACITY);
  bookingFixture = [];
  mocks.bookingFindMany.mockImplementation(bookingFindManyDouble);
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.reservationFindMany.mockResolvedValue([]);
  mocks.sendAdminCapacityWarningAlert.mockResolvedValue(undefined);
});

describe("#2681 the capacity-warnings cron and checkCapacity agree on occupancy", () => {
  it("runs on the frozen test clock the fixture dates were written for", () => {
    // Every fixture night below is a literal, and the cron derives its 14-night
    // window from `getTodayDateOnly()`. Under a shifted clock
    // (`TEST_CLOCK_OFFSET_DAYS` / `TEST_CLOCK_ISO`, docs/TESTING.md) the window
    // slides off the fixture and every assertion fails as
    // `expected undefined to be 2`, which reads like a product bug. Fail here
    // instead, saying what actually happened.
    expect(
      formatDateOnly(getTodayDateOnly(CLUB_ZONE)),
      "This suite pins literal fixture nights against the repo's default frozen clock. The clock has been shifted (TEST_CLOCK_OFFSET_DAYS / TEST_CLOCK_ISO?) — see docs/TESTING.md.",
    ).toBe("2026-07-01");
  });

  it("counts a HELD policy-exception reservation on both surfaces (#2525)", async () => {
    const night = "2026-07-05";
    mocks.reservationFindMany.mockResolvedValue([
      { night: parseDateOnly(night), beds: 2 },
    ]);

    const engine = await engineOccupancyForNight(night);
    const cron = await cronOccupancyByNight();

    expect(engine).toBe(2);
    expect(cron.get(night)).toBe(engine);
  });

  it("pins a whole-lodge-held night to the lodge ceiling on both surfaces (ADR-001, #118)", async () => {
    const night = "2026-07-06";
    bookingFixture = [
      {
        id: "booking-hold",
        checkIn: parseDateOnly(night),
        checkOut: parseDateOnly("2026-07-07"),
        wholeLodgeHold: true,
        guests: [
          {
            stayStart: parseDateOnly(night),
            stayEnd: parseDateOnly("2026-07-07"),
            nights: [],
          },
        ],
      },
    ];

    const engine = await engineOccupancyForNight(night);
    const cron = await cronOccupancyByNight();

    // One guest, but the lodge is exclusively held: both surfaces report a full
    // lodge, so the cron warns rather than reading 1 of 5 beds taken.
    expect(engine).toBe(LODGE_CAPACITY);
    expect(cron.get(night)).toBe(engine);
  });

  it("respects a sparse guest's explicit night set on both surfaces (#713)", async () => {
    const gapNight = "2026-07-09";
    bookingFixture = [
      {
        id: "booking-sparse",
        checkIn: parseDateOnly("2026-07-08"),
        checkOut: parseDateOnly("2026-07-11"),
        wholeLodgeHold: false,
        guests: [
          {
            stayStart: parseDateOnly("2026-07-08"),
            stayEnd: parseDateOnly("2026-07-11"),
            // Stays the 8th and the 10th; the 9th is a genuine absence.
            nights: [
              { stayDate: parseDateOnly("2026-07-08") },
              { stayDate: parseDateOnly("2026-07-10") },
            ],
          },
        ],
      },
    ];

    const engine = await engineOccupancyForNight(gapNight);
    const cron = await cronOccupancyByNight();

    expect(engine).toBe(0);
    expect(cron.get(gapNight)).toBe(engine);
    // The nights either side are genuinely occupied, so this is not a fixture
    // that simply counts nothing anywhere.
    expect(cron.get("2026-07-08")).toBe(1);
    expect(cron.get("2026-07-10")).toBe(1);
  });

  it("still counts custodian bed holds on both surfaces (#2286, the term that did reach every surface)", async () => {
    const night = "2026-07-03";
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "assignment-1",
        memberId: "member-1",
        lodgeId: LODGE,
        bedId: "bed-1",
        startDate: parseDateOnly(night),
        endDate: parseDateOnly(night),
        member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    const engine = await engineOccupancyForNight(night);
    const cron = await cronOccupancyByNight();

    expect(engine).toBe(1);
    expect(cron.get(night)).toBe(engine);
  });

  it("agrees night by night when all four terms land in the same window", async () => {
    bookingFixture = [
      {
        id: "booking-hold",
        checkIn: parseDateOnly("2026-07-06"),
        checkOut: parseDateOnly("2026-07-07"),
        wholeLodgeHold: true,
        guests: [
          {
            stayStart: parseDateOnly("2026-07-06"),
            stayEnd: parseDateOnly("2026-07-07"),
            nights: [],
          },
        ],
      },
      {
        id: "booking-sparse",
        checkIn: parseDateOnly("2026-07-08"),
        checkOut: parseDateOnly("2026-07-11"),
        wholeLodgeHold: false,
        guests: [
          {
            stayStart: parseDateOnly("2026-07-08"),
            stayEnd: parseDateOnly("2026-07-11"),
            nights: [
              { stayDate: parseDateOnly("2026-07-08") },
              { stayDate: parseDateOnly("2026-07-10") },
            ],
          },
        ],
      },
    ];
    mocks.reservationFindMany.mockResolvedValue([
      { night: parseDateOnly("2026-07-05"), beds: 2 },
    ]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "assignment-1",
        memberId: "member-1",
        lodgeId: LODGE,
        bedId: "bed-1",
        startDate: parseDateOnly("2026-07-03"),
        endDate: parseDateOnly("2026-07-03"),
        member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    const cron = await cronOccupancyByNight();

    // Absolute per-night expectations, not just parity: a term deleted from the
    // shared calculation drops out of BOTH surfaces, so parity alone would
    // still hold. These numbers are what actually bite.
    const expected: Record<string, number> = {
      "2026-07-01": 0, // nothing on this night
      "2026-07-03": 1, // custodian bed hold (#2286)
      "2026-07-05": 2, // two beds reserved by a HELD exception request (#2525)
      "2026-07-06": LODGE_CAPACITY, // whole-lodge hold pins the ceiling (ADR-001)
      "2026-07-08": 1, // sparse guest, present
      "2026-07-09": 0, // sparse guest's GAP night — absent (#713)
      "2026-07-10": 1, // sparse guest, present again
      "2026-07-14": 0, // last night of the cron's window, nothing on it
    };

    for (const [night, occupiedBeds] of Object.entries(expected)) {
      expect(
        await engineOccupancyForNight(night),
        `checkCapacity must read ${occupiedBeds} occupied bed(s) on ${night}`,
      ).toBe(occupiedBeds);
      expect(
        cron.get(night),
        `the cron and checkCapacity must agree on ${night}`,
      ).toBe(occupiedBeds);
    }
  });
});
