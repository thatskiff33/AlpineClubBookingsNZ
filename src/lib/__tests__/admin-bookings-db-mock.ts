import { vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { matchesWhere as evaluateWhere } from "@/lib/__tests__/support/prisma-where";

/**
 * Args-aware stand-in for `prisma.booking.findMany` / `prisma.booking.count`
 * used by the admin-bookings-service tests (#1884).
 *
 * The service now pushes ordering (`orderBy`), pagination (`skip`/`take`,
 * id-`cursor`) and the payment-source filter (`where.payment`) down to SQL, so
 * a naive mock that returns every fixture regardless of args can no longer
 * exercise the service's real contract. This mock emulates exactly the query
 * shapes the service emits:
 *
 * - `where.id.in` (page hydration)
 * - `where.payment` as `{ is: null }` / `{ is: { source } }` (#1884)
 * - `orderBy` on checkIn / updatedAt / finalPriceCents / id and the
 *   `guests._count` relation aggregate, with array composition
 * - `cursor` (+ `skip: 1`) / `skip` / `take`
 *
 * Every other `where` key is deliberately ignored — fixtures are pre-filtered
 * by the tests, matching the previous naive-mock behavior.
 */

type FixtureRow = Record<string, any>;

interface WhereLike {
  id?: { in?: string[] };
  payment?: { is: null | { source?: string } };
  [key: string]: unknown;
}

type OrderByClause = Record<
  string,
  "asc" | "desc" | { _count?: "asc" | "desc"; sort?: "asc" | "desc" }
>;

interface FindManyArgsLike {
  where?: WhereLike;
  orderBy?: OrderByClause | OrderByClause[];
  cursor?: { id?: string };
  skip?: number;
  take?: number;
}

/** The `where` keys this mock emulates; every other key is dropped, per the contract above. */
const EMULATED_WHERE_KEYS = ["id", "payment"] as const;

function matchesWhere(row: FixtureRow, where?: WhereLike) {
  if (!where) return true;
  const emulated: Record<string, unknown> = {};
  for (const key of EMULATED_WHERE_KEYS) {
    if (key in where) emulated[key] = where[key];
  }
  return evaluateWhere(row, emulated, { label: "admin-bookings db mock" });
}

function orderRows(rows: FixtureRow[], orderBy: OrderByClause | OrderByClause[]) {
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, spec] = Object.entries(clause)[0];
      let left: unknown;
      let right: unknown;
      let dir: "asc" | "desc";
      if (field === "guests") {
        dir = (typeof spec === "object" && spec._count) || "asc";
        left = a._count?.guests ?? a.guests?.length ?? 0;
        right = b._count?.guests ?? b.guests?.length ?? 0;
      } else {
        dir = typeof spec === "string" ? spec : spec.sort ?? "asc";
        left = a[field];
        right = b[field];
        if (left instanceof Date) left = left.getTime();
        if (right instanceof Date) right = right.getTime();
      }
      let cmp = (left as never) < (right as never) ? -1 : (left as never) > (right as never) ? 1 : 0;
      if (dir === "desc") cmp = -cmp;
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function runFindMany(fixtures: FixtureRow[], args: FindManyArgsLike = {}) {
  let rows = fixtures.filter((row) => matchesWhere(row, args.where));
  if (args.orderBy) rows = orderRows(rows, args.orderBy);
  if (args.cursor?.id != null) {
    const index = rows.findIndex((row) => row.id === args.cursor?.id);
    rows = index === -1 ? [] : rows.slice(index + (args.skip ?? 0));
  } else if (args.skip) {
    rows = rows.slice(args.skip);
  }
  if (args.take != null) rows = rows.slice(0, args.take);
  return rows;
}

export function installAdminBookingsDbMock(fixtures: FixtureRow[]) {
  vi.mocked(prisma.booking.findMany).mockImplementation((async (
    args?: FindManyArgsLike
  ) => runFindMany(fixtures, args)) as never);
  vi.mocked(prisma.booking.count).mockImplementation((async (args?: {
    where?: WhereLike;
  }) => fixtures.filter((row) => matchesWhere(row, args?.where)).length) as never);
}
