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

  it("does not touch the database from the synchronous render path", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");

    clubTime.emailClubDate(DIVERGENT);
    clubTime.emailClubDateTime(DIVERGENT);
    clubTime.emailClubTimeZoneForTests();

    expect(mocks.readPersistedClubTimeZoneOutsideRequest).not.toHaveBeenCalled();
  });
});

describe("a read that finds nothing", () => {
  // The reader answers `null` for every one of these — no row, an unreadable
  // database, a row whose value is not a usable named zone — and the point is
  // that none of them may become the answer the templates render in.
  it("commits nothing when the reader has nothing usable", async () => {
    const clubTime = await import("@/lib/email-templates-club-time");
    const before = clubTime.emailClubTimeZoneForTests();

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
