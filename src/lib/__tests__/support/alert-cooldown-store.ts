import { vi } from "vitest";

/**
 * An in-memory `AlertCooldown` table for unit tests (#5407), answering the
 * `where` shapes `alert-cooldown.ts` and its callers write: an exact `key`,
 * an exact-prefix `key: { startsWith }` (`exactPrefix`), `key: { in }`, and
 * `lastAlertedAt` as an exact instant or `{ lt | lte | gte }`. Its delegate methods are `vi.fn`s,
 * so a test can assert calls or make one fail. The real table's primary key
 * is proved against PostgreSQL in the `.realdb` suites.
 *
 * #5255: a once-ever claim's `awaitingSendSince` mark is kept beside `rows`
 * (in `awaiting`, present only while set), so a write that changes only the
 * mark, such as the email row's confirm, leaves the claim's stamp alone. A
 * `where` may test it as `null`, `{ not: null }` or `{ lt }`. `findUnique`
 * reads one row by its exact `key`, as Prisma does: null when absent, else the
 * row (`awaitingSendSince` null when unset), narrowed to `select` if given.
 * `findMany` still orders by `lastAlertedAt` only; `replayAlert` is not kept
 * (the fuller fake in `helpers/alert-cooldown-fake.ts` keeps both).
 */
type StampFilter = Date | { lt?: Date; lte?: Date; gte?: Date };
type AwaitingFilter = null | { not: null } | { lt: Date };
type CooldownWhere = {
  key?: string | { startsWith: string } | { in: string[] };
  lastAlertedAt?: StampFilter;
  awaitingSendSince?: AwaitingFilter;
};
type CooldownData = { lastAlertedAt?: Date; awaitingSendSince?: Date | null };

function matchesAwaiting(mark: Date | undefined, filter: AwaitingFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter === null) return mark === undefined;
  if ("not" in filter) return mark !== undefined;
  return mark !== undefined && mark < filter.lt;
}

function unescapeLike(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

function matches(key: string, at: Date, where: CooldownWhere): boolean {
  if (typeof where.key === "string" && where.key !== key) return false;
  if (where.key && typeof where.key === "object" && "in" in where.key && !where.key.in.includes(key)) return false;
  if (where.key && typeof where.key === "object" && "startsWith" in where.key && !key.startsWith(unescapeLike(where.key.startsWith))) return false;
  const stamp = where.lastAlertedAt;
  if (stamp instanceof Date) return at.getTime() === stamp.getTime();
  if (stamp?.lt && !(at < stamp.lt)) return false;
  if (stamp?.lte && !(at <= stamp.lte)) return false;
  if (stamp?.gte && !(at >= stamp.gte)) return false;
  return true;
}

export function createAlertCooldownStore() {
  const rows = new Map<string, Date>();
  const awaiting = new Map<string, Date>();
  const matching = (where: CooldownWhere) =>
    [...rows].filter(([key, at]) => matches(key, at, where) && matchesAwaiting(awaiting.get(key), where.awaitingSendSince));
  const setAwaiting = (key: string, mark: Date | null | undefined) => {
    if (mark) awaiting.set(key, mark);
    else awaiting.delete(key);
  };
  const delegate = {
    upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { key: string; lastAlertedAt: Date } }) => {
      if (!rows.has(where.key)) {
        rows.set(create.key, create.lastAlertedAt);
        awaiting.delete(create.key);
      }
      return { key: where.key, lastAlertedAt: rows.get(where.key)! };
    }),
    create: vi.fn(async ({ data }: { data: { key: string; lastAlertedAt: Date } & CooldownData }) => {
      if (rows.has(data.key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      rows.set(data.key, data.lastAlertedAt);
      setAwaiting(data.key, data.awaitingSendSince);
      return data;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: CooldownWhere; data: CooldownData }) => {
      const hits = matching(where);
      for (const [key] of hits) {
        if (data.lastAlertedAt !== undefined) rows.set(key, data.lastAlertedAt);
        if ("awaitingSendSince" in data) setAwaiting(key, data.awaitingSendSince);
      }
      return { count: hits.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: CooldownWhere }) => {
      const hits = matching(where);
      for (const [key] of hits) {
        rows.delete(key);
        awaiting.delete(key);
      }
      return { count: hits.length };
    }),
    findUnique: vi.fn(async ({ where, select }: { where: { key: string }; select?: Record<string, boolean> }) => {
      const lastAlertedAt = rows.get(where.key);
      if (!lastAlertedAt) return null;
      const row = { key: where.key, lastAlertedAt, awaitingSendSince: awaiting.get(where.key) ?? null };
      if (!select) return row;
      return Object.fromEntries(Object.entries(row).filter(([field]) => select[field]));
    }),
    findMany: vi.fn(async ({ where, take }: { where: CooldownWhere; take?: number }) =>
      matching(where)
        .sort(([, a], [, b]) => a.getTime() - b.getTime())
        .slice(0, take ?? Number.POSITIVE_INFINITY)
        .map(([key, lastAlertedAt]) => ({ key, lastAlertedAt })),
    ),
  };
  return { rows, awaiting, delegate };
}
