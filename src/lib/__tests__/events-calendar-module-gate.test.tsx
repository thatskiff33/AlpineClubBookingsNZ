import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The events-calendar gate (#2241) — two independent rules over one surface:
 *
 *  1. the `eventsCalendar` module, so a club can switch the calendar off; and
 *  2. organisation ("ORG") accounts, who never see the calendar at all.
 *
 * Route-prefix gating lives in `src/config/__tests__/feature-routes.test.ts`.
 * This file covers what the proxy CANNOT: the page guards themselves and the
 * member dashboard.
 *
 * Rule 2 is load-bearing, not decoration: the proxy's feature-route gate
 * enforces the module flag ALONE — `FEATURE_ROUTE_RULES` lists route prefixes
 * and never reads the account type — so the `notFound()` asserted here for an
 * ORG account is the only thing standing in front of the calendar for one.
 *
 * `@/lib/calendar-access` is deliberately NOT mocked: the ORG rule under test
 * lives inside it, so mocking it would assert the harness rather than the gate.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  moduleFlags: {} as Record<string, boolean>,
  calendarEventFindMany: vi.fn(),
  committeeAssignmentFindFirst: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingFindMany: vi.fn(),
  lockerFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
}));

class NotFoundError extends Error {}
class RedirectError extends Error {}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new RedirectError(`NEXT_REDIRECT:${to}`);
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => mocks.session),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => mocks.moduleFlags),
}));

vi.mock("@/components/calendar/calendar-view", () => ({
  CalendarView: () => null,
}));

vi.mock("@/components/recent-news-card", () => ({
  RecentNewsCard: () => null,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: mocks.bookingFindFirst,
      findMany: mocks.bookingFindMany,
    },
    locker: { findMany: mocks.lockerFindMany },
    member: { findUnique: mocks.memberFindUnique },
    calendarEvent: { findMany: mocks.calendarEventFindMany },
    committeeAssignment: { findFirst: mocks.committeeAssignmentFindFirst },
  },
}));

vi.mock("@/lib/hut-leader", () => ({
  isHutLeader: vi.fn(async () => false),
}));

vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn(async () => 0),
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/promo", () => ({
  getAvailablePromoCodesForMember: vi.fn(async () => []),
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacity: vi.fn(async () => ({ minAvailable: 0, nightDetails: [] })),
}));

import MemberCalendarPage from "@/app/(authenticated)/calendar/page";
import AdminCalendarPage from "@/app/(admin)/admin/calendar/page";
import DashboardPage from "@/app/(authenticated)/dashboard/page";
import {
  canEditCalendarEvents,
  canManageCalendarEvents,
  canViewCalendarEvents,
} from "@/lib/calendar-access";

const MEMBER_SESSION = {
  user: {
    id: "member-1",
    name: "Ada Lovelace",
    role: "USER",
    accessRoles: ["USER"],
  },
};

/** An organisation account: the ORG access-role token, legacy role SCHOOL. */
const ORG_SESSION = {
  user: {
    id: "org-1",
    name: "Kaimai High School",
    role: "SCHOOL",
    accessRoles: ["ORG"],
  },
};

const LODGE_EDIT_MATRIX = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "edit",
  content: "none",
  support: "none",
} as const;

/** Every `href` prop anywhere in a rendered element tree (no DOM required). */
function collectHrefs(node: ReactNode, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  const props = (node as ReactElement).props as Record<string, unknown>;
  if (typeof props.href === "string") found.push(props.href);
  collectHrefs(props.children as ReactNode, found);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = MEMBER_SESSION;
  mocks.moduleFlags = { eventsCalendar: true };
  mocks.bookingFindFirst.mockResolvedValue(null);
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.lockerFindMany.mockResolvedValue([]);
  mocks.memberFindUnique.mockResolvedValue(null);
  mocks.calendarEventFindMany.mockResolvedValue([]);
  mocks.committeeAssignmentFindFirst.mockResolvedValue(null);
});

describe("calendar pages 404 when the eventsCalendar module is off", () => {
  it("member /calendar calls notFound()", async () => {
    mocks.moduleFlags = { eventsCalendar: false };
    await expect(MemberCalendarPage()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("admin /admin/calendar calls notFound()", async () => {
    mocks.moduleFlags = { eventsCalendar: false };
    await expect(AdminCalendarPage()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("both pages render when the module is on", async () => {
    await expect(MemberCalendarPage()).resolves.toBeTruthy();
    await expect(AdminCalendarPage()).resolves.toBeTruthy();
  });
});

describe("organisation accounts never see the calendar", () => {
  it("member /calendar calls notFound() for an ORG account, module on", async () => {
    mocks.session = ORG_SESSION;
    await expect(MemberCalendarPage()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("admin /admin/calendar calls notFound() for an ORG account", async () => {
    mocks.session = ORG_SESSION;
    await expect(AdminCalendarPage()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("excludes a legacy SCHOOL account whose ORG token was cleared", async () => {
    // canLogin=false collapses the access-role tokens to [], so the legacy
    // `role` column is the only thing left that says "organisation".
    mocks.session = {
      user: { id: "org-2", name: "Old School", role: "SCHOOL", accessRoles: [] },
    };
    await expect(MemberCalendarPage()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("still admits an ordinary member and a lodge-edit admin", async () => {
    await expect(MemberCalendarPage()).resolves.toBeTruthy();

    mocks.session = {
      user: {
        id: "admin-1",
        name: "Grace Hopper",
        role: "ADMIN",
        accessRoles: ["ADMIN"],
        adminPermissionMatrix: LODGE_EDIT_MATRIX,
      },
    };
    await expect(MemberCalendarPage()).resolves.toBeTruthy();
    await expect(AdminCalendarPage()).resolves.toBeTruthy();
  });
});

describe("canViewCalendarEvents drives every calendar write gate too", () => {
  it("refuses an ORG account that also holds an active committee assignment", async () => {
    // Without the view check inside canManageCalendarEvents, the committee leg
    // would hand an organisation account CREATE authority on the calendar.
    mocks.committeeAssignmentFindFirst.mockResolvedValue({ id: "ca-1" });

    expect(canViewCalendarEvents(ORG_SESSION.user)).toBe(false);
    await expect(canManageCalendarEvents(ORG_SESSION.user)).resolves.toBe(false);
    // The committee table is not even consulted: the refusal is decided first.
    expect(mocks.committeeAssignmentFindFirst).not.toHaveBeenCalled();

    // The same member without the ORG token does pass the committee leg.
    await expect(
      canManageCalendarEvents({ ...ORG_SESSION.user, role: "USER", accessRoles: ["USER"] }),
    ).resolves.toBe(true);
  });

  it("refuses edit/delete for an ORG account even with lodge:edit", () => {
    expect(
      canEditCalendarEvents({
        ...ORG_SESSION.user,
        adminPermissionMatrix: LODGE_EDIT_MATRIX,
      }),
    ).toBe(false);
    expect(
      canEditCalendarEvents({
        role: "ADMIN",
        accessRoles: ["ADMIN"],
        adminPermissionMatrix: LODGE_EDIT_MATRIX,
      }),
    ).toBe(true);
  });
});

describe("member dashboard respects both calendar rules", () => {
  it("neither queries calendarEvent nor links the Events card when the module is off", async () => {
    mocks.moduleFlags = { eventsCalendar: false };

    const tree = await DashboardPage();

    // No query for a surface the proxy 404s: the dashboard must not read the
    // calendar table at all when the module is off.
    expect(mocks.calendarEventFindMany).not.toHaveBeenCalled();
    expect(collectHrefs(tree)).not.toContain("/calendar");
  });

  it("neither queries calendarEvent nor links the Events card for an ORG account", async () => {
    mocks.session = ORG_SESSION;

    const tree = await DashboardPage();

    expect(mocks.calendarEventFindMany).not.toHaveBeenCalled();
    expect(collectHrefs(tree)).not.toContain("/calendar");
  });

  it("queries calendarEvent and renders the Events card for a member with the module on", async () => {
    const tree = await DashboardPage();

    expect(mocks.calendarEventFindMany).toHaveBeenCalledTimes(1);
    expect(collectHrefs(tree)).toContain("/calendar");
  });
});
