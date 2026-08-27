/**
 * #3107 - the one zone where the projection was not a uniform shift.
 *
 * ## Why this zone, and only this zone
 *
 * Swept across all 418 IANA zones for 2026, `Atlantic/Azores` is the only one
 * that CHANGES THE SIGN of its UTC offset across a DST transition: UTC-1 in
 * standard time, UTC+0 in summer. Every other zone behind Greenwich stays behind
 * it all year, so the projection `dateOnlyKey` used to perform was a uniform
 * one-day shift there - wrong, but wrong the same way on every night, which is
 * why the module's internal comparisons still agreed with each other and why
 * every existing suite passed.
 *
 * Here it is not uniform. Across the 2026-03-29 spring-forward the projection
 * yields day-deltas of BOTH -1 and 0, so it stops being a translation and the
 * arithmetic done in key space stops commuting with it:
 *
 * | stored `@db.Date` | projected into `Atlantic/Azores` |
 * | ----------------- | -------------------------------- |
 * | `2026-03-28`      | `2026-03-27`                     |
 * | `2026-03-29`      | `2026-03-28`                     |
 * | `2026-03-30`      | `2026-03-30`                     |
 *
 * 29 March is skipped entirely, and two stored days collapse onto one key. That
 * is what made #3106 - which correctly moved the night STEP onto calendar
 * arithmetic while the decoder beside it still projected - regress a presence day
 * here and grow a phantom bed night on a three-night stay. Nothing restricts the
 * club zone to a list: `club-time/zone.ts` validates the format, not membership.
 *
 * `booking-guest-stay-ranges-sparse.test.ts` pins the envelope-versus-explicit
 * equivalence under `Pacific/Auckland`, where the projection is the identity, and
 * #3106's suite pins it under `America/Denver`, where it is uniform. This file is
 * the case neither can see.
 *
 * The premise test below asserts BOTH deltas are present, so this file cannot
 * quietly become a second uniform-zone suite if the IANA data moves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The environment zone moves ALONE, above the imports, because `APP_TIME_ZONE`
// is frozen at module load. The host stays where the runner put it.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Atlantic/Azores",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  lodgeBedCount: vi.fn(),
  lodgeSettingsFindUnique: vi.fn(),
  hutLeaderAssignmentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany },
    clubModuleSettings: { findUnique: mocks.clubModuleSettingsFindUnique },
    lodgeBed: { count: mocks.lodgeBedCount },
    lodgeSettings: { findUnique: mocks.lodgeSettingsFindUnique },
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  expandStayEnvelopeToNightKeys,
  getGuestBedNightKeys,
  getGuestDepartureMorningKeys,
  getGuestOperationalDayPresence,
  isGuestActiveOnNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { formatDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/** A `@db.Date` value: the calendar day encoded at UTC midnight. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** The three nights straddling the 2026-03-29 spring-forward. */
const NIGHTS = ["2026-03-28", "2026-03-29", "2026-03-30"];
const CHECK_IN = day("2026-03-28");
/** Half-open: the departure morning, never an occupied night (INV-DATE-003). */
const CHECK_OUT = day("2026-03-31");
const BOOKING = { checkIn: CHECK_IN, checkOut: CHECK_OUT };

const HOST_EXTREMES = ["Pacific/Pago_Pago", "Pacific/Kiritimati"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
  mocks.lodgeBedCount.mockResolvedValue(0);
  mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: 10 });
});

describe("#3107 premise: this zone's projection is NOT a uniform shift", () => {
  it("pins both day-deltas across the 2026-03-29 transition", () => {
    expect(APP_TIME_ZONE).toBe("Atlantic/Azores");
    // Standard time, UTC-1: the previous day.
    expect(formatDateOnlyForTimeZone(day("2026-03-28"), APP_TIME_ZONE)).toBe("2026-03-27");
    expect(formatDateOnlyForTimeZone(day("2026-03-29"), APP_TIME_ZONE)).toBe("2026-03-28");
    // Summer time, UTC+0: the same day. Two stored days collapse onto one key
    // above, and 29 March is named by none of them.
    expect(formatDateOnlyForTimeZone(day("2026-03-30"), APP_TIME_ZONE)).toBe("2026-03-30");
    // If either delta ever disappears this file has stopped testing the class
    // it exists for, so the non-uniformity is asserted rather than assumed.
    const deltas = new Set(
      NIGHTS.map(
        (value) =>
          (Date.parse(`${formatDateOnlyForTimeZone(day(value), APP_TIME_ZONE)}T00:00:00.000Z`) -
            Date.parse(`${value}T00:00:00.000Z`)) /
          86_400_000,
      ),
    );
    expect([...deltas].sort()).toEqual([-1, 0]);
  });
});

describe("#3107 the stay expander crosses the transition without gaining a night", () => {
  it("yields exactly the three nights the envelope covers", () => {
    // Before the fix this produced FOUR keys - a phantom bed night - because the
    // step was calendar arithmetic while the bounds were projected onto a frame
    // where one day had gone missing.
    expect(expandStayEnvelopeToNightKeys(CHECK_IN, CHECK_OUT)).toEqual(NIGHTS);
  });

  it("agrees with the explicit night set, night for night", () => {
    const explicit: GuestStayRange = { nights: NIGHTS.map(day) };
    expect(getGuestBedNightKeys(explicit, BOOKING)).toEqual(
      getGuestBedNightKeys({}, BOOKING),
    );
  });

  it("has ONE departure morning, the day after the last night", () => {
    expect(getGuestDepartureMorningKeys({}, BOOKING)).toEqual(["2026-03-31"]);
  });

  it("HOST AXIS: neither offset extreme changes the night list", () => {
    for (const zone of HOST_EXTREMES) {
      withTimeZone(zone, () => {
        expect(expandStayEnvelopeToNightKeys(CHECK_IN, CHECK_OUT), zone).toEqual(
          NIGHTS,
        );
      });
    }
  });
});

describe("#3107 the transition day itself is occupied and flagged", () => {
  it("counts 29 March as one of the guest's nights", () => {
    // The day the projection skipped. #3106 left this night unoccupied here.
    expect(isGuestActiveOnNight({}, day("2026-03-29"), BOOKING)).toBe(true);
    expect(
      isGuestActiveOnNight({ nights: NIGHTS.map(day) }, day("2026-03-29"), BOOKING),
    ).toBe(true);
    expect(
      isGuestActiveOnNight({ nights: NIGHTS }, day("2026-03-29"), BOOKING),
    ).toBe(true);
    // The three predicates above all survive the projection, because each side of
    // each comparison is derived the same way and the error cancels - which is
    // exactly the uniformity argument #3106 relied on and this zone disproves. So
    // the ABSOLUTE days are asserted too, from both input shapes, and those are
    // what the projection cannot satisfy: it names 27 and 28 March and never 29.
    expect(getGuestBedNightKeys({ nights: NIGHTS.map(day) }, BOOKING)).toEqual(
      NIGHTS,
    );
    expect(getGuestBedNightKeys({ nights: NIGHTS }, BOOKING)).toEqual(NIGHTS);
  });

  it("reports the right half of each day across the transition", () => {
    const presence = (value: string) =>
      getGuestOperationalDayPresence({}, day(value), BOOKING);

    // Arrival evening: the night of the 28th is booked, the 27th is not.
    expect(presence("2026-03-28")).toMatchObject({
      morning: false,
      evening: true,
      isArriving: true,
      isDeparting: false,
    });
    // Mid-stay, and the day whose key the projection lost entirely.
    expect(presence("2026-03-29")).toMatchObject({
      morning: true,
      evening: true,
      present: true,
      isArriving: false,
      isDeparting: false,
    });
    // Departure morning: the night of the 30th was booked, the 31st is not.
    expect(presence("2026-03-31")).toMatchObject({
      morning: true,
      evening: false,
      isDeparting: true,
    });
  });
});

describe("#3107 the admission check spans the transition correctly", () => {
  it("counts two proposed beds on each of the three nights", async () => {
    const result = await checkCapacityForGuestRanges(
      "lodge-a",
      parseDateOnly("2026-03-28"),
      parseDateOnly("2026-03-31"),
      [{ nights: NIGHTS }, { nights: NIGHTS }],
    );

    expect(
      result.nightDetails.map((night) => night.date.toISOString().slice(0, 10)),
    ).toEqual(NIGHTS);
    expect(result.nightDetails.map((night) => night.occupiedBeds)).toEqual([
      2, 2, 2,
    ]);
  });
});
