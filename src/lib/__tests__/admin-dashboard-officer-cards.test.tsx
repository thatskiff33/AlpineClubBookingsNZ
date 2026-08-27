import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The club-time delegate. `loadPersistedClubTimeSettings` returns `null`
    // when it is ABSENT, and the page then falls back to the environment — the
    // very defect CT-4 removes, silently, with nothing able to tell. Every test
    // here leaves it resolving `null`, which reproduces the no-row fallback and
    // keeps their expectations unchanged; the zone-authority test supplies a row.
    clubTimeSettings: { findUnique: vi.fn() },
    member: { count: vi.fn(), findUnique: vi.fn() },
    booking: { count: vi.fn(), findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
    bedAllocation: { findMany: vi.fn() },
    payment: { aggregate: vi.fn() },
    refundRequest: { count: vi.fn() },
    adminCreditAdjustmentRequest: { count: vi.fn() },
    membershipCancellationRequest: { count: vi.fn() },
    memberLifecycleActionRequest: { count: vi.fn() },
    deletionRequest: { count: vi.fn() },
    bookingChangeRequest: { count: vi.fn() },
    lodge: { count: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

// Partial mock: only the query is faked. coverageNeedsLodgeContext and
// coverageLodgeLabel are pure functions over the rows and the lodge count this
// suite supplies, so mocking them would only let the suite disagree with
// production about when a lodge name is shown (#2917).
vi.mock("@/lib/hut-leader-coverage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hut-leader-coverage")>()),
  getUnassignedHutLeaderDates: vi.fn(),
}));

import AdminDashboardPage from "@/app/(admin)/admin/dashboard/page";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { auth } from "@/lib/auth";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { prisma } from "@/lib/prisma";

/*
 * The club's day the fixtures below are built in (#3123). The dashboard takes
 * its own from `clubTime()` and `getUnassignedHutLeaderDates` from
 * `clubTodayDateOnlyInstant()`; this suite's `clubTimeSettings.findUnique`
 * resolves `null`, so both fall back to `APP_TIME_ZONE` — `Pacific/Auckland`
 * under test. The roster fixtures have to sit in the same zone as the window
 * they are counted against. Zone authority is not this file's subject.
 */
const CLUB_ZONE = "Pacific/Auckland";

// getStats booking.count call order (roster + bed counts no longer use
// booking.count — they now run through window-scoped helpers that findMany
// bookings + choreAssignments / bedAllocations): totalBookings, activeBookings,
// upcomingCheckIns, unpaidFinishedStays, unsettledAdditionalFinishedStays,
// pendingBookingReviews.
function mockStats() {
  vi.mocked(auth).mockResolvedValue({ user: { id: "admin-1" } } as any);
  vi.mocked(prisma.member.count)
    .mockResolvedValueOnce(50) // totalMembers
    .mockResolvedValueOnce(42) // activeMembers
    .mockResolvedValueOnce(8); // inactiveMembers
  vi.mocked(prisma.booking.count)
    .mockResolvedValueOnce(120) // totalBookings
    .mockResolvedValueOnce(15) // activeBookings
    .mockResolvedValueOnce(7) // upcomingCheckIns
    .mockResolvedValueOnce(0) // unpaidFinishedStays
    .mockResolvedValueOnce(0) // unsettledAdditionalFinishedStays
    .mockResolvedValueOnce(0); // pendingBookingReviews

  // The reworked officer-card counts compute over real fixtures so the headline
  // reconciles with each surface's own semantics (#2091 review). A single guest
  // stays THREE of the next seven nights with no chore assignment → 4 roster
  // days needing chores (#2631: the three nights plus the checkout morning,
  // when the beds get stripped and the kitchen shut down); three guests each
  // have an unallocated bed-night in the window → 3 guests awaiting a bed.
  //
  // #2628: BOTH helpers expand the canonical `BookingGuestNight` rows, not the
  // derived stayStart/stayEnd envelope, so every guest below carries the night
  // rows a real guest has. The envelope stays alongside them because it is what
  // the Prisma where-clauses select on, and because the two must agree for a
  // contiguous stay — which is the whole point of writing both out here.
  const today = getTodayDateOnly(CLUB_ZONE);
  const plus1 = addDaysDateOnly(today, 1);
  const plus2 = addDaysDateOnly(today, 2);
  const plus3 = addDaysDateOnly(today, 3);

  const rosterBookings = [
    {
      id: "rb1",
      checkIn: today,
      checkOut: plus3,
      guests: [
        {
          stayStart: today,
          stayEnd: plus3,
          ageTier: null,
          // The three nights the envelope [today, plus3) describes. This used to
          // be `[]`, which made the count come out right only by falling through
          // to the legacy envelope branch — the branch a guest with real night
          // rows never reaches — so the fixture agreed with the assertion while
          // exercising none of the code the roster card actually runs (#2628).
          nights: [{ stayDate: today }, { stayDate: plus1 }, { stayDate: plus2 }],
        },
      ],
    },
  ];
  const bedBookings = [
    // One night each (the envelope [today, plus1) is a single night), none of
    // them allocated below, so all three guests are awaiting a bed.
    {
      id: "bb1",
      guests: [
        {
          id: "g1",
          stayStart: today,
          stayEnd: plus1,
          nights: [{ stayDate: today }],
        },
        {
          id: "g2",
          stayStart: today,
          stayEnd: plus1,
          nights: [{ stayDate: today }],
        },
        {
          id: "g3",
          stayStart: today,
          stayEnd: plus1,
          nights: [{ stayDate: today }],
        },
      ],
    },
  ];

  // booking.findMany serves three callers; route by the where-clause each uses:
  // the bed helper is the only one filtering wholeLodgeHold, the roster helper
  // the only other one carrying a status set, and Recent Bookings carries
  // neither.
  vi.mocked(prisma.booking.findMany).mockImplementation((args: any) => {
    const where = args?.where ?? {};
    if (where.wholeLodgeHold === false) return Promise.resolve(bedBookings) as any;
    if (where.status) return Promise.resolve(rosterBookings) as any;
    return Promise.resolve([]) as any; // Recent Bookings
  });
  vi.mocked(prisma.choreAssignment.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.bedAllocation.findMany).mockResolvedValue([] as any);

  vi.mocked(prisma.payment.aggregate).mockResolvedValue({
    _sum: { amountCents: 123400 },
  } as any);
  vi.mocked(prisma.refundRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.adminCreditAdjustmentRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.membershipCancellationRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.memberLifecycleActionRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.deletionRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.bookingChangeRequest.count).mockResolvedValue(0);
  // A single-lodge club unless a test says otherwise: the Presentation Rule is
  // keyed on the club's active-lodge count (#2917 review), so this is what
  // decides whether the card names lodges at all.
  vi.mocked(prisma.lodge.count).mockResolvedValue(1);
  // Empty so the "assignment required" attention card stays hidden — this suite
  // isolates the officer key cards, and /admin/hut-leaders would otherwise also
  // be linked from that attention card.
  vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([]);
}

// Resolve the actor through the accessRoles-derivation path production actually
// uses (the dashboard's actor select carries accessRoles only — never an
// embedded adminPermissionMatrix), by attaching a definition-backed custom role
// whose per-area levels produce the requested matrix (#2091 review).
function mockActorMatrix(matrix: Partial<AdminPermissionMatrix>) {
  const roleDefinition = Object.fromEntries(
    Object.entries(matrix).map(([area, level]) => [
      `${area}Level`,
      level === "edit" ? "EDIT" : level === "view" ? "VIEW" : "NONE",
    ]),
  );
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    id: "admin-1",
    canLogin: true,
    accessRoles: [{ role: null, roleDefinition }],
  } as any);
}

describe("admin dashboard officer key cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue(null);
    mockStats();
  });

  it("renders all four officer cards with actionable counts for a full admin", async () => {
    mockActorMatrix({
      overview: "edit",
      bookings: "edit",
      membership: "edit",
      finance: "edit",
      lodge: "edit",
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    // Four officer surfaces linked from the primary row.
    expect(html).toContain('href="/admin/bookings?upcoming=7"');
    expect(html).toContain('href="/admin/hut-leaders"');
    expect(html).toContain('href="/admin/roster"');
    expect(html).toContain('href="/admin/bed-allocation"');

    // Officer-card-unique copy and headline counts.
    expect(html).toContain("checking in within 7 days");
    expect(html).toContain("Roster Assignment");
    // #2631: DAYS, not nights. A changeover morning whose guests all leave
    // before midday is a real day of chores and is counted here.
    expect(html).toContain("days in the next 7 days with no chores assigned");
    expect(html).toContain("Bed Allocation");
    expect(html).toContain("guests in the next 7 days awaiting a bed");
    expect(html).toContain(">7</div>"); // upcoming check-ins
    expect(html).toContain(">4</div>"); // roster days needing chores (#2631)
    expect(html).toContain(">3</div>"); // guests awaiting a bed

    // Slim secondary row keeps Members + Revenue.
    expect(html).toContain("Revenue This Month");
    expect(html).toContain("active of 50 total");
  });

  it("hides officer cards whose target page the actor cannot open", async () => {
    // Lodge-only officer: sees Hut Leader + Roster (lodge area), never the
    // Bookings / Bed Allocation cards (bookings area) or the Members / Revenue
    // secondary row (membership / finance areas).
    mockActorMatrix({ overview: "view", lodge: "edit" });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/hut-leaders"');
    expect(html).toContain("Roster Assignment");
    // Bookings-area officer cards are gone.
    expect(html).not.toContain('href="/admin/bed-allocation"');
    expect(html).not.toContain("Bed Allocation");
    expect(html).not.toContain('href="/admin/bookings?upcoming=7"');
    expect(html).not.toContain("checking in within 7 days");
    // Secondary row is entirely hidden.
    expect(html).not.toContain("Revenue This Month");
  });

  it("renders with no officer or secondary cards when the actor has no area access", async () => {
    mockActorMatrix({ overview: "view" });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    // Page still renders its shell and Recent Bookings without throwing.
    expect(html).toContain("Admin Dashboard");
    expect(html).toContain("Recent Bookings");
    expect(html).not.toContain("Roster Assignment");
    expect(html).not.toContain("Bed Allocation");
    expect(html).not.toContain("checking in within 7 days");
    expect(html).not.toContain("Revenue This Month");
  });
});

/**
 * The officer-facing half of #2917: the coverage result is now one row per
 * uncovered LODGE-night, and the card has to be readable for both club shapes.
 */
describe("admin dashboard hut-leader coverage card", () => {
  function uncoveredLodgeNight(
    date: string,
    lodgeId: string,
    lodgeName: string,
    lodgeActive = true,
  ) {
    return {
      date,
      lodgeId,
      lodgeName,
      lodgeActive,
      bookingCount: 1,
      guestCount: 2,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue(null);
    mockStats();
    mockActorMatrix({ overview: "view" });
  });

  it("names each lodge and counts lodge-nights when two lodges are uncovered on one night", async () => {
    vi.mocked(prisma.lodge.count).mockResolvedValue(2);
    vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([
      uncoveredLodgeNight("2026-07-05", "lodge-a", "Alpine Lodge"),
      uncoveredLodgeNight("2026-07-05", "lodge-b", "Basin Lodge"),
    ]);

    const html = renderToStaticMarkup(await AdminDashboardPage());

    // One night, two lodges, two pieces of work — and the officer is told
    // where to send someone rather than just how many.
    expect(html).toContain("2 upcoming lodge-nights");
    expect(html).toContain("2026-07-05 (Alpine Lodge), 2026-07-05 (Basin Lodge)");
  });

  it("STILL NAMES THE LODGE ON A MULTI-LODGE CLUB WHOSE GAPS ALL SIT AT ONE LODGE", async () => {
    // Three active lodges; Basin and Ridge are covered for the whole lookahead,
    // so every row is Alpine's. Keying the label on the result would print bare
    // dates here — the rejected Option B outcome — and would flip the wording the
    // moment Basin lost cover (#2917 review). It is keyed on the club instead.
    vi.mocked(prisma.lodge.count).mockResolvedValue(3);
    vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([
      uncoveredLodgeNight("2026-07-05", "lodge-a", "Alpine Lodge"),
      uncoveredLodgeNight("2026-07-06", "lodge-a", "Alpine Lodge"),
    ]);

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain("2 upcoming lodge-nights");
    expect(html).toContain("2026-07-05 (Alpine Lodge), 2026-07-06 (Alpine Lodge)");
  });

  it("marks a night at an ARCHIVED lodge, even on a club with one active lodge", async () => {
    // The lodge was deactivated with `force` while it still had future bookings,
    // so its guests still arrive and still need a leader — and the workspace's
    // lodge selector cannot offer it, which is why the label says so.
    vi.mocked(prisma.lodge.count).mockResolvedValue(1);
    vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([
      uncoveredLodgeNight("2026-07-05", "lodge-b", "Basin Lodge", false),
    ]);

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain("2026-07-05 (Basin Lodge, archived)");
  });

  it("shows a single-lodge club the bare dates and the plain wording it saw before", async () => {
    vi.mocked(prisma.lodge.count).mockResolvedValue(1);
    vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([
      uncoveredLodgeNight("2026-07-05", "lodge-a", "Alpine Lodge"),
      uncoveredLodgeNight("2026-07-06", "lodge-a", "Alpine Lodge"),
    ]);

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain("2 upcoming dates");
    expect(html).toContain("2026-07-05, 2026-07-06");
    // ADR-002 Presentation Rule: a club with one lodge is never shown a lodge
    // name it cannot act on, and never the multi-lodge noun.
    expect(html).not.toContain("Alpine Lodge");
    expect(html).not.toContain("lodge-night");
  });
});
