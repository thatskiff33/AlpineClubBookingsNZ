import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the scheduled jobs take "today" from the CLUB's persisted timezone.
 *
 * Separate from `club-today-authority.test.ts` because these three modules take
 * the OTHER reader, and which reader a module may use is the part of this
 * migration most easily got wrong. `src/instrumentation.node.ts` loads each of
 * them through a lazy `await import(...)`, and `@/lib/club-time/server` carries
 * `import "server-only"` — a bare throw on that graph, at import, before the job
 * runs. So they compose `dateOnlyInstantOf(clubToday(await
 * readClubTimeZoneOutsideRequest()))` instead, which is the spelling nine other
 * sites in this tree already use and `docs/CLUB_TIME_KERNEL.md` mandates
 * ("static CLI reach, or reach from instrumentation — either one means the
 * runtime reader").
 *
 * DISCRIMINATION, as in the sibling file: the container's zone is pinned to
 * `Pacific/Auckland` — the answer the replaced helper gave, and this codebase's
 * own fallback — and the persisted club zone is `America/Denver`. Under the
 * frozen clock (`2026-07-01T00:00:00.000Z`) that is 1 July against 30 June, so
 * nothing here can pass by coincidence.
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
  bookingFindMany: vi.fn(),
  emailLogFindFirst: vi.fn(),
  lodgeFindMany: vi.fn(),
  computeNightOccupancy: vi.fn(),
  getLodgeCapacity: vi.fn(),
}));

/*
  The `clubTimeSettings` delegate is load-bearing. `readClubTimeZoneOutsideRequest`
  is fail-soft on a missing delegate, a throwing query and an absent row, and
  every one of those degrades to the environment seed — so a prisma mock without
  it would pass for exactly the reason this file exists.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    booking: { findMany: mocks.bookingFindMany },
    emailLog: { findFirst: mocks.emailLogFindFirst },
    lodge: { findMany: mocks.lodgeFindMany },
  },
}));
vi.mock("@/lib/email", () => ({
  sendCheckinReminderEmail: vi.fn(),
  shouldSendEmail: vi.fn().mockResolvedValue(false),
  sendAdminCapacityWarningAlert: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({
  computeNightOccupancy: mocks.computeNightOccupancy,
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: mocks.getLodgeCapacity,
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { checkCapacityWarnings } from "@/lib/cron-capacity-warnings";
import { sendCheckinReminders } from "@/lib/cron-checkin-reminders";

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";
const CLUB_DAY = "2026-06-30T00:00:00.000Z";
const CLUB_DAY_PLUS_1 = "2026-07-01T00:00:00.000Z";
const CLUB_DAY_PLUS_2 = "2026-07-02T00:00:00.000Z";
const CLUB_DAY_PLUS_14 = "2026-07-14T00:00:00.000Z";

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone(PERSISTED_ZONE);
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.emailLogFindFirst.mockResolvedValue(null);
  mocks.lodgeFindMany.mockResolvedValue([{ id: "lodge-a", name: "Lodge A" }]);
  mocks.getLodgeCapacity.mockResolvedValue(10);
  mocks.computeNightOccupancy.mockResolvedValue(() => ({
    occupiedBeds: 0,
    wholeLodgeHeld: false,
  }));
});

describe("the scheduled jobs take today from the club, not the container (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's give different days", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(clubToday(requireClubTimeZone(ENVIRONMENT_ZONE))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_ZONE))).toBe("2026-06-30");
  });

  describe("cron-checkin-reminders.ts — 'your stay starts tomorrow'", () => {
    it("means tomorrow AT THE CLUB, on both ends of the night", async () => {
      // A day out here emails the wrong guests entirely: the reminder goes to
      // the people arriving the day after the one that needed it.
      await sendCheckinReminders();

      const where = mocks.bookingFindMany.mock.calls[0]?.[0] as {
        where: { checkIn: { gte: Date; lt: Date } };
      };
      expect(where.where.checkIn.gte.toISOString()).toBe(CLUB_DAY_PLUS_1);
      expect(where.where.checkIn.lt.toISOString()).toBe(CLUB_DAY_PLUS_2);
    });

    it("moves both bounds when the persisted zone moves", async () => {
      persistClubZone("Pacific/Kiritimati"); // UTC+14 — the club's day is 1 July
      await sendCheckinReminders();

      const where = mocks.bookingFindMany.mock.calls.at(-1)?.[0] as {
        where: { checkIn: { gte: Date; lt: Date } };
      };
      expect(where.where.checkIn.gte.toISOString()).toBe(CLUB_DAY_PLUS_2);
      expect(where.where.checkIn.lt.toISOString()).toBe("2026-07-03T00:00:00.000Z");
    });

    it("really asks the ClubTimeSettings row for the zone", async () => {
      await sendCheckinReminders();

      expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "default" } }),
      );
    });
  });

  describe("cron-capacity-warnings.ts — the fourteen-night lookahead", () => {
    it("opens the window on the club's day and closes it fourteen nights later", async () => {
      await checkCapacityWarnings();

      const call = mocks.computeNightOccupancy.mock.calls[0]?.[0] as {
        from: Date;
        toExclusive: Date;
        nights: Date[];
      };
      expect(call.from.toISOString()).toBe(CLUB_DAY);
      expect(call.toExclusive.toISOString()).toBe(CLUB_DAY_PLUS_14);
      expect(call.nights[0].toISOString()).toBe(CLUB_DAY);
    });

    it("moves the window when the persisted zone moves", async () => {
      persistClubZone("Pacific/Kiritimati"); // UTC+14 — the club's day is 1 July
      await checkCapacityWarnings();

      const call = mocks.computeNightOccupancy.mock.calls.at(-1)?.[0] as {
        from: Date;
      };
      expect(call.from.toISOString()).toBe(CLUB_DAY_PLUS_1);
    });

    it("really asks the ClubTimeSettings row for the zone", async () => {
      await checkCapacityWarnings();

      expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "default" } }),
      );
    });
  });
});
