/**
 * #3107 - a stored lodge night is DECODED, and the capacity admission check sees
 * the beds a proposal really asks for.
 *
 * ## The defect this file exists to keep closed
 *
 * `dateOnlyKey` in `booking-guest-stay-ranges.ts` read every stored `@db.Date`
 * value through the environment zone, while `nightEntryKey` took a `yyyy-mm-dd`
 * string VERBATIM. Both shapes occur in production: `BookingGuestNight` rows and
 * booking envelopes arrive as `Date`s, and `ProposalGuest.nights` is declared
 * `string[]` (`booking-exception-requests.ts`) and reaches
 * `checkCapacityForGuestRanges` untouched through
 * `createModificationExceptionRequest`. So one logical night lived in two frames
 * at once.
 *
 * `checkCapacityForGuestRanges` compounded it: it projected its bounds with
 * `normalizeDateOnlyForTimeZone` before expanding them into nights, so the night
 * it asked about was a day early AND the key it derived for that night was a
 * further day early. Measured on `America/Denver` for a two-guest, three-night
 * proposal, exactly one of the three nights matched the proposal's string set -
 * the other two counted ZERO proposed beds instead of two.
 *
 * That runs inside `acquireGlobalBookingLock` plus `acquireLodgeCapacityLock`, on
 * the `reservesBeds` branch, and it is the one code path whose entire job is to
 * decide whether the beds exist. An under-count makes the lodge look emptier than
 * it is, so a proposal that should be refused for want of beds could be admitted.
 *
 * ## Why no existing suite caught it
 *
 * Every other suite runs with the environment zone resolving to
 * `Pacific/Auckland`, where the projection is the identity. This file pins the
 * environment zone behind Greenwich with a module mock, and moves the HOST
 * separately with `withTimeZone` / `withTimeZoneAsync` - separately, because a
 * test moving both together could not tell a projection through the configured
 * zone from one through the host's, and one instant can move both axes.
 *
 * The first case asserts the premise is real, so nothing below can pass
 * vacuously.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `APP_TIME_ZONE` is frozen at module load, so the environment zone has to move
// above the imports. This moves it ALONE, leaving the host where the runner put
// it.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
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

import { AgeTier } from "@prisma/client";
import { APP_TIME_ZONE } from "@/config/operational";
import {
  checkCapacityForGuestRanges,
  type NightAvailability,
} from "@/lib/capacity";
import {
  getCapacityGuestRanges,
  resolveBookingDateEnvelope,
} from "@/lib/booking-create-guests";
import type { BookingGuestInput } from "@/lib/booking-create-types";
import {
  getGuestBedNightKeys,
  getNextGuestBedNightAfter,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { formatDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";
import {
  withTimeZone,
  withTimeZoneAsync,
} from "@/lib/__tests__/helpers/timezone";

const LODGE = "lodge-a";

/** The three lodge nights of the proposal, as `ProposalGuest.nights` carries them. */
const PROPOSAL_NIGHTS = ["2026-07-04", "2026-07-05", "2026-07-06"];
/** Its envelope, as `createModificationExceptionRequest` builds it. */
const PROPOSAL_CHECK_IN = parseDateOnly("2026-07-04");
const PROPOSAL_CHECK_OUT = parseDateOnly("2026-07-07");

/** A `@db.Date` value: the calendar day encoded at UTC midnight. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Both offset extremes, to prove the host cannot move any answer here. */
const HOST_EXTREMES = ["Pacific/Pago_Pago", "Pacific/Kiritimati"];

const BOOKING = { checkIn: day("2026-07-04"), checkOut: day("2026-07-07") };

function beds(nights: NightAvailability[]): number[] {
  return nights.map((night) => night.occupiedBeds);
}

function proposal(nights: GuestStayRange["nights"]): GuestStayRange[] {
  return [{ nights }, { nights }];
}

/** The `yyyy-mm-dd` day a returned bound or night carries, read in UTC. */
function storedDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** A create-path guest: only the stay fields matter to the envelope. */
function guest(stay: Partial<BookingGuestInput>): BookingGuestInput {
  return {
    firstName: "A",
    lastName: "Guest",
    ageTier: AgeTier.ADULT,
    isMember: true,
    ...stay,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // An EMPTY lodge, so every bed the check reports as occupied is the proposal's
  // own. That is what makes `occupiedBeds` a direct readout of the proposed count.
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
  mocks.lodgeBedCount.mockResolvedValue(0);
  mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: 10 });
});

describe("#3107 premise: the environment zone really is behind Greenwich", () => {
  it("pins it, so nothing below measures the identity", () => {
    expect(APP_TIME_ZONE).toBe("America/Denver");
    // The projection the fix removed. While `dateOnlyKey` used this, every key
    // it produced was this day rather than the day the column holds.
    expect(formatDateOnlyForTimeZone(day("2026-07-04"), APP_TIME_ZONE)).toBe(
      "2026-07-03",
    );
  });
});

describe("#3107 the capacity admission check counts the proposal's beds", () => {
  it("sees TWO proposed beds on every night of a two-guest three-night proposal fed as STRINGS", async () => {
    const result = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      proposal(PROPOSAL_NIGHTS),
    );

    // The nights asked about are the nights proposed - not a day early.
    expect(
      result.nightDetails.map((night) => night.date.toISOString().slice(0, 10)),
    ).toEqual(PROPOSAL_NIGHTS);
    // THE MEASUREMENT. Before the fix this was [0, 0, 2], over the nights
    // 07-03/04/05: the window was a day early AND every key derived inside it a
    // further day early, so exactly one night matched the proposal's string set
    // and two counted no beds at all - on an empty lodge, inside the capacity
    // lock. (Not [2, 0, 0]; that is the offset-bearing single-night vector
    // asserted at the foot of this file, and it was copied here by mistake.)
    expect(beds(result.nightDetails)).toEqual([2, 2, 2]);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([
      8, 8, 8,
    ]);
  });

  it("REFUSES a proposal that does not fit, which the under-count could admit", async () => {
    mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: 1 });

    const result = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      proposal(PROPOSAL_NIGHTS),
    );

    // Two beds asked for, one bed in the lodge, so every night is short by one.
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([
      -1, -1, -1,
    ]);
    expect(result.available).toBe(false);
  });

  it("gives the SAME answer for every input shape, so the frames agree", async () => {
    const asStrings = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      proposal(PROPOSAL_NIGHTS),
    );
    const asDates = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      proposal(PROPOSAL_NIGHTS.map(day)),
    );
    const asRows = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      proposal(PROPOSAL_NIGHTS.map((value) => ({ stayDate: day(value) }))),
    );
    const asSerialisedRows = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      proposal(
        PROPOSAL_NIGHTS.map((value) => ({
          stayDate: `${value}T00:00:00.000Z`,
        })),
      ),
    );

    expect(beds(asStrings.nightDetails)).toEqual([2, 2, 2]);
    expect(beds(asDates.nightDetails)).toEqual(beds(asStrings.nightDetails));
    expect(beds(asRows.nightDetails)).toEqual(beds(asStrings.nightDetails));
    expect(beds(asSerialisedRows.nightDetails)).toEqual(
      beds(asStrings.nightDetails),
    );
  });

  it("counts the ENVELOPE branch on the same frame as the explicit one", async () => {
    const envelope = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      [
        { stayStart: day("2026-07-04"), stayEnd: day("2026-07-07") },
        { stayStart: day("2026-07-04"), stayEnd: day("2026-07-07") },
      ],
    );
    expect(beds(envelope.nightDetails)).toEqual([2, 2, 2]);
  });

  it("counts an EXISTING booking's stored span against the same nights", async () => {
    // The occupancy index keys the booking's stored span; the night keys come
    // from the requested window. Those were built by two different spellings -
    // one projected, one not - so behind Greenwich this term was off by one.
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "existing",
        checkIn: day("2026-07-04"),
        checkOut: day("2026-07-07"),
        wholeLodgeHold: false,
        guests: [{ nights: [] }, { nights: [] }],
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      proposal(PROPOSAL_NIGHTS),
    );

    // Two existing beds plus the two proposed, on each of the three nights.
    expect(beds(result.nightDetails)).toEqual([4, 4, 4]);
  });

  it("HOST AXIS: neither offset extreme changes the bed count", async () => {
    for (const zone of HOST_EXTREMES) {
      await withTimeZoneAsync(zone, async () => {
        const result = await checkCapacityForGuestRanges(
          LODGE,
          PROPOSAL_CHECK_IN,
          PROPOSAL_CHECK_OUT,
          proposal(PROPOSAL_NIGHTS),
        );
        expect(beds(result.nightDetails), zone).toEqual([2, 2, 2]);
      });
    }
  });
});

describe("#3107 the two exported key producers hand out the stored day", () => {
  it("getGuestBedNightKeys returns the days the columns hold, from either branch", () => {
    // Explicit `BookingGuestNight` rows.
    expect(
      getGuestBedNightKeys({ nights: PROPOSAL_NIGHTS.map(day) }, BOOKING),
    ).toEqual(PROPOSAL_NIGHTS);
    // The half-open envelope fallback, from the booking's own stored columns.
    expect(getGuestBedNightKeys({}, BOOKING)).toEqual(PROPOSAL_NIGHTS);
  });

  it("getNextGuestBedNightAfter returns the stored day, not a projected one", () => {
    const guest: GuestStayRange = {
      nights: [day("2026-07-04"), day("2026-07-07")],
    };
    const next = getNextGuestBedNightAfter(guest, day("2026-07-05"), BOOKING);
    // The kiosk's departure sweep uses this as the UPPER Prisma bound of a
    // `choreAssignment.deleteMany` range whose lower bound is `parseDateOnly` of
    // the URL segment and was never projected. Two bounds, one frame.
    expect(next?.toISOString()).toBe("2026-07-07T00:00:00.000Z");
  });

  it("HOST AXIS: neither offset extreme changes either producer", () => {
    for (const zone of HOST_EXTREMES) {
      withTimeZone(zone, () => {
        expect(
          getGuestBedNightKeys({ nights: PROPOSAL_NIGHTS.map(day) }, BOOKING),
          zone,
        ).toEqual(PROPOSAL_NIGHTS);
        expect(
          getNextGuestBedNightAfter(
            { nights: [day("2026-07-04"), day("2026-07-07")] },
            day("2026-07-05"),
            BOOKING,
          )?.toISOString(),
          zone,
        ).toBe("2026-07-07T00:00:00.000Z");
      });
    }
  });
});

describe("#3107 the string branch reads the prefix, it does not reparse", () => {
  // The one input on which a prefix read and a reparse disagree, and therefore
  // the only probe that can tell the fixed string branch from the one it
  // replaced. `calendarDateOfSerialisedDbDate` reads the first ten characters,
  // so this is 4 July in every zone; `dateOnlyKey(new Date(entry))` would
  // resolve the offset first and decode 3 July. No serialisation of a `@db.Date`
  // produces such a string, so this is the contract boundary rather than a live
  // path - but "which day does this night name" must not depend on a zone at
  // all, and only one of the two spellings has that property.
  const OFFSET_BEARING = "2026-07-04T12:00:00+13:00";

  it("names the day in the string, not the day its offset resolves to", () => {
    expect(
      getGuestBedNightKeys({ nights: [OFFSET_BEARING] }, BOOKING),
    ).toEqual(["2026-07-04"]);
  });

  it("counts that night as the day it names, inside the admission check", async () => {
    const result = await checkCapacityForGuestRanges(
      LODGE,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
      proposal([OFFSET_BEARING]),
    );
    expect(beds(result.nightDetails)).toEqual([2, 0, 0]);
  });
});

describe("#3107 a real timestamp is refused rather than silently decoded", () => {
  it("names the value instead of returning its UTC day", () => {
    // The precondition `requireStoredCalendarDay` asserts. Without it, swapping
    // the projection for a UTC read would be silently wrong the moment a caller
    // passed a moment - the INV-DATE-019 defect from the other direction, and
    // the reason #3100 refused to fold this fix into itself.
    expect(() =>
      getGuestBedNightKeys(
        { nights: [new Date("2026-07-04T09:30:00.000Z")] },
        BOOKING,
      ),
    ).toThrow(/takes a stored calendar day, not a moment/);
  });
});

describe("#3107 the create envelope is stored, and admitted, on the true calendar", () => {
  // Two guests over the three proposed nights, as `POST /api/bookings` builds
  // them once the consent plan has run.
  const withNights = [
    guest({ nights: PROPOSAL_NIGHTS }),
    guest({ nights: PROPOSAL_NIGHTS }),
  ];
  // THE SHAPE THE ORDINARY CREATE ACTUALLY SENDS, and the one the branch below
  // exists for. `normalizeGuestStayRange` fills `stayStart` / `stayEnd` from the
  // booking range for every guest that supplies neither
  // (`booking-guest-stay-range-input.ts`), and `planMemberGuestConsentWrites`
  // passes them through, so `guestInputs` on `POST /api/bookings` ALWAYS carries
  // both bounds. Any guest not using multi-date-range mode therefore reaches
  // `resolveBookingDateEnvelope` here, in the `stayStart && stayEnd` branch.
  const withBounds = [
    guest({ stayStart: PROPOSAL_CHECK_IN, stayEnd: PROPOSAL_CHECK_OUT }),
    guest({ stayStart: PROPOSAL_CHECK_IN, stayEnd: PROPOSAL_CHECK_OUT }),
  ];

  it("resolves to the days the member asked for", () => {
    const envelope = resolveBookingDateEnvelope(
      withNights,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );
    // Before the fix, on this zone, 2026-07-02 -> 2026-07-06: the seeds decoded
    // and every contribution and both returned bounds were projected.
    expect(storedDay(envelope.checkIn)).toBe("2026-07-04");
    expect(storedDay(envelope.checkOut)).toBe("2026-07-07");
  });

  it("resolves to them when a guest contributes NOTHING at all", () => {
    // DEFENSIVE, NOT REACHABLE - and saying so is the point. A guest carrying
    // neither nights nor bounds is the one shape no caller can produce: the
    // route fills the bounds, `admin-booking-copy.ts` sets them, and
    // `proposalGuestToCreateInput` sets nights AND bounds. So this case
    // isolates the RETURN, by taking no contribution branch at all - which is
    // exactly why it cannot speak for the branch production takes, and why the
    // `withBounds` cases below exist. It was wrong before the fix too, by one
    // day rather than two: a member asking 07-04 -> 07-07 had 07-03 -> 07-06
    // written to `booking.checkIn` / `checkOut` while `pricing.ts`'s zone-free
    // `normalizeBookingDate` wrote `BookingGuestNight.stayDate` on the true
    // calendar. The created row straddled itself.
    const envelope = resolveBookingDateEnvelope(
      [guest({}), guest({})],
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );
    expect(storedDay(envelope.checkIn)).toBe("2026-07-04");
    expect(storedDay(envelope.checkOut)).toBe("2026-07-07");
  });

  it("resolves to them for the shape the ordinary create ACTUALLY sends", () => {
    // THE CASE THIS SUITE WAS MISSING. Every other envelope case here passes
    // `nights` or nothing, so the branch every ordinary API create takes had no
    // coverage at all - and that gap, not equivalence, is why the
    // contributions-only mutant used to survive twice instead of once.
    //
    // Pre-fix on this zone: 2026-07-02 -> 2026-07-06. TWO days early on the low
    // bound, not one, because the contribution projected the bound and then the
    // return projected the result again. The one-day case above is the only
    // shape that lost a single day, and no caller can produce it.
    const envelope = resolveBookingDateEnvelope(
      withBounds,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );
    expect(storedDay(envelope.checkIn)).toBe("2026-07-04");
    expect(storedDay(envelope.checkOut)).toBe("2026-07-07");
  });

  it("expands from the stay-bounds branch on the true calendar, at BOTH ends", () => {
    // A guest whose own bounds sit outside the member stated range widens it.
    // Both ends move here, so a projection on either one shows up: the low bound
    // is taken as-is and the high bound goes through the -1 / +1 last-night
    // round trip that turns an exclusive stay end into an inclusive night key
    // and back.
    const envelope = resolveBookingDateEnvelope(
      [guest({ stayStart: day("2026-07-02"), stayEnd: day("2026-07-09") })],
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );
    expect(storedDay(envelope.checkIn)).toBe("2026-07-02");
    expect(storedDay(envelope.checkOut)).toBe("2026-07-09");
  });

  it("follows the NIGHT SET when a guest carries both nights and bounds", () => {
    // `proposalGuestToCreateInput` sets both, and so does
    // `normalizeGuestStayRange` for a multi-date-range guest, so the two
    // branches are not mutually exclusive in the data - only in the code. The
    // wide bounds here would reach 07-01 -> 07-12 if the wrong branch won.
    const envelope = resolveBookingDateEnvelope(
      [
        guest({
          nights: PROPOSAL_NIGHTS,
          stayStart: day("2026-07-01"),
          stayEnd: day("2026-07-12"),
        }),
      ],
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );
    expect(storedDay(envelope.checkIn)).toBe("2026-07-04");
    expect(storedDay(envelope.checkOut)).toBe("2026-07-07");
  });

  it("contributes NOTHING for a one-sided guest, so the range accessors stay unused", () => {
    // The branch needs BOTH bounds, so a guest carrying one is skipped and the
    // member stated range stands. `booking-guest-stay-ranges.ts` exports
    // accessors that fall back to the booking range per side, so reusing them
    // here would make a one-sided guest contribute where today it does not.
    // That is a behaviour change rather than a refactor, and this pins the
    // current answer so the next reader can see the difference is deliberate.
    for (const oneSided of [
      guest({ stayStart: day("2026-07-01") }),
      guest({ stayEnd: day("2026-07-12") }),
    ]) {
      const envelope = resolveBookingDateEnvelope(
        [oneSided],
        PROPOSAL_CHECK_IN,
        PROPOSAL_CHECK_OUT,
      );
      expect(storedDay(envelope.checkIn)).toBe("2026-07-04");
      expect(storedDay(envelope.checkOut)).toBe("2026-07-07");
    }
  });

  it("counts every proposed bed on the envelope the ordinary create resolves", async () => {
    // The `withNights` twin of this case is below; this is the same composition
    // `createConfirmedBooking` performs inside `acquireLodgeCapacityLock`, for
    // the guests the route really builds. `getCapacityGuestRanges` passes
    // `nights: undefined` for these, so capacity spreads each guest across the
    // whole window - which is what makes a two-day-early window visible as a
    // bed count rather than only as a stored date.
    const envelope = resolveBookingDateEnvelope(
      withBounds,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );

    const result = await checkCapacityForGuestRanges(
      LODGE,
      envelope.checkIn,
      envelope.checkOut,
      getCapacityGuestRanges(withBounds, envelope.checkIn, envelope.checkOut),
    );

    expect(result.nightDetails.map((night) => storedDay(night.date))).toEqual(
      PROPOSAL_NIGHTS,
    );
    // Pre-fix this window was 07-02..07-05: it counted 0 proposed beds on the
    // two nights before the stay and never inspected 07-06 at all.
    expect(beds(result.nightDetails)).toEqual([2, 2, 2]);
  });

  it("HOST AXIS: neither offset extreme moves the ordinary create envelope", () => {
    for (const zone of HOST_EXTREMES) {
      withTimeZone(zone, () => {
        const envelope = resolveBookingDateEnvelope(
          withBounds,
          PROPOSAL_CHECK_IN,
          PROPOSAL_CHECK_OUT,
        );
        expect(storedDay(envelope.checkIn), zone).toBe("2026-07-04");
        expect(storedDay(envelope.checkOut), zone).toBe("2026-07-07");
      });
    }
  });

  it("still auto-expands to cover a guest night outside the stated range (#713)", () => {
    const envelope = resolveBookingDateEnvelope(
      [guest({ nights: ["2026-07-02", ...PROPOSAL_NIGHTS, "2026-07-08"] })],
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );
    expect(storedDay(envelope.checkIn)).toBe("2026-07-02");
    // The night set's last night is 07-08, so the exclusive check-out is 07-09.
    expect(storedDay(envelope.checkOut)).toBe("2026-07-09");
  });

  it("does not straddle the night rows written inside the same envelope", () => {
    const envelope = resolveBookingDateEnvelope(
      withNights,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );
    const nightKeys = getGuestBedNightKeys(withNights[0], envelope);
    expect(nightKeys).toEqual(PROPOSAL_NIGHTS);
    // Every night the guest holds lies inside the envelope the booking stores.
    // Before the fix the last one (07-06) fell on or after the stored check-out
    // (07-06), which is what "the row straddles itself" means concretely.
    for (const key of nightKeys) {
      expect(
        key >= storedDay(envelope.checkIn) && key < storedDay(envelope.checkOut),
        key,
      ).toBe(true);
    }
  });

  it("counts every proposed bed when the admission check runs on that envelope", async () => {
    const envelope = resolveBookingDateEnvelope(
      withNights,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );
    // Exactly the composition `createBooking` performs inside
    // `acquireLodgeCapacityLock`: the resolved envelope is both the window and
    // the value the booking stores.
    const result = await checkCapacityForGuestRanges(
      LODGE,
      envelope.checkIn,
      envelope.checkOut,
      getCapacityGuestRanges(withNights, envelope.checkIn, envelope.checkOut),
    );

    expect(result.nightDetails.map((night) => storedDay(night.date))).toEqual(
      PROPOSAL_NIGHTS,
    );
    // THE MEASUREMENT. With the envelope still projected this was [0, 0, 2, 2]
    // over 07-02..07-05 - a four-night window two days early, counting no beds
    // on two of its nights and never inspecting 07-06 at all.
    expect(beds(result.nightDetails)).toEqual([2, 2, 2]);
  });

  it("REFUSES a proposal that does not fit the lodge, on that envelope", async () => {
    mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: 1 });
    const envelope = resolveBookingDateEnvelope(
      withNights,
      PROPOSAL_CHECK_IN,
      PROPOSAL_CHECK_OUT,
    );

    const result = await checkCapacityForGuestRanges(
      LODGE,
      envelope.checkIn,
      envelope.checkOut,
      getCapacityGuestRanges(withNights, envelope.checkIn, envelope.checkOut),
    );

    expect(result.available).toBe(false);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([
      -1, -1, -1,
    ]);
  });

  it("HOST AXIS: neither offset extreme moves the envelope", () => {
    for (const zone of HOST_EXTREMES) {
      withTimeZone(zone, () => {
        const envelope = resolveBookingDateEnvelope(
          withNights,
          PROPOSAL_CHECK_IN,
          PROPOSAL_CHECK_OUT,
        );
        expect(storedDay(envelope.checkIn), zone).toBe("2026-07-04");
        expect(storedDay(envelope.checkOut), zone).toBe("2026-07-07");
      });
    }
  });

  it("reads a night entry in every shape the TYPE admits, reachable or not", () => {
    // TWO OF THESE FOUR ARE DEFENSIVE, and the distinction is worth stating
    // rather than blurring. `GuestNightInput` is wider than any live producer:
    // the route's schema is `z.array(dateOnlyString)` and `ProposalGuest.nights`
    // is `string[]`, so what actually arrives is a canonical `yyyy-mm-dd`, and
    // the `@db.Date` row shape is what a stored `BookingGuestNight` looks like.
    // The SERIALISED row shape is not produced by anything here - it is the
    // contract boundary, the same one the offset-bearing string above marks.
    //
    // Worth pinning anyway: the longer ISO forms used to make
    // `new Date(entry + "T00:00:00.000Z")` an Invalid Date and throw on EVERY
    // zone, so decoding them correctly is a real widening rather than a
    // restatement. It is just not a shape the create path can hand over today.
    const shapes: Array<[string, BookingGuestInput["nights"]]> = [
      ["date-only strings (the reachable one)", PROPOSAL_NIGHTS],
      ["Date values", PROPOSAL_NIGHTS.map(day)],
      [
        "serialised @db.Date rows (defensive)",
        PROPOSAL_NIGHTS.map((value) => ({
          stayDate: `${value}T00:00:00.000Z`,
        })),
      ],
      [
        "@db.Date rows",
        PROPOSAL_NIGHTS.map((value) => ({ stayDate: day(value) })),
      ],
    ];
    for (const [label, nights] of shapes) {
      const envelope = resolveBookingDateEnvelope(
        [guest({ nights })],
        PROPOSAL_CHECK_IN,
        PROPOSAL_CHECK_OUT,
      );
      expect(storedDay(envelope.checkIn), label).toBe("2026-07-04");
      expect(storedDay(envelope.checkOut), label).toBe("2026-07-07");
    }
  });
});
