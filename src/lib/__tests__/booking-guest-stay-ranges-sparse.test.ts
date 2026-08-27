/**
 * #2628 — one definition of "expand a stay into nights", and it is sparse-aware.
 *
 * `BookingGuestNight` is the canonical night set; `BookingGuest.stayStart` /
 * `stayEnd` is a DERIVED half-open envelope whose `stayEnd` is the morning after
 * the last night (INV-DATE-012). They agree for a contiguous stay. For a sparse
 * one the envelope fills the internal gaps, so six sites that each expanded a
 * stay their own way disagreed about who is in a bed.
 *
 * The fixtures below use nights {10, 12} at July 2026 throughout: one stay, two
 * segments, one gap day. Frozen clock discipline — "today" is 2026-07-01, so
 * these are near-future dates, permanently.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  expandStayEnvelopeToNightKeys,
  getEarliestCurrentBedNightDate,
  getExplicitGuestBedNightKeys,
  getGuestBedNightKeys,
  getGuestDepartureMorningKeys,
  getNextGuestBedNightAfter,
  isGuestActiveOnNight,
  isGuestDepartureMorning,
  isGuestReturningOnDay,
} from "@/lib/booking-guest-stay-ranges";

const booking = {
  checkIn: parseDateOnly("2026-07-10"),
  checkOut: parseDateOnly("2026-07-13"),
};

/** Nights {10, 12}: in on the 10th, out on the 11th, back on the 12th. */
const sparseGuest = {
  stayStart: parseDateOnly("2026-07-10"),
  stayEnd: parseDateOnly("2026-07-13"),
  nights: [{ stayDate: parseDateOnly("2026-07-10") }, { stayDate: parseDateOnly("2026-07-12") }],
};

/** The same envelope, contiguous — the ordinary case that must not move. */
const contiguousGuest = {
  stayStart: parseDateOnly("2026-07-10"),
  stayEnd: parseDateOnly("2026-07-13"),
  nights: [
    { stayDate: parseDateOnly("2026-07-10") },
    { stayDate: parseDateOnly("2026-07-11") },
    { stayDate: parseDateOnly("2026-07-12") },
  ],
};

/** A pre-#713 guest carrying no night rows at all: envelope is all there is. */
const legacyGuest = {
  stayStart: parseDateOnly("2026-07-10"),
  stayEnd: parseDateOnly("2026-07-13"),
};

describe("expandStayEnvelopeToNightKeys", () => {
  it("is HALF-OPEN: the check-out date is a departure morning, never a night", () => {
    // INV-DATE-003. The single most dangerous line in this area — the planner is
    // fed one pseudo-guest per night with stayEnd = night + 1, so an inclusive
    // expansion is a double booking. `bed-allocation.test.ts` →
    // "pseudo-guest envelope (#2628)" pins the consequence.
    expect(
      expandStayEnvelopeToNightKeys(parseDateOnly("2026-07-10"), parseDateOnly("2026-07-13")),
    ).toEqual(["2026-07-10", "2026-07-11", "2026-07-12"]);
  });

  it("gives a one-night envelope exactly one night", () => {
    expect(
      expandStayEnvelopeToNightKeys(parseDateOnly("2026-07-10"), parseDateOnly("2026-07-11")),
    ).toEqual(["2026-07-10"]);
  });

  it("gives a zero-night or reversed envelope no nights at all", () => {
    // INV-DATE-008: checkIn == checkOut expands to nothing and is present on no
    // day. Reversed is not a legal shape, and yielding nothing is the safe read.
    expect(
      expandStayEnvelopeToNightKeys(parseDateOnly("2026-07-10"), parseDateOnly("2026-07-10")),
    ).toEqual([]);
    expect(
      expandStayEnvelopeToNightKeys(parseDateOnly("2026-07-13"), parseDateOnly("2026-07-10")),
    ).toEqual([]);
  });
});

describe("getGuestBedNightKeys", () => {
  it("reads the night set for a sparse stay, not the envelope", () => {
    expect(getGuestBedNightKeys(sparseGuest, booking)).toEqual([
      "2026-07-10",
      "2026-07-12",
    ]);
  });

  it("is byte-identical to the envelope for a contiguous stay", () => {
    expect(getGuestBedNightKeys(contiguousGuest, booking)).toEqual([
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ]);
    expect(getGuestBedNightKeys(legacyGuest, booking)).toEqual(
      getGuestBedNightKeys(contiguousGuest, booking),
    );
  });

  it("falls back to the booking envelope when the guest carries neither", () => {
    expect(getGuestBedNightKeys({}, booking)).toEqual([
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ]);
  });

  it("AGREES WITH isGuestActiveOnNight NIGHT FOR NIGHT", () => {
    // The property that makes this safe to route the counting surfaces at: the
    // set form and the frozen predicate cannot disagree about who holds a bed,
    // so a booking's "expected nights" and capacity's "who is here" stay one
    // answer. Swept over a window wider than the stay on both sides.
    for (const guest of [sparseGuest, contiguousGuest, legacyGuest, {}]) {
      const keys = new Set(getGuestBedNightKeys(guest, booking));
      for (let day = 8; day <= 15; day += 1) {
        const key = `2026-07-${String(day).padStart(2, "0")}`;
        expect(keys.has(key), key).toBe(
          isGuestActiveOnNight(guest, parseDateOnly(key), booking),
        );
      }
    }
  });
});

describe("getExplicitGuestBedNightKeys", () => {
  it("returns the explicit rows, sorted", () => {
    expect(getExplicitGuestBedNightKeys(sparseGuest)).toEqual([
      "2026-07-10",
      "2026-07-12",
    ]);
  });

  it("returns null — never an envelope — when the guest carries no night rows", () => {
    // This is the difference from `getGuestBedNightKeys`, and it is the whole
    // point of having both. The bed-allocation board and its lifecycle place
    // only explicitly listed nights, so a guest with none has nothing to
    // allocate; an envelope fallback there would advertise work on the officer
    // card that the board itself does not list.
    expect(getExplicitGuestBedNightKeys(legacyGuest)).toBeNull();
    expect(getExplicitGuestBedNightKeys({ ...legacyGuest, nights: [] })).toBeNull();
  });
});

describe("departure mornings", () => {
  it("gives a sparse stay ONE PER SEGMENT", () => {
    // Nights {10, 12}: they leave on the 11th, come back that evening, and
    // leave again on the 13th. A surface keyed on `stayEnd` alone sees only the
    // 13th, which is why the kiosk could not record the first departure.
    expect(getGuestDepartureMorningKeys(sparseGuest, booking)).toEqual([
      "2026-07-11",
      "2026-07-13",
    ]);
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-11"), booking)).toBe(true);
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-13"), booking)).toBe(true);
  });

  it("gives a contiguous or legacy stay exactly one, equal to stayEnd", () => {
    for (const guest of [contiguousGuest, legacyGuest]) {
      expect(getGuestDepartureMorningKeys(guest, booking)).toEqual(["2026-07-13"]);
      expect(isGuestDepartureMorning(guest, parseDateOnly("2026-07-11"), booking)).toBe(false);
      expect(isGuestDepartureMorning(guest, parseDateOnly("2026-07-13"), booking)).toBe(true);
    }
  });

  it("is NOT presence: a guest mid-stay is not departing", () => {
    // The distinction the kiosk depart endpoint depends on. On the 11th the
    // contiguous guest occupies both halves of the day, so they are present and
    // not departing; the sparse guest occupies only the morning, so they are.
    expect(isGuestDepartureMorning(contiguousGuest, parseDateOnly("2026-07-11"), booking)).toBe(
      false,
    );
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-11"), booking)).toBe(true);
  });

  it("is not an arrival either", () => {
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-10"), booking)).toBe(false);
    expect(isGuestDepartureMorning(sparseGuest, parseDateOnly("2026-07-12"), booking)).toBe(false);
  });

  it("gives a guest with no nights no departure mornings", () => {
    expect(
      getGuestDepartureMorningKeys(
        { stayStart: parseDateOnly("2026-07-10"), stayEnd: parseDateOnly("2026-07-10") },
        { checkIn: parseDateOnly("2026-07-10"), checkOut: parseDateOnly("2026-07-10") },
      ),
    ).toEqual([]);
  });
});

describe("returning on a later segment (#2628)", () => {
  // The kiosk's whole attendance model rides on this: `arrivedAt`/`departedAt`
  // is ONE pair for the stay, so a guest arriving for a second time lands
  // against a record that still says "departed". A contiguous stay can never be
  // in that position, which is what keeps the ordinary kiosk path untouched.
  it("is TRUE on a sparse stay's later arrival evening", () => {
    expect(isGuestReturningOnDay(sparseGuest, parseDateOnly("2026-07-12"), booking)).toBe(true);
  });

  it("is FALSE on the FIRST arrival, when nothing has been departed yet", () => {
    expect(isGuestReturningOnDay(sparseGuest, parseDateOnly("2026-07-10"), booking)).toBe(false);
  });

  it("is FALSE on a departure morning and on a gap day", () => {
    expect(isGuestReturningOnDay(sparseGuest, parseDateOnly("2026-07-11"), booking)).toBe(false);
    expect(isGuestReturningOnDay(sparseGuest, parseDateOnly("2026-07-13"), booking)).toBe(false);
  });

  it("is FALSE on EVERY day of a contiguous or legacy stay", () => {
    // The safety property, not a coincidence: the kiosk keeps its shipped
    // behaviour for every ordinary booking because this can never fire on one.
    for (const guest of [contiguousGuest, legacyGuest]) {
      for (const day of ["2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]) {
        expect(isGuestReturningOnDay(guest, parseDateOnly(day), booking)).toBe(false);
      }
    }
  });
});

describe("the next booked night after a date (#2628)", () => {
  // The bound the kiosk's chore sweep needs. Marking a guest departed clears the
  // suggested chores they can no longer do; without this the sweep is "every
  // date after today" and takes the chores of the segment they come back for.
  it("finds the night a sparse guest comes back for", () => {
    expect(getNextGuestBedNightAfter(sparseGuest, parseDateOnly("2026-07-11"), booking)).toEqual(
      parseDateOnly("2026-07-12"),
    );
  });

  it("is null once the stay has no nights left", () => {
    expect(
      getNextGuestBedNightAfter(sparseGuest, parseDateOnly("2026-07-13"), booking),
    ).toBeNull();
    expect(
      getNextGuestBedNightAfter(contiguousGuest, parseDateOnly("2026-07-13"), booking),
    ).toBeNull();
    expect(getNextGuestBedNightAfter(legacyGuest, parseDateOnly("2026-07-13"), booking)).toBeNull();
  });

  it("never returns the date itself, only a LATER night", () => {
    expect(getNextGuestBedNightAfter(contiguousGuest, parseDateOnly("2026-07-11"), booking)).toEqual(
      parseDateOnly("2026-07-12"),
    );
  });
});

describe("the current-or-future bed night boundary", () => {
  // The frozen clock puts "today" at 2026-07-01 (docs/TESTING.md).
  const TODAY = parseDateOnly("2026-07-01");

  it("starts at LAST NIGHT, because its occupant is still in the lodge", () => {
    // Night N runs to midday NZ on date N+1 (INV-DATE-002), so at any moment on
    // day D the person who slept on night D-1 may still be in their bed. A
    // guard written `stayDate >= today` forgets them and lets an admin retire a
    // bed somebody is lying in.
    expect(getEarliestCurrentBedNightDate(TODAY)).toEqual(parseDateOnly("2026-06-30"));
  });

  it("has NO default — the club's day is supplied, never assumed (#3123)", () => {
    /*
      This case used to assert that the boundary "defaults to the club's own
      today", and the name was the defect: the default was
      `getTodayDateOnly()`, which reads the CONTAINER's timezone, not the club's
      persisted one (`INV-CONFIG-002`). It passed because under test the two
      agree. This module reaches the browser bundle, so it cannot read the club's
      zone at all, and its one production caller is a bed-deactivation guard
      running under the global cohort key and the per-lodge capacity key — where
      `INV-LOCK-004` forbids the read outright. Deleting the default is the fix,
      and this is what stops one being added back.
    */
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/booking-guest-stay-ranges.ts"),
      "utf8",
    );
    expect(source).toContain(
      "export function getEarliestCurrentBedNightDate(today: Date): Date",
    );
    expect(source).not.toContain("getTodayDateOnly");
  });

  it("is the ONLY form of the boundary: no unused predicate rides beside it", () => {
    // #2628 review: an `isCurrentOrFutureBedNight(stayDate, today)` predicate
    // shipped here beside the date, and nothing in `src/` ever called it — the
    // one guard that moved needs the DATE, as a SQL lower bound
    // (`stayDate: { gte: getEarliestCurrentBedNightDate() }`), not a per-row
    // test. An exported helper with only a test for a caller reads as a
    // supported API and invites a second, in-memory copy of a boundary that has
    // to stay identical to the query's. If a real caller ever needs the
    // predicate form, add it back WITH that caller.
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/booking-guest-stay-ranges.ts"),
      "utf8",
    );
    expect(source).toContain("export function getEarliestCurrentBedNightDate(");
    expect(source).not.toContain("isCurrentOrFutureBedNight");
  });
});
