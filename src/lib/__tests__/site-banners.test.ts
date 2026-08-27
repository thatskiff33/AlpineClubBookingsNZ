import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  siteBannerFindMany: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    siteBanner: {
      findMany: mocks.siteBannerFindMany,
    },
    // Load-bearing: `getClubTimeZone` is fail-soft on a missing delegate and
    // degrades silently to the environment, so a mock without this would pass
    // for exactly the reason the club zone was moved here (#3123).
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));

/*
  "Today" is the CLUB's day, from its persisted timezone (#3123). The container's
  zone is pinned to `Pacific/Auckland` — the answer the replaced `getTodayDateOnly()`
  gave, and this codebase's own fallback, so it is the one value a wrong fix could
  still pass under — and the persisted club zone is `America/Denver`, behind
  Greenwich. Under the frozen clock (2026-07-01T00:00:00.000Z) that is 1 July in
  Auckland and 30 June in Denver, so the window and grouping assertions below are
  stable AND cannot pass while the environment is deciding the day.
*/
const TODAY = new Date("2026-06-30T00:00:00.000Z");
const ENVIRONMENT_DAY = new Date("2026-07-01T00:00:00.000Z");
const PERSISTED_ZONE = "America/Denver";

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

import {
  getCurrentSiteBanners,
  listSiteBannersForAdmin,
} from "@/lib/site-banners";

function bannerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "banner-1",
    message: "Mountain closed",
    priority: "URGENT",
    startDate: new Date("2026-06-29T00:00:00.000Z"),
    endDate: new Date("2026-07-08T00:00:00.000Z"),
    active: true,
    createdByMemberId: "admin-1",
    updatedByMemberId: "admin-1",
    createdAt: new Date("2026-06-30T01:00:00.000Z"),
    updatedAt: new Date("2026-06-30T02:00:00.000Z"),
    ...overrides,
  };
}

describe("getCurrentSiteBanners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistClubZone(PERSISTED_ZONE);
    mocks.siteBannerFindMany.mockResolvedValue([]);
  });

  it("queries active banners whose window includes the club's day", async () => {
    await getCurrentSiteBanners();

    expect(mocks.siteBannerFindMany).toHaveBeenCalledWith({
      where: {
        active: true,
        startDate: { lte: TODAY },
        endDate: { gte: TODAY },
      },
      select: {
        id: true,
        message: true,
        priority: true,
        startDate: true,
        updatedAt: true,
      },
    });
  });

  it("does NOT use the container's day, and follows the persisted zone when it moves", async () => {
    // The leg that makes this a club-time proof rather than a spelling change.
    // Legs above are satisfied by a hard-coded `Pacific/Auckland`, which is not
    // the fix #3123 asks for: the zone comes from the club's configured setting.
    await getCurrentSiteBanners();
    expect(mocks.siteBannerFindMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ startDate: { lte: ENVIRONMENT_DAY } }),
      }),
    );

    persistClubZone("Pacific/Kiritimati"); // UTC+14 — 1 July, ahead of Auckland
    await getCurrentSiteBanners();
    expect(mocks.siteBannerFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startDate: { lte: ENVIRONMENT_DAY },
          endDate: { gte: ENVIRONMENT_DAY },
        }),
      }),
    );

    persistClubZone("Pacific/Pago_Pago"); // UTC-11 — still 30 June
    await getCurrentSiteBanners();
    expect(mocks.siteBannerFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startDate: { lte: TODAY },
          endDate: { gte: TODAY },
        }),
      }),
    );
  });

  it("really asks the ClubTimeSettings row for the zone", async () => {
    await getCurrentSiteBanners();

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });

  it("sorts URGENT before WARNING before NOTIFY, then newest start date", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([
      bannerRow({ id: "notify-1", priority: "NOTIFY" }),
      bannerRow({
        id: "urgent-old",
        priority: "URGENT",
        startDate: new Date("2026-06-18T00:00:00.000Z"),
      }),
      bannerRow({ id: "warning-1", priority: "WARNING" }),
      bannerRow({
        id: "urgent-new",
        priority: "URGENT",
        startDate: new Date("2026-06-29T00:00:00.000Z"),
      }),
    ]);

    const banners = await getCurrentSiteBanners();

    expect(banners.map((banner) => banner.id)).toEqual([
      "urgent-new",
      "urgent-old",
      "warning-1",
      "notify-1",
    ]);
  });

  it("returns a serialisable shape with an ISO updatedAt", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([bannerRow()]);

    const banners = await getCurrentSiteBanners();

    expect(banners).toEqual([
      {
        id: "banner-1",
        message: "Mountain closed",
        priority: "URGENT",
        updatedAt: "2026-06-30T02:00:00.000Z",
      },
    ]);
  });
});

describe("listSiteBannersForAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistClubZone(PERSISTED_ZONE);
    mocks.siteBannerFindMany.mockResolvedValue([]);
  });

  it("splits banners into current, upcoming, and past groups", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([
      // Ends before today -> past.
      bannerRow({
        id: "past-1",
        startDate: new Date("2026-05-30T00:00:00.000Z"),
        endDate: new Date("2026-06-29T00:00:00.000Z"),
      }),
      // Window includes today -> current.
      bannerRow({
        id: "current-1",
        startDate: new Date("2026-06-29T00:00:00.000Z"),
        endDate: new Date("2026-07-03T00:00:00.000Z"),
      }),
      // Starts after today -> upcoming.
      bannerRow({
        id: "upcoming-1",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-07-06T00:00:00.000Z"),
      }),
    ]);

    const groups = await listSiteBannersForAdmin();

    expect(groups.current.map((banner) => banner.id)).toEqual(["current-1"]);
    expect(groups.upcoming.map((banner) => banner.id)).toEqual(["upcoming-1"]);
    expect(groups.past.map((banner) => banner.id)).toEqual(["past-1"]);
  });

  it("treats a banner ending today as current (inclusive end date)", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([
      bannerRow({
        id: "ends-today",
        startDate: new Date("2026-06-26T00:00:00.000Z"),
        endDate: new Date("2026-06-30T00:00:00.000Z"),
      }),
      bannerRow({
        id: "starts-today",
        startDate: new Date("2026-06-30T00:00:00.000Z"),
        endDate: new Date("2026-07-07T00:00:00.000Z"),
      }),
    ]);

    const groups = await listSiteBannersForAdmin();

    expect(groups.current.map((banner) => banner.id)).toEqual([
      "starts-today",
      "ends-today",
    ]);
    expect(groups.upcoming).toEqual([]);
    expect(groups.past).toEqual([]);
  });

  it("keeps inactive banners in their date-derived group", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([
      bannerRow({
        id: "inactive-current",
        active: false,
        startDate: new Date("2026-06-29T00:00:00.000Z"),
        endDate: new Date("2026-07-03T00:00:00.000Z"),
      }),
    ]);

    const groups = await listSiteBannersForAdmin();

    expect(groups.current.map((banner) => banner.id)).toEqual([
      "inactive-current",
    ]);
    expect(groups.current[0].active).toBe(false);
  });

  it("serialises dates as date-only strings and caps past banners at 50", async () => {
    const pastBanners = Array.from({ length: 60 }, (_, index) =>
      bannerRow({
        id: `past-${index}`,
        startDate: new Date("2026-05-01T00:00:00.000Z"),
        // Spread end dates so the newest-ended sort is observable.
        endDate: new Date(Date.UTC(2026, 4, 1 + index)),
      }),
    );
    mocks.siteBannerFindMany.mockResolvedValue(pastBanners);

    const groups = await listSiteBannersForAdmin();

    expect(groups.past).toHaveLength(50);
    // Most recently ended first.
    expect(groups.past[0].id).toBe("past-59");
    expect(groups.past[0]).toMatchObject({
      startDate: "2026-05-01",
      endDate: "2026-06-29",
    });
  });
});
