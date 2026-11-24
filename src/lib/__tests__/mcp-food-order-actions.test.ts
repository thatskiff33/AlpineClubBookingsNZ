/**
 * ALP-796 (`INV-MCP-006`): the food-order actions an AI app connection may
 * run, held to the contract each exposes (`expectActionContract`), on the
 * in-memory food-order tables the route suite uses, so the visibility rule
 * really runs.
 *
 * The caller is a member who is also on the committee, a hut leader at Lodge
 * A today and a Full Admin: on the website they see and manage every order. A
 * connection must see their own orders only, and manage none.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

import { fakeDb, resetFakeDb } from "./support/food-order-fake-db";

const mocks = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./support/food-order-fake-db")).fakePrisma,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => ({ foodOrders: true }),
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: async () =>
    mocks.session
      ? { ok: true, session: { user: mocks.session } }
      : { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
}));
vi.mock("@/lib/club-time/server", async () => {
  const clubTime = (await import("@/lib/club-time")) as typeof import("@/lib/club-time");
  const { CLUB_FORMAT_TEST } = (await import(
    "./support/club-format-fixture"
  )) as typeof import("./support/club-format-fixture");
  const bound = clubTime.bindClubTime(clubTime.requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);
  return {
    clubTime: async () => bound,
    clubTodayDateOnlyInstant: async () => clubTime.dateOnlyInstantOf(bound.today()),
  };
});
vi.mock("@/lib/rate-limit", () => ({
  applyMemberScopedRateLimit: async () => null,
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/email", () => ({ sendFoodOrderPlacedEmail: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as historyGet } from "@/app/api/food-orders/history/route";
import { GET as formGet, POST as orderPost } from "@/app/api/food-orders/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { FOOD_ORDER_UNITS } from "@/lib/food-order-rules";

const OFFICER_ID = "officer-1";
const day = (value: string) => dateOnlyInstantOf(requireCalendarDate(value));

function seedOrder(id: string, memberId: string, lodgeId: string) {
  fakeDb.orders.push({
    id,
    lodgeId,
    memberId,
    neededBy: day("2026-07-05"),
    notes: "For the work party",
    status: "RECEIVED",
    receivedAt: new Date("2026-07-04T00:00:00.000Z"),
    receivedById: "leader-9",
    priceCents: 4250,
    priceUpdatedAt: new Date("2026-07-04T00:00:00.000Z"),
    priceUpdatedById: "leader-9",
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    items: [
      {
        id: `${id}-item-0`,
        description: "Flour",
        quantity: "1.5",
        unit: "KILOGRAMS",
        sortOrder: 0,
        receivedAt: new Date("2026-07-04T00:00:00.000Z"),
        receivedById: "leader-9",
      },
    ],
  });
}

beforeEach(() => {
  resetFakeDb();
  fakeDb.settings = { officerEmail: "food@club.test", officerLabel: "Food officer" };
  fakeDb.members.push(
    { id: OFFICER_ID, firstName: "Olive", lastName: "Officer", email: "olive@club.test" },
    { id: "member-2", firstName: "Rangi", lastName: "Smith", email: "rangi@club.test" },
    { id: "leader-9", firstName: "Hana", lastName: "Leader", email: "hana@club.test" },
  );
  fakeDb.committee.push({ memberId: OFFICER_ID, isActive: true, roleActive: true });
  fakeDb.hutLeaders.push({
    memberId: OFFICER_ID,
    lodgeId: "lodge-a",
    startDate: day("2026-06-01"),
    endDate: day("2026-08-01"),
  });
  mocks.session = officerMemberSession(OFFICER_ID).user as unknown as Record<string, unknown>;
});

describe("list_my_food_orders", () => {
  it("answers a connection with the member's own orders only, without other people's names or the officer controls", async () => {
    seedOrder("own-1", OFFICER_ID, "lodge-b");
    seedOrder("other-1", "member-2", "lodge-a");
    const { connection, browser } = await expectActionContract({
      actionId: "list_my_food_orders",
      handler: historyGet,
    });
    expect(connection).toMatchObject({
      orders: [
        {
          id: "own-1",
          lodgeName: "Lodge B",
          status: "RECEIVED",
          priceCents: 4250,
          items: [{ description: "Flour", quantity: "1.5", unit: "KILOGRAMS" }],
        },
      ],
      orderCount: 1,
      priceTotalCents: 4250,
    });
    // On the website the same person sees and manages every order.
    expect(browser).toMatchObject({ seesOthersOrders: true, orderCount: 2 });
    const browserOrders = (browser as { orders: Array<{ id: string; canManage: boolean }> }).orders;
    expect(browserOrders.map((order) => order.id).sort()).toEqual(["other-1", "own-1"]);
    expect(browserOrders.find((order) => order.id === "other-1")?.canManage).toBe(true);
  });

  it("does not let a connection reach another member's order through the emailed link", async () => {
    seedOrder("other-1", "member-2", "lodge-a");
    const request = new NextRequest("http://localhost/api/food-orders/history?order=other-1", {
      headers: { "x-mcp-principal": "contract-test-principal" },
    });
    const body = await (await historyGet(request)).json();
    expect(body).toEqual({ orders: [], page: 1, pageSize: 25, orderCount: 0, pricedCount: 0, priceTotalCents: 0 });
  });
});

describe("get_food_order_options", () => {
  it("answers with whether orders are taken, the lodges and the limits, never the officer's address", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "get_food_order_options",
      handler: formGet,
    });
    expect(connection).toMatchObject({
      ready: true,
      officerLabel: "Food officer",
      lodges: [
        { id: "lodge-a", name: "Lodge A" },
        { id: "lodge-b", name: "Lodge B" },
      ],
      units: [...FOOD_ORDER_UNITS],
    });
    expect(JSON.stringify(connection)).not.toContain("food@club.test");
    expect(browser).toEqual(connection);
  });
});

describe("place_food_order", () => {
  it("places the order for the signed-in member and answers with its id", async () => {
    const { connection } = await expectActionContract({
      actionId: "place_food_order",
      handler: orderPost,
      args: {
        lodgeId: "lodge-a",
        neededBy: "2026-07-03",
        items: [{ description: "Dozen eggs", quantity: "2", unit: "ITEMS" }],
      },
    });
    expect(connection).toEqual({ id: expect.any(String) });
    // Once as the connection, once as the browser: both the member's own.
    expect(fakeDb.orders).toHaveLength(2);
    expect(fakeDb.orders.every((order) => order.memberId === OFFICER_ID)).toBe(true);
  });
});
