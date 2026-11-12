import { beforeEach, describe, expect, it, vi } from "vitest";

import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

/**
 * Fork #121: the food-order access rules, one case per rule.
 *
 * The committee and hut-leader reads run against small in-memory tables that
 * evaluate the REAL where-clauses the module builds (the committee assignment's
 * own and its role's `isActive`, and the shared hut-leader access window), so a
 * lapsed assignment, an inactive role, and a hut leader before, inside and after
 * their window or at another lodge are decided by the production filters, not
 * by a stub that returns a canned answer.
 *
 * Today is the frozen test day, 2026-07-01.
 */

type CommitteeRow = { memberId: string; isActive: boolean; roleActive: boolean };
type HutLeaderRow = { memberId: string; lodgeId: string; startDate: Date; endDate: Date };

const tables = vi.hoisted(() => ({
  committee: [] as CommitteeRow[],
  hutLeaders: [] as HutLeaderRow[],
}));

vi.mock("@/lib/club-time/server", async () => {
  const clubTime = (await import("@/lib/club-time")) as typeof import("@/lib/club-time");
  return {
    clubTodayDateOnlyInstant: async () =>
      clubTime.dateOnlyInstantOf(clubTime.requireCalendarDate("2026-07-01")),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    committeeAssignment: {
      findFirst: async ({
        where,
      }: {
        where: { memberId: string; isActive: boolean; committeeRole: { isActive: boolean } };
      }) =>
        tables.committee.find(
          (row) =>
            row.memberId === where.memberId &&
            row.isActive === where.isActive &&
            row.roleActive === where.committeeRole.isActive,
        )
          ? { id: "assignment" }
          : null,
    },
    hutLeaderAssignment: {
      findMany: async ({
        where,
      }: {
        where: { memberId: string; startDate: { lte: Date }; endDate: { gte: Date } };
      }) =>
        tables.hutLeaders
          .filter(
            (row) =>
              row.memberId === where.memberId &&
              row.startDate.getTime() <= where.startDate.lte.getTime() &&
              row.endDate.getTime() >= where.endDate.gte.getTime(),
          )
          .map((row) => ({ lodgeId: row.lodgeId })),
    },
  },
}));

import {
  canActorUseFoodOrders,
  canManageFoodOrder,
  canPlaceFoodOrder,
  canViewAllFoodOrders,
  canViewFoodOrder,
  resolveFoodOrderViewer,
} from "@/lib/food-order-access";

const day = (value: string) => dateOnlyInstantOf(requireCalendarDate(value));

const NO_ACCESS = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "none",
  content: "none",
  support: "none",
} as const;

function actor(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    canLogin: true,
    role: "USER",
    accessRoles: ["USER"],
    adminPermissionMatrix: NO_ACCESS,
    ...overrides,
  } as Parameters<typeof resolveFoodOrderViewer>[0];
}

const ORDER_AT_A = { lodgeId: "lodge-a", memberId: "someone-else" };

beforeEach(() => {
  tables.committee.length = 0;
  tables.hutLeaders.length = 0;
});

describe("food-order access: committee", () => {
  it("an active assignment under an active role manages every order", async () => {
    tables.committee.push({ memberId: "m1", isActive: true, roleActive: true });
    const viewer = await resolveFoodOrderViewer(actor("m1"));
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(true);
    expect(canManageFoodOrder(viewer, { lodgeId: "lodge-b" })).toBe(true);
    expect(canViewAllFoodOrders(viewer)).toBe(true);
  });

  it("a lapsed (inactive) assignment grants nothing", async () => {
    tables.committee.push({ memberId: "m1", isActive: false, roleActive: true });
    const viewer = await resolveFoodOrderViewer(actor("m1"));
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(false);
    expect(canViewAllFoodOrders(viewer)).toBe(false);
  });

  it("an active assignment under an inactive role grants nothing", async () => {
    tables.committee.push({ memberId: "m1", isActive: true, roleActive: false });
    const viewer = await resolveFoodOrderViewer(actor("m1"));
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(false);
    expect(canViewAllFoodOrders(viewer)).toBe(false);
  });
});

describe("food-order access: hut leader at the order's lodge", () => {
  // Access window = [startDate - 1, endDate + 1]; today is 2026-07-01.
  it("inside the window at that lodge: manages it", async () => {
    tables.hutLeaders.push({
      memberId: "h1",
      lodgeId: "lodge-a",
      startDate: day("2026-07-02"),
      endDate: day("2026-07-05"),
    });
    const viewer = await resolveFoodOrderViewer(actor("h1"));
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(true);
    expect(canViewAllFoodOrders(viewer)).toBe(true);
  });

  it("on the departure day (endDate + 1): still manages it", async () => {
    tables.hutLeaders.push({
      memberId: "h1",
      lodgeId: "lodge-a",
      startDate: day("2026-06-25"),
      endDate: day("2026-06-30"),
    });
    const viewer = await resolveFoodOrderViewer(actor("h1"));
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(true);
  });

  it("before the window opens: refused", async () => {
    tables.hutLeaders.push({
      memberId: "h1",
      lodgeId: "lodge-a",
      startDate: day("2026-07-03"),
      endDate: day("2026-07-06"),
    });
    const viewer = await resolveFoodOrderViewer(actor("h1"));
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(false);
    expect(canViewAllFoodOrders(viewer)).toBe(false);
  });

  it("after the window closes: refused", async () => {
    tables.hutLeaders.push({
      memberId: "h1",
      lodgeId: "lodge-a",
      startDate: day("2026-06-20"),
      endDate: day("2026-06-29"),
    });
    const viewer = await resolveFoodOrderViewer(actor("h1"));
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(false);
    expect(canViewAllFoodOrders(viewer)).toBe(false);
  });

  it("inside the window but at ANOTHER lodge: sees every order, manages none here", async () => {
    tables.hutLeaders.push({
      memberId: "h1",
      lodgeId: "lodge-b",
      startDate: day("2026-06-30"),
      endDate: day("2026-07-03"),
    });
    const viewer = await resolveFoodOrderViewer(actor("h1"));
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(false);
    expect(canManageFoodOrder(viewer, { lodgeId: "lodge-b" })).toBe(true);
    expect(canViewAllFoodOrders(viewer)).toBe(true);
  });
});

describe("food-order access: admins", () => {
  it("Lodge Operations edit manages and sees every order", async () => {
    const viewer = await resolveFoodOrderViewer(
      actor("a1", { adminPermissionMatrix: { ...NO_ACCESS, lodge: "edit" } }),
    );
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(true);
    expect(canViewAllFoodOrders(viewer)).toBe(true);
  });

  it("Lodge Operations view sees every order but manages none", async () => {
    const viewer = await resolveFoodOrderViewer(
      actor("a1", { adminPermissionMatrix: { ...NO_ACCESS, lodge: "view" } }),
    );
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(false);
    expect(canViewAllFoodOrders(viewer)).toBe(true);
  });

  it("another area's edit grants nothing here", async () => {
    const viewer = await resolveFoodOrderViewer(
      actor("a1", { adminPermissionMatrix: { ...NO_ACCESS, finance: "edit" } }),
    );
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(false);
    expect(canViewAllFoodOrders(viewer)).toBe(false);
  });
});

describe("food-order access: ordinary members and organisations", () => {
  it("a member orders, sees only their own order, and manages none", async () => {
    const viewer = await resolveFoodOrderViewer(actor("m1"));
    expect(canPlaceFoodOrder(viewer)).toBe(true);
    expect(canViewAllFoodOrders(viewer)).toBe(false);
    expect(canViewFoodOrder(viewer, { memberId: "m1" })).toBe(true);
    expect(canViewFoodOrder(viewer, { memberId: "m2" })).toBe(false);
    expect(canManageFoodOrder(viewer, { lodgeId: "lodge-a" })).toBe(false);
  });

  it("an organisation account can do nothing, even holding committee and lodge edit", async () => {
    tables.committee.push({ memberId: "o1", isActive: true, roleActive: true });
    const org = actor("o1", {
      role: "USER",
      accessRoles: ["ORG"],
      adminPermissionMatrix: { ...NO_ACCESS, lodge: "edit" },
    });
    expect(canActorUseFoodOrders(org)).toBe(false);
    const viewer = await resolveFoodOrderViewer(org);
    expect(canPlaceFoodOrder(viewer)).toBe(false);
    expect(canManageFoodOrder(viewer, ORDER_AT_A)).toBe(false);
    expect(canViewAllFoodOrders(viewer)).toBe(false);
    expect(canViewFoodOrder(viewer, { memberId: "o1" })).toBe(false);
  });

  it("the legacy SCHOOL role counts as an organisation", () => {
    expect(canActorUseFoodOrders(actor("s1", { role: "SCHOOL", accessRoles: [] }))).toBe(false);
  });
});
