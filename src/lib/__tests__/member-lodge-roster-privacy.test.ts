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

import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { prisma } from "@/lib/prisma";
import {
  buildMemberLodgeRoster,
  DEFAULT_ROSTER_NAME_GRANULARITY,
  MEMBER_ROSTER_BOOKING_SELECT,
  ROSTER_WINDOW_DAYS,
} from "@/lib/member-lodge-roster";

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
  "wholeLodgeHold",
  "arrivalTime",
  "groupBookingId",
] as const;

function instant(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function guest(
  firstName: string,
  lastName: string,
  ageTier: "ADULT" | "CHILD" | "NOT_APPLICABLE",
  nights: string[]
) {
  return {
    firstName,
    lastName,
    ageTier,
    stayStart: instant(nights[0] ?? TODAY),
    stayEnd: instant(nights[nights.length - 1] ?? TODAY),
    nights: nights.map((stayDate) => ({ stayDate: instant(stayDate) })),
  };
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
}) {
  return {
    lodgeId: options.lodgeId,
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
    wholeLodgeHold: true,
    groupBooking: { joinCode: SECRETS.joinCode },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    ]);
    expect(
      Object.keys(MEMBER_ROSTER_BOOKING_SELECT.member.select).sort()
    ).toEqual(["ageTier", "firstName", "lastName"]);
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
    expect(roster.lodges[0]?.countsByNight[TODAY]).toBe(2);
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
    for (const key of ["joinCode", "dietary", "wholeLodgeHold", "bedId"]) {
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
