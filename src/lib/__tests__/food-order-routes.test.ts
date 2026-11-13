import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

import { fakeDb, fakePrisma, resetFakeDb } from "./support/food-order-fake-db";

/**
 * Fork #121: the food-order member routes end to end over an in-memory
 * database — the access matrix for Received and price, creating an order, the
 * module gate, the Received claim under concurrent requests, price audit, and
 * the history's scope, filters, paging and totals.
 *
 * The REAL access module, service and route guard run; only Prisma, the
 * session, the module flags, the rate limiter, the clock reader and the mail
 * sender are replaced. Today is the frozen test day, 2026-07-01 (NZ).
 */

const mocks = vi.hoisted(() => ({
  modules: { foodOrders: true } as Record<string, boolean>,
  session: null as null | Record<string, unknown>,
  rateLimited: false,
  sendFoodOrderPlacedEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./support/food-order-fake-db")).fakePrisma,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => mocks.modules,
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: async () =>
    mocks.session
      ? { ok: true, session: { user: mocks.session } }
      : {
          ok: false,
          response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        },
}));
vi.mock("@/lib/club-time/server", async () => {
  const clubTime = (await import("@/lib/club-time")) as typeof import("@/lib/club-time");
  const { CLUB_FORMAT_TEST } = (await import(
    "./support/club-format-fixture"
  )) as typeof import("./support/club-format-fixture");
  const bound = clubTime.bindClubTime(
    clubTime.requireClubTimeZone("Pacific/Auckland"),
    CLUB_FORMAT_TEST,
  );
  return {
    clubTime: async () => bound,
    clubTodayDateOnlyInstant: async () => clubTime.dateOnlyInstantOf(bound.today()),
  };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { foodOrderMember: { id: "food-order-member" } },
  applyMemberScopedRateLimit: async () =>
    mocks.rateLimited
      ? NextResponse.json({ error: "Too many requests" }, { status: 429 })
      : null,
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/email", () => ({
  sendFoodOrderPlacedEmail: mocks.sendFoodOrderPlacedEmail,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as historyGet } from "@/app/api/food-orders/history/route";
import { PATCH as pricePatch } from "@/app/api/food-orders/[id]/price/route";
import { POST as receivedPost } from "@/app/api/food-orders/[id]/received/route";
import { GET as formGet, POST as orderPost } from "@/app/api/food-orders/route";

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

function user(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    role: "USER",
    accessRoles: ["USER"],
    canLogin: true,
    adminPermissionMatrix: NO_ACCESS,
    ...overrides,
  };
}

const ROLES = {
  member: () => user("member-1"),
  owner: () => user("owner-1"),
  organisation: () => user("org-1", { accessRoles: ["ORG"] }),
  committee: () => {
    fakeDb.committee.push({ memberId: "committee-1", isActive: true, roleActive: true });
    return user("committee-1");
  },
  hutLeaderInWindow: () => {
    fakeDb.hutLeaders.push({
      memberId: "leader-1",
      lodgeId: "lodge-a",
      startDate: day("2026-07-01"),
      endDate: day("2026-07-04"),
    });
    return user("leader-1");
  },
  hutLeaderOutOfWindow: () => {
    fakeDb.hutLeaders.push({
      memberId: "leader-2",
      lodgeId: "lodge-a",
      startDate: day("2026-07-10"),
      endDate: day("2026-07-12"),
    });
    return user("leader-2");
  },
  hutLeaderOtherLodge: () => {
    fakeDb.hutLeaders.push({
      memberId: "leader-3",
      lodgeId: "lodge-b",
      startDate: day("2026-07-01"),
      endDate: day("2026-07-04"),
    });
    return user("leader-3");
  },
  lodgeViewAdmin: () =>
    user("admin-view", { adminPermissionMatrix: { ...NO_ACCESS, lodge: "view" } }),
  lodgeEditAdmin: () =>
    user("admin-edit", { adminPermissionMatrix: { ...NO_ACCESS, lodge: "edit" } }),
};

/** Item lines for a seeded order; ids are `<orderId>-item-<n>`. */
function seedItems(orderId: string, descriptions: string[]) {
  return descriptions.map((description, index) => ({
    id: `${orderId}-item-${index}`,
    description,
    quantity: "1",
    unit: "ITEMS",
    sortOrder: index,
    receivedAt: null as Date | null,
    receivedById: null as string | null,
  }));
}

function seedOrder(
  overrides: Partial<(typeof fakeDb.orders)[number]> = {},
  descriptions: string[] = ["Bread"],
) {
  const id = overrides.id ?? `seed-${fakeDb.orders.length + 1}`;
  const order = {
    id,
    lodgeId: "lodge-a",
    memberId: "owner-1",
    neededBy: day("2026-07-05"),
    notes: null,
    status: "OPEN" as const,
    receivedAt: null,
    receivedById: null,
    priceCents: null,
    priceUpdatedAt: null,
    priceUpdatedById: null,
    createdAt: new Date(Date.UTC(2026, 5, 1 + fakeDb.orders.length)),
    items: seedItems(id, descriptions),
    ...overrides,
  };
  fakeDb.orders.push(order);
  return order;
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Tick items received; by default every item of the order still unreceived. */
function receive(id: string, itemIds?: unknown) {
  const open =
    fakeDb.orders
      .find((order) => order.id === id)
      ?.items.filter((item) => item.receivedAt === null)
      .map((item) => item.id) ?? [`${id}-item-0`];
  return receivedPost(
    jsonRequest(`/api/food-orders/${id}/received`, "POST", {
      itemIds: itemIds === undefined ? open : itemIds,
    }),
    params(id),
  );
}
/**
 * PATCH a price. `expectedCents` defaults to what is stored now — the screen is
 * up to date — so each test states only what it is about.
 */
function price(id: string, priceCents: unknown, expectedCents?: unknown) {
  const stored = fakeDb.orders.find((order) => order.id === id)?.priceCents ?? null;
  return pricePatch(
    jsonRequest(`/api/food-orders/${id}/price`, "PATCH", {
      priceCents,
      expectedCents: expectedCents === undefined ? stored : expectedCents,
    }),
    params(id),
  );
}

/** One order line as the form sends it. */
function line(description: string, quantity = "1", unit = "ITEMS") {
  return { description, quantity, unit };
}

const VALID_ORDER = {
  lodgeId: "lodge-a",
  neededBy: "2026-07-03",
  notes: "For the work party",
  items: [
    { description: "Flour", quantity: "1.5", unit: "KILOGRAMS" },
    { description: "Dozen eggs", quantity: "2", unit: "ITEMS" },
    { description: "Wholemeal", quantity: "1", unit: "LOAVES" },
  ],
};
function placeOrder(body: unknown = VALID_ORDER) {
  return orderPost(jsonRequest("/api/food-orders", "POST", body));
}

beforeEach(() => {
  resetFakeDb();
  mocks.modules = { foodOrders: true };
  mocks.session = ROLES.member();
  mocks.rateLimited = false;
  mocks.sendFoodOrderPlacedEmail.mockReset();
  fakeDb.settings = { officerEmail: "food@club.test", officerLabel: "Food officer" };
});

describe("Received and price: the access matrix", () => {
  // [role, expected status for an order at lodge-a owned by owner-1]
  const matrix: Array<[keyof typeof ROLES, number]> = [
    ["member", 404],
    ["owner", 403],
    ["organisation", 403],
    ["committee", 200],
    ["hutLeaderInWindow", 200],
    ["hutLeaderOutOfWindow", 404],
    ["hutLeaderOtherLodge", 403],
    ["lodgeViewAdmin", 403],
    ["lodgeEditAdmin", 200],
  ];

  for (const [role, expected] of matrix) {
    it(`${role}: Received answers ${expected}`, async () => {
      const order = seedOrder();
      mocks.session = ROLES[role]();
      const res = await receive(order.id);
      expect(res.status).toBe(expected);
      expect(fakeDb.orders[0]?.status).toBe(expected === 200 ? "RECEIVED" : "OPEN");
    });

    it(`${role}: price answers ${expected}`, async () => {
      const order = seedOrder();
      mocks.session = ROLES[role]();
      const res = await price(order.id, 4250);
      expect(res.status).toBe(expected);
      expect(fakeDb.orders[0]?.priceCents).toBe(expected === 200 ? 4250 : null);
    });
  }

  it("signed out: 401 and nothing changes", async () => {
    const order = seedOrder();
    mocks.session = null;
    expect((await receive(order.id)).status).toBe(401);
    expect((await price(order.id, 100)).status).toBe(401);
    expect(fakeDb.orders[0]?.status).toBe("OPEN");
    expect(fakeDb.audit).toHaveLength(0);
  });

  it("an unknown order id answers 404", async () => {
    mocks.session = ROLES.lodgeEditAdmin();
    expect((await receive("missing")).status).toBe(404);
    expect((await price("missing", 100)).status).toBe(404);
  });
});

describe("the module gate", () => {
  it("module off: every route answers 404, signed in or not, and nothing is stored", async () => {
    const order = seedOrder();
    mocks.modules = { foodOrders: false };
    for (const session of [ROLES.lodgeEditAdmin(), null]) {
      mocks.session = session;
      expect((await formGet()).status).toBe(404);
      expect((await placeOrder()).status).toBe(404);
      expect(
        (await historyGet(jsonRequest("/api/food-orders/history", "GET"))).status,
      ).toBe(404);
      expect((await receive(order.id)).status).toBe(404);
      expect((await price(order.id, 100)).status).toBe(404);
    }
    expect(fakeDb.orders).toHaveLength(1);
    expect(fakeDb.orders[0]?.status).toBe("OPEN");
    expect(fakeDb.audit).toHaveLength(0);
  });
});

describe("placing an order", () => {
  it("stores it Open with every item, audits it, then emails the officer every item", async () => {
    const res = await placeOrder();
    expect(res.status).toBe(201);
    expect(fakeDb.orders).toHaveLength(1);
    const stored = fakeDb.orders[0]!;
    expect(stored.status).toBe("OPEN");
    expect(stored.memberId).toBe("member-1");
    expect(stored.neededBy.toISOString()).toBe("2026-07-03T00:00:00.000Z");
    expect(stored.items.map((item) => [item.description, item.quantity, item.unit])).toEqual([
      ["Flour", "1.5", "KILOGRAMS"],
      ["Dozen eggs", "2", "ITEMS"],
      ["Wholemeal", "1", "LOAVES"],
    ]);
    expect(fakeDb.audit.map((row) => row.action)).toEqual(["food_order.placed"]);

    await vi.waitFor(() => expect(mocks.sendFoodOrderPlacedEmail).toHaveBeenCalledOnce());
    const email = mocks.sendFoodOrderPlacedEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(email.to).toBe("food@club.test");
    expect(email.lodgeName).toBe("Lodge A");
    expect(email.notes).toBe("For the work party");
    expect(email.items).toEqual([
      { description: "Flour", quantity: "1.5", unit: "KILOGRAMS" },
      { description: "Dozen eggs", quantity: "2", unit: "ITEMS" },
      { description: "Wholemeal", quantity: "1", unit: "LOAVES" },
    ]);
    expect(String(email.foodOrderUrl)).toContain(`/food-orders?order=${stored.id}`);
  });

  it("refuses with no officer email set, stores nothing and sends nothing", async () => {
    fakeDb.settings = { officerEmail: null, officerLabel: "Food officer" };
    const res = await placeOrder();
    expect(res.status).toBe(409);
    expect(fakeDb.orders).toHaveLength(0);
    expect(mocks.sendFoodOrderPlacedEmail).not.toHaveBeenCalled();

    const form = await (await formGet()).json();
    expect(form.ready).toBe(false);
  });

  it("reports ready, the label and the club's today to the form when set up", async () => {
    fakeDb.settings = { officerEmail: "food@club.test", officerLabel: "Catering officer" };
    const form = await (await formGet()).json();
    expect(form).toMatchObject({ ready: true, officerLabel: "Catering officer", today: "2026-07-01" });
    expect(JSON.stringify(form)).not.toContain("food@club.test");
  });

  const invalid: Array<[string, unknown]> = [
    ["no items", { ...VALID_ORDER, items: [] }],
    [
      "51 items",
      {
        ...VALID_ORDER,
        items: Array.from({ length: 51 }, (_, i) => line(`Item ${i}`)),
      },
    ],
    ["an empty description", { ...VALID_ORDER, items: [line("   ")] }],
    ["a 201-character description", { ...VALID_ORDER, items: [line("x".repeat(201))] }],
    ["quantity 0", { ...VALID_ORDER, items: [line("Milk", "0")] }],
    ["quantity 0.00", { ...VALID_ORDER, items: [line("Milk", "0.00")] }],
    ["a negative quantity", { ...VALID_ORDER, items: [line("Milk", "-1")] }],
    ["three decimal places", { ...VALID_ORDER, items: [line("Milk", "1.005")] }],
    ["more than 99999.99", { ...VALID_ORDER, items: [line("Milk", "100000")] }],
    ["an exponent", { ...VALID_ORDER, items: [line("Milk", "1e3")] }],
    ["NaN", { ...VALID_ORDER, items: [line("Milk", "NaN")] }],
    ["a JSON number, not a string", { ...VALID_ORDER, items: [{ description: "Milk", quantity: 1.5, unit: "ITEMS" }] }],
    ["an unknown type", { ...VALID_ORDER, items: [line("Milk", "1", "CRATES")] }],
    ["no type", { ...VALID_ORDER, items: [{ description: "Milk", quantity: "1" }] }],
    ["yesterday as needed-by", { ...VALID_ORDER, neededBy: "2026-06-30" }],
    ["a malformed date", { ...VALID_ORDER, neededBy: "2026-13-01" }],
    ["an inactive or unknown lodge", { ...VALID_ORDER, lodgeId: "nowhere" }],
  ];
  for (const [label, body] of invalid) {
    it(`refuses ${label}`, async () => {
      const res = await placeOrder(body);
      expect(res.status).toBe(400);
      expect(fakeDb.orders).toHaveLength(0);
      expect(mocks.sendFoodOrderPlacedEmail).not.toHaveBeenCalled();
    });
  }

  it("accepts the boundaries: 50 items, 0.01 and 99999.99, and today as needed-by", async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      line(`Item ${i}`, i === 0 ? "99999.99" : i === 1 ? "0.01" : "1"),
    );
    const res = await placeOrder({ ...VALID_ORDER, neededBy: "2026-07-01", items });
    expect(res.status).toBe(201);
    expect(fakeDb.orders[0]?.items).toHaveLength(50);
    expect(fakeDb.orders[0]?.items.slice(0, 2).map((item) => item.quantity)).toEqual([
      "99999.99",
      "0.01",
    ]);
  });

  it("stores a decimal quantity normalised, and it round-trips to the history as text", async () => {
    mocks.session = ROLES.committee();
    const res = await placeOrder({
      ...VALID_ORDER,
      items: [line("Rice", "0.50", "PACKETS"), line("Flour", "250.00", "GRAMS")],
    });
    expect(res.status).toBe(201);
    expect(fakeDb.orders[0]?.items.map((item) => item.quantity)).toEqual(["0.5", "250"]);
    const history = await (await historyGet(jsonRequest("/api/food-orders/history", "GET"))).json();
    expect(
      history.orders[0].items.map((item: { quantity: string; unit: string }) => [item.quantity, item.unit]),
    ).toEqual([
      ["0.5", "PACKETS"],
      ["250", "GRAMS"],
    ]);
  });

  it("is rate limited per member", async () => {
    mocks.rateLimited = true;
    expect((await placeOrder()).status).toBe(429);
    expect(fakeDb.orders).toHaveLength(0);
  });

  it("refuses an organisation account", async () => {
    mocks.session = ROLES.organisation();
    expect((await placeOrder()).status).toBe(403);
    expect((await formGet()).status).toBe(403);
    expect(fakeDb.orders).toHaveLength(0);
  });

  it("refuses a signed-out caller", async () => {
    mocks.session = null;
    expect((await placeOrder()).status).toBe(401);
  });
});

describe("closing an order", () => {
  it("two confirmations at once close it once, with one audit row", async () => {
    const order = seedOrder();
    mocks.session = ROLES.committee();
    const [first, second] = await Promise.all([receive(order.id), receive(order.id)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(fakeDb.orders[0]?.status).toBe("RECEIVED");
    expect(fakeDb.orders[0]?.receivedById).toBe("committee-1");
    expect(fakeDb.audit.filter((row) => row.action === "food_order.received")).toHaveLength(1);
  });

  it("a closed order cannot be received again", async () => {
    const order = seedOrder({ status: "RECEIVED", receivedById: "x" });
    mocks.session = ROLES.lodgeEditAdmin();
    expect((await receive(order.id)).status).toBe(409);
    expect(fakeDb.orders[0]?.receivedById).toBe("x");
    expect(fakeDb.audit).toHaveLength(0);
  });

  it("an order the previous release closed, with its items unmarked, cannot be ticked", async () => {
    // The draining colour closes an order without marking its items. The
    // order-row guard (status OPEN) is what refuses it: nothing is written.
    const order = seedOrder({ status: "RECEIVED", receivedById: "x" }, ["Bread", "Milk"]);
    mocks.session = ROLES.committee();
    const res = await receive(order.id, [`${order.id}-item-0`]);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been marked received/);
    expect(fakeDb.orders[0]?.items.every((item) => item.receivedAt === null)).toBe(true);
    expect(fakeDb.audit).toHaveLength(0);
  });
});

describe("history totals by year", () => {
  async function history(query = "") {
    const res = await historyGet(jsonRequest(`/api/food-orders/history${query}`, "GET"));
    return (await res.json()) as {
      currentYear: number;
      orderCount: number;
      priceTotalCents: number;
      yearTotals: Array<{ year: number; orderCount: number; pricedCount: number; priceTotalCents: number }>;
    };
  }

  beforeEach(() => {
    mocks.session = ROLES.committee();
    seedOrder({ neededBy: day("2025-12-31"), priceCents: 100 });
    seedOrder({ neededBy: day("2026-01-01"), priceCents: 200 });
    seedOrder({ neededBy: day("2026-07-05"), priceCents: null });
    seedOrder({ neededBy: day("2024-06-01"), priceCents: null, lodgeId: "lodge-b" });
    seedOrder({ neededBy: day("2027-02-01"), priceCents: 50, status: "RECEIVED" });
  });

  it("splits 31 Dec and 1 Jan into their own calendar years, newest first, across the whole filter", async () => {
    const body = await history();
    expect(body.currentYear).toBe(2026);
    expect(body.yearTotals).toEqual([
      { year: 2027, orderCount: 1, pricedCount: 1, priceTotalCents: 50 },
      { year: 2026, orderCount: 2, pricedCount: 1, priceTotalCents: 200 },
      { year: 2025, orderCount: 1, pricedCount: 1, priceTotalCents: 100 },
      { year: 2024, orderCount: 1, pricedCount: 0, priceTotalCents: 0 },
    ]);
    // The headline is unchanged: the whole filter.
    expect(body.orderCount).toBe(5);
    expect(body.priceTotalCents).toBe(350);
  });

  it("honours the filters and omits years with no orders", async () => {
    expect((await history("?lodgeId=lodge-b")).yearTotals).toEqual([
      { year: 2024, orderCount: 1, pricedCount: 0, priceTotalCents: 0 },
    ]);
    expect((await history("?status=RECEIVED")).yearTotals.map((total) => total.year)).toEqual([2027]);
    expect(
      (await history("?from=2025-12-31&to=2026-01-01")).yearTotals.map((total) => total.year),
    ).toEqual([2026, 2025]);
  });

  it("a member's totals cover only their own orders", async () => {
    mocks.session = ROLES.owner();
    const body = await history();
    // Every seeded order here belongs to owner-1.
    expect(body.yearTotals.reduce((sum, total) => sum + total.orderCount, 0)).toBe(5);
    mocks.session = ROLES.member();
    expect((await history()).yearTotals).toEqual([]);
  });
});

describe("receiving items (a checklist)", () => {
  const FIVE = ["Bread", "Milk", "Eggs", "Flour", "Coffee"];

  it("ticks some items, records who and when, and leaves the order Open", async () => {
    const order = seedOrder({}, FIVE);
    mocks.session = ROLES.hutLeaderInWindow();
    const res = await receive(order.id, [`${order.id}-item-0`, `${order.id}-item-2`]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "OPEN", markedCount: 2, remaining: 3 });
    const stored = fakeDb.orders[0]!;
    expect(stored.status).toBe("OPEN");
    expect(stored.items.map((item) => item.receivedById)).toEqual([
      "leader-1", null, "leader-1", null, null,
    ]);
    expect(fakeDb.audit.map((row) => row.action)).toEqual(["food_order.items_received"]);
    expect(JSON.parse(fakeDb.audit[0]!.details ?? "{}")).toEqual({
      items: [
        { id: `${order.id}-item-0`, description: "Bread", quantity: "1 Item" },
        { id: `${order.id}-item-2`, description: "Eggs", quantity: "1 Item" },
      ],
      markedCount: 2,
      remaining: 3,
    });
  });

  it("the last item closes the order, stamped with that moment and person, and writes the received audit", async () => {
    const order = seedOrder({}, ["Bread", "Milk"]);
    mocks.session = ROLES.committee();
    expect((await receive(order.id, [`${order.id}-item-0`])).status).toBe(200);
    expect(fakeDb.orders[0]?.status).toBe("OPEN");
    const res = await receive(order.id, [`${order.id}-item-1`]);
    expect(await res.json()).toMatchObject({ status: "RECEIVED", remaining: 0 });
    const stored = fakeDb.orders[0]!;
    expect(stored.status).toBe("RECEIVED");
    expect(stored.receivedById).toBe("committee-1");
    expect(stored.receivedAt?.getTime()).toBe(stored.items[1]!.receivedAt?.getTime());
    expect(fakeDb.audit.map((row) => row.action)).toEqual([
      "food_order.items_received",
      "food_order.items_received",
      "food_order.received",
    ]);
  });

  it("two people ticking the last items at once close the order once", async () => {
    const order = seedOrder({}, ["Bread", "Milk"]);
    mocks.session = ROLES.committee();
    const [first, second] = await Promise.all([
      receive(order.id, [`${order.id}-item-0`, `${order.id}-item-1`]),
      receive(order.id, [`${order.id}-item-1`]),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(fakeDb.orders[0]?.status).toBe("RECEIVED");
    expect(fakeDb.audit.filter((row) => row.action === "food_order.received")).toHaveLength(1);
    expect(fakeDb.audit.filter((row) => row.action === "food_order.items_received")).toHaveLength(1);
  });

  it("items already received answer 409 and change nothing", async () => {
    const order = seedOrder({}, ["Bread", "Milk"]);
    mocks.session = ROLES.committee();
    await receive(order.id, [`${order.id}-item-0`]);
    const before = fakeDb.audit.length;
    const updatedAt = fakeDb.orders[0]!.items[0]!.receivedAt;
    const res = await receive(order.id, [`${order.id}-item-0`]);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already received/);
    expect(fakeDb.audit).toHaveLength(before);
    expect(fakeDb.orders[0]!.items[0]!.receivedAt).toBe(updatedAt);
    expect(fakeDb.orders[0]?.status).toBe("OPEN");
  });

  it("an item of another order is refused with 400 and nothing is written", async () => {
    const order = seedOrder({}, ["Bread"]);
    const other = seedOrder({ id: "other-order" }, ["Milk"]);
    mocks.session = ROLES.committee();
    const res = await receive(order.id, [`${order.id}-item-0`, `${other.id}-item-0`]);
    expect(res.status).toBe(400);
    expect(fakeDb.orders.flatMap((row) => row.items).every((item) => item.receivedAt === null)).toBe(true);
    expect(fakeDb.audit).toHaveLength(0);
  });

  const badBodies: Array<[string, unknown]> = [
    ["no items", []],
    ["a duplicated item", ["seed-1-item-0", "seed-1-item-0"]],
    ["a non-string id", [7]],
    ["51 items", Array.from({ length: 51 }, (_, i) => `seed-1-item-${i}`)],
    ["not an array", "seed-1-item-0"],
  ];
  for (const [label, itemIds] of badBodies) {
    it(`refuses ${label} with 400`, async () => {
      seedOrder({}, ["Bread"]);
      mocks.session = ROLES.committee();
      expect((await receive("seed-1", itemIds)).status).toBe(400);
      expect(fakeDb.audit).toHaveLength(0);
    });
  }

  it("refuses an unknown body field and a missing body", async () => {
    const order = seedOrder();
    mocks.session = ROLES.committee();
    const extra = await receivedPost(
      jsonRequest(`/api/food-orders/${order.id}/received`, "POST", {
        itemIds: [`${order.id}-item-0`],
        all: true,
      }),
      params(order.id),
    );
    expect(extra.status).toBe(400);
    const empty = await receivedPost(
      jsonRequest(`/api/food-orders/${order.id}/received`, "POST"),
      params(order.id),
    );
    expect(empty.status).toBe(400);
    expect(fakeDb.orders[0]?.status).toBe("OPEN");
  });

  it("the history lists each item with when and by whom it was received", async () => {
    fakeDb.members.push({ id: "committee-1", firstName: "Cara", lastName: "Committee", email: "c@x.test" });
    const order = seedOrder({ memberId: "member-1" }, ["Bread", "Milk"]);
    mocks.session = ROLES.committee();
    await receive(order.id, [`${order.id}-item-1`]);
    const res = await historyGet(jsonRequest("/api/food-orders/history", "GET"));
    const row = (await res.json()).orders[0];
    expect(row.status).toBe("OPEN");
    expect(row.items.map((item: { id: string; receivedBy: string | null; receivedAt: string | null }) => [
      item.id,
      item.receivedBy,
      item.receivedAt !== null,
    ])).toEqual([
      [`${order.id}-item-0`, null, false],
      [`${order.id}-item-1`, "Cara Committee", true],
    ]);
  });
});

describe("recording the price", () => {
  it("audits every change with the old and new amounts, including on a closed order", async () => {
    const order = seedOrder({ status: "RECEIVED" });
    mocks.session = ROLES.hutLeaderInWindow();
    expect((await price(order.id, 4250)).status).toBe(200);
    expect((await price(order.id, 3999)).status).toBe(200);
    expect(fakeDb.orders[0]?.priceCents).toBe(3999);
    expect(fakeDb.orders[0]?.priceUpdatedById).toBe("leader-1");
    const rows = fakeDb.audit.filter((row) => row.action === "food_order.price_updated");
    expect(rows.map((row) => JSON.parse(row.details ?? "{}"))).toEqual([
      { fromCents: null, toCents: 4250 },
      { fromCents: 4250, toCents: 3999 },
    ]);
  });

  it("saving the same amount again writes no audit row", async () => {
    const order = seedOrder({ priceCents: 1000 });
    mocks.session = ROLES.committee();
    expect((await price(order.id, 1000)).status).toBe(200);
    expect(fakeDb.audit).toHaveLength(0);
  });

  const badPrices: unknown[] = [-1, 12.5, "1000", null, 2_147_483_648, Number.MAX_SAFE_INTEGER];
  for (const value of badPrices) {
    it(`refuses ${JSON.stringify(value)} as a price`, async () => {
      const order = seedOrder();
      mocks.session = ROLES.committee();
      expect((await price(order.id, value)).status).toBe(400);
      expect(fakeDb.orders[0]?.priceCents).toBeNull();
      expect(fakeDb.audit).toHaveLength(0);
    });
  }

  it("refuses a stale screen: the price it showed is no longer stored (409, nothing written)", async () => {
    const order = seedOrder({ priceCents: 1000 });
    mocks.session = ROLES.committee();
    const res = await price(order.id, 2000, null);
    expect(res.status).toBe(409);
    expect(fakeDb.orders[0]?.priceCents).toBe(1000);
    expect(fakeDb.audit).toHaveLength(0);
  });

  it("refuses a request without expectedCents, or with an invalid one", async () => {
    const order = seedOrder();
    mocks.session = ROLES.committee();
    const noExpected = await pricePatch(
      jsonRequest(`/api/food-orders/${order.id}/price`, "PATCH", { priceCents: 100 }),
      params(order.id),
    );
    expect(noExpected.status).toBe(400);
    expect((await price(order.id, 100, -5)).status).toBe(400);
    expect((await price(order.id, 100, 1.5)).status).toBe(400);
    expect(fakeDb.audit).toHaveLength(0);
  });

  it("a price changed between the route's read and its write answers 409 and writes no audit row", async () => {
    const order = seedOrder({ priceCents: 1000 });
    mocks.session = ROLES.committee();
    // Another officer's save lands after this request read the order but
    // before its guarded update runs.
    const original = fakePrisma.foodOrder.updateMany;
    const spy = vi
      .spyOn(fakePrisma.foodOrder, "updateMany")
      .mockImplementationOnce(async (args) => {
        fakeDb.orders[0]!.priceCents = 1500;
        return original(args);
      });
    const res = await price(order.id, 2000, 1000);
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(fakeDb.orders[0]?.priceCents).toBe(1500);
    expect(fakeDb.audit).toHaveLength(0);
  });

  it("accepts zero cents", async () => {
    const order = seedOrder();
    mocks.session = ROLES.committee();
    expect((await price(order.id, 0)).status).toBe(200);
    expect(fakeDb.orders[0]?.priceCents).toBe(0);
  });
});

describe("the history", () => {
  async function history(query = "") {
    const res = await historyGet(jsonRequest(`/api/food-orders/history${query}`, "GET"));
    return { status: res.status, body: await res.json() };
  }

  beforeEach(() => {
    seedOrder({ memberId: "member-1", lodgeId: "lodge-a", neededBy: day("2026-07-05"), priceCents: 1000 });
    seedOrder({ memberId: "member-1", lodgeId: "lodge-b", neededBy: day("2026-08-01"), status: "RECEIVED", priceCents: 2500 });
    seedOrder({ memberId: "other-1", lodgeId: "lodge-a", neededBy: day("2026-07-10"), priceCents: 400 });
    seedOrder({ memberId: "other-2", lodgeId: "lodge-a", neededBy: day("2026-09-01") });
  });

  it("a member sees only their own orders and their totals, and may manage none", async () => {
    const { status, body } = await history();
    expect(status).toBe(200);
    expect(body.canViewAll).toBe(false);
    expect(body.orders).toHaveLength(2);
    expect(body.orders.every((row: { isOwn: boolean }) => row.isOwn)).toBe(true);
    expect(body.orders.every((row: { canManage: boolean }) => !row.canManage)).toBe(true);
    expect(body.orderCount).toBe(2);
    expect(body.priceTotalCents).toBe(3500);
  });

  it("a committee member sees every order, with the count and price total", async () => {
    mocks.session = ROLES.committee();
    const { body } = await history();
    expect(body.canViewAll).toBe(true);
    expect(body.orderCount).toBe(4);
    expect(body.pricedCount).toBe(3);
    expect(body.priceTotalCents).toBe(3900);
    expect(body.orders.every((row: { canManage: boolean }) => row.canManage)).toBe(true);
  });

  it("a hut leader sees every order but manages only their lodge's", async () => {
    mocks.session = ROLES.hutLeaderInWindow();
    const { body } = await history();
    expect(body.orderCount).toBe(4);
    for (const row of body.orders as Array<{ lodgeId: string; canManage: boolean }>) {
      expect(row.canManage).toBe(row.lodgeId === "lodge-a");
    }
  });

  it("filters by lodge, status and needed-by range, and totals the filter", async () => {
    mocks.session = ROLES.lodgeViewAdmin();
    expect((await history("?lodgeId=lodge-a")).body.orderCount).toBe(3);
    expect((await history("?status=RECEIVED")).body.orderCount).toBe(1);
    const ranged = await history("?lodgeId=lodge-a&from=2026-07-01&to=2026-07-31");
    expect(ranged.body.orderCount).toBe(2);
    expect(ranged.body.priceTotalCents).toBe(1400);
    expect(ranged.body.orders.every((row: { canManage: boolean }) => !row.canManage)).toBe(true);
  });

  it("refuses a malformed filter rather than widening it", async () => {
    mocks.session = ROLES.committee();
    expect((await history("?status=CLOSED")).status).toBe(400);
    expect((await history("?from=01/07/2026")).status).toBe(400);
    expect((await history("?page=0")).status).toBe(400);
  });

  it("pages 25 at a time, with the count and total across every page", async () => {
    for (let i = 0; i < 26; i += 1) {
      seedOrder({ memberId: "bulk", neededBy: day("2026-10-01"), priceCents: 100 });
    }
    mocks.session = ROLES.committee();
    const first = await history();
    const second = await history("?page=2");
    expect(first.body.orders).toHaveLength(25);
    expect(second.body.orders).toHaveLength(5);
    expect(second.body.page).toBe(2);
    expect(first.body.orderCount).toBe(30);
    expect(first.body.priceTotalCents).toBe(3900 + 2600);
  });

  it("refuses an organisation account", async () => {
    mocks.session = ROLES.organisation();
    expect((await history()).status).toBe(403);
  });

  describe("the emailed link (?order=)", () => {
    it("returns the linked order even when it is not on the page shown", async () => {
      for (let i = 0; i < 30; i += 1) {
        seedOrder({ memberId: "bulk", neededBy: day("2026-12-01") });
      }
      mocks.session = ROLES.committee();
      const target = fakeDb.orders.find((row) => row.memberId === "other-2")!;
      const { body } = await history(`?order=${target.id}`);
      expect(body.orders.some((row: { id: string }) => row.id === target.id)).toBe(false);
      expect(body.linkedOrder).toMatchObject({ id: target.id, canManage: true });
    });

    it("returns the orderer their own order", async () => {
      const own = fakeDb.orders.find((row) => row.memberId === "member-1")!;
      const { body } = await history(`?order=${own.id}`);
      expect(body.linkedOrder).toMatchObject({ id: own.id, isOwn: true, canManage: false });
    });

    it("shows nothing for an order the viewer may not see, exactly as for one that does not exist", async () => {
      const other = fakeDb.orders.find((row) => row.memberId === "other-1")!;
      const hidden = await history(`?order=${other.id}`);
      const missing = await history("?order=no-such-order");
      expect(hidden.status).toBe(200);
      expect(hidden.body.linkedOrder).toBeNull();
      expect(missing.body.linkedOrder).toBeNull();
      expect(JSON.stringify(hidden.body)).not.toContain(other.id);
    });
  });
});
