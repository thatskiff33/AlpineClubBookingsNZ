/**
 * #2622 — the one named operational-day rule.
 *
 * Everyone who stays a night is in the lodge from midday NZ on the day they
 * arrive to midday NZ on the day they leave. Day D therefore has a morning half
 * (owned by whoever booked night D-1) and an evening half (owned by whoever
 * booked night D), and presence is "occupies either half".
 *
 * Every case below is a fixed calendar fixture. Nothing here reads the clock.
 */
import { describe, expect, it } from "vitest";

import {
  getGuestOperationalDayPresence,
  getLodgeVisibleGuestsForDate,
  getOperationallyPresentGuestsForDay,
  isGuestActiveOnNight,
  isGuestArrivingOnDay,
  isGuestDepartingOnDay,
  isGuestOperationallyPresentOnDay,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

// A three-night contiguous stay: nights 10, 11, 12; checkout morning is the
// 13th. This is the ordinary booking shape, with no explicit night rows.
const BOOKING = { checkIn: day("2026-07-10"), checkOut: day("2026-07-13") };
const ENVELOPE_GUEST: GuestStayRange = {
  stayStart: day("2026-07-10"),
  stayEnd: day("2026-07-13"),
};

// The same stay expressed as explicit night rows (#713 sparse model).
const NIGHT_ROW_GUEST: GuestStayRange = {
  stayStart: day("2026-07-10"),
  stayEnd: day("2026-07-13"),
  nights: [
    { stayDate: day("2026-07-10") },
    { stayDate: day("2026-07-11") },
    { stayDate: day("2026-07-12") },
  ],
};

// D-M4's worked example: nights 5 and 8, with the 6th and 7th NOT booked.
const SPARSE_GUEST: GuestStayRange = {
  stayStart: day("2026-07-05"),
  stayEnd: day("2026-07-09"),
  nights: [{ stayDate: day("2026-07-05") }, { stayDate: day("2026-07-08") }],
};

function presence(guest: GuestStayRange, iso: string, booking = BOOKING) {
  const result = getGuestOperationalDayPresence(guest, day(iso), booking);
  return {
    morning: result.morning,
    evening: result.evening,
    present: result.present,
    isArriving: result.isArriving,
    isDeparting: result.isDeparting,
  };
}

describe("operational-day presence — contiguous stay", () => {
  for (const [label, guest] of [
    ["envelope-only guest", ENVELOPE_GUEST],
    ["explicit night rows", NIGHT_ROW_GUEST],
  ] as const) {
    describe(label, () => {
      it("is absent the day before arrival", () => {
        expect(presence(guest, "2026-07-09")).toEqual({
          morning: false,
          evening: false,
          present: false,
          isArriving: false,
          isDeparting: false,
        });
      });

      it("occupies only the evening half on the arrival day", () => {
        expect(presence(guest, "2026-07-10")).toEqual({
          morning: false,
          evening: true,
          present: true,
          isArriving: true,
          isDeparting: false,
        });
      });

      it("occupies both halves mid-stay", () => {
        expect(presence(guest, "2026-07-11")).toEqual({
          morning: true,
          evening: true,
          present: true,
          isArriving: false,
          isDeparting: false,
        });
        expect(presence(guest, "2026-07-12")).toEqual({
          morning: true,
          evening: true,
          present: true,
          isArriving: false,
          isDeparting: false,
        });
      });

      it("occupies only the MORNING half on the checkout day — the whole point of #2622", () => {
        expect(presence(guest, "2026-07-13")).toEqual({
          morning: true,
          evening: false,
          present: true,
          isArriving: false,
          isDeparting: true,
        });
      });

      it("is absent the day after checkout", () => {
        expect(presence(guest, "2026-07-14").present).toBe(false);
      });

      it("MUTATION PROBE: the checkout day is inside the operational span", () => {
        // Reverting the rule to the half-open night model (present iff the day
        // is a booked night) makes this fail: the 13th would drop out.
        const span = ["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]
          .filter((iso) => isGuestOperationallyPresentOnDay(guest, day(iso), BOOKING));
        expect(span).toEqual([
          "2026-07-10",
          "2026-07-11",
          "2026-07-12",
          "2026-07-13",
        ]);
      });

      it("MUTATION PROBE: the noon-boundary labels do not swap sides", () => {
        // Arrival is EVENING-only and departure is MORNING-only. Swapping the
        // two halves (or the two labels) fails both assertions at once.
        expect(isGuestArrivingOnDay(guest, day("2026-07-10"), BOOKING)).toBe(true);
        expect(isGuestDepartingOnDay(guest, day("2026-07-10"), BOOKING)).toBe(false);
        expect(isGuestArrivingOnDay(guest, day("2026-07-13"), BOOKING)).toBe(false);
        expect(isGuestDepartingOnDay(guest, day("2026-07-13"), BOOKING)).toBe(true);
      });
    });
  }
});

describe("operational-day presence — sparse stays (D-M4)", () => {
  const sparseBooking = { checkIn: day("2026-07-05"), checkOut: day("2026-07-09") };

  it("follows EACH segment's final night, not just the last one", () => {
    const present = [
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
    ].filter((iso) =>
      isGuestOperationallyPresentOnDay(SPARSE_GUEST, day(iso), sparseBooking),
    );
    expect(present).toEqual([
      "2026-07-05", // night 5, evening half
      "2026-07-06", // morning after night 5 — the first segment's departure
      "2026-07-08", // night 8, evening half
      "2026-07-09", // morning after night 8 — the final departure
    ]);
  });

  it("MUTATION PROBE: the gap day gains no presence", () => {
    // Day 7 is adjacent to no booked night: neither half is occupied. Any rule
    // that spans the gap (an envelope comparison, or "everything between the
    // first and last night") lights this up.
    expect(presence(SPARSE_GUEST, "2026-07-07", sparseBooking)).toEqual({
      morning: false,
      evening: false,
      present: false,
      isArriving: false,
      isDeparting: false,
    });
  });

  it("labels each segment's edges independently", () => {
    expect(presence(SPARSE_GUEST, "2026-07-05", sparseBooking).isArriving).toBe(true);
    expect(presence(SPARSE_GUEST, "2026-07-06", sparseBooking).isDeparting).toBe(true);
    expect(presence(SPARSE_GUEST, "2026-07-08", sparseBooking).isArriving).toBe(true);
    expect(presence(SPARSE_GUEST, "2026-07-09", sparseBooking).isDeparting).toBe(true);
  });

  it("is absent after the final departure morning", () => {
    expect(
      isGuestOperationallyPresentOnDay(SPARSE_GUEST, day("2026-07-10"), sparseBooking),
    ).toBe(false);
  });
});

describe("operational-day presence — degenerate stays", () => {
  it("a zero-night booking is never present on any day", () => {
    const zeroNight = { checkIn: day("2026-07-10"), checkOut: day("2026-07-10") };
    const guest: GuestStayRange = {
      stayStart: day("2026-07-10"),
      stayEnd: day("2026-07-10"),
    };
    for (const iso of ["2026-07-09", "2026-07-10", "2026-07-11"]) {
      expect(
        isGuestOperationallyPresentOnDay(guest, day(iso), zeroNight),
        iso,
      ).toBe(false);
    }
  });

  it("a guest with no stay range of their own falls back to the booking envelope", () => {
    const guest: GuestStayRange = {};
    expect(isGuestOperationallyPresentOnDay(guest, day("2026-07-13"), BOOKING)).toBe(true);
    expect(isGuestOperationallyPresentOnDay(guest, day("2026-07-14"), BOOKING)).toBe(false);
  });

  it("an empty night array keeps the documented envelope fallback", () => {
    const guest: GuestStayRange = {
      stayStart: day("2026-07-10"),
      stayEnd: day("2026-07-13"),
      nights: [],
    };
    expect(isGuestOperationallyPresentOnDay(guest, day("2026-07-13"), BOOKING)).toBe(true);
  });

  it("accepts Date and yyyy-mm-dd night entries as well as relation rows", () => {
    const guest: GuestStayRange = {
      stayStart: day("2026-07-10"),
      stayEnd: day("2026-07-12"),
      nights: [day("2026-07-10"), "2026-07-11"],
    };
    expect(isGuestOperationallyPresentOnDay(guest, day("2026-07-12"), BOOKING)).toBe(true);
    expect(isGuestDepartingOnDay(guest, day("2026-07-12"), BOOKING)).toBe(true);
    expect(isGuestOperationallyPresentOnDay(guest, day("2026-07-13"), BOOKING)).toBe(false);
  });
});

describe("getOperationallyPresentGuestsForDay", () => {
  const departing: GuestStayRange & { id: string } = {
    id: "leaving",
    stayStart: day("2026-07-10"),
    stayEnd: day("2026-07-13"),
  };
  const arriving: GuestStayRange & { id: string } = {
    id: "arriving",
    stayStart: day("2026-07-13"),
    stayEnd: day("2026-07-15"),
  };
  const goneYesterday: GuestStayRange & { id: string } = {
    id: "gone",
    stayStart: day("2026-07-10"),
    stayEnd: day("2026-07-12"),
  };
  const turnoverBooking = { checkIn: day("2026-07-10"), checkOut: day("2026-07-15") };

  it("returns both sides of a same-day turnover and nobody who left yesterday", () => {
    const present = getOperationallyPresentGuestsForDay(
      [departing, arriving, goneYesterday],
      day("2026-07-13"),
      turnoverBooking,
    );
    expect(present.map((guest) => guest.id)).toEqual(["leaving", "arriving"]);
  });

  it("labels the turnover pair on opposite sides of midday", () => {
    expect(isGuestDepartingOnDay(departing, day("2026-07-13"), turnoverBooking)).toBe(true);
    expect(isGuestArrivingOnDay(departing, day("2026-07-13"), turnoverBooking)).toBe(false);
    expect(isGuestArrivingOnDay(arriving, day("2026-07-13"), turnoverBooking)).toBe(true);
    expect(isGuestDepartingOnDay(arriving, day("2026-07-13"), turnoverBooking)).toBe(false);
  });

  it("returns an empty list for null/undefined guest collections", () => {
    expect(getOperationallyPresentGuestsForDay(null, day("2026-07-13"), BOOKING)).toEqual([]);
    expect(getOperationallyPresentGuestsForDay(undefined, day("2026-07-13"), BOOKING)).toEqual([]);
  });
});

describe("the night model stays separate", () => {
  it("isGuestActiveOnNight still excludes the checkout day", () => {
    // The whole point of adding named operational-day helpers is that the NIGHT
    // model — which capacity, pricing and the whole-lodge rules read — is left
    // exactly as it was. A guest with nights 10-12 sleeps on none of the 13th.
    expect(isGuestActiveOnNight(ENVELOPE_GUEST, day("2026-07-12"), BOOKING)).toBe(true);
    expect(isGuestActiveOnNight(ENVELOPE_GUEST, day("2026-07-13"), BOOKING)).toBe(false);
    expect(isGuestActiveOnNight(SPARSE_GUEST, day("2026-07-06"), BOOKING)).toBe(false);
  });
});

describe("getLodgeVisibleGuestsForDate: the lobby wall's two named models", () => {
  const guests = [ENVELOPE_GUEST, SPARSE_GUEST];

  it("without includeDepartureDate it is the night model", () => {
    expect(getLodgeVisibleGuestsForDate(guests, day("2026-07-13"), BOOKING)).toEqual([]);
    expect(
      getLodgeVisibleGuestsForDate(guests, day("2026-07-12"), BOOKING, {
        includeDepartureDate: false,
      }),
    ).toEqual([ENVELOPE_GUEST]);
  });

  it("with includeDepartureDate an envelope stay gains its checkout day", () => {
    expect(
      getLodgeVisibleGuestsForDate(guests, day("2026-07-13"), BOOKING, {
        includeDepartureDate: true,
      }),
    ).toEqual([ENVELOPE_GUEST]);
  });

  it("shows a sparse stay on EVERY morning it leaves, per segment (#2735)", () => {
    // SPARSE_GUEST books nights N and N+3 (the 5th and the 8th), so they are in
    // the lodge until midday on the 6th and again until midday on the 9th. The
    // wall used to admit only the 9th — the morning after the FINAL night — so
    // on the 6th it showed them as already gone while they were standing in the
    // building. Every other operational surface was made per-segment by #2628.
    //
    // #2622 and #2628 both REFUSED this, and were right to at the time: the
    // wall's sole-occupancy night count was derived from this list, so one extra
    // morning became a phantom night and could drop a blockout and publish guest
    // names on an unauthenticated screen (INV-DATE-006, issue hoppers99/AlpineClubBookingsNZ#58). #2735
    // decoupled that count FIRST — see `lodge-display-state.test.ts`, which
    // fails if a departure morning is ever counted as a night — and only then
    // widened this. If the count is ever coupled back, this has to narrow again.
    expect(
      getLodgeVisibleGuestsForDate([SPARSE_GUEST], day("2026-07-06"), BOOKING, {
        includeDepartureDate: true,
      }),
    ).toEqual([SPARSE_GUEST]);
    expect(
      getOperationallyPresentGuestsForDay([SPARSE_GUEST], day("2026-07-06"), BOOKING),
    ).toEqual([SPARSE_GUEST]);
  });

  it("admits the morning after EACH booked night and no other day", () => {
    for (const [iso, visible] of [
      ["2026-07-04", false], // day before the first night
      ["2026-07-05", true], // first booked night
      ["2026-07-06", true], // its departure morning — here until midday
      ["2026-07-07", false], // gap day, adjacent to no booked night
      ["2026-07-08", true], // final booked night
      ["2026-07-09", true], // its departure morning
      ["2026-07-10", false],
    ] as const) {
      expect(
        getLodgeVisibleGuestsForDate([SPARSE_GUEST], day(iso), BOOKING, {
          includeDepartureDate: true,
        }),
        iso,
      ).toEqual(visible ? [SPARSE_GUEST] : []);
    }
  });

  it("NIGHT MODEL UNTOUCHED: a departure morning is still not a night", () => {
    // The half of #2735 that must NOT move. Sole-occupancy detection, capacity
    // and pricing all read this; if either of the sparse stay's departure
    // mornings ever answers true here, the wall can drop a blockout.
    for (const iso of ["2026-07-06", "2026-07-07", "2026-07-09"]) {
      expect(
        getLodgeVisibleGuestsForDate([SPARSE_GUEST], day(iso), BOOKING, {
          includeDepartureDate: false,
        }),
        iso,
      ).toEqual([]);
    }
    for (const iso of ["2026-07-05", "2026-07-08"]) {
      expect(
        getLodgeVisibleGuestsForDate([SPARSE_GUEST], day(iso), BOOKING, {
          includeDepartureDate: false,
        }),
        iso,
      ).toEqual([SPARSE_GUEST]);
    }
  });
});
