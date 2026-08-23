import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loggerError: vi.fn(),
  prisma: {
    booking: { findMany: vi.fn() },
    clubTimeSettings: { findUnique: vi.fn() },
  },
  getMonthAvailability: vi.fn(),
  getLodgeCapacity: vi.fn(),
  countActiveLodges: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  lodgeNullTolerantScope: vi.fn((id: string) => ({ __scope: id })),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/capacity", () => ({
  getMonthAvailability: mocks.getMonthAvailability,
  getLodgeCapacity: mocks.getLodgeCapacity,
}));
vi.mock("@/lib/lodges", () => ({
  countActiveLodges: mocks.countActiveLodges,
  getDefaultLodgeId: mocks.getDefaultLodgeId,
  lodgeNullTolerantScope: mocks.lodgeNullTolerantScope,
}));

import { GET as getCalendar } from "@/app/api/admin/bookings/route";
import { APP_TIME_ZONE } from "@/config/operational";

function req(query: string) {
  return new NextRequest(`http://localhost/api/admin/bookings?${query}`);
}

/** Persist a club timezone for the route's `clubTime()` read to resolve. */
function persistClubZone(timeZone: string | null) {
  mocks.prisma.clubTimeSettings.findUnique.mockResolvedValue(
    timeZone === null
      ? null
      : { timeZone, updatedByMemberId: null, updatedAt: new Date(0) },
  );
}

describe("Admin bookings calendar route — lodge scoping (#9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.prisma.booking.findMany.mockResolvedValue([]);
    mocks.getMonthAvailability.mockResolvedValue(new Map([["2026-07-01", 5]]));
    mocks.getLodgeCapacity.mockResolvedValue(32);
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-1");
    mocks.countActiveLodges.mockResolvedValue(1);
    persistClubZone(null);
  });

  it("scopes bookings and beds to the selected lodge", async () => {
    const res = await getCalendar(req("calendarMonth=2026-07&lodgeId=lodge-2"));
    const body = await res.json();

    const where = mocks.prisma.booking.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.__scope).toBe("lodge-2");
    expect(mocks.getMonthAvailability).toHaveBeenCalledWith("lodge-2", 2026, 6);
    expect(body.availability).toEqual({ "2026-07-01": 27 });
  });

  it("hides the bed count for a multi-lodge 'All lodges' view, but keeps bookings unscoped", async () => {
    mocks.countActiveLodges.mockResolvedValue(2);
    const res = await getCalendar(req("calendarMonth=2026-07"));
    const body = await res.json();

    const where = mocks.prisma.booking.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.__scope).toBeUndefined();
    expect(mocks.getMonthAvailability).not.toHaveBeenCalled();
    expect(mocks.getLodgeCapacity).not.toHaveBeenCalled();
    expect(body.availability).toEqual({});
  });

  it("shows the sole lodge's beds for a single-lodge club with no filter (ADR-002)", async () => {
    mocks.countActiveLodges.mockResolvedValue(1);
    const res = await getCalendar(req("calendarMonth=2026-07"));
    const body = await res.json();

    const where = mocks.prisma.booking.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.__scope).toBeUndefined();
    expect(mocks.getMonthAvailability).toHaveBeenCalledWith("lodge-1", 2026, 6);
    expect(body.availability).toEqual({ "2026-07-01": 27 });
  });
});

/*
  CT-4 (#2870), epic #2988 — the calendar-date half of the club-time boundary.

  `Booking.checkIn` / `checkOut` are `@db.Date` LODGE NIGHTS. Prisma hands them
  back as their UTC-midnight encoding, and INV-DATE-010 says that encoding is
  encoding, not meaning: nothing may read it in any zone but UTC. This route used
  to read all four of them through `formatDateOnlyForTimeZone` /
  `normalizeDateOnlyForTimeZone`, which project an instant into the club zone.

  THAT IS THE IDENTITY FOR A CLUB AT OR AHEAD OF UTC, which is why it looked
  right for as long as this product only ran in New Zealand, and it is the
  PREVIOUS DAY for a club behind UTC — the defect #2870 exists to close. The
  assertions below therefore run with the club's PERSISTED timezone set to
  `America/Denver`, where UTC midnight reads back as 18:00 the day before.

  WHAT THESE TESTS PROVE, EXACTLY: the route's answer does not depend on the
  zone. The same fixture is driven under a club behind UTC and a club ahead of
  it, and both produce the same lodge nights. Substituting `clubCalendarDateOf`
  for the date-only decoder — the shape this migration is guarding against, and
  the one a future edit is most likely to reach for — was measured to fail both:
  `2026-07-09` for `2026-07-10`, and a guest count of 0 for 1.

  WHAT THEY DO NOT PROVE, so nobody reads more into a green run than is there:
  they cannot distinguish "read the persisted zone" from "read the environment
  zone", because a correct calendar-date read consults NEITHER. Restoring the
  legacy `formatDateOnlyForTimeZone` here still passes, since that helper is
  pinned to `APP_TIME_ZONE` and the environment default agrees with UTC about
  what day UTC midnight is. Zone AUTHORITY is proved where it is observable — on
  an instant, in `members-export-route.test.ts` and `admin-reports-route.test.ts`.
  The premise assertion below guards that boundary: if the environment were ever
  set to Denver, even those tests would stop discriminating, so it says so.
*/
describe("Admin bookings calendar route — lodge nights are calendar days (CT-4, #2870)", () => {
  const CLUB_ZONE_BEHIND_UTC = "America/Denver";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.getMonthAvailability.mockResolvedValue(new Map());
    mocks.getLodgeCapacity.mockResolvedValue(32);
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-1");
    mocks.countActiveLodges.mockResolvedValue(1);
    persistClubZone(CLUB_ZONE_BEHIND_UTC);
  });

  it("returns the STORED lodge nights for a club behind UTC, not the day before", async () => {
    expect(
      APP_TIME_ZONE,
      "INV-CONFIG-002: the environment zone must differ from the persisted club " +
        "zone, or this test cannot tell which one the route read.",
    ).not.toBe(CLUB_ZONE_BEHIND_UTC);

    mocks.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        member: { firstName: "Ada", lastName: "Lovelace" },
        // The `@db.Date` encoding of 10 and 13 July: UTC midnight, which is
        // 18:00 on the 9th and the 12th in Denver.
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-13T00:00:00.000Z"),
        status: "PAID",
        deletedAt: null,
        guests: [],
      },
    ]);

    const res = await getCalendar(req("calendarMonth=2026-07"));
    const body = await res.json();

    expect(body.bookings[0].checkIn).toBe("2026-07-10");
    expect(body.bookings[0].checkOut).toBe("2026-07-13");
  });

  it("keeps the last night of a stay inside the visible month for a club behind UTC", async () => {
    expect(APP_TIME_ZONE).not.toBe(CLUB_ZONE_BEHIND_UTC);

    // The guest occupies ONE night — the 12th — which is the last night of the
    // stay. `stayEnd` is half-open, a departure morning (INV-DATE-003), so the
    // 13th is not an occupied night.
    //
    // The visible-month window is `[max(checkIn, monthStart), min(checkOut,
    // nextMonthStart))`. Slide both ends back a day, as projecting them through
    // Denver did, and the window becomes the 9th to the 12th exclusive — which
    // no longer contains the only night this guest is on, so the calendar
    // reported ZERO guests for a booking that has one.
    mocks.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        member: { firstName: "Ada", lastName: "Lovelace" },
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-13T00:00:00.000Z"),
        status: "PAID",
        deletedAt: null,
        guests: [
          {
            stayStart: new Date("2026-07-12T00:00:00.000Z"),
            stayEnd: new Date("2026-07-13T00:00:00.000Z"),
          },
        ],
      },
    ]);

    const res = await getCalendar(req("calendarMonth=2026-07"));
    const body = await res.json();

    expect(body.bookings[0].guestCount).toBe(1);
  });

  it("is unchanged for a club at UTC+12/+13, where the old projection was the identity", async () => {
    persistClubZone("Pacific/Auckland");
    mocks.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        member: { firstName: "Ada", lastName: "Lovelace" },
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-13T00:00:00.000Z"),
        status: "PAID",
        deletedAt: null,
        guests: [],
      },
    ]);

    const res = await getCalendar(req("calendarMonth=2026-07"));
    const body = await res.json();

    expect(body.bookings[0].checkIn).toBe("2026-07-10");
    expect(body.bookings[0].checkOut).toBe("2026-07-13");
  });
});
