/**
 * #2622 — checkout-day guests on the chore roster, end to end.
 *
 * The canonical selector, the kiosk generate route that now shares it, and the
 * roster-confirm validation that has to agree with both. Acceptance criteria
 * AC1-AC4 and AC7 live here; cleanup (AC5) is in
 * `chore-cleanup-operational-day.test.ts` and the rule itself is in
 * `operational-day-presence.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PRESENT_OR = [{ consentStatus: null }, { consentStatus: "CONFIRMED" }];

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findMany: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
    choreTemplate: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn(), createMany: vi.fn(), groupBy: vi.fn() },
    lodge: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const lodgeAuthMocks = vi.hoisted(() => ({
  checkLodgeAuth: vi.fn(),
  resolveKioskLodgeId: vi.fn(),
}));
vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: lodgeAuthMocks.checkLodgeAuth,
  getLodgeAuthActorMemberId: vi.fn(() => "actor-1"),
  resolveKioskLodgeId: lodgeAuthMocks.resolveKioskLodgeId,
  kioskLodgeAuthErrorResponse: vi.fn(() => null),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLodgeCapacity: vi.fn().mockResolvedValue(20),
}));

import { getOperationalRosterGuestsForDate } from "@/lib/roster-eligibility";
import { validateRosterAllocationsForDate } from "@/lib/lodge-date-scoping";

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const DATE = day("2026-07-13");

type FixtureGuest = {
  id: string;
  firstName: string;
  lastName: string;
  ageTier?: string;
  stayStart: Date;
  stayEnd: Date;
  nights: Array<{ stayDate: Date }>;
  member?: { ageTier: string; dateOfBirth: Date | null } | null;
};

function guest(
  id: string,
  nights: string[],
  overrides: Partial<FixtureGuest> = {},
): FixtureGuest {
  const sorted = [...nights].sort();
  return {
    id,
    firstName: id,
    lastName: "Guest",
    ageTier: "ADULT",
    stayStart: day(sorted[0] ?? "2026-07-13"),
    stayEnd: day(sorted[sorted.length - 1] ?? "2026-07-12"),
    nights: nights.map((iso) => ({ stayDate: day(iso) })),
    member: { ageTier: "ADULT", dateOfBirth: null },
    ...overrides,
  };
}

function booking(id: string, guests: FixtureGuest[], owner = "Ana Booker") {
  return {
    id,
    createdAt: day("2026-01-01"),
    checkIn: day("2026-07-10"),
    checkOut: day("2026-07-16"),
    member: { firstName: owner.split(" ")[0], lastName: owner.split(" ")[1] },
    guests,
  };
}

/** The `db` shape the selector needs, so it can be driven without Prisma. */
function fakeDb(bookings: unknown[]) {
  const findMany = vi.fn<(args: unknown) => Promise<unknown[]>>(async () => bookings);
  return { db: { booking: { findMany } } as never, findMany };
}

describe("getOperationalRosterGuestsForDate — the canonical selector (#2622)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("AC1: includes the checkout-day guest and excludes the day-after one", async () => {
    const { db } = fakeDb([
      booking("booking-1", [
        // Left this morning: last night was the 12th.
        guest("leaving", ["2026-07-11", "2026-07-12"]),
        // Mid-stay.
        guest("staying", ["2026-07-12", "2026-07-13"]),
        // Arrives tonight.
        guest("arriving", ["2026-07-13", "2026-07-14"]),
        // Left yesterday morning — gone.
        guest("gone", ["2026-07-10", "2026-07-11"]),
      ]),
    ]);
    const result = await getOperationalRosterGuestsForDate(DATE, "lodge-1", db);
    expect(result.map((entry) => entry.id)).toEqual([
      "arriving",
      "leaving",
      "staying",
    ]);
  });

  it("AC1: derives 'departing' as LEAVES TODAY, not leaves tomorrow", async () => {
    const { db } = fakeDb([
      booking("booking-1", [
        guest("leaving", ["2026-07-11", "2026-07-12"]),
        guest("staying", ["2026-07-12", "2026-07-13"]),
        guest("arriving", ["2026-07-13", "2026-07-14"]),
      ]),
    ]);
    const byId = new Map(
      (await getOperationalRosterGuestsForDate(DATE, "lodge-1", db)).map((entry) => [
        entry.id,
        entry,
      ]),
    );
    expect(byId.get("leaving")).toMatchObject({ isArriving: false, isDeparting: true });
    expect(byId.get("staying")).toMatchObject({ isArriving: false, isDeparting: false });
    expect(byId.get("arriving")).toMatchObject({ isArriving: true, isDeparting: false });
  });

  it("AC2: a sparse stay's gap day is not presence", async () => {
    const { db } = fakeDb([
      booking("booking-1", [guest("sparse", ["2026-07-11", "2026-07-14"])]),
    ]);
    // The 13th is adjacent to neither the 11th nor the 14th.
    expect(await getOperationalRosterGuestsForDate(DATE, "lodge-1", db)).toEqual([]);
    // ...but the morning after the FIRST segment is.
    const morningAfter = await getOperationalRosterGuestsForDate(
      day("2026-07-12"),
      "lodge-1",
      db,
    );
    expect(morningAfter.map((entry) => entry.id)).toEqual(["sparse"]);
    expect(morningAfter[0]).toMatchObject({ isDeparting: true });
  });

  it("MUTATION PROBE: the coarse SQL bounds are checkout-inclusive on booking and guest", async () => {
    // Reverting either bound to `gt` drops the checkout-day booking before the
    // in-memory rule ever sees it, and no amount of correct rule code helps.
    const { db, findMany } = fakeDb([]);
    await getOperationalRosterGuestsForDate(DATE, "lodge-1", db);
    const args = findMany.mock.calls[0][0] as unknown as {
      where: Record<string, unknown> & {
        guests: { some: Record<string, unknown> };
      };
      include: { guests: { where: Record<string, unknown>; include: unknown } };
    };
    expect(args.where.checkIn).toEqual({ lte: DATE });
    expect(args.where.checkOut).toEqual({ gte: DATE });
    expect(args.where.guests.some).toMatchObject({
      stayStart: { lte: DATE },
      stayEnd: { gte: DATE },
    });
    expect(args.include.guests.where).toMatchObject({
      stayStart: { lte: DATE },
      stayEnd: { gte: DATE },
    });
  });

  it("preserves the consent, review, status, soft-delete and lodge filters verbatim", async () => {
    const { db, findMany } = fakeDb([]);
    await getOperationalRosterGuestsForDate(DATE, "lodge-1", db);
    const args = findMany.mock.calls[0][0] as unknown as {
      where: {
        status: { in: string[] };
        deletedAt: null;
        lodgeId: string;
        OR: unknown;
        guests: { some: { OR: unknown } };
      };
      include: { guests: { where: { OR: unknown }; include: { nights: unknown } } };
    };
    expect(args.where.status.in).not.toContain("CANCELLED");
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.lodgeId).toBe("lodge-1");
    expect(args.where.OR).toEqual([
      { requiresAdminReview: false },
      { adminReviewStatus: "APPROVED" },
    ]);
    expect(args.where.guests.some.OR).toEqual(PRESENT_OR);
    expect(args.include.guests.where.OR).toEqual(PRESENT_OR);
    // Without the night rows a sparse gap would read as presence.
    expect(args.include.guests.include.nights).toEqual({
      select: { stayDate: true },
    });
  });

  it("AC1: returns each person once across several bookings, in booking then age order", async () => {
    const { db } = fakeDb([
      booking("booking-1", [
        guest("older", ["2026-07-12"], {
          member: { ageTier: "ADULT", dateOfBirth: day("1970-01-01") },
        }),
        guest("younger", ["2026-07-12"], {
          member: { ageTier: "ADULT", dateOfBirth: day("1990-01-01") },
        }),
      ]),
      booking("booking-2", [guest("other", ["2026-07-13"])], "Bo Second"),
    ]);
    const result = await getOperationalRosterGuestsForDate(DATE, "lodge-1", db);
    expect(result.map((entry) => entry.id)).toEqual(["older", "younger", "other"]);
    expect(new Set(result.map((entry) => entry.id)).size).toBe(result.length);
    expect(result.map((entry) => entry.bookingGroupLabel)).toEqual([
      "Booking for Ana Booker",
      "Booking for Ana Booker",
      "Booking for Bo Second",
    ]);
  });

  it("AC1: scopes to the requested lodge", async () => {
    const { db, findMany } = fakeDb([]);
    await getOperationalRosterGuestsForDate(DATE, "lodge-2", db);
    expect(
      (findMany.mock.calls[0][0] as unknown as { where: { lodgeId: string } }).where
        .lodgeId,
    ).toBe("lodge-2");
  });
});

describe("validateRosterAllocationsForDate (#2622)", () => {
  beforeEach(() => vi.clearAllMocks());

  function storedGuest(id: string, nights: string[]) {
    return {
      id,
      bookingId: "booking-1",
      stayStart: day(nights[0]),
      stayEnd: day(nights[nights.length - 1]),
      nights: nights.map((iso) => ({ stayDate: day(iso) })),
      booking: { checkIn: day("2026-07-10"), checkOut: day("2026-07-16") },
    };
  }

  it("MUTATION PROBE: accepts an allocation for a guest who leaves this morning", async () => {
    mockPrisma.bookingGuest.findMany.mockResolvedValue([
      storedGuest("leaving", ["2026-07-11", "2026-07-12"]),
    ]);
    await expect(
      validateRosterAllocationsForDate(
        [{ bookingGuestId: "leaving", bookingId: "booking-1" }],
        DATE,
        "lodge-1",
      ),
    ).resolves.toBe(true);
  });

  it("rejects an allocation for someone who left yesterday", async () => {
    mockPrisma.bookingGuest.findMany.mockResolvedValue([
      storedGuest("gone", ["2026-07-10", "2026-07-11"]),
    ]);
    await expect(
      validateRosterAllocationsForDate(
        [{ bookingGuestId: "gone", bookingId: "booking-1" }],
        DATE,
        "lodge-1",
      ),
    ).resolves.toBe(false);
  });

  it("rejects an allocation on a sparse gap day", async () => {
    mockPrisma.bookingGuest.findMany.mockResolvedValue([
      storedGuest("sparse", ["2026-07-11", "2026-07-14"]),
    ]);
    await expect(
      validateRosterAllocationsForDate(
        [{ bookingGuestId: "sparse", bookingId: "booking-1" }],
        DATE,
        "lodge-1",
      ),
    ).resolves.toBe(false);
  });

  it("still rejects an allocation attributed to the wrong booking", async () => {
    mockPrisma.bookingGuest.findMany.mockResolvedValue([
      storedGuest("leaving", ["2026-07-11", "2026-07-12"]),
    ]);
    await expect(
      validateRosterAllocationsForDate(
        [{ bookingGuestId: "leaving", bookingId: "booking-other" }],
        DATE,
        "lodge-1",
      ),
    ).resolves.toBe(false);
  });

  it("widens both coarse bounds and keeps the consent, review and lodge filters", async () => {
    mockPrisma.bookingGuest.findMany.mockResolvedValue([]);
    await validateRosterAllocationsForDate(
      [{ bookingGuestId: "any", bookingId: "booking-1" }],
      DATE,
      "lodge-1",
    );
    const args = mockPrisma.bookingGuest.findMany.mock.calls[0][0] as {
      where: {
        stayEnd: unknown;
        OR: unknown;
        booking: { checkOut: unknown; lodgeId: string; OR: unknown };
      };
    };
    expect(args.where.stayEnd).toEqual({ gte: DATE });
    expect(args.where.booking.checkOut).toEqual({ gte: DATE });
    expect(args.where.OR).toEqual(PRESENT_OR);
    expect(args.where.booking.lodgeId).toBe("lodge-1");
    expect(args.where.booking.OR).toEqual([
      { requiresAdminReview: false },
      { adminReviewStatus: "APPROVED" },
    ]);
  });
});

describe("kiosk generate route shares the selector (#2622)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "hut-leader" });
    lodgeAuthMocks.resolveKioskLodgeId.mockResolvedValue("lodge-1");
    mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
  });

  function morningAndEveningTemplates() {
    return [
      {
        id: "strip-beds",
        name: "Strip beds",
        recommendedPeopleMin: 1,
        recommendedPeopleMax: 1,
        isEssential: true,
        ageRestriction: "ANY",
        minAge: 0,
        sortOrder: 1,
        timeOfDay: "MORNING",
        frequencyMode: "DAILY",
        frequencyDays: null,
        frequencyDaysOfWeek: [],
      },
      {
        id: "dinner",
        name: "Dinner",
        recommendedPeopleMin: 1,
        recommendedPeopleMax: 1,
        isEssential: true,
        ageRestriction: "ANY",
        minAge: 0,
        sortOrder: 2,
        timeOfDay: "EVENING",
        frequencyMode: "DAILY",
        frequencyDays: null,
        frequencyDaysOfWeek: [],
      },
    ];
  }

  async function generate() {
    const { POST } = await import("@/app/api/lodge/roster/[date]/generate/route");
    const request = new Request(
      "http://localhost/api/lodge/roster/2026-07-13/generate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choreTemplateIds: ["strip-beds", "dinner"] }),
      },
    );
    return POST(request as never, {
      params: Promise.resolve({ date: "2026-07-13" }),
    } as never);
  }

  it("AC3: a day whose only occupants are departing still generates a roster", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("booking-1", [guest("leaving", ["2026-07-11", "2026-07-12"])]),
    ]);
    mockPrisma.choreTemplate.findMany.mockResolvedValue(morningAndEveningTemplates());

    const response = await generate();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.guests.map((entry: { id: string }) => entry.id)).toEqual(["leaving"]);
    expect(body.guests[0]).toMatchObject({ isDeparting: true, isArriving: false });
    // AC4: morning work yes, evening work no.
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toMatchObject({
      choreTemplateId: "strip-beds",
      bookingGuestId: "leaving",
    });
  });

  it("MUTATION PROBE: the route loads the night rows through the shared selector", async () => {
    // The deleted duplicate loaded none, so a sparse gap day looked like
    // presence. Anything that re-grows a local query without `nights` fails.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("booking-1", [guest("sparse", ["2026-07-11", "2026-07-14"])]),
    ]);
    mockPrisma.choreTemplate.findMany.mockResolvedValue(morningAndEveningTemplates());

    const response = await generate();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.guests).toEqual([]);
    expect(body.allocations).toEqual([]);
    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      where: { checkOut: unknown; deletedAt: null };
      include: { guests: { include: { nights: unknown } } };
    };
    expect(args.where.checkOut).toEqual({ gte: DATE });
    expect(args.where.deletedAt).toBeNull();
    expect(args.include.guests.include.nights).toEqual({
      select: { stayDate: true },
    });
  });

  it("AC6: generating a preview writes nothing", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("booking-1", [guest("leaving", ["2026-07-11", "2026-07-12"])]),
    ]);
    mockPrisma.choreTemplate.findMany.mockResolvedValue(morningAndEveningTemplates());

    await generate();
    expect(mockPrisma.choreAssignment.createMany).not.toHaveBeenCalled();
  });

  it("PRIVACY: the kiosk response never carries the booking-owner label", async () => {
    // The shared selector adds `bookingGroupLabel` ("Booking for Bev Booker")
    // for the ADMIN roster editor. This endpoint answers a shared hut-leader PIN
    // session, the owner need not be staying, and the duplicate query this route
    // replaced never exposed it. Anything that returns the selector rows
    // wholesale — now or later — fails here.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("booking-1", [guest("leaving", ["2026-07-11", "2026-07-12"])]),
    ]);
    mockPrisma.choreTemplate.findMany.mockResolvedValue(morningAndEveningTemplates());

    const response = await generate();
    const raw = await response.text();
    expect(raw).not.toContain("bookingGroupLabel");
    expect(raw).not.toContain("Booking for");
    expect(raw).not.toContain("Ana"); // the booking OWNER, who need not be staying

    const body = JSON.parse(raw);
    expect(Object.keys(body.guests[0]).sort()).toEqual([
      "ageTier",
      "bookingId",
      "firstName",
      "isArriving",
      "isDeparting",
      "id",
      "lastName",
    ].sort());
  });
});

describe("hut-leader roster wizard reaches the generate step (#2622)", () => {
  // The wizard's step 1 reads `/api/lodge/guests/[date]`; its `totalGuests`
  // gates the Next button. That route used to answer the night model by
  // default, so on an all-departing morning it returned nobody and the wizard
  // dead-ended before the (already converted) generate route could run. #2622
  // unblocked it with a `?scope=lodge-list` parameter; #2631 removed the
  // parameter by giving the route one operational-day answer.
  //
  // SOURCE CONTRACT (#2631): the kiosk and the roster setup wizard must ask the
  // guests route the SAME question. They are the two screens whose "Departing"
  // badges meant opposite days, and nothing at runtime can see them disagree —
  // they are separate pages that are never rendered together. If one of them
  // ever grows a scope parameter, or stops calling the shared route, this
  // fails.
  it("the kiosk and the setup page ask the guests route the same question", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (relative: string) =>
      fs.readFileSync(path.join(process.cwd(), relative), "utf8");

    const setup = read("src/app/(lodge)/lodge/roster/[date]/setup/page.tsx");
    const kiosk = read("src/app/(lodge)/lodge/kiosk/page.tsx");

    expect(setup).toContain("`/api/lodge/guests/${dateStr}`");
    expect(kiosk).toContain("`/api/lodge/guests/${date}`");
    for (const [name, source] of [
      ["setup page", setup],
      ["kiosk", kiosk],
    ] as const) {
      // No scope parameter on either side, ever again.
      expect(source, name).not.toMatch(/api\/lodge\/guests\/\$\{[^}]+\}\?/);
      expect(source, name).not.toContain("scope=");
    }
  });

  it("the unified scope returns the departing guest and a non-zero count", async () => {
    vi.clearAllMocks();
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "hut-leader" });
    lodgeAuthMocks.resolveKioskLodgeId.mockResolvedValue("lodge-1");
    // An all-departing morning: the booking's only guest checks out on the 13th.
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: day("2026-07-11"),
        checkOut: DATE,
        member: { firstName: "Bev", lastName: "Booker" },
        guests: [
          {
            id: "leaving",
            firstName: "Lee",
            lastName: "Leaver",
            ageTier: "ADULT",
            isMember: false,
            arrivedAt: null,
            departedAt: null,
            stayStart: day("2026-07-11"),
            stayEnd: DATE,
            member: null,
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const response = await GET(
      new Request("http://localhost/api/lodge/guests/2026-07-13") as never,
      { params: Promise.resolve({ date: "2026-07-13" }) } as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalGuests).toBe(1);
    expect(body.bookings[0].guests[0]).toMatchObject({
      id: "leaving",
      isDeparting: true,
      isArriving: false,
    });
  });

  it("a sparse stay shows nobody on its gap day, and both flags on each segment", async () => {
    // THE NIGHTS REGRESSION TRAP (#2631). Nights {11, 14}: the guest is here on
    // the 11th and 12th, away on the 13th, back on the 14th and 15th. The
    // coarse SQL bound returns the row on every one of those dates, so if the
    // route ever stops loading `nights` the envelope 11→15 fills the gap and
    // the kiosk shows a guest who is not in the building.
    const sparseGuest = {
      id: "sparse",
      firstName: "Sam",
      lastName: "Sparse",
      ageTier: "ADULT",
      isMember: false,
      arrivedAt: null,
      departedAt: null,
      stayStart: day("2026-07-11"),
      stayEnd: day("2026-07-15"),
      member: null,
      nights: [{ stayDate: day("2026-07-11") }, { stayDate: day("2026-07-14") }],
    };

    async function guestsOn(date: string) {
      vi.clearAllMocks();
      lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "hut-leader" });
      lodgeAuthMocks.resolveKioskLodgeId.mockResolvedValue("lodge-1");
      // The mock HONOURS the include, the way Prisma does: drop the `nights`
      // load from the route and the rows come back without night data, the
      // envelope takes over and the gap day fills in. A mock that always
      // returned the nights would pass with the regression in place.
      mockPrisma.booking.findMany.mockImplementation(async (args: never) => {
        const { include } = args as unknown as {
          include?: { guests?: { include?: { nights?: unknown } } };
        };
        const loadsNights = Boolean(include?.guests?.include?.nights);
        const { nights, ...withoutNights } = sparseGuest;
        return [
          {
            id: "booking-1",
            checkIn: day("2026-07-11"),
            checkOut: day("2026-07-15"),
            member: { firstName: "Bev", lastName: "Booker" },
            guests: [loadsNights ? { ...withoutNights, nights } : withoutNights],
          },
        ];
      });
      const { GET } = await import("@/app/api/lodge/guests/[date]/route");
      const response = await GET(
        new Request(`http://localhost/api/lodge/guests/${date}`) as never,
        { params: Promise.resolve({ date }) } as never,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      return body.bookings[0]?.guests[0] ?? null;
    }

    expect(await guestsOn("2026-07-11")).toMatchObject({
      isArriving: true,
      isDeparting: false,
    });
    expect(await guestsOn("2026-07-12")).toMatchObject({
      isArriving: false,
      isDeparting: true,
    });
    // The gap day: nobody at all, and therefore no booking card either.
    expect(await guestsOn("2026-07-13")).toBeNull();
    expect(await guestsOn("2026-07-14")).toMatchObject({
      isArriving: true,
      isDeparting: false,
    });
    expect(await guestsOn("2026-07-15")).toMatchObject({
      isArriving: false,
      isDeparting: true,
    });
  });
});
