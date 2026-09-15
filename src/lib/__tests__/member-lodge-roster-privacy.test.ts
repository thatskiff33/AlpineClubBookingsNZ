// #2942 — the member lodge roster's disclosure boundary.
//
// ENFORCES INV-PRIV-017. Every assertion that carries that rule repeats its id
// in the failure message, so whoever trips one is handed the rule rather than
// having to go and find it (#2691).
//
// WHY THESE ARE PAYLOAD TESTS AND NOT RENDER TESTS. The design this issue
// REJECTED is "select the booking and hide the private fields in JSX". In a
// React application anything reachable from a client component's props is in
// the browser whether it is rendered or not, so a test that only looked at the
// screen would pass against exactly the shape the issue forbids. Every leak
// check below therefore runs against `JSON.stringify` of the object the builder
// returns, and searches that string for forbidden VALUES and forbidden KEY
// NAMES rather than asking about one key it happens to remember.
//
// WHY THE FIXTURES CARRY REAL SECRETS. A fixture whose member has no phone
// number proves nothing about whether a phone number would have been
// serialized. Every private field this repository stores about a person is
// seeded below with a distinctive value, and the absence assertions look for
// those exact strings. A field that is never selected cannot leak, but the
// test has to be able to tell "never selected" from "there was nothing there".
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    memberLodgeAccess: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/custodian-occupancy", async (importOriginal) => {
  // PARTIAL mock: `holdCoversNight` is the real predicate, because a double
  // for it would make the night arithmetic below a fact about the double.
  // Only the database read is replaced.
  // The cast goes OUTSIDE the call, not into a type argument: Semgrep cannot
  // parse a call whose type argument contains an `import()` type and silently
  // stops scanning the rest of the file (#3318 / #2842).
  const actual = (await importOriginal()) as typeof import("@/lib/custodian-occupancy");
  return { ...actual, findCustodianBedHolds: vi.fn(async () => []) };
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { findCustodianBedHolds } from "@/lib/custodian-occupancy";
import { prisma } from "@/lib/prisma";
import {
  buildMemberLodgeRoster,
  DEFAULT_ROSTER_NAME_GRANULARITY,
  MEMBER_ROSTER_BOOKING_SELECT,
  ROSTER_WINDOW_DAYS,
} from "@/lib/member-lodge-roster";

const mockFindCustodianBedHolds = findCustodianBedHolds as unknown as ReturnType<
  typeof vi.fn
>;

function custodianHold(
  firstName: string,
  lastName: string,
  startDate: string,
  endDate: string,
  isMinor = false
) {
  return {
    assignmentId: `hold-${firstName}`,
    memberId: `member-${firstName}`,
    memberName: `${firstName} ${lastName}`,
    memberFirstName: firstName,
    memberLastName: lastName,
    memberIsMinor: isMinor,
    lodgeId: "lodge-a",
    bedId: "bed-1",
    bedName: "Bed 1",
    roomId: "room-1",
    roomName: "Room 1",
    startDate,
    endDate,
  };
}

const mockPrisma = prisma as unknown as {
  lodge: { findMany: ReturnType<typeof vi.fn> };
  booking: { findMany: ReturnType<typeof vi.fn> };
  memberLodgeAccess: { findMany: ReturnType<typeof vi.fn> };
};

// The frozen clock is 2026-07-01 (vitest.clock-setup.ts), so the club's today
// is that date and the window runs to 2026-07-31 exclusive of the last night.
const TODAY = "2026-07-01";
const LAST_NIGHT = "2026-07-30";
const FIRST_NIGHT_OUTSIDE = "2026-07-31";

/** Values that exist in the fixtures and may NEVER reach a member. */
const SECRETS = {
  email: "private.person@example.test",
  phone: "+64211234567",
  dateOfBirth: "1971-03-04",
  address: "12 Secret Lane",
  notes: "Officer note: chased twice for payment",
  joinCode: "ZZ9TRP",
  dietary: "severe peanut allergy",
  bookingId: "booking-id-must-not-appear",
  memberId: "member-id-must-not-appear",
  price: "48250",
  childFirstName: "Tama",
  childLastName: "Rangi",
} as const;

/** Key names that may never appear in a roster payload. */
const FORBIDDEN_KEYS = [
  "email",
  "phone",
  "dateOfBirth",
  "address",
  "notes",
  "joinCode",
  "dietary",
  "allergy",
  "bookingId",
  "memberId",
  "guestId",
  "price",
  "amountCents",
  "totalCents",
  "consentStatus",
  "status",
  "bedId",
  "roomId",
  "arrivalTime",
  "groupBookingId",
] as const;

/**
 * Read but never returned. `wholeLodgeHold` decides whether a party had the
 * building to itself, which is what SUPPRESSES their names — so the module
 * must select it, and the payload must not carry it. Consulting and
 * disclosing are different things and this suite checks them separately.
 */
const CONSULTED_NOT_DISCLOSED = ["wholeLodgeHold"] as const;

function instant(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * A guest with an EXPLICIT night set, which is what most fixtures here want.
 *
 * `stayEnd` is the checkout MORNING — one day past the last night — because
 * the envelope is half-open (`stayStart <= night < stayEnd`). Setting it to
 * the last night, as this helper first did, is invisible while an explicit
 * night set is present (the set wins) and silently drops that last night the
 * moment one is not. A fixture that is only correct because something else
 * overrides it is the kind of test that agrees with a bug.
 */
function guest(
  firstName: string,
  lastName: string,
  ageTier: "ADULT" | "CHILD" | "NOT_APPLICABLE",
  nights: string[]
) {
  const first = nights[0] ?? TODAY;
  const last = nights[nights.length - 1] ?? TODAY;
  return {
    firstName,
    lastName,
    ageTier,
    stayStart: instant(first),
    stayEnd: instant(nextDay(last)),
    nights: nights.map((stayDate) => ({ stayDate: instant(stayDate) })),
  };
}

/**
 * A guest carrying ONLY the half-open envelope, with no explicit night set —
 * the other shape the canonical presence rule supports, and the one no roster
 * fixture exercised until review pointed out that the fallback branch of
 * `isGuestActiveOnNight` was unreached from this suite.
 */
function envelopeGuest(
  firstName: string,
  lastName: string,
  firstNight: string,
  checkoutMorning: string
) {
  return {
    firstName,
    lastName,
    ageTier: "ADULT" as const,
    stayStart: instant(firstNight),
    stayEnd: instant(checkoutMorning),
    nights: [] as { stayDate: Date }[],
  };
}

function nextDay(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function lodgeRow(
  id: string,
  name: string,
  rosterNameGranularity:
    | "FULL_NAME"
    | "FIRST_NAME_SURNAME_INITIAL"
    | "FIRST_NAME_ONLY"
    | "COUNTS_ONLY"
    | null = null
) {
  return { id, name, rosterNameGranularity };
}

/**
 * A booking row shaped as the builder's select returns it, but carrying every
 * private field as well — so that if the builder ever spreads a row instead of
 * picking from it, the secrets are there to be caught.
 */
function bookingRow(options: {
  lodgeId: string;
  organiser: { firstName: string; lastName: string; ageTier: string };
  guests: ReturnType<typeof guest>[];
  checkIn?: string;
  checkOut?: string;
  wholeLodgeHold?: boolean;
}) {
  return {
    lodgeId: options.lodgeId,
    // Consulted by the builder as outright sole occupancy, so it is a real
    // input here rather than a planted secret. Defaults false: a fixture that
    // held the whole lodge on every booking would suppress every name and the
    // naming tests below would pass for the wrong reason.
    wholeLodgeHold: options.wholeLodgeHold ?? false,
    checkIn: instant(options.checkIn ?? TODAY),
    checkOut: instant(options.checkOut ?? "2026-07-05"),
    member: {
      ...options.organiser,
      id: SECRETS.memberId,
      email: SECRETS.email,
      phone: SECRETS.phone,
      dateOfBirth: instant(SECRETS.dateOfBirth),
      address: SECRETS.address,
      dietary: SECRETS.dietary,
    },
    guests: options.guests,
    id: SECRETS.bookingId,
    notes: SECRETS.notes,
    totalCents: Number(SECRETS.price),
    status: "PAID",
    groupBooking: { joinCode: SECRETS.joinCode },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindCustodianBedHolds.mockResolvedValue([]);
  mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
  mockPrisma.lodge.findMany.mockResolvedValue([lodgeRow("lodge-a", "Alpha")]);
  mockPrisma.booking.findMany.mockResolvedValue([]);
});

describe("member lodge roster — what the select may name", () => {
  it("names no private column, so nothing has to be stripped later", () => {
    // The PROJECTION only. `guests.where` is the consent GATE and legitimately
    // names `consentStatus`: it is a filter deciding which rows are read, not
    // a column being returned, and the rule here is about what the query
    // hands back. The payload test below is what proves `consentStatus` never
    // reaches a member.
    const { guests, ...rest } = MEMBER_ROSTER_BOOKING_SELECT;
    const projection = JSON.stringify({ ...rest, guests: guests.select });
    for (const key of FORBIDDEN_KEYS) {
      expect(
        projection,
        `INV-PRIV-017: the roster select must not name "${key}". A field that is never selected cannot leak; one that is selected and stripped later can be un-stripped by any future edit.`
      ).not.toContain(`"${key}"`);
    }
  });

  it("selects EXACTLY these columns and no others", () => {
    // An exact set, not a forbidden-substring scan. A scan cannot see a bare
    // `id: true` — "id" is a substring of `lodgeId`, so no denylist can name
    // it safely — and a booking id is precisely the durable handle a member
    // could carry to another surface. Pinning the whole set means ANY
    // widening of this select fails here and has to be argued for, which is
    // the property the denylist below cannot provide on its own.
    expect(Object.keys(MEMBER_ROSTER_BOOKING_SELECT).sort()).toEqual([
      "checkIn",
      "checkOut",
      "guests",
      "lodgeId",
      "member",
      "organisation",
      "wholeLodgeHold",
    ]);
    expect(
      Object.keys(MEMBER_ROSTER_BOOKING_SELECT.member.select).sort()
    ).toEqual(["ageTier", "firstName", "lastName"]);
    // THE ARGUMENT FOR `organisation`, which this assertion exists to demand.
    // #3369 made a booking's owner either a member or an `Organisation`, so
    // `member` is nullable and `bookingOwner()` is the one accessor for both.
    // The NAME is the only column, and it is what an organisation booking has
    // always been labelled with on this surface — the invented school member
    // carried it until stage 4 removed that member — so this preserves the
    // roster's behaviour instead of widening it. An organisation reads as
    // `NOT_APPLICABLE`, which `namesAllowedForBooking` refuses, so the name
    // reaches the group label and no individual is ever named because of it.
    expect(
      Object.keys(MEMBER_ROSTER_BOOKING_SELECT.organisation.select).sort()
    ).toEqual(["name"]);
    expect(
      Object.keys(MEMBER_ROSTER_BOOKING_SELECT.guests.select).sort()
    ).toEqual([
      "ageTier",
      "firstName",
      "lastName",
      "nights",
      "stayEnd",
      "stayStart",
    ]);
    expect(
      Object.keys(MEMBER_ROSTER_BOOKING_SELECT.guests.select.nights.select)
    ).toEqual(["stayDate"]);
  });

  it("filters guests through the canonical consent gate", () => {
    // A member added as somebody else's guest who has not consented holds a
    // bed but must not be listed. The gate is the shared constant, not a
    // re-derived OR clause.
    expect(
      JSON.stringify(MEMBER_ROSTER_BOOKING_SELECT.guests.where),
      "INV-PRIV-017: the roster must reuse OPERATIONALLY_PRESENT_GUEST_WHERE rather than restate the consent condition."
    ).toContain("consentStatus");
  });
});

describe("member lodge roster — the built payload", () => {
  it("carries no private value and no private key name", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        guests: [
          guest("Jane", "Smith", "ADULT", [TODAY, "2026-07-02"]),
          guest("Ari", "Nikau", "ADULT", [TODAY]),
        ],
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Other", lastName: "Booker", ageTier: "ADULT" },
        guests: [guest("Other", "Booker", "ADULT", ["2026-07-03"])],
      }),
    ]);

    const payload = JSON.stringify(await buildMemberLodgeRoster("viewer-1"));

    for (const [label, value] of Object.entries(SECRETS)) {
      if (label === "childFirstName" || label === "childLastName") continue;
      expect(
        payload,
        `INV-PRIV-017: ${label} must be ABSENT from the roster payload, not merely unrendered.`
      ).not.toContain(value);
    }
    for (const key of FORBIDDEN_KEYS) {
      expect(
        payload,
        `INV-PRIV-017: the key "${key}" must not appear in the roster payload.`
      ).not.toContain(`"${key}"`);
    }
  });

  it("names adults at the lodge's granularity", async () => {
    mockPrisma.lodge.findMany.mockResolvedValue([
      lodgeRow("lodge-a", "Alpha", "FIRST_NAME_SURNAME_INITIAL"),
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        guests: [guest("Jane", "Smith", "ADULT", [TODAY])],
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", [TODAY])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.people.map((p) => p.name)).toEqual([
      "Ari N",
      "Jane S",
    ]);
  });

  it("defaults to the full name when the lodge has not chosen (owner decision D2)", async () => {
    expect(DEFAULT_ROSTER_NAME_GRANULARITY).toBe("FULL_NAME");
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        guests: [guest("Jane", "Smith", "ADULT", [TODAY])],
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", [TODAY])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.granularity).toBe("FULL_NAME");
    expect(roster.lodges[0]?.people.map((p) => p.name)).toEqual([
      "Ari Nikau",
      "Jane Smith",
    ]);
  });

  it("names NOBODY in a booking that contains a child, not merely not the child", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Parent", lastName: "Rangi", ageTier: "ADULT" },
        guests: [
          guest("Parent", "Rangi", "ADULT", [TODAY]),
          guest(SECRETS.childFirstName, SECRETS.childLastName, "CHILD", [
            TODAY,
          ]),
        ],
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", [TODAY])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const payload = JSON.stringify(roster);

    expect(
      payload,
      "INV-PRIV-017 (owner decision D1): a child's name must never appear on the roster."
    ).not.toContain(SECRETS.childFirstName);
    expect(
      payload,
      "INV-PRIV-017 (owner decision D1): the ADULTS in a booking containing a child must not be named either — naming them beside a family label identifies the child by association."
    ).not.toContain("Parent");
    expect(roster.lodges[0]?.groups.map((g) => g.label)).toContain(
      "Rangi family"
    );
    // The unrelated adult booking is still named.
    expect(roster.lodges[0]?.people.map((p) => p.name)).toEqual(["Ari Nikau"]);
  });

  it("shows an organisation by its own name and never its people", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: {
          firstName: "Harakeke",
          lastName: "College",
          ageTier: "NOT_APPLICABLE",
        },
        guests: [
          guest("Teacher", "One", "ADULT", [TODAY]),
          guest(SECRETS.childFirstName, SECRETS.childLastName, "CHILD", [
            TODAY,
          ]),
        ],
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", [TODAY])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.groups.map((g) => g.label)).toContain(
      "Harakeke College"
    );
    expect(JSON.stringify(roster)).not.toContain("Teacher");
  });

  it("names nobody at COUNTS_ONLY, but still counts them", async () => {
    mockPrisma.lodge.findMany.mockResolvedValue([
      lodgeRow("lodge-a", "Alpha", "COUNTS_ONLY"),
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        guests: [guest("Jane", "Smith", "ADULT", [TODAY])],
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", [TODAY])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const payload = JSON.stringify(roster);
    expect(
      payload,
      "INV-PRIV-017: COUNTS_ONLY must yield no personal name at all."
    ).not.toContain("Jane");
    expect(payload).not.toContain("Ari");
    // Counts survive as the group rows' own figures; there is no per-night
    // total in the payload, deliberately.
    expect(roster.lodges[0]?.groups.map((g) => g.count).sort()).toEqual([1, 1]);
  });
});

describe("member lodge roster — sole occupancy", () => {
  // REGRESSION. The first build of this decided sole occupancy by counting the
  // bookings in the window, which is not the question `namesAllowedForBooking`
  // asks. Two large groups whose stays never overlap each had the lodge to
  // themselves, and the count-of-bookings reading named all of them.
  function schoolGroup(nights: string[], surname: string, size: number) {
    return bookingRow({
      lodgeId: "lodge-a",
      organiser: { firstName: "Group", lastName: surname, ageTier: "ADULT" },
      guests: Array.from({ length: size }, (_, i) =>
        guest(`Person${i}`, surname, "ADULT", nights)
      ),
      checkIn: nights[0],
      checkOut: "2026-07-31",
    });
  }

  it("suppresses two large groups that never overlap, because each was alone", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      schoolGroup([TODAY, "2026-07-02"], "Alpha", 14),
      schoolGroup(["2026-07-20", "2026-07-21"], "Beta", 12),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const payload = JSON.stringify(roster);

    expect(
      roster.lodges[0]?.people,
      "INV-PRIV-017: a group alone in the building must not be named, however many other bookings sit elsewhere in the window."
    ).toEqual([]);
    expect(payload).not.toContain("Person0");
    expect(roster.lodges[0]?.groups.map((g) => g.label).sort()).toEqual([
      "Group Alpha",
      "Group Beta",
    ]);
  });

  it("still names a large group that shared the lodge on even one of its nights", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      schoolGroup([TODAY, "2026-07-02"], "Alpha", 14),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", ["2026-07-02"])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.people.map((p) => p.name)).toContain("Person0 Alpha");
    expect(roster.lodges[0]?.people.map((p) => p.name)).toContain("Ari Nikau");
  });

  it("names a small party that is the only booking, because it is not a group", async () => {
    // Below WHOLE_LODGE_MIN_GUESTS the sole-occupancy gate does not apply: a
    // couple alone mid-week is a small party, not a take-over, and reducing
    // them to a group label would withhold names nobody asked to withhold.
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        guests: [
          guest("Jane", "Smith", "ADULT", [TODAY]),
          guest("Ari", "Nikau", "ADULT", [TODAY]),
        ],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.people.map((p) => p.name)).toEqual([
      "Ari Nikau",
      "Jane Smith",
    ]);
  });

  it("suppresses an organisation alone at any size", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: {
          firstName: "Harakeke",
          lastName: "College",
          ageTier: "NOT_APPLICABLE",
        },
        guests: [guest("Teacher", "One", "ADULT", [TODAY])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.people).toEqual([]);
    expect(JSON.stringify(roster)).not.toContain("Teacher");
  });
});

describe("member lodge roster — findings from adversarial review", () => {
  it("suppresses a small party that hired the WHOLE lodge, at any size", async () => {
    // A whole-lodge hold is sole occupancy outright. Five people who took the
    // entire building are a private party; without consulting the flag they
    // fall under the group threshold and get named the moment any second
    // booking exists in the window.
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        guests: Array.from({ length: 5 }, (_, i) =>
          guest(`Private${i}`, "Smith", "ADULT", [TODAY])
        ),
        wholeLodgeHold: true,
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", ["2026-07-20"])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const payload = JSON.stringify(roster);
    expect(
      payload,
      "INV-PRIV-017: a party that hired the whole lodge must not be named, whatever its size."
    ).not.toContain("Private0");
    // The row collapses to the booking's own label. With no minor on the
    // booking that label is the organiser at the lodge's granularity, which is
    // the lobby display's behaviour too: the PARTY is what is protected here,
    // not the fact that a booking exists under somebody's name.
    expect(roster.lodges[0]?.groups.map((g) => g.label)).toEqual([
      "Jane Smith",
    ]);
    expect(roster.lodges[0]?.people.map((p) => p.name)).not.toContain(
      "Private0 Smith"
    );
  });

  it("never puts the hold flag in the payload, though it reads it", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        guests: [guest("Jane", "Smith", "ADULT", [TODAY])],
        wholeLodgeHold: true,
      }),
    ]);
    const payload = JSON.stringify(await buildMemberLodgeRoster("viewer-1"));
    for (const key of CONSULTED_NOT_DISCLOSED) {
      expect(
        payload,
        `INV-PRIV-017: "${key}" may be read but must never be serialized.`
      ).not.toContain(key);
    }
  });

  it("applies the minor rule to the WHOLE booking, not just the nights on screen", async () => {
    // The children join after the window closes. Asking only about the nights
    // on screen would name the parents today and suppress them tomorrow, and
    // the flip would announce that a child is on the booking.
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Parent", lastName: "Rangi", ageTier: "ADULT" },
        guests: [
          guest("Parent", "Rangi", "ADULT", [TODAY]),
          guest(SECRETS.childFirstName, SECRETS.childLastName, "CHILD", [
            FIRST_NIGHT_OUTSIDE,
          ]),
        ],
        checkIn: TODAY,
        checkOut: "2026-08-02",
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", [TODAY])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(
      JSON.stringify(roster),
      "INV-PRIV-017 (owner decision D1): a booking containing a minor names nobody in it, even when the minor's nights fall outside the window."
    ).not.toContain("Parent");
    expect(roster.lodges[0]?.groups.map((g) => g.label)).toContain(
      "Rangi family"
    );
  });

  it("reports a group's BUSIEST night, not everyone who passed through", async () => {
    // Three people for two nights, three different people for two more. Six
    // were here; three at a time. A row reading "6 people, 1-5 Jul" beside
    // that range would be false about every night in it.
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Parent", lastName: "Rangi", ageTier: "ADULT" },
        guests: [
          ...Array.from({ length: 3 }, (_, i) =>
            guest(`Early${i}`, "Rangi", "ADULT", [TODAY, "2026-07-02"])
          ),
          ...Array.from({ length: 3 }, (_, i) =>
            guest(`Late${i}`, "Rangi", "ADULT", ["2026-07-04", "2026-07-05"])
          ),
          guest(SECRETS.childFirstName, SECRETS.childLastName, "CHILD", [
            TODAY,
          ]),
        ],
        checkOut: "2026-07-06",
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", ["2026-07-20"])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const group = roster.lodges[0]?.groups[0];
    expect(group?.count, "the peak night, not the window total").toBe(4);
  });

  it("does not return a per-night total for anyone to difference", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Jane", lastName: "Smith", ageTier: "ADULT" },
        guests: [guest("Jane", "Smith", "ADULT", [TODAY])],
      }),
    ]);
    const payload = JSON.stringify(await buildMemberLodgeRoster("viewer-1"));
    expect(
      payload,
      "INV-PRIV-017: a per-night occupancy total is the figure a reader would difference against the availability calendar; it must not be in the payload."
    ).not.toContain("countsByNight");
  });

  it("reports the window as half-open, so `to` is one past the last night", async () => {
    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.from).toBe(TODAY);
    expect(roster.to).toBe(FIRST_NIGHT_OUTSIDE);
  });
});

describe("member lodge roster — the presence rule's other shapes", () => {
  it("honours a bare half-open envelope, and excludes the checkout morning", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Env", lastName: "Elope", ageTier: "ADULT" },
        guests: [envelopeGuest("Env", "Elope", TODAY, "2026-07-04")],
        checkIn: TODAY,
        checkOut: "2026-07-04",
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", ["2026-07-20"])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const env = roster.lodges[0]?.people.find((p) => p.name === "Env Elope");
    expect(
      env?.nights,
      "the envelope is half-open: three nights, and the checkout morning is not one of them."
    ).toEqual([TODAY, "2026-07-02", "2026-07-03"]);
  });

  it("keeps a gap in a non-contiguous stay rather than filling it", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Split", lastName: "Stay", ageTier: "ADULT" },
        guests: [guest("Split", "Stay", "ADULT", [TODAY, "2026-07-05"])],
        checkIn: TODAY,
        checkOut: "2026-07-06",
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", ["2026-07-20"])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const split = roster.lodges[0]?.people.find((p) => p.name === "Split Stay");
    expect(
      split?.nights,
      "a gap is a real absence; the roster must not say somebody was here on a night they were not."
    ).toEqual([TODAY, "2026-07-05"]);
  });
});

describe("member lodge roster — the custodian is shown, not inferred", () => {
  it("lists the custodian by name, with the nights they are here", async () => {
    mockFindCustodianBedHolds.mockResolvedValue([
      custodianHold("Hemi", "Walker", TODAY, "2026-07-03"),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.custodians).toEqual([
      {
        name: "Hemi Walker",
        nights: [TODAY, "2026-07-02", "2026-07-03"],
      },
    ]);
  });

  it("never names a custodian under 18, but still says one is here", async () => {
    mockFindCustodianBedHolds.mockResolvedValue([
      custodianHold("Tama", "Rangi", TODAY, TODAY, true),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const payload = JSON.stringify(roster);
    expect(
      payload,
      "INV-PRIV-017: a minor custodian is never individually named, at any granularity."
    ).not.toContain("Tama");
    expect(roster.lodges[0]?.custodians).toEqual([
      { name: null, nights: [TODAY] },
    ]);
  });

  it("withholds EVERY custodian name when one of them may not be named", async () => {
    // Naming one and withholding the other identifies the withheld person by
    // elimination, so the rule is all-or-nothing.
    mockFindCustodianBedHolds.mockResolvedValue([
      custodianHold("Hemi", "Walker", TODAY, TODAY),
      custodianHold("Tama", "Rangi", TODAY, TODAY, true),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const payload = JSON.stringify(roster);
    expect(payload).not.toContain("Hemi");
    expect(payload).not.toContain("Tama");
    expect(roster.lodges[0]?.custodians.map((c) => c.name)).toEqual([
      null,
      null,
    ]);
  });

  it("reduces the custodian's name to the lodge's granularity", async () => {
    mockPrisma.lodge.findMany.mockResolvedValue([
      lodgeRow("lodge-a", "Alpha", "FIRST_NAME_SURNAME_INITIAL"),
    ]);
    mockFindCustodianBedHolds.mockResolvedValue([
      custodianHold("Hemi", "Walker", TODAY, TODAY),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.custodians[0]?.name).toBe("Hemi W");
  });

  it("drops a hold that does not reach into the window", async () => {
    mockFindCustodianBedHolds.mockResolvedValue([
      custodianHold("Hemi", "Walker", "2026-08-10", "2026-08-12"),
    ]);
    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges[0]?.custodians).toEqual([]);
  });

  it("reads custodian holds only for lodges the member may reach", async () => {
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "lodge-a" },
    ]);
    await buildMemberLodgeRoster("viewer-1");
    for (const call of mockFindCustodianBedHolds.mock.calls) {
      expect(call[0].lodgeId).toBe("lodge-a");
    }
  });
});

describe("member lodge roster — the window", () => {
  it("runs from the club's today for exactly the configured nights", async () => {
    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(ROSTER_WINDOW_DAYS).toBe(30);
    expect(roster.from).toBe(TODAY);
    expect(roster.to).toBe(FIRST_NIGHT_OUTSIDE);
  });

  it("includes the last night in the window and excludes the one after it", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Late", lastName: "Arrival", ageTier: "ADULT" },
        guests: [
          guest("Late", "Arrival", "ADULT", [LAST_NIGHT, FIRST_NIGHT_OUTSIDE]),
        ],
        checkIn: LAST_NIGHT,
        checkOut: "2026-08-01",
      }),
      bookingRow({
        lodgeId: "lodge-a",
        organiser: { firstName: "Ari", lastName: "Nikau", ageTier: "ADULT" },
        guests: [guest("Ari", "Nikau", "ADULT", [TODAY])],
      }),
    ]);

    const roster = await buildMemberLodgeRoster("viewer-1");
    const late = roster.lodges[0]?.people.find((p) => p.name === "Late Arrival");
    expect(late?.nights).toEqual([LAST_NIGHT]);
    expect(
      late?.nights,
      "INV-PRIV-017: the window is bounded and a night beyond it must not be disclosed."
    ).not.toContain(FIRST_NIGHT_OUTSIDE);
  });

  it("asks the database only for bookings overlapping the window", async () => {
    await buildMemberLodgeRoster("viewer-1");
    const where = mockPrisma.booking.findMany.mock.calls[0]?.[0]?.where;
    expect(where.deletedAt).toBeNull();
    expect(where.status.in).toEqual(["PAID", "COMPLETED"]);
    expect(where.checkIn.lt).toEqual(instant(FIRST_NIGHT_OUTSIDE));
    expect(where.checkOut.gt).toEqual(instant(TODAY));
  });
});

describe("member lodge roster — lodge authorization", () => {
  it("asks for the member's eligible lodges before selecting any booking", async () => {
    await buildMemberLodgeRoster("viewer-1");
    const accessCallOrder =
      mockPrisma.memberLodgeAccess.findMany.mock.invocationCallOrder[0];
    const bookingCallOrder =
      mockPrisma.booking.findMany.mock.invocationCallOrder[0];
    expect(
      accessCallOrder,
      "INV-PRIV-017: authorization must be resolved BEFORE booking rows are selected, so no code path reads a lodge the caller cannot reach."
    ).toBeLessThan(bookingCallOrder);
  });

  it("narrows to the member's restricted lodges and never beyond them", async () => {
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "lodge-a" },
    ]);
    await buildMemberLodgeRoster("viewer-1");
    const lodgeWhere = mockPrisma.lodge.findMany.mock.calls[0]?.[0]?.where;
    expect(lodgeWhere.active).toBe(true);
    expect(lodgeWhere.id).toEqual({ in: ["lodge-a"] });
  });

  it("reads nothing at all when the member may reach no active lodge", async () => {
    mockPrisma.lodge.findMany.mockResolvedValue([]);
    const roster = await buildMemberLodgeRoster("viewer-1");
    expect(roster.lodges).toEqual([]);
    expect(
      mockPrisma.booking.findMany,
      "INV-PRIV-017: a member with no reachable lodge must cost no booking query and have nothing to leak."
    ).not.toHaveBeenCalled();
  });

  it("does not filter by lodge id when the member is unrestricted", async () => {
    await buildMemberLodgeRoster("viewer-1");
    const lodgeWhere = mockPrisma.lodge.findMany.mock.calls[0]?.[0]?.where;
    expect(lodgeWhere.id).toBeUndefined();
    expect(lodgeWhere.active).toBe(true);
  });
});

describe("member lodge roster — the source fence", () => {
  const SOURCE = stripComments(
    readFileSync(
      path.join(process.cwd(), "src/lib/member-lodge-roster.ts"),
      "utf8"
    )
  );

  it("derives today through the club-time kernel and never by hand", () => {
    expect(
      SOURCE,
      "INV-DATE-019: a civil date must come from the club's calendar, never from an instant sliced to ten characters."
    ).not.toMatch(/toISOString\(\)\.slice/);
    expect(SOURCE).toContain("clubTime()");
    expect(SOURCE).toContain("addCalendarDays");
  });

  it("names no forbidden column anywhere in the module", () => {
    for (const key of ["joinCode", "dietary", "bedId"]) {
      expect(
        SOURCE,
        `INV-PRIV-017: the roster module must not name "${key}" at all, in a select or anywhere else.`
      ).not.toContain(key);
    }
  });

  it("reduces every name through the one shared implementation", () => {
    expect(
      SOURCE,
      "INV-SSOT: the roster must import the shared name rules rather than restate them."
    ).toContain('from "./display-name-granularity"');
    // A template literal joining a first and last name would be a second
    // implementation of `reduceName` hiding in plain sight.
    expect(SOURCE).not.toMatch(/\$\{[^}]*firstName[^}]*\}\s*\$\{/);
  });
});
