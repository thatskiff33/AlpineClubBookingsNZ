/**
 * CT-4 (#2870), group F4b, defect 1: the guest who supplied no dates of their
 * own is defaulted from the STORED envelope, not from a projection of it.
 *
 * `normalizeGuestStayRange` used to open with two
 * `normalizeDateOnlyForTimeZone(booking.checkIn/checkOut)` calls, so a guest
 * carrying no range was defaulted from the booking envelope read through
 * `APP_TIME_ZONE`. That is the identity for a club ahead of Greenwich and the
 * PREVIOUS DAY for one behind it — and the range-less guest is what the member
 * form sends for every guest unless they open multi-range mode. So on a Denver
 * club that guest was priced, capacity-checked, frozen for an officer and
 * executed a night early, with the party envelope a night wide.
 *
 * Every guest-SUPPLIED field on these input types is a `yyyy-MM-dd` string and
 * reaches `parseDateOnly`, so both explicit shapes were always right. The
 * default was the whole of the defect.
 *
 * ## THE HALF THE LEDGER RECORDED AS CLEAN
 *
 * #2870's residual list said "the modification path is genuinely clean —
 * `buildModificationProposalParties` never touches this helper". It does.
 * `buildModificationProposalParties` calls `resolveModificationStayRanges`,
 * whose SECOND pass normalises every added guest through
 * `normalizeGuestStayRange` against the final envelope
 * (`booking-modification-stay-ranges.ts`, the `added` map) — including one that
 * carries no range at all. So a member adding a guest to an existing booking
 * without giving them dates hit exactly the same night-early default.
 *
 * Worse, the two passes of that one function DISAGREED with each other. Pass 1
 * defaults a range-less added guest to `{ requestedCheckIn, requestedCheckOut }`
 * directly — the stored days, unprojected — while pass 2 sent the same guest
 * through the projecting helper. The envelope was therefore computed from one
 * frame and the guest's own range from another, inside a single call. That is
 * pinned below, because it is the shape this epic keeps finding and the shape a
 * later edit is most likely to reintroduce.
 *
 * ## Why the environment zone is mocked rather than set through `TZ`
 *
 * `TZ` is not a usable lever on this repository's documented shell, and it moves
 * `APP_TIME_ZONE` and the host together — so a suite using it could not tell a
 * projection through the configured zone from one through the host's. The config
 * mock moves the environment zone alone, which is the leak this file is about.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import {
  normalizeGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import { resolveModificationStayRanges } from "@/lib/booking-modification-stay-ranges";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/** A `@db.Date` value: the calendar day encoded at UTC midnight. */
function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const CHECK_IN = "2026-07-04";
const CHECK_OUT = "2026-07-07";
const booking = { checkIn: day(CHECK_IN), checkOut: day(CHECK_OUT) };

describe("a range-less guest is defaulted from the STORED envelope", () => {
  it("PREMISE: the mocked environment zone really does move a stored day", () => {
    expect(APP_TIME_ZONE).toBe("America/Denver");
    expect(formatDateOnlyForTimeZone(booking.checkIn, APP_TIME_ZONE)).toBe(
      "2026-07-03",
    );
  });

  it("the create/quote path: no dates supplied means the booking's own days", () => {
    // `normalizeGuestStayRanges` intersects the guest type with the resolved
    // range, so a literal `stayStart: null` collapses the intersection to
    // `never`. A guest carrying no date fields at all is the shape the member
    // form actually sends, and it types cleanly. The `stayStart: null` spelling
    // is covered by `normalizeGuestStayRange` directly further down.
    const [guest] = normalizeGuestStayRanges([{}], booking);
    expect(formatDateOnly(guest.stayStart)).toBe(CHECK_IN);
    expect(formatDateOnly(guest.stayEnd)).toBe(CHECK_OUT);
  });

  it("HOST AXIS: a host at either offset extreme cannot move it either", () => {
    for (const zone of ["Pacific/Pago_Pago", "Pacific/Kiritimati"]) {
      withTimeZone(zone, () => {
        const range = normalizeGuestStayRange({}, booking, 0);
        expect(formatDateOnly(range.stayStart), zone).toBe(CHECK_IN);
        expect(formatDateOnly(range.stayEnd), zone).toBe(CHECK_OUT);
      });
    }
  });

  it("an explicit range is unchanged — it always reached parseDateOnly", () => {
    const range = normalizeGuestStayRange(
      { stayStart: CHECK_IN, stayEnd: CHECK_OUT },
      booking,
      0,
    );
    expect(formatDateOnly(range.stayStart)).toBe(CHECK_IN);
    expect(formatDateOnly(range.stayEnd)).toBe(CHECK_OUT);
  });

  it("an explicit night set is unchanged too", () => {
    const range = normalizeGuestStayRange(
      { nights: ["2026-07-05", "2026-07-04"] },
      booking,
      0,
    );
    expect((range.nights ?? []).map(formatDateOnly)).toEqual([
      "2026-07-04",
      "2026-07-05",
    ]);
    expect(formatDateOnly(range.stayStart)).toBe("2026-07-04");
    expect(formatDateOnly(range.stayEnd)).toBe("2026-07-06");
  });

  it("a range supplied as a Date is read as its stored day too", () => {
    // `normalizeInputDate`'s `value instanceof Date` branch. No live producer
    // reaches it today — every member-supplied field is typed `string`, and a
    // stored delta arrives as JSON — but `StayRangeDeltaEntry.stayStart` is typed
    // `Date | string | null`, so the branch is a typed hole a future caller can
    // walk through. It surfaced as the ONE mutation survival in this lane: a
    // projection reinstated there killed nothing, because nothing exercised it.
    // Covered rather than explained away.
    const range = normalizeGuestStayRange(
      { stayStart: day(CHECK_IN), stayEnd: day(CHECK_OUT) },
      booking,
      0,
    );
    expect(formatDateOnly(range.stayStart)).toBe(CHECK_IN);
    expect(formatDateOnly(range.stayEnd)).toBe(CHECK_OUT);
  });

  it("and so is an explicit night set supplied as Dates", () => {
    const range = normalizeGuestStayRange(
      { nights: [day("2026-07-05"), day("2026-07-04")] },
      booking,
      0,
    );
    expect((range.nights ?? []).map(formatDateOnly)).toEqual([
      "2026-07-04",
      "2026-07-05",
    ]);
  });

  it("a stored value that is not a calendar day is REFUSED, not floored", () => {
    // `storedDateOnly` throws for an Invalid Date rather than returning a
    // plausible wrong day. `normalizeDateOnlyForTimeZone` threw here too, so
    // this is not a new refusal — it is the same one, kept.
    expect(() =>
      normalizeGuestStayRange({}, { checkIn: new Date(NaN), checkOut: booking.checkOut }, 0),
    ).toThrow();
  });
});

describe("the MODIFICATION path reaches the same default (#2870 ledger correction)", () => {
  const liveGuest = { id: "guest-1", stayStart: null, stayEnd: null };

  it("a range-less ADDED guest gets the stored envelope, not a projection", () => {
    const resolved = resolveModificationStayRanges({
      booking,
      guests: [liveGuest],
      // One range input somewhere switches the whole request into range-input
      // mode, which is the mode that runs pass 1 — so the two passes are both
      // exercised by this single delta.
      input: {
        addGuests: [{}],
        guestStayRanges: [
          { guestId: "guest-1", stayStart: CHECK_IN, stayEnd: CHECK_OUT },
        ],
      },
    });

    expect(formatDateOnly(resolved.added[0].stayStart)).toBe(CHECK_IN);
    expect(formatDateOnly(resolved.added[0].stayEnd)).toBe(CHECK_OUT);
  });

  it("and the two passes of that one function agree on it", () => {
    // Pass 1 defaults a range-less added guest to `{ requestedCheckIn,
    // requestedCheckOut }` DIRECTLY and pass 2 sends it through the helper. When
    // the helper projected, one call computed its envelope in one frame and the
    // guest's own range in another. The envelope must not widen for a guest who
    // asked for nothing.
    const resolved = resolveModificationStayRanges({
      booking,
      guests: [liveGuest],
      input: {
        addGuests: [{}],
        guestStayRanges: [
          { guestId: "guest-1", stayStart: CHECK_IN, stayEnd: CHECK_OUT },
        ],
      },
    });

    expect(formatDateOnly(resolved.checkIn)).toBe(CHECK_IN);
    expect(formatDateOnly(resolved.checkOut)).toBe(CHECK_OUT);
    expect(resolved.datesChanged).toBe(false);

    // THE SHARP EDGE, and the reason this deserves its own case: pass 1 built
    // the envelope from the UNPROJECTED default, so while the helper projected,
    // the added guest's own resolved range fell a night OUTSIDE the envelope
    // that same call returned. An added guest who asked for nothing must sit
    // inside the booking they were added to.
    expect(resolved.added[0].stayStart.getTime()).toBeGreaterThanOrEqual(
      resolved.checkIn.getTime(),
    );
    expect(resolved.added[0].stayEnd.getTime()).toBeLessThanOrEqual(
      resolved.checkOut.getTime(),
    );
  });

  it("a range-less added guest in NO-range-input mode is unaffected as before", () => {
    // No range inputs anywhere: pass 1 never runs, and the added guest still
    // resolves against the (unmoved) envelope through the helper.
    const resolved = resolveModificationStayRanges({
      booking,
      guests: [liveGuest],
      input: { addGuests: [{}] },
    });
    expect(formatDateOnly(resolved.added[0].stayStart)).toBe(CHECK_IN);
    expect(formatDateOnly(resolved.added[0].stayEnd)).toBe(CHECK_OUT);
  });
});
