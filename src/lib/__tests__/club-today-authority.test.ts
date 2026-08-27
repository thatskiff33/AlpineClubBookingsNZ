import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the modules that ask "what day is it at the club" answer from the
 * PERSISTED `ClubTimeSettings.timeZone`, never from `APP_TIME_ZONE`.
 *
 * One file rather than five, because the discrimination is identical for every
 * subject and the two dials it moves — the mocked container zone and the
 * persisted club row — are file-scoped. Each subject gets its own block, so a
 * failure still names one module.
 *
 * DISCRIMINATION. `APP_TIME_ZONE`, the container's zone and the only thing
 * `getTodayDateOnly()` ever read, is pinned to `Pacific/Auckland`. That is both
 * the answer the replaced helper gave here AND this codebase's documented
 * fallback, so it is the one value a wrong fix — a hard-coded default, a lost
 * read — could still pass under. The persisted club zone is `America/Denver`,
 * behind Greenwich, which is the side these defects show on. Under the frozen
 * clock (`2026-07-01T00:00:00.000Z`) it is 1 July in Auckland and 30 June in
 * Denver, so the two never agree and no assertion here can pass by coincidence.
 * The issue's execution contract requires exactly this: "a test that persists
 * `Pacific/Auckland` cannot tell the persisted zone from the environment zone."
 *
 * Bounds are asserted at the exact millisecond, not merely as a calendar day.
 * `HutLeaderAssignment.endDate` and `Booking.checkOut` are `@db.Date`, so a
 * club-LOCAL midnight bound would be `2026-06-30T06:00:00Z`, which the Prisma
 * adapter narrows to 29 June (`INV-DATE-026`). Only "the club's day, encoded at
 * UTC midnight" produces `2026-06-30T00:00:00.000Z`.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("server-only", () => ({}));
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  clubTimeSettingsFindUnique: vi.fn(),
  hutLeaderAssignmentCount: vi.fn(),
  bookingFindUnique: vi.fn(),
}));

/*
  THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK. `getClubTimeZone`
  is fail-soft in three places — a missing delegate, a throwing query and an
  absent row — and every one of them degrades silently to the environment. A
  prisma mock without it therefore passes for exactly the reason this file
  exists to rule out.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    hutLeaderAssignment: { count: mocks.hutLeaderAssignmentCount },
    booking: { findUnique: mocks.bookingFindUnique },
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { copyBookingToDraft } from "@/lib/admin-booking-copy";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { hasActiveHutLeaderAssignment } from "@/lib/hut-leader";
import { canReadLodgeInstructions } from "@/lib/lodge-instructions";
import { loadMembershipCancellationBlockersByMemberId } from "@/lib/membership-cancellation-blockers";

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";
/** The club's day at the frozen instant, encoded as Prisma's `@db.Date` value. */
const CLUB_DAY = "2026-06-30T00:00:00.000Z";
/** What the container's zone would have said — every assertion must reject it. */
const ENVIRONMENT_DAY = "2026-07-01T00:00:00.000Z";

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

/** The `endDate` bound the subject handed the assignment count. */
function assignmentBound(): Date {
  const call = mocks.hutLeaderAssignmentCount.mock.calls.at(-1)?.[0] as {
    where: { endDate: { gte: Date } };
  };
  return call.where.endDate.gte;
}

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone(PERSISTED_ZONE);
  mocks.hutLeaderAssignmentCount.mockResolvedValue(0);
});

describe("the club's day comes from the club, not the container (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's give different days", () => {
    // The ANSWERS have to differ, not merely the identifiers — two zones with
    // different names and the same offset would make every case below vacuous.
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(clubToday(requireClubTimeZone(ENVIRONMENT_ZONE))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_ZONE))).toBe("2026-06-30");
  });

  describe("hut-leader.ts — whether the nav link shows", () => {
    it("bounds the assignment window on the club's day, at UTC midnight", async () => {
      await hasActiveHutLeaderAssignment("member-1");

      expect(assignmentBound().toISOString()).toBe(CLUB_DAY);
    });

    it("moves the bound when the persisted zone moves", async () => {
      // Kills "ignore the persisted row" in every form, including a hard-coded
      // `Pacific/Auckland`. Same clock, same call; only the stored zone differs.
      persistClubZone("Pacific/Kiritimati"); // UTC+14 — 1 July
      await hasActiveHutLeaderAssignment("member-1");
      expect(assignmentBound().toISOString()).toBe(ENVIRONMENT_DAY);

      persistClubZone("Pacific/Pago_Pago"); // UTC-11 — still 30 June
      await hasActiveHutLeaderAssignment("member-1");
      expect(assignmentBound().toISOString()).toBe(CLUB_DAY);
    });

    it("really asks the ClubTimeSettings row for the zone", async () => {
      await hasActiveHutLeaderAssignment("member-1");

      expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "default" } }),
      );
    });
  });

  describe("lodge-instructions.ts — who may read door codes and emergency access", () => {
    it("bounds the reader's assignment window on the club's day", async () => {
      // A day early here withdraws a hut leader's access to the lodge's
      // operational documents while they are still on duty.
      await canReadLodgeInstructions("member-1", { accessRoles: [] });

      expect(assignmentBound().toISOString()).toBe(CLUB_DAY);
    });

    it("agrees with hut-leader.ts, which its own comment requires", async () => {
      await hasActiveHutLeaderAssignment("member-1");
      const navBound = assignmentBound().toISOString();
      await canReadLodgeInstructions("member-1", { accessRoles: [] });

      expect(assignmentBound().toISOString()).toBe(navBound);
    });
  });

  describe("membership-cancellation-blockers.ts — which stays block a cancellation", () => {
    it("counts a stay as future from the club's day", async () => {
      const bookingFindMany = vi.fn().mockResolvedValue([]);
      const db = {
        booking: { findMany: bookingFindMany },
        bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as Parameters<
        typeof loadMembershipCancellationBlockersByMemberId
      >[1];

      await loadMembershipCancellationBlockersByMemberId(["member-1"], db, {
        invoiceCheck: "skip",
      });

      const where = bookingFindMany.mock.calls[0]?.[0] as {
        where: { checkOut: { gt: Date } };
      };
      expect(where.where.checkOut.gt.toISOString()).toBe(CLUB_DAY);
    });
  });

  describe("hut-leader-coverage.ts — which nights have no leader", () => {
    it("opens the coverage window on the club's day", async () => {
      const bookingFindMany = vi.fn().mockResolvedValue([]);
      const db = {
        booking: { findMany: bookingFindMany },
        hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      };

      await getUnassignedHutLeaderDates({
        db: db as never,
        lookAheadDays: 0,
        scope: { kind: "all" },
      });

      const where = bookingFindMany.mock.calls[0]?.[0] as {
        where: { checkOut: { gt: Date } };
      };
      expect(where.where.checkOut.gt.toISOString()).toBe(CLUB_DAY);
    });

    it("still honours an explicitly supplied today, so callers can thread one", async () => {
      // The seam #3123 keeps: a caller holding one resolved club day passes it
      // in rather than letting this module resolve a second one.
      const bookingFindMany = vi.fn().mockResolvedValue([]);
      const db = {
        booking: { findMany: bookingFindMany },
        hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      };

      await getUnassignedHutLeaderDates({
        db: db as never,
        lookAheadDays: 0,
        today: new Date(ENVIRONMENT_DAY),
        scope: { kind: "all" },
      });

      const where = bookingFindMany.mock.calls[0]?.[0] as {
        where: { checkOut: { gt: Date } };
      };
      expect(where.where.checkOut.gt.toISOString()).toBe(ENVIRONMENT_DAY);
    });
  });

  describe("admin-booking-copy.ts — refusing a copy into the past", () => {
    it("accepts the club's own day as a target check-in", async () => {
      // 30 June is TODAY at the club and YESTERDAY in the container's zone, so
      // before this migration an admin in Denver could not copy a booking into
      // the current day at all. The refusal is what is under test: the call is
      // allowed to fail later for the absent booking, but never with this error.
      mocks.bookingFindUnique.mockResolvedValue(null);

      await expect(
        copyBookingToDraft({
          sourceBookingId: "booking-1",
          targetCheckIn: "2026-06-30",
          adminMemberId: "admin-1",
        }),
      ).rejects.toThrow("Booking not found");
    });

    it("still refuses a day that is genuinely past at the club", async () => {
      // The guard must not have been weakened into never firing.
      mocks.bookingFindUnique.mockResolvedValue(null);

      await expect(
        copyBookingToDraft({
          sourceBookingId: "booking-1",
          targetCheckIn: "2026-06-29",
          adminMemberId: "admin-1",
        }),
      ).rejects.toThrow("Target check-in date cannot be in the past");
    });
  });
});
