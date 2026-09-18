import { beforeEach, describe, expect, it, vi } from "vitest";

import { nextRequest, routeParams } from "@/lib/__tests__/helpers/requests";
import { withTimeZoneAsync as withHostTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * #2478 — ONE calendar-day contract, and ONE lodge, for the printed chore
 * roster feed.
 *
 * A roster night is a calendar day. It is stored in `@db.Date` columns, which
 * Prisma reads and writes as UTC midnight, and it is matched here by equality.
 * This route used to parse `dateStr + "T00:00:00"`, which is midnight ON THE
 * SERVER'S WALL CLOCK: under the production `TZ=Pacific/Auckland` pin that
 * resolves to (D-1) 12:00 UTC, so the equality filter matched no assignment row
 * and the booking window filters excluded the stay.
 *
 * WHAT THIS IS NOT. There is no print page behind this endpoint — nothing in
 * the app calls it (the admin "Print Roster" button goes to
 * `/api/admin/roster/[date]`, which always parsed correctly). These tests pin a
 * preventative fix, so that a future consumer inherits a route that reads the
 * night it was asked for and only its own lodge's roster.
 *
 * The zone cases run the same request with the process clock in two zones and
 * require an identical result. Note the two zones are deliberately independent
 * concepts: `APP_TIME_ZONE` is mocked to New Zealand below so that moving
 * `process.env.TZ` simulates a differently-zoned HOST for a club that is always
 * in NZ — without the mock, `src/config/operational.ts` reads `process.env.TZ`
 * first and the club would move with the host, hiding the mismatch.
 */

const ROSTER_NIGHT = "2026-07-10";
const NIGHT_UTC_MIDNIGHT = "2026-07-10T00:00:00.000Z";
const THIS_LODGE = "lodge-1";
const OTHER_LODGE = "lodge-2";

vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

const { mockPrisma, mockAuth } = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
    lodge: { findFirst: vi.fn(), findUnique: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

// The stored roster rows for the night being printed, as Prisma would hand them
// back: `@db.Date` values are UTC midnight. Two lodges run their own roster for
// the same night — only this lodge's may reach the sheet
// (docs/multi-lodge/lodge-scoping-contract.md).
const ASSIGNMENT_ROWS = [
  {
    choreTemplateId: "chore-1",
    choreTemplate: {
      lodgeId: THIS_LODGE,
      sortOrder: 1,
      name: "Dishes",
      description: "Wash and dry",
    },
    bookingGuest: { firstName: "Ada", lastName: "Lovelace" },
  },
  {
    choreTemplateId: "chore-2",
    choreTemplate: {
      lodgeId: OTHER_LODGE,
      sortOrder: 2,
      name: "Woodshed",
      description: "Restack the woodshed",
    },
    bookingGuest: { firstName: "Grace", lastName: "Hopper" },
  },
];

const BOOKING_ROWS = [
  {
    id: "booking-1",
    lodgeId: THIS_LODGE,
    checkIn: dateOnly("2026-07-10"),
    checkOut: dateOnly("2026-07-12"),
    member: { firstName: "Bev", lastName: "Booker" },
    guests: [
      {
        id: "guest-1",
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        stayStart: dateOnly("2026-07-10"),
        stayEnd: dateOnly("2026-07-12"),
        nights: [
          { stayDate: dateOnly("2026-07-10") },
          { stayDate: dateOnly("2026-07-11") },
        ],
        member: null,
        consentStatus: null,
      },
    ],
  },
  {
    id: "booking-2",
    lodgeId: OTHER_LODGE,
    checkIn: dateOnly("2026-07-10"),
    checkOut: dateOnly("2026-07-12"),
    member: { firstName: "Cal", lastName: "Other" },
    guests: [
      {
        id: "guest-2",
        firstName: "Grace",
        lastName: "Hopper",
        ageTier: "ADULT",
        stayStart: dateOnly("2026-07-10"),
        stayEnd: dateOnly("2026-07-12"),
        nights: [
          { stayDate: dateOnly("2026-07-10") },
          { stayDate: dateOnly("2026-07-11") },
        ],
        member: null,
        consentStatus: null,
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: {
      id: "admin-1",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
      email: "admin@example.org",
    },
  });

  // The club's default lodge, as `getDefaultLodgeId` resolves it (isDefault
  // first). An explicit `?lodgeId=` goes through `findUnique` instead.
  mockPrisma.lodge.findFirst.mockResolvedValue({ id: THIS_LODGE });
  mockPrisma.lodge.findUnique.mockImplementation(async (args: never) => {
    const { where } = args as unknown as { where: { id: string } };
    return where.id === THIS_LODGE || where.id === OTHER_LODGE
      ? { id: where.id, active: true }
      : null;
  });

  // Both mocks APPLY the filters the route sent rather than ignoring them — a
  // mock that always returned every row would pass with the bug still in place,
  // and would not notice a missing lodge scope at all.
  mockPrisma.choreAssignment.findMany.mockImplementation(async (args: never) => {
    const { where } = args as unknown as {
      where: { date: Date; choreTemplate?: { lodgeId?: string } };
    };
    const matchesNight =
      where.date instanceof Date &&
      where.date.getTime() === Date.parse(NIGHT_UTC_MIDNIGHT);
    if (!matchesNight) return [];
    const scopedTo = where.choreTemplate?.lodgeId;
    return ASSIGNMENT_ROWS.filter(
      (row) => scopedTo === undefined || row.choreTemplate.lodgeId === scopedTo,
    );
  });

  // #2631: the sheet's headcount now comes from the shared roster selector
  // (`getOperationalRosterGuestsForDate`), whose window is checkout-INCLUSIVE —
  // the morning after the last night is a rostered day. The mock APPLIES the
  // bound it is sent, so a route that reverted to `gt` would fail loudly here
  // rather than quietly returning every row.
  mockPrisma.booking.findMany.mockImplementation(async (args: never) => {
    const { where } = args as unknown as {
      where: { lodgeId?: string; checkIn: { lte: Date }; checkOut: { gte: Date } };
    };
    expect(where.checkOut).toHaveProperty("gte");
    return BOOKING_ROWS.filter(
      (booking) =>
        booking.checkIn.getTime() <= where.checkIn.lte.getTime() &&
        booking.checkOut.getTime() >= where.checkOut.gte.getTime() &&
        (where.lodgeId === undefined || booking.lodgeId === where.lodgeId),
    );
  });
});

// `withHostTimeZone` (aliased from the shared `withTimeZoneAsync` helper)
// restores the host zone by ASSIGNING it back, not by deleting
// `process.env.TZ` — a bare delete does not invalidate Node's cached zone and
// would leave the whole worker on whichever zone this file set last (#2485).

async function printRoster(date = ROSTER_NIGHT, query = "") {
  // Re-import so the route is evaluated under the host zone now in force.
  vi.resetModules();
  const { GET } = await import("@/app/api/chores/roster/[date]/print/route");
  return GET(
    nextRequest(`/api/chores/roster/${date}/print${query}`),
    routeParams({ date }),
  );
}

describe("GET /api/chores/roster/[date]/print — calendar-day contract (#2478)", () => {
  it.each([
    // A CI-style runner on UTC: naive parsing happened to be right here, which
    // is exactly why the bug survived the test suite.
    ["UTC", "2026-07-10T00:00:00.000Z"],
    // The production pin. Naive parsing lands on the PREVIOUS day at noon UTC.
    ["Pacific/Auckland", "2026-07-09T12:00:00.000Z"],
  ])(
    "prints the roster for the requested night with the host clock on %s",
    async (timeZone, naiveParseInstant) => {
      await withHostTimeZone(timeZone, async () => {
        // Guard the harness itself: if the platform ignored the TZ change, the
        // naive parse would not move and the boundary would never be tested.
        expect(new Date(`${ROSTER_NIGHT}T00:00:00`).toISOString()).toBe(
          naiveParseInstant,
        );

        const res = await printRoster();
        expect(res.status).toBe(200);
        const data = await res.json();

        // The filter is the calendar day itself, in every host zone.
        const assignmentArgs = mockPrisma.choreAssignment.findMany.mock
          .calls[0][0] as { where: { date: Date } };
        expect(assignmentArgs.where.date.toISOString()).toBe(NIGHT_UTC_MIDNIGHT);

        // …and the sheet is not blank under a correct heading.
        expect(data.date).toBe(ROSTER_NIGHT);
        expect(data.chores).toHaveLength(1);
        expect(data.chores[0]).toMatchObject({
          name: "Dishes",
          guests: ["Ada Lovelace"],
        });
        expect(data.guestCount).toBe(1);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Lodge scope
// ---------------------------------------------------------------------------

describe("GET /api/chores/roster/[date]/print — one lodge only (#2478)", () => {
  it("prints the default lodge's roster and never the other lodge's", async () => {
    const res = await printRoster();
    expect(res.status).toBe(200);
    const data = await res.json();

    // Both lodges rostered chores for this night and both have a guest staying.
    // Only this lodge's may appear, and the headcount is this lodge's alone.
    const names = (data.chores as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(["Dishes"]);
    expect(names).not.toContain("Woodshed");
    expect(data.chores[0].guests).toEqual(["Ada Lovelace"]);
    expect(data.guestCount).toBe(1);

    // The scope is in the query, not applied after the fact: the other lodge's
    // rows must never be read at all.
    const assignmentArgs = mockPrisma.choreAssignment.findMany.mock
      .calls[0][0] as { where: { choreTemplate?: { lodgeId?: string } } };
    expect(assignmentArgs.where.choreTemplate).toEqual({ lodgeId: THIS_LODGE });
    const bookingArgs = mockPrisma.booking.findMany.mock.calls[0][0] as {
      where: { lodgeId?: string };
    };
    expect(bookingArgs.where.lodgeId).toBe(THIS_LODGE);
  });

  it("honours an explicit ?lodgeId= for the other lodge", async () => {
    const res = await printRoster(ROSTER_NIGHT, `?lodgeId=${OTHER_LODGE}`);
    expect(res.status).toBe(200);
    const data = await res.json();

    // The mirror image of the case above — proof the scope is the requested
    // lodge rather than a constant.
    expect((data.chores as Array<{ name: string }>).map((c) => c.name)).toEqual([
      "Woodshed",
    ]);
    expect(data.chores[0].guests).toEqual(["Grace Hopper"]);
    expect(data.guestCount).toBe(1);
  });

  it("refuses a lodgeId that names no active lodge", async () => {
    const res = await printRoster(ROSTER_NIGHT, "?lodgeId=lodge-gone");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Lodge not found or not active" });
    expect(mockPrisma.choreAssignment.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Date validation — the two-message contract the sibling [date] routes keep
// ---------------------------------------------------------------------------

describe("GET /api/chores/roster/[date]/print — date validation (#2478)", () => {
  it.each([
    ["not a date at all", "yesterday"],
    ["a day that does not exist in that month", "2026-07-32"],
    // Deliberately REFUSED rather than silently rolled forward to 2 March: a
    // mistyped night must never print another night's roster under the heading
    // that was asked for.
    ["a date that would roll over into the next month", "2026-02-30"],
  ])("rejects %s with the format message", async (_label, value) => {
    const res = await printRoster(value);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid date format" });
    expect(mockPrisma.choreAssignment.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });

  it("keeps the second message for a value that passes the shape check but does not parse", async () => {
    // `parseDateOnly` re-runs `isDateOnlyString`, so nothing reaches the second
    // branch through the public surface today. It is kept because it is the
    // sibling routes' contract, and pinned here so that swapping in a looser
    // parser cannot quietly send an invalid `Date` to a query instead of
    // returning this 400.
    vi.resetModules();
    vi.doMock("@/lib/date-only", async () => {
      const actual =
        (await vi.importActual("@/lib/date-only")) as typeof import("@/lib/date-only");
      return {
        ...actual,
        isDateOnlyString: () => true,
        parseDateOnly: () => new Date(NaN),
      };
    });

    try {
      const { GET } = await import(
        "@/app/api/chores/roster/[date]/print/route"
      );
      const res = await GET(
        nextRequest(`/api/chores/roster/${ROSTER_NIGHT}/print`),
        routeParams({ date: ROSTER_NIGHT }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid date" });
      expect(mockPrisma.choreAssignment.findMany).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@/lib/date-only");
      vi.resetModules();
    }
  });
});
