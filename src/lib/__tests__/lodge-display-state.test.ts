import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayNameGranularity } from "@prisma/client";

// Issue #28 (LTV-003): the lobby display privacy serialiser — the single
// enforcement point for what a public screen shows. The matrix here covers
// every granularity level × booking shape (adults / family-with-minors /
// organisation / whole-lodge) plus scoping, clamping, config sanitisation,
// and the no-money-fields contract.

const { mockPrisma, mockFlags, mockInstructions } = vi.hoisted(() => ({
  mockPrisma: {
    lodge: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    booking: { findMany: vi.fn() },
    lodgeRoom: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
    // The route test below imports the state route, whose device path stamps
    // lastSeenAt on success (issue #52).
    lodgeDisplayDevice: { findUnique: vi.fn(), update: vi.fn() },
    // Club branding for the header brand block (issue #56).
    clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    // DB-first club name for the header (E3 #1929; leak fixed C5 #1984). Default
    // null → the display club name resolves from config, as before.
    clubIdentitySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    // Custodian in residence (#2286): a bed-holding hut-leader assignment
    // covering the window's current day. Default null = nobody in residence,
    // which is every pre-#2286 case in this file.
    hutLeaderAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
  },
  mockFlags: vi.fn(),
  mockInstructions: vi.fn(),
}));

// The state route now pulls in the layout-render assembler (LTV-027), which
// imports the server-only page-content sanitiser; `server-only` throws outside
// an RSC context, so stub it for this Node-environment route test.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
// The state route reads the club name through the tagged identity cache
// (getCachedClubIdentity, invalidated by the admin identity PUT; C5 #1984). Here
// we bypass the Next unstable_cache wrapper and delegate to the uncached DB-first
// resolver so each case re-reads the prisma mock — the real cache would otherwise
// memoise the first case's value across the two club-name assertions below.
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
  THE WALL'S "TODAY" NOW COMES FROM THE CLUB'S PERSISTED TIMEZONE (CT-4, #2870).

  `buildDisplayState` used to open its window on `getTodayDateOnly()` — the
  CONTAINER's day — which this file pinned by mocking `date-only`. It now derives
  the day from `clubTime()`, so the seam moved and the mock moves with it.

  TWO KNOBS, AND THE SECOND ONE IS THE POINT. `zone` is what the club has
  persisted. `today` short-circuits the derivation to a fixed calendar day, which
  is what keeps the fifty fixtures below on 13 April 2026 instead of on the
  frozen test clock's 1 July; it is NOT an opt-out, because the discriminating
  case at the end of this file sets it to `null` and makes the real
  `clubToday(zone, clock)` derivation run, so the zone has to reach the code for
  that pair to pass.
*/
const clubTimeState = vi.hoisted(() => ({
  zone: "Pacific/Auckland",
  today: "2026-04-13" as string | null,
}));

vi.mock("@/lib/club-time/server", async () => {
  const {
    bindClubTime,
    dateOnlyInstantOf,
    requireCalendarDate,
    requireClubTimeZone,
  } = await import("@/lib/club-time");
  const bindWithKnobs = () => {
    const bound = bindClubTime(requireClubTimeZone(clubTimeState.zone));
    return {
      ...bound,
      today: () =>
        clubTimeState.today === null
          ? bound.today()
          : requireCalendarDate(clubTimeState.today),
    };
  };
  return {
    clubTimeZone: async () => requireClubTimeZone(clubTimeState.zone),
    clubTime: async () => bindWithKnobs(),
    // `clubTodayDateOnlyInstant` IS `dateOnlyInstantOf(clubTime().today())` in the
    // real module (F4a, #2870), so the double is composed from the same two knobs
    // rather than given a literal of its own — otherwise setting `today` to `null`
    // for the discriminating case at the end of this file would stop reaching the
    // derivation through this path.
    clubTodayDateOnlyInstant: async () =>
      dateOnlyInstantOf(bindWithKnobs().today()),
  };
});

import { parseDateOnly } from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";

const LODGE = {
  id: "lodge-a",
  name: "Silverpeak Lodge",
  active: true,
  displayConfig: null,
  displayNameGranularity: null as DisplayNameGranularity | null,
  // #125 / #37: phone display defaults OFF on the lodge.
  showGuestPhonesOnScreens: false,
};

const ADULT_ORGANISER = {
  firstName: "Olive",
  lastName: "Organiser",
  ageTier: "ADULT" as const,
};

function guest(
  first: string,
  last: string,
  ageTier: "ADULT" | "CHILD" | "YOUTH" | "INFANT",
  stay: { start: string; end: string },
  roomId?: string,
  // #125 / #37: the guest's linked member (opt-in + phone). Omitted for the
  // privacy/label matrix, which does not exercise phone.
  member?: {
    ageTier?: "ADULT" | "CHILD" | "YOUTH" | "INFANT";
    lodgeScreenPhoneOptIn: boolean;
    phoneCountryCode?: string | null;
    phoneAreaCode?: string | null;
    phoneNumber?: string | null;
  }
) {
  return {
    id: `g-${first}`,
    firstName: first,
    lastName: last,
    ageTier,
    stayStart: parseDateOnly(stay.start),
    stayEnd: parseDateOnly(stay.end),
    member: member ?? null,
    // Explicit #713 night rows, empty by default (the envelope fallback). Typed
    // so a case can hand a sparse guest a real night set.
    nights: [] as Array<{ stayDate: Date }>,
    bedAllocations: roomId ? [{ roomId }] : [],
  };
}

function booking(
  id: string,
  member: { firstName: string; lastName: string; ageTier: string },
  guests: ReturnType<typeof guest>[],
  range = { checkIn: "2026-04-13", checkOut: "2026-04-15" },
  // #122 / #116: an explicit exclusive hold drives the whole-lodge blockout.
  wholeLodgeHold = false,
  // #2621: the display-only expected arrival time. Null is the ordinary case
  // and the default, so every pre-existing case is unchanged by its presence.
  expectedArrivalTime: string | null = null
) {
  return {
    id,
    checkIn: parseDateOnly(range.checkIn),
    checkOut: parseDateOnly(range.checkOut),
    wholeLodgeHold,
    member,
    guests,
    expectedArrivalTime,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE });
  mockPrisma.lodge.findFirst.mockResolvedValue(null);
  mockPrisma.clubIdentitySettings.findUnique.mockResolvedValue(null);
  mockPrisma.clubTheme.findUnique.mockResolvedValue(null);
  mockPrisma.booking.findMany.mockResolvedValue([]);
  mockPrisma.lodgeRoom.findMany.mockResolvedValue([]);
  mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
  mockPrisma.hutLeaderAssignment.findFirst.mockResolvedValue(null);
  mockFlags.mockResolvedValue({ bedAllocation: false, chores: false });
  mockInstructions.mockResolvedValue([]);
  // Back to the defaults the fixtures below assume; the discriminating case at
  // the end of this file moves both and must not leak them.
  clubTimeState.zone = "Pacific/Auckland";
  clubTimeState.today = "2026-04-13";
});

describe("reduceName / bookingLabel / clamp / config (pure rules)", () => {
  it("reduces adult names per level", async () => {
    const { reduceName } = await import("@/lib/lodge-display-state");
    expect(reduceName("Jane", "Smith", "FULL_NAME")).toBe("Jane Smith");
    expect(reduceName("Jane", "Smith", "FIRST_NAME_SURNAME_INITIAL")).toBe("Jane S");
    expect(reduceName("Jane", "Smith", "FIRST_NAME_ONLY")).toBe("Jane");
    expect(reduceName("Jane", "Smith", "COUNTS_ONLY")).toBeNull();
  });

  it("labels organisations with their full name at every level", async () => {
    const { bookingLabel } = await import("@/lib/lodge-display-state");
    const org = { firstName: "Harakeke", lastName: "College", ageTier: "NOT_APPLICABLE" as const };
    for (const level of ["FULL_NAME", "FIRST_NAME_SURNAME_INITIAL", "FIRST_NAME_ONLY", "COUNTS_ONLY"] as const) {
      expect(bookingLabel(org, { granularity: level, containsMinors: true, guestCount: 14 })).toBe("Harakeke College");
    }
  });

  it("labels bookings with minors as a family, never naming the child", async () => {
    const { bookingLabel } = await import("@/lib/lodge-display-state");
    expect(
      bookingLabel(ADULT_ORGANISER, { granularity: "FIRST_NAME_SURNAME_INITIAL", containsMinors: true, guestCount: 4 })
    ).toBe("Organiser family");
    expect(
      bookingLabel(ADULT_ORGANISER, { granularity: "FIRST_NAME_ONLY", containsMinors: true, guestCount: 4 })
    ).toBe("Family of 4");
  });

  it("clamps the window to 1..7 with a default of 3", async () => {
    const { clampDisplayWindowDays } = await import("@/lib/lodge-display-state");
    expect(clampDisplayWindowDays(null)).toBe(3);
    expect(clampDisplayWindowDays(Number.NaN)).toBe(3);
    expect(clampDisplayWindowDays(0)).toBe(1);
    expect(clampDisplayWindowDays(99)).toBe(7);
    expect(clampDisplayWindowDays(5.9)).toBe(5);
  });

  it("sanitises the config glob: key format, string values, control chars, caps", async () => {
    const { sanitiseDisplayConfig } = await import("@/lib/lodge-display-state");
    expect(
      sanitiseDisplayConfig({
        "wifi-code": "alpine1234",
        "Bad Key!": "x",
        numeric: 42,
        sneaky: "a\u0000b\u001Fc",
        long: "x".repeat(600),
      })
    ).toEqual({
      "wifi-code": "alpine1234",
      sneaky: "abc",
      long: "x".repeat(500),
    });
    expect(sanitiseDisplayConfig(null)).toEqual({});
    expect(sanitiseDisplayConfig([1, 2])).toEqual({});
  });
});

describe("buildDisplayState privacy matrix", () => {
  it("lists adult guests at the default granularity (first name + surname initial)", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
        guest("Rewi", "Parata", "ADULT", { start: "2026-04-13", end: "2026-04-14" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state?.bookings).toHaveLength(1);
    const row = state!.bookings[0];
    expect(row.label).toBe("Olive O");
    expect(row.guests?.map((g) => g.label)).toEqual(["Jane S", "Rewi P"]);
    expect(row.guestCount).toBe(2);
    expect(row.key).not.toContain("b1"); // opaque key, never the booking id
  });

  it("shows an admin-set club name on the lobby board (DB-first, not raw config; C5 #1984)", async () => {
    mockPrisma.clubIdentitySettings.findUnique.mockResolvedValue({
      name: "Board Override Club",
      shortName: null,
      hutLeaderLabel: null,
      facebookUrl: null,
    });
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state?.club.name).toBe("Board Override Club");
  });

  it("falls back to the config club name when no admin override is set", async () => {
    const { clubConfig } = await import("@/config/club");
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state?.club.name).toBe(clubConfig.name);
  });

  it("honours the per-lodge FULL_NAME override (owner-requested level)", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue({
      ...LODGE,
      displayNameGranularity: "FULL_NAME",
    });
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state!.bookings[0].guests?.[0].label).toBe("Jane Smith");
    expect(state!.bookings[0].label).toBe("Olive Organiser");
  });

  it("never lists guests for a booking containing minors, at any level (AC4)", async () => {
    for (const level of ["FULL_NAME", "FIRST_NAME_SURNAME_INITIAL", "FIRST_NAME_ONLY", "COUNTS_ONLY"] as const) {
      mockPrisma.lodge.findUnique.mockResolvedValue({
        ...LODGE,
        displayNameGranularity: level,
      });
      mockPrisma.booking.findMany.mockResolvedValue([
        booking("b1", ADULT_ORGANISER, [
          guest("Pat", "Organiser", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
          guest("Tama", "Organiser", "CHILD", { start: "2026-04-13", end: "2026-04-15" }),
        ]),
      ]);
      const { buildDisplayState } = await import("@/lib/lodge-display-state");
      const state = await buildDisplayState("lodge-a");
      const row = state!.bookings[0];
      expect(row.guests).toBeNull();
      expect(JSON.stringify(state)).not.toContain("Tama");
      expect(row.guestCount).toBe(2);
    }
  });

  it("emits only the group label for a whole-lodge organisation booking (AC3)", async () => {
    const org = { firstName: "Harakeke", lastName: "College", ageTier: "NOT_APPLICABLE" as const };
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        org,
        Array.from({ length: 14 }, (_, i) =>
          guest(`Student${i}`, "Roll", i % 2 ? "YOUTH" : "ADULT", { start: "2026-04-13", end: "2026-04-15" })
        )
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    const row = state!.bookings[0];
    expect(row.wholeLodge).toBe(true);
    expect(row.label).toBe("Harakeke College");
    expect(row.guests).toBeNull();
    expect(JSON.stringify(state)).not.toContain("Student");
  });

  it("keeps whole-lodge on a back-to-back handover: sole occupancy is measured on NIGHTS (issue #58)", async () => {
    // Group leaves Wednesday morning; a new booking arrives Wednesday evening.
    // Their departure-day visibility overlaps but their nights never do.
    const org = { firstName: "Harakeke", lastName: "College", ageTier: "NOT_APPLICABLE" as const };
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        org,
        Array.from({ length: 14 }, (_, i) =>
          guest(`Student${i}`, "Roll", "ADULT", { start: "2026-04-13", end: "2026-04-15" })
        ),
        { checkIn: "2026-04-13", checkOut: "2026-04-15" }
      ),
      booking(
        "b2",
        { firstName: "Zoe", lastName: "Zed", ageTier: "ADULT" },
        [guest("Zoe", "Zed", "ADULT", { start: "2026-04-15", end: "2026-04-16" })],
        { checkIn: "2026-04-15", checkOut: "2026-04-16" }
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    const orgRow = state!.bookings.find((row) => row.label === "Harakeke College")!;
    expect(orgRow.wholeLodge).toBe(true);
    const zoeRow = state!.bookings.find((row) => row.label !== "Harakeke College")!;
    expect(zoeRow.wholeLodge).toBe(false);
  });

  it("PRIVACY: a sparse stay's gap morning is NOT a night, so an unrelated sole-night blockout holds (#2735)", async () => {
    // THE ACCEPTANCE TEST FOR #2735, and the one whose failure mode is a
    // member's name and phone number on a public screen.
    //
    // The sparse guest holds nights 13 and 15 and NOT the 14th, so on the
    // morning of the 14th they are in the lodge until midday — which #2735 now
    // shows on the wall — and on the NIGHT of the 14th they are not. The eight
    // Blockout guests hold the 14th alone. If the wall's night count is ever
    // derived from its visible list again, the gap morning re-enters it as a
    // PHANTOM NIGHT on the 14th, the eight-guest booking stops being the sole
    // occupant, its whole-lodge blockout drops, and eight guest names appear on
    // an unauthenticated public screen (INV-DATE-006, INV-DATE-023, issue #58).
    const sparse = {
      ...guest("Gappy", "Guest", "ADULT", { start: "2026-04-13", end: "2026-04-16" }),
      // Nights 13 and 15 only — the 14th is NOT booked.
      nights: [
        { stayDate: parseDateOnly("2026-04-13") },
        { stayDate: parseDateOnly("2026-04-15") },
      ],
    };
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [sparse], {
        checkIn: "2026-04-13",
        checkOut: "2026-04-16",
      }),
      booking(
        "b2",
        { firstName: "Blockout", lastName: "Party", ageTier: "ADULT" },
        Array.from({ length: 8 }, (_, i) =>
          guest(`Blocker${i}`, "Party", "ADULT", {
            start: "2026-04-14",
            end: "2026-04-15",
          }),
        ),
        { checkIn: "2026-04-14", checkOut: "2026-04-15" },
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const blockout = state!.bookings.find((row) => row.label === "Blockout P")!;
    expect(blockout.wholeLodge).toBe(true);
    expect(blockout.guests).toBeNull();
    expect(JSON.stringify(state)).not.toContain("Blocker");

    // The sparse guest IS on the wall on the 14th — that is the whole point of
    // #2735 — and is still not one of the 14th's nine sleepers: nine people are
    // in the building at some point that day, eight of them in a bed that night.
    const gapDay = state!.occupancy.find((entry) => entry.date === "2026-04-14")!;
    expect(gapDay.staying).toBe(9);
    // They leave on the morning of the 14th and come back on the evening of the
    // 15th: per SEGMENT, not once per stay.
    expect(gapDay.departing).toBe(1);
    expect(gapDay.arriving).toBe(8);
    const returnDay = state!.occupancy.find((entry) => entry.date === "2026-04-15")!;
    expect(returnDay.arriving).toBe(1);
    expect(returnDay.departing).toBe(8);

    // The bar carries the gap, so the wall cannot draw them through the 14th.
    const gappyRow = state!.bookings.find((row) => row.label === "Olive O")!;
    expect(gappyRow.nights).toEqual(["2026-04-13", "2026-04-15"]);
    expect(gappyRow.guests![0].nights).toEqual(["2026-04-13", "2026-04-15"]);
  });

  it("PRIVACY: a sole group is still not named on a window that only catches its departure morning (#2735)", async () => {
    // The other half of the sole-occupancy gate, and the one the widened
    // visibility rule made reachable on far more days.
    //
    // Fourteen people hold the lodge to themselves on nights 12 and 16 and on
    // nothing in between. The window is 13–15, so the ONLY thing the wall sees
    // of them is the morning of the 13th, when they are in the building until
    // midday — a row with no night inside the window at all. The blockout
    // heuristic scans window nights, finds none, and used to fall straight
    // through to "not whole lodge", which published all fourteen names on an
    // unauthenticated screen. They are named on no other day: on any window
    // containing one of their nights they ARE the sole occupants and the names
    // are withheld, so this window was the one that printed them.
    const org = { firstName: "Harakeke", lastName: "College", ageTier: "ADULT" };
    const sparseGuests = Array.from({ length: 14 }, (_, i) => ({
      ...guest(`Student${i}`, "Roll", "ADULT", {
        start: "2026-04-12",
        end: "2026-04-17",
      }),
      nights: [
        { stayDate: parseDateOnly("2026-04-12") },
        { stayDate: parseDateOnly("2026-04-16") },
      ],
    }));
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", org, sparseGuests, {
        checkIn: "2026-04-12",
        checkOut: "2026-04-17",
      }),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    // The row exists — they really are here on the morning of the 13th, which
    // is the fix this issue shipped.
    expect(state!.bookings).toHaveLength(1);
    const row = state!.bookings[0];
    expect(row.nights).toEqual(["2026-04-12", "2026-04-16"]);
    // …but nobody is named, and no phone or arrival time rides along.
    expect(row.guests).toBeNull();
    expect(JSON.stringify(state)).not.toContain("Student");
    // And the wall does NOT claim the lodge is blocked out: they hold no night
    // in this window, so the blockout panel and the rotating blockout condition
    // stay off. Withholding a name and painting a "fully booked" statement over
    // an empty lodge are different decisions.
    expect(row.wholeLodge).toBe(false);
  });

  it("PRIVACY: the wall's night count is taken from the guest list, never the visible list (#2735)", async () => {
    // A source contract because the forms agree night for night on every stay in
    // the tree today — no fixture can tell them apart, so reverting this would
    // break nothing while quietly restoring the coupling that #2735 removed.
    //
    // Three shapes are refused, in the order they were actually written here:
    // subtracting the envelope end from the visible list (pre-#2628), filtering
    // the visible list by the night model (#2628, which left the count bounded
    // above by visibility), and any other re-derivation of `nightGuests` from
    // `visible`. The count must read `booking.guests` (INV-DATE-023).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/lodge-display-state.ts"),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain(
      "const nightGuests = getActiveGuestsForNight(booking.guests, date, booking);",
    );
    expect(code).not.toContain(
      "getGuestStayEnd(guest, booking).getTime() !== date.getTime()",
    );
    expect(code).not.toMatch(/nightGuests\s*=\s*visible/);
  });

  it("shows a guest on every morning they leave, and draws the gap (#2735)", async () => {
    // The reported bug, in isolation and with nobody else in the lodge: in on
    // the 13th, home on the 14th, back on the 15th. The wall used to drop them
    // from the board on the morning of the 14th, while they were physically at
    // the lodge until midday, and to draw one unbroken bar across all three
    // days as though they had never gone.
    const sparse = {
      ...guest("Gappy", "Guest", "ADULT", { start: "2026-04-13", end: "2026-04-16" }),
      nights: [
        { stayDate: parseDateOnly("2026-04-13") },
        { stayDate: parseDateOnly("2026-04-15") },
      ],
    };
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [sparse], {
        checkIn: "2026-04-13",
        checkOut: "2026-04-16",
      }),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(
      state!.occupancy.map((entry) => [entry.date, entry.staying]),
    ).toEqual([
      ["2026-04-13", 1], // arrives
      ["2026-04-14", 1], // here until midday, then gone — used to read 0
      ["2026-04-15", 1], // back for the night
    ]);
    const row = state!.bookings[0];
    expect(row.nights).toEqual(["2026-04-13", "2026-04-15"]);
    // The envelope is unchanged and still describes the whole stay.
    expect(row.stayStart).toBe("2026-04-13");
    expect(row.stayEnd).toBe("2026-04-16");
  });

  it("leaves a contiguous stay's counters and nights exactly as they were (#2735)", async () => {
    // The no-regression half. Every ordinary booking — envelope-only, no night
    // rows — must produce the same occupancy buckets and the same span it
    // always did, with `nights` simply the expanded envelope.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Anna", "Adult", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.occupancy).toEqual([
      { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
      { date: "2026-04-14", arriving: 0, departing: 0, staying: 1 },
      { date: "2026-04-15", arriving: 0, departing: 1, staying: 1 },
    ]);
    expect(state!.bookings[0].nights).toEqual(["2026-04-13", "2026-04-14"]);
    expect(state!.bookings[0].guests![0].nights).toEqual([
      "2026-04-13",
      "2026-04-14",
    ]);
  });

  it("shows a zero-night booking on no day at all (INV-DATE-008, #2735)", async () => {
    // BEHAVIOUR CHANGE, and the invariant-correct one. The old rule was the
    // CLOSED envelope `[stayStart, stayEnd]`, so a guest whose stayStart equals
    // their stayEnd was visible on that one date and counted as both an arrival
    // and a departure. Under the operational day they occupy neither half of
    // any day, so the wall shows nothing — which is what INV-DATE-008 says a
    // zero-night booking is. The shape is deliberately unrepresentable and
    // every booking-creating route refuses it; this is the wall agreeing.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Zero", "Nights", "ADULT", { start: "2026-04-14", end: "2026-04-14" })],
        { checkIn: "2026-04-14", checkOut: "2026-04-14" },
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.bookings).toEqual([]);
    expect(state!.occupancy).toEqual([
      { date: "2026-04-13", arriving: 0, departing: 0, staying: 0 },
      { date: "2026-04-14", arriving: 0, departing: 0, staying: 0 },
      { date: "2026-04-15", arriving: 0, departing: 0, staying: 0 },
    ]);
    expect(JSON.stringify(state)).not.toContain("Zero");
  });

  it("keeps a guest off the wall when none of their nights touch the window (#2735)", async () => {
    // A sparse stay whose envelope spans the window while its nights sit
    // outside it. The envelope-overlap test this replaced listed them as
    // present all week; presence is now asked per night. The other guest keeps
    // the booking on the board, so this is the guest filter and not the
    // booking filter being tested.
    const away = {
      ...guest("Away", "Guest", "ADULT", { start: "2026-04-11", end: "2026-04-20" }),
      // Night 11 (before the window) and night 17 (after it). Nothing in
      // [12, 15], so they are in the lodge on no day of a 13–15 window.
      nights: [
        { stayDate: parseDateOnly("2026-04-11") },
        { stayDate: parseDateOnly("2026-04-17") },
      ],
    };
    const here = {
      ...guest("Here", "Guest", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
      nights: [
        { stayDate: parseDateOnly("2026-04-13") },
        { stayDate: parseDateOnly("2026-04-14") },
      ],
    };
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [away, here], {
        checkIn: "2026-04-11",
        checkOut: "2026-04-20",
      }),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    expect(row.guestCount).toBe(1);
    expect(row.guests!.map((entry) => entry.label)).toEqual(["Here G"]);
    expect(row.nights).toEqual(["2026-04-13", "2026-04-14"]);
  });

  it("does not blockout a lone sole-occupancy guest (whole-lodge threshold)", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Solo", "Stayer", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state!.bookings[0].wholeLodge).toBe(false);
    expect(state!.bookings[0].guests).toHaveLength(1);
  });

  it("treats an explicit exclusive hold as whole-lodge, below the heuristic threshold (#122, ADR-001 decision 4)", async () => {
    // The SAME lone guest that the heuristic leaves un-blocked above becomes a
    // whole-lodge blockout when the booking carries the authoritative flag — no
    // headcount/sole-occupancy condition applies, and individual names are
    // withheld exactly like any whole-lodge row.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Solo", "Stayer", "ADULT", { start: "2026-04-13", end: "2026-04-15" })],
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        true // wholeLodgeHold
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state!.bookings[0].wholeLodge).toBe(true);
    expect(state!.bookings[0].guests).toBeNull();
  });

  it("never leaks the exclusive nature of a hold to the public display (ADR-001 decision 6, #119/#120)", async () => {
    // A held booking presents EXACTLY as an ordinary whole-lodge blockout — the
    // public payload must carry no indication that the lodge is *exclusively*
    // held (no wholeLodgeHold flag, no conflict/overlap/exclusivity field).
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Solo", "Stayer", "ADULT", { start: "2026-04-13", end: "2026-04-15" })],
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        true // wholeLodgeHold
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    // The row shape is the fixed whole-lodge treatment, nothing more.
    expect(Object.keys(row).sort()).toEqual(
      [
        "guestCount",
        "guests",
        "key",
        "label",
        "roomId",
        "stayStart",
        "stayEnd",
        "wholeLodge",
        // #2621: present on every row, and NULL on this one — a whole-lodge
        // row shows no names, so it carries no arrival time either.
        "arrivalTime",
        // #2735: present on every row, INCLUDING one whose names are withheld —
        // a bar has to be drawn for a blockout too, and the row's own
        // stayStart/stayEnd already published the same span. It is the group's
        // nights and names nobody, so it discloses nothing the envelope did not
        // and nothing about the hold being exclusive.
        "nights",
      ].sort()
    );
    expect(row.arrivalTime).toBeNull();
    expect(row.nights).toEqual(["2026-04-13", "2026-04-14"]);
    // No exclusivity/hold/conflict wording anywhere in the serialised payload.
    const serialised = JSON.stringify(state);
    expect(serialised).not.toMatch(/exclusiv/i);
    expect(serialised).not.toMatch(/wholeLodgeHold/i);
    expect(serialised).not.toMatch(/conflict/i);
    expect(serialised).not.toMatch(/overlap/i);
  });

  it("shares the lodge with two bookings without any whole-lodge collapse", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        ...Array.from({ length: 9 }, (_, i) =>
          guest(`A${i}`, "Group", "ADULT", { start: "2026-04-13", end: "2026-04-15" })
        ),
      ]),
      booking("b2", { firstName: "Zoe", lastName: "Zed", ageTier: "ADULT" }, [
        guest("Zoe", "Zed", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state!.bookings.every((row) => row.wholeLodge === false)).toBe(true);
  });

  it("splits a booking into per-room rows when bed allocation is on", async () => {
    mockFlags.mockResolvedValue({ bedAllocation: true, chores: false });
    mockPrisma.lodgeRoom.findMany.mockResolvedValue([
      { id: "room-1", name: "Kea" },
      { id: "room-2", name: "Tui" },
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }, "room-1"),
        guest("Rewi", "Parata", "ADULT", { start: "2026-04-13", end: "2026-04-15" }, "room-2"),
        guest("Noor", "Khan", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.rooms).toEqual([
      { id: "room-1", name: "Kea" },
      { id: "room-2", name: "Tui" },
    ]);
    const roomIds = state!.bookings.map((row) => row.roomId).sort();
    expect(roomIds).toEqual([null, "room-1", "room-2"]);
  });

  it("returns rooms: null with single per-booking rows when bed allocation is off", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }, "room-1"),
        guest("Rewi", "Parata", "ADULT", { start: "2026-04-13", end: "2026-04-15" }, "room-2"),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state!.rooms).toBeNull();
    expect(state!.bookings).toHaveLength(1);
    expect(state!.bookings[0].roomId).toBeNull();
  });

  it("computes arriving/departing/staying occupancy per window day", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
        guest("Rewi", "Parata", "ADULT", { start: "2026-04-14", end: "2026-04-15" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a", { days: 3 });

    expect(state!.occupancy).toEqual([
      { date: "2026-04-13", arriving: 1, departing: 0, staying: 1 },
      { date: "2026-04-14", arriving: 1, departing: 0, staying: 2 },
      { date: "2026-04-15", arriving: 0, departing: 2, staying: 2 },
    ]);
  });

  it("starts the window on a simulated windowStart instead of today (issue #60)", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Jane", "Smith", "ADULT", { start: "2026-05-01", end: "2026-05-03" })],
        { checkIn: "2026-05-01", checkOut: "2026-05-03" }
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a", {
      windowStart: parseDateOnly("2026-05-01"),
      days: 3,
    });
    expect(state!.window.start).toBe("2026-05-01");
    expect(state!.occupancy.map((day) => day.date)).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ]);
  });

  it("labels chore assignees per privacy rules: adults reduced, minors as family label", async () => {
    mockFlags.mockResolvedValue({ bedAllocation: false, chores: true });
    const familyGuests = [
      { ageTier: "ADULT" },
      { ageTier: "CHILD" },
    ];
    mockPrisma.choreAssignment.findMany.mockResolvedValue([
      {
        date: parseDateOnly("2026-04-13"),
        choreTemplate: { name: "Dishes" },
        bookingGuest: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        booking: { id: "b-ordinary", member: ADULT_ORGANISER, guests: [{ ageTier: "ADULT" }] },
      },
      {
        date: parseDateOnly("2026-04-13"),
        choreTemplate: { name: "Vacuum bunkroom" },
        bookingGuest: { firstName: "Tama", lastName: "Organiser", ageTier: "CHILD" },
        booking: { id: "b-family", member: ADULT_ORGANISER, guests: familyGuests },
      },
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.chores).toEqual([
      { date: "2026-04-13", title: "Dishes", assigneeLabels: ["Jane S"] },
      { date: "2026-04-13", title: "Vacuum bunkroom", assigneeLabels: ["Organiser family"] },
    ]);
    expect(JSON.stringify(state!.chores)).not.toContain("Tama");
  });

  it("applies the SAME namesAllowed decision to chore assignees as booking rows — whole-lodge and organisation bookings collapse to the group label too (#174)", async () => {
    mockFlags.mockResolvedValue({ bedAllocation: false, chores: true });

    // The whole-lodge booking also has to appear in the primary bookings
    // query — that's where `wholeLodgeBookingIds` is computed, and the
    // chores mapping looks the booking up there by id, same as booking rows.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b-whole",
        ADULT_ORGANISER,
        [guest("Wyn", "Blockout", "ADULT", { start: "2026-04-13", end: "2026-04-15" })],
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        true // wholeLodgeHold
      ),
    ]);

    const orgOrganiser = {
      firstName: "Harakeke",
      lastName: "College",
      ageTier: "NOT_APPLICABLE" as const,
    };

    mockPrisma.choreAssignment.findMany.mockResolvedValue([
      // Adult assignee, but the booking also contains a minor sibling: the
      // booking-row namesAllowed conditions withhold the individual name.
      {
        date: parseDateOnly("2026-04-13"),
        choreTemplate: { name: "Kitchen" },
        bookingGuest: { firstName: "Pat", lastName: "Organiser", ageTier: "ADULT" },
        booking: {
          id: "b-family",
          member: ADULT_ORGANISER,
          guests: [{ ageTier: "ADULT" }, { ageTier: "CHILD" }],
        },
      },
      // Adult assignee under an organisation organiser: group label.
      {
        date: parseDateOnly("2026-04-13"),
        choreTemplate: { name: "Woodshed" },
        bookingGuest: { firstName: "Ana", lastName: "Roll", ageTier: "ADULT" },
        booking: {
          id: "b-org",
          member: orgOrganiser,
          guests: [{ ageTier: "ADULT" }],
        },
      },
      // Adult assignee whose booking is the whole-lodge blockout: group label
      // (previously this leaked the individual reduced name — the #174 bug).
      {
        date: parseDateOnly("2026-04-13"),
        choreTemplate: { name: "Firewood" },
        bookingGuest: { firstName: "Wyn", lastName: "Blockout", ageTier: "ADULT" },
        booking: {
          id: "b-whole",
          member: ADULT_ORGANISER,
          guests: [{ ageTier: "ADULT" }],
        },
      },
      // Adult assignee on an ordinary booking: unchanged individual name.
      {
        date: parseDateOnly("2026-04-13"),
        choreTemplate: { name: "Dishes" },
        bookingGuest: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        booking: {
          id: "b-ordinary",
          member: ADULT_ORGANISER,
          guests: [{ ageTier: "ADULT" }],
        },
      },
    ]);

    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.chores).toEqual([
      { date: "2026-04-13", title: "Kitchen", assigneeLabels: ["Organiser family"] },
      { date: "2026-04-13", title: "Woodshed", assigneeLabels: ["Harakeke College"] },
      { date: "2026-04-13", title: "Firewood", assigneeLabels: ["Olive O"] },
      { date: "2026-04-13", title: "Dishes", assigneeLabels: ["Jane S"] },
    ]);
    // Neither the minor's, the organisation guest's, nor the whole-lodge
    // guest's own name ever appears — only ordinary-booking assignees keep
    // their individual reduced name.
    expect(JSON.stringify(state!.chores)).not.toContain("Pat");
    expect(JSON.stringify(state!.chores)).not.toContain("Ana");
    expect(JSON.stringify(state!.chores)).not.toContain("Wyn");
  });

  it("scopes every query to the device's lodge (AC5) and selects no money/email fields (AC7)", async () => {
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    await buildDisplayState("lodge-a");

    const bookingArgs = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(bookingArgs.where).toMatchObject(lodgeNullTolerantScope("lodge-a"));
    const selectJson = JSON.stringify(bookingArgs.select);
    // No monetary or email field is ever selected. Phone IS selected (#125 /
    // #37) but released per-guest only under the two-sided consent gate — see
    // the "phone opt-in gate" block for the enforcement proof.
    expect(selectJson).not.toMatch(/price|amount|cents|payment|invoice|email/i);
  });

  it("returns null for a missing or inactive lodge (AC8 path)", async () => {
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    mockPrisma.lodge.findUnique.mockResolvedValue(null);
    expect(await buildDisplayState("ghost")).toBeNull();
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE, active: false });
    expect(await buildDisplayState("lodge-a")).toBeNull();
  });

  it("passes the config glob through sanitised and ships a null notice placeholder", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue({
      ...LODGE,
      displayConfig: { "wifi-code": "alpine1234", "BAD KEY": "x" },
    });
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state!.config).toEqual({ "wifi-code": "alpine1234" });
    expect(state!.notice).toBeNull();
  });

  it("ships only the display-relevant module flags on capabilities, never the whole map", async () => {
    // The effective flags include unrelated club modules; the public payload
    // must carry only DISPLAY_RELEVANT_MODULE_KEYS (ADR-003 §3, issue #71).
    mockFlags.mockResolvedValue({
      bedAllocation: true,
      chores: false,
      lobbyDisplay: true,
      financeDashboard: true,
      twoFactor: true,
    });
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state!.capabilities).toEqual({ bedAllocation: true, chores: false });
    expect(Object.keys(state!.capabilities)).toEqual(["bedAllocation", "chores"]);
  });
});

describe("GET /api/display/state (route)", () => {
  it("401s without a display token, 200s with one, and clamps the window", async () => {
    vi.resetModules();
    // The route imports @/lib/auth for the admin preview path (issue #52);
    // stub it so this Node-environment test never loads real next-auth.
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/lodge-display-auth", () => ({
      checkDisplayAuth: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ device: { id: "dev-1", lodgeId: "lodge-a" } }),
    }));
    const buildSpy = vi.fn().mockResolvedValue({ ok: "payload" });
    vi.doMock("@/lib/lodge-display-state", () => ({
      buildDisplayState: buildSpy,
    }));
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/display/state/route");

    const unauth = await GET(
      new NextRequest("http://localhost/api/display/state", {
        headers: { "x-forwarded-for": "10.50.1.1" },
      })
    );
    expect(unauth.status).toBe(401);

    const ok = await GET(
      new NextRequest("http://localhost/api/display/state?days=99", {
        headers: { "x-forwarded-for": "10.50.1.2" },
      })
    );
    expect(ok.status).toBe(200);
    expect(buildSpy).toHaveBeenCalledWith("lodge-a", { days: 99 });
    vi.doUnmock("@/lib/lodge-display-auth");
    vi.doUnmock("@/lib/lodge-display-state");
  });
});

// #125 / #37: the lobby display is a PUBLIC screen, so the two-sided consent
// gate is the whole point here — a phone must never enter the payload unless the
// lodge enabled it AND the member opted in AND the guest is an adult on a row
// that already shows individual names.
describe("buildDisplayState phone opt-in gate (#125 / #37)", () => {
  const OPTED_IN_ADULT = {
    ageTier: "ADULT" as const,
    lodgeScreenPhoneOptIn: true,
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "4224115",
  };

  async function firstGuest(member: Parameters<typeof guest>[5]) {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }, undefined, member),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    return state!.bookings[0].guests![0];
  }

  it("serves an adult member phone when the lodge enables it AND the member opted in (AC1)", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE, showGuestPhonesOnScreens: true });
    expect((await firstGuest(OPTED_IN_ADULT)).phone).toBe("+64 27 4224115");
  });

  it("withholds the phone when the member has NOT opted in, even with lodge config on (AC1)", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE, showGuestPhonesOnScreens: true });
    const g = await firstGuest({ ...OPTED_IN_ADULT, lodgeScreenPhoneOptIn: false });
    expect(g.phone).toBeUndefined();
  });

  it("withholds the phone when the lodge config is off, even if the member opted in (AC1)", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE, showGuestPhonesOnScreens: false });
    expect((await firstGuest(OPTED_IN_ADULT)).phone).toBeUndefined();
  });

  it("never leaks a phone on a row whose names are withheld — a booking with a minor (AC2/AC4)", async () => {
    // A minor in the booking suppresses individual names entirely, so there is
    // no per-guest row to attach a number to — the adults-only floor and the
    // names-only invariant reinforce each other.
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE, showGuestPhonesOnScreens: true });
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }, undefined, OPTED_IN_ADULT),
        guest("Kid", "Smith", "CHILD", { start: "2026-04-13", end: "2026-04-15" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");
    expect(state!.bookings[0].guests).toBeNull();
  });

  it("stops serving the number on the very next build after the member revokes (AC3)", async () => {
    // The payload is rebuilt every refresh, so revocation takes effect within
    // one refresh interval — no cached number survives.
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE, showGuestPhonesOnScreens: true });
    expect((await firstGuest(OPTED_IN_ADULT)).phone).toBe("+64 27 4224115");
    const revoked = await firstGuest({ ...OPTED_IN_ADULT, lodgeScreenPhoneOptIn: false });
    expect(revoked.phone).toBeUndefined();
  });
});

// --- D-12 (#2307): the wall shows only operationally present guests ---------
//
// Owner decision D-12 keeps an unconsented member guest off the board. On this
// surface that is not just a hidden row: the guest set also decides HOW THE
// LODGE IS LABELLED, through the sole-occupancy whole-lodge heuristic
// (guestCount >= WHOLE_LODGE_MIN_GUESTS) and through containsMinors, and both of
// those gate whether individual names may be shown at all. The owner's call is
// that the board describes the lodge as it will actually be, so both decisions
// are computed from consented guests only — and these tests make that flip
// visible rather than incidental.
describe("buildDisplayState member-guest consent exclusion (D-12, #2307)", () => {
  // Applies the `where` the production code sends, the way Prisma would, so the
  // assertions below prove the query CARRIES the predicate as well as proving
  // the downstream label logic reads the filtered set. A mock that ignored the
  // `where` would pass every test here with the filter deleted.
  function matchesConsentWhere(
    where: { OR?: Array<{ consentStatus: string | null }> } | undefined,
    consentStatus: string | null | undefined,
  ): boolean {
    if (!where?.OR) return true; // no predicate sent — production filtered nothing
    const value = consentStatus ?? null;
    return where.OR.some((branch) => branch.consentStatus === value);
  }

  function seedBookings(bookings: Array<Record<string, unknown>>) {
    mockPrisma.booking.findMany.mockImplementation(
      async (args: {
        select: {
          guests: { where?: { OR?: Array<{ consentStatus: string | null }> } };
        };
      }) =>
        bookings.map((b) => ({
          ...b,
          guests: (b.guests as Array<{ consentStatus?: string | null }>).filter(
            (g) => matchesConsentWhere(args.select.guests.where, g.consentStatus),
          ),
        })),
    );
  }

  function resetDisplayMocks() {
    vi.clearAllMocks();
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE });
    mockPrisma.lodge.findFirst.mockResolvedValue(null);
    mockPrisma.clubIdentitySettings.findUnique.mockResolvedValue(null);
    mockPrisma.clubTheme.findUnique.mockResolvedValue(null);
    mockPrisma.lodgeRoom.findMany.mockResolvedValue([]);
    mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
    mockFlags.mockResolvedValue({ bedAllocation: false, chores: false });
    mockInstructions.mockResolvedValue([]);
  }

  const withConsent = (
    g: ReturnType<typeof guest>,
    consentStatus: string | null,
  ) => ({ ...g, consentStatus });

  const adultOn = (name: string) =>
    guest(name, "Visitor", "ADULT", { start: "2026-04-13", end: "2026-04-15" });

  it("omits a PENDING guest and keeps null- and CONFIRMED-consent guests", async () => {
    seedBookings([
      booking("b1", ADULT_ORGANISER, [
        // The ordinary case, and the one the not-PENDING trap would delete: a
        // null-consent guest is every non-member, every family add, every legacy
        // row, i.e. almost every guest the club has.
        withConsent(adultOn("Nula"), null),
        withConsent(adultOn("Connie"), "CONFIRMED"),
        withConsent(adultOn("Penny"), "PENDING"),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    expect(row.guests?.map((g) => g.label)).toEqual(["Nula V", "Connie V"]);
    expect(row.guestCount).toBe(2);
    // The pending guest's name must not reach the public payload at all.
    expect(JSON.stringify(state)).not.toContain("Penny");
  });

  it("keeps DECLINED and EXPIRED guests off the wall too", async () => {
    // A row that survived its removal attempt (it lands on the admin exception
    // list instead) is not an occupant either.
    seedBookings([
      booking("b1", ADULT_ORGANISER, [
        withConsent(adultOn("Nula"), null),
        withConsent(adultOn("Dana"), "DECLINED"),
        withConsent(adultOn("Xena"), "EXPIRED"),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.bookings[0].guests?.map((g) => g.label)).toEqual(["Nula V"]);
    expect(JSON.stringify(state)).not.toContain("Dana");
    expect(JSON.stringify(state)).not.toContain("Xena");
  });

  it("computes the whole-lodge privacy threshold from consented guests only", async () => {
    // WHOLE_LODGE_MIN_GUESTS is 8. Eight guests on a sole-occupancy booking is a
    // group and gets the blockout treatment, which withholds individual names.
    // Seven consented plus one PENDING is NOT a group — the eighth person is not
    // going to be there.
    const { WHOLE_LODGE_MIN_GUESTS, buildDisplayState } = await import(
      "@/lib/lodge-display-state"
    );
    const consented = Array.from({ length: WHOLE_LODGE_MIN_GUESTS - 1 }, (_, i) =>
      withConsent(adultOn(`Con${i}`), null),
    );

    seedBookings([
      booking("b1", ADULT_ORGANISER, [
        ...consented,
        withConsent(adultOn("Penny"), "PENDING"),
      ]),
    ]);
    const justUnder = await buildDisplayState("lodge-a");

    expect(justUnder!.bookings[0].wholeLodge).toBe(false);
    // Names are still shown, because this is not a group on the wall.
    expect(justUnder!.bookings[0].guests).not.toBeNull();

    // The very same booking with that one consent confirmed crosses the
    // threshold. This pair is what makes the flip deliberate rather than a side
    // effect nobody noticed.
    resetDisplayMocks();
    seedBookings([
      booking("b1", ADULT_ORGANISER, [
        ...consented,
        withConsent(adultOn("Penny"), "CONFIRMED"),
      ]),
    ]);
    const atThreshold = await buildDisplayState("lodge-a");

    expect(atThreshold!.bookings[0].wholeLodge).toBe(true);
    expect(atThreshold!.bookings[0].guests).toBeNull();
  });

  it("computes containsMinors from consented guests only", async () => {
    // The booking's only minor is a PENDING guest, so there is no minor at the
    // lodge and the adult beside them is named normally instead of the whole row
    // collapsing to the family label.
    seedBookings([
      booking("b1", ADULT_ORGANISER, [
        withConsent(adultOn("Nula"), null),
        withConsent(
          guest("Tama", "Young", "CHILD", {
            start: "2026-04-13",
            end: "2026-04-15",
          }),
          "PENDING",
        ),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    expect(row.label).toBe("Olive O");
    expect(row.guests?.map((g) => g.label)).toEqual(["Nula V"]);
    expect(JSON.stringify(state)).not.toContain("Tama");
  });

  it("sends the predicate on the booking-level guests.some as well", async () => {
    // Both halves, same reason as the kiosk: without the `some`, a booking whose
    // only overlapping guest is pending is still matched and renders as an empty
    // shell on the wall.
    seedBookings([]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    await buildDisplayState("lodge-a");

    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      where: { guests: { some: { OR?: unknown } } };
      select: { guests: { where?: { OR?: unknown } } };
    };
    expect(args.where.guests.some.OR).toEqual([
      { consentStatus: null },
      { consentStatus: "CONFIRMED" },
    ]);
    expect(args.select.guests.where?.OR).toEqual([
      { consentStatus: null },
      { consentStatus: "CONFIRMED" },
    ]);
  });

  it("filters the chore panel's own guest read so one booking gets one label", async () => {
    // The chore panel re-derives containsMinors and the group headcount from its
    // own booking.guests read. If only the booking rows were filtered, the same
    // booking could be "Olive O" in one panel and "Organiser family" in the
    // other, on the same wall, on the same night.
    mockFlags.mockResolvedValue({ bedAllocation: false, chores: true });
    seedBookings([]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    await buildDisplayState("lodge-a");

    const args = mockPrisma.choreAssignment.findMany.mock.calls[0][0] as {
      select: {
        booking: { select: { guests: { where?: { OR?: unknown } } } };
      };
    };
    expect(args.select.booking.select.guests.where?.OR).toEqual([
      { consentStatus: null },
      { consentStatus: "CONFIRMED" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// #2621 — the expected arrival time on the lobby wall.
//
// The wall is UNAUTHENTICATED. It hangs in a public lobby and anyone standing
// in front of it reads whatever the payload carries. The whole point of the
// name gate (#58, design.md §10) is that some rows may not identify the people
// on them, and an arrival time is a movement fact about identifiable people —
// so it must ride the SAME gate the names ride, never a gate of its own.
//
// The mutation these tests exist to catch: someone lifting `arrivalTime` out of
// the `namesAllowed` branch "because it is only a time". Force the time onto a
// name-suppressed row and the three PRIVACY cases below fail.
// ---------------------------------------------------------------------------
describe("buildDisplayState expected arrival time (#2621)", () => {
  it("carries the time on a row that already names its guests", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" })],
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        false,
        "17:30"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    expect(row.guests?.map((g) => g.label)).toEqual(["Jane S"]);
    expect(row.arrivalTime).toBe("17:30");
  });

  it("PRIVACY: withholds the time from a booking containing a minor — the row the wall may not name", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [
          guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
          guest("Tama", "Smith", "CHILD", { start: "2026-04-13", end: "2026-04-15" }),
        ],
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        false,
        "17:30"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    expect(row.guests).toBeNull();
    // "The Smith family arrives at 5:30" on a public screen is the same
    // disclosure the family label was chosen to avoid.
    expect(row.arrivalTime).toBeNull();
  });

  it("PRIVACY: withholds the time under COUNTS_ONLY granularity", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue({
      ...LODGE,
      displayNameGranularity: "COUNTS_ONLY",
    });
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" })],
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        false,
        "17:30"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    expect(row.guests).toBeNull();
    expect(row.arrivalTime).toBeNull();
  });

  it("PRIVACY: withholds the time from a whole-lodge blockout row", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" })],
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        true, // explicit exclusive hold
        "17:30"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    expect(row.wholeLodge).toBe(true);
    expect(row.guests).toBeNull();
    expect(row.arrivalTime).toBeNull();
  });

  it("withholds the time from a stay that began BEFORE the window — it is not an arrival any more", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Jane", "Smith", "ADULT", { start: "2026-04-11", end: "2026-04-15" })],
        { checkIn: "2026-04-11", checkOut: "2026-04-15" },
        false,
        "17:30"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    // Named, so the name gate is not what is stopping it.
    expect(row.guests?.map((g) => g.label)).toEqual(["Jane S"]);
    // "arriving 5:30" beside a guest who arrived two days ago is a lie repeated
    // every remaining day of their stay.
    expect(row.arrivalTime).toBeNull();
  });

  it("keeps the time for an arrival LATER in the window", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Jane", "Smith", "ADULT", { start: "2026-04-14", end: "2026-04-15" })],
        { checkIn: "2026-04-14", checkOut: "2026-04-15" },
        false,
        "17:30"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.bookings[0].arrivalTime).toBe("17:30");
  });

  it("withholds the time when the ROW starts mid-window but the BOOKING checked in earlier", async () => {
    // The discriminating case, and the one an in-window test alone cannot see.
    // The booking checked in on the 11th — before the board — but its only guest
    // in view has their own later stayStart (#713 partial stay) on the 14th. The
    // row therefore begins INSIDE the window, so an "is the row in the window"
    // test passes, while the time the row would print describes an arrival that
    // happened three days ago. There is one arrival time per BOOKING, so it may
    // only ride the row that is actually the booking's arrival.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Jane", "Smith", "ADULT", { start: "2026-04-14", end: "2026-04-15" })],
        { checkIn: "2026-04-11", checkOut: "2026-04-15" },
        false,
        "17:30"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const row = state!.bookings[0];
    // Named, and starting inside the window, so neither the name gate nor the
    // window check is what is stopping it.
    expect(row.guests?.map((g) => g.label)).toEqual(["Jane S"]);
    expect(row.stayStart).toBe("2026-04-14");
    expect(row.arrivalTime).toBeNull();
  });

  it("shows the time on the arriving room row of a split booking, and on no other room row", async () => {
    // Same booking, two rooms, one arrival time. Bed allocation splits it into
    // one row per room; the room whose guest joins later in the stay begins
    // mid-window, so the naive in-window check would print the booking's arrival
    // time on both bars — the second one reading as "this room arrives at 5:30
    // tonight" when that party arrived on the 13th.
    mockFlags.mockResolvedValue({ bedAllocation: true, chores: false });
    mockPrisma.lodgeRoom.findMany.mockResolvedValue([
      { id: "room-1", name: "Kea" },
      { id: "room-2", name: "Tui" },
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [
          guest(
            "Jane",
            "Smith",
            "ADULT",
            { start: "2026-04-13", end: "2026-04-16" },
            "room-1"
          ),
          guest(
            "Rewi",
            "Parata",
            "ADULT",
            { start: "2026-04-15", end: "2026-04-16" },
            "room-2"
          ),
        ],
        { checkIn: "2026-04-13", checkOut: "2026-04-16" },
        false,
        "17:30"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    const kea = state!.bookings.find((r) => r.roomId === "room-1")!;
    const tui = state!.bookings.find((r) => r.roomId === "room-2")!;
    expect(kea.stayStart).toBe("2026-04-13");
    expect(kea.arrivalTime).toBe("17:30");
    expect(tui.stayStart).toBe("2026-04-15");
    // Named, in the window, same booking, same stored time — and still no time,
    // because this row is not the booking's arrival.
    expect(tui.guests?.map((g) => g.label)).toEqual(["Rewi P"]);
    expect(tui.arrivalTime).toBeNull();
  });

  it("drops a malformed legacy value rather than printing it on a public screen", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        [guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" })],
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        false,
        // A row written before the minute rule was tightened, or by hand.
        "14:10"
      ),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.bookings[0].arrivalTime).toBeNull();
  });

  it("is null when the booking has no time, which is the ordinary case", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, [
        guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
      ]),
    ]);
    const { buildDisplayState } = await import("@/lib/lodge-display-state");
    const state = await buildDisplayState("lodge-a");

    expect(state!.bookings[0].arrivalTime).toBeNull();
  });

  it("CHANGES NO COUNT: the same fixture with and without a time gives identical occupancy and whole-lodge results", async () => {
    // The #2622-era fence on this file protects the night counts and the
    // sole-occupancy collapse from exactly this kind of addition. This proves
    // the new field is carried alongside them and read by none of them.
    const guests = () => [
      guest("Jane", "Smith", "ADULT", { start: "2026-04-13", end: "2026-04-15" }),
      guest("Rewi", "Parata", "ADULT", { start: "2026-04-13", end: "2026-04-14" }),
    ];
    const { buildDisplayState } = await import("@/lib/lodge-display-state");

    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b1", ADULT_ORGANISER, guests()),
    ]);
    const without = await buildDisplayState("lodge-a");

    mockPrisma.booking.findMany.mockResolvedValue([
      booking(
        "b1",
        ADULT_ORGANISER,
        guests(),
        { checkIn: "2026-04-13", checkOut: "2026-04-15" },
        false,
        "17:30"
      ),
    ]);
    const withTime = await buildDisplayState("lodge-a");

    expect(withTime!.occupancy).toEqual(without!.occupancy);
    expect(withTime!.bookings.map((r) => r.wholeLodge)).toEqual(
      without!.bookings.map((r) => r.wholeLodge)
    );
    expect(withTime!.bookings.map((r) => r.guestCount)).toEqual(
      without!.bookings.map((r) => r.guestCount)
    );
    expect(withTime!.bookings.map((r) => [r.stayStart, r.stayEnd])).toEqual(
      without!.bookings.map((r) => [r.stayStart, r.stayEnd])
    );
  });
});

describe("the wall's window opens on the CLUB's today, not the container's (CT-4, #2870)", () => {
  /*
    THE STRADDLE GROUP E'S OWN DIFF CREATED, and this pair is what closes it.

    `display-header-clock.tsx` was migrated to read the live day through
    `club.calendarDateOf(now)` — the club's PERSISTED zone. This function, which
    keys everything on the board (occupancy, arrivals, roster, chores, custodian
    in residence), still opened its window on `getTodayDateOnly()`: the
    CONTAINER's day. For a club in `Pacific/Auckland` on a `TZ=UTC` host that is
    a twelve-hour window every day in which the header reads "Fri, 17 Apr" above
    a board still showing 16 April's guests — on an unattended screen, with
    nobody to reload it.

    THE PAIR IS THE PROOF, and it does not depend on this machine's zone. The
    same frozen instant is asked of two clubs and required to give DIFFERENT
    days: an implementation that read the environment, the host or a hard-coded
    zone has one answer and fails one half. `clubTimeState.today` is set to
    `null` for both halves so the real `clubToday(zone, clock)` derivation runs
    rather than the fixed day the rest of this file pins.

    The frozen test clock is 2026-07-01T00:00:00.000Z (`vitest.clock-setup.ts`),
    which is 1 July in Auckland (UTC+12) and 30 JUNE in Denver (UTC-6).
  */
  const FROZEN_UTC_DAY = "2026-07-01";
  const DENVER_DAY = "2026-06-30";

  beforeEach(() => {
    clubTimeState.today = null;
  });

  it("the two clubs really disagree about the frozen instant's day", () => {
    /*
      PREMISE AS AN ANSWER, from `Intl` rather than from the kernel: recomputing
      the expectation with the code under test would prove only determinism. If
      a runtime change ever put the two clubs on the same day, this fails here
      instead of leaving the pair below asserting the same thing twice.
    */
    const dayIn = (zone: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    expect(dayIn("Pacific/Auckland")).toBe(FROZEN_UTC_DAY);
    expect(dayIn("America/Denver")).toBe(DENVER_DAY);
  });

  it("opens the window on the persisted zone's day for a club ahead of UTC", async () => {
    clubTimeState.zone = "Pacific/Auckland";
    const { buildDisplayState } = await import("@/lib/lodge-display-state");

    const state = await buildDisplayState("lodge-a", { days: 1 });

    expect(state!.window.start).toBe(FROZEN_UTC_DAY);
  });

  it("opens it a day earlier for a club behind UTC, on the same instant", async () => {
    clubTimeState.zone = "America/Denver";
    const { buildDisplayState } = await import("@/lib/lodge-display-state");

    const state = await buildDisplayState("lodge-a", { days: 1 });

    expect(state!.window.start).toBe(DENVER_DAY);
    // And the nights the board queries move with it, so this is the whole board
    // rather than a label: `checkOut: { gte: startDate }` is the arrivals and
    // occupancy bound.
    const where = mockPrisma.booking.findMany.mock.calls[0]![0].where;
    expect(where.checkOut.gte).toEqual(new Date(`${DENVER_DAY}T00:00:00.000Z`));
  });

  it("an admin preview's simulated date still wins over both", async () => {
    // The preview branch passes an explicit `windowStart`; it is a chosen day,
    // not a derived one, so no zone may touch it.
    clubTimeState.zone = "America/Denver";
    const { buildDisplayState } = await import("@/lib/lodge-display-state");

    const state = await buildDisplayState("lodge-a", {
      days: 1,
      windowStart: new Date("2026-04-16T00:00:00.000Z"),
    });

    expect(state!.window.start).toBe("2026-04-16");
  });
});
