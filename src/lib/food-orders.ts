import type { FoodOrderStatus, Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import {
  FOOD_ORDER_HISTORY_PAGE_SIZE,
  formatFoodOrderQuantity,
  normaliseStoredFoodOrderQuantity,
  type FoodOrderUnitValue,
} from "@/lib/food-order-rules";
import {
  canManageFoodOrder,
  canViewAllFoodOrders,
  canViewFoodOrder,
  type FoodOrderViewer,
} from "@/lib/food-order-access";
import { calendarDateOfDateOnlyInstant, calendarDateParts } from "@/lib/club-time";
import { memberName } from "@/lib/member-serialization";
import { prisma } from "@/lib/prisma";

/**
 * The food-order service (fork #121): create, close, price and list.
 *
 * NO MONEY MOVES HERE. `priceCents` is a historical record for forecasting
 * (fork #121 owner decisions 8 and 11). Nothing in this module charges a member, touches a
 * booking, an invoice, the booking ledger, member money or Xero, and nothing
 * here takes an advisory lock: food orders share no row, key or counterpart
 * writer with any booking, capacity or settlement path.
 *
 * Every write commits its audit row in the SAME transaction as the change it
 * records, so an order, a close or a price change can never land unaudited, and
 * a lost race writes neither.
 */

type AuditContext = { ipAddress: string };

/** The order and its item lines, and its audit row, in one transaction. */
export async function createFoodOrder(
  input: {
    memberId: string;
    lodgeId: string;
    /** The club calendar day, as a `@db.Date` instant (`dateOnlyInstantOf`). */
    neededBy: Date;
    notes: string | null;
    /** Already validated: quantity normalised by `parseFoodOrderQuantity`. */
    items: ReadonlyArray<{ description: string; quantity: string; unit: FoodOrderUnitValue }>;
  },
  context: AuditContext,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.foodOrder.create({
      data: {
        lodgeId: input.lodgeId,
        memberId: input.memberId,
        neededBy: input.neededBy,
        notes: input.notes,
        items: {
          create: input.items.map((item, index) => ({
            description: item.description.trim(),
            // A decimal string ("0.5"): Prisma writes it exactly, never via a float.
            quantity: item.quantity,
            unit: item.unit,
            sortOrder: index,
          })),
        },
      },
      select: { id: true },
    });

    await createAuditLog(
      {
        action: "food_order.placed",
        // `lodge`: the affected domain is the physical lodge's supplies, like a
        // maintenance report (#2581's rule is the domain, not the actor).
        category: "lodge",
        memberId: input.memberId,
        targetId: order.id,
        entityType: "FoodOrder",
        entityId: order.id,
        details: JSON.stringify({
          lodgeId: input.lodgeId,
          itemCount: input.items.length,
        }),
        ipAddress: context.ipAddress,
        outcome: "success",
      },
      tx,
    );

    return order;
  });
}

export type FoodOrderReceiptOutcome =
  /** The order is no longer OPEN: nothing was written. */
  | { outcome: "already_received" }
  /** Every chosen item was already received: nothing was written. */
  | { outcome: "items_already_received" }
  | { outcome: "received"; markedCount: number; remaining: number; closed: boolean };

/** Rolls the receipt transaction back when there was nothing to mark. */
class NothingToMark extends Error {}

/**
 * Tick items of an OPEN order received (owner change, 13 Nov 2026: food can
 * arrive in parts). The order closes as RECEIVED when its last item is.
 *
 * THE ORDER ROW IS TAKEN FIRST. A status-guarded `updateMany`
 * (`WHERE status = 'OPEN'`, touching `updatedAt`) locks the order row before any
 * item is read, so concurrent receipts on one order run one after the other and
 * the "is anything left?" count below always sees the other's committed work.
 * When it matches nothing the order is already closed and nothing is written.
 *
 * Then only the chosen items that are still unreceived are marked. If none are
 * left to mark the transaction is rolled back, so the order's `updatedAt` is
 * not touched either. One audit row records the items marked and how many
 * remain; if none remain, a guarded OPEN -> RECEIVED close follows with the
 * existing received audit row, in the same transaction. Received is final:
 * there is no unticking.
 */
export async function markFoodOrderItemsReceived(
  input: { orderId: string; actorId: string; itemIds: readonly string[] },
  context: AuditContext,
): Promise<FoodOrderReceiptOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const lock = await tx.foodOrder.updateMany({
        where: { id: input.orderId, status: "OPEN" },
        data: { updatedAt: now },
      });
      if (lock.count === 0) return { outcome: "already_received" as const };

      const toMark = await tx.foodOrderItem.findMany({
        where: {
          id: { in: [...input.itemIds] },
          foodOrderId: input.orderId,
          receivedAt: null,
        },
        orderBy: { sortOrder: "asc" },
        select: { id: true, description: true, quantity: true, unit: true },
      });
      if (toMark.length === 0) throw new NothingToMark();

      await tx.foodOrderItem.updateMany({
        where: {
          id: { in: toMark.map((item) => item.id) },
          foodOrderId: input.orderId,
          receivedAt: null,
        },
        data: { receivedAt: now, receivedById: input.actorId },
      });
      const remaining = await tx.foodOrderItem.count({
        where: { foodOrderId: input.orderId, receivedAt: null },
      });

      await createAuditLog(
        {
          action: "food_order.items_received",
          category: "lodge",
          memberId: input.actorId,
          targetId: input.orderId,
          entityType: "FoodOrder",
          entityId: input.orderId,
          details: JSON.stringify({
            items: toMark.map((item) => ({
              id: item.id,
              description: item.description,
              quantity: formatFoodOrderQuantity(storedQuantity(item.quantity), item.unit),
            })),
            markedCount: toMark.length,
            remaining,
          }),
          ipAddress: context.ipAddress,
          outcome: "success",
        },
        tx,
      );

      let closed = false;
      if (remaining === 0) {
        const close = await tx.foodOrder.updateMany({
          where: { id: input.orderId, status: "OPEN" },
          data: { status: "RECEIVED", receivedAt: now, receivedById: input.actorId },
        });
        closed = close.count === 1;
        if (closed) {
          await createAuditLog(
            {
              action: "food_order.received",
              category: "lodge",
              memberId: input.actorId,
              targetId: input.orderId,
              entityType: "FoodOrder",
              entityId: input.orderId,
              details: JSON.stringify({ from: "OPEN", to: "RECEIVED", lastItems: toMark.length }),
              ipAddress: context.ipAddress,
              outcome: "success",
            },
            tx,
          );
        }
      }
      return {
        outcome: "received" as const,
        markedCount: toMark.length,
        remaining,
        closed,
      };
    });
  } catch (err) {
    if (err instanceof NothingToMark) return { outcome: "items_already_received" };
    throw err;
  }
}

export type FoodOrderPriceOutcome =
  | { outcome: "updated"; fromCents: number | null; toCents: number }
  | { outcome: "unchanged"; cents: number }
  | { outcome: "conflict" };

/**
 * Record or change an order's price, open or closed. Guarded on the price the
 * caller read, so the audit row's old amount is the one actually replaced: if
 * somebody else changed it in between, nothing is written and the caller is
 * told to reload. Saving the same amount again writes nothing either.
 */
export async function setFoodOrderPrice(
  input: {
    orderId: string;
    actorId: string;
    expectedCents: number | null;
    priceCents: number;
  },
  context: AuditContext,
): Promise<FoodOrderPriceOutcome> {
  if (input.expectedCents === input.priceCents) {
    return { outcome: "unchanged", cents: input.priceCents };
  }
  return prisma.$transaction(async (tx) => {
    const claim = await tx.foodOrder.updateMany({
      where: { id: input.orderId, priceCents: input.expectedCents },
      data: {
        priceCents: input.priceCents,
        priceUpdatedAt: new Date(),
        priceUpdatedById: input.actorId,
      },
    });
    if (claim.count === 0) return { outcome: "conflict" as const };

    await createAuditLog(
      {
        action: "food_order.price_updated",
        category: "lodge",
        memberId: input.actorId,
        targetId: input.orderId,
        entityType: "FoodOrder",
        entityId: input.orderId,
        // The old and new amounts in integer cents (issue item 3). A record
        // only: no charge, invoice, ledger row or Xero call follows.
        details: JSON.stringify({
          fromCents: input.expectedCents,
          toCents: input.priceCents,
        }),
        ipAddress: context.ipAddress,
        outcome: "success",
      },
      tx,
    );
    return {
      outcome: "updated" as const,
      fromCents: input.expectedCents,
      toCents: input.priceCents,
    };
  });
}

export type FoodOrderHistoryFilters = {
  lodgeId?: string;
  status?: FoodOrderStatus;
  /** Inclusive needed-by range, as `@db.Date` instants. */
  neededFrom?: Date;
  neededTo?: Date;
  page: number;
};

export type FoodOrderHistoryRow = {
  id: string;
  lodgeId: string;
  lodgeName: string;
  orderedBy: string | null;
  isOwn: boolean;
  neededBy: Date;
  notes: string | null;
  status: FoodOrderStatus;
  items: Array<{
    id: string;
    description: string;
    /** Normalised decimal text ("0.5", "2"), never a float. */
    quantity: string;
    unit: FoodOrderUnitValue;
    receivedAt: Date | null;
    receivedBy: string | null;
  }>;
  receivedAt: Date | null;
  receivedBy: string | null;
  priceCents: number | null;
  priceUpdatedAt: Date | null;
  priceUpdatedBy: string | null;
  createdAt: Date;
  /** From `canManageFoodOrder`: the UI shows Received and price controls by it. */
  canManage: boolean;
};

export type FoodOrderHistory = {
  canViewAll: boolean;
  orders: FoodOrderHistoryRow[];
  page: number;
  pageSize: number;
  /** Orders matching the filter, across every page. */
  orderCount: number;
  /** Orders in the filter that have a price recorded. */
  pricedCount: number;
  /** The sum of recorded prices across the filter, in cents. */
  priceTotalCents: number;
  /**
   * The same three figures per calendar year of the needed-by date, across the
   * whole filter, newest year first; years with no orders are absent.
   */
  yearTotals: FoodOrderYearTotal[];
};

export type FoodOrderYearTotal = {
  year: number;
  orderCount: number;
  pricedCount: number;
  priceTotalCents: number;
};

/**
 * Fold per-day totals into per-year totals. The year is the CALENDAR year of
 * the stored date-only needed-by day (`calendarDateOfDateOnlyInstant`), never
 * an instant read in a time zone (INV-DATE). Cents stay integers (INV-MONEY).
 */
export function foldFoodOrderYearTotals(
  days: ReadonlyArray<{
    neededBy: Date;
    orderCount: number;
    pricedCount: number;
    priceTotalCents: number;
  }>,
): FoodOrderYearTotal[] {
  const byYear = new Map<number, FoodOrderYearTotal>();
  for (const day of days) {
    const { year } = calendarDateParts(calendarDateOfDateOnlyInstant(day.neededBy));
    const total = byYear.get(year) ?? { year, orderCount: 0, pricedCount: 0, priceTotalCents: 0 };
    total.orderCount += day.orderCount;
    total.pricedCount += day.pricedCount;
    total.priceTotalCents += day.priceTotalCents;
    byYear.set(year, total);
  }
  return [...byYear.values()]
    .filter((total) => total.orderCount > 0)
    .sort((a, b) => b.year - a.year);
}

/**
 * A stored `Decimal(7,2)` as normalised text: `toFixed(2)` is Decimal.js's exact
 * rendering, then the shared normaliser drops trailing zeros. No float.
 */
export function storedQuantity(value: Prisma.Decimal | string): string {
  return normaliseStoredFoodOrderQuantity(
    typeof value === "string" ? value : value.toFixed(2),
  );
}

function nameOrNull(member: { firstName: string; lastName: string } | null | undefined) {
  return member ? memberName(member) || null : null;
}

/** The columns one history row is built from, shared by the list and the linked order. */
const HISTORY_ROW_SELECT = {
  id: true,
  lodgeId: true,
  memberId: true,
  neededBy: true,
  notes: true,
  status: true,
  receivedAt: true,
  receivedById: true,
  priceCents: true,
  priceUpdatedAt: true,
  priceUpdatedById: true,
  createdAt: true,
  lodge: { select: { name: true } },
  member: { select: { firstName: true, lastName: true } },
  items: {
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      description: true,
      quantity: true,
      unit: true,
      receivedAt: true,
      receivedById: true,
    },
  },
} satisfies Prisma.FoodOrderSelect;

type HistoryRowRecord = Prisma.FoodOrderGetPayload<{ select: typeof HISTORY_ROW_SELECT }>;

/**
 * Shape stored rows for the viewer. receivedById / priceUpdatedById are
 * snapshot ids, not relations, so their names are read in one batch.
 */
async function toHistoryRows(
  viewer: FoodOrderViewer,
  rows: readonly HistoryRowRecord[],
): Promise<FoodOrderHistoryRow[]> {
  const actorIds = [
    ...new Set(
      rows.flatMap((row) =>
        [
          row.receivedById,
          row.priceUpdatedById,
          ...row.items.map((item) => item.receivedById),
        ].filter((id): id is string => typeof id === "string"),
      ),
    ),
  ];
  const actors = actorIds.length
    ? await prisma.member.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const actorName = new Map(actors.map((actor) => [actor.id, nameOrNull(actor)]));

  return rows.map((row) => ({
    id: row.id,
    lodgeId: row.lodgeId,
    lodgeName: row.lodge.name,
    orderedBy: nameOrNull(row.member),
    isOwn: row.memberId === viewer.memberId,
    neededBy: row.neededBy,
    notes: row.notes,
    status: row.status,
    items: row.items.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: storedQuantity(item.quantity),
      unit: item.unit,
      receivedAt: item.receivedAt,
      receivedBy: item.receivedById ? (actorName.get(item.receivedById) ?? null) : null,
    })),
    receivedAt: row.receivedAt,
    receivedBy: row.receivedById ? (actorName.get(row.receivedById) ?? null) : null,
    priceCents: row.priceCents,
    priceUpdatedAt: row.priceUpdatedAt,
    priceUpdatedBy: row.priceUpdatedById
      ? (actorName.get(row.priceUpdatedById) ?? null)
      : null,
    createdAt: row.createdAt,
    canManage: canManageFoodOrder(viewer, row),
  }));
}

/**
 * One order by id, for the link in the food officer's email: the row when the
 * viewer may see it (their own, or any when they see all), and null otherwise —
 * an order they may not see and one that does not exist answer the same.
 */
export async function findFoodOrderHistoryRow(
  viewer: FoodOrderViewer,
  orderId: string,
): Promise<FoodOrderHistoryRow | null> {
  const row = await prisma.foodOrder.findUnique({
    where: { id: orderId },
    select: HISTORY_ROW_SELECT,
  });
  if (!row || !canViewFoodOrder(viewer, row)) return null;
  const [shaped] = await toHistoryRows(viewer, [row]);
  return shaped ?? null;
}

/**
 * The history the viewer may see: their own orders, or every order when
 * `canViewAllFoodOrders`. The count and the price total cover the whole filter,
 * not just the page — they are the figures forecasting needs.
 */
export async function listFoodOrderHistory(
  viewer: FoodOrderViewer,
  filters: FoodOrderHistoryFilters,
): Promise<FoodOrderHistory> {
  const canViewAll = canViewAllFoodOrders(viewer);
  const neededBy: Prisma.DateTimeFilter = {};
  if (filters.neededFrom) neededBy.gte = filters.neededFrom;
  if (filters.neededTo) neededBy.lte = filters.neededTo;

  const where: Prisma.FoodOrderWhereInput = {
    ...(canViewAll ? {} : { memberId: viewer.memberId }),
    ...(filters.lodgeId ? { lodgeId: filters.lodgeId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.neededFrom || filters.neededTo ? { neededBy } : {}),
  };
  const page = Math.max(1, Math.trunc(filters.page));

  const [rows, totals, days] = await Promise.all([
    prisma.foodOrder.findMany({
      where,
      orderBy: [{ neededBy: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * FOOD_ORDER_HISTORY_PAGE_SIZE,
      take: FOOD_ORDER_HISTORY_PAGE_SIZE,
      select: HISTORY_ROW_SELECT,
    }),
    prisma.foodOrder.aggregate({
      where,
      _count: { _all: true, priceCents: true },
      _sum: { priceCents: true },
    }),
    // Per needed-by DAY over the same filter, folded into years below; Prisma
    // groups by the stored date, so no raw SQL and no time-zone reading.
    prisma.foodOrder.groupBy({
      by: ["neededBy"],
      where,
      _count: { _all: true, priceCents: true },
      _sum: { priceCents: true },
    }),
  ]);

  return {
    canViewAll,
    page,
    pageSize: FOOD_ORDER_HISTORY_PAGE_SIZE,
    orderCount: totals._count._all,
    pricedCount: totals._count.priceCents,
    priceTotalCents: totals._sum.priceCents ?? 0,
    yearTotals: foldFoodOrderYearTotals(
      days.map((day) => ({
        neededBy: day.neededBy,
        orderCount: day._count._all,
        pricedCount: day._count.priceCents,
        priceTotalCents: day._sum.priceCents ?? 0,
      })),
    ),
    orders: await toHistoryRows(viewer, rows),
  };
}

/** The fields the action routes need to decide and act on one order. */
export async function findFoodOrderForAction(orderId: string) {
  return prisma.foodOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      lodgeId: true,
      memberId: true,
      status: true,
      priceCents: true,
      items: { select: { id: true } },
    },
  });
}
