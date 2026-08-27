import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — three background sweeps whose `@db.Date` window boundary was derived
 * from the CONTAINER's timezone, and now comes from the club's persisted one
 * (`INV-CONFIG-002`).
 *
 * All three bound a `@db.Date` column — `Booking.checkIn` / `checkOut` — so the
 * value asserted is the UTC-midnight encoding of a calendar day, not an instant
 * boundary. Hand Prisma a club-LOCAL midnight against one of those columns and
 * the adapter narrows it to the PREVIOUS day with nothing to warn you
 * (`INV-DATE-026`), so the bound VALUE is what these cases assert. A row count
 * or a "did it send" assertion cannot tell 30 June at UTC midnight from 30 June
 * at Denver midnight, and those two are the whole point.
 *
 * READER. All three modules take `readClubTimeZoneOutsideRequest()` rather than
 * `club-time/server`, and that is measured rather than chosen: two are loaded by
 * `general-cron-runner` from `src/instrumentation.node.ts`, the third by
 * `config-transfer/bootstrap-import`, and `server-only` is a bare throw at
 * import on that graph — it would kill the job as it loaded rather than fail a
 * test.
 *
 * DISCRIMINATION. `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — what the
 * replaced adapters answered, and this codebase's own fallback, so it is the one
 * value a half-done fix could still pass under. The persisted club zone is
 * `America/Denver`. Under the default frozen clock (`2026-07-01T00:00:00.000Z`)
 * Auckland reads 1 July and Denver reads 30 June, so the two never agree and no
 * assertion here can pass by coincidence. No `vi.setSystemTime` is needed.
 *
 * THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK. The zone reader
 * is fail-soft on a missing delegate, a throwing query and an absent row, and
 * every one degrades silently to the environment — so a prisma mock without it
 * would pass for exactly the reason this file exists to rule out.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const {
  mockClubTimeSettingsFindUnique,
  mockBookingRequestCount,
  mockBookingFindMany,
  mockGetBookingRequestSettings,
} = vi.hoisted(() => ({
  mockClubTimeSettingsFindUnique: vi.fn(),
  mockBookingRequestCount: vi.fn(),
  mockBookingFindMany: vi.fn(),
  mockGetBookingRequestSettings: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
    bookingRequest: { count: mockBookingRequestCount },
    booking: { findMany: mockBookingFindMany },
  },
}));

vi.mock("@/lib/booking-request", () => ({
  getBookingRequestSettings: () => mockGetBookingRequestSettings(),
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { enqueueActiveHostingIncidentPolicyReconciliation } from "@/lib/adult-member-hosting-policy-reconciliation";
import { countBookingsWithUnnamedPlaceholderGuests } from "@/lib/placeholder-guest-name-reminders";
import { countUnconfirmedSchoolAttendeeLists } from "@/lib/school-attendee-confirmation";

const ENVIRONMENT_DAY = "2026-07-01"; // Pacific/Auckland at the frozen instant
const CLUB_DAY = "2026-06-30"; // America/Denver at the frozen instant

const utcMidnight = (day: string) => new Date(`${day}T00:00:00.000Z`);

function persistClubZone(timeZone: string) {
  mockClubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone("America/Denver");
  mockGetBookingRequestSettings.mockResolvedValue({
    attendeeConfirmationLeadDays: 7,
    attendeeConfirmationReminderDays: 3,
  });
  mockBookingRequestCount.mockResolvedValue(0);
  mockBookingFindMany.mockResolvedValue([]);
});

describe("PREMISE: the container and the club disagree about today", () => {
  it("pins the environment to the replaced adapter's own answer", () => {
    expect(APP_TIME_ZONE).toBe("Pacific/Auckland");
    const now = new Date();
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(
        now,
      ),
    ).toBe(ENVIRONMENT_DAY);
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(
        now,
      ),
    ).toBe(CLUB_DAY);
  });
});

describe("the school attendee-confirmation window (#3123)", () => {
  it("opens on the CLUB's day, encoded as UTC midnight for a @db.Date column", async () => {
    await countUnconfirmedSchoolAttendeeLists();
    const where = mockBookingRequestCount.mock.calls[0]?.[0]?.where;
    expect(where.convertedBooking.checkIn).toEqual({
      gt: utcMidnight(CLUB_DAY),
      lte: utcMidnight("2026-07-07"),
    });
    // ...and specifically NOT the container's day, which is what it used to be.
    expect(where.convertedBooking.checkIn.gt).not.toEqual(
      utcMidnight(ENVIRONMENT_DAY),
    );
  });

  it("MOVES with the persisted zone — kills a hard-coded club zone", async () => {
    persistClubZone("Pacific/Kiritimati"); // UTC+14, already 1 July
    await countUnconfirmedSchoolAttendeeLists();
    expect(
      mockBookingRequestCount.mock.calls[0]?.[0]?.where.convertedBooking.checkIn
        .gt,
    ).toEqual(utcMidnight("2026-07-01"));

    mockBookingRequestCount.mockClear();
    persistClubZone("Pacific/Pago_Pago"); // UTC-11, still 30 June
    await countUnconfirmedSchoolAttendeeLists();
    expect(
      mockBookingRequestCount.mock.calls[0]?.[0]?.where.convertedBooking.checkIn
        .gt,
    ).toEqual(utcMidnight("2026-06-30"));
  });

  it("reads the zone from the persisted row, not the environment", async () => {
    await countUnconfirmedSchoolAttendeeLists();
    expect(mockClubTimeSettingsFindUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: { timeZone: true },
    });
  });
});

describe("the unnamed-placeholder-guest window (#3123)", () => {
  it("includes the club's arrival day, on the club's own calendar", async () => {
    // This window is INCLUSIVE of today, unlike the school sweep: a party still
    // unnamed on the morning they travel is who the final reminder is for.
    await countBookingsWithUnnamedPlaceholderGuests();
    expect(mockBookingFindMany.mock.calls[0]?.[0]?.where.checkIn).toEqual({
      gte: utcMidnight(CLUB_DAY),
      lte: utcMidnight("2026-07-07"),
    });
  });

  it("MOVES with the persisted zone", async () => {
    persistClubZone("Pacific/Kiritimati");
    await countBookingsWithUnnamedPlaceholderGuests();
    expect(mockBookingFindMany.mock.calls[0]?.[0]?.where.checkIn.gte).toEqual(
      utcMidnight("2026-07-01"),
    );
  });
});

describe("the hosting-policy reconciliation window (#3123)", () => {
  function makeDb() {
    return {
      adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
      booking: { findMany: vi.fn().mockResolvedValue([]) },
    };
  }

  it("keeps bookings checking out after the CLUB's today", async () => {
    const db = makeDb();
    await enqueueActiveHostingIncidentPolicyReconciliation(
      { beforePolicies: [] },
      db as never,
    );
    const where = db.booking.findMany.mock.calls[0]?.[0]?.where;
    expect(where.OR[0].checkOut).toEqual({ gt: utcMidnight(CLUB_DAY) });
  });

  it("still honours the explicit test seam over the clock", async () => {
    // The seam predates #3123 and stays: a caller that states the day is
    // stating it, and the zone is not consulted at all.
    const db = makeDb();
    await enqueueActiveHostingIncidentPolicyReconciliation(
      { beforePolicies: [], todayDateOnly: "2026-08-15" },
      db as never,
    );
    expect(db.booking.findMany.mock.calls[0]?.[0]?.where.OR[0].checkOut).toEqual(
      { gt: utcMidnight("2026-08-15") },
    );
  });
});
