import { vi } from "vitest";

/**
 * An in-memory `AlertCooldown` table for unit tests (#5407), answering the
 * `where` shapes `alert-cooldown.ts` and its callers write: an exact `key`,
 * an exact-prefix `key: { startsWith }` (`exactPrefix`), and `lastAlertedAt`
 * as an exact instant or `{ lt | lte }`. Its delegate methods are `vi.fn`s,
 * so a test can assert calls or make one fail. The real table's primary key
 * is proved against PostgreSQL in the `.realdb` suites.
 */
type StampFilter = Date | { lt?: Date; lte?: Date };
type CooldownWhere = { key?: string | { startsWith: string }; lastAlertedAt?: StampFilter };

function unescapeLike(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

function matches(key: string, at: Date, where: CooldownWhere): boolean {
  if (typeof where.key === "string" && where.key !== key) return false;
  if (where.key && typeof where.key === "object" && !key.startsWith(unescapeLike(where.key.startsWith))) return false;
  const stamp = where.lastAlertedAt;
  if (stamp instanceof Date) return at.getTime() === stamp.getTime();
  if (stamp?.lt && !(at < stamp.lt)) return false;
  if (stamp?.lte && !(at <= stamp.lte)) return false;
  return true;
}

export function createAlertCooldownStore() {
  const rows = new Map<string, Date>();
  const matching = (where: CooldownWhere) => [...rows].filter(([key, at]) => matches(key, at, where));
  const delegate = {
    upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { key: string; lastAlertedAt: Date } }) => {
      if (!rows.has(where.key)) rows.set(create.key, create.lastAlertedAt);
      return { key: where.key, lastAlertedAt: rows.get(where.key)! };
    }),
    create: vi.fn(async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
      if (rows.has(data.key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      rows.set(data.key, data.lastAlertedAt);
      return data;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: CooldownWhere; data: { lastAlertedAt: Date } }) => {
      const hits = matching(where);
      for (const [key] of hits) rows.set(key, data.lastAlertedAt);
      return { count: hits.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: CooldownWhere }) => {
      const hits = matching(where);
      for (const [key] of hits) rows.delete(key);
      return { count: hits.length };
    }),
    findMany: vi.fn(async ({ where, take }: { where: CooldownWhere; take?: number }) =>
      matching(where)
        .sort(([, a], [, b]) => a.getTime() - b.getTime())
        .slice(0, take ?? Number.POSITIVE_INFINITY)
        .map(([key, lastAlertedAt]) => ({ key, lastAlertedAt })),
    ),
  };
  return { rows, delegate };
}
