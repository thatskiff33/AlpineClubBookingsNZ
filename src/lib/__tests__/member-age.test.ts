import { describe, expect, it } from "vitest";
import {
  AGE_UNAVAILABLE_LABEL,
  calculateMemberAgeParts,
  formatAgeYearsMonths,
  formatMemberIdentityAge,
} from "@/lib/member-age";
import { requireCalendarDate } from "@/lib/club-time";

// Every case below states its own reference day. There is no default to test
// any more: #3123 deleted it, because the only zone this module could have
// defaulted to was the container's (on a server) or the build's (in the
// browser), and neither is the club's. Which zone the day comes from is now the
// CALLER's contract, proved in `member-age-club-time-authority.test.ts`.
const day = requireCalendarDate;
const NZ_TODAY = day("2026-07-01");

describe("formatAgeYearsMonths", () => {
  it("formats a normal date of birth", () => {
    expect(formatAgeYearsMonths("1990-01-01", day("2026-05-10"))).toBe(
      "36 years 4 months"
    );
  });

  it("handles a birthday that has not occurred this month", () => {
    expect(formatAgeYearsMonths("1990-05-20", day("2026-05-10"))).toBe(
      "35 years 11 months"
    );
  });

  it("handles a birthday today", () => {
    expect(formatAgeYearsMonths("1990-05-10", day("2026-05-10"))).toBe(
      "36 years 0 months"
    );
  });

  it("handles leap-day dates of birth in non-leap years", () => {
    expect(formatAgeYearsMonths("2000-02-29", day("2026-02-28"))).toBe(
      "26 years 0 months"
    );
  });

  it("returns null for a null date of birth", () => {
    expect(formatAgeYearsMonths(null, day("2026-05-10"))).toBeNull();
  });

  it("singularises one year and one month", () => {
    expect(formatAgeYearsMonths("2025-06-01", day("2026-07-01"))).toBe(
      "1 year 1 month"
    );
  });
});

describe("formatMemberIdentityAge — generations in one family group (#2568)", () => {
  it("separates an adult child from an older parent", () => {
    // The case the issue opens with: two ADULTs, three decades apart.
    expect(formatMemberIdentityAge("2007-06-15", NZ_TODAY)).toBe("19 years");
    expect(formatMemberIdentityAge("1974-03-02", NZ_TODAY)).toBe("52 years");
  });

  it("separates three adult generations", () => {
    expect(formatMemberIdentityAge("1948-11-20", NZ_TODAY)).toBe("77 years");
    expect(formatMemberIdentityAge("1974-03-02", NZ_TODAY)).toBe("52 years");
    expect(formatMemberIdentityAge("2007-06-15", NZ_TODAY)).toBe("19 years");
  });

  it("gives two same-named members different ages when their births differ", () => {
    // Same first name, same surname, same age tier — the age is the only
    // separator an admin has.
    const olderJohnSmith = formatMemberIdentityAge("1969-04-04", NZ_TODAY);
    const youngerJohnSmith = formatMemberIdentityAge("1998-04-04", NZ_TODAY);
    expect(olderJohnSmith).toBe("57 years");
    expect(youngerJohnSmith).toBe("28 years");
    expect(olderJohnSmith).not.toBe(youngerJohnSmith);
  });

  it("gives two members born in the same year the same label", () => {
    // Two members of the same age are NOT distinguishable by age, and the label
    // must not pretend otherwise — email and age tier carry the rest.
    expect(formatMemberIdentityAge("2007-01-05", NZ_TODAY)).toBe("19 years");
    expect(formatMemberIdentityAge("2007-06-15", NZ_TODAY)).toBe("19 years");
  });
});

describe("formatMemberIdentityAge — years versus years-and-months (#2568)", () => {
  it("shows completed years and months under five", () => {
    expect(formatMemberIdentityAge("2022-10-20", NZ_TODAY)).toBe(
      "3 years 8 months"
    );
  });

  it("counts only COMPLETED months", () => {
    // Born on the 10th; the reference date is the 1st, so the month in progress
    // does not count.
    expect(formatMemberIdentityAge("2022-11-10", NZ_TODAY)).toBe(
      "3 years 7 months"
    );
  });

  it("shows years and months for an infant under one", () => {
    expect(formatMemberIdentityAge("2026-01-01", NZ_TODAY)).toBe(
      "0 years 6 months"
    );
  });

  it("switches to years only on the fifth birthday", () => {
    expect(formatMemberIdentityAge("2021-07-01", day("2026-06-30"))).toBe(
      "4 years 11 months"
    );
    expect(formatMemberIdentityAge("2021-07-01", day("2026-07-01"))).toBe("5 years");
  });
});

describe("formatMemberIdentityAge — birthdays around the reference date (#2568)", () => {
  it("counts a birthday that falls on the reference date", () => {
    expect(formatMemberIdentityAge("2007-07-01", NZ_TODAY)).toBe("19 years");
  });

  it("does not count a birthday that falls tomorrow", () => {
    expect(formatMemberIdentityAge("2007-07-02", NZ_TODAY)).toBe("18 years");
  });

  it("counts a birthday that fell yesterday", () => {
    expect(formatMemberIdentityAge("2007-06-30", NZ_TODAY)).toBe("19 years");
  });
});

describe("formatMemberIdentityAge — 29 February (#2568)", () => {
  it("counts the birthday on 29 February in a leap year", () => {
    expect(formatMemberIdentityAge("2000-02-29", day("2028-02-28"))).toBe("27 years");
    expect(formatMemberIdentityAge("2000-02-29", day("2028-02-29"))).toBe("28 years");
  });

  it("counts the birthday on 28 February in a non-leap year", () => {
    // Documented convention: the anniversary clamps to the last day of the
    // month, so a leap-day member turns over on 28 February rather than 1 March.
    expect(formatMemberIdentityAge("2000-02-29", day("2027-02-27"))).toBe("26 years");
    expect(formatMemberIdentityAge("2000-02-29", day("2027-02-28"))).toBe("27 years");
    expect(formatMemberIdentityAge("2000-02-29", day("2027-03-01"))).toBe("27 years");
  });

  it("handles a leap-day toddler in the years-and-months band", () => {
    expect(formatMemberIdentityAge("2024-02-29", day("2027-03-01"))).toBe(
      "3 years 0 months"
    );
    expect(formatMemberIdentityAge("2024-02-29", day("2027-02-28"))).toBe(
      "3 years 0 months"
    );
    expect(formatMemberIdentityAge("2024-02-29", day("2027-02-27"))).toBe(
      "2 years 11 months"
    );
  });

  it("accepts a 29 February reference date", () => {
    expect(formatMemberIdentityAge("2020-01-31", day("2028-02-29"))).toBe("8 years");
  });
});

describe("formatMemberIdentityAge — missing and invalid dates (#2568)", () => {
  it("reports a missing date of birth as unavailable", () => {
    expect(formatMemberIdentityAge(null, NZ_TODAY)).toBe(AGE_UNAVAILABLE_LABEL);
    expect(formatMemberIdentityAge(undefined, NZ_TODAY)).toBe(
      AGE_UNAVAILABLE_LABEL
    );
    expect(formatMemberIdentityAge("", NZ_TODAY)).toBe(AGE_UNAVAILABLE_LABEL);
    expect(AGE_UNAVAILABLE_LABEL).toBe("Age unavailable");
  });

  it("reports an unparseable date of birth as unavailable", () => {
    for (const bad of [
      "not-a-date",
      "01/02/2003",
      "2020-13-05",
      "2021-02-30",
      "2021-00-10",
      "0000-00-00",
    ]) {
      expect(formatMemberIdentityAge(bad, NZ_TODAY)).toBe(AGE_UNAVAILABLE_LABEL);
    }
    expect(formatMemberIdentityAge(new Date("nonsense"), NZ_TODAY)).toBe(
      AGE_UNAVAILABLE_LABEL
    );
  });

  it("reports a future date of birth as unavailable rather than as a newborn", () => {
    // A mistyped year must read as unusable. "0 years 0 months" would look like
    // a real infant and could be approved as one.
    expect(formatMemberIdentityAge("2030-01-01", NZ_TODAY)).toBe(
      AGE_UNAVAILABLE_LABEL
    );
    expect(formatMemberIdentityAge("2026-07-02", NZ_TODAY)).toBe(
      AGE_UNAVAILABLE_LABEL
    );
    expect(calculateMemberAgeParts("2026-07-02", NZ_TODAY)).toBeNull();
  });

  it("reports an unusable reference day as unavailable", () => {
    // Unreachable from a legitimately-obtained `CalendarDate` — the brand can
    // only be minted by a validator — so the cast is the point: it proves the
    // runtime guard behind the type is still there, because on this surface a
    // quietly-wrong age year is worse than "Age unavailable" (#2568).
    expect(
      formatMemberIdentityAge("2000-01-01", "not-a-date" as never)
    ).toBe(AGE_UNAVAILABLE_LABEL);
    // The same guard, reached the other way a cast can defeat the brand: a
    // value that is not a string at all. It must read as unavailable rather
    // than throw, because this module renders inside a client error boundary.
    expect(
      formatMemberIdentityAge("2000-01-01", new Date("2026-07-01") as never)
    ).toBe(AGE_UNAVAILABLE_LABEL);
  });
});

describe("member age — date-only semantics, no timezone drift (#2568)", () => {
  it("reads a UTC-midnight Date as its own calendar day", () => {
    // A stored date-only value is pinned to UTC midnight, which is midday in New
    // Zealand — the same calendar day. Reading it with local getters on a server
    // west of UTC would move it back a day and report an age a year short on a
    // birthday.
    expect(
      formatMemberIdentityAge(new Date("2007-07-01T00:00:00.000Z"), NZ_TODAY)
    ).toBe("19 years");
  });

  it("agrees between a Date, its ISO string, and a bare date-only string", () => {
    expect(
      formatMemberIdentityAge(new Date("2007-07-01T00:00:00.000Z"), NZ_TODAY)
    ).toBe("19 years");
    expect(formatMemberIdentityAge("2007-07-01T00:00:00.000Z", NZ_TODAY)).toBe(
      "19 years"
    );
    expect(formatMemberIdentityAge("2007-07-01", NZ_TODAY)).toBe("19 years");
  });

  it("refuses an INSTANT as the reference day — the type is the guard (#3123)", () => {
    // This used to be "accepts a Date as the reference date", and accepting one
    // was the hazard: a `Date` in that position is an instant, and an instant
    // has no calendar day until a zone is chosen. `CalendarDate` makes the
    // confusion unrepresentable, so the claim is now about what the compiler
    // refuses. The block is never CALLED — `@ts-expect-error` is checked by
    // `tsc`, and running these lines would only prove what happens after the
    // type system has already been defeated.
    const refusedByTheCompiler = () => {
      // @ts-expect-error a Date is not a CalendarDate (#3123)
      formatMemberIdentityAge("2007-07-01", new Date("2026-07-01T00:00:00.000Z"));
    };
    expect(refusedByTheCompiler).toBeTypeOf("function");
    expect(formatMemberIdentityAge("2007-07-01", day("2026-07-01"))).toBe(
      "19 years"
    );
  });

  it("exposes the parts as completed years and months", () => {
    expect(calculateMemberAgeParts("2022-10-20", NZ_TODAY)).toEqual({
      years: 3,
      months: 8,
    });
  });
});

describe("member age — the reference day is the CALLER's contract now (#3123)", () => {
  /*
    THE BLOCK THAT USED TO LIVE HERE MOVED THE SYSTEM CLOCK to prove the DEFAULT
    reference date was the New Zealand calendar day. #3123 deleted that default,
    so the block had no subject: the only zone this module could default to was
    `APP_TIME_ZONE`, which is the container's claim on a server and the build's
    in the browser, and `INV-CONFIG-002` says neither is the club's.

    What replaced it is a contract on each of the five callers, proved under a
    persisted club zone the host does not hold, in
    `member-age-club-time-authority.test.ts`. Nothing here can test it: this
    module no longer knows what day it is, which is the fix.
  */
  it("has no default, so omitting the reference day does not compile", () => {
    // Never called: `@ts-expect-error` is a COMPILE-time assertion, and `tsc`
    // fails the build if any of these three lines becomes legal again — which
    // is exactly what reintroducing a default would do.
    const refusedByTheCompiler = () => {
      // @ts-expect-error the reference day is required (#3123)
      formatMemberIdentityAge("2007-07-01");
      // @ts-expect-error the reference day is required (#3123)
      formatAgeYearsMonths("2007-07-01");
      // @ts-expect-error the reference day is required (#3123)
      calculateMemberAgeParts("2007-07-01");
    };
    expect(refusedByTheCompiler).toBeTypeOf("function");
    expect(formatMemberIdentityAge("2007-07-01", day("2026-07-01"))).toBe(
      "19 years"
    );
  });
});
