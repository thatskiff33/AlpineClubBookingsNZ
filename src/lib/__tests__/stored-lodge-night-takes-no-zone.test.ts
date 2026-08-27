import { describe, expect, it, vi } from "vitest";

/**
 * #3123 — four predicates that compare a STORED LODGE NIGHT against "today",
 * and used to project the stored night through `APP_TIME_ZONE` first.
 *
 * `Booking.checkIn` and `Booking.checkOut` are `DateTime @db.Date`
 * (`prisma/schema.prisma:1662-1663`). A `@db.Date` value round-trips as UTC
 * midnight of the day the column holds, and a calendar day takes no timezone at
 * all — 1 August is 1 August everywhere. Projecting that UTC-midnight encoding
 * into a zone BEHIND Greenwich lands on the previous evening, so the day comes
 * back one early. That is `INV-DATE-026`, and it is the mistake #3113 was filed
 * to correct.
 *
 * DISCRIMINATION. `APP_TIME_ZONE` is pinned to `America/Denver` — behind
 * Greenwich, which is the side the defect shows on, and deliberately NOT
 * `Pacific/Auckland`, which is `APP_TIME_ZONE`'s own fallback and therefore
 * indistinguishable from "no pin at all". Every subject here is a PURE function
 * taking both operands as data, so there is no persisted zone to mock and the
 * fail-soft `clubTimeSettings` trap does not apply: the discriminating dial is
 * `APP_TIME_ZONE`, and it is moved.
 *
 * Before the migration each assertion below fails against this pin. After it,
 * the stored night is decoded rather than projected — and it is DECODED off the
 * UTC clock face, which the last block pins on the HOST axis. That block's own
 * comment says exactly what it can and cannot see, because the two axes are not
 * interchangeable: the club zone is `APP_TIME_ZONE`, mocked once at load, and
 * the host zone is `process.env.TZ`, moved per case.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { evaluateGuestSelfRemoval } from "@/lib/booking-guest-self-removal";
import { predictConsentDeclineRefusal } from "@/lib/member-guest-consent-card";
import { daysUntilDate } from "@/lib/policies/cancellation";
import { requireCalendarDate } from "@/lib/club-time";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/** A stored `@db.Date` lodge night: UTC midnight, exactly as Prisma returns it. */
const storedNight = (day: string) => new Date(`${day}T00:00:00.000Z`);

const AUGUST_1 = storedNight("2026-08-01");

describe("PREMISE: the container zone and the stored day disagree", () => {
  it("is pinned behind Greenwich, where the defect is visible", () => {
    expect(APP_TIME_ZONE).toBe("America/Denver");
    // The projection this migration removes: 1 August at UTC midnight reads as
    // 31 July in Denver. Asserted from raw `Intl` rather than from any helper,
    // so the premise cannot drift with the code under test.
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(
        AUGUST_1,
      ),
    ).toBe("2026-07-31");
  });
});

describe("evaluateGuestSelfRemoval reads the stay's own night (#3123)", () => {
  const base = {
    actorMemberId: "member-1",
    guestMemberId: "member-1",
    bookingOwnerMemberId: "owner-1",
    bookingStatus: "CONFIRMED",
    bookingGuestCount: 3,
  };

  it("a stay starting TOMORROW is still removable", () => {
    // Club's today 31 July, stay starts 1 August. Before the fix the check-in
    // projected to 31 July, equalled `today`, and the member was refused
    // STAY_NOT_FUTURE a whole day early.
    expect(
      evaluateGuestSelfRemoval({
        ...base,
        bookingCheckIn: AUGUST_1,
        today: storedNight("2026-07-31"),
      }),
    ).toEqual({ canSelfRemove: true, blocker: null });
  });

  it("a stay starting TODAY is refused, and the boundary has not moved", () => {
    expect(
      evaluateGuestSelfRemoval({
        ...base,
        bookingCheckIn: AUGUST_1,
        today: AUGUST_1,
      }),
    ).toEqual({ canSelfRemove: false, blocker: "STAY_NOT_FUTURE" });
  });

  it("takes the day off the UTC clock face, never out of a zone", () => {
    // `storedDateOnly` DECODES: it reads the UTC day and re-encodes it. So a
    // value carrying a time of day is truncated in UTC rather than projected —
    // which is the documented bridge contract, and the point is that no zone
    // can move it. (A refusal on a timestamp is `requireStoredCalendarDay`'s
    // contract, used where the value is rendered rather than compared; this
    // predicate takes the bridge, so the assertion is the frame, not a throw.)
    expect(
      evaluateGuestSelfRemoval({
        ...base,
        bookingCheckIn: new Date("2026-08-01T09:30:00.000Z"),
        today: storedNight("2026-07-31"),
      }),
    ).toEqual({ canSelfRemove: true, blocker: null });
    // ...and the same value 30 minutes past Denver's midnight on 31 July is
    // still read as 1 August, which is what a projection would have got wrong.
    expect(
      evaluateGuestSelfRemoval({
        ...base,
        bookingCheckIn: new Date("2026-08-01T00:30:00.000Z"),
        today: storedNight("2026-08-01"),
      }),
    ).toEqual({ canSelfRemove: false, blocker: "STAY_NOT_FUTURE" });
  });
});

describe("predictConsentDeclineRefusal agrees with it, night for night", () => {
  const base = {
    bookingStatus: "CONFIRMED",
    bookingGuestCount: 3,
    isQuotePriced: false,
  };

  it("does not predict STAY_NOT_FUTURE for a stay starting tomorrow", () => {
    expect(
      predictConsentDeclineRefusal({
        ...base,
        bookingCheckIn: AUGUST_1,
        today: storedNight("2026-07-31"),
      }),
    ).toBeNull();
  });

  it("predicts exactly what the removal predicate decides, on the boundary day", () => {
    // The two are two halves of one `<=`, and #3123 moved both. Had one been
    // migrated alone they would disagree on precisely this day.
    const today = AUGUST_1;
    const predicted = predictConsentDeclineRefusal({
      ...base,
      bookingCheckIn: AUGUST_1,
      today,
    });
    const decided = evaluateGuestSelfRemoval({
      actorMemberId: "member-1",
      guestMemberId: "member-1",
      bookingOwnerMemberId: "owner-1",
      bookingStatus: "CONFIRMED",
      bookingGuestCount: 3,
      bookingCheckIn: AUGUST_1,
      today,
    });
    expect(predicted).toBe("STAY_NOT_FUTURE");
    expect(decided.blocker).toBe("STAY_NOT_FUTURE");
  });
});

describe("daysUntilDate counts from the night the column holds (#3123)", () => {
  it("counts 32 days, not 31 — the refund tier this used to lose", () => {
    // 30 June to 1 August is 32 lodge days. The old code projected the STORED
    // night back a day and left the instant where it was, so the two errors
    // subtracted rather than cancelling: measured 31 on `America/Denver`, which
    // for a club with a 32-day tier boundary is a worse refund than its own
    // policy promises.
    // The club's own day, resolved by the caller and handed in. On
    // `America/Denver` at the frozen instant that is 30 June.
    expect(daysUntilDate(AUGUST_1, requireCalendarDate("2026-06-30"))).toBe(32);
  });

  it("reads the check-in day off the UTC clock face, not out of a zone", () => {
    // Same count whatever time of day the value carries, because the decode
    // truncates in UTC. A projection through Denver would have returned 31.
    const clubDay = requireCalendarDate("2026-06-30");
    expect(daysUntilDate(new Date("2026-08-01T09:30:00.000Z"), clubDay)).toBe(32);
    expect(daysUntilDate(new Date("2026-08-01T00:30:00.000Z"), clubDay)).toBe(32);
  });
});

describe("the HOST's zone cannot move the decoded night either", () => {
  /*
    WHAT THIS LEG ACTUALLY PROVES, stated honestly because its previous spelling
    claimed something it could not see.

    It used to say it caught "a future sweep that moves these predicates onto the
    club zone". It could not: the club zone reaches this module only through
    `APP_TIME_ZONE`, which is frozen at module load and is MOCKED at the top of
    this file, so `process.env.TZ` cannot move it under the old code or the new.
    That claim is covered instead by the `America/Denver` pin above, under which
    every assertion in this file fails before the migration.

    The axis this leg really moves is the HOST's, and there is a live regression
    on it: all three subjects decode through `utcDateOnlyString`, whose whole
    content is `getUTCFullYear/getUTCMonth/getUTCDate`. Drop the `UTC` from those
    three getters — the single commonest date bug there is, and a change a
    reviewer would wave through — and the stored night starts reading out of
    whatever zone the process happens to be running in. Measured on node v24:
    assigning `process.env.TZ` does re-derive `Date`'s local getters, so this
    leg sees it.

    So the zones below are chosen for the HOST axis: `Pacific/Kiritimati` (UTC+14)
    and `Pacific/Pago_Pago` (UTC-11) are the two extremes, 25 hours apart, and any
    local-getter read of a UTC-midnight value lands on a different day in one of
    them. The expected values are asserted OUTRIGHT per zone rather than merely
    compared with each other, because six identically-wrong answers are also a set
    of size one.
  */
  const ZONES = [
    "UTC",
    "Pacific/Auckland",
    "America/Denver",
    "Europe/Berlin",
    "Pacific/Kiritimati",
    "Pacific/Pago_Pago",
  ];

  it("reads the same, and the RIGHT, answer however the process is oriented", () => {
    for (const zone of ZONES) {
      // `withTimeZone` is the house helper for this (#2485): restoring by
      // assigning `original ?? ""` — which this leg used to do — leaves an empty
      // TZ behind and leaks a zone into whichever suite the runner schedules
      // next.
      withTimeZone(zone, () => {
        expect(
          evaluateGuestSelfRemoval({
            actorMemberId: "member-1",
            guestMemberId: "member-1",
            bookingOwnerMemberId: "owner-1",
            bookingStatus: "CONFIRMED",
            bookingGuestCount: 3,
            bookingCheckIn: AUGUST_1,
            today: storedNight("2026-07-31"),
          }),
          zone,
        ).toEqual({ canSelfRemove: true, blocker: null });
        expect(
          predictConsentDeclineRefusal({
            bookingStatus: "CONFIRMED",
            bookingGuestCount: 3,
            isQuotePriced: false,
            bookingCheckIn: AUGUST_1,
            today: storedNight("2026-07-31"),
          }),
          zone,
        ).toBeNull();
        expect(
          daysUntilDate(AUGUST_1, requireCalendarDate("2026-06-30")),
          zone,
        ).toBe(32);
      });
    }
  });
});
