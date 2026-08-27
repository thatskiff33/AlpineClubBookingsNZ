import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the member-guest consent exception list classifies every row against
 * ONE day, and that day is the CLUB's.
 *
 * This module already says so itself: "`today` is read ONCE, here, and threaded
 * into every row's derivation — never left to a default deep inside the
 * prediction. One list must be classified against one date." What it did not
 * say, until now, is WHOSE date. It was the container's.
 *
 * The proof below is a differential, deliberately, because it needs to know
 * nothing about how a row is classified. It shows three things in order: that
 * this fixture's classification really does depend on the day (otherwise every
 * other assertion here would be vacuous); that the value the module reaches for
 * by default is the club's day; and that it is NOT the container's.
 *
 * Container zone `Pacific/Auckland`, persisted club zone `America/Denver`; under
 * the frozen clock that is 1 July against 30 June. The fixture's booking checks
 * in on 1 July, so it is a future stay at the club and a stay starting today in
 * the container's zone — the pair the classifier separates.
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
  isQuotePricedBooking: vi.fn(),
}));

/*
  The `clubTimeSettings` delegate is load-bearing: `getClubTimeZone` is fail-soft
  on a missing delegate and degrades silently to the environment, so a mock
  without it passes for the very reason this file exists (#3123).
*/
vi.mock("@/lib/prisma", () => ({
  prisma: { clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique } },
}));
vi.mock("@/lib/booking-modify-validation", () => ({
  isQuotePricedBooking: mocks.isQuotePricedBooking,
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { listMemberGuestConsentExceptions } from "@/lib/member-guest-consent-exceptions";

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";
const CLUB_DAY = new Date("2026-06-30T00:00:00.000Z");
const ENVIRONMENT_DAY = new Date("2026-07-01T00:00:00.000Z");

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

const bookingGuestFindMany = vi.fn();
const db = {
  bookingGuest: { findMany: bookingGuestFindMany },
} as unknown as Parameters<typeof listMemberGuestConsentExceptions>[0];

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone(PERSISTED_ZONE);
  mocks.isQuotePricedBooking.mockResolvedValue(false);
  bookingGuestFindMany.mockResolvedValue([
    {
      id: "guest-1",
      firstName: "Ada",
      lastName: "Lovelace",
      consentStatus: "EXPIRED",
      consentRespondedAt: null,
      consentExpiresAt: new Date("2026-06-20T00:00:00.000Z"),
      booking: {
        id: "booking-1",
        status: "CONFIRMED",
        // 1 July: still a FUTURE stay at the club, already started in the
        // container's zone. That is the whole discrimination.
        checkIn: new Date("2026-07-01T00:00:00.000Z"),
        checkOut: new Date("2026-07-03T00:00:00.000Z"),
        lodge: { name: "Alpine Lodge" },
        member: { firstName: "Grace", lastName: "Hopper" },
        guests: [{ id: "guest-1" }, { id: "guest-2" }],
        payment: null,
      },
    },
  ]);
});

describe("the consent exception list classifies against the club's day (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's give different days", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(clubToday(requireClubTimeZone(ENVIRONMENT_ZONE))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_ZONE))).toBe("2026-06-30");
  });

  it("PREMISE: this fixture really is classified differently on the two days", async () => {
    // Without this leg the two assertions below would both hold for a module
    // that ignored `today` altogether.
    const onClubDay = await listMemberGuestConsentExceptions(db, {
      today: CLUB_DAY,
    });
    const onEnvironmentDay = await listMemberGuestConsentExceptions(db, {
      today: ENVIRONMENT_DAY,
    });

    expect(onClubDay).not.toEqual(onEnvironmentDay);
  });

  it("defaults to the club's day, not the container's", async () => {
    const onClubDay = await listMemberGuestConsentExceptions(db, {
      today: CLUB_DAY,
    });
    const onEnvironmentDay = await listMemberGuestConsentExceptions(db, {
      today: ENVIRONMENT_DAY,
    });

    const byDefault = await listMemberGuestConsentExceptions(db);

    expect(byDefault).toEqual(onClubDay);
    expect(byDefault).not.toEqual(onEnvironmentDay);
  });

  it("follows the persisted zone when it moves", async () => {
    // Kills a hard-coded `Pacific/Auckland` and every other way of ignoring the
    // stored row: same clock, same fixture, only the club's zone differs.
    persistClubZone("Pacific/Kiritimati"); // UTC+14 — the club's day is 1 July
    const byDefault = await listMemberGuestConsentExceptions(db);
    const onEnvironmentDay = await listMemberGuestConsentExceptions(db, {
      today: ENVIRONMENT_DAY,
    });

    expect(byDefault).toEqual(onEnvironmentDay);
  });

  it("really asks the ClubTimeSettings row for the zone", async () => {
    await listMemberGuestConsentExceptions(db);

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });
});
