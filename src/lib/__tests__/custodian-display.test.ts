import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayNameGranularity } from "@prisma/client";

/**
 * Custodian on the lobby TV (#2286).
 *
 * Two things are being pinned here, and the second matters more than the first:
 *
 *  1. the slot appears only for a BED-HOLDING assignment covering today, and
 *  2. the payload never individually names someone it must not — nobody under
 *     COUNTS_ONLY, and NEVER a minor-age custodian at any granularity. Nothing
 *     structurally stops an admin making a minor the custodian, so the display
 *     serialiser refuses on its own rather than trusting the admin surface.
 *
 * The custodian is not a `BookingGuest`, so their absence from the occupancy
 * counts, the booking rows and the chore roster is structural — asserted here
 * so a future refactor that "helpfully" joins them in fails loudly.
 */

const { mockPrisma, mockFlags, mockInstructions } = vi.hoisted(() => ({
  mockPrisma: {
    lodge: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    booking: { findMany: vi.fn() },
    lodgeRoom: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
    clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    clubIdentitySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    hutLeaderAssignment: { findMany: vi.fn() },
  },
  mockFlags: vi.fn(),
  mockInstructions: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/public-layout-config", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/club-identity-settings")
  >("@/lib/club-identity-settings");
  return { getCachedClubIdentity: actual.getClubIdentity };
});
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: () => mockFlags(),
}));
vi.mock("@/lib/lodge-instructions", () => ({
  getSanitizedLodgeInstructions: (...args: unknown[]) =>
    mockInstructions(...args),
}));
/*
  `buildDisplayState` opens its window on the CLUB's today since CT-4 (#2870),
  not on `getTodayDateOnly()`, so the seam this file pins moved from `date-only`
  to `clubTime()`. The pinned day is unchanged, and so is every expectation
  below; `lodge-display-state.test.ts` is where the zone itself is proved to be
  the authority.
*/
vi.mock("@/lib/club-time/server", async () => {
  const {
    bindClubTime,
    dateOnlyInstantOf,
    requireCalendarDate,
    requireClubTimeZone,
  } = await import("@/lib/club-time");
  const zone = requireClubTimeZone("Pacific/Auckland");
  const bound = bindClubTime(zone);
  const today = () => requireCalendarDate("2026-07-02");
  return {
    clubTimeZone: async () => zone,
    clubTime: async () => ({ ...bound, today }),
    // `clubTodayDateOnlyInstant` IS `dateOnlyInstantOf(clubTime().today())` in the
    // real module (F4a, #2870), so the double composes it from the same pinned day.
    clubTodayDateOnlyInstant: async () => dateOnlyInstantOf(today()),
  };
});

import { buildDisplayState } from "@/lib/lodge-display-state";

const LODGE_ID = "lodge-a";

function lodge(granularity: DisplayNameGranularity | null = null) {
  return {
    id: LODGE_ID,
    name: "Silverpeak Lodge",
    active: true,
    displayConfig: null,
    displayNameGranularity: granularity,
    showGuestPhonesOnScreens: false,
  };
}

function custodianRow(ageTier: string, firstName = "Sam", lastName = "Ranger") {
  return { member: { firstName, lastName, ageTier } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.lodge.findUnique.mockResolvedValue(lodge());
  mockPrisma.lodge.findFirst.mockResolvedValue(null);
  mockPrisma.booking.findMany.mockResolvedValue([]);
  mockPrisma.lodgeRoom.findMany.mockResolvedValue([]);
  mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
  mockPrisma.clubTheme.findUnique.mockResolvedValue(null);
  mockPrisma.clubIdentitySettings.findUnique.mockResolvedValue(null);
  mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
  mockFlags.mockResolvedValue({
    bedAllocation: false,
    chores: false,
    hutLeaders: true,
  });
  mockInstructions.mockResolvedValue([]);
});

describe("custodian slot on the lobby display", () => {
  it("is null when nobody is in residence", async () => {
    const state = await buildDisplayState(LODGE_ID);
    expect(state?.custodian).toBeNull();
  });

  it("asks only for a BED-HOLDING assignment covering today, scoped to this lodge", async () => {
    await buildDisplayState(LODGE_ID);
    const where = mockPrisma.hutLeaderAssignment.findMany.mock.calls[0][0]
      .where as Record<string, unknown>;
    // The bedId gate is the whole point: a role-only assignment is not an
    // occupancy and must not put anyone on the wall.
    expect(where.bedId).toEqual({ not: null });
    expect(where.lodgeId).toBe(LODGE_ID);
  });

  it("names an adult custodian at the configured granularity", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue(
      lodge("FIRST_NAME_SURNAME_INITIAL"),
    );
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      custodianRow("ADULT"),
    ]);

    const state = await buildDisplayState(LODGE_ID);
    expect(state?.custodian).toEqual({ label: "Sam R", count: 1 });
  });

  it("shows the slot with NO name under COUNTS_ONLY, so the wall still says someone is here", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue(lodge("COUNTS_ONLY"));
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      custodianRow("ADULT"),
    ]);

    const state = await buildDisplayState(LODGE_ID);
    expect(state?.custodian).toEqual({ label: null, count: 1 });
  });

  it.each(["INFANT", "CHILD", "YOUTH"])(
    "never names a %s custodian, even at FULL_NAME — the display contract forbids naming a minor at any level",
    async (ageTier) => {
      mockPrisma.lodge.findUnique.mockResolvedValue(lodge("FULL_NAME"));
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        custodianRow(ageTier),
      ]);

      const state = await buildDisplayState(LODGE_ID);
      expect(state?.custodian).toEqual({ label: null, count: 1 });
      expect(JSON.stringify(state)).not.toContain("Ranger");
    },
  );

  it("carries no phone, no dates and no member id — the slot is a name or nothing", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue(lodge("FULL_NAME"));
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      custodianRow("ADULT"),
    ]);

    const state = await buildDisplayState(LODGE_ID);
    expect(Object.keys(state?.custodian ?? {}).sort()).toEqual([
      "count",
      "label",
    ]);
  });

  it("keeps the custodian out of the occupancy counts, the booking rows and the chore roster", async () => {
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      custodianRow("ADULT"),
    ]);

    const state = await buildDisplayState(LODGE_ID);
    // Structural, not filtered: a custodian is not a BookingGuest, so there is
    // nothing for these three surfaces to have picked up in the first place.
    expect(state?.bookings).toEqual([]);
    expect(state?.chores).toEqual([]);
    expect(state?.occupancy.every((day) => day.staying === 0)).toBe(true);
  });

  it("is skipped entirely when the hutLeaders module is off — no read, no slot", async () => {
    mockFlags.mockResolvedValue({
      bedAllocation: false,
      chores: false,
      hutLeaders: false,
    });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      custodianRow("ADULT"),
    ]);

    const state = await buildDisplayState(LODGE_ID);
    // A club with the module off has no hut-leader surface at all, so the wall
    // must not grow one. The query is not made in the first place — the same
    // shape as `flags.bedAllocation` for rooms and `flags.chores` for the roster.
    expect(state?.custodian).toBeNull();
    expect(mockPrisma.hutLeaderAssignment.findMany).not.toHaveBeenCalled();
  });

  describe("handover night — two custodians on two beds", () => {
    it("names BOTH and counts two, instead of naming one and hiding the other", async () => {
      mockPrisma.lodge.findUnique.mockResolvedValue(
        lodge("FIRST_NAME_SURNAME_INITIAL"),
      );
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        custodianRow("ADULT", "Sam", "Ranger"),
        custodianRow("ADULT", "Ada", "Beck"),
      ]);

      const state = await buildDisplayState(LODGE_ID);
      expect(state?.custodian).toEqual({ label: "Sam R · Ada B", count: 2 });
    });

    it("withholds EVERY name when one of them is a minor, and reports the count", async () => {
      // All-or-nothing: naming the adult beside "Custodians · 2" would identify
      // the minor by elimination. The count is still the honest fact.
      mockPrisma.lodge.findUnique.mockResolvedValue(lodge("FULL_NAME"));
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        custodianRow("ADULT", "Sam", "Ranger"),
        custodianRow("YOUTH", "Kid", "Junior"),
      ]);

      const state = await buildDisplayState(LODGE_ID);
      expect(state?.custodian).toEqual({ label: null, count: 2 });
      const payload = JSON.stringify(state);
      expect(payload).not.toContain("Junior");
      expect(payload).not.toContain("Ranger");
    });

    it("bounds the read rather than rendering an unbounded list of bad data", async () => {
      await buildDisplayState(LODGE_ID);
      expect(
        mockPrisma.hutLeaderAssignment.findMany.mock.calls[0][0].take,
      ).toBeGreaterThan(0);
    });
  });
});
