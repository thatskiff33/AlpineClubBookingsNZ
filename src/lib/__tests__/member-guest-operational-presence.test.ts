import { beforeEach, describe, expect, it, vi } from "vitest";

// "+ Add Member Guest" (epic #2305) MG2 (#2307) — owner decision D-12.
//
// A member guest whose consent is still PENDING holds a bed (D-4) and NOTHING
// else. They are not operationally present: no row on the kiosk arrivals list,
// no chore, no bed placement, no name in an arrival email, no line on the wall,
// and no candidacy for hut leader. A DECLINED or EXPIRED row that survived its
// removal attempt (it goes to the admin exception list instead) is not an
// occupant either.
//
// Fifteen call sites across ten surfaces enforce that. This file covers the
// route-and-cron surfaces that share one prisma-mock harness; the rest are
// pinned in the test file that already owns their surface:
//   * lodge-display-state.test.ts        — the wall, plus the privacy threshold
//   * cron-pre-arrival-reminders.test.ts — the headcount in the reminder
//   * placeholder-guest-name-reminders.test.ts — the headcount in the #2550
//     whole-lodge guest-name reminder
//   * notification-preference-gating.test.ts — the names in the check-in reminder
//   * double-bed-sharing.test.ts         — both halves of the candidate sweep
//   * bed-allocation-lifecycle.test.ts / admin-bed-allocation.test.ts — beds
//   * admin-roster-regenerate.test.ts    — the admin chore roster choke point
//   * member-guest-consent.test.ts       — the predicate itself, incl. the NULL trap
//   * capacity.test.ts and friends       — the FREEZE side (D-4 still holds a bed)
//
// THE TRAP these tests exist to catch. The filter must be the explicit OR
// `[{ consentStatus: null }, { consentStatus: "CONFIRMED" }]`, never
// `{ consentStatus: { not: "PENDING" } }`. consentStatus is nullable and NULL is
// the dominant value forever — every non-member guest, every family-scope add,
// every row written before this feature existed — and in SQL `<> 'PENDING'` is
// UNKNOWN for NULL. The `not:` form therefore empties the kiosk, the roster and
// the arrival emails of every ordinary guest, while looking correct. Each case
// below asserts the null-consent guest is PRESENT for exactly that reason.

const PRESENT_OR = [{ consentStatus: null }, { consentStatus: "CONFIRMED" }];

const { mockPrisma, mockAuth, mockFlags, mockLookahead } = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findMany: vi.fn() },
    bookingGuest: { findFirst: vi.fn(), findMany: vi.fn() },
    choreTemplate: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn(), groupBy: vi.fn() },
    hutLeaderAssignment: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    member: { findUnique: vi.fn() },
    lodge: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockFlags: vi.fn(),
  mockLookahead: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: async () => {
    const session = await mockAuth();
    return session?.user?.id
      ? { ok: true, session }
      : { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  },
}));

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

// The hut-leader cron is a no-op unless its module flag is on, and it reads the
// club's lookahead. Neither is what these tests are about.
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: () => mockFlags(),
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadHutLeaderLookaheadDays: () => mockLookahead(),
}));
vi.mock("@/lib/email", () => ({
  sendHutLeaderAssignmentEmail: vi.fn().mockResolvedValue(undefined),
  sendChoreRosterEmail: vi.fn().mockResolvedValue(undefined),
  shouldSendChoreRoster: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(29),
  FALLBACK_LODGE_CAPACITY: 29,
}));

import {
  findLodgeGuestForDate,
  findLodgeGuestDepartingOnDate,
  validateRosterAllocationsForDate,
} from "@/lib/lodge-date-scoping";
import { nextRequest, routeParams } from "@/lib/__tests__/helpers/requests";

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * A booking whose overlapping guest list is filtered the way Prisma would filter
 * it, from the `where` the production code actually sent. Used where a test
 * asserts an OUTCOME rather than a query shape — a mock that ignored the `where`
 * would pass those tests with the filter deleted.
 */
function applyGuestWhere<T extends { consentStatus?: string | null }>(
  where: { OR?: Array<{ consentStatus: string | null }> } | undefined,
  guests: T[],
): T[] {
  if (!where?.OR) return guests;
  return guests.filter((guest) =>
    where.OR!.some((branch) => branch.consentStatus === (guest.consentStatus ?? null)),
  );
}

const ORDINARY = { consentStatus: null };
const AGREED = { consentStatus: "CONFIRMED" };
const AWAITING = { consentStatus: "PENDING" };

beforeEach(() => {
  vi.clearAllMocks();
  lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "lodge" });
  lodgeAuthMocks.resolveKioskLodgeId.mockResolvedValue("lodge-1");
  mockAuth.mockResolvedValue({
    user: {
      id: "admin-1",
      role: "ADMIN",
      accessRoles: [{ role: "ADMIN" }],
      email: "admin@example.org",
    },
  });
  mockPrisma.booking.findMany.mockResolvedValue([]);
  mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);
  mockPrisma.bookingGuest.findMany.mockResolvedValue([]);
  mockPrisma.choreTemplate.findMany.mockResolvedValue([]);
  mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
  mockPrisma.choreAssignment.groupBy.mockResolvedValue([]);
  mockPrisma.hutLeaderAssignment.findFirst.mockResolvedValue(null);
  mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
  mockPrisma.lodge.findFirst.mockResolvedValue({ id: "lodge-1" });
  mockFlags.mockResolvedValue({ hutLeaders: true });
  mockLookahead.mockResolvedValue(1);
});

// --- 1. Kiosk arrivals list -------------------------------------------------
describe("kiosk arrivals list (D-12)", () => {
  function guest(id: string, first: string, consent: { consentStatus: string | null }) {
    return {
      id,
      firstName: first,
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: true,
      arrivedAt: null,
      departedAt: null,
      member: null,
      stayStart: dateOnly("2026-07-10"),
      stayEnd: dateOnly("2026-07-12"),
      ...consent,
    };
  }

  async function callArrivals() {
    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    return GET(
      new Request(
        "http://localhost/api/lodge/guests/2026-07-10",
      ) as never,
      routeParams({ date: "2026-07-10" }),
    );
  }

  it("lists null- and CONFIRMED-consent guests and omits the PENDING one", async () => {
    mockPrisma.booking.findMany.mockImplementation(async (args: never) => {
      const typed = args as unknown as {
        include: { guests: { where?: { OR?: Array<{ consentStatus: string | null }> } } };
      };
      return [
        {
          id: "booking-1",
          checkIn: dateOnly("2026-07-10"),
          checkOut: dateOnly("2026-07-12"),
          requiresAdminReview: false,
          adminReviewStatus: null,
          member: { firstName: "Ada", lastName: "Booker" },
          guests: applyGuestWhere(typed.include.guests.where, [
            guest("g-ordinary", "Nula", ORDINARY),
            guest("g-agreed", "Connie", AGREED),
            guest("g-awaiting", "Penny", AWAITING),
          ]),
        },
      ];
    });

    const res = await callArrivals();
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.bookings[0].guests.map((g: { id: string }) => g.id)).toEqual([
      "g-ordinary",
      "g-agreed",
    ]);
    expect(data.totalGuests).toBe(2);
    expect(JSON.stringify(data)).not.toContain("Penny");
  });

  it("carries the predicate on BOTH the booking match and the guest include", async () => {
    await callArrivals();

    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      where: { guests: { some: { OR?: unknown } } };
      include: { guests: { where?: { OR?: unknown } } };
    };
    // Filter only the include and a booking whose sole overlapping guest is
    // pending still MATCHES, then renders as an empty card on the kiosk.
    expect(args.where.guests.some.OR).toEqual(PRESENT_OR);
    expect(args.include.guests.where?.OR).toEqual(PRESENT_OR);
  });

  it("drops the whole booking when its only overlapping guest is unconsented", async () => {
    // The `some` does this in production. Modelled here by returning nothing,
    // which is what a filtered `some` returns, and asserting the route does not
    // invent an empty card.
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const data = await (await callArrivals()).json();
    expect(data.bookings).toEqual([]);
    expect(data.totalGuests).toBe(0);
  });
});

// --- 2. Kiosk arrive / depart / roster-confirm ENFORCEMENT -------------------
describe("kiosk arrive/depart/roster-confirm enforcement (D-12)", () => {
  it("the arrive lookup refuses an unconsented guest", async () => {
    await findLodgeGuestForDate("guest-1", dateOnly("2026-07-10"), "lodge-1");

    const args = mockPrisma.bookingGuest.findFirst.mock.calls[0][0] as {
      where: { OR?: unknown };
    };
    // The guest resolves to null, so the arrive endpoint 404s — exactly the way
    // a review-blocked guest already does (#1422). Display and enforcement have
    // to agree, or the list hides them while the endpoint still checks them in.
    expect(args.where.OR).toEqual(PRESENT_OR);
  });

  it("the depart lookup refuses an unconsented guest", async () => {
    await findLodgeGuestDepartingOnDate("guest-1", dateOnly("2026-07-12"), "lodge-1");

    const args = mockPrisma.bookingGuest.findFirst.mock.calls[0][0] as {
      where: { OR?: unknown };
    };
    expect(args.where.OR).toEqual(PRESENT_OR);
  });

  it("roster-confirm validation refuses an allocation naming an unconsented guest", async () => {
    const ok = await validateRosterAllocationsForDate(
      [{ bookingGuestId: "guest-1", bookingId: "booking-1" }],
      dateOnly("2026-07-10"),
    );

    // Nothing came back for that id, so the allocation set does not validate.
    expect(ok).toBe(false);
    const args = mockPrisma.bookingGuest.findMany.mock.calls[0][0] as {
      where: { OR?: unknown };
    };
    expect(args.where.OR).toEqual(PRESENT_OR);
  });

  it("still resolves a null-consent guest (the NULL trap)", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Nula",
      lastName: "Ordinary",
      memberId: null,
      arrivedAt: null,
      departedAt: null,
      booking: { memberId: "member-1" },
    });

    const found = await findLodgeGuestForDate("guest-1", dateOnly("2026-07-10"));
    expect(found?.id).toBe("guest-1");
    // The predicate that let them through admits NULL explicitly.
    const args = mockPrisma.bookingGuest.findFirst.mock.calls[0][0] as {
      where: { OR: Array<{ consentStatus: string | null }> };
    };
    expect(args.where.OR[0]).toEqual({ consentStatus: null });
  });
});

// --- 3. Kiosk chore roster generate (shares the admin selector since #2622) --
describe("kiosk roster generate (D-12)", () => {
  it("carries the predicate on both the booking match and the guest include", async () => {
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "hut-leader" });
    const { POST } = await import("@/app/api/lodge/roster/[date]/generate/route");

    const res = await POST(
      new Request("http://localhost/api/lodge/roster/2026-07-10/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choreTemplateIds: ["chore-1"] }),
      }) as never,
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(200);
    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      where: { guests: { some: { OR?: unknown } } };
      include: { guests: { where?: { OR?: unknown } } };
    };
    // An independent copy of the admin service's query: a guest kept off the
    // admin roster would otherwise still be given a chore from the kiosk.
    expect(args.where.guests.some.OR).toEqual(PRESENT_OR);
    expect(args.include.guests.where?.OR).toEqual(PRESENT_OR);
  });
});

// --- 4. Chore print sheet ---------------------------------------------------
describe("chore roster print sheet (D-12)", () => {
  it("excludes unconsented guests and counts only the rest", async () => {
    mockPrisma.booking.findMany.mockImplementation(async (args: never) => {
      const typed = args as unknown as {
        include: { guests: { where?: { OR?: Array<{ consentStatus: string | null }> } } };
      };
      return [
        {
          id: "booking-1",
          checkIn: dateOnly("2026-07-10"),
          checkOut: dateOnly("2026-07-12"),
          guests: applyGuestWhere(typed.include.guests.where, [
            { id: "g-ordinary", stayStart: dateOnly("2026-07-10"), stayEnd: dateOnly("2026-07-12"), nights: [], ...ORDINARY },
            { id: "g-agreed", stayStart: dateOnly("2026-07-10"), stayEnd: dateOnly("2026-07-12"), nights: [], ...AGREED },
            { id: "g-awaiting", stayStart: dateOnly("2026-07-10"), stayEnd: dateOnly("2026-07-12"), nights: [], ...AWAITING },
          ]),
        },
      ];
    });

    const { GET } = await import("@/app/api/chores/roster/[date]/print/route");
    // A real NextRequest: the route reads `?lodgeId=` off `nextUrl` to scope
    // the sheet to one lodge (#2478), which a bare `Request` does not carry.
    const res = await GET(
      nextRequest("/api/chores/roster/2026-07-10/print"),
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    // The sheet's headcount is the OPERATIONAL number a leader reads off the
    // wall — two people, not three. It is not a capacity number: the pending
    // guest still holds a bed under D-4, which capacity.ts still counts.
    expect(data.guestCount).toBe(2);

    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      where: { guests: { some: { OR?: unknown } } };
      include: { guests: { where?: { OR?: unknown } } };
    };
    expect(args.where.guests.some.OR).toEqual(PRESENT_OR);
    expect(args.include.guests.where?.OR).toEqual(PRESENT_OR);
  });
});

// --- 5. Lodge week summary --------------------------------------------------
describe("lodge week summary (D-12)", () => {
  it("counts staying/arriving/departing from consented guests only", async () => {
    mockPrisma.booking.findMany.mockImplementation(async (args: never) => {
      const typed = args as unknown as {
        select: { guests: { where?: { OR?: Array<{ consentStatus: string | null }> } } };
      };
      return [
        {
          id: "booking-1",
          checkIn: dateOnly("2026-07-10"),
          checkOut: dateOnly("2026-07-12"),
          guests: applyGuestWhere(typed.select.guests.where, [
            { stayStart: dateOnly("2026-07-10"), stayEnd: dateOnly("2026-07-12"), ageTier: "ADULT", nights: [], ...ORDINARY },
            { stayStart: dateOnly("2026-07-10"), stayEnd: dateOnly("2026-07-12"), ageTier: "ADULT", nights: [], ...AGREED },
            { stayStart: dateOnly("2026-07-10"), stayEnd: dateOnly("2026-07-12"), ageTier: "ADULT", nights: [], ...AWAITING },
          ]),
        },
      ];
    });

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/week/route");
    const res = await GET(
      new NextRequest("http://localhost/api/lodge/week?start=2026-07-10"),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    const firstDay = data.days.find(
      (day: { date: string }) => day.date === "2026-07-10",
    );
    expect(firstDay.guestCount).toBe(2);
    expect(firstDay.arrivingCount).toBe(2);

    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      where: { guests: { some: { OR?: unknown } } };
      select: { guests: { where?: { OR?: unknown } } };
    };
    expect(args.where.guests.some.OR).toEqual(PRESENT_OR);
    expect(args.select.guests.where?.OR).toEqual(PRESENT_OR);

    const assignmentArgs = mockPrisma.choreAssignment.findMany.mock.calls[0][0] as {
      where: { booking?: unknown; choreTemplate?: unknown };
    };
    expect(assignmentArgs.where.booking).toEqual({ lodgeId: "lodge-1" });
    expect(assignmentArgs.where.choreTemplate).toEqual({ lodgeId: "lodge-1" });
  });
});

describe("lodge roster supporting reads stay inside the kiosk lodge", () => {
  it("scopes frequency history through both booking and template attribution", async () => {
    const { NextRequest } = await import("next/server");
    const { GET } = await import(
      "@/app/api/lodge/roster/[date]/frequency-info/route"
    );

    const res = await GET(
      new NextRequest("http://localhost/api/lodge/roster/2026-07-10/frequency-info"),
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.choreAssignment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: { lodgeId: "lodge-1" },
          choreTemplate: { lodgeId: "lodge-1" },
        }),
      }),
    );
  });

  it("scopes generation history through both booking and template attribution", async () => {
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "hut-leader" });
    const { NextRequest } = await import("next/server");
    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/generate/route"
    );

    const res = await POST(
      new NextRequest("http://localhost/api/lodge/roster/2026-07-10/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choreTemplateIds: ["kitchen"] }),
      }),
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.choreAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: { lodgeId: "lodge-1" },
          choreTemplate: { lodgeId: "lodge-1" },
        }),
      }),
    );
  });
});

// --- 6. Hut leader auto-assign (cron) ---------------------------------------
describe("hut leader auto-assign (D-12)", () => {
  it("never auto-assigns off an unconsented guest row", async () => {
    // This job assigns ONLY when exactly one adult member is staying. Anna is
    // consented, Penny is pending: with Penny counted the job sees two adults
    // and assigns nobody, so leaving her in would change the outcome for Anna.
    mockPrisma.booking.findMany.mockImplementation(async (args: never) => {
      const typed = args as unknown as {
        select: { guests: { where?: { OR?: Array<{ consentStatus: string | null }> } } };
      };
      return [
        {
          lodgeId: "lodge-1",
          guests: applyGuestWhere(typed.select.guests.where, [
            {
              memberId: "m-anna",
              stayStart: dateOnly("2026-07-10"),
              stayEnd: dateOnly("2026-07-12"),
              member: { id: "m-anna", firstName: "Anna", lastName: "Adult", active: true },
              ...ORDINARY,
            },
            {
              memberId: "m-penny",
              stayStart: dateOnly("2026-07-10"),
              stayEnd: dateOnly("2026-07-12"),
              member: { id: "m-penny", firstName: "Penny", lastName: "Awaiting", active: true },
              ...AWAITING,
            },
          ]),
        },
      ];
    });
    mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "assignment-1" });

    const { autoAssignHutLeaders } = await import(
      "@/lib/cron-hut-leader-auto-assign"
    );
    await autoAssignHutLeaders();

    // Exactly one adult member remains — Anna — so she is the one assigned, and
    // never Penny.
    const created = mockPrisma.hutLeaderAssignment.create.mock.calls;
    expect(created.length).toBeGreaterThan(0);
    for (const [call] of created) {
      expect((call as { data: { memberId: string } }).data.memberId).toBe("m-anna");
    }

    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      where: { guests: { some: { OR?: unknown } } };
      select: { guests: { where?: { OR?: unknown } } };
    };
    expect(args.where.guests.some.OR).toEqual(PRESENT_OR);
    expect(args.select.guests.where?.OR).toEqual(PRESENT_OR);
  });
});

// --- 7. Hut leader admin picker --------------------------------------------
describe("hut leader eligible-members picker (D-12)", () => {
  it("does not offer a member whose guest row is unconsented", async () => {
    const { GET } = await import(
      "@/app/api/admin/hut-leaders/eligible-members/route"
    );
    const res = await GET(
      new Request(
        "http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-07-10&endDate=2026-07-12",
      ) as never,
    );

    expect(res.status).toBe(200);
    const args = mockPrisma.bookingGuest.findMany.mock.calls[0][0] as {
      where: { OR?: unknown };
    };
    expect(args.where.OR).toEqual(PRESENT_OR);
  });
});

// --- The trap, asserted structurally across every site ----------------------
describe("no site uses the NULL-hostile `not: PENDING` form", () => {
  it("every call site spreads the shared OR predicate", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");

    // Every file this work package filtered. Each must import the shared
    // predicate rather than hand-rolling one, and none may use the `not:` form
    // that is UNKNOWN for the NULL rows that are the overwhelming majority.
    const FILTERED_FILES = [
      "src/app/api/lodge/guests/[date]/route.ts",
      "src/lib/lodge-date-scoping.ts",
      // #2622: `admin-roster-service.ts` and the kiosk generate route used to
      // carry one copy of this predicate each. They are now one shared chore-
      // eligibility selector, so the predicate is asserted where it lives.
      "src/lib/roster-eligibility.ts",
      // #2631: the roster calendar and the dashboard's needs-roster headline
      // used to be consent-BLIND, so a day could paint "needs roster" and open
      // empty. Both DB entry points in roster-status now carry the predicate.
      "src/lib/roster-status.ts",
      "src/lib/bed-allocation-lifecycle.ts",
      "src/lib/admin-bed-allocation.ts",
      "src/lib/cron-hut-leader-auto-assign.ts",
      "src/app/api/admin/hut-leaders/eligible-members/route.ts",
      "src/lib/cron-pre-arrival-reminders.ts",
      "src/lib/cron-checkin-reminders.ts",
      "src/lib/lodge-display-state.ts",
      "src/app/api/lodge/week/route.ts",
      "src/lib/double-bed-sharing.ts",
    ];

    for (const relativePath of FILTERED_FILES) {
      const source = readFileSync(
        path.resolve(process.cwd(), relativePath),
        "utf8",
      );
      expect(
        source,
        `${relativePath} must use the shared operational-presence predicate`,
      ).toMatch(
        /OPERATIONALLY_PRESENT_GUEST_WHERE|isOperationallyPresentConsent/,
      );
      expect(
        source.replace(/\s+/g, " "),
        `${relativePath} must not filter consent by hand — the not: form is UNKNOWN for NULL`,
      ).not.toMatch(/consentStatus: \{ not:/);
    }
  });

  it("the printed chore sheet inherits the predicate from the shared selector (#2631)", async () => {
    // This route used to carry its own copy of the consent filter. It now has
    // no booking query of its own at all: its headcount is the roster's own
    // population, read through `getOperationalRosterGuestsForDate` (asserted
    // above). Keeping it in the list would demand a predicate that is correctly
    // no longer there, so the coverage moves here instead.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "src/app/api/chores/roster/[date]/print/route.ts",
      ),
      "utf8",
    );
    expect(source).toContain("getOperationalRosterGuestsForDate");
    expect(source).not.toMatch(/prisma\.booking\.findMany/);
    expect(source.replace(/\s+/g, " ")).not.toMatch(/consentStatus: \{ not:/);
  });
});
