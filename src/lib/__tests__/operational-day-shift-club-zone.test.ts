/**
 * #3100 — shifting a lodge-night key is calendar arithmetic, and no zone may
 * touch it.
 *
 * `shiftDateOnlyKey` used to build a UTC-midnight instant from the key, add
 * `days * 24h`, and read the result back with `formatDateOnlyForTimeZone` — a
 * projection into the environment zone. Measured on `America/Denver`:
 *
 * | shift               | Pacific/Auckland | UTC          | America/Denver   |
 * | ------------------- | ---------------- | ------------ | ---------------- |
 * | `2026-07-04` **+1** | `2026-07-05`     | `2026-07-05` | **`2026-07-04`** |
 * | `2026-07-04` **-1** | `2026-07-03`     | `2026-07-03` | **`2026-07-02`** |
 *
 * So "the next night" was the SAME night and "the previous night" skipped one,
 * on every call rather than at a boundary. The docblock justifying the
 * projection said the key was re-anchored at "UTC midnight, which is midday NZ
 * (UTC+12/+13)" and so could never roll the day the wrong way — the exact claim
 * epic #2988 exists to remove, and one `INV-DATE-010` no longer makes.
 *
 * ## Why no existing suite caught it
 *
 * Every one of them runs with the environment zone resolving to
 * `Pacific/Auckland`, where the projection is the identity. So this file moves
 * the environment axis with a config mock, and the host axis with `withTimeZone`
 * — separately, because a suite that moved them together could not tell a
 * projection through the configured zone from one through the host's.
 *
 * ## What this file may and may not assert
 *
 * `dateOnlyKey` — this module's key derivation for a `Date` argument — still
 * projects a stored `@db.Date` value through the environment zone. That is a
 * SEPARATE defect, outside #3100's scope and tracked as #3107, and it is NOT
 * merely cosmetic: because a `string` night is taken verbatim while a `Date`
 * night is projected, the two live in different frames, and both frames occur in
 * production. The measured consequence is in the #3107 group at the foot of this
 * file. So no assertion here may pin an absolute day derived from a `Date`, or it
 * would pin that defect as correct. Two groups, therefore:
 *
 * - **String-fed** cases reach no projection at all (`nightEntryKey` returns a
 *   `yyyy-mm-dd` string verbatim), so they assert EXACT days, and those days are
 *   the same in every zone.
 * - **`Date`-fed** cases keep every input in one frame and assert the presence
 *   RELATION. A relation between keys derived the same way holds whatever the
 *   frame is, so these are zone-independent too, and they exercise the `-1`
 *   sites, which cannot be reached without a `Date`.
 *
 * ## Two spellings that look like the fix and are not
 *
 * Both are named in #3100 and one is measured below: adding
 * `24 * 60 * 60 * 1000` to an instant breaks on a 25-hour day even when the zone
 * is read correctly, and keeping the instant round trip with a UTC reader is
 * correct only until somebody changes the encoder.
 */
import { describe, expect, it, vi } from "vitest";

// `APP_TIME_ZONE` is frozen at module load, so the environment zone has to move
// above this file's imports. The mock moves it ALONE, leaving the host wherever
// the runner put it.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import {
  expandStayEnvelopeToNightKeys,
  getExplicitGuestBedNightKeys,
  getGuestDepartureMorningKeys,
  getGuestOperationalDayPresence,
  isGuestActiveOnNight,
  isGuestDepartureMorning,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import {
  requireCalendarDate,
  startOfClubDay,
  unvalidatedLegacyClubTimeZone,
} from "@/lib/club-time";
import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/** A `@db.Date` value: the calendar day encoded at UTC midnight. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Both offset extremes, to prove the host cannot move any answer here. */
const HOST_EXTREMES = ["Pacific/Pago_Pago", "Pacific/Kiritimati"];

const BOOKING = { checkIn: day("2026-07-04"), checkOut: day("2026-07-07") };

const DEPARTING = {
  morning: true,
  evening: false,
  present: true,
  isArriving: false,
  isDeparting: true,
};

function presence(guest: GuestStayRange, dayValue: Date) {
  const result = getGuestOperationalDayPresence(guest, dayValue, BOOKING);
  return {
    morning: result.morning,
    evening: result.evening,
    present: result.present,
    isArriving: result.isArriving,
    isDeparting: result.isDeparting,
  };
}

describe("#3100 premise: the projection this fix removes really is reachable", () => {
  it("pins the environment zone behind Greenwich, so nothing here is vacuous", () => {
    // If either assertion fails, every kill below is measuring the identity.
    expect(APP_TIME_ZONE).toBe("America/Denver");
    expect(formatDateOnlyForTimeZone(day("2026-07-04"), APP_TIME_ZONE)).toBe(
      "2026-07-03",
    );
  });

  it("MEASURES the forbidden fix: +24h on an instant loses a 25-hour day", () => {
    // `America/Denver` falls back on 2026-11-01, so that local day is 25 hours
    // long. Adding 24 hours to its first instant lands INSIDE it — 23:00 the
    // same evening — so "the next night" is the same night again, with the zone
    // read perfectly correctly. That is why the shift is day-based rather than
    // millisecond-based, and it is why #3100 forbids this spelling.
    const zone = unvalidatedLegacyClubTimeZone("America/Denver");
    const fallBackDay = startOfClubDay(requireCalendarDate("2026-11-01"), zone);
    const plus24h = new Date(fallBackDay.getTime() + 24 * 60 * 60 * 1000);
    expect(formatDateOnlyForTimeZone(plus24h, APP_TIME_ZONE)).toBe("2026-11-01");

    // The calendar answer, which takes no zone and no instant at all.
    expect(
      getGuestDepartureMorningKeys({ nights: ["2026-11-01"] }, BOOKING),
    ).toEqual(["2026-11-02"]);
  });
});

describe("#3100 the +1 sites, fed strings: exact days, no projection anywhere", () => {
  // `getGuestDepartureMorningKeys` over an explicit night set reaches
  // `shiftDateOnlyKey` and nothing else zone-shaped: the night keys are the
  // strings as given. Before the fix each shift returned the night itself, which
  // the `!booked.has(...)` filter then dropped — so a guest had NO departure
  // morning at all and the kiosk could record no check-out.

  it("a one-night stay departs the morning after that night", () => {
    expect(
      getGuestDepartureMorningKeys({ nights: ["2026-07-04"] }, BOOKING),
    ).toEqual(["2026-07-05"]);
  });

  it("a sparse stay departs once per segment", () => {
    expect(
      getGuestDepartureMorningKeys(
        { nights: ["2026-07-10", "2026-07-12"] },
        BOOKING,
      ),
    ).toEqual(["2026-07-11", "2026-07-13"]);
  });

  it("crosses a DST transition in the configured zone, both ways", () => {
    // `America/Denver` springs forward on 2026-03-08 (a 23-hour day) and falls
    // back on 2026-11-01 (25 hours). Calendar arithmetic is indifferent to both,
    // which is the property being asserted rather than a happy accident.
    for (const [night, morning] of [
      ["2026-03-07", "2026-03-08"],
      ["2026-03-08", "2026-03-09"],
      ["2026-10-31", "2026-11-01"],
      ["2026-11-01", "2026-11-02"],
      // And New Zealand's own two, since the deleted docblock's premise was
      // specifically about NZ daylight saving: it ends 2026-04-05 and starts
      // 2026-09-27.
      ["2026-04-04", "2026-04-05"],
      ["2026-09-26", "2026-09-27"],
    ]) {
      expect(
        getGuestDepartureMorningKeys({ nights: [night] }, BOOKING),
        night,
      ).toEqual([morning]);
    }
  });

  it("crosses a month, a year and a leap day", () => {
    for (const [night, morning] of [
      ["2026-07-31", "2026-08-01"],
      ["2026-12-31", "2027-01-01"],
      ["2028-02-28", "2028-02-29"],
      ["2028-02-29", "2028-03-01"],
    ]) {
      expect(
        getGuestDepartureMorningKeys({ nights: [night] }, BOOKING),
        night,
      ).toEqual([morning]);
    }
  });

  it("HOST AXIS: neither offset extreme moves any of it", () => {
    for (const zone of HOST_EXTREMES) {
      withTimeZone(zone, () => {
        expect(
          getGuestDepartureMorningKeys({ nights: ["2026-07-04"] }, BOOKING),
          zone,
        ).toEqual(["2026-07-05"]);
      });
    }
  });
});

describe("#3100 the -1 sites, one frame: the presence relation", () => {
  // The morning half of day D is D-1's night (`INV-DATE-004`). Before the fix
  // the shift returned D-2, so a one-night guest was reported ABSENT on the
  // morning they leave and PRESENT the day after — which is what a custodian and
  // the lodge display run on.

  const ONE_NIGHT: GuestStayRange = { nights: [day("2026-07-04")] };

  it("the morning they leave is theirs", () => {
    expect(presence(ONE_NIGHT, day("2026-07-05"))).toEqual(DEPARTING);
  });

  it("the day after that is not", () => {
    expect(presence(ONE_NIGHT, day("2026-07-06"))).toEqual({
      morning: false,
      evening: false,
      present: false,
      isArriving: false,
      isDeparting: false,
    });
  });

  it("a second night is not a second arrival", () => {
    const twoNights: GuestStayRange = {
      nights: [day("2026-07-04"), day("2026-07-05")],
    };
    expect(presence(twoNights, day("2026-07-05"))).toEqual({
      morning: true,
      evening: true,
      present: true,
      isArriving: false,
      isDeparting: false,
    });
  });

  it("isGuestDepartureMorning agrees with it, on the same two days", () => {
    expect(isGuestDepartureMorning(ONE_NIGHT, day("2026-07-05"), BOOKING)).toBe(
      true,
    );
    expect(isGuestDepartureMorning(ONE_NIGHT, day("2026-07-06"), BOOKING)).toBe(
      false,
    );
  });

  it("crosses a DST transition in the configured zone, both ways", () => {
    // The absolute days here belong to `dateOnlyKey`'s frame, which this file
    // does not pin — but the SHIFT still steps across Denver's spring-forward
    // (2026-03-08) and its fall-back (2026-11-01), which is what needed
    // covering.
    for (const [night, morning] of [
      [day("2026-03-08"), day("2026-03-09")],
      [day("2026-11-02"), day("2026-11-03")],
    ]) {
      expect(
        presence({ nights: [night] }, morning),
        night.toISOString(),
      ).toEqual(DEPARTING);
    }
  });

  it("HOST AXIS: neither offset extreme moves the relation", () => {
    for (const zone of HOST_EXTREMES) {
      withTimeZone(zone, () => {
        expect(presence(ONE_NIGHT, day("2026-07-05")), zone).toEqual(DEPARTING);
      });
    }
  });
});

describe("#3100 the envelope expander steps by a day, so its loop ends", () => {
  /*
    NOTE FOR A MUTATION PROBE: reinstating the projection does not make this
    group FAIL, it makes it run away. `expandStayEnvelopeToNightKeys` steps with
    `shiftDateOnlyKey`, and a step that returns its own argument never reaches
    `endKey`.

    BE PRECISE ABOUT WHY THAT DEFEATS VITEST, because the obvious explanation is
    wrong and an earlier revision of this note published it. Vitest cannot
    INTERRUPT a synchronous loop, but it does report a timeout: measured, an
    8-second terminating busy loop under `{ timeout: 1000 }` ran to completion
    and vitest then failed it with `Error: Test timed out in 1000ms.` So a slow
    synchronous assertion CAN be bounded with `timeout`, and a reader who
    believes otherwise skips a bound that would have worked. What defeats vitest
    here is NON-TERMINATION, not synchrony.

    Nor does the mutant hang for ever. It pushes one identical string until V8
    aborts: `FATAL ERROR: Reached heap limit Allocation failed`, process exit
    134 — under a second at `--max-old-space-size=256`, minutes at the default
    cap, and on CI a slow worker crash rather than an assertion. Deliberately
    stated qualitatively: the array holds hundreds of thousands of references to
    a SINGLE retained string, so the cost is tens of MB per million iterations,
    and the throughput and heap-delta samples this lane took differ by machine
    (719,694 vs 817,152 keys in ~2 s; 19.1 vs 31.1 MB for the same 719,694
    pushes). A figure that moves between machines does not belong in a comment as
    if it were a constant — an earlier revision of this note said `~91 MB`, which
    is a whole vitest worker's `heapUsed`, not this loop's footprint.

    The fast, clean kill for the same step is the string-fed group above. Since
    #3106 there is also a source-text one:
    `guest-stay-expansion-census.test.ts` → "and its STEP is calendar arithmetic,
    by a literal one day" fails in 6 ms, which is the guard a future regression
    actually wants. That file also pins the half-open `key < endKey;` shape,
    which is why the loop stays a loop; this group is here because the expander
    is the third `+1` call site.
  */

  it("agrees with the explicit night set it must be equivalent to", () => {
    // Both sides derive their keys from the same `Date`s through the same
    // derivation; only the envelope side takes a shift. So this asserts the
    // equivalence `booking-guest-stay-ranges-sparse.test.ts` claims, in a zone
    // where the shift used to break it, without pinning either side's frame.
    const envelope = expandStayEnvelopeToNightKeys(
      BOOKING.checkIn,
      BOOKING.checkOut,
    );
    const explicit = getExplicitGuestBedNightKeys({
      nights: [day("2026-07-04"), day("2026-07-05"), day("2026-07-06")],
    });
    expect(envelope).toEqual(explicit);
    expect(envelope).toHaveLength(3);
  });

  it("stays half-open: a checkout morning is never a night", () => {
    // The pseudo-guest shape both bed-allocation planners are fed, one per night.
    expect(
      expandStayEnvelopeToNightKeys(day("2026-07-04"), day("2026-07-05")),
    ).toHaveLength(1);
    expect(
      expandStayEnvelopeToNightKeys(day("2026-07-04"), day("2026-07-04")),
    ).toEqual([]);
  });

  it("HOST AXIS: neither offset extreme changes the night count", () => {
    for (const zone of HOST_EXTREMES) {
      withTimeZone(zone, () => {
        expect(
          expandStayEnvelopeToNightKeys(BOOKING.checkIn, BOOKING.checkOut),
          zone,
        ).toHaveLength(3);
      });
    }
  });
});

describe("#3107 the frame split this fix did NOT close, now closed", () => {
  /*
    THE AGREEMENT NOBODY WAS ASSERTING. This file's two groups deliberately run
    in two different key frames — the string-fed group takes its nights verbatim,
    the `Date`-fed group has them projected by `dateOnlyKey` — and nothing
    anywhere asserted that they describe the same nights. They do not, behind
    Greenwich, and that gap is what let #3106's own pull-request body claim an
    internal agreement that does not hold.

    IT IS NOT CONFINED TO TESTS. `ProposalGuest.nights` is declared `string[]`
    (`booking-exception-requests.ts`), and `createModificationExceptionRequest`
    passes it straight through as `GuestStayRange.nights` into
    `checkCapacityForGuestRanges`, which keys each night with `dateOnlyKey`.
    Measured on `America/Denver` for a two-guest, three-night proposal, the
    admission check counted 0 proposed beds on two of the three nights instead of
    2 — under `acquireGlobalBookingLock` + `acquireLodgeCapacityLock`, on the
    branch that reserves beds. That is a capacity-admission defect, it predates
    #3100, and #3100 does not touch it: `isGuestActiveOnNight` takes no shift.

    THIS BLOCK ASSERTED THE SPLIT AS AN INEQUALITY, and said so: "it goes RED the
    moment #3107 makes the two frames agree — which is when it must be rewritten
    to `toEqual`. Do not delete it then; flip it." #3107 has landed, and it is
    flipped rather than deleted, so the same two cases now hold the agreement they
    were written to wait for.

    THE ABSOLUTE DAYS ARE NOW ASSERTED, which this file previously forbade. The
    reason for the ban was that `dateOnlyKey` projected, so pinning a
    `Date`-derived day would have pinned the defect as correct. It decodes now, so
    a `Date`-fed key names the day the column holds in every zone and there is
    nothing left for an absolute assertion to freeze wrongly.
  */
  const LOGICAL_NIGHTS = ["2026-07-04", "2026-07-05", "2026-07-06"];

  it("string-fed and Date-fed nights AGREE for the same logical stay", () => {
    const stringFed = getExplicitGuestBedNightKeys({ nights: LOGICAL_NIGHTS });
    const dateFed = getExplicitGuestBedNightKeys({ nights: LOGICAL_NIGHTS.map(day) });

    // Verbatim: no projection is reachable from a `yyyy-mm-dd` string, in any zone.
    expect(stringFed).toEqual(LOGICAL_NIGHTS);
    // And the `Date` side now decodes the day its column holds, so the two frames
    // are one frame. This is the assertion #3106 could not make.
    expect(dateFed).toEqual(stringFed);
  });

  it("so one logical night is occupied whichever shape it arrives in", () => {
    const night = day("2026-07-04");
    expect(isGuestActiveOnNight({ nights: [night] }, night, BOOKING)).toBe(true);
    // This was `false` while the string was taken verbatim and the `Date` was
    // projected. The same logical night being simultaneously occupied and
    // unoccupied is what under-counted proposed beds inside the capacity lock.
    expect(isGuestActiveOnNight({ nights: ["2026-07-04"] }, night, BOOKING)).toBe(
      true,
    );
  });
});
