import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

/**
 * Food-order receipt and price races against real PostgreSQL (PR #5143 review,
 * finding 6). The unit suite's fake runs transactions one at a time, so it
 * cannot show row locking; this does, under PostgreSQL's default READ
 * COMMITTED isolation.
 *
 * - Two concurrent receipts that each tick the order's last items: the order
 *   row is taken first (status-guarded `updateMany`), so the second waits,
 *   then finds every item received and writes nothing. The order closes once,
 *   with one `food_order.received` audit row.
 * - Two concurrent price saves from the same screen (both expecting null):
 *   exactly one wins; the other is a conflict and writes no audit row.
 */

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "race-5143-";
const LODGE = `${PREFIX}lodge`;
const MEMBER = `${PREFIX}member`;
const ORDER = `${PREFIX}order`;
const CONTEXT = { ipAddress: "127.0.0.1" };

let db: PrismaClient;
let foodOrders: typeof import("@/lib/food-orders");

async function cleanUp() {
  await db.auditLog.deleteMany({ where: { entityId: ORDER } });
  await db.foodOrder.deleteMany({ where: { id: ORDER } });
}

(RUN ? describe : describe.skip)("food-order races in PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "Food order");
    process.env.DATABASE_URL = URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    foodOrders = await import("@/lib/food-orders");
    await db.lodge.upsert({
      where: { id: LODGE },
      create: { id: LODGE, name: "Race lodge", slug: LODGE },
      update: {},
    });
    await db.member.upsert({
      where: { id: MEMBER },
      create: {
        id: MEMBER,
        firstName: "Race",
        lastName: "Member",
        email: "food-order-race@example.invalid",
        passwordHash: "not-a-password",
      },
      update: {},
    });
  }, 30_000);

  beforeEach(async () => {
    await cleanUp();
    await db.foodOrder.create({
      data: {
        id: ORDER,
        lodgeId: LODGE,
        memberId: MEMBER,
        neededBy: new Date("2026-07-05"),
        items: {
          create: [
            { id: `${PREFIX}item-0`, description: "Bread", quantity: "2", unit: "LOAVES", sortOrder: 0 },
            { id: `${PREFIX}item-1`, description: "Milk", quantity: "1", unit: "LITERS", sortOrder: 1 },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanUp();
    await db.member.deleteMany({ where: { id: MEMBER } });
    await db.lodge.deleteMany({ where: { id: LODGE } });
  });

  it("two concurrent final ticks close the order once", async () => {
    const tick = (actorId: string) =>
      foodOrders.markFoodOrderItemsReceived(
        { orderId: ORDER, actorId, itemIds: [`${PREFIX}item-0`, `${PREFIX}item-1`] },
        CONTEXT,
      );
    const outcomes = await Promise.all([tick("actor-a"), tick("actor-b")]);

    const winners = outcomes.filter((outcome) => outcome.outcome === "received");
    expect(winners).toEqual([
      expect.objectContaining({ markedCount: 2, remaining: 0, closed: true }),
    ]);
    // The loser waited on the order row, then saw the order closed.
    expect(outcomes.filter((outcome) => outcome.outcome !== "received").map((o) => o.outcome))
      .toEqual([expect.stringMatching(/^(already_received|items_already_received)$/)]);

    const order = await db.foodOrder.findUniqueOrThrow({
      where: { id: ORDER },
      include: { items: true },
    });
    expect(order.status).toBe("RECEIVED");
    const winnerId = order.receivedById;
    expect(order.items.every((item) => item.receivedById === winnerId)).toBe(true);

    const audits = await db.auditLog.findMany({ where: { entityId: ORDER }, select: { action: true } });
    expect(audits.map((row) => row.action).sort()).toEqual([
      "food_order.items_received",
      "food_order.received",
    ]);
  });

  it("two concurrent ticks of different items leave both received and close once", async () => {
    const outcomes = await Promise.all([
      foodOrders.markFoodOrderItemsReceived(
        { orderId: ORDER, actorId: "actor-a", itemIds: [`${PREFIX}item-0`] },
        CONTEXT,
      ),
      foodOrders.markFoodOrderItemsReceived(
        { orderId: ORDER, actorId: "actor-b", itemIds: [`${PREFIX}item-1`] },
        CONTEXT,
      ),
    ]);
    expect(outcomes.every((outcome) => outcome.outcome === "received")).toBe(true);
    expect(outcomes.filter((outcome) => outcome.outcome === "received" && outcome.closed)).toHaveLength(1);

    const order = await db.foodOrder.findUniqueOrThrow({ where: { id: ORDER } });
    expect(order.status).toBe("RECEIVED");
    const closes = await db.auditLog.count({ where: { entityId: ORDER, action: "food_order.received" } });
    expect(closes).toBe(1);
  });

  it("two concurrent price saves from the same screen: one wins, one conflicts", async () => {
    const save = (actorId: string, priceCents: number) =>
      foodOrders.setFoodOrderPrice(
        { orderId: ORDER, actorId, expectedCents: null, priceCents },
        CONTEXT,
      );
    const outcomes = await Promise.all([save("actor-a", 4250), save("actor-b", 9900)]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["conflict", "updated"]);
    const winner = outcomes.find((outcome) => outcome.outcome === "updated");
    const order = await db.foodOrder.findUniqueOrThrow({ where: { id: ORDER } });
    expect(winner).toMatchObject({ fromCents: null, toCents: order.priceCents });

    const audits = await db.auditLog.findMany({
      where: { entityId: ORDER, action: "food_order.price_updated" },
      select: { details: true },
    });
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.details ?? "{}")).toEqual({ fromCents: null, toCents: order.priceCents });
  });
});
