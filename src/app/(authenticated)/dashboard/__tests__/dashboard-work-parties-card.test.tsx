import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard's Work Parties card gate (#5148, `showWorkPartiesCard`):
 * members only (`canViewWorkParties`, owner decision 7), and only while the
 * Work parties module is on. The card lists work party names, dates and
 * lodges, so an organisation account or a non-member login must never be
 * shown it, and a viewer who is not shown it costs no work-party read.
 *
 * The access-role helpers are the real ones here (the other dashboard suites
 * stub `hasAccessRole`), so the gate is decided exactly as in production.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingFindMany: vi.fn(),
  calendarEventFindMany: vi.fn(),
  getAvailablePromoCodesForMember: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  isHutLeader: vi.fn(),
  listUpcomingMemberWorkParties: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  lockerFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  memberInductionFindFirst: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: mocks.bookingFindFirst,
      findMany: mocks.bookingFindMany,
    },
    locker: { findMany: mocks.lockerFindMany },
    lodge: { count: vi.fn(async () => 1) },
    member: { findUnique: mocks.memberFindUnique },
    memberInduction: { findFirst: mocks.memberInductionFindFirst },
    calendarEvent: { findMany: mocks.calendarEventFindMany },
  },
}));

vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: mocks.getMemberCreditBalance,
  deriveBookingAppliedCreditCents: vi.fn(async () => 0),
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/promo", () => ({
  getAvailablePromoCodesForMember: mocks.getAvailablePromoCodesForMember,
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/hut-leader", () => ({ isHutLeader: mocks.isHutLeader }));

vi.mock("@/lib/capacity", () => ({ checkCapacity: vi.fn() }));

vi.mock("@/lib/work-party-member", () => ({
  listUpcomingMemberWorkParties: mocks.listUpcomingMemberWorkParties,
}));

import DashboardPage from "../page";

function moduleFlags(workParties: boolean, eventsCalendar = false) {
  return {
    eventsCalendar,
    kiosk: false,
    chores: false,
    financeDashboard: false,
    waitlist: false,
    xeroIntegration: false,
    bedAllocation: false,
    internetBankingPayments: false,
    addressAutocomplete: false,
    groupBookings: false,
    lockers: false,
    induction: false,
    workParties,
    promoCodes: false,
    hutLeaders: false,
    communications: false,
    skifieldConditions: false,
    skifieldWhakapapa: false,
    twoFactor: false,
    analytics: false,
  };
}

const WORK_PARTY = {
  id: "wp-1",
  name: "Spring working bee",
  description: null,
  startDate: "2026-07-10",
  endDate: "2026-07-12",
  discountPercent: 50,
  lodgeId: null,
  lodgeName: null,
  joinStay: null,
};

const MEMBER = { accessRoles: ["USER"], role: "USER", canLogin: true };

async function renderAs(user: Record<string, unknown>, workParties = true, eventsCalendar = false) {
  mocks.auth.mockResolvedValue({
    user: { id: "viewer-1", name: "Viewer One", ...user },
  });
  mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(workParties, eventsCalendar));
  return renderToStaticMarkup(await DashboardPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFindFirst.mockResolvedValue(null);
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.calendarEventFindMany.mockResolvedValue([]);
  mocks.getAvailablePromoCodesForMember.mockResolvedValue([]);
  mocks.getMemberCreditBalance.mockResolvedValue(0);
  mocks.isHutLeader.mockResolvedValue(false);
  mocks.listUpcomingMemberWorkParties.mockResolvedValue([WORK_PARTY]);
  mocks.lockerFindMany.mockResolvedValue([]);
  mocks.memberFindUnique.mockResolvedValue({ requiresInduction: false });
  mocks.memberInductionFindFirst.mockResolvedValue(null);
});

describe("DashboardPage Work Parties card gate", () => {
  it("shows a member the card, read for the club's today", async () => {
    const html = await renderAs(MEMBER);

    expect(html).toContain("Work Parties");
    expect(html).toContain("Spring working bee");
    expect(html).toContain('href="/dashboard/work-parties/wp-1"');
    expect(mocks.listUpcomingMemberWorkParties).toHaveBeenCalledTimes(1);
    // The suite clock is frozen at 2026-07-01T00:00Z, which is 1 July in the
    // club's zone; the read takes that club day as a date-only instant.
    const [today, take] = mocks.listUpcomingMemberWorkParties.mock.calls[0];
    expect((today as Date).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(take).toBe(5);
  });

  it.each([
    ["an organisation account", { accessRoles: ["ORG"], role: "USER", canLogin: true }],
    ["a legacy school login that also holds USER", { accessRoles: ["USER"], role: "SCHOOL", canLogin: true }],
    ["a non-member login", { accessRoles: [], role: "NON_MEMBER", canLogin: true }],
  ])("shows %s no card and reads no work party", async (_label, user) => {
    const html = await renderAs(user);

    expect(html).not.toContain("Work Parties");
    expect(html).not.toContain("Spring working bee");
    expect(mocks.listUpcomingMemberWorkParties).not.toHaveBeenCalled();
  });

  it("shows a member no card and reads no work party while the module is off", async () => {
    const html = await renderAs(MEMBER, false);

    expect(html).not.toContain("Work Parties");
    expect(mocks.listUpcomingMemberWorkParties).not.toHaveBeenCalled();
  });

  it("reads a non-member's Events card through the visibility rule with their own session, so no work-party entry is asked for", async () => {
    await renderAs({ accessRoles: [], role: "NON_MEMBER", canLogin: true }, true, true);

    expect(mocks.calendarEventFindMany).toHaveBeenCalledTimes(1);
    const [args] = mocks.calendarEventFindMany.mock.calls[0];
    expect((args as { where: { AND: unknown[] } }).where.AND).toEqual([{ workPartyEventId: null }]);
  });
});
