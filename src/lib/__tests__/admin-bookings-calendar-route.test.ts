import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loggerError: vi.fn(),
  prisma: { booking: { findMany: vi.fn() } },
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
import { clubCalendarDateOf, requireClubTimeZone, requireInstant } from "@/lib/club-time";

function req(query: string) {
  return new NextRequest(`http://localhost/api/admin/bookings?${query}`);
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
  back as their UTC-midnight encoding. INV-DATE-010 says that encoding is
  encoding and not meaning; the authority for DECODING it in UTC is
  INV-DATE-019's exact boundaries plus INV-DATE-026 — cite those rather than 010,
  which an earlier version of this comment paraphrased as its own inverse
  (see #3080). This route used to read all four of them through
  `formatDateOnlyForTimeZone` / `normalizeDateOnlyForTimeZone`, which project an
  instant into a zone.

  THAT IS THE IDENTITY FOR A ZONE AT OR AHEAD OF UTC, which is why it looked
  right for as long as this product only ran in New Zealand, and it is the
  PREVIOUS DAY for anywhere behind UTC — the defect #2870 exists to close.

  WHAT THESE TESTS PROVE, EXACTLY: the wire shape is the STORED calendar day, and
  no zone — persisted, environment or host — is consulted to produce it. That is
  the whole correctness property for a `@db.Date` column, and it is why this
  route reads nothing from `ClubTimeSettings`: `src/app/api/admin/bookings/route.ts`
  contains no `clubTime()` / `clubTimeZone()` call at all, and a Prisma
  `clubTimeSettings` mock here would be answering a question nobody asks. It used
  to have one, and one of these cases persisted a second zone and asserted the
  same answer twice — measured at 0 delegate reads, so it was theatre. Zone
  AUTHORITY is provable only where a zone is legitimately consulted, on an
  INSTANT: `members-export-route.test.ts` and `admin-reports-route.test.ts` are
  where that lives.

  WHAT KEEPS THESE FROM BEING VACUOUS is the premise each one opens with: the
  fixture is checked to be a value a ZONED read would get demonstrably WRONG.
  Without that, a fixture drifting to a date where the two readings agree would
  leave a green suite proving nothing. Substituting `clubCalendarDateOf` for the
  date-only decoder — the shape this migration guards against, and the one a
  future edit is most likely to reach for — was measured to fail both cases:
  `2026-07-09` for `2026-07-10`, and a guest count of 0 for 1.
*/
describe("Admin bookings calendar route — lodge nights are calendar days (CT-4, #2870)", () => {
  // A zone behind UTC, where the UTC-midnight encoding of a day reads back as
  // 18:00 the day BEFORE. Nothing persists it: it is the yardstick the premise
  // assertions measure the fixture against, not an input to the route.
  const ZONE_BEHIND_UTC = requireClubTimeZone("America/Denver");
  const CHECK_IN = new Date("2026-07-10T00:00:00.000Z");
  const CHECK_OUT = new Date("2026-07-13T00:00:00.000Z");

  /**
   * The fixture must be one where reading the column as a MOMENT gives a
   * different day from reading it as the calendar day it encodes. If it ever
   * stops being one, every assertion below goes quietly vacuous.
   */
  function expectZonedReadWouldDiffer() {
    expect(
      clubCalendarDateOf(requireInstant(CHECK_IN), ZONE_BEHIND_UTC),
      "INV-DATE-010: this fixture no longer distinguishes a calendar-day read " +
        "from a zoned one, so the assertions below cannot fail for the right reason.",
    ).toBe("2026-07-09");
    expect(clubCalendarDateOf(requireInstant(CHECK_OUT), ZONE_BEHIND_UTC)).toBe(
      "2026-07-12",
    );
  }

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
  });

  it("returns the STORED lodge nights, not the day a zone behind UTC would read", async () => {
    expectZonedReadWouldDiffer();

    mocks.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        member: { firstName: "Ada", lastName: "Lovelace" },
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
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

  it("keeps the last night of a stay inside the visible month", async () => {
    expectZonedReadWouldDiffer();

    // The guest occupies ONE night — the 12th — which is the last night of the
    // stay. `stayEnd` is half-open, a departure morning (INV-DATE-003), so the
    // 13th is not an occupied night.
    //
    // The visible-month window is `[max(checkIn, monthStart), min(checkOut,
    // nextMonthStart))`. Slide both ends back a day, as projecting them through
    // a zone behind UTC did, and the window becomes the 9th to the 12th
    // exclusive — which no longer contains the only night this guest is on, so
    // the calendar reported ZERO guests for a booking that has one.
    mocks.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        member: { firstName: "Ada", lastName: "Lovelace" },
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        status: "PAID",
        deletedAt: null,
        guests: [
          {
            stayStart: new Date("2026-07-12T00:00:00.000Z"),
            stayEnd: CHECK_OUT,
          },
        ],
      },
    ]);

    const res = await getCalendar(req("calendarMonth=2026-07"));
    const body = await res.json();

    expect(body.bookings[0].guestCount).toBe(1);
  });
});
