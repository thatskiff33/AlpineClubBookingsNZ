import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureHostTimeZone, withTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * Email dates are the CLUB's civil time (CT-5, #2869; epic #2988).
 *
 * The property this suite exists to hold: two members reading the same booking
 * confirmation see the same dates, and those dates do not move because the
 * container that rendered the message was redeployed to another region. Before
 * this change the zone came from `APP_TIME_ZONE` — `process.env.TZ ||
 * NEXT_PUBLIC_TZ || "Pacific/Auckland"` — which is precisely the container's own
 * zone.
 *
 * Three properties are pinned separately, because they fail for different
 * reasons:
 *
 *  1. once the persisted zone is loaded, it wins over the host's;
 *  2. before it is loaded the answer is the environment seed, which is what
 *     these templates already used — so a cold cache cannot regress anything;
 *  3. a read that finds nothing, or cannot reach the database, commits NOTHING.
 *     That is the `readFailed` trap `email-theme.ts` documents: folding "could
 *     not read" into "here is a zone" would silently rebrand every email's dates
 *     as though the club had chosen that zone.
 */

const mocks = vi.hoisted(() => ({
  readPersistedClubTimeZoneOutsideRequest: vi.fn(),
}));

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readPersistedClubTimeZoneOutsideRequest:
    mocks.readPersistedClubTimeZoneOutsideRequest,
}));

vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: async () => {
    const { DEFAULT_CLUB_THEME_VALUES } = await import("@/lib/club-theme-schema");
    return { values: DEFAULT_CLUB_THEME_VALUES, css: "" };
  },
}));

/**
 * 2026-04-16T00:30:00Z: still 15 April in Denver, already 16 April (12:30) in
 * Auckland. Any assertion below that reported the same day for both zones would
 * be proving nothing, so the fixture is chosen to make them disagree.
 */
const DIVERGENT = new Date("2026-04-16T00:30:00.000Z");

/**
 * A persisted zone that is never the runner's own and never the documented
 * fallback, so "the persisted value won" cannot be read off a coincidence.
 * `Pacific/Chatham` is +12:45 and a real IANA location.
 */
const PERSISTED_ZONE = "Pacific/Chatham";

const hostTimeZone = captureHostTimeZone();

beforeEach(async () => {
  mocks.readPersistedClubTimeZoneOutsideRequest.mockReset();
  const { __resetEmailClubTimeZoneForTests } = await import(
    "@/lib/email-templates-club-time"
  );
  __resetEmailClubTimeZoneForTests();
});

afterEach(() => {
  hostTimeZone.restore();
});

describe("the persisted club timezone, once primed", () => {
  it("beats the host's zone in both directions", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");

    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue("Pacific/Auckland");
    await clubTime.primeEmailClubTimeZone();

    for (const hostZone of ["UTC", "America/Denver", "Pacific/Auckland"]) {
      withTimeZone(hostZone, () => {
        expect(clubTime.emailClubTimeZoneForTests(), hostZone).toBe(
          "Pacific/Auckland",
        );
        expect(clubTime.emailClubDate(DIVERGENT), hostZone).toBe("16 Apr 2026");
      });
    }

    clubTime.__resetEmailClubTimeZoneForTests();
    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue("America/Denver");
    await clubTime.primeEmailClubTimeZone();

    for (const hostZone of ["UTC", "America/Denver", "Pacific/Auckland"]) {
      withTimeZone(hostZone, () => {
        expect(clubTime.emailClubDate(DIVERGENT), hostZone).toBe("15 Apr 2026");
      });
    }
  });

  it("renders a real template in the club's zone, not the container's", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    const { setupIntentFailedTemplate } = await import(
      "@/lib/email-templates/booking"
    );

    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue("Pacific/Auckland");
    await clubTime.primeEmailClubTimeZone();

    // A US-hosted worker reading a NZ club's booking: the stay dates must be the
    // club's, not the worker's.
    withTimeZone("America/New_York", () => {
      const html = setupIntentFailedTemplate({
        firstName: "Ada",
        checkIn: new Date("2026-04-16T00:00:00.000Z"),
        checkOut: new Date("2026-04-18T00:00:00.000Z"),
      });
      expect(html).toContain("16 Apr 2026 – 18 Apr 2026");
    });
  });
});

describe("before it is primed", () => {
  it("answers with the environment seed, which is what these templates used before", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    const { APP_TIME_ZONE } = await import("@/config/operational");

    // Not merely "some zone": the SAME zone `APP_TIME_ZONE` resolves to, which
    // is what makes a cold cache a no-op rather than a regression. Both are
    // frozen at module load, so this comparison is stable.
    expect(clubTime.emailClubTimeZoneForTests()).toBe(APP_TIME_ZONE);
  });

  it("deliberately DIFFERS from APP_TIME_ZONE for a seed that names no place", async () => {
    /*
      THE EXCEPTION TO THE SENTENCE ABOVE, pinned rather than glossed over
      (#2869 review). The module's docblock used to claim a cold cache was
      "character-for-character the `APP_TIME_ZONE` these templates used before".
      It is not: `APP_TIME_ZONE` is `process.env.TZ` UNVALIDATED, while this
      resolves the seed through `resolveClubTimeZone`, which refuses a value
      naming no place — `UTC`, `GMT`, `Zulu`, `Etc/*` — and answers the
      documented default instead.

      That is the epic's intended behaviour and matches CT-1's refusal to record
      such a seed, so the test pins the DIFFERENCE rather than the claim. It is
      also the one deployment class whose email dates move on the release that
      lands CT-5, which is why it is worth a test of its own.

      Both constants are frozen at module load, so the seed has to be pinned
      before a FRESH import of each — hence `vi.resetModules()`.
    */
    const hostTimeZone = captureHostTimeZone();
    try {
      vi.resetModules();
      process.env.TZ = "UTC";
      const freshClubTime = await import("@/lib/email-templates-club-time");
      const { APP_TIME_ZONE: freshAppTimeZone } = await import(
        "@/config/operational"
      );

      expect(freshAppTimeZone).toBe("UTC");
      expect(freshClubTime.emailClubTimeZoneForTests()).toBe("Pacific/Auckland");
    } finally {
      hostTimeZone.restore();
      vi.resetModules();
    }
  });

  // The seed is read once, at module load. A live `process.env.TZ` read would
  // make an email's dates depend on when it was rendered relative to an
  // environment change — and would let one suite's `TZ` pin leak into another's
  // rendered output, which is a flake with nothing in any diff to blame.
  it("does not follow a mid-process change to TZ", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    const before = clubTime.emailClubTimeZoneForTests();

    withTimeZone("America/Denver", () => {
      expect(clubTime.emailClubTimeZoneForTests()).toBe(before);
    });
  });

  it("never WAITS on the database from the synchronous render path", async () => {
    /*
      THE PROPERTY THAT MATTERS, and it is not the one this test used to assert.

      It used to require that a cold render start NO read at all, and that made
      the cache unrecoverable: the TTL branch sat behind a `persisted === null`
      early return, so the only thing that could ever load the zone was the boot
      prime and the only thing that could recover from a failed boot prime was
      another boot. A container that started before PostgreSQL was ready dated
      EVERY email for the life of that process in the environment's zone (#2869
      review).

      What a render must not do is WAIT. It answers from the cache — the
      environment fallback while cold — and returns; the read it kicks off is
      not awaited and cannot make it slower.
    */
    const clubTime = await import("@/lib/email-templates-club-time");
    const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
    let resolveRead: (zone: string) => void = () => {};
    mocks.readPersistedClubTimeZoneOutsideRequest.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const { APP_TIME_ZONE } = await import("@/config/operational");
    expect(
      PERSISTED_ZONE,
      "the persisted fixture must differ from the runner's own zone, or this proves nothing",
    ).not.toBe(APP_TIME_ZONE);

    // The read is in flight and unresolved; the render still answers, from the
    // cold cache, without waiting for it.
    const coldZone = clubTime.emailClubTimeZoneForTests();
    expect(coldZone).toBe(APP_TIME_ZONE);
    expect(clubTime.emailClubDate(DIVERGENT)).toBe(
      bindClubTime(requireClubTimeZone(coldZone)).instantDate(DIVERGENT),
    );

    resolveRead(PERSISTED_ZONE);
    await Promise.resolve();
    await Promise.resolve();
    expect(clubTime.emailClubTimeZoneForTests()).toBe(PERSISTED_ZONE);
  });

  it("starts ONE read for a burst of renders, not one per message", async () => {
    // The bound that makes a self-warming cold cache safe: `refreshing` plus a
    // stamp taken up front, exactly as `emailPalette()` does one module along.
    const clubTime = await import("@/lib/email-templates-club-time");
    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue(
      PERSISTED_ZONE,
    );

    for (let index = 0; index < 50; index += 1) {
      clubTime.emailClubDate(DIVERGENT);
    }

    expect(
      mocks.readPersistedClubTimeZoneOutsideRequest,
    ).toHaveBeenCalledTimes(1);
  });

  it("recovers from a cold start whose first read failed", async () => {
    /*
      THE DEFECT, END TO END. The boot prime runs before PostgreSQL is ready and
      fails. Under the old code nothing else could ever load the zone, so every
      email that process sent was dated in the container's zone. Now the next
      render past the failure cooldown reads again and the zone arrives.

      The cooldown is real time, so it is stepped over with `vi.setSystemTime`
      rather than waited out — and the suite re-pins the frozen default
      afterwards, per the repository clock rule.
    */
    const clubTime = await import("@/lib/email-templates-club-time");
    const frozenNow = new Date();

    mocks.readPersistedClubTimeZoneOutsideRequest.mockRejectedValueOnce(
      new Error("database not ready"),
    );
    await clubTime.primeEmailClubTimeZone();

    const { APP_TIME_ZONE } = await import("@/config/operational");
    expect(clubTime.emailClubTimeZoneForTests()).toBe(APP_TIME_ZONE);

    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue(
      PERSISTED_ZONE,
    );
    // Inside the cooldown, nothing is retried.
    clubTime.emailClubDate(DIVERGENT);
    expect(
      mocks.readPersistedClubTimeZoneOutsideRequest,
    ).toHaveBeenCalledTimes(1);

    try {
      vi.setSystemTime(new Date(frozenNow.getTime() + 31_000));
      clubTime.emailClubDate(DIVERGENT);
      await Promise.resolve();
      await Promise.resolve();
      expect(clubTime.emailClubTimeZoneForTests()).toBe(PERSISTED_ZONE);
    } finally {
      vi.setSystemTime(frozenNow);
    }
  });
});

describe("a read that finds nothing", () => {
  // The reader answers `null` for every one of these — no row, an unreadable
  // database, a row whose value is not a usable named zone — and the point is
  // that none of them may become the answer the templates render in.
  it("commits nothing when the reader has nothing usable", async () => {
    /*
      `before` IS TAKEN FROM A PRIMED CACHE, not a cold one, and that is the
      whole discrimination (#2869 review). Reading it cold made `before` the
      environment fallback — which is also what a mutant that COMMITTED the
      fallback on a `null` read would produce, so the assertion held either way
      and proved nothing. Priming a zone that is neither the host's nor the
      fallback first means "unchanged" can only mean "nothing was committed".
    */
    const clubTime = await import("@/lib/email-templates-club-time");

    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue(
      PERSISTED_ZONE,
    );
    await clubTime.primeEmailClubTimeZone();
    const before = clubTime.emailClubTimeZoneForTests();
    expect(before).toBe(PERSISTED_ZONE);

    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue(null);
    await clubTime.primeEmailClubTimeZone();

    expect(clubTime.emailClubTimeZoneForTests()).toBe(before);
  });

  it("keeps the last good value when a later read throws", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");

    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue("America/Denver");
    await clubTime.primeEmailClubTimeZone();
    expect(clubTime.emailClubTimeZoneForTests()).toBe("America/Denver");

    mocks.readPersistedClubTimeZoneOutsideRequest.mockRejectedValue(new Error("db down"));
    await expect(clubTime.primeEmailClubTimeZone()).resolves.toBeUndefined();
    expect(clubTime.emailClubTimeZoneForTests()).toBe("America/Denver");
  });
});

/**
 * The calendar-day formatter, pinned DIRECTLY rather than through a template.
 *
 * `emailCalendarDay` is reached from 22 source files and, before this block, from
 * no test file at all: the only assertion on its refusal was indirect, through
 * one template, and nothing pinned the boundary the refusal turns on. That is the
 * wrong way round for the one function in this module whose whole job is to
 * REFUSE a value the others accept.
 *
 * Two directions are pinned, because the two mistakes fail differently:
 *
 *  - a real instant handed to the zone-free formatter throws LOUDLY, and that is
 *    asserted here. It is the safe direction, and worth saying so plainly: it
 *    bounds how bad a misclassification can be.
 *  - a stored calendar day handed to `emailClubDate` is SILENT, and right for
 *    every club east of Greenwich. That is the dangerous direction and the reason
 *    the two functions exist separately, so it is measured rather than described.
 */
describe("emailCalendarDay: the stored-calendar-day boundary", () => {
  const STORED = new Date("2026-04-16T00:00:00.000Z");

  it("accepts exact UTC midnight and refuses one millisecond past it", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");

    expect(clubTime.emailCalendarDay(STORED)).toBe("16 Apr 2026");

    // The boundary itself, from both sides — a guard pinned only at a value far
    // from its threshold does not pin the threshold.
    expect(() =>
      clubTime.emailCalendarDay(new Date(STORED.getTime() + 1)),
    ).toThrow(RangeError);
    expect(() =>
      clubTime.emailCalendarDay(new Date(STORED.getTime() - 1)),
    ).toThrow(RangeError);
    expect(() =>
      clubTime.emailCalendarDay(new Date(STORED.getTime() - 86_400_000)),
    ).not.toThrow();
  });

  it("hands the caller the remedy, not just a refusal", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    // A guard whose message does not name the alternative sends whoever trips it
    // looking for one, and the likeliest guess is to floor the value — which is
    // the defect the guard exists to stop.
    expect(() => clubTime.emailCalendarDay(new Date("2026-04-16T09:30:00.000Z")))
      .toThrow(/emailClubDate/);
  });

  it("accepts a pre-1970 exact midnight rather than refusing it spuriously", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    // The check is a remainder against a day of milliseconds, and before 1970
    // that arithmetic runs on a negative number. A date of birth is the obvious
    // real value in this class, so a sign bug here would refuse a member's
    // stored birthday.
    expect(clubTime.emailCalendarDay(new Date("1953-06-02T00:00:00.000Z"))).toBe(
      "2 Jun 1953",
    );
  });

  it("consults NO zone: neither the club's nor the host's can move it", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");

    for (const persisted of ["Pacific/Honolulu", "Pacific/Auckland"]) {
      clubTime.__resetEmailClubTimeZoneForTests();
      mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue(persisted);
      await clubTime.primeEmailClubTimeZone();
      for (const hostZone of ["UTC", "America/Denver", "Pacific/Auckland"]) {
        withTimeZone(hostZone, () => {
          expect(
            clubTime.emailCalendarDay(STORED),
            `persisted ${persisted}, host ${hostZone}`,
          ).toBe("16 Apr 2026");
        });
      }
    }
  });

  it("differs from emailClubDate for a club west of Greenwich, which is why both exist", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    clubTime.__resetEmailClubTimeZoneForTests();
    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue("Pacific/Honolulu");
    await clubTime.primeEmailClubTimeZone();

    // The silent, dangerous direction, measured: projecting a stored night
    // through the club's own zone reads it as the PREVIOUS day. This is what a
    // sweep onto the persisted zone would have done to 131 lodge nights.
    expect(clubTime.emailClubDate(STORED)).toBe("15 Apr 2026");
    expect(clubTime.emailCalendarDay(STORED)).toBe("16 Apr 2026");

    // And east of Greenwich the two agree, which is exactly why the defect
    // survived: every current adopter sees no difference.
    clubTime.__resetEmailClubTimeZoneForTests();
    mocks.readPersistedClubTimeZoneOutsideRequest.mockResolvedValue("Pacific/Auckland");
    await clubTime.primeEmailClubTimeZone();
    expect(clubTime.emailClubDate(STORED)).toBe(clubTime.emailCalendarDay(STORED));
  });
});

describe("emailCalendarDayOrUnknown", () => {
  const STORED = new Date("2026-04-16T00:00:00.000Z");

  it("renders Unknown for an absent date and defers to emailCalendarDay otherwise", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    expect(clubTime.emailCalendarDayOrUnknown(null)).toBe("Unknown");
    expect(clubTime.emailCalendarDayOrUnknown(undefined)).toBe("Unknown");
    expect(clubTime.emailCalendarDayOrUnknown(STORED)).toBe(
      clubTime.emailCalendarDay(STORED),
    );
  });

  it("is NOT an escape hatch: a real instant still throws", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    // The whole point of the nullable variant is to let a sender say "I do not
    // have this night". If it also swallowed a wrong-KIND value it would become
    // the quiet way round the guard, and the next `?? new Date()` would render a
    // plausible wrong day instead of failing.
    expect(() =>
      clubTime.emailCalendarDayOrUnknown(new Date("2026-04-16T09:30:00.000Z")),
    ).toThrow(RangeError);
  });
});
