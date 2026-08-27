/**
 * CT-4 (#2870), group F4b, defect 3: THE PREVIEW AND THE APPLY PATH MUST
 * VALIDATE THE SAME WINDOW.
 *
 * `resolveTargetDates` (`src/lib/booking-modify-validation.ts`) is the apply
 * path's date-window validator. Its preview twin is the block at
 * `src/app/api/bookings/[id]/modify-quote/route.ts` around the
 * `isInProgressEdit` branch, and the comment beside them says the two "compute
 * the same answer rather than a lookalike".
 *
 * They did not. Group B (#3056) corrected the preview side onto `storedDateOnly`
 * and left the apply side on `normalizeDateOnlyForTimeZone`, which reads the
 * value through `APP_TIME_ZONE`. So for a club behind Greenwich the quote route
 * priced and allowed one window while the save refused another, a day apart —
 * and #2870's ledger recorded the pair as "internally consistent with each
 * other, so there is no straddle today" for two whole groups after that stopped
 * being true.
 *
 * ## What makes these cases discriminating
 *
 * `getBookingEditPolicy` reads `input.checkIn` through `storedDateOnly`, and
 * since #3123 its `today` is a REQUIRED VALUE the caller supplies from the
 * club's persisted zone — it used to default to `APP_TIME_ZONE`, the
 * container's claim. So the comparisons below are stored-day-against-club-day
 * on both sides. The defect was a validator sitting beside a corrected policy
 * and reading the same column differently — the "corrected producer feeding an
 * uncorrected consumer" shape this epic keeps finding.
 *
 * The `America/Denver` mock below is now here for ONE purpose only: the PREMISE
 * case, which proves the environment's zone still projects a different day, so
 * that every other case demonstrates the club's day winning over it rather than
 * agreeing with it by luck.
 *
 * The frozen clock is `2026-07-01T00:00:00.000Z`. The club's day under test is
 * held at `2026-06-30` — the same day the fixtures were always built against —
 * so `editPolicy.today` is `2026-06-30` and `tomorrow` is `2026-07-01`. Every
 * fixture below is placed against those two days deliberately: a stored
 * `2026-07-01` read as itself is AFTER today, and read through Denver is
 * `2026-06-30`, which is not. One day decides whether the member is refused.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import {
  formatDateOnly,
  formatDateOnlyForTimeZone,
  getTodayDateOnly,
} from "@/lib/date-only";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import {
  resolveTargetDates,
  type BatchModifyInput,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * The CLUB's day for this suite (#3123), supplied as a value rather than
 * projected from the process clock. Deliberately the day the mocked
 * `APP_TIME_ZONE` also produces at the frozen instant, so the fixtures keep the
 * geometry the docblock describes — the PREMISE case is what proves the two are
 * separate dials, and every other case now takes the club's.
 */
const CLUB_TODAY = new Date("2026-06-30T00:00:00.000Z");

function makeBooking(
  status: string,
  checkIn: string,
  checkOut: string,
): LoadedBookingForModify {
  return {
    status,
    checkIn: day(checkIn),
    checkOut: day(checkOut),
    guests: [{ id: "g1", stayStart: day(checkIn), stayEnd: day(checkOut) }],
  } as unknown as LoadedBookingForModify;
}

/**
 * The preview twin's decision, expressed in the SAME terms the quote route uses
 * — `storedDateOnly` on both comparisons. This is the oracle: it is what
 * `modify-quote/route.ts` computes, transcribed rather than imported, because
 * importing the route would drag its whole module graph in and prove nothing
 * about the text that actually ships there.
 */
// `Role` has no `MEMBER`: an ordinary member is `USER`, and `isAdmin(role)` in
// `booking-edit-policy.ts` is the only thing either function asks of it.
function previewRefusesSelfServiceWindow(
  booking: LoadedBookingForModify,
  requestedCheckIn: Date,
): boolean {
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: "USER",
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    today: CLUB_TODAY,
  });
  return storedDateOnly(requestedCheckIn) <= editPolicy.today;
}

function previewRefusesInProgressExtension(
  booking: LoadedBookingForModify,
  requestedCheckOut: Date,
): boolean {
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: "USER",
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    today: CLUB_TODAY,
  });
  const editableFrom = editPolicy.editableFrom;
  return Boolean(editableFrom && storedDateOnly(requestedCheckOut) < editableFrom);
}

describe("preview and apply validate the same date window", () => {
  it("PREMISE: the mocked zone puts the club's today a day behind the stored day", () => {
    expect(APP_TIME_ZONE).toBe("America/Denver");
    /*
     * `APP_TIME_ZONE` PASSED ON PURPOSE, and this is the one place in this file
     * where that is right (#3123). Everywhere else the club's day arrives as
     * `CLUB_TODAY`, a value; here the SUBJECT of the assertion is the
     * environment's own projection, because the premise's whole job is to show
     * that the environment still answers differently from the club. Naming a
     * zone literal instead would assert something about `America/Denver` rather
     * than about the environment, and the case would stop discriminating the
     * moment the mock above changed.
     */
    // The frozen clock instant, read in Denver, is still 30 June.
    expect(formatDateOnly(getTodayDateOnly(APP_TIME_ZONE))).toBe("2026-06-30");
    // And a stored 1 July projected through Denver becomes 30 June, which is
    // the single day that decides every case below.
    expect(formatDateOnlyForTimeZone(day("2026-07-01"), APP_TIME_ZONE)).toBe(
      "2026-06-30",
    );
  });

  it("a future self-service edit the preview allows is not refused on save", () => {
    // Stored check-in 1 July, club today 30 June: a future booking, so the
    // self-service window is open. Projected through Denver the check-in reads
    // 30 June, which is "today or earlier" — and the apply path refused it while
    // the quote route priced it.
    const booking = makeBooking("CONFIRMED", "2026-07-01", "2026-07-04");
    const input: BatchModifyInput = { pricingMode: "recalculate" };

    expect(previewRefusesSelfServiceWindow(booking, booking.checkIn)).toBe(false);
    expect(() =>
      resolveTargetDates({ booking, role: "USER", input, today: CLUB_TODAY }),
    ).not.toThrow();
  });

  it("an in-progress extension to `editableFrom` is allowed by both", () => {
    // Stored 29 June -> 5 July with club today 30 June is the in-progress
    // window, so `editableFrom` is tomorrow, 1 July. Shortening the stay to
    // check out on 1 July is exactly the boundary the gate permits; projected
    // through Denver it reads 30 June and was refused.
    const booking = makeBooking("PAID", "2026-06-29", "2026-07-05");
    const input: BatchModifyInput = {
      checkOut: "2026-07-01",
      pricingMode: "recalculate",
    };

    expect(previewRefusesInProgressExtension(booking, day("2026-07-01"))).toBe(
      false,
    );
    const result = resolveTargetDates({ booking, role: "USER", input, today: CLUB_TODAY });
    expect(result.isInProgressEdit).toBe(true);
    expect(formatDateOnly(result.newCheckOut)).toBe("2026-07-01");
  });

  it("and an in-progress check-out BEFORE `editableFrom` is still refused", () => {
    const booking = makeBooking("PAID", "2026-06-29", "2026-07-05");
    const input: BatchModifyInput = {
      checkOut: "2026-06-30",
      pricingMode: "recalculate",
    };

    expect(previewRefusesInProgressExtension(booking, day("2026-06-30"))).toBe(
      true,
    );
    expect(() => resolveTargetDates({ booking, role: "USER", input, today: CLUB_TODAY })).toThrow(
      "NZ today and earlier are locked for self-service changes",
    );
  });

  it("the in-progress check-in lock still fires on a real check-in change", () => {
    // Both sides of this comparison always moved together, so it was never a
    // straddle — but it reads the same column and must keep its behaviour.
    const booking = makeBooking("PAID", "2026-06-29", "2026-07-05");
    const input: BatchModifyInput = {
      checkIn: "2026-06-28",
      checkOut: "2026-07-05",
      pricingMode: "recalculate",
    };

    expect(() => resolveTargetDates({ booking, role: "USER", input, today: CLUB_TODAY })).toThrow(
      "Check-in cannot be changed for an in-progress booking",
    );
  });

  it("and does not fire when the check-in is unchanged", () => {
    const booking = makeBooking("PAID", "2026-06-29", "2026-07-05");
    const input: BatchModifyInput = {
      checkIn: "2026-06-29",
      checkOut: "2026-07-05",
      pricingMode: "recalculate",
    };

    const result = resolveTargetDates({ booking, role: "USER", input, today: CLUB_TODAY });
    expect(result.isInProgressEdit).toBe(true);
    expect(result.checkInChanged).toBe(false);
  });

  it("HOST AXIS: the host cannot move the window either", () => {
    // `editPolicy.today` is now the CLUB's day, supplied as a value (#3123), so
    // this case pins the STORED side: whatever the host is, a stored 1 July must
    // read as 1 July and stay outside the closed window.
    const booking = makeBooking("CONFIRMED", "2026-07-01", "2026-07-04");
    const input: BatchModifyInput = { pricingMode: "recalculate" };
    for (const zone of ["Pacific/Pago_Pago", "Pacific/Kiritimati"]) {
      withTimeZone(zone, () => {
        expect(() =>
          resolveTargetDates({ booking, role: "USER", input, today: CLUB_TODAY }),
        ).not.toThrow();
      });
    }
  });

  it("a member moving a future check-in ONTO the boundary is the sharpest case", () => {
    // A future booking whose check-in the member drags back to 1 July. Read as
    // stored that is 1 July, still after club-today 30 June, so the quote route
    // priced it. Read through Denver it is 30 June — "today or earlier" — and the
    // save refused. Same request, two answers, one day apart.
    const booking = makeBooking("CONFIRMED", "2026-07-05", "2026-07-08");
    const input: BatchModifyInput = {
      checkIn: "2026-07-01",
      checkOut: "2026-07-08",
      pricingMode: "recalculate",
    };

    expect(previewRefusesSelfServiceWindow(booking, day("2026-07-01"))).toBe(
      false,
    );
    const result = resolveTargetDates({ booking, role: "USER", input, today: CLUB_TODAY });
    expect(formatDateOnly(result.newCheckIn)).toBe("2026-07-01");
  });

  it("and that same member request IS refused one day earlier", () => {
    const booking = makeBooking("CONFIRMED", "2026-07-05", "2026-07-08");
    const input: BatchModifyInput = {
      checkIn: "2026-06-30",
      checkOut: "2026-07-08",
      pricingMode: "recalculate",
    };

    expect(previewRefusesSelfServiceWindow(booking, day("2026-06-30"))).toBe(true);
    expect(() => resolveTargetDates({ booking, role: "USER", input, today: CLUB_TODAY })).toThrow(
      "NZ today and earlier are locked for self-service changes",
    );
  });

  it("an ADMIN is exempt from that window", () => {
    const booking = makeBooking("CONFIRMED", "2026-07-05", "2026-07-08");
    const input: BatchModifyInput = {
      checkIn: "2026-06-30",
      checkOut: "2026-07-08",
      pricingMode: "recalculate",
    };
    expect(() =>
      resolveTargetDates({ booking, role: "ADMIN", input, today: CLUB_TODAY }),
    ).not.toThrow();
  });
});
