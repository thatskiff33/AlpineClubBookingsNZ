import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — kiosk lodge resolution asks "what day is it at the club", and the
 * answer decides which lodge's guest list and roster a shared screen shows.
 *
 * Both sites here bound a window around today: the hut-leader arm finds the
 * assignment covering today, the staying-guest arm finds the booking covering
 * tonight. A day out sends a kiosk to the wrong lodge — or to the default lodge,
 * because no assignment matched — which is the ADR-001 lodge-scoping failure the
 * `resolveKioskLodgeId` comments are about. This file is separate from
 * `club-today-authority.test.ts` because `lodge-auth.ts` pulls in the auth stack
 * and needs its own mock set.
 *
 * DISCRIMINATION: container zone `Pacific/Auckland` (what the replaced helper
 * answered, and the documented fallback), persisted club zone `America/Denver`.
 * Under the frozen clock that is 1 July against 30 June.
 *
 * The two sites sit in MUTUALLY EXCLUSIVE switch arms, so each is asserted from
 * its own call rather than from one shared resolution.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  clubTimeSettingsFindUnique: vi.fn(),
  assignmentFindFirst: vi.fn(),
  bookingFindFirst: vi.fn(),
  getDefaultLodgeId: vi.fn(),
}));

/*
  The `clubTimeSettings` delegate is load-bearing: `getClubTimeZone` is fail-soft
  on a missing delegate and degrades silently to the environment (#3123).
*/
vi.mock("@/lib/prisma", () => ({
  prisma: { clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique } },
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/kiosk-access", () => ({ getKioskAccessTier: vi.fn() }));
vi.mock("@/lib/lodge-pin-session", () => ({
  getActiveLodgePinSessionForRequest: vi.fn(),
}));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: mocks.getDefaultLodgeId }));
vi.mock("@/lib/lodge-access", () => ({
  AmbiguousKioskLodgeError: class extends Error {},
  getStaffLodgeBinding: vi.fn(),
}));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn() }));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { resolveKioskLodgeId } from "@/lib/lodge-auth";

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";
const CLUB_DAY = "2026-06-30T00:00:00.000Z";
const CLUB_DAY_PLUS_1 = "2026-07-01T00:00:00.000Z";

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

const db = {
  hutLeaderAssignment: {
    findFirst: mocks.assignmentFindFirst,
    findUnique: vi.fn(),
  },
  booking: { findFirst: mocks.bookingFindFirst },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone(PERSISTED_ZONE);
  mocks.assignmentFindFirst.mockResolvedValue({ lodgeId: "lodge-a" });
  mocks.bookingFindFirst.mockResolvedValue({ lodgeId: "lodge-b" });
  mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");
});

describe("kiosk lodge resolution uses the club's day (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's give different days", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(clubToday(requireClubTimeZone(ENVIRONMENT_ZONE))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_ZONE))).toBe("2026-06-30");
  });

  it("finds the hut-leader assignment covering the CLUB's today", async () => {
    await resolveKioskLodgeId(
      { tier: "hut-leader", member: { id: "member-1" } } as never,
      db,
    );

    const where = mocks.assignmentFindFirst.mock.calls[0]?.[0] as {
      where: { startDate: { lte: Date }; endDate: { gte: Date } };
    };
    // `startDate <= today + 1` is the arm's own pre-existing window; only the
    // day it is anchored on changes here.
    expect(where.where.endDate.gte.toISOString()).toBe(CLUB_DAY);
    expect(where.where.startDate.lte.toISOString()).toBe(CLUB_DAY_PLUS_1);
  });

  it("finds the staying-guest booking covering the CLUB's tonight", async () => {
    await resolveKioskLodgeId(
      { tier: "staying-guest", member: { id: "member-1" } } as never,
      db,
    );

    const where = mocks.bookingFindFirst.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    // The arm builds its window from `today` and `today + 1`; the serialised
    // where-clause is asserted whole so neither bound can drift unnoticed.
    expect(JSON.stringify(where.where)).toContain("2026-06-30T00:00:00.000Z");
    expect(JSON.stringify(where.where)).not.toContain("2026-07-02T00:00:00.000Z");
  });

  it("moves the assignment window when the persisted zone moves", async () => {
    // Kills a hard-coded `Pacific/Auckland` and every other way of ignoring the
    // stored row.
    persistClubZone("Pacific/Kiritimati"); // UTC+14 — the club's day is 1 July

    await resolveKioskLodgeId(
      { tier: "hut-leader", member: { id: "member-1" } } as never,
      db,
    );

    const where = mocks.assignmentFindFirst.mock.calls.at(-1)?.[0] as {
      where: { endDate: { gte: Date } };
    };
    expect(where.where.endDate.gte.toISOString()).toBe(CLUB_DAY_PLUS_1);
  });

  it("really asks the ClubTimeSettings row for the zone", async () => {
    await resolveKioskLodgeId(
      { tier: "hut-leader", member: { id: "member-1" } } as never,
      db,
    );

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });
});
