import { vi } from "vitest";

/**
 * An in-memory `OwedNotice` table for unit tests (#5433), answering the
 * shapes `owed-notice/store.ts` writes: `createMany` with `skipDuplicates`
 * (a row already there is left as it is, as ON CONFLICT DO NOTHING leaves
 * it), an exact `id`, `kind` (or `{ notIn }`), `stampedAt` as an exact
 * instant or `{ lte }`, `createdAt: { lt }`, and `attempts: { increment }`. Its delegate methods are `vi.fn`s, so a test
 * can assert calls or make one fail. The real table, its primary key and the
 * claim's exclusivity are proved against PostgreSQL in the `.realdb` suites.
 */
export interface StoredOwedNotice {
  id: string;
  kind: string;
  subjectId: string;
  eventAt: Date;
  variant: string | null;
  payload: unknown;
  stampedAt: Date;
  attempts: number;
  createdAt: Date;
}

type StampFilter = Date | { lte?: Date };
type OwedWhere = { id?: string; kind?: string | { notIn: string[] }; stampedAt?: StampFilter; createdAt?: { lt: Date } };

function matches(row: StoredOwedNotice, where: OwedWhere): boolean {
  if (where.id !== undefined && where.id !== row.id) return false;
  if (typeof where.kind === "string" && where.kind !== row.kind) return false;
  if (typeof where.kind === "object" && where.kind.notIn.includes(row.kind)) return false;
  if (where.createdAt && !(row.createdAt < where.createdAt.lt)) return false;
  const stamp = where.stampedAt;
  if (stamp instanceof Date) return row.stampedAt.getTime() === stamp.getTime();
  if (stamp?.lte && !(row.stampedAt <= stamp.lte)) return false;
  return true;
}

export function createOwedNoticeStore() {
  const rows = new Map<string, StoredOwedNotice>();
  const matching = (where: OwedWhere) => [...rows.values()].filter((row) => matches(row, where));
  const delegate = {
    createMany: vi.fn(
      async ({ data, skipDuplicates }: { data: Array<Omit<StoredOwedNotice, "attempts" | "createdAt"> & { attempts?: number }>; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of data) {
          if (rows.has(row.id)) {
            if (!skipDuplicates) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
            continue;
          }
          rows.set(row.id, { ...row, variant: row.variant ?? null, payload: row.payload ?? null, attempts: row.attempts ?? 0, createdAt: new Date() });
          count += 1;
        }
        return { count };
      },
    ),
    updateMany: vi.fn(
      async ({ where, data }: { where: OwedWhere; data: { stampedAt: Date; attempts?: { increment: number } } }) => {
        const hits = matching(where);
        for (const row of hits) {
          row.stampedAt = data.stampedAt;
          if (data.attempts) row.attempts += data.attempts.increment;
        }
        return { count: hits.length };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: OwedWhere }) => {
      const hits = matching(where);
      for (const row of hits) rows.delete(row.id);
      return { count: hits.length };
    }),
    count: vi.fn(async ({ where }: { where: OwedWhere }) => matching(where).length),
    findMany: vi.fn(async ({ where, take }: { where: OwedWhere; take?: number }) =>
      matching(where)
        .sort((a, b) => a.stampedAt.getTime() - b.stampedAt.getTime())
        .slice(0, take ?? Number.POSITIVE_INFINITY)
        .map(({ id, kind, subjectId, eventAt, variant, payload }) => ({ id, kind, subjectId, eventAt, variant, payload })),
    ),
  };
  /** Seed one marker as `recordOwedNotices` writes it: stamped with its event time. */
  function seed(row: { id: string; kind: string; subjectId: string; eventAt: Date; variant?: string | null; stampedAt?: Date; createdAt?: Date }) {
    rows.set(row.id, {
      id: row.id,
      kind: row.kind,
      subjectId: row.subjectId,
      eventAt: row.eventAt,
      variant: row.variant ?? null,
      payload: null,
      stampedAt: row.stampedAt ?? row.eventAt,
      attempts: 0,
      createdAt: row.createdAt ?? row.eventAt,
    });
  }
  return { rows, delegate, seed };
}
